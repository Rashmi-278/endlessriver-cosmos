import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import cron from 'node-cron';
import { verifyTraceSignature } from './hmac';
import {
  insertMemory,
  findLatestByObject,
  deleteUserMemories,
  recentMemories,
  memoriesSince,
  activeUsersSince,
  upsertPlace,
  listPlaces,
  placeNameForLocation,
  parseLocation,
  type MemoryRow,
} from './db';
import {
  extractObjects,
  extractQueryObject,
  isPlaceCommand,
  semanticMatch,
} from './vision';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TRACE_HMAC_SECRET = process.env.TRACE_HMAC_SECRET || '';
const TRACE_SKILL_ID = process.env.TRACE_SKILL_ID || '';
const BRAIN_BASE_URL = process.env.BRAIN_BASE_URL || 'https://brain.endlessriver.ai';
const DAILY_RECAP_CRON = process.env.DAILY_RECAP_CRON || '0 21 * * *'; // 9pm local
const DAILY_RECAP_TZ = process.env.DAILY_RECAP_TZ || 'Asia/Kolkata';
const DAILY_RECAP_ENABLED = process.env.DAILY_RECAP_ENABLED !== '0';

app.use(bodyParser.json({ limit: '2mb' }));

// ─── helpers ──────────────────────────────────────────────────────────────
function formatTimeAgo(ts: number): string {
  const mins = Math.max(1, Math.round((Date.now() - ts) / 60_000));
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function locationString(user: any): string | null {
  const loc = user?.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
  return `${loc.lat},${loc.lng}`;
}

function memoryToReplyText(userId: string, memory: MemoryRow, canonicalObject: string): string {
  const when = formatTimeAgo(memory.ts);
  const where = memory.scene?.trim() || 'somewhere I saw earlier';
  const place = placeNameForLocation(userId, memory.location);
  const placePrefix = place ? `at ${place}, ` : '';
  return `I last saw your ${canonicalObject} ${placePrefix}${where}, ${when}.`;
}

function mcpReply(id: any, text: string, title = 'Object Memory') {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        { type: 'text', text },
        {
          type: 'embedded_responses',
          responses: [{ type: 'notification', content: { title, body: text, tts: true } }],
        },
      ],
    },
  };
}

// ─── 🟢 Webhook: media.photo ──────────────────────────────────────────────
app.post('/webhook', verifyTraceSignature(TRACE_HMAC_SECRET), async (req: Request, res: Response) => {
  const { event, user, request_id, callback_url } = req.body ?? {};
  console.log(`[webhook] ${event?.channel} user=${user?.id} req=${request_id}`);

  res.status(202).json({ status: 'accepted', request_id });

  if (event?.channel !== 'media.photo') {
    console.log(`[webhook] ignoring channel ${event?.channel}`);
    return;
  }

  const items = Array.isArray(event.items) ? event.items : [];
  const photo = items.find((it: any) => it?.url);
  if (!photo) {
    console.warn(`[webhook] no photo url in items`);
    return;
  }

  try {
    const vision = await extractObjects(photo.url);
    console.log(`[vision] objects=${JSON.stringify(vision.objects)} scene="${vision.scene}"`);

    const rowId = insertMemory({
      user_id: user.id,
      objects: vision.objects,
      scene: vision.scene,
      location: locationString(user),
      image_url: photo.url,
      request_id,
    });
    console.log(`[db] inserted memory id=${rowId} user=${user.id}`);

    await sendPushResponse(user.id, [
      {
        type: 'notification',
        content: {
          title: 'Memory saved',
          body: `I'll remember: ${vision.objects.slice(0, 3).join(', ')}.`,
          tts: true,
        },
      },
      {
        type: 'feed_item',
        content: {
          title: 'Object memory captured',
          story: vision.scene || vision.objects.join(', '),
        },
      },
    ], callback_url);
  } catch (err: any) {
    console.error(`[webhook] processing failed:`, err?.message || err);
    await sendPushResponse(user.id, [
      {
        type: 'notification',
        content: {
          title: 'Memory skipped',
          body: `I couldn't save that one. (${err?.message?.slice(0, 60) || 'error'})`,
          tts: false,
        },
      },
    ], callback_url);
  }
});

