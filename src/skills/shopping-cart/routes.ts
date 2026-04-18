import { Router, Request, Response } from 'express';
import { verifyTraceSignature } from '../../hmac';
import { visionExtract } from '../../shared/vision';
import { sendPushResponse } from '../../shared/push';
import {
  insertCartItem,
  listActiveCart,
  findActiveByName,
  removeCartItem,
  clearActiveCart,
  markCartPurchased,
  deleteUserCart,
  type CartItem,
} from './db';

// ─── Prompts ──────────────────────────────────────────────────────────────
const ITEM_EXTRACTION_PROMPT = `You are helping a user add items to their shopping cart from a photo taken in a store.

Look at the image and identify the SINGLE most prominent product the user likely wants to buy. Return strict JSON:
{"item": "short name, 2-5 words",
 "category": "furniture|electronics|grocery|home|clothing|beauty|office|other",
 "estimated_price_usd": <number or null>,
 "store_guess": "<store name if signage/branding visible, else null>",
 "notes": "color, model, size — one line; null if nothing salient"}

Rules:
- "item" must be the concrete product. Prefer specific over generic ("blue Markus office chair" > "chair").
- "estimated_price_usd" is a guess based on product type. Null if you really can't estimate.
- "store_guess" only if you can see a logo, price tag branding, or shelf context.
- Return ONLY the JSON. No preamble, no markdown fence.`;

type VisionItem = {
  item: string;
  category: string | null;
  estimated_price_usd: number | null;
  store_guess: string | null;
  notes: string | null;
};

// ─── Dialog intent classifier ────────────────────────────────────────────
type Intent =
  | { type: 'prompt_photo' }          // "add this to my cart"
  | { type: 'list' }                  // "what's in my cart"
  | { type: 'remove'; target: string }// "remove the lamp"
  | { type: 'clear' }                 // "clear my cart"
  | { type: 'checkout' }              // "checkout" / "email me my cart"
  | { type: 'add_text'; name: string }// "add a toothbrush"
  | { type: 'unknown' };

function classify(utterance: string): Intent {
  const u = utterance.toLowerCase().trim();

  if (/\b(what(?:'s|s| is)?\s+in\s+(?:my\s+)?cart|show\s+(?:my\s+)?cart|list\s+(?:my\s+)?cart|cart\s+contents)/.test(u))
    return { type: 'list' };

  if (/\b(clear|empty|wipe|reset)\s+(?:my\s+)?(?:cart|list|shopping\s+list)/.test(u))
    return { type: 'clear' };

  if (/\b(checkout|check\s+out|done\s+shopping|email\s+(?:me\s+)?(?:my\s+)?cart|send\s+(?:me\s+)?(?:my\s+)?cart)/.test(u))
    return { type: 'checkout' };

  const rm = u.match(/\b(?:remove|delete|drop|take\s+(?:out|off)|cancel)\s+(?:the\s+|my\s+)?(.+?)$/);
  if (rm) return { type: 'remove', target: rm[1].trim().replace(/\s+from.*$/, '').trim() };

  // "add this" / "add to cart" / "put this in my cart" → need a photo
  if (/\b(add|put)\s+(this|it|that|these)\b/.test(u) || /\b(add|put)\s+.*\bto\s+(?:my\s+)?(?:cart|list)\b/.test(u) === false && /\b(add\s+to\s+cart|to\s+my\s+cart)\b/.test(u))
    return { type: 'prompt_photo' };

  // "add a toothbrush" / "add toothbrush to my cart" → text-only add
  const addText = u.match(/\b(?:add|put)\s+(?:a|an|some|the)?\s*(.+?)(?:\s+to\s+(?:my\s+)?(?:cart|list|shopping\s+list))?$/);
  if (addText && addText[1] && !/(this|it|that|these)/.test(addText[1])) {
    const name = addText[1].trim();
    if (name && name.length < 60) return { type: 'add_text', name };
  }

  return { type: 'unknown' };
}

// ─── Reply helpers ───────────────────────────────────────────────────────
function mcpReply(id: any, text: string, title = 'Shopping Cart', extra: any[] = []) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        { type: 'text', text },
        {
          type: 'embedded_responses',
          responses: [
            { type: 'notification', content: { title, body: text, tts: true } },
            ...extra,
          ],
        },
      ],
    },
  };
}

function formatPrice(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '';
  return `~$${Math.round(p)}`;
}

function formatItemLine(it: CartItem): string {
  const price = formatPrice(it.price_est_usd);
  return price ? `${it.name} (${price})` : it.name;
}

