# Building Trace Skills End-to-End

*A step-by-step tutorial covering how we designed, built, and deployed two Trace skills — **Object Memory** (photographic recall) and **Shopping Cart** (in-store add-to-list) — on a single Render instance.*

This is the record of what we actually did, in order, with every decision, gotcha, and command. You can follow it to reproduce the work or to build a new skill on the same chassis.

---

## 0. What we built, at a glance

**Skill 1 — Object Memory.** You snap a photo of where you put something (keys on the kitchen counter). Later you ask *"where are my keys?"* and get a voice answer: *"I last saw your keys at home, on the kitchen counter next to a coffee mug, 2 hours ago."*

**Skill 2 — Shopping Cart.** You walk through IKEA, snap a chair, say *"add this to my cart"*. Later you ask *"what's in my cart?"* or *"email me my cart"*.

Both skills run on **one Render web service**. One Git repo. One Node process. Shared `HMAC` middleware, shared Gemini vision wrapper, shared geolocation helpers. Each skill is self-contained in `src/skills/<slug>/` and mounted at `/<slug>` by a thin entrypoint.

**Live URL:** `https://endlessriver-cosmos.onrender.com`
**Repo:** `github.com/Rashmi-278/endlessriver-cosmos`

---

## 1. Prerequisites

This section splits into two halves: **what the Trace team gives you** (hardware, invite, playbook, companion app via TestFlight) and **what you set up yourself** (GitHub, Render, Gemini, local Node).

### 1.1 What Trace / Endless River gives you

This is a pre-launch pilot, so the onboarding is hand-held by the Endless River team (Ishaan Bansal is the person we worked with). Four things show up:

**1. The physical glasses.** Picked up in person (at the pilot we attended there were ~15 M08 units in a box, all identically named — a temporary BLE-pairing quirk that'll be fixed with unique IDs before public launch). You confirm you're paired by playing music from your phone and hearing it on *your* glasses rather than a neighbour's.

**2. An invite to the Trace iPhone companion app via TestFlight.** This is the one that trips people up, so the detail:

- Ishaan adds your Apple ID email to App Store Connect as an internal/external tester.
- You get an email from Apple titled something like *"You have been invited to test Trace"*.
- That email contains a **TestFlight redeem code** (or a direct link).
- You install Apple's **TestFlight** app from the App Store on your iPhone (free, first-party Apple app).
- Open TestFlight → "Redeem" → paste the code (or just tap the link in the email and it deep-links into TestFlight).
- The Trace app appears in your TestFlight list → tap **Install** → it installs alongside your normal apps.
- Open the Trace app → create an account (email + verification code typically) → pair to your glasses via Bluetooth.

TestFlight builds expire every 90 days, so expect periodic "new build available" prompts during the pilot. Apple limits internal testers to 100 and external testers to 10,000, which is plenty for a pilot.

**3. Access to the Trace Developer Dashboard.** A web dashboard where you register your skill (paste URLs, list triggers, define domains, get issued an HMAC secret + skill ID). This is where you came back to in Step 14 of this tutorial.

**4. The Skill Builder Playbook.** A prose walkthrough of the platform (channels, actions, examples) linked from the template README. Copy of it lives in `docs/buildathon/SKILL_BUILDER_PLAYBOOK.md` in the template repo you cloned. Worth reading top-to-bottom before writing code — it's ~30 min and saves you hours of guessing what's possible.

**Android note.** At the time of writing, the companion app is iOS-only on TestFlight. When Android lands, distribution typically happens via one of:
- **Google Play Internal Testing** — uploads an AAB to Play Console, testers opt in via a link, install through the Play Store (most common for production-bound apps)
- **Firebase App Distribution** — looser sideload, tester gets an email with an install link, no Play Store involvement
- **Direct APK sideload** — for very early builds, just an APK file shared over Slack/email; you enable "Install unknown apps" on your device

Neither TestFlight nor any of the Android equivalents can be shortcut — Apple and Google both gate pre-release distribution. Expect the same flow on Android once it exists.

### 1.2 What you set up yourself

| Thing | Why |
|---|---|
| Trace developer dashboard access | Register skills, get HMAC secrets + skill IDs (given to you per 1.1 above) |
| GitHub account (we used `Rashmi-278`) | Render deploys from a Git remote |
| Render account (free tier fine) | To host the Node server publicly |
| Google AI Studio API key | Free Gemini 1.5 Flash access — 15 RPM / 1,500 req/day. Create at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey), no credit card |
| Node 18+ locally | Build and smoke-test before deploying |
| SSH key on GitHub | For `git push` without password prompts — `ssh-keygen -t ed25519` then paste the pub key into github.com/settings/keys |

You can sub Render for Railway / Fly / your own VPS. You can sub Gemini for OpenAI `gpt-4o-mini` or Anthropic Claude — any vision LLM with JSON mode works.

### 1.3 The user flow end-to-end (what actually happens the first time)

From zero to "I'm holding the glasses and the skill I built is running":

```
1. Get contacted by Ishaan → he collects your Apple ID email + GitHub handle
2. Receive TestFlight invite email from Apple → redeem code → install TestFlight + Trace app
3. Pick up the physical glasses (pair with music-playback sanity check)
4. Open Trace app on iPhone → sign in → pair glasses over Bluetooth
5. Get access to the developer dashboard → browse existing skills
6. Clone the template repo: git clone git@github.com:EndlessRiverAI/trace-template-skill.git
7. Read docs/buildathon/SKILL_BUILDER_PLAYBOOK.md end-to-end (~30 min)
8. Build your skill locally (steps 1-12 of this tutorial)
9. Deploy to Render (step 13)
10. Register in Trace dashboard (step 14) → get HMAC secret + skill ID
11. Set the real HMAC + skill ID as Render env vars → auto-redeploy
12. Wear the glasses → test the skill end-to-end (Section 11)
```

Steps 1-5 are people-gated (you wait for Ishaan to invite you, the email to arrive, the glasses to be handed over). Steps 6-12 are all you.

---

## 2. Understanding the Trace platform (the mental model)

Everything else hangs off this, so read it once:

**A Trace Skill is a web server the Trace cloud calls into.** Your server doesn't run on the glasses. It sits behind a URL. Trace routes events to it.

**Two channels matter:**
1. **Webhook (`POST /webhook`)** — event-driven. Trace sends you JSON when something happens on the glasses (photo captured, audio recorded, user spoke).
2. **MCP (`POST /mcp`)** — JSON-RPC 2.0, the voice interface. Trace calls `tools/list` to discover your capabilities and `tools/call` to invoke them when the user speaks matching utterances.

**Events you can subscribe to:**
- `media.photo` — user snapped a photo
- `media.audio` — user finished a recording (with transcript)
- `interaction.dialog` — user said something meant for a skill (routed via your `domains`)

**What your skill can respond with (Actions):**
- `notification` — TTS + toast on glasses
- `feed_item` — entry in the daily feed
- `confirm_action` — Yes/No prompt before destructive ops
- `tool_call` — platform-managed tools (`mail.send`, `calendar.create`) — zero-OAuth, the platform fills in auth
- `set_todo`, `set_reminder` — platform-managed lists

