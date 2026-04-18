import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH =
  process.env.SHOPPING_CART_DB_PATH ||
  path.join(process.cwd(), 'data', 'shopping-cart.db');

const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS cart_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT    NOT NULL,
    ts            INTEGER NOT NULL,
    name          TEXT    NOT NULL,
    category      TEXT,
    price_est_usd REAL,
    store_guess   TEXT,
    qty           INTEGER NOT NULL DEFAULT 1,
    image_url     TEXT,
    notes         TEXT,
    source        TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active',
    request_id    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_cart_user_status_ts
    ON cart_items(user_id, status, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_cart_user_name
    ON cart_items(user_id, name);
`);

export type CartItem = {
  id: number;
  user_id: string;
  ts: number;
  name: string;
  category: string | null;
  price_est_usd: number | null;
  store_guess: string | null;
  qty: number;
  image_url: string | null;
  notes: string | null;
  source: 'photo' | 'dialog_text';
  status: 'active' | 'removed' | 'purchased';
  request_id: string | null;
};

export type NewCartItem = {
  user_id: string;
  ts?: number;
  name: string;
  category?: string | null;
  price_est_usd?: number | null;
  store_guess?: string | null;
  qty?: number;
  image_url?: string | null;
  notes?: string | null;
  source: 'photo' | 'dialog_text';
  request_id?: string | null;
};

const insertStmt = db.prepare(`
  INSERT INTO cart_items
    (user_id, ts, name, category, price_est_usd, store_guess, qty, image_url, notes, source, request_id)
  VALUES
    (@user_id, @ts, @name, @category, @price_est_usd, @store_guess, @qty, @image_url, @notes, @source, @request_id)
`);

export function insertCartItem(item: NewCartItem): number {
  const row = insertStmt.run({
    user_id: item.user_id,
    ts: item.ts ?? Date.now(),
    name: item.name.trim(),
    category: item.category ?? null,
    price_est_usd: item.price_est_usd ?? null,
    store_guess: item.store_guess ?? null,
    qty: item.qty ?? 1,
    image_url: item.image_url ?? null,
    notes: item.notes ?? null,
    source: item.source,
    request_id: item.request_id ?? null,
  });
  return Number(row.lastInsertRowid);
}

const listActiveStmt = db.prepare(`
  SELECT * FROM cart_items
  WHERE user_id = ? AND status = 'active'
  ORDER BY ts DESC
`);
export function listActiveCart(userId: string): CartItem[] {
  return listActiveStmt.all(userId) as CartItem[];
}

const findByNameStmt = db.prepare(`
  SELECT * FROM cart_items
  WHERE user_id = ? AND status = 'active' AND LOWER(name) LIKE ?
  ORDER BY ts DESC
  LIMIT 1
`);
export function findActiveByName(userId: string, needle: string): CartItem | undefined {
  return findByNameStmt.get(userId, `%${needle.toLowerCase()}%`) as CartItem | undefined;
}

const softDeleteStmt = db.prepare(`
  UPDATE cart_items SET status = 'removed' WHERE id = ? AND user_id = ?
`);
export function removeCartItem(userId: string, id: number): boolean {
  return softDeleteStmt.run(id, userId).changes > 0;
}

const clearActiveStmt = db.prepare(`
  UPDATE cart_items SET status = 'removed' WHERE user_id = ? AND status = 'active'
`);
export function clearActiveCart(userId: string): number {
  return clearActiveStmt.run(userId).changes;
}

const markPurchasedStmt = db.prepare(`
  UPDATE cart_items SET status = 'purchased' WHERE user_id = ? AND status = 'active'
`);
export function markCartPurchased(userId: string): number {
  return markPurchasedStmt.run(userId).changes;
}

const deleteUserStmt = db.prepare(`DELETE FROM cart_items WHERE user_id = ?`);
export function deleteUserCart(userId: string): number {
  return deleteUserStmt.run(userId).changes;
}

export default db;
