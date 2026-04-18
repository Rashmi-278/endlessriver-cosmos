// Brain push helper shared across skills. Each caller passes its own skill id + secret.
import fetch from 'node-fetch';

const BRAIN_BASE_URL = process.env.BRAIN_BASE_URL || 'https://brain.endlessriver.ai';

export async function sendPushResponse(
  skillId: string,
  hmacSecret: string,
  user_id: string,
  responses: any[],
  callback_url?: string,
) {
  const url = callback_url || `${BRAIN_BASE_URL}/api/skill-push/${skillId}`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${hmacSecret}`,
      },
      body: JSON.stringify({ user_id, responses }),
      signal: controller.signal as any,
    });
    if (!res.ok) {
      const text = await res.text();
      console.error(`[push:${skillId}] ${res.status} ${text.slice(0, 200)}`);
    } else {
      console.log(`[push:${skillId}] ok user=${user_id}`);
    }
  } catch (err: any) {
    console.error(`[push:${skillId}] error:`, err?.message || err);
  } finally {
    clearTimeout(t);
  }
}
