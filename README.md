# 🛠️ Trace Template Skill

This is a minimal, production-ready template for building **Trace Skills**. It includes everything you need to handle background events (Webhooks) and voice-native interactions (MCP).

---

## 🚀 Quickstart

### 1. Setup
```bash
mkdir trace_skill
cd trace_skill
git clone git@github.com:EndlessRiverAI/trace-template-skill.git
cd trace-template-skill
npm install
cp .env.example .env
```
Fill in your `TRACE_HMAC_SECRET` in `.env` once you register your skill.

### 2. Local Development
```bash
npm run dev
```
In a separate terminal, expose your local server to the internet using **localhost.run**:
```bash
ssh -R 80:localhost:3000 nokey@localhost.run
```
*Take note of the `https` URL localhost.run provides (e.g., `https://21231e1.localhost.run`).*

---

## 📝 Manifest & Registration

Your skill is defined by the `manifest.json`. You must submit this manifest via the **Trace Developer Dashboard**.

### Key Fields:
- **`name`**: Human-readable name of your skill.
- **`interface`**: `hybrid` allows both Webhooks and MCP.
- **`triggers`**: Defines what events your skill "listens" to. By default, it listens to `interaction.dialog` (voice).
- **`permissions`**: List of permissions your skill needs. Common ones:
    - `notification.send`: (Implicit) Ability to sent toasts/TTS.
    - `user.profile.read`: Ability to see the user's name.
    - `user.location.read`: Ability to see city/country/GPS.
- **`domains`**: Natural language descriptions that tell the Trace Router when to send an event to your skill.
- **`allowedTools`**: Declares which platform-managed tools (like `mail.send`) your skill can use.

### Registration Steps:
1. Go to **Dashboard** → **Skills** → **Create New Skill**.
2. Paste your localhost.run URL into the **Webhook** and **MCP** endpoint fields.
3. Use the contents of `manifest.json` as a guide for your configuration.
    Sample manifest for this skill:
     ```jsx
    {
      "name": "Template Skill",
      "version": "1.0.0",
      "interface": "hybrid",
      "endpoints": {
        "webhook": "https://your-domain.localhost.run/webhook",
        "mcp": "https://your-domain.localhost.run/mcp"
      },
      "triggers": [
        { "channel": "interaction.dialog", "routing_mode": "active" }
      ],
      "domains": {
        "general": "Handle general greetings and tests for the template skill. Match utterances like 'test template' or 'hello from template'."
      },
      "permissions": [
        "notification.send",
        "user.profile.read",
        "user.location.read"
      ],
      "allowedTools": [
        "mail.send"
      ],
      "data_retention": {
        "max_days": 30,
        "deletion_webhook": "https://your-domain.localhost.run/delete-user"
      }
    }
    ```
4. **Save** and copy the **HMAC Secret** into your `.env` file.

---

## 🔌 Using Platform Actions

This template shows you how to return **responses** that trigger actions on the user's glasses:

- **Notifications**: Toast messages and TTS.
- **Feed Items**: Logging activity to the daily feed.
- **Platform Tools**: Sending emails or creating calendar events via `tool_call`.

Check `src/index.ts` to see how these are constructed.

---

## 🔒 Security

- **HMAC Verification**: All requests from Trace are signed. The `src/hmac.ts` utility ensures only legitimate Trace events are processed.
- **Proxy IDs**: `user.id` is a stable, unique proxy for that specific user. Use it as a primary key in your database.
- **User Info**: If you have the right permissions, the `user` object will contain `name`, `timezone`, and `location`. Timezone and Locale are always provided.

---

## 🚢 Deployment

Ready to go live? Check out the `deploy.sh` script for instructions on deploying to **Railway** or **Vercel**.

1. Deploy your server.
2. Get the new production URL.
3. Update your endpoints in the **Trace Developer Dashboard**.

### Persistent storage (important)

This skill keeps memories in SQLite (`data/memories.db` by default). SQLite files are **local disk**, which means:

