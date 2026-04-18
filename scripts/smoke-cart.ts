import crypto from 'crypto';
import http from 'http';
import {
  insertCartItem,
  listActiveCart,
  deleteUserCart,
} from '../src/skills/shopping-cart/db';

const SECRET = process.env.SHOPPING_CART_HMAC_SECRET || 'your_shopping_cart_hmac_secret_here';
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const USER_ID = 'smoke-cart-user';

function sign(body: string) {
  const ts = Date.now().toString();
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  return { ts, sig };
}

function post(path: string, body: any): Promise<{ status: number; body: string }> {
  const raw = JSON.stringify(body);
  const { ts, sig } = sign(raw);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(raw),
          'x-trace-signature': sig,
          'x-trace-timestamp': ts,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

function expect(cond: boolean, label: string) {
  if (!cond) { console.error(`  ✗ FAIL: ${label}`); process.exitCode = 1; }
  else       { console.log(`  ✓ ${label}`); }
}

(async () => {
  console.log('=== tools/list ===');
  const list = await post('/shopping-cart/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(list.status === 200, 'tools/list 200');
  expect(list.body.includes('handle_dialog'), 'has handle_dialog');

  console.log('\n=== seed 3 items (2 IKEA marketplace + 1 non-IKEA) ===');
  deleteUserCart(USER_ID);
  insertCartItem({
    user_id: USER_ID, name: 'blue MARKUS office chair', category: 'furniture',
    price_est_usd: 270, price_local: 23990, currency: 'INR',
    brand: 'IKEA', sku: '002.754.31', aisle: '15', bin: '22',
    pickup_type: 'marketplace', room: 'office', store_guess: 'IKEA',
    source: 'photo', image_url: 'x',
  });
  insertCartItem({
    user_id: USER_ID, name: 'KALLAX shelf unit', category: 'storage',
    price_est_usd: 80, price_local: 6990, currency: 'INR',
    brand: 'IKEA', sku: '702.758.87', aisle: '21', bin: '05',
    pickup_type: 'marketplace', room: 'living_room', store_guess: 'IKEA',
    source: 'photo', image_url: 'x',
  });
  insertCartItem({
    user_id: USER_ID, name: 'LED desk lamp', category: 'lighting',
    price_est_usd: 35, source: 'photo', image_url: 'x',
  });
  expect(listActiveCart(USER_ID).length === 3, 'seeded 3 items');

  console.log('\n=== dialog: "what\'s in my cart" (expect IKEA aisle/bin in reply) ===');
  const listReply = await post('/shopping-cart/mcp', {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: "what's in my cart" } },
    user: { id: USER_ID },
  });
  expect(listReply.status === 200, 'list 200');
  expect(listReply.body.includes('3 items'), 'reply mentions 3 items');
  expect(listReply.body.includes('385') || listReply.body.includes('~$385'), 'reply includes total ~$385');
  expect(listReply.body.includes('aisle 15'), 'reply includes IKEA aisle 15');
  expect(listReply.body.includes('bin 22'), 'reply includes IKEA bin 22');
  console.log('  ', JSON.parse(listReply.body).result.content[0].text);

  console.log('\n=== dialog: "what\'s in my IKEA cart" (brand-filtered, expect 2 items) ===');
  const listIkea = await post('/shopping-cart/mcp', {
    jsonrpc: '2.0', id: 22, method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: "what's in my IKEA cart" } },
    user: { id: USER_ID },
  });
  expect(listIkea.body.includes('2 items'), 'IKEA filter returns 2 items');
  expect(listIkea.body.toLowerCase().includes('ikea cart'), 'reply says "IKEA cart"');
  expect(!listIkea.body.includes('LED desk lamp'), 'non-IKEA lamp excluded');
  console.log('  ', JSON.parse(listIkea.body).result.content[0].text);

  console.log('\n=== dialog: "add this to my cart" (expect photo prompt) ===');
  const prompt = await post('/shopping-cart/mcp', {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: 'add this to my cart' } },
    user: { id: USER_ID },
  });
  expect(prompt.body.toLowerCase().includes('snap'), 'prompts for photo');
  console.log('  ', JSON.parse(prompt.body).result.content[0].text);

  console.log('\n=== dialog: "add a toothbrush" (text-only add) ===');
  const addText = await post('/shopping-cart/mcp', {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: 'add a toothbrush' } },
    user: { id: USER_ID },
  });
  expect(addText.body.toLowerCase().includes('added'), 'text-add confirmed');
  expect(listActiveCart(USER_ID).some((i) => i.name.includes('toothbrush')), 'toothbrush in cart');

  console.log('\n=== dialog: "remove the lamp" ===');
  const rm = await post('/shopping-cart/mcp', {
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: 'remove the lamp' } },
    user: { id: USER_ID },
  });
  expect(rm.body.toLowerCase().includes('removed'), 'removed confirmation');
  expect(!listActiveCart(USER_ID).some((i) => i.name.toLowerCase().includes('lamp')), 'lamp gone from active');

  console.log('\n=== dialog: "remove the unicorn" (miss) ===');
  const miss = await post('/shopping-cart/mcp', {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: 'remove the unicorn' } },
    user: { id: USER_ID },
  });
  expect(miss.body.toLowerCase().includes("don't see"), 'miss message');

  console.log('\n=== dialog: "clear my cart" (expect confirm_action) ===');
  const clearAsk = await post('/shopping-cart/mcp', {
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: 'clear my cart' } },
    user: { id: USER_ID },
  });
  expect(clearAsk.body.includes('confirm_action'), 'returns confirm_action');

  console.log('\n=== dialog: confirm callback "__confirm_clear__" ===');
  const clearConfirm = await post('/shopping-cart/mcp', {
    jsonrpc: '2.0', id: 8, method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: '__confirm_clear__' } },
    user: { id: USER_ID },
  });
  expect(clearConfirm.body.toLowerCase().includes('cleared'), 'cleared confirmation');
  expect(listActiveCart(USER_ID).length === 0, 'cart is now empty');

  console.log('\n=== /delete-user ===');
  const del = await post('/shopping-cart/delete-user', { user_id: USER_ID });
  expect(del.status === 200, 'delete 200');

  console.log(`\n${process.exitCode ? 'CART SMOKE FAILED' : 'CART SMOKE OK'}`);
})().catch((e) => { console.error(e); process.exit(1); });
