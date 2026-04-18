import { Router, Request, Response } from 'express';
import { verifyTraceSignature } from '../../hmac';
import { visionExtract, textExtract, hasVision } from '../../shared/vision';
import { sendPushResponse } from '../../shared/push';
import { formatTimeAgo, locationString, parseLocation } from '../../shared/geo';
import { logEvent } from '../../shared/events';
import {
  insertMemory,
  findLatestByObject,
  recentMemories,
  memoriesSince,
  activeUsersSince,
  deleteUserData,
  upsertPlace,
  placeNameForLocation,
  type MemoryRow,
} from './db';

// ─── Prompts ──────────────────────────────────────────────────────────────
const EXTRACTION_PROMPT = `You are an object-memory assistant. Look at this image and return strict JSON:
{"objects": ["keyword1", "keyword2"], "scene": "one-sentence description including where the objects are"}

Rules:
- objects: 1-8 everyday nouns a user would later ask about (e.g. "keys", "wallet", "passport", "phone", "laptop", "mug"). Lowercase. No articles.
- scene: describe WHERE the objects are (surface, room, container) in one short sentence. Example: "on the kitchen counter next to a coffee mug".
- Return ONLY the JSON object. No preamble, no markdown fence.`;

const semanticPrompt = (utterance: string, memories: MemoryRow[]) => `You are helping a user recall where they put something.

The user asked: "${utterance}"

Here are their recent memories (most recent first). Each has an id, a timestamp (ms epoch), a list of objects, and a scene description.

${memories
  .map((m, i) => `#${i + 1} id=${m.id} ts=${m.ts} objects=${m.objects} scene="${m.scene ?? ''}"`)
  .join('\n')}

Pick the memory that best matches what the user is asking about. If no memory is a reasonable match, return memory_id: null.

Return strict JSON:
{"memory_id": <number or null>, "reason": "one short phrase naming the canonical object for the TTS reply, e.g. 'black notebook' or 'keys'"}