// ─── 🔵 MCP (JSON-RPC) ────────────────────────────────────────────────────
app.post('/mcp', verifyTraceSignature(TRACE_HMAC_SECRET), async (req: Request, res: Response) => {
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
              'Answers questions about where the user last saw an object. Supports fuzzy queries ("that black thing earlier") via semantic fallback. Also handles "call this place X" to name the current location.',
            inputSchema: {
              type: 'object',
              properties: {
                utterance: { type: 'string', description: 'Raw voice utterance from the user.' },
              },
              required: ['utterance'],
            },
          },
          {
            name: 'mark_place',
            description: 'Explicitly name the user\'s current location (e.g. "home", "office") so future recalls can filter by place.',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Short place name, e.g. "home".' },
              },
              required: ['name'],
            },
          },
        ],
      },
    });
  }

  if (method !== 'tools/call') {
    return res.status(404).json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' },
    });
  }

  const { name, arguments: args } = params ?? {};
  const user = req.body?.user ?? req.body?.context?.user;
  const userId: string | undefined = user?.id;
  if (!userId) return res.json(mcpReply(id, "I don't know who's asking."));

  // ── mark_place tool ─────────────────────────────────────────────────────
  if (name === 'mark_place') {
    const placeName = String(args?.name ?? '').trim();
    const coord = parseLocation(locationString(user));
    if (!placeName) return res.json(mcpReply(id, 'What should I call this place?'));
    if (!coord) {
      return res.json(mcpReply(id, "I don't have your location right now. Grant location permission and try again."));
    }
    upsertPlace({ user_id: userId, name: placeName, lat: coord.lat, lng: coord.lng });
    console.log(`[place] user=${userId} named "${placeName}" at ${coord.lat},${coord.lng}`);
    return res.json(mcpReply(id, `Got it. This is "${placeName}".`, 'Place saved'));
  }

  // ── handle_dialog tool ──────────────────────────────────────────────────
  if (name === 'handle_dialog') {
    const utterance: string = String(args?.utterance ?? '').trim();
    console.log(`[dialog] user=${userId} utterance="${utterance}"`);

    if (!utterance) return res.json(mcpReply(id, "I didn't catch that. Try again?"));

    // Natural-language shortcut: "call this place home" routes into mark_place.
    const placeFromSpeech = isPlaceCommand(utterance);
    if (placeFromSpeech) {
      const coord = parseLocation(locationString(user));
      if (!coord) {
        return res.json(mcpReply(id, "I don't have your location right now."));
      }
      upsertPlace({ user_id: userId, name: placeFromSpeech, lat: coord.lat, lng: coord.lng });
      console.log(`[place via dialog] user=${userId} "${placeFromSpeech}"`);
      return res.json(mcpReply(id, `Got it. This is "${placeFromSpeech}".`, 'Place saved'));
    }

    // 1) Fast path: keyword extraction + SQL LIKE lookup.
    const keyword = extractQueryObject(utterance);
    if (keyword) {
      const hit = findLatestByObject(userId, keyword);
      if (hit) {
        const text = memoryToReplyText(userId, hit, keyword);
        console.log(`[dialog] keyword="${keyword}" match=${hit.id}`);
        return res.json(fullDialogReply(id, text, keyword));
      }
    }

    // 2) Semantic fallback: ask the LLM to pick from recent memories.
    const recent = recentMemories(userId, 20);
    if (recent.length === 0) {
      return res.json(mcpReply(id, "I haven't seen anything yet. Snap a photo first."));
    }
    const sem = await semanticMatch(utterance, recent);
    if (sem?.memory_id) {
      const hit = recent.find((m) => m.id === sem.memory_id);
      if (hit) {
        const label = sem.reason || keyword || 'that';
        const text = memoryToReplyText(userId, hit, label);
        console.log(`[dialog] semantic hit=${hit.id} label="${label}"`);
        return res.json(fullDialogReply(id, text, label));
      }
    }

    console.log(`[dialog] no match (keyword="${keyword}" recent=${recent.length})`);
    return res.json(
      mcpReply(id, keyword ? `I haven't seen your ${keyword} yet.` : "I couldn't find a match."),
    );
  }

  return res.status(404).json({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unknown tool: ${name}` },
  });
});

function fullDialogReply(id: any, text: string, object: string) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        { type: 'text', text },
        {
          type: 'embedded_responses',
          responses: [
            {
              type: 'notification',
              content: { title: `Found your ${object}`, body: text, tts: true },
            },
            {
              type: 'feed_item',
              content: { title: `Recalled ${object}`, story: text },
            },
          ],
        },
      ],
    },
  };
}

// ─── 🟣 Brain Push ────────────────────────────────────────────────────────
async function sendPushResponse(user_id: string, responses: any[], callback_url?: string) {
  const url = callback_url || `${BRAIN_BASE_URL}/api/skill-push/${TRACE_SKILL_ID}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TRACE_HMAC_SECRET}`,
      },
      body: JSON.stringify({ user_id, responses }),
      signal: controller.signal as any,
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[push] ${res.status} ${text.slice(0, 200)}`);
    } else {
      console.log(`[push] ok user=${user_id}`);
    }
  } catch (err: any) {
    console.error(`[push] error:`, err?.message || err);
  } finally {
    clearTimeout(t);
  }
}

