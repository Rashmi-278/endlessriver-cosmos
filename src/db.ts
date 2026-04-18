import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'memories.db');
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    ts         INTEGER NOT NULL,
    objects    TEXT    NOT NULL,
    scene      TEXT,
    location   TEXT,
    image_url  TEXT,
    request_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_memories_user_ts   ON memories(user_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_user_objs ON memories(user_id, objects);

  CREATE TABLE IF NOT EXISTS places (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   TEXT    NOT NULL,
    name      TEXT    NOT NULL,
    lat       REAL    NOT NULL,
    lng       REAL    NOT NULL,
    radius_m  INTEGER NOT NULL DEFAULT 100,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_places_user ON places(user_id);
`);

export type MemoryRow = {
  id: number;
  user_id: string;
  ts: number;
  objects: string;
  scene: string | null;
  location: string | null;
  image_url: string | null;
  request_id: string | null;
};

export type NewMemory = {
  user_id: string;
  ts?: number;
  objects: string[];
  scene?: string;
  location?: string | null;
  image_url?: string;
  request_id?: string;
};

export type PlaceRow = {
  id: number;
  user_id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  created_at: number;
};

// ─── memories ─────────────────────────────────────────────────────────────
const insertMemoryStmt = db.prepare(`
  INSERT INTO memories (user_id, ts, objects, scene, location, image_url, request_id)
  VALUES (@user_id, @ts, @objects, @scene, @location, @image_url, @request_id)
`);

export function insertMemory(m: NewMemory) {
  const result = insertMemoryStmt.run({
    user_id: m.user_id,
    ts: m.ts ?? Date.now(),
    objects: JSON.stringify(m.objects.map((o) => o.toLowerCase())),
    scene: m.scene ?? null,
    location: m.location ?? null,
    image_url: m.image_url ?? null,
    request_id: m.request_id ?? null,
  });
  return result.lastInsertRowid;
}

const findByObjectStmt = db.prepare(`
  SELECT * FROM memories
  WHERE user_id = ? AND objects LIKE ?
  ORDER BY ts DESC
  LIMIT 1
`);
export function findLatestByObject(userId: string, object: string): MemoryRow | undefined {
  const needle = `%"${object.toLowerCase()}"%`;
  return findByObjectStmt.get(userId, needle) as MemoryRow | undefined;
}

const recentStmt = db.prepare(`
  SELECT * FROM memories WHERE user_id = ? ORDER BY ts DESC LIMIT ?
`);
export function recentMemories(userId: string, limit = 10): MemoryRow[] {
  return recentStmt.all(userId, limit) as MemoryRow[];
}

const sinceStmt = db.prepare(`
  SELECT * FROM memories WHERE user_id = ? AND ts >= ? ORDER BY ts ASC
`);
export function memoriesSince(userId: string, sinceTs: number): MemoryRow[] {
  return sinceStmt.all(userId, sinceTs) as MemoryRow[];
}

const activeUsersStmt = db.prepare(`
  SELECT DISTINCT user_id FROM memories WHERE ts >= ?
`);
export function activeUsersSince(sinceTs: number): string[] {
  return (activeUsersStmt.all(sinceTs) as Array<{ user_id: string }>).map((r) => r.user_id);
}

const deleteMemStmt = db.prepare(`DELETE FROM memories WHERE user_id = ?`);
const deletePlacesStmt = db.prepare(`DELETE FROM places WHERE user_id = ?`);
export function deleteUserMemories(userId: string): number {
  const m = deleteMemStmt.run(userId).changes;
  deletePlacesStmt.run(userId);
  return m;
}

// ─── places ───────────────────────────────────────────────────────────────
const upsertPlaceStmt = db.prepare(`
  INSERT INTO places (user_id, name, lat, lng, radius_m, created_at)
  VALUES (@user_id, @name, @lat, @lng, @radius_m, @created_at)
  ON CONFLICT(user_id, name) DO UPDATE SET lat=excluded.lat, lng=excluded.lng, radius_m=excluded.radius_m
`);

export function upsertPlace(p: {
  user_id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m?: number;
}) {
  upsertPlaceStmt.run({
    user_id: p.user_id,
    name: p.name.toLowerCase().trim(),
    lat: p.lat,
    lng: p.lng,
    radius_m: p.radius_m ?? 100,
    created_at: Date.now(),
  });
}

const listPlacesStmt = db.prepare(`SELECT * FROM places WHERE user_id = ?`);
export function listPlaces(userId: string): PlaceRow[] {
  return listPlacesStmt.all(userId) as PlaceRow[];
}

// Haversine (meters)
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function parseLocation(loc: string | null | undefined): { lat: number; lng: number } | null {
  if (!loc) return null;
  const [latStr, lngStr] = loc.split(',');
  const lat = Number(latStr);
  const lng = Number(lngStr);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

export function placeNameForLocation(userId: string, loc: string | null | undefined): string | null {
  const coord = parseLocation(loc);
  if (!coord) return null;
  const places = listPlaces(userId);
  for (const p of places) {
    if (haversineM(coord.lat, coord.lng, p.lat, p.lng) <= p.radius_m) return p.name;
  }
  return null;
}

export default db;