Return ONLY the JSON. No preamble, no markdown fence.`;

// ─── Keyword utilities ────────────────────────────────────────────────────
const STOPWORDS = new Set([
  'where','are','is','my','the','a','an','did','i','leave','put','see','last',
  'have','was','were','that','this','to','for','and','of','in','on','at',
  'you','your','can','find','look','looking','what','which','please','hey','do',
  'call','tag','name','mark','here','place','as','me','it','there',
]);

export function extractQueryObject(utterance: string): string | null {
  const words = utterance
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
  return words.length ? words[words.length - 1] : null;
}

export function isPlaceCommand(utterance: string): string | null {
  const m = utterance
    .toLowerCase()
    .match(/(?:call|mark|name|tag)\s+(?:this\s+(?:place\s+)?|here\s+as\s+|this\s+)?([a-z][a-z0-9\s]{0,30})$/);
  if (!m) return null;
  const place = m[1].trim().replace(/\s+/g, ' ');
  return place && !STOPWORDS.has(place) ? place : null;
}

// ─── Reply shaping ────────────────────────────────────────────────────────
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
            { type: 'notification', content: { title: `Found your ${object}`, body: text, tts: true } },
            { type: 'feed_item', content: { title: `Recalled ${object}`, story: text } },
          ],
        },
      ],
    },
  };
}

function memoryToReplyText(userId: string, memory: MemoryRow, canonicalObject: string): string {
  const when = formatTimeAgo(memory.ts);
  const where = memory.scene?.trim() || 'somewhere I saw earlier';
  const place = placeNameForLocation(userId, memory.location);
  const placePrefix = place ? `at ${place}, ` : '';
  return `I last saw your ${canonicalObject} ${placePrefix}${where}, ${when}.`;
}

// ─── Daily recap ──────────────────────────────────────────────────────────
export async function runDailyRecap(skillId: string, hmacSecret: string) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const startTs = startOfDay.getTime();

  const users = activeUsersSince(startTs);
  console.log(`[object-memory:recap] firing for ${users.length} users`);

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

    await sendPushResponse(skillId, hmacSecret, userId, [
      { type: 'notification', content: { title: 'Daily recap', body, tts: true, persist: true } },
      { type: 'feed_item', content: { title: 'Daily recap', story: body } },
    ]);
  }
}

// ─── Router ───────────────────────────────────────────────────────────────
export type ObjectMemoryConfig = {
  hmacSecret: string;
  skillId: string;
};

export function buildObjectMemoryRouter(cfg: ObjectMemoryConfig): Router {
  const router = Router();

  // Webhook: media.photo
  router.post('/webhook', verifyTraceSignature(cfg.hmacSecret), async (req: Request, res: Response) => {
    const { event, user, request_id, callback_url } = req.body ?? {};
    console.log(`[object-memory:webhook] ${event?.channel} user=${user?.id} req=${request_id}`);
    logEvent({
      skill: 'object-memory',
      kind: 'webhook.received',
      user_id: user?.id,
      request_id,
      summary: `${event?.channel || 'unknown-channel'} from ${user?.id || 'unknown-user'}`,
      detail: { channel: event?.channel, item_count: event?.items?.length ?? 0 },
    });
    res.status(202).json({ status: 'accepted', request_id });

    if (event?.channel !== 'media.photo') {
      logEvent({
        skill: 'object-memory',
        kind: 'webhook.ignored',
        user_id: user?.id,
        request_id,
        summary: `Ignored channel ${event?.channel}`,
      });
      return;
    }

    const items = Array.isArray(event.items) ? event.items : [];
    const photo = items.find((it: any) => it?.url);
    if (!photo) {
      console.warn('[object-memory:webhook] no photo url');
      logEvent({
        skill: 'object-memory',
        kind: 'webhook.no_photo',
        level: 'warn',
        user_id: user?.id,
        request_id,
        summary: 'media.photo event had no photo url',
      });
      return;
    }

    try {
      const visionStart = Date.now();
      const vision = await visionExtract<{ objects: string[]; scene: string }>(photo.url, EXTRACTION_PROMPT);
      if (!Array.isArray(vision.objects) || vision.objects.length === 0) {
        throw new Error('no objects extracted');
      }
      console.log(`[object-memory:vision] objects=${JSON.stringify(vision.objects)} scene="${vision.scene}"`);
      logEvent({
        skill: 'object-memory',
        kind: 'vision.completed',
        user_id: user?.id,
        request_id,
        summary: `Extracted ${vision.objects.length} objects: ${vision.objects.slice(0, 3).join(', ')}`,
        detail: { objects: vision.objects, scene: vision.scene, duration_ms: Date.now() - visionStart },
      });

      const rowId = insertMemory({
        user_id: user.id,
        objects: vision.objects,
        scene: vision.scene,
        location: locationString(user),
        image_url: photo.url,
        request_id,
      });
      console.log(`[object-memory:db] inserted memory id=${rowId}`);
      logEvent({
        skill: 'object-memory',
        kind: 'db.insert',
        user_id: user?.id,
        request_id,
        summary: `Saved memory id=${rowId}`,
        detail: { row_id: rowId, location: locationString(user) },
      });

      await sendPushResponse(cfg.skillId, cfg.hmacSecret, user.id, [
        {
          type: 'notification',
          content: {
            title: 'Memory saved',
            body: `I'll remember: ${vision.objects.slice(0, 3).join(', ')}.`,
            tts: true,
          },
        },
        { type: 'feed_item', content: { title: 'Object memory captured', story: vision.scene || vision.objects.join(', ') } },
      ], callback_url);
    } catch (err: any) {
      console.error('[object-memory:webhook] processing failed:', err?.message || err);
      logEvent({
        skill: 'object-memory',
        kind: 'webhook.failed',
        level: 'error',
        user_id: user?.id,
        request_id,
        summary: `Processing failed: ${err?.message?.slice(0, 120) || 'unknown error'}`,
        detail: { error: String(err?.message || err) },
      });
      await sendPushResponse(cfg.skillId, cfg.hmacSecret, user.id, [
        {
          type: 'notification',
          content: {
            title: 'Memory skipped',
            body: `I couldn't save that one. (${err?.message?.slice(0, 60) || 'error'})`,
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
                'Answers questions about where the user last saw an object. Supports fuzzy queries via semantic fallback. Also handles "call this place X".',
              inputSchema: {
                type: 'object',
                properties: { utterance: { type: 'string' } },
                required: ['utterance'],
              },
            },
            {
              name: 'mark_place',
              description: 'Name the user\'s current location (e.g. "home", "office").',
              inputSchema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
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

    if (name === 'mark_place') {
      const placeName = String(args?.name ?? '').trim();
      const coord = parseLocation(locationString(user));
      if (!placeName) return res.json(mcpReply(id, 'What should I call this place?'));
      if (!coord) return res.json(mcpReply(id, "I don't have your location right now."));
      upsertPlace({ user_id: userId, name: placeName, lat: coord.lat, lng: coord.lng });
      console.log(`[object-memory:place] user=${userId} "${placeName}"`);
      return res.json(mcpReply(id, `Got it. This is "${placeName}".`, 'Place saved'));
    }

    if (name !== 'handle_dialog') {
      return res.status(404).json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } });
    }

    const utterance: string = String(args?.utterance ?? '').trim();
    console.log(`[object-memory:dialog] user=${userId} utterance="${utterance}"`);
    logEvent({
      skill: 'object-memory',
      kind: 'mcp.dialog',
      user_id: userId,
      summary: `"${utterance.slice(0, 120)}"`,
      detail: { utterance, tool: name },
    });
    if (!utterance) return res.json(mcpReply(id, "I didn't catch that. Try again?"));

    const placeFromSpeech = isPlaceCommand(utterance);
    if (placeFromSpeech) {
      const coord = parseLocation(locationString(user));
      if (!coord) return res.json(mcpReply(id, "I don't have your location right now."));
      upsertPlace({ user_id: userId, name: placeFromSpeech, lat: coord.lat, lng: coord.lng });
      return res.json(mcpReply(id, `Got it. This is "${placeFromSpeech}".`, 'Place saved'));
    }

    // Fast path
    const keyword = extractQueryObject(utterance);
    if (keyword) {
      const hit = findLatestByObject(userId, keyword);
      if (hit) {
        const text = memoryToReplyText(userId, hit, keyword);
        console.log(`[object-memory:dialog] keyword="${keyword}" match=${hit.id}`);
        logEvent({
          skill: 'object-memory',
          kind: 'mcp.match.keyword',
          user_id: userId,
          summary: `"${keyword}" → memory id=${hit.id}`,
          detail: { keyword, memory_id: hit.id, reply: text },
        });
        return res.json(fullDialogReply(id, text, keyword));
      }
    }

    // Semantic fallback
    const recent = recentMemories(userId, 20);
    if (recent.length === 0) {
      return res.json(mcpReply(id, "I haven't seen anything yet. Snap a photo first."));
    }
    if (hasVision() && process.env.DISABLE_SEMANTIC !== '1') {
      const sem = await textExtract<{ memory_id: number | null; reason: string }>(semanticPrompt(utterance, recent));
      if (sem?.memory_id) {
        const hit = recent.find((m) => m.id === sem.memory_id);
        if (hit) {
          const label = sem.reason || keyword || 'that';
          const text = memoryToReplyText(userId, hit, label);
          console.log(`[object-memory:dialog] semantic hit=${hit.id}`);
          logEvent({
            skill: 'object-memory',
            kind: 'mcp.match.semantic',
            user_id: userId,
            summary: `"${utterance.slice(0, 60)}" → memory id=${hit.id} (${label})`,
            detail: { utterance, memory_id: hit.id, label, reply: text },
          });
          return res.json(fullDialogReply(id, text, label));
        }
      }
    }

    logEvent({
      skill: 'object-memory',
      kind: 'mcp.miss',
      user_id: userId,
      summary: keyword ? `No match for "${keyword}"` : 'No match (no keyword)',
      detail: { utterance, keyword, recent_count: recent.length },
    });
    return res.json(
      mcpReply(id, keyword ? `I haven't seen your ${keyword} yet.` : "I couldn't find a match."),
    );
  });

  // Lifecycle
  router.post('/delete-user', (req: Request, res: Response) => {
    const userId: string | undefined = req.body?.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });
    const removed = deleteUserData(userId);
    console.log(`[object-memory:delete] user=${userId} rows=${removed}`);
    res.json({ ok: true, removed });
  });

  return router;
}