**Security:** every request from Trace is signed with HMAC-SHA256 over `${timestamp}.${rawBody}` using a secret you get from the dashboard. **Every endpoint must verify this or you're wide open.**

**Proactive push:** your skill can call `POST ${BRAIN_BASE_URL}/api/skill-push/${SKILL_ID}` with `Authorization: Bearer ${HMAC_SECRET}` to push notifications to the user without a trigger (daily digest, reminder, async result).

**What you do NOT get:**
- Bluetooth / BLE pairing control — that's phone/OS layer
- Continuous video stream — only discrete `media.photo` + `media.audio`
- Screen recording or UI instrumentation
- Raw user identity — only a stable **proxied `user.id`** you can use as a DB primary key

These constraints ruled out three ideas we originally considered (M08 pairing, UI flow debugging, dance video breakdown). Recognizing what's *not* possible upfront saved hours.

---

## 3. Plan phase — before a single line of code

Before writing code, we ran a structured plan review (the `/plan-ceo-review` skill). Here's what mattered:

### 3.1 Premise challenge

We were going to build "object memory" ("where are my keys?"). The inversion reflex: **what would make this fail?**

- Judges have seen "where are my keys" 10 times. Saturated demo.
- Vision LLMs confuse similar-looking scenes. Accuracy risk.
- Phone `Find My` already solves the specific "keys with Bluetooth tracker" case.

Verdict: still a good fit for the platform, but we should **polish the retrieval UX** (time + location context in the voice reply) so it feels *useful* rather than gimmicky.

### 3.2 Scope modes

Four options (EXPANSION / SELECTIVE / HOLD / REDUCTION). We picked **SELECTIVE EXPANSION** — hold baseline rigor, surface expansion opportunities one at a time, user cherry-picks.

### 3.3 Cherry-picks considered

| Expansion | Effort | Demo wow | Decision |
|---|---|---|---|
| Proactive daily recap | S (~10 min) | HIGH | Deferred initially; built later |
| Semantic LLM query fallback | M (~20 min) | HIGH (risky in live demo) | Built later |
| Location-tagged memory | S (~10 min) | MED | Accepted immediately |
| `confirm_action` before logging | S (~5 min) | LOW | Skipped |

### 3.4 The 11 review sections (compressed, since we were time-boxed)

Key findings:
- **Error & Rescue Map** — 2 gaps: presigned image URL 403 + Gemini 5xx. Patched inline with try/catch → graceful "I couldn't save that memory" notification.
- **Security** — `/mcp` had no HMAC in the template. Added. Decision point, user accepted.
- **Data flow** — zero-row case, empty utterance, stale URL. All handled.
- **Tests** — deferred formal unit tests; built a HMAC-signed smoke script instead.
- **Deploy** — flagged that SQLite on ephemeral platforms (Vercel, Render free) dies on redeploy. Accepted for demo.

### 3.5 The plan doc

Written to `~/.gstack/projects/EndlessRiverAI-trace-template-skill/ceo-plans/2026-04-18-object-memory.md`. Captures scope decisions, accepted/deferred/skipped items, engineering preferences applied. It's a living record — later CEO reviews see it.

---

## 4. Step-by-step build

### Step 1 — Clone the template and install deps

The Trace team publishes a starter: `EndlessRiverAI/trace-template-skill`. It gave us HMAC middleware, `/webhook` scaffold, `/mcp` scaffold, and Brain push helper for free.

```bash
git clone git@github.com:EndlessRiverAI/trace-template-skill.git
cd trace-template-skill
npm install
cp .env.example .env
```

Then added the deps our skill needed:

```bash
npm install better-sqlite3 @google/generative-ai node-cron
npm install -D @types/better-sqlite3 @types/node-fetch @types/node-cron
```

**Why these:**
- `better-sqlite3` — synchronous SQLite driver. Single-process Node fits this perfectly. Avoids async plumbing on every query.
- `@google/generative-ai` — official Gemini SDK. Supports vision (inline base64 images).
- `node-cron` — cron-expression scheduler that runs in the Node process. Good enough until Render free tier's 15-min spin-down bites.

**Gotcha on Render:** `better-sqlite3` is a native module requiring node-gyp compilation. Adds ~60s to the Render build. Works fine; just budget for it.

### Step 2 — Design the DB schema

Object Memory needs to persist per-user photo events with their extracted structure, plus named places for location filtering.

`src/skills/object-memory/db.ts`:

```ts
CREATE TABLE memories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,          -- proxied Trace user ID
  ts         INTEGER NOT NULL,          -- ms epoch
  objects    TEXT    NOT NULL,          -- JSON array of lowercased nouns
  scene      TEXT,                      -- "on the kitchen counter next to a mug"
  location   TEXT,                      -- "lat,lng" from user.location
  image_url  TEXT,                      -- presigned URL (expires)
  request_id TEXT                       -- trace request_id for debugging
);
CREATE INDEX idx_memories_user_ts   ON memories(user_id, ts DESC);
CREATE INDEX idx_memories_user_objs ON memories(user_id, objects);

CREATE TABLE places (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT    NOT NULL,
  name       TEXT    NOT NULL,          -- "home", "office", etc. lowercased
  lat        REAL    NOT NULL,
  lng        REAL    NOT NULL,
  radius_m   INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
```

**Design decisions:**
- `objects` as a JSON string, not a separate table. We never need to JOIN on object; we only LIKE-match. Denormalize for simplicity.
- `location` as `"lat,lng"` string. Haversine comparisons happen at query time.
- `user_id` is always the proxied ID from Trace. Never a real identity.
- Composite index `(user_id, ts DESC)` for the daily recap query (`WHERE user_id = ? AND ts >= ?`).

### Step 3 — Vision extraction via Gemini

`src/shared/vision.ts`:

```ts
const EXTRACTION_PROMPT = `You are an object-memory assistant. Look at this image and return strict JSON:
{"objects": ["keyword1", "keyword2"], "scene": "one-sentence description..."}

Rules:
- objects: 1-8 everyday nouns... Lowercase. No articles.
- scene: describe WHERE the objects are (surface, room, container)...
- Return ONLY the JSON object. No preamble, no markdown fence.`;
```

**Why strict JSON + explicit "no markdown fence":** Gemini often wraps JSON in ``` ``` fences even when told not to. Our `parseJsonLoose()` strips fences and as a final fallback does a `{...}` regex match. **Every LLM-JSON integration needs loose parsing, always.**

Flow:
1. Download presigned image URL → base64
2. `genAI.getGenerativeModel('gemini-1.5-flash')`
3. `generateContent([{inlineData: {data: base64, mimeType}}, {text: PROMPT}])`
4. Parse, validate (`objects.length > 0`), return

**Timeout handling:** wrap `fetch` in `AbortController` with 12s timeout. Trace expects our webhook to return 202 fast; actual vision work happens async after the response.

### Step 4 — HMAC verification middleware

`src/hmac.ts` (came with the template, we kept it verbatim):

