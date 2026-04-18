import { Router, Request, Response } from 'express';
import { verifyTraceSignature } from '../../hmac';
import { visionExtract } from '../../shared/vision';
import { sendPushResponse } from '../../shared/push';
import {
  insertCartItem,
  listActiveCart,
  listActiveCartByBrand,
  findActiveByName,
  removeCartItem,
  clearActiveCart,
  markCartPurchased,
  deleteUserCart,
  type CartItem,
} from './db';

// ─── IKEA-aware vision prompt ────────────────────────────────────────────
// Works for any store; fills in IKEA-specific fields when it detects IKEA.
const ITEM_EXTRACTION_PROMPT = `You are helping a user add items to their shopping cart from a photo taken in a retail store.

Identify the ONE most prominent product the user likely wants to buy. Return strict JSON:

{
  "item": "short product name, 2-5 words (e.g. 'blue Markus office chair')",
  "category": "furniture|electronics|grocery|home|clothing|beauty|office|lighting|kitchen|textiles|decor|storage|other",
  "brand": "<brand name if clearly visible, else null. Use 'IKEA' for IKEA products.>",
  "sku": "<product SKU/article number if visible. IKEA uses 8-digit codes like '002.601.90'. Null if not visible.>",
  "estimated_price_usd": <number or null, best guess in USD>,
  "price_local": <number or null, actual price shown on the tag in its native currency>,
  "currency": "<ISO code of the price shown: USD, EUR, INR, GBP, SEK, etc. Null if no price visible.>",
  "store_guess": "<store name from signage/branding, else null>",
  "aisle": "<marketplace aisle label if visible on a yellow IKEA pickup tag (e.g. '15' or 'A'), else null>",
  "bin": "<bin/compartment number if visible on a pickup tag (e.g. '22'), else null>",
  "pickup_type": "<marketplace if the item is shown with aisle+bin (self-serve flat-pack), showroom if assembled/displayed without pickup info, else unknown>",
  "room": "<bedroom|living_room|kitchen|dining|bathroom|office|outdoor|kids|hallway|other — inferred from product type or visible section signage, else null>",
  "notes": "<color, model, size, or other salient details — one line, null if nothing noteworthy>"
}

RULES:
- "item" must be the concrete product. For IKEA, include the model name if visible ("blue MARKUS office chair" not just "office chair").
- If you see "IKEA" signage, IKEA's yellow price tag, or the distinctive IKEA font, set brand="IKEA".
- IKEA article numbers are 8 digits, often formatted as "XXX.XXX.XX" on tags.
- IKEA marketplace tags are bright yellow and show AISLE + BIN prominently for self-pickup. If you see these, set pickup_type="marketplace" and populate aisle + bin.
- If it's a showroom display (styled room setting, no pickup tag), pickup_type="showroom".
- "estimated_price_usd" is always your best guess, even if price_local is in another currency.
- Return ONLY the JSON object. No preamble, no markdown fence.`;

type VisionItem = {
  item: string;
  category: string | null;
  brand: string | null;
  sku: string | null;
  estimated_price_usd: number | null;
  price_local: number | null;
  currency: string | null;
  store_guess: string | null;
  aisle: string | null;
  bin: string | null;
  pickup_type: 'marketplace' | 'showroom' | 'unknown' | null;
  room: string | null;
  notes: string | null;
};

// ─── Dialog intent classifier ────────────────────────────────────────────
type Intent =
  | { type: 'prompt_photo' }
  | { type: 'list' }
  | { type: 'list_brand'; brand: string }    // "what's in my IKEA cart"
  | { type: 'remove'; target: string }
  | { type: 'clear' }
  | { type: 'checkout' }
  | { type: 'add_text'; name: string }
  | { type: 'unknown' };