// ─── 🟡 Daily recap cron ──────────────────────────────────────────────────
async function runDailyRecap() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startTs = startOfDay.getTime();

  const users = activeUsersSince(startTs);
  console.log(`[recap] firing for ${users.length} users`);

  for (const userId of users) {
    const todays = memoriesSince(userId, startTs);
    if (todays.length === 0) continue;

    const lines = todays.slice(0, 5).map((m) => {
      let objs: string[] = [];
      try { objs = JSON.parse(m.objects); } catch {}
      const primary = objs[0] || 'something';
      const place = placeNameForLocation(userId, m.location);
      const where = place ? `at ${place}` : m.scene?.split(',')[0] || 'around';
      return `${primary} ${where}`;
    });
    const extra = todays.length > lines.length ? ` and ${todays.length - lines.length} more` : '';
    const body = `Today I logged: ${lines.join('; ')}${extra}.`;

    await sendPushResponse(userId, [
      {
        type: 'notification',
        content: { title: 'Daily recap', body, tts: true, persist: true },
      },
      {
        type: 'feed_item',
        content: { title: 'Daily recap', story: body },
      },
    ]);
  }
}

// Exposed for manual testing. Fire-and-forget so callers don't block on push fanout.
app.post('/admin/run-recap', (req: Request, res: Response) => {
  if (req.headers['x-admin-secret'] !== TRACE_HMAC_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  runDailyRecap().catch((e) => console.error('[recap] failed:', e));
  res.json({ ok: true, queued: true });
});

if (DAILY_RECAP_ENABLED) {
  if (!cron.validate(DAILY_RECAP_CRON)) {
    console.warn(`[recap] invalid cron expression "${DAILY_RECAP_CRON}" — recap disabled`);
  } else {
    cron.schedule(
      DAILY_RECAP_CRON,
      () => {
        runDailyRecap().catch((e) => console.error('[recap] failed:', e));
      },
      { timezone: DAILY_RECAP_TZ },
    );
    console.log(`[recap] scheduled "${DAILY_RECAP_CRON}" tz=${DAILY_RECAP_TZ}`);
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────
app.post('/delete-user', (req: Request, res: Response) => {
  const userId: string | undefined = req.body?.user_id;
  if (!userId) return res.status(400).json({ error: 'user_id required' });
  const removed = deleteUserMemories(userId);
  console.log(`[delete] user=${userId} memory rows=${removed}`);
  res.json({ ok: true, removed });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, places_supported: true, semantic: process.env.DISABLE_SEMANTIC !== '1' });
});

app.listen(PORT, () => {
  console.log(`🚀 Object Memory skill running at http://localhost:${PORT}`);
});