- On **Vercel / serverless** they are wiped on every cold start. **Do not deploy there as-is** for the memory skill. Switch to a hosted SQLite like [Turso](https://turso.tech/) (free tier) or Postgres.
- On **Railway / Fly.io / Render**, mount a persistent volume and point `DATABASE_PATH` at it.

**Railway volume setup:**
1. Dashboard → your service → **Variables** → add `DATABASE_PATH=/data/memories.db`
2. **Volumes** → *New Volume* → mount path `/data`, 1 GB is plenty
3. Redeploy. The skill auto-creates the directory and file on boot.

**Fly.io volume setup:**
```bash
fly volumes create memdata --size 1 --region bom
# in fly.toml:
# [mounts]
# source = "memdata"
# destination = "/data"
fly secrets set DATABASE_PATH=/data/memories.db
```

**Turso migration (if you outgrow single-instance SQLite):**
Turso is libSQL (SQLite-compatible) with HTTP/WebSocket. Swap `better-sqlite3` for `@libsql/client`, set `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`, and convert `db.ts` to an async interface. Migration is mechanical; no schema change needed.

### Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `TRACE_HMAC_SECRET` | ✅ | — | From Trace dashboard. Verifies webhook + MCP. |
| `TRACE_SKILL_ID` | ✅ | — | From Trace dashboard. Used for Brain push. |
| `GEMINI_API_KEY` | ✅ | — | [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey), free tier. |
| `BRAIN_BASE_URL` | — | `https://brain.endlessriver.ai` | Brain push target. |
| `DATABASE_PATH` | — | `./data/memories.db` | SQLite file location. Point at a volume in prod. |
| `DAILY_RECAP_CRON` | — | `0 21 * * *` | node-cron expression. Set to any valid cron. |
| `DAILY_RECAP_TZ` | — | `Asia/Kolkata` | IANA timezone for the cron. |
| `DAILY_RECAP_ENABLED` | — | `1` | `0` disables the cron entirely. |
| `DISABLE_SEMANTIC` | — | `0` | `1` disables the LLM fallback (faster, dumber). |
| `PORT` | — | `3000` | HTTP listen port. |

### Manual cron test

```bash
curl -X POST http://localhost:3000/admin/run-recap/object-memory \
  -H "x-admin-secret: $OBJECT_MEMORY_HMAC_SECRET"
```
Fires the daily recap immediately for any user with memories since midnight local.

---

## 🧩 Multi-Skill Layout

This server is set up to host many skills under one deploy. Each skill is a
self-contained folder under `src/skills/<slug>/` and is mounted at `/<slug>` by
`src/index.ts`. Register each skill separately in the Trace dashboard with its
own HMAC secret; the server routes them to the right handlers by path.

```
src/
  index.ts                   # mounts skill routers, starts cron
  hmac.ts                    # shared HMAC middleware
  shared/
    vision.ts                # Gemini wrapper (reuse across skills)
    geo.ts                   # haversine, parseLocation, formatTimeAgo
    push.ts                  # skill-push helper with timeout
  skills/
    object-memory/
      manifest.json          # paste into Trace dashboard
      routes.ts              # /webhook + /mcp + /delete-user
      db.ts                  # memories + places tables
```

**URLs registered in the Trace dashboard:**
- Webhook: `https://<your-host>/object-memory/webhook`
- MCP: `https://<your-host>/object-memory/mcp`
- Deletion: `https://<your-host>/object-memory/delete-user`

Adding a new skill: copy `src/skills/object-memory/` to
`src/skills/<new-slug>/`, tweak the logic, add a `buildRouter` export, then in
`src/index.ts`:

```ts
app.use('/shopping-cart', buildShoppingCartRouter({
  hmacSecret: process.env.SHOPPING_CART_HMAC_SECRET!,
  skillId: process.env.SHOPPING_CART_SKILL_ID!,
}));
```
Register the new skill in the Trace dashboard with its own secret and URLs.

---

### Need Help?
Reach out to **ishaan@endlessriver.ai** or check the **[Developer Reference](https://endlessriver.ai/dashboard/docs)** (or `/dashboard/docs` on your Trace domain) for more details.

You can also follow the full **[Skill Builder Playbook](./docs/buildathon/SKILL_BUILDER_PLAYBOOK.md)** for a deep dive.
**Happy Building! 🛠️**