function classify(utterance: string): Intent {
  const u = utterance.toLowerCase().trim();

  // Brand-scoped list: "what's in my ikea cart", "show my ikea list", "list my ikea cart"
  const brandList = u.match(
    /\b(?:what(?:'s|s| is)?\s+in\s+my|show\s+my|list\s+my)\s+(ikea|target|home\s?depot|walmart|costco|amazon|best\s?buy)\s+(?:cart|list|shopping\s+list)?\b/,
  );
  if (brandList) return { type: 'list_brand', brand: brandList[1].replace(/\s+/g, '').toUpperCase() };

  if (/\b(what(?:'s|s| is)?\s+in\s+(?:my\s+)?cart|show\s+(?:my\s+)?cart|list\s+(?:my\s+)?cart|cart\s+contents)/.test(u))
    return { type: 'list' };

  if (/\b(clear|empty|wipe|reset)\s+(?:my\s+)?(?:cart|list|shopping\s+list)/.test(u))
    return { type: 'clear' };

  if (/\b(checkout|check\s+out|done\s+shopping|email\s+(?:me\s+)?(?:my\s+)?cart|send\s+(?:me\s+)?(?:my\s+)?cart|email\s+(?:me\s+)?(?:my\s+)?pick\s*list)/.test(u))
    return { type: 'checkout' };

  const rm = u.match(/\b(?:remove|delete|drop|take\s+(?:out|off)|cancel)\s+(?:the\s+|my\s+)?(.+?)$/);
  if (rm) return { type: 'remove', target: rm[1].trim().replace(/\s+from.*$/, '').trim() };

  if (/\b(add|put)\s+(this|it|that|these)\b/.test(u) || /\badd\s+to\s+(?:my\s+)?(?:cart|list)\b/.test(u))
    return { type: 'prompt_photo' };

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

function currencySymbol(code: string | null | undefined): string {
  switch ((code || '').toUpperCase()) {
    case 'USD': return '$';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'INR': return '₹';
    case 'SEK': return 'kr ';
    case 'JPY': return '¥';
    default: return '';
  }
}

function formatPriceLocal(item: CartItem): string {
  if (item.price_local == null || !Number.isFinite(item.price_local)) {
    return formatPriceUsd(item.price_est_usd);
  }
  const sym = currencySymbol(item.currency);
  if (sym) return `${sym}${Math.round(item.price_local)}`;
  return `${Math.round(item.price_local)} ${item.currency || ''}`.trim();
}

function formatPriceUsd(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return '';
  return `~$${Math.round(p)}`;
}

function locationSuffix(item: CartItem): string {
  if (item.pickup_type === 'marketplace' && item.aisle && item.bin) {
    return ` — aisle ${item.aisle}, bin ${item.bin}`;
  }
  if (item.pickup_type === 'marketplace' && item.aisle) {
    return ` — aisle ${item.aisle}`;
  }
  return '';
}

function formatItemLine(it: CartItem): string {
  const price = formatPriceLocal(it);
  const pieces = [it.name];
  if (price) pieces.push(`(${price})`);
  return pieces.join(' ') + locationSuffix(it);
}

function formatCartSummary(items: CartItem[], scope = 'cart'): string {
  if (items.length === 0) return `Your ${scope} is empty.`;
  const total = items.reduce((s, it) => s + (it.price_est_usd || 0), 0);
  const head = items.slice(0, 5).map(formatItemLine).join('; ');
  const tail = items.length > 5 ? ` and ${items.length - 5} more` : '';
  const totalText = total > 0 ? ` Estimated total: ~$${Math.round(total)}.` : '';
  return `You have ${items.length} item${items.length === 1 ? '' : 's'} in your ${scope}: ${head}${tail}.${totalText}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Group items by a key function.
function groupBy<T>(items: T[], keyFn: (x: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = keyFn(it) || 'other';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }
  return map;
}

// ─── Rich email template (IKEA-aware sections) ──────────────────────────
function cartEmailHtml(items: CartItem[]): string {
  const total = items.reduce((s, it) => s + (it.price_est_usd || 0), 0);

  // Split marketplace (self-pickup) vs showroom/unknown.
  const marketplace = items.filter((it) => it.pickup_type === 'marketplace');
  const other = items.filter((it) => it.pickup_type !== 'marketplace');

  // Sort marketplace items by aisle then bin so the pick list follows the store flow.
  marketplace.sort((a, b) => {
    const aa = (a.aisle || '').padStart(4, '0');
    const bb = (b.aisle || '').padStart(4, '0');
    if (aa !== bb) return aa.localeCompare(bb);
    return (a.bin || '').localeCompare(b.bin || '');
  });

  const marketplaceRows = marketplace
    .map(
      (it) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;"><strong>${escapeHtml(it.name)}</strong>${it.brand ? ` <span style="color:#fbd914;background:#0051ba;padding:2px 6px;border-radius:3px;font-size:11px;">${escapeHtml(it.brand)}</span>` : ''}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;">${escapeHtml(it.aisle ?? '—')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;">${escapeHtml(it.bin ?? '—')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;">${escapeHtml(it.sku ?? '—')}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(formatPriceLocal(it) || '—')}</td>
        </tr>`,
    )
    .join('');

  const byRoom = groupBy(other, (it) => it.room);
  const otherSections = Array.from(byRoom.entries())
    .map(([room, rItems]) => {
      const rows = rItems
        .map(
          (it) => `
            <tr>
              <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(it.name)}${it.brand ? ` <span style="color:#888;font-size:12px;">(${escapeHtml(it.brand)})</span>` : ''}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(it.category ?? '')}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #eee;">${it.qty}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(formatPriceLocal(it) || '—')}</td>
              <td style="padding:8px 12px;border-bottom:1px solid #eee;">${escapeHtml(it.store_guess ?? '')}</td>
            </tr>`,
        )
        .join('');
      const label = room === 'other' ? 'Other' : capitalize(room.replace(/_/g, ' '));
      return `
        <h3 style="margin-top:24px;border-bottom:2px solid #f0f0f0;padding-bottom:6px;">${escapeHtml(label)}</h3>
        <table style="border-collapse:collapse;width:100%;">
          <thead>
            <tr style="background:#fafafa;">
              <th style="padding:10px 12px;text-align:left;">Item</th>
              <th style="padding:10px 12px;text-align:left;">Category</th>
              <th style="padding:10px 12px;text-align:left;">Qty</th>
              <th style="padding:10px 12px;text-align:left;">Price</th>
              <th style="padding:10px 12px;text-align:left;">Store</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join('');

  const marketplaceSection =
    marketplaceRows.length > 0
      ? `
        <h3 style="margin-top:24px;color:#0051ba;">Marketplace pickup (self-serve)</h3>
        <p style="color:#666;font-size:14px;margin:0 0 12px 0;">Walk the marketplace in aisle order. Grab these from the shelves.</p>
        <table style="border-collapse:collapse;width:100%;">
          <thead>
            <tr style="background:#fff8d6;">
              <th style="padding:10px 12px;text-align:left;">Item</th>
              <th style="padding:10px 12px;text-align:left;">Aisle</th>
              <th style="padding:10px 12px;text-align:left;">Bin</th>
              <th style="padding:10px 12px;text-align:left;">Article #</th>
              <th style="padding:10px 12px;text-align:left;">Price</th>
            </tr>
          </thead>
          <tbody>${marketplaceRows}</tbody>
        </table>`
      : '';

  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:0 auto;color:#222;">
      <h2 style="margin-bottom:4px;">Your shopping cart</h2>
      <p style="color:#888;margin-top:0;">${items.length} item${items.length === 1 ? '' : 's'}${total > 0 ? ` · estimated ~$${Math.round(total)} total` : ''}</p>
      ${marketplaceSection}
      ${otherSections}
      ${total > 0 ? `<p style="margin-top:24px;font-size:16px;"><strong>Estimated total: ~$${Math.round(total)}</strong></p>` : ''}
      <p style="color:#888;font-size:12px;margin-top:24px;border-top:1px solid #f0f0f0;padding-top:12px;">Generated by Shopping Cart skill on Trace. Prices are estimates from photo extraction — verify at checkout.</p>
    </div>`;
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
      console.log(
        `[shopping-cart:vision] item="${vision.item}" brand=${vision.brand} sku=${vision.sku} price=${vision.price_local}${vision.currency || ''} aisle=${vision.aisle} bin=${vision.bin} pickup=${vision.pickup_type} room=${vision.room}`,
      );

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
        brand: vision.brand,
        sku: vision.sku,
        aisle: vision.aisle,
        bin: vision.bin,
        currency: vision.currency,
        price_local: vision.price_local,
        room: vision.room,
        pickup_type: vision.pickup_type,
      });

      // Build the TTS body — IKEA-aware phrasing when aisle/bin present.
      const priceText = (() => {
        if (vision.price_local != null && vision.currency) {
          const sym = currencySymbol(vision.currency);
          return sym ? `${sym}${Math.round(vision.price_local)}` : `${Math.round(vision.price_local)} ${vision.currency}`;
        }
        return vision.estimated_price_usd ? `~$${Math.round(vision.estimated_price_usd)}` : '';
      })();

      const brandText = vision.brand && vision.brand.toUpperCase() === 'IKEA' ? '' : vision.brand ? ` from ${vision.brand}` : '';
      const locText =
        vision.pickup_type === 'marketplace' && vision.aisle && vision.bin
          ? `, aisle ${vision.aisle} bin ${vision.bin}`
          : vision.store_guess && !vision.brand
            ? ` at ${vision.store_guess}`
            : '';
      const pricePart = priceText ? ` (${priceText}${locText})` : locText ? ` (${locText.replace(/^,\s*/, '')})` : '';

      const body = `Added ${vision.item}${brandText}${pricePart} to your cart.`;

      await sendPushResponse(cfg.skillId, cfg.hmacSecret, user.id, [
        { type: 'notification', content: { title: 'Cart updated', body, tts: true } },
        {
          type: 'feed_item',
          content: {
            title: `Cart: +${vision.item}`,
            story: [
              vision.brand && `${vision.brand}${vision.sku ? ` · ${vision.sku}` : ''}`,
              vision.pickup_type === 'marketplace' && vision.aisle && vision.bin && `Aisle ${vision.aisle}, bin ${vision.bin}`,
              vision.room && capitalize(vision.room.replace(/_/g, ' ')),
              vision.notes,
            ].filter(Boolean).join(' · '),
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
                'Manages a shopping cart. "add this to my cart" prompts for a photo (extracts IKEA article name, aisle, bin, price). "what\'s in my cart" lists items; "what\'s in my IKEA cart" filters by brand. "remove the lamp" removes by fuzzy name. "clear my cart" empties with confirmation. "email me my cart" sends an HTML pick list via mail.send (marketplace items sorted by aisle + bin).',
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
          "Sure, snap a photo of the item and I'll add it to your cart.",
        ));

      case 'list': {
        const items = listActiveCart(userId);
        return res.json(mcpReply(id, formatCartSummary(items, 'cart')));
      }

      case 'list_brand': {
        const items = listActiveCartByBrand(userId, intent.brand);
        const scope = `${intent.brand} cart`;
        return res.json(mcpReply(id, formatCartSummary(items, scope)));
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
        const brandCounts = new Map<string, number>();
        for (const it of items) {
          const b = it.brand || 'mixed';
          brandCounts.set(b, (brandCounts.get(b) || 0) + 1);
        }
        const brandLabel =
          brandCounts.size === 1 && !brandCounts.has('mixed')
            ? ` (${Array.from(brandCounts.keys())[0]})`
            : '';
        const subject = `Your shopping cart${brandLabel} — ${items.length} item${items.length === 1 ? '' : 's'}`;
        const body = formatCartSummary(items, 'cart');
        const html = cartEmailHtml(items);

        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              { type: 'text', text: `Emailing your pick list. ${body}` },
              {
                type: 'embedded_responses',
                responses: [
                  { type: 'notification', content: { title: 'Cart emailed', body, tts: true } },
                  { type: 'feed_item', content: { title: 'Cart checkout', story: body } },
                  { type: 'tool_call', name: 'mail.send', arguments: { subject, body, html } },
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
        if (utterance === '__confirm_clear__') {
          const n = clearActiveCart(userId);
          return res.json(mcpReply(id, `Cleared ${n} item${n === 1 ? '' : 's'} from your cart.`));
        }
        return res.json(mcpReply(
          id,
          "Say 'add this to my cart', 'what's in my cart', 'what's in my IKEA cart', 'remove the lamp', 'clear my cart', or 'email me my cart'.",
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
