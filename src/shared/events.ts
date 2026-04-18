// Shared event log — structured observability across all skills.
// Ring buffer: keeps last EVENTS_MAX rows, auto-prunes on insert.
// Every request_id threads through related events so the inspect page
// can correlate webhook -> vision -> db -> push.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.EVENTS_DB_PATH || path.join(process.cwd(), 'data', 'events.db');
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const EVENTS_MAX = Number(process.env.EVENTS_MAX || 1000);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    skill       TEXT    NOT NULL,     -- 'object-memory' | 'shopping-cart' | 'system'
    kind        TEXT    NOT NULL,     -- 'webhook.received', 'vision.completed', etc.
    level       TEXT    NOT NULL DEFAULT 'info',  -- 'info' | 'warn' | 'error'
    user_id     TEXT,                 -- proxied user id, may be null for system events
    request_id  TEXT,                 -- thread events for one request
    summary     TEXT    NOT NULL,     -- one-line human description
    detail      TEXT                  -- JSON blob, parsed on the frontend
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts        ON events(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_skill_ts  ON events(skill, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_events_req       ON events(request_id);
`);

export type EventLevel = 'info' | 'warn' | 'error';
export type EventSkill = 'object-memory' | 'shopping-cart' | 'system';

export type EventInput = {
  skill: EventSkill;
  kind: string;
  level?: EventLevel;
  user_id?: string | null;
  request_id?: string | null;
  summary: string;
  detail?: any;
};

export type EventRow = {
  id: number;
  ts: number;
  skill: string;
  kind: string;
  level: string;
  user_id: string | null;
  request_id: string | null;
  summary: string;
  detail: string | null;
};

const insertStmt = db.prepare(`
  INSERT INTO events (ts, skill, kind, level, user_id, request_id, summary, detail)
  VALUES (@ts, @skill, @kind, @level, @user_id, @request_id, @summary, @detail)
`);

const countStmt = db.prepare(`SELECT COUNT(*) as c FROM events`);
const pruneStmt = db.prepare(`
  DELETE FROM events WHERE id NOT IN (
    SELECT id FROM events ORDER BY id DESC LIMIT ?
  )
`);

export function logEvent(e: EventInput): void {
  try {
    insertStmt.run({
      ts: Date.now(),
      skill: e.skill,
      kind: e.kind,
      level: e.level ?? 'info',
      user_id: e.user_id ?? null,
      request_id: e.request_id ?? null,
      summary: e.summary.slice(0, 300),
      detail: e.detail !== undefined ? JSON.stringify(e.detail) : null,
    });
    // Prune once every ~50 inserts to amortize cost
    if (Math.random() < 0.02) {
      const n = (countStmt.get() as { c: number }).c;
      if (n > EVENTS_MAX) pruneStmt.run(EVENTS_MAX);
    }
  } catch (err: any) {
    // Never let event logging break the request path.
    console.error('[events] log failed:', err?.message || err);
  }
}

const listStmt = db.prepare(`
  SELECT * FROM events
  WHERE (@since IS NULL OR id > @since)
    AND (@skill IS NULL OR skill = @skill)
    AND (@level IS NULL OR level = @level)
    AND (@kind IS NULL OR kind LIKE @kind)
    AND (@user IS NULL OR user_id = @user)
  ORDER BY id DESC
  LIMIT @limit
`);

export type ListFilters = {
  since?: number;
  skill?: string;
  level?: string;
  kind?: string;     // substring match, LIKE %kind%
  user?: string;
  limit?: number;
};

export function listEvents(f: ListFilters = {}): EventRow[] {
  return listStmt.all({
    since: f.since ?? null,
    skill: f.skill ?? null,
    level: f.level ?? null,
    kind: f.kind ? `%${f.kind}%` : null,
    user: f.user ?? null,
    limit: Math.min(f.limit ?? 200, 500),
  }) as EventRow[];
}

export function eventStats() {
  const total = (countStmt.get() as { c: number }).c;
  const bySkill = db.prepare(`SELECT skill, COUNT(*) as c FROM events GROUP BY skill`).all() as Array<{ skill: string; c: number }>;
  const byLevel = db.prepare(`SELECT level, COUNT(*) as c FROM events GROUP BY level`).all() as Array<{ level: string; c: number }>;
  const newest = db.prepare(`SELECT ts FROM events ORDER BY id DESC LIMIT 1`).get() as { ts: number } | undefined;
  return {
    total,
    bySkill: Object.fromEntries(bySkill.map((r) => [r.skill, r.c])),
    byLevel: Object.fromEntries(byLevel.map((r) => [r.level, r.c])),
    newestTs: newest?.ts ?? null,
    max: EVENTS_MAX,
  };
}

export default db;
