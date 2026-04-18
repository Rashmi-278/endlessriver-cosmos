import crypto from 'crypto';
import http from 'http';
import {
  insertMemory,
  deleteUserData,
  upsertPlace,
  listPlaces,
  placeNameForLocation,
} from '../src/skills/object-memory/db';

const SECRET = process.env.TRACE_HMAC_SECRET || 'your_hmac_secret_here';
const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const USER_ID = 'smoke-user-001';
const HOME_LAT = 28.6139;
const HOME_LNG = 77.2090;

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
  if (!cond) {
    console.error(`  ✗ FAIL: ${label}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${label}`);
  }
}

(async () => {
  console.log('=== tools/list ===');
  const list = await post('/object-memory/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  expect(list.status === 200, 'tools/list 200');
  expect(list.body.includes('handle_dialog'), 'tools/list has handle_dialog');
  expect(list.body.includes('mark_place'), 'tools/list has mark_place');

  console.log('\n=== seed: clean slate + home memory (2h ago) + office memory (30m ago) ===');
  deleteUserData(USER_ID);
  upsertPlace({ user_id: USER_ID, name: 'home', lat: HOME_LAT, lng: HOME_LNG });
  insertMemory({
    user_id: USER_ID,
    ts: Date.now() - 2 * 60 * 60 * 1000,
    objects: ['keys', 'wallet'],
    scene: 'on the kitchen counter next to a coffee mug',
    location: `${HOME_LAT},${HOME_LNG}`,
    image_url: 'https://example.com/keys.jpg',
  });
  insertMemory({
    user_id: USER_ID,
    ts: Date.now() - 30 * 60 * 1000,
    objects: ['laptop'],
    scene: 'on the desk by the monitor',
    location: '12.9716,77.5946', // different coords -> no place
    image_url: 'https://example.com/laptop.jpg',
  });
  expect(listPlaces(USER_ID).length === 1, 'home place registered');
  expect(placeNameForLocation(USER_ID, `${HOME_LAT},${HOME_LNG}`) === 'home', 'location resolves to "home"');

  console.log('\n=== dialog: "where are my keys" (should tag "at home") ===');
  const keys = await post('/object-memory/mcp', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: 'where are my keys' } },
    user: { id: USER_ID },
  });
  expect(keys.status === 200, 'keys dialog 200');
  expect(keys.body.includes('at home'), 'reply includes "at home"');
  expect(keys.body.includes('2 hours ago'), 'reply includes "2 hours ago"');
  console.log('  reply:', JSON.parse(keys.body).result.content[0].text);

  console.log('\n=== dialog: "where is my laptop" (no place tag, different location) ===');
  const laptop = await post('/object-memory/mcp', {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: 'where is my laptop' } },
    user: { id: USER_ID },
  });
  expect(laptop.status === 200, 'laptop dialog 200');
  expect(!laptop.body.includes('at home'), 'laptop reply does NOT include "at home"');
  console.log('  reply:', JSON.parse(laptop.body).result.content[0].text);

  console.log('\n=== dialog: natural-language place command "call this place office" ===');
  const namePlace = await post('/object-memory/mcp', {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: 'call this place office' } },
    user: { id: USER_ID, location: { lat: 12.9716, lng: 77.5946 } },
  });
  expect(namePlace.status === 200, 'place command 200');
  expect(namePlace.body.toLowerCase().includes('office'), 'confirms office named');
  expect(listPlaces(USER_ID).some((p) => p.name === 'office'), 'office place in DB');

  console.log('\n=== dialog: "where is my laptop" again (should now say "at office") ===');
  const laptop2 = await post('/object-memory/mcp', {
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: 'where is my laptop' } },
    user: { id: USER_ID },
  });
  expect(laptop2.body.includes('at office'), 'laptop reply now includes "at office"');
  console.log('  reply:', JSON.parse(laptop2.body).result.content[0].text);

  console.log('\n=== mark_place tool direct ===');
  const markDirect = await post('/object-memory/mcp', {
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'mark_place', arguments: { name: 'gym' } },
    user: { id: USER_ID, location: { lat: 40.7128, lng: -74.0060 } },
  });
  expect(markDirect.status === 200, 'mark_place 200');
  expect(listPlaces(USER_ID).some((p) => p.name === 'gym'), 'gym place saved');

  console.log('\n=== dialog: passport (miss — no semantic call because no Gemini key in smoke) ===');
  const miss = await post('/object-memory/mcp', {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'handle_dialog', arguments: { utterance: 'where is my passport' } },
    user: { id: USER_ID },
  });
  expect(miss.status === 200, 'passport miss 200');
  expect(miss.body.includes("haven't seen your passport"), 'miss message shown');

  console.log('\n=== admin/run-recap/object-memory ===');
  await new Promise<void>((resolve) => {
    const body = '{}';
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: '/admin/run-recap/object-memory',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-admin-secret': SECRET,
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          expect(res.statusCode === 200, `admin recap 200 (got ${res.statusCode})`);
          console.log('  response:', d);
          resolve();
        });
      },
    );
    req.write(body);
    req.end();
  });

  console.log('\n=== /delete-user cleanup ===');
  const del = await post('/object-memory/delete-user', { user_id: USER_ID });
  expect(del.status === 200, 'delete 200');
  expect(JSON.parse(del.body).removed === 2, 'deleted 2 memories');
  expect(listPlaces(USER_ID).length === 0, 'places also wiped');

  console.log(`\n${process.exitCode ? 'SMOKE FAILED' : 'SMOKE OK'}`);
})().catch((e) => {
  console.error('smoke error:', e);
  process.exit(1);
});