```ts
export function verifyTraceSignature(secret: string) {
  return (req, res, next) => {
    const signature = req.headers['x-trace-signature'];
    const timestamp = req.headers['x-trace-timestamp'];
    if (!signature || !timestamp) return res.status(401).json({ error: 'Missing signature or timestamp' });

    // 5-min replay window
    if (Math.abs(Date.now() - parseInt(timestamp, 10)) > 5 * 60 * 1000) {
      return res.status(401).json({ error: 'Request timestamp expired' });
    }

    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${JSON.stringify(req.body)}`)
      .digest('hex');

    if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return next();
    return res.status(401).json({ error: 'Invalid signature' });
  };
}
```

**Critical bug the template had:** only `/webhook` was HMAC-protected in the example; `/mcp` was wide open. We fixed this — `/mcp` must also verify. Both endpoints receive the same signed requests from Trace.

### Step 5 — The webhook handler

`src/skills/object-memory/routes.ts`:

```ts
router.post('/webhook', verifyTraceSignature(cfg.hmacSecret), async (req, res) => {
  const { event, user, request_id, callback_url } = req.body;

  // ACK immediately — Trace expects <10s response
  res.status(202).json({ status: 'accepted', request_id });

  if (event?.channel !== 'media.photo') return;

  const photo = event.items?.find(it => it?.url);
  if (!photo) return;

  try {
    const vision = await visionExtract(photo.url, EXTRACTION_PROMPT);
    insertMemory({
      user_id: user.id,
      objects: vision.objects,
      scene: vision.scene,
      location: locationString(user),    // "lat,lng" or null
      image_url: photo.url,
      request_id,
    });
    // Push TTS confirmation back via Brain push API
    await sendPushResponse(cfg.skillId, cfg.hmacSecret, user.id, [
      { type: 'notification', content: { title: 'Memory saved', body: `I'll remember: ${vision.objects.slice(0,3).join(', ')}.`, tts: true } }
    ], callback_url);
  } catch (err) {
    // Graceful: user hears "I couldn't save that one" instead of silent drop
    await sendPushResponse(..., [{ type: 'notification', content: { title: 'Memory skipped', body: `I couldn't save that one.` } }]);
  }
});
```

**The 202-then-process pattern is mandatory.** Trace's gateway times out the webhook in ~10s. Vision + DB + push could easily exceed that. Always: `res.status(202)` first, work after.

### Step 6 — The MCP handler

MCP is JSON-RPC 2.0. Two methods to implement:

**`tools/list`** — returns the schema of every tool we expose:
```ts
{
  name: 'handle_dialog',
  description: 'Answers questions about where the user last saw an object...',
  inputSchema: { type: 'object', properties: { utterance: { type: 'string' } }, required: ['utterance'] }
}
```

**`tools/call`** — Trace invokes this when the user's utterance matches our `domains`. We inspect `params.name` and `params.arguments.utterance` and return `content: [{type: 'text', text}, {type: 'embedded_responses', responses: [...]}]`.

The `embedded_responses` field is where the Actions live (notification, feed_item, confirm_action, tool_call). This is how MCP responses trigger glasses-side behaviors.

**Retrieval logic:**
1. Extract keyword from utterance (strip stopwords, take last meaningful noun)
2. `SELECT * FROM memories WHERE user_id = ? AND objects LIKE ? ORDER BY ts DESC LIMIT 1`
3. Format reply: `"I last saw your ${obj} [at ${place}], ${scene}, ${timeAgo}."`

### Step 7 — Location-aware replies

When a memory is retrieved, we check if its stored `lat,lng` falls within any named place's radius:

```ts
export function placeNameForLocation(userId, loc) {
  const coord = parseLocation(loc);  // "12.97,77.59" -> {lat, lng}
  if (!coord) return null;
  for (const p of listPlaces(userId)) {
    if (haversineM(coord.lat, coord.lng, p.lat, p.lng) <= p.radius_m) return p.name;
  }
  return null;
}
```

**Haversine formula** (great-circle distance on Earth):

```ts
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6_371_000;  // Earth radius in meters
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
```

**Naming a place** — a MCP tool:
```ts
if (name === 'mark_place') {
  upsertPlace({ user_id: userId, name: args.name, lat: user.location.lat, lng: user.location.lng });
}
```

Also supports natural-language routing inside `handle_dialog`: if the utterance matches `/call this place (\w+)/`, we extract the name and upsert. So saying *"call this place home"* just works without Trace needing to route to a different tool.

### Step 8 — Proactive daily recap

`node-cron` schedules a job at 21:00 IST:

```ts
cron.schedule('0 21 * * *', () => {
  runDailyRecap(OBJECT_MEMORY.skillId, OBJECT_MEMORY.hmacSecret);
}, { timezone: 'Asia/Kolkata' });
```

`runDailyRecap()`:
1. `activeUsersSince(startOfDay)` — which users have logged anything today
2. For each user, `memoriesSince(user_id, startOfDay)`
3. Build summary: *"Today I logged: keys at home; wallet on desk; passport in drawer."*
4. `sendPushResponse()` with a `notification` action — TTS + persistent toast

**Admin endpoint for manual trigger** (used during demos + QA):
```ts
app.post('/admin/run-recap/object-memory', (req, res) => {
  if (req.headers['x-admin-secret'] !== OBJECT_MEMORY.hmacSecret) return res.status(401).json({});
  runDailyRecap(...).catch(console.error);   // fire-and-forget
  res.json({ ok: true, queued: true });
});
```

Fire-and-forget matters: earlier we `await`ed the recap and the admin endpoint hung for ~30s waiting on push fetch. Now it returns instantly.

**Render-free-tier caveat:** the service spins down after 15 min of no requests. If the spin-down happens before 21:00 IST, the cron silently misses the slot. Proper fix: **Render Cron Jobs** (separate resource, free tier) that hits our admin endpoint from outside. Deferred to TODOs.

### Step 9 — Semantic fallback

For fuzzy queries like *"that black thing I had earlier"*, keyword extraction fails. We fall back to Gemini:

```ts
const recent = recentMemories(userId, 20);
const prompt = `The user asked: "${utterance}"
Here are their recent memories (most recent first):
${recent.map(m => `id=${m.id} ts=${m.ts} objects=${m.objects} scene="${m.scene}"`).join('\n')}
Pick the memory that best matches. Return JSON: {"memory_id": <n or null>, "reason": "canonical name"}`;

const sem = await textExtract(prompt);
if (sem?.memory_id) {
  const hit = recent.find(m => m.id === sem.memory_id);
  return fullDialogReply(id, memoryToReplyText(userId, hit, sem.reason), sem.reason);
}
```

Env toggle `DISABLE_SEMANTIC=1` turns it off (cheaper, faster, loses fuzzy queries). Useful if Gemini rate-limits during a live demo.

### Step 10 — Refactor to multi-skill layout

Once we knew we'd add Shopping Cart, we refactored **before** adding it. Why: if Object Memory lives flat at `/webhook` + `/mcp`, adding a second skill either breaks those URLs (need to update dashboard) or requires a second Render service (wastes free tier).

**Before:**
```
src/
  index.ts            # all routes
  db.ts, vision.ts    # skill-specific but at root