function formatCartSummary(items: CartItem[]): string {
  if (items.length === 0) return 'Your cart is empty.';
  const total = items.reduce((s, it) => s + (it.price_est_usd || 0), 0);
  const head = items.slice(0, 5).map(formatItemLine).join('; ');
  const tail = items.length > 5 ? ` and ${items.length - 5} more` : '';
  const totalText = total > 0 ? ` Estimated total: ~$${Math.round(total)}.` : '';
  return `You have ${items.length} item${items.length === 1 ? '' : 's'}: ${head}${tail}.${totalText}`;
}

function cartEmailHtml(items: CartItem[]): string {
  const rows = items
    .map(
      (it) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(it.name)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(it.category ?? '')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${it.qty}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${formatPrice(it.price_est_usd) || '—'}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(it.store_guess ?? '')}</td>
        </tr>`,
    )
    .join('');
  const total = items.reduce((s, it) => s + (it.price_est_usd || 0), 0);
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:640px;margin:0 auto;">
      <h2>Your shopping cart</h2>
      <table style="border-collapse:collapse;width:100%;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:10px 12px;text-align:left;">Item</th>
            <th style="padding:10px 12px;text-align:left;">Category</th>
            <th style="padding:10px 12px;text-align:left;">Qty</th>
            <th style="padding:10px 12px;text-align:left;">Est.</th>
            <th style="padding:10px 12px;text-align:left;">Store</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${total > 0 ? `<p style="margin-top:16px;font-size:16px;"><strong>Estimated total: ~$${Math.round(total)}</strong></p>` : ''}
      <p style="color:#888;font-size:12px;margin-top:24px;">Generated by Shopping Cart skill · prices are Gemini estimates, verify before buying.</p>
    </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Router ───────────────────────────────────────────────────────────────
export type ShoppingCartConfig = {
  hmacSecret: string;
  skillId: string;
};

export function buildShoppingCartRouter(cfg: ShoppingCartConfig): Router {
  const router = Router();

  // Webhook: media.photo → extract product → insert into cart
  router.post('/webhook', verifyTraceSignature(cfg.hmacSecret), async (req: Request, res: Response) => {
    const { event, user, request_id, callback_url } = req.body ?? {};
    console.log(`[shopping-cart:webhook] ${event?.channel} user=${user?.id} req=${request_id}`);
    res.status(202).json({ status: 'accepted', request_id });

    if (event?.channel !== 'media.photo') return;

    const items = Array.isArray(event.items) ? event.items : [];
    const photo = items.find((it: any) => it?.url);
    if (!photo) {
      console.warn('[shopping-cart:webhook] no photo url');
      return;
    }

    try {
      const vision = await visionExtract<VisionItem>(photo.url, ITEM_EXTRACTION_PROMPT);
      if (!vision?.item || typeof vision.item !== 'string') {
        throw new Error('no item extracted');
      }
      console.log(`[shopping-cart:vision] item="${vision.item}" cat=${vision.category} price=${vision.estimated_price_usd}`);

      const id = insertCartItem({
        user_id: user.id,
        name: vision.item,
        category: vision.category,
        price_est_usd: vision.estimated_price_usd,
        store_guess: vision.store_guess,
        notes: vision.notes,
        image_url: photo.url,
        source: 'photo',
        request_id,
      });

      const priceText = formatPrice(vision.estimated_price_usd);
      const storeText = vision.store_guess ? ` at ${vision.store_guess}` : '';
      const body = `Added ${vision.item}${priceText ? ` (${priceText})` : ''}${storeText} to your cart.`;

      await sendPushResponse(cfg.skillId, cfg.hmacSecret, user.id, [
        { type: 'notification', content: { title: 'Cart updated', body, tts: true } },
        {
          type: 'feed_item',
          content: {
            title: `Cart: +${vision.item}`,
            story: vision.notes ? `${vision.item}. ${vision.notes}` : vision.item,
          },
        },
      ], callback_url);

      console.log(`[shopping-cart:db] inserted id=${id}`);
    } catch (err: any) {
      console.error('[shopping-cart:webhook] failed:', err?.message || err);
      await sendPushResponse(cfg.skillId, cfg.hmacSecret, user.id, [
        {
          type: 'notification',
          content: {
            title: 'Cart add failed',
            body: `I couldn't identify that item. (${err?.message?.slice(0, 60) || 'error'})`,
          },
        },
      ], callback_url);
    }
  });

  // MCP
  router.post('/mcp', verifyTraceSignature(cfg.hmacSecret), async (req: Request, res: Response) => {
    const { jsonrpc, method, params, id } = req.body ?? {};
    if (jsonrpc !== '2.0') return res.status(400).send('Invalid JSON-RPC');

    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'handle_dialog',
              description:
                'Manages a shopping cart. "add this to my cart" prompts for a photo. "what\'s in my cart" lists items. "remove the lamp" removes by fuzzy name. "clear my cart" empties. "email me my cart" sends an HTML list via mail.send.',
              inputSchema: {
                type: 'object',
                properties: {
                  utterance: { type: 'string', description: 'Raw voice utterance.' },
                },
                required: ['utterance'],
              },
            },
          ],
        },
      });
    }

    if (method !== 'tools/call') {
      return res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }

    const { name, arguments: args } = params ?? {};
    const user = req.body?.user ?? req.body?.context?.user;
    const userId: string | undefined = user?.id;
    if (!userId) return res.json(mcpReply(id, "I don't know who's asking."));

    if (name !== 'handle_dialog') {
      return res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
    }

    const utterance: string = String(args?.utterance ?? '').trim();
    console.log(`[shopping-cart:dialog] user=${userId} utterance="${utterance}"`);
    if (!utterance) return res.json(mcpReply(id, "I didn't catch that."));

    const intent = classify(utterance);
    console.log(`[shopping-cart:dialog] intent=${JSON.stringify(intent)}`);

    switch (intent.type) {
      case 'prompt_photo':
        return res.json(mcpReply(
          id,
          'Sure, snap a photo of the item and I\'ll add it to your cart.',
        ));

      case 'list': {
        const items = listActiveCart(userId);
        return res.json(mcpReply(id, formatCartSummary(items)));
      }

      case 'remove': {
        const hit = findActiveByName(userId, intent.target);
        if (!hit) return res.json(mcpReply(id, `I don't see "${intent.target}" in your cart.`));
        removeCartItem(userId, hit.id);
        return res.json(mcpReply(id, `Removed ${hit.name} from your cart.`));
      }

      case 'clear': {
        const items = listActiveCart(userId);
        if (items.length === 0) return res.json(mcpReply(id, 'Your cart is already empty.'));
        // Ask for confirmation before destructive action.
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              { type: 'text', text: `Clear all ${items.length} items from your cart?` },
              {
                type: 'embedded_responses',
                responses: [
                  {
                    type: 'confirm_action',
                    content: {
                      prompt: `Clear all ${items.length} items from your cart?`,
                      on_confirm: {
                        type: 'tool_call',
                        name: 'handle_dialog',
                        arguments: { utterance: '__confirm_clear__' },
                      },
                      on_decline: {
                        type: 'notification',
                        content: { title: 'Cart kept', body: 'Cart untouched.', tts: true },
                      },
                    },
                  },
                ],
              },
            ],
          },
        });
      }

      case 'checkout': {
        const items = listActiveCart(userId);
        if (items.length === 0) return res.json(mcpReply(id, 'Your cart is empty — nothing to check out.'));

        markCartPurchased(userId);
        const subject = `Your shopping cart (${items.length} item${items.length === 1 ? '' : 's'})`;
        const body = formatCartSummary(items);
        const html = cartEmailHtml(items);

        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              { type: 'text', text: `Emailing your cart. ${body}` },
              {
                type: 'embedded_responses',
                responses: [
                  { type: 'notification', content: { title: 'Cart emailed', body, tts: true } },
                  { type: 'feed_item', content: { title: 'Cart checkout', story: body } },
                  {
                    type: 'tool_call',
                    name: 'mail.send',
                    arguments: { subject, body, html },
                  },
                ],
              },
            ],
          },
        });
      }

      case 'add_text': {
        const id2 = insertCartItem({
          user_id: userId,
          name: intent.name,
          source: 'dialog_text',
        });
        console.log(`[shopping-cart:add_text] id=${id2} name="${intent.name}"`);
        return res.json(mcpReply(id, `Added ${intent.name} to your cart.`));
      }

      case 'unknown':
      default:
        // Handle the __confirm_clear__ callback from the confirm_action above.
        if (utterance === '__confirm_clear__') {
          const n = clearActiveCart(userId);
          return res.json(mcpReply(id, `Cleared ${n} item${n === 1 ? '' : 's'} from your cart.`));
        }
        return res.json(mcpReply(
          id,
          "Say 'add this to my cart', 'what's in my cart', 'remove the lamp', 'clear my cart', or 'email me my cart'.",
        ));
    }
  });

  // Lifecycle
  router.post('/delete-user', (req: Request, res: Response) => {
    const userId: string | undefined = req.body?.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });
    const removed = deleteUserCart(userId);
    console.log(`[shopping-cart:delete] user=${userId} rows=${removed}`);
    res.json({ ok: true, removed });
  });

  return router;
}
