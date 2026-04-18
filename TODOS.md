# TODOs

## Skill: Shopping Cart (NEXT)

**Goal.** "Add this to my shopping cart" for in-store ecommerce experiences (IKEA, grocery, hardware). Two capture modes share one cart.

### Mode A — Single-item add (button + dialog + photo)

**UX flow (matches Trace's documented event model):**
```
[button] -> interaction.dialog -> /shopping-cart/mcp (handle_dialog)
         "add this to my cart"
           -> our MCP replies: "sure, snap the item" (TTS)
[platform captures photo]
         -> media.photo -> /shopping-cart/webhook
           -> Gemini Flash vision -> {item, category, price_est, store_guess, notes}
           -> INSERT INTO cart_items
           -> push TTS: "Added the blue lamp (~$40) to your cart."
```

**Handles:** single intentional captures. Natural for "I'm looking at this specific
thing right now and want to add it."

### Mode B' — Audio walk-through (narration substitute for video)

**Why not video:** Trace's documented media channels are `media.audio`, `media.photo`,
`interaction.dialog`. **No `media.video` channel.** Video-mode is blocked at the
platform until Trace adds it. Audio narration is a strictly better substitute anyway
because intent is explicit in speech (no guessing from pixels which items the user
actually wanted).

**UX flow:**
```
[user starts recording] (platform UX)
[user walks IKEA, narrates: "I want this Markus chair... that Kallax shelf... this lamp"]
[user ends recording]
         -> media.audio (with transcript) -> /shopping-cart/webhook
           -> Gemini extracts item list from transcript
              (ignore negations like "don't want the gray one")
           -> bulk INSERT
           -> push TTS: "Added 3 items: Markus chair, Kallax shelf, lamp."
```

**Handles:** bulk capture during store walk-throughs. 10x throughput vs photo-per-item.

### Implementation plan (scaffolded, ready to copy)

```
src/skills/shopping-cart/
  manifest.json       # triggers: media.photo, media.audio, interaction.dialog
  routes.ts           # webhook + mcp router (copy object-memory, swap prompts)
  db.ts               # cart_items, carts_state
  prompts.ts          # item-extraction prompts (photo + audio)
```

**cart_items schema:**
```sql
CREATE TABLE cart_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  name          TEXT NOT NULL,       -- "blue Markus chair"
  category      TEXT,                -- "furniture", "grocery", ...
  price_est_usd REAL,                -- null if unknown
  store_guess   TEXT,                -- "IKEA", "Target", inferred or explicit
  qty           INTEGER DEFAULT 1,
  image_url     TEXT,                -- null for audio-add
  notes         TEXT,                -- color, model, other details
  source        TEXT NOT NULL,       -- 'photo' | 'audio' | 'dialog_text'
  status        TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'removed' | 'purchased'
  request_id    TEXT
);
CREATE INDEX idx_cart_user_status_ts ON cart_items(user_id, status, ts DESC);
```

**MCP tools:**
- `handle_dialog` — routes everything. Patterns:
  - "add a toothbrush" → text-only add (no photo needed)
  - "what's in my cart" → list top N with running price total
  - "remove the lamp" → fuzzy match by name, set status='removed'
  - "clear my cart" → confirm_action then set all to 'removed'
  - "email me my cart" → platform tool_call mail.send with HTML list
- `add_item_manual` — explicit text add (for voice UX that doesn't want implicit dialog matching)
- `list_cart` — returns JSON for UI consumers
- `checkout` — mail.send + optionally mark all as 'purchased'

**Vision prompt (photo mode):**
```
Look at this product image. Return strict JSON:
{"item": "short name, 2-5 words",
 "category": "furniture|electronics|grocery|home|clothing|other",
 "estimated_price_usd": <number or null>,
 "store_guess": "<store name if signage visible, else null>",
 "notes": "color, model, size — one line"}
```

**Audio prompt (narration mode):**
```
You are parsing a shopping narration. From this transcript, extract every item
the user said they WANT. Ignore negations ("I don't want the red one"), ignore
undecided ("maybe the blue one"), keep only clear wants.

Return strict JSON: [{"item": "...", "qty": 1, "notes": "color/model/detail"}]

Transcript: "${transcript}"
```

### Manifest outline

```json
{
  "name": "Shopping Cart",
  "interface": "hybrid",
  "endpoints": {
    "webhook": "https://<host>/shopping-cart/webhook",
    "mcp": "https://<host>/shopping-cart/mcp"
  },
  "triggers": [
    { "channel": "media.photo", "routing_mode": "passive" },
    { "channel": "media.audio", "routing_mode": "passive" },
    { "channel": "interaction.dialog", "routing_mode": "active" }
  ],
  "domains": {
    "shopping": "Match 'add this to my cart', 'add to shopping list', 'what's in my cart', 'remove the lamp', 'checkout', 'email my cart', 'clear my cart'."
  },
  "permissions": ["notification.send", "user.profile.read"],
  "allowedTools": ["mail.send"]
}
```

### Effort estimate

| Chunk | CC effort | Human effort |
|---|---|---|
| Copy object-memory scaffold → shopping-cart | 5 min | 1 hr |
| cart_items schema + CRUD | 10 min | 2 hr |
| Photo webhook handler (Mode A) | 10 min | 3 hr |
| Audio webhook handler (Mode B') | 15 min | 4 hr |
| MCP tools (list, remove, clear, checkout, email) | 15 min | 4 hr |
| Mount in index.ts + env + smoke test | 10 min | 2 hr |
| **Total** | **~65 min** | **~2 days** |

### Open questions (resolve before building)

1. Do we need a separate "carts" entity (multiple active carts per user, e.g. one for IKEA, one for groceries)? Current plan: single implicit cart per user. YAGNI for v1.
2. Checkout behavior: email the list via `mail.send`, or just read it aloud? Plan: both. `email_cart` tool + a "summary" mode in `list_cart`.
3. Price lookup: Gemini's `price_est_usd` is a hallucination. Do we want real price lookup via a search API? Defer — mark as "estimated" in the UX text.
4. Deduplication: if user says "add this lamp" twice for the same lamp, do we merge? Plan: v1 no dedup, show duplicates. Easy to add later.

---

## Skill: Object Memory — polish items (deferred from MVP)

- [ ] Replace `better-sqlite3` with `@libsql/client` (Turso free tier) when deploying to Vercel or anywhere ephemeral.
- [ ] Add image rehosting (download presigned URL, upload to S3-compatible storage) so memories survive past URL expiry.
- [ ] Location clustering: automatically infer named places from DBSCAN on lat/lng history, so users don't have to mark every place manually.
- [ ] "Confirm before saving" flow via `confirm_action` for users who don't want every photo logged.
- [ ] Per-user retention policy — today we rely on Trace's 30-day global setting.

## Infrastructure

- [ ] Render free tier spins down after 15 min idle. Daily recap cron may miss its slot. If we care, swap to **Render Cron Jobs** (separate free tier resource) hitting `/admin/run-recap/object-memory` on schedule.
- [ ] Move SQLite to Turso free tier for multi-instance deploys + survivable across redeploys.
- [ ] Add `/metrics` endpoint for basic per-skill request counts (observability was MVP-skipped).