```

**After:**
```
src/
  index.ts            # thin mount layer: app.use('/object-memory', ...); app.use('/shopping-cart', ...);
  hmac.ts             # shared
  shared/
    vision.ts         # Gemini wrapper (generic)
    geo.ts            # haversine, parseLocation, formatTimeAgo
    push.ts           # skill-push with timeout
  skills/
    object-memory/
      routes.ts       # buildObjectMemoryRouter(cfg)
      db.ts           # memories + places tables
      manifest.json
    shopping-cart/
      routes.ts       # buildShoppingCartRouter(cfg)
      db.ts           # cart_items table
      manifest.json
```

Each skill has its own HMAC secret and skill ID, read from env: `OBJECT_MEMORY_HMAC_SECRET`, `SHOPPING_CART_HMAC_SECRET`, etc. `buildXxxRouter(cfg)` factory takes them as config, HMAC middleware is closed over.

**Why it matters:** adding Shopping Cart was now ~45 min of work (copy object-memory folder, change prompts, change SQL schema) rather than ~2 hours of disentanglement.

### Step 11 — Shopping Cart (the second skill)

Same pattern, different prompts + schema. Highlights:

**Schema** (`src/skills/shopping-cart/db.ts`):
```sql
CREATE TABLE cart_items (
  id, user_id, ts,
  name, category, price_est_usd, store_guess, qty,
  image_url, notes, source,                     -- 'photo' | 'dialog_text'
  status                                        -- 'active' | 'removed' | 'purchased'
);
```

Soft-delete via `status` instead of `DELETE`, so "what did I remove last week" stays answerable.

**Intent classifier** (regex-based, not LLM, to avoid 1-2s latency on every utterance):
```ts
if (/what(?:'s|s| is)?\s+in\s+(?:my\s+)?cart/.test(u)) return { type: 'list' };
if (/\b(clear|empty|wipe)\s+.*cart/.test(u))           return { type: 'clear' };
if (/\b(checkout|email\s+(?:me\s+)?(?:my\s+)?cart)/.test(u)) return { type: 'checkout' };
const rm = u.match(/\b(?:remove|delete)\s+(?:the\s+)?(.+)$/);
if (rm) return { type: 'remove', target: rm[1] };
// ...
```

**`confirm_action` for destructive ops:**
```ts
case 'clear': return {
  embedded_responses: [{
    type: 'confirm_action',
    content: {
      prompt: `Clear all ${items.length} items?`,
      on_confirm: { type: 'tool_call', name: 'handle_dialog', arguments: { utterance: '__confirm_clear__' } },
      on_decline: { type: 'notification', content: { title: 'Cart kept', body: 'Cart untouched.' } }
    }
  }]
};
```

The `on_confirm` callback loops back through our own dialog handler with a sentinel string. Keeps logic centralized.

**Email checkout via platform tool:**
```ts
case 'checkout': return {
  embedded_responses: [
    { type: 'notification', content: { title: 'Cart emailed', body: summary, tts: true } },
    { type: 'tool_call', name: 'mail.send', arguments: { subject, body, html } }
  ]
};
```

`mail.send` is a platform-managed tool. **We never see or touch the user's email address** — Trace owns that, we supply subject/body/html only. Zero-OAuth.

### Step 12 — Smoke tests (before deploying anything)

`scripts/smoke.ts` and `scripts/smoke-cart.ts` — HMAC-signed end-to-end tests that hit the local server.

```ts
function sign(body) {
  const ts = Date.now().toString();
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
  return { ts, sig };
}

function post(path, body) {
  const raw = JSON.stringify(body);
  const { ts, sig } = sign(raw);
  // ... http.request with x-trace-signature + x-trace-timestamp headers
}

// Test the full loop:
// 1. tools/list returns expected tools
// 2. Seed DB directly (bypass the vision path)
// 3. POST /mcp handle_dialog → assert reply text contains expected substrings
// 4. Clean up via /delete-user
```

Run via:
```bash
DAILY_RECAP_ENABLED=0 DISABLE_SEMANTIC=1 npx ts-node src/index.ts > /tmp/server.log 2>&1 &
npx ts-node scripts/smoke.ts
```

14 assertions for object-memory, 14 for shopping-cart. **Every change ran the smoke suite before deploy.**

### Step 13 — Deploy to Render (free tier)

#### Create the service

Via the Render MCP tool (can also use the dashboard UI):

```ts
mcp__render__create_web_service({
  name: 'endlessriver-cosmos',
  runtime: 'node',
  repo: 'https://github.com/Rashmi-278/endlessriver-cosmos',
  branch: 'master',
  buildCommand: 'npm install && npm run build',
  startCommand: 'npm start',
  plan: 'free',
  region: 'singapore',         // closest to IST for latency
  autoDeploy: 'yes',           // redeploy on every push to master
  envVars: [
    { key: 'GEMINI_API_KEY', value: '...' },
    { key: 'OBJECT_MEMORY_HMAC_SECRET', value: '<random placeholder>' },
    { key: 'OBJECT_MEMORY_SKILL_ID', value: 'pending-trace-registration' },
    { key: 'DAILY_RECAP_ENABLED', value: '0' },
    // ...
  ]
});
```

#### Gotcha #1: Render's `NODE_ENV=production` skips devDependencies

Our first build failed: `tsc` couldn't find `@types/express`, `@types/node`, `@types/better-sqlite3`. Reason: Render sets `NODE_ENV=production` by default, which makes `npm install` skip `devDependencies`. All our `@types/*` lived there.

**Fix:** add env var `NPM_CONFIG_PRODUCTION=false`. Cleaner than rewriting the build command.

#### Gotcha #2: Placeholder HMAC → real HMAC swap

Render needs a URL to exist before Trace dashboard can register the skill. But Trace mints the HMAC secret on registration. Chicken-and-egg.

**Resolution:**
1. Deploy with a random 32-byte hex placeholder HMAC (so the server boots happily)
2. Register the skill in Trace dashboard using the `*.onrender.com` URL
3. Trace mints the real secret + skill ID
4. Paste them back; I swap via `mcp__render__update_environment_variables`
5. Render auto-redeploys in ~30s

#### Gotcha #3: `better-sqlite3` native compile time

First deploy: ~3-4 min. Subsequent deploys without deps changes: ~30-60s. Normal; just budget for it.

#### Verifying the deploy

```bash
curl https://endlessriver-cosmos.onrender.com/health
# {"ok":true,"skills":["object-memory","shopping-cart"],"semantic":true}

curl -X POST https://endlessriver-cosmos.onrender.com/object-memory/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# HTTP 401 (good — HMAC required)

# With HMAC:
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
TS=$(date +%s000)
SIG="sha256=$(echo -n "${TS}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
curl -X POST https://endlessriver-cosmos.onrender.com/object-memory/mcp \
  -H "x-trace-signature: $SIG" \
  -H "x-trace-timestamp: $TS" \
  -H "Content-Type: application/json" \
  -d "$BODY"
# {"jsonrpc":"2.0","id":1,"result":{"tools":[...]}}
```

### Step 14 — Register in the Trace dashboard

For each skill:
1. Dashboard → **Create New Skill**
2. **Interface: Hybrid** (not Webhook — you lose voice if you pick Webhook)
3. Paste URLs:
   - Webhook: `https://<host>/<slug>/webhook`
   - MCP: `https://<host>/<slug>/mcp`
   - Deletion: `https://<host>/<slug>/delete-user`
4. **Triggers:** `media.photo` (passive), `interaction.dialog` (active)
5. **Domains:** fill these in carefully — they're how the platform routes voice utterances to your skill
6. **Permissions:** check what you actually read from the `user` object — only request what you use
7. **Platform tools:** check `Send Email` only if you call `mail.send` in a `tool_call` action
8. **Save** → copy the HMAC Secret + Skill ID into the Render env vars

For Object Memory we used two domains:
- `object_recall`: *"Help the user find objects they placed earlier..."*
- `place_naming`: *"Name the user's current location..."*

For Shopping Cart we used one:
- `shopping`: *"Add, list, remove, clear, or email shopping cart items..."*

---

## 5. Environment variables reference

```bash
# Per-skill secrets (from Trace dashboard)
OBJECT_MEMORY_HMAC_SECRET=...
OBJECT_MEMORY_SKILL_ID=...
SHOPPING_CART_HMAC_SECRET=...
SHOPPING_CART_SKILL_ID=...

# Shared vision backend
GEMINI_API_KEY=...                  # https://aistudio.google.com/app/apikey — free tier
GEMINI_MODEL=gemini-1.5-flash       # optional override
DISABLE_SEMANTIC=0                  # 1 to skip LLM fallback

# Brain push target
BRAIN_BASE_URL=https://brain.endlessriver.ai

# Daily recap (object-memory)
DAILY_RECAP_CRON=0 21 * * *
DAILY_RECAP_TZ=Asia/Kolkata
DAILY_RECAP_ENABLED=1

# DB paths (point at mounted volume in prod)
OBJECT_MEMORY_DB_PATH=./data/object-memory.db
SHOPPING_CART_DB_PATH=./data/shopping-cart.db

# Render-specific
NPM_CONFIG_PRODUCTION=false         # include devDeps so tsc works
```

---

## 6. Tools and technologies catalog

| Layer | Tool | Why |
|---|---|---|
| Language | TypeScript 5, Node 18+ | Strong types catch shape errors before runtime; Gemini + Express have good types |
| Web framework | Express 4 | Battle-tested, `Router` mounts make multi-skill trivial |
| Body parsing | `body-parser` | Built-in to Express, we use it raw for HMAC verification |
| DB | SQLite via `better-sqlite3` | Synchronous, single-file, zero-setup. Handles 10k+ writes/sec easily |
| Vision LLM | Google Gemini 1.5 Flash | Free tier: 15 RPM / 1,500 req/day. Native multimodal. Fast (~1s). |
| Vision SDK | `@google/generative-ai` | Official, supports `inlineData` base64 image input |
| Crypto | `crypto` (built-in) | HMAC-SHA256 + `timingSafeEqual` for signature verification |
| Scheduling | `node-cron` | In-process cron, standard expressions with timezone support |
| HTTP fetch | `node-fetch` v2 | Whatwg-fetch polyfill that plays well with CJS |
| UUIDs | `uuid` | Request IDs, idempotency keys |
| Deploy target | Render (free tier, Singapore) | Long-running Node process, auto-deploy from GitHub, generous-enough free tier |
| Source control | Git + GitHub | Standard; Render pulls from the GitHub remote |
| CI | Render's built-in | Auto-build on push to master, fail loudly in dashboard |
| Local tunnel (alt) | `localhost.run` | For dev-time Trace registration without deploying |
| Dev loop | `nodemon` + `ts-node` | Hot-reload on TS changes |

---

## 7. Project structure (final)

```
endlessriver-cosmos/
├── src/
│   ├── index.ts                        # thin entrypoint: mounts skill routers, starts cron
│   ├── hmac.ts                         # HMAC middleware (shared)
│   ├── shared/
│   │   ├── vision.ts                   # Gemini wrapper: visionExtract(imageUrl, prompt), textExtract(prompt)
│   │   ├── geo.ts                      # haversine, parseLocation, locationString, formatTimeAgo
│   │   └── push.ts                     # sendPushResponse(skillId, secret, userId, responses)
│   └── skills/
│       ├── object-memory/
│       │   ├── routes.ts               # buildObjectMemoryRouter + runDailyRecap
│       │   ├── db.ts                   # memories + places
│       │   └── manifest.json
│       └── shopping-cart/
│           ├── routes.ts               # buildShoppingCartRouter
│           ├── db.ts                   # cart_items
│           └── manifest.json
├── scripts/
│   ├── smoke.ts                        # object-memory smoke test (14 assertions)
│   └── smoke-cart.ts                   # shopping-cart smoke test (14 assertions)
├── docs/
│   ├── TUTORIAL.md                     # this file
│   └── buildathon/
│       └── SKILL_BUILDER_PLAYBOOK.md   # from Trace
├── data/                               # gitignored, SQLite files live here
├── .env.example
├── .env                                # gitignored
├── .gitignore
├── manifest.json                       # REMOVED — each skill now has its own in src/skills/*/manifest.json
├── TRACE_SKILL_LLM_CONTEXT.md          # platform reference
├── TODOS.md                            # deferred work
├── README.md
├── deploy.sh
├── package.json
├── tsconfig.json
└── package-lock.json
```

---

## 8. The recurring patterns (copy these when you build a third skill)

### Pattern: adding a new skill

1. `mkdir src/skills/<slug>/`
2. Create `db.ts` — your tables, indexed on `user_id`
3. Create `routes.ts` — export `buildXxxRouter(cfg: { hmacSecret, skillId })` that returns an Express Router
4. Create `manifest.json` — endpoint URLs, triggers, domains, permissions
5. In `src/index.ts`, add:
   ```ts
   import { buildXxxRouter } from './skills/<slug>/routes';
   const XXX = { slug: '<slug>', hmacSecret: process.env.XXX_HMAC_SECRET, skillId: process.env.XXX_SKILL_ID };
   app.use(`/${XXX.slug}`, buildXxxRouter(XXX));
   ```
6. Add env vars to `.env.example`
7. Write `scripts/smoke-<slug>.ts`
8. `git commit && git push` → Render auto-deploys
9. Register in Trace dashboard with the new URL
10. Copy HMAC + skill ID back into Render env

### Pattern: the webhook handler

```ts
router.post('/webhook', verifyTraceSignature(cfg.hmacSecret), async (req, res) => {
  const { event, user, request_id, callback_url } = req.body;
  res.status(202).json({ status: 'accepted', request_id });     // ACK FAST
  if (event?.channel !== '<channel>') return;
  try {
    /* do the work: vision, DB, logic */
    await sendPushResponse(cfg.skillId, cfg.hmacSecret, user.id, [responses], callback_url);
  } catch (err) {
    await sendPushResponse(..., [graceful error notification]);
  }
});
```

### Pattern: the MCP handler

```ts
router.post('/mcp', verifyTraceSignature(cfg.hmacSecret), async (req, res) => {
  const { method, params, id } = req.body;
  if (method === 'tools/list') return res.json({ jsonrpc: '2.0', id, result: { tools: [...] } });
  if (method !== 'tools/call') return res.status(404).json({ error: { code: -32601 } });

  const userId = req.body?.user?.id;
  if (!userId) return res.json(mcpReply(id, "I don't know who's asking."));

  const utterance = String(params.arguments?.utterance ?? '').trim();
  const intent = classify(utterance);
  switch (intent.type) { /* ... */ }
});
```

### Pattern: graceful LLM JSON parsing

```ts
function parseJsonLoose(text, label) {
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); }
  catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${label}: non-JSON: ${cleaned.slice(0,120)}`);
    return JSON.parse(match[0]);
  }
}
```

### Pattern: `confirm_action` before destructive ops

```ts
{
  type: 'confirm_action',
  content: {
    prompt: 'Clear all items?',
    on_confirm: { type: 'tool_call', name: 'handle_dialog', arguments: { utterance: '__confirm_clear__' } },
    on_decline: { type: 'notification', content: { title: 'Cart kept', body: '...' } }
  }
}
```
Then handle the `__confirm_<x>__` sentinel inside your dialog classifier.

### Pattern: proxied ID as primary key

Every table has `user_id TEXT NOT NULL` indexed. We never store real identities — Trace hands us a stable proxy ID that we treat as opaque. `/delete-user` wipes everything for that ID on request.

---

## 9. Common gotchas (things that cost us real time)

| Gotcha | Fix | Time lost |
|---|---|---|
| Render skips devDependencies by default | `NPM_CONFIG_PRODUCTION=false` env var | ~10 min |
| Chicken-and-egg on HMAC secret (dashboard needs URL, Render needs secret) | Deploy with random placeholder, swap later | Built into plan |
| Gemini wraps JSON in ``` ``` fences randomly | `parseJsonLoose()` with fence strip + regex fallback | Caught in smoke |
| `node-fetch` v2 typings missing | `npm install -D @types/node-fetch` | 2 min |
| Admin endpoint hanging on push fanout | Fire-and-forget: `.catch(console.error)` without `await` | Caught in smoke |
| Timezone-naive cron | `cron.schedule(..., { timezone: 'Asia/Kolkata' })` | — |
| Grammar "your keys was" vs "your keys were" | Avoided verb conjugation: *"I last saw your keys..."* instead | 1 min |
| Zombie local dev servers on port 3000 | `fuser -k 3000/tcp` before every smoke run | — |
| `/mcp` missing HMAC in the template | Added `verifyTraceSignature` middleware to `/mcp` — this was critical | Flagged in CEO review |
| Render free tier spin-down breaking cron | Deferred to TODOs (use Render Cron Jobs) | — |

---

## 10. What we deferred (the honest TODOs)

Lifted from `TODOS.md`:

- **Shopping Cart Mode B' (audio narration walk-through)** — audio transcript → LLM extracts N items in one go. Platform supports `media.audio` with transcripts, so this is feasible; we just skipped for time.
- **Proactive daily recap on Render free** — spin-down breaks in-process cron. Fix: Render Cron Jobs resource hitting `/admin/run-recap/<slug>`.
- **Turso migration** — for when we need persistence across Render redeploys or move to Vercel/serverless. Swap `better-sqlite3` for `@libsql/client`, convert DB layer to async.
- **Image rehosting** — presigned URLs expire. Download + re-upload to S3-compatible storage so old memories stay queryable.
- **Location clustering** — DBSCAN on lat/lng history to auto-name places (no manual `mark_place`).
- **`confirm_action` before object-memory save** — for users who don't want every photo logged.
- **Real price lookup in Shopping Cart** — Gemini's price estimates are hallucinations. Integrate a product search API for real numbers.
- **Observability** — right now we only have `console.log`. No metrics, no traces. Fine for a demo, not for scale.

---

## 11. What a good run looks like (manual E2E on real glasses)

1. Service is live on Render, `*.onrender.com/health` returns `{"ok":true,"skills":[...]}`
2. Both skills registered in Trace dashboard, real HMAC + skill ID set on Render
3. Wear the glasses, put keys on the kitchen counter, snap a photo
4. Within ~2 seconds, TTS: *"I'll remember: keys, wallet, mug."*
5. Feed item appears in the Trace app: *"Object memory captured: on the kitchen counter next to a coffee mug"*
6. Walk to a different room. Say *"call this place bedroom"*. TTS: *"Got it. This is bedroom."*
7. Walk back to kitchen. Say *"where are my keys?"*. TTS: *"I last saw your keys at home, on the kitchen counter next to a coffee mug, 4 minutes ago."*
8. Open a store. Snap a lamp. Say *"add this to my cart"*. TTS: *"Added desk lamp (~$35) to your cart."*
9. Say *"what's in my cart?"*. TTS: *"You have 1 item: desk lamp (~$35). Estimated total: ~$35."*
10. Say *"email me my cart"*. Gmail inbox gets an HTML list via platform `mail.send`.

If all ten steps work, you shipped.

---

## 12. Testing both skills end-to-end (per-skill manuals)

This section is what you read **with the glasses on your face and the phone in your hand**. Two manuals, one per skill, each written so a non-dev pilot user could follow along. Plus a shared pre-flight checklist and a live-debug playbook.

### 12.1 Pre-flight checklist (run once before every test session)

Before wearing the glasses, confirm all four:

**A) The Render service is awake and healthy.**
```bash
curl https://endlessriver-cosmos.onrender.com/health
# Expected: {"ok":true,"skills":["object-memory","shopping-cart"],"semantic":true}
```
If you get a timeout or 500, the free-tier instance is cold-starting — wait ~30s and retry. If `skills` is missing an entry, the deploy didn't pick up the latest code; check the Render dashboard for a stuck deploy.

