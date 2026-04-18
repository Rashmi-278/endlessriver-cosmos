import { GoogleGenerativeAI } from '@google/generative-ai';
import fetch from 'node-fetch';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

export function hasVision(): boolean {
  return Boolean(genAI);
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

async function fetchImageBase64(imageUrl: string, timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(imageUrl, { signal: controller.signal as any });
    if (!res.ok) throw new Error(`image fetch ${res.status}`);
    const ct = res.headers.get('content-type');
    const mimeType = ct && ct.startsWith('image/') ? ct.split(';')[0] : 'image/jpeg';
    const buf = await res.buffer();
    return { base64: buf.toString('base64'), mimeType };
  } finally {
    clearTimeout(t);
  }
}

// Generic: extract structured JSON from an image given a prompt describing the target schema.
export async function visionExtract<T = any>(
  imageUrl: string,
  prompt: string,
  timeoutMs = 12_000,
): Promise<T> {
  if (!genAI) throw new Error('GEMINI_API_KEY not set');
  const { base64, mimeType } = await fetchImageBase64(imageUrl, timeoutMs);
  const model = genAI.getGenerativeModel({ model: MODEL });
  const result = await model.generateContent([
    { inlineData: { data: base64, mimeType } },
    { text: prompt },
  ]);
  const text = result.response.text().trim();
  return parseJsonLoose(text, 'visionExtract') as T;
}

// Text-only JSON call (used for semantic-match style flows).
export async function textExtract<T = any>(prompt: string, timeoutMs = 8_000): Promise<T | null> {
  if (!genAI) return null;
  const model = genAI.getGenerativeModel({ model: MODEL });
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    return parseJsonLoose(text, 'textExtract') as T;
  } catch (err: any) {
    console.warn('[textExtract] failed:', err?.message || err);
    return null;
  } finally {
    clearTimeout(t);
  }
}
