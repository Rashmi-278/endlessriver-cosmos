# 🌌 EndlessRiver Cosmos

**A skills pack for the [EndlessRiver Trace](https://endlessriver.ai) AI wearable glasses.** Two production skills ship in this repo, running on a single Node server with a shared chassis for adding more.

| Skill | What it does | Trigger |
|---|---|---|
| 🔑 **Object Memory** | Photographic recall. Snap where you put things; later, ask *"where are my keys?"* and get a voice answer with time and location. | photo capture + voice query |
| 🛒 **Shopping Cart** | In-store shopping list for wearables. Snap a product (IKEA-aware), say *"add this to my cart"*. Ask *"what's in my cart"*, *"email me my cart"*. | photo capture + voice query |

**Live at:** [`endlessriver-cosmos.onrender.com`](https://endlessriver-cosmos.onrender.com/health)

---

## 📐 Architecture (one deploy, many skills)

```
src/
├── index.ts                  # mounts skill routers, starts cron
├── hmac.ts                   # shared HMAC middleware
├── shared/
│   ├── vision.ts             # Gemini Flash wrapper (reusable)
│   ├── geo.ts                # haversine, location parsing, time formatting
│   ├── push.ts               # Brain push with timeout
│   └── inventory.ts          # retailer-uploaded product catalog + fuzzy match
└── skills/
    ├── object-memory/
    │   ├── manifest.json     # paste into Trace dashboard
    │   ├── routes.ts         # /webhook + /mcp + /delete-user
    │   └── db.ts             # memories + places tables (SQLite)
    └── shopping-cart/
        ├── manifest.json
        ├── routes.ts         # photo-add, dialog queries, email checkout
        └── db.ts             # cart_items with soft delete + IKEA fields

inventory/
├── ikea-in.json              # 5 canonical IKEA India products (demo)
└── README.md                 # schema for retailers uploading their own

docs/
├── TUTORIAL.md               # full end-to-end walkthrough (~1200 lines)
└── buildathon/
    └── SKILL_BUILDER_PLAYBOOK.md
```

Each skill is mounted at `/<slug>` by `src/index.ts`. Registered separately in the Trace dashboard with its own HMAC secret. One Render instance, one DB per skill, shared plumbing.

---

## 🎤 Talking to the glasses

### Object Memory

**Save a memory** — just take a photo. Every `media.photo` event gets remembered (passive subscription, no voice command needed). You'll hear *"I'll remember: keys, wallet, mug"* within ~2 seconds.

**Name a place** — voice dialog:
- *"Call this place home"*
- *"Mark this as office"*

**Recall** — voice dialog:
- *"Where are my keys?"* → *"I last saw your keys at home, on the kitchen counter, 12 minutes ago."*
- *"That black thing I had earlier"* → semantic fallback via Gemini

### Shopping Cart

**Add via photo:**
1. Press the button → dialog mode → *"add this to my cart"*
2. Snap the product
3. Hear *"Added MARKUS office chair (₹24,990, aisle 22 bin 50) to your cart."*

**Add via voice only:** *"Add a toothbrush to my cart"*

**Query:**
- *"What's in my cart?"* → reads items + total
- *"What's in my IKEA cart?"* → brand-filtered
- *"Remove the lamp"* → fuzzy match
- *"Clear my cart"* → `confirm_action` prompt before wiping
- *"Email me my cart"* → Gmail gets an HTML pick list sorted by aisle/bin

---

## 🛍️ Inventory enrichment (the IKEA trick)

When a user photographs a product, Gemini Flash guesses: *"blue Markus office chair, maybe ~$250, probably IKEA"*. We then fuzzy-match that guess against any loaded retailer inventory and **override** with canonical data (real price ₹24,990, exact SKU `702.611.50`, aisle 22 bin 50, product URL, image).

Gemini still does the vision heavy-lifting. Inventory enrichment is **additive** — no inventory just means Gemini's guess is stored as-is.

**Adding your own inventory:** drop a JSON file at `inventory/my-store.json` matching the schema in [`inventory/README.md`](./inventory/README.md). Point `INVENTORY_PATH` at a directory and all JSONs are merged. Restart the server.

Current demo: 5 iconic IKEA India products (MARKUS, KALLAX, MALM, BILLY, POÄNG). Real retailers would upload the full catalog.

---

## 🚀 Quickstart (local dev)

```bash
git clone git@github.com:Rashmi-278/endlessriver-cosmos.git
cd endlessriver-cosmos
npm install
cp .env.example .env
# fill in OBJECT_MEMORY_HMAC_SECRET, OBJECT_MEMORY_SKILL_ID, GEMINI_API_KEY
# (same for SHOPPING_CART_* once you register that skill)

npm run dev
```

Expose to the internet for Trace dashboard registration:
```bash
ssh -R 80:localhost:3000 nokey@localhost.run
```
Use the `https://*.localhost.run` URL as your webhook + MCP URLs in the dashboard.

**Smoke tests** (all three run in ~15s each):
```bash
npx ts-node scripts/smoke.ts            # object-memory end-to-end
npx ts-node scripts/smoke-cart.ts       # shopping-cart end-to-end
npx ts-node scripts/smoke-inventory.ts  # inventory fuzzy matcher
```

---

## 📝 Trace dashboard registration

Each skill needs its own entry in [dashboard → Skills → Create New Skill](https://dashboard.endlessriver.ai/skills).

**Minimum fields both skills share:**
- `Interface`: **Hybrid** (not Webhook — MCP is required for voice)
- `Execution`: Sync, < 10s
- `Webhook URL`: `https://<your-host>/<skill-slug>/webhook`
- `MCP URL`: `https://<your-host>/<skill-slug>/mcp`
- `Deletion webhook`: `https://<your-host>/<skill-slug>/delete-user`

**Per-skill fields** live in each `src/skills/<slug>/manifest.json` — copy the `triggers`, `domains`, `permissions`, `allowedTools` from there.

After save, Trace issues an **HMAC Secret** and **Skill ID**. Paste them as `<SLUG>_HMAC_SECRET` and `<SLUG>_SKILL_ID` on your host. Render auto-redeploys on env var change.

---

## 🔒 Security

- **HMAC verification** on both `/webhook` and `/mcp` (the template's `/mcp` was open; fixed here).
- **Proxy IDs** everywhere — Trace hands us a stable `user.id` we never associate with real identity. Every table is scoped by it.
- **Zero-OAuth platform tools** — `mail.send` is invoked with `{subject, body, html}`; we never touch the user's email address.
- **Data deletion** — each skill honors `POST /<slug>/delete-user` by wiping all rows for that user ID.

---

## 🚢 Deployment (Render primary)

This repo auto-deploys to Render on every push to `master`. One service, free tier, Singapore region.

**First-time deploy (Render free tier):**

1. Create a web service from this repo.
2. Build command: `npm install && npm run build`
3. Start command: `npm start`
4. Set `NPM_CONFIG_PRODUCTION=false` (Render's default `NODE_ENV=production` skips devDeps → `tsc` fails otherwise)
5. Set env vars (table below). Use random placeholders for HMAC secrets until you register in Trace; swap real values after.

**Persistent storage caveat (Render free tier has no disk):**
- Demo / single-session testing: SQLite works. Memories and cart items survive while the instance is warm.
- Spin-down after 15 min idle wipes state. For durable storage swap to **Turso** (free tier, libSQL) — replace `better-sqlite3` with `@libsql/client`, convert DB layer to async.
- On **Railway / Fly.io** mount a volume and set `*_DB_PATH=/data/<skill>.db`.

**Cron note on free tier:** `node-cron` only fires while the Node process is running. The daily recap misses its 9pm IST slot if the service is spun down. Real fix: **Render Cron Jobs** (separate resource, free tier) hitting `/admin/run-recap/object-memory`. Deferred to TODOs.

---

## 🔑 Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OBJECT_MEMORY_HMAC_SECRET` | ✅ | — | Trace-issued. Verifies /object-memory webhook + MCP. |
| `OBJECT_MEMORY_SKILL_ID` | ✅ | — | Trace-issued. Used for Brain push. |
| `SHOPPING_CART_HMAC_SECRET` | ✅ | — | Same, for /shopping-cart. |
| `SHOPPING_CART_SKILL_ID` | ✅ | — | Same, for /shopping-cart. |
| `GEMINI_API_KEY` | ✅ | — | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey), free tier. |
| `BRAIN_BASE_URL` | — | `https://brain.endlessriver.ai` | Brain push target. |
| `INVENTORY_PATH` | — | `./inventory/ikea-in.json` | File or dir of retailer inventory JSONs. |
| `OBJECT_MEMORY_DB_PATH` | — | `./data/object-memory.db` | Point at a mounted volume in prod. |
| `SHOPPING_CART_DB_PATH` | — | `./data/shopping-cart.db` | Same. |
| `DAILY_RECAP_CRON` | — | `0 21 * * *` | node-cron expression. |
| `DAILY_RECAP_TZ` | — | `Asia/Kolkata` | IANA timezone. |
| `DAILY_RECAP_ENABLED` | — | `1` | `0` disables the cron entirely. |
| `DISABLE_SEMANTIC` | — | `0` | `1` disables LLM fuzzy fallback. |
| `NPM_CONFIG_PRODUCTION` | — | `false` | **Required on Render** to include devDeps for tsc. |
| `PORT` | — | `3000` | HTTP listen port. Render overrides. |

**Manual cron test:**
```bash
curl -X POST https://endlessriver-cosmos.onrender.com/admin/run-recap/object-memory \
  -H "x-admin-secret: $OBJECT_MEMORY_HMAC_SECRET"
```
Fires the daily recap for any user with memories since midnight local.

---

## ➕ Adding a new skill (the 10-step pattern)

1. `mkdir src/skills/<slug>/`
2. Write `db.ts`, `routes.ts`, `manifest.json` (copy `shopping-cart` — it's the fuller template).
3. Export `buildXxxRouter(cfg)` that returns an Express Router closed over `{hmacSecret, skillId}`.
4. Mount in `src/index.ts`:
   ```ts
   import { buildNewSkillRouter } from './skills/<slug>/routes';
   app.use('/<slug>', buildNewSkillRouter({
     hmacSecret: process.env.NEW_SKILL_HMAC_SECRET!,
     skillId: process.env.NEW_SKILL_SKILL_ID!,
   }));
   ```
5. Add env vars to `.env.example`.
6. Write `scripts/smoke-<slug>.ts` with HMAC-signed end-to-end tests.
7. Local smoke → all green.
8. `git push` → Render auto-deploys.
9. Register in Trace dashboard with `/<slug>/*` URLs.
10. Paste the new HMAC + skill ID back into Render env. Auto-redeploy. Done.

Full deep dive: [`docs/TUTORIAL.md`](./docs/TUTORIAL.md) — pilot onboarding (TestFlight, glasses pairing), per-skill testing manuals, live debugging playbook.

---

## 🧰 Tech

- **TypeScript** on Node 18+, strict mode
- **Express** with mounted routers per skill
- **SQLite** via `better-sqlite3` (sync, zero-setup)
- **Gemini 1.5 Flash** for vision + semantic match (free tier: 15 RPM, 1.5k/day)
- **node-cron** for scheduled pushes
- **HMAC-SHA256** with `timingSafeEqual` for Trace-signed requests
- **Render** free tier hosting (Singapore)

---

## 📚 Docs

- [`docs/TUTORIAL.md`](./docs/TUTORIAL.md) — the full story: how we built this, decisions made, gotchas hit, testing manuals
- [`inventory/README.md`](./inventory/README.md) — schema + upload flow for retailer catalogs
- [`TODOS.md`](./TODOS.md) — deferred work (audio narration mode, Render cron jobs, Turso migration)
- [`docs/buildathon/SKILL_BUILDER_PLAYBOOK.md`](./docs/buildathon/SKILL_BUILDER_PLAYBOOK.md) — EndlessRiver's official skill builder doc
- [`TRACE_SKILL_LLM_CONTEXT.md`](./TRACE_SKILL_LLM_CONTEXT.md) — platform reference (channels, actions, routing)

---

## 🙏 Credits

Built during the EndlessRiver Trace pilot. Template and platform by the **EndlessRiver AI** team ([ishaan@endlessriver.ai](mailto:ishaan@endlessriver.ai)). Developer reference lives at [endlessriver.ai/dashboard/docs](https://endlessriver.ai/dashboard/docs).

Happy wearing. 🕶️