**B) Both skills are registered in the Trace dashboard.**
Open the Dashboard → Skills. You should see:
- **Object Memory** — interface: Hybrid, triggers: media.photo + interaction.dialog, URLs point at `https://endlessriver-cosmos.onrender.com/object-memory/*`
- **Shopping Cart** — interface: Hybrid, same URL pattern under `/shopping-cart/*`

Both should show "Active" (or "Approved" for proactive-push-enabled skills).

**C) Your glasses are paired to your phone.**
Open the Trace app on iPhone → Settings/Device → confirm glasses show as **Connected**. If stuck on "Searching": re-pair via Bluetooth settings. During the pilot, multiple M08 units advertise the same name, so pick the one with the highest signal strength (yours should be closest).

**D) Play-test audio.** With the glasses on, play any song from Apple Music/Spotify on your iPhone. You should hear it through the glasses speakers, not your iPhone speaker. If you hear it on the iPhone, the audio-route is still on the phone — tap the AirPlay icon in Control Center and select the Trace glasses.

Once all four pass, you're ready.

### 12.2 Skill manual — Object Memory

**What it does.** Gives you photographic memory for physical objects. You take a photo of where you placed something; later you ask in natural voice where that thing is; it tells you with time and location context.

**When it's useful.**
- You put your keys down somewhere and forget
- You stash your passport before a trip and can't remember which drawer
- You put a book on a shelf and want to find it weeks later
- You want a daily recap of what you interacted with ("today I handled: keys at home; laptop at office; passport at home")

