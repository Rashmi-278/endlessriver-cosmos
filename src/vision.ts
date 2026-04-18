import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';
import type { MemoryRow } from './db';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = 'gemini-1.5-flash';
const SEMANTIC_DISABLED = process.env.DISABLE_SEMANTIC === '1';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

export type VisionResult = {
  objects: string[];
  scene: string;
};

const EXTRACTION_PROMPT = `You are an object-memory assistant. Look at this image and return strict JSON:
{"objects": ["keyword1", "keyword2"], "scene": "one-sentence description including where the objects are"}

Rules:
- objects: 1-8 everyday nouns a user would later ask about (e.g. "keys", "wallet", "passport", "phone", "laptop", "mug"). Lowercase. No articles.
- scene: describe WHERE the objects are (surface, room, container) in one short sentence. Example: "on the kitchen counter next to a coffee mug".
- Return ONLY the JSON object. No preamble, no markdown fence.`;

export async function extractObjects(imageUrl: string, timeoutMs = 12_000): Promise<VisionResult> {
  if (!genAI) throw new Error('GEMINI_API_KEY not set');

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  let mimeType = 'image/jpeg';
  let base64: string;
  try {
    const res = await fetch(imageUrl, { signal: controller.signal as any });
    if (!res.ok) throw new Error(`image fetch ${res.status}`);
    const ct = res.headers.get('content-type');
    if (ct && ct.startsWith('image/')) mimeType = ct.split(';')[0];
    const buf = await res.buffer();
    base64 = buf.toString('base64');
  } finally {
    clearTimeout(t);
  }

  const model = genAI.getGenerativeModel({ model: MODEL });
  const result = await model.generateContent([
    { inlineData: { data: base64, mimeType } },
    { text: EXTRACTION_PROMPT },
  ]);
  const text = result.response.text().trim();
  return parseJsonLoose(text, 'extraction') as VisionResult;
}

// ─── Semantic fallback ────────────────────────────────────────────────────
// When the keyword-extractor misses (fuzzy query like "that black thing earlier"),
// show recent memories to the LLM and let it pick the best match.

export type SemanticMatch = {
  memory_id: number | null;
  reason: string;
};

const SEMANTIC_PROMPT = (utterance: string, memories: MemoryRow[]) => `You are helping a user recall where they put something.

The user asked: "${utterance}"

Here are their recent memories (most recent first). Each has an id, a timestamp (ms epoch), a list of objects, and a scene description.

${memories
  .map(
    (m, i) =>
      `#${i + 1} id=${m.id} ts=${m.ts} objects=${m.objects} scene="${m.scene ?? ''}"`,
  )
  .join('\n')}

Pick the memory that best matches what the user is asking about. If no memory is a reasonable match, return memory_id: null.

Return strict JSON:
{"memory_id": <number or null>, "reason": "one short phrase naming the canonical object for the TTS reply, e.g. 'black notebook' or 'keys'"}

Return ONLY the JSON. No preamble, no markdown fence.`;

export async function semanticMatch(
  utterance: string,
  memories: MemoryRow[],
  timeoutMs = 8_000,
): Promise<SemanticMatch | null> {
  if (SEMANTIC_DISABLED || !genAI || memories.length === 0) return null;

  const model = genAI.getGenerativeModel({ model: MODEL });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await model.generateContent(SEMANTIC_PROMPT(utterance, memories));
    const text = result.response.text().trim();
    const parsed = parseJsonLoose(text, 'semantic');
    const id = typeof parsed.memory_id === 'number' ? parsed.memory_id : null;
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    return { memory_id: id, reason };
  } catch (err: any) {
    console.warn('[semantic] failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(t);
  }
}

function parseJsonLoose(text: string, label: string): any {
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`${label}: non-JSON response: ${cleaned.slice(0, 120)}`);
    return JSON.parse(match[0]);
  }
}

// ─── Keyword extractor (fast path) ────────────────────────────────────────
const STOPWORDS = new Set([
  'where','are','is','my','the','a','an','did','i','leave','put','see','last',
  'have','was','were','that','this','to','for','and','of','in','on','at',
  'you','your','can','find','look','looking','what','which','please','hey','do',
  'call','tag','name','mark','here','place','as','me','it','there'
]);

export function extractQueryObject(utterance: string): string | null {
  const words = utterance
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
  if (words.length === 0) return null;
  return words[words.length - 1];
}

export function isPlaceCommand(utterance: string): string | null {
  // "call this place home", "mark here as office", "name this office"
  const m = utterance
    .toLowerCase()
    .match(/(?:call|mark|name|tag)\s+(?:this\s+(?:place\s+)?|here\s+as\s+|this\s+)?([a-z][a-z0-9\s]{0,30})$/);
  if (!m) return null;
  const place = m[1].trim().replace(/\s+/g, ' ');
  if (!place || STOPWORDS.has(place)) return null;
  return place;
}