**What it's NOT for.**
- Real-time object *tracking* (it only knows where you last photographed it)
- Fine-grained identity ("the red book" vs "the blue book" — works only if Gemini's vision extracted different labels)
- Anything requiring continuous video or ambient always-on capture

#### How to trigger a capture

1. **Hold the object you want to remember somewhere visible** — on the counter, on your desk, in your hand.
2. **Tap the button on the glasses to take a photo** (exact button location varies by hardware; the pilot uses a capacitive tap on the temple).
3. **Wait ~2 seconds.** You'll hear a TTS confirmation in your ear: *"I'll remember: keys, wallet, mug."* — the three things Gemini picked out of the scene.
4. **Check the Trace app feed** — a new entry appears: *"Object memory captured: on the kitchen counter next to a coffee mug."*

If you don't hear anything within ~5 seconds, the photo may have failed to process. Check Render logs (see 12.4).

#### How to query

Trigger voice dialog on the glasses (the pilot's UX: press-and-hold, or say a wake word — check with Ishaan which is active on your build). Then say any of:

| Utterance | What happens |
|---|---|
| *"Where are my keys?"* | Finds the most recent photo tagged with `keys`, replies with scene + time |
| *"Where did I leave my wallet?"* | Same, for wallet |
| *"Have you seen my passport?"* | Same, for passport |
| *"Find my laptop"* | Same, for laptop |
| *"Where's my phone?"* | Same, for phone — though tricky if the phone you're asking from is the phone you're asking about |

**Expected replies (format):**
> *"I last saw your keys at home, on the kitchen counter next to a coffee mug, 12 minutes ago."*

If no place is tagged:
> *"I last saw your keys on the kitchen counter next to a coffee mug, 12 minutes ago."*

If nothing matches:
> *"I haven't seen your keys yet."*

If you've never captured anything:
> *"I haven't seen anything yet. Snap a photo first."*

#### How to name a place (for "at home" / "at office" context)

Stand in the location you want to name. Trigger voice dialog. Say:
- *"Call this place home"*
- *"Mark this as office"*
- *"Name this kitchen"*
- *"Tag here as gym"*

Expected TTS: *"Got it. This is home."*

The skill records your current lat/lng with a 100m radius. Any future memory captured within 100m of that point will be tagged `at home` in the voice reply.

**Gotcha:** GPS accuracy indoors is ~20-50m. If you name "home" in your kitchen and later photograph something in your bedroom 15m away, it'll still show *"at home"* — that's fine, it's the intent. If you named two places within 100m of each other, the first match wins; give named places clean separation for best behaviour.

#### Fuzzy queries (semantic fallback)

If the keyword extractor doesn't match (you asked about *"that black thing I had earlier"* instead of a specific noun), the skill asks Gemini to look at your last 20 memories and pick the best match. Slower (~1-2s extra), often surprisingly good.

Try:
- *"That thing I was holding this morning"*
- *"The red folder I had earlier"*
- *"My keys that were on the counter"* (specific enough that regex catches it; fallback not invoked)

Set `DISABLE_SEMANTIC=1` on Render if you want to test without this fallback.

#### Daily recap (currently disabled in prod)

When enabled, at 21:00 IST the skill fires a push notification:
> *"Today I logged: keys at home; wallet at home; laptop at office."*

Disabled right now because Render free tier spins down after 15 min idle — the cron silently misses if the service is asleep. To test the logic manually:
```bash
curl -X POST https://endlessriver-cosmos.onrender.com/admin/run-recap/object-memory \
  -H "x-admin-secret: b377f097829875445f63a7e4b002cf0e4b124d0f9a3124ed8945364fbfdaec41"
# Expected: {"ok":true,"queued":true}
```
(Secret in the header is the HMAC secret from the Trace dashboard — same one Render uses.)

Production fix is deferred — see TODOs.md "Render Cron Jobs" item.

#### Test script (10-minute happy path)

1. Pre-flight checklist (12.1) passes.
2. Stand in your kitchen with your keys.
3. Photograph keys on the counter. → *"I'll remember: keys..."*
4. Say *"call this place kitchen"*. → *"Got it. This is kitchen."*
5. Walk to another room. Photograph your wallet on a desk. → *"I'll remember: wallet..."*
6. Walk back to the kitchen. Say *"where are my keys?"* → *"I last saw your keys at kitchen, on the counter..., 2 minutes ago."*
7. Say *"where's my wallet?"* → *"I last saw your wallet on a desk..., 1 minute ago."* (no place tag, because you didn't name the other room)
8. Try the semantic fallback: *"the thing I had in my hand earlier"* → should still pick one of your memories.

If steps 1-7 work, Object Memory is shipped. Step 8 is bonus.

### 12.3 Skill manual — Shopping Cart

**What it does.** Adds items to a per-user shopping list via photos. You're in a store, you see a product you want, you photograph it and say *"add this to my cart"*. Later you ask *"what's in my cart?"* or *"email me my cart"*.

**When it's useful.**
- Walking through IKEA/hardware store/grocery and wanting to build a list without typing
- Shopping for furniture over multiple store visits — capture in context, review later
- Comparison shopping — capture a few options, email yourself the list, decide at home
- Reminder list for things you'll buy online later ("I need batteries")

**What it's NOT for (Mode A limits).**
- Bulk add during a walk-through without photographing each item (that's Mode B' / audio narration — deferred)
- Actually placing orders (the skill lists; it doesn't transact)
- Real prices — Gemini's `estimated_price_usd` is a guess, not a lookup

#### How to add items

**Method 1: photo-based (the main flow).**

1. See a product in a store.
2. Trigger voice dialog. Say *"add this to my cart"*.
3. Reply: *"Sure, snap a photo of the item and I'll add it to your cart."*
4. Photograph the product (clear, well-lit, one product in frame).
5. Wait ~2 seconds. TTS: *"Added blue Markus office chair (~$270) at IKEA to your cart."*
6. Feed entry in the Trace app: *"Cart: +blue Markus office chair"*

The price + store are Gemini's best-guess; they're labeled as estimates. The skill stores whatever Gemini returns.

**Method 2: voice-only add (no photo).**

Trigger dialog. Say any of:
- *"Add a toothbrush"*
- *"Add batteries to my list"*
- *"Put a notebook in my cart"*

TTS: *"Added toothbrush to your cart."*

No price/category/store — these become text-only entries. Useful for remembering items that aren't in front of you.

#### How to query the cart

| Utterance | Behaviour |
|---|---|
| *"What's in my cart?"* | Reads back first 5 items + total estimated price |
| *"Show my cart"* | Same as above |
| *"List my cart"* | Same as above |

**Expected reply:**
> *"You have 4 items: blue Markus office chair (~$270); Kallax shelf (~$80); LED desk lamp (~$35); toothbrush. Estimated total: ~$385."*

If empty:
> *"Your cart is empty."*

Items without prices contribute nothing to the total; the total is a sum of the ones that have price estimates.

#### How to remove items

Trigger dialog. Say any of:
- *"Remove the lamp"*
- *"Delete the chair"*
- *"Take out the shelf"*
- *"Drop the notebook"*
- *"Cancel the toothbrush"*

The skill fuzzy-matches against `name` columns (substring LIKE). Most recent match wins if there are duplicates.

TTS: *"Removed LED desk lamp from your cart."*

Miss case: *"I don't see 'unicorn' in your cart."*

#### How to clear the whole cart

Say *"clear my cart"* or *"empty my cart"*.

The skill returns a **confirm_action** — you'll hear/see a Yes/No prompt on the glasses before anything is deleted. This is deliberate: clearing is destructive and we don't want a misheard command to nuke your shopping list.

- Confirm → *"Cleared 4 items from your cart."*
- Decline → *"Cart untouched."*

#### How to checkout / email your cart

Say *"email me my cart"* or *"checkout"*.

Two things happen simultaneously:
1. TTS + feed entry summarising the cart contents.
2. An email lands in your Gmail (the account connected to Trace) with subject `Your shopping cart (N items)` and an HTML table: Item / Category / Qty / Estimated price / Store.

After checkout, all active items are marked `status = 'purchased'` — they're out of the active cart but still in the DB. If you say *"what's in my cart?"* immediately after, it'll say *"Your cart is empty."* because purchased items are filtered out of the active list.

**Privacy note.** The skill never sees your email address. The `mail.send` platform tool is invoked with just `{subject, body, html}`; Trace's backend fills in the authenticated user's email and sends it via Gmail.

#### Test script (10-minute happy path)

1. Pre-flight checklist (12.1) passes.
2. Find any object you'd buy in a store (a mug works fine in your kitchen).
3. Trigger dialog, say *"add this to my cart"* → *"Sure, snap a photo..."*
4. Photograph the object. Wait for TTS confirmation.
5. Say *"add a toothbrush"* (text-only add).
6. Say *"what's in my cart?"* → should hear 2 items, one with price, one without.
7. Say *"remove the toothbrush"* → *"Removed toothbrush from your cart."*
8. Say *"clear my cart"* → get a Yes/No prompt. Say yes → *"Cleared 1 item..."*
9. Say *"what's in my cart?"* → *"Your cart is empty."*
10. Add a couple items back. Say *"email me my cart"* → check Gmail for the HTML table.

If steps 1-10 work, Shopping Cart is shipped.

### 12.4 Live debugging while testing

When something doesn't work on the glasses, the answer is almost always in Render's runtime logs. Three access paths:

**A) Render dashboard — Logs tab** (easiest, browser-based)
- Go to [dashboard.render.com/web/srv-d7hl7ogsfn5c73cvt2hg](https://dashboard.render.com/web/srv-d7hl7ogsfn5c73cvt2hg)
- Click **Logs** in the left sidebar
- Filter by time range or severity
- Watch in real-time as you trigger events from the glasses

Every webhook hit logs its channel + user ID + request ID:
```
[object-memory:webhook] media.photo user=proxy-abc123 req=8f3e...
[object-memory:vision] objects=["keys","mug"] scene="on the kitchen counter..."
[object-memory:db] inserted memory id=47 user=proxy-abc123
```

Every MCP dialog logs utterance + intent + match:
```
[object-memory:dialog] user=proxy-abc123 utterance="where are my keys"
[object-memory:dialog] keyword="keys" match=47
[shopping-cart:dialog] intent={"type":"list"}
```

**B) Filter by level in the MCP tool** (good for drill-down):
```ts
mcp__render__list_logs({
  resource: ["srv-d7hl7ogsfn5c73cvt2hg"],
  level: ["error", "warning"],
  limit: 50
})
```
Returns only errors/warnings. 99% of the time this is empty — if something's wrong, it'll surface here.

**C) Curl against the live endpoint** (sanity-check plumbing):
```bash
# Health
curl https://endlessriver-cosmos.onrender.com/health

# Sign a request as if from Trace and call tools/list
SECRET="b377f097829875445f63a7e4b002cf0e4b124d0f9a3124ed8945364fbfdaec41"
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
TS=$(date +%s000)
SIG="sha256=$(echo -n "${TS}.${BODY}" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')"
curl -X POST https://endlessriver-cosmos.onrender.com/object-memory/mcp \
  -H "x-trace-signature: $SIG" -H "x-trace-timestamp: $TS" \
  -H "Content-Type: application/json" -d "$BODY"
```

If `/health` 200s but a signed `/mcp` call returns 401, your HMAC secret on Render doesn't match the one in the Trace dashboard. Re-paste it on Render → auto-redeploy → retry.

#### Common failure modes and what to check

| Symptom | Likely cause | Check |
|---|---|---|
| No TTS response after photo | Gemini rate-limited or API key invalid | Logs: `[vision] failed: ...` — if 429, wait a minute; if "invalid API key", re-set `GEMINI_API_KEY` |
| *"I couldn't save that memory"* | Presigned image URL 403/expired | Logs: `image fetch 403` — rare; Trace URLs usually live ~1 hr. Re-photograph |
| Every dialog → silence | `/mcp` returning 401 | Logs: signature mismatch — HMAC on Render doesn't match Trace dashboard |
| *"I don't know who's asking"* | `user.id` missing from request | Likely a Trace app bug — check that glasses are paired |
| *"Your cart is empty"* when you just added something | Two skills both processed the photo (routing ambiguity) | Check both `[object-memory:webhook]` and `[shopping-cart:webhook]` logs — if both fired on the same request, Trace routed to both. Adjust `domains` in the manifest to disambiguate |
| Cold start (first request takes ~30s) | Render free-tier spin-down | Expected. Pre-warm by hitting `/health` before your test |

If a symptom isn't on this list, grep Render logs for the `request_id` Trace embeds in every webhook — it threads through all our `console.log`s.

### 12.5 Adding new skills to the same host (the template for skill #3+)

Once Object Memory and Shopping Cart are proven, adding a third skill (Meal Tracker, Travel Journal, Gym Log, whatever) follows the exact same 10-step pattern:

1. `mkdir src/skills/<new-slug>/`
2. Write `db.ts`, `routes.ts`, `manifest.json` (copy shopping-cart, change prompts + schema).
3. Mount in `src/index.ts`:
   ```ts
   app.use('/<new-slug>', buildNewSkillRouter({
     hmacSecret: process.env.NEW_SKILL_HMAC_SECRET!,
     skillId: process.env.NEW_SKILL_SKILL_ID!,
   }));
   ```
4. Add env vars to `.env.example`.
5. Write `scripts/smoke-<new-slug>.ts`.
6. Local smoke test → all green.
7. `git commit && git push` → Render auto-deploys.
8. Register in Trace dashboard with `/<new-slug>/webhook` and `/<new-slug>/mcp` URLs.
9. Paste the new HMAC + skill ID into Render env vars → auto-redeploy.
10. Repeat Section 12.1 pre-flight → test with glasses.

The chassis is built. Each new skill is ~60 minutes of focused work. That's the compounding thesis in Section 13 made concrete.

---

## 13. The larger lesson

Two skills built on the same chassis, shared vision/geo/push libraries, one Render instance, one GitHub repo. That's the design point: **Trace Skills compound**. Each new skill is mostly a new prompt, new schema, new intent classifier — the plumbing (HMAC, webhooks, MCP, push, cron) is already written.

The thing that keeps velocity high is discipline about the plumbing boundary. Anything generic (vision calls, geo math, HMAC, push) lives in `src/shared/`. Anything skill-specific (prompts, tables, intent classifiers) lives in `src/skills/<slug>/`. When the next idea lands, you're back to ~30-60 minutes of focused work, not two days.

That's it. Build, test, ship.
