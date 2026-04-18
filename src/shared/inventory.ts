// Retailer inventory: retailer-uploaded JSON catalogs used to enrich
// photo-extracted product guesses with canonical data.
//
// Loads from INVENTORY_PATH (file or directory). Multiple JSON files in a
// directory are merged. No inventory = fuzzy-match calls return null and
// the caller uses the unenriched vision output.

import fs from 'fs';
import path from 'path';

export type InventoryProduct = {
  id: string;
  name: string;
  aliases?: string[];
  brand?: string;
  sku?: string;
  category?: string;
  subcategory?: string;
  room?: string;
  color?: string;
  material?: string;
  price?: number;
  currency?: string;
  price_usd_est?: number;
  aisle?: string;
  bin?: string;
  pickup_type?: 'marketplace' | 'showroom' | 'unknown';
  image_url?: string;
  product_url?: string;
  description?: string;
  dimensions_cm?: { w?: number; d?: number; h?: number };
  // Injected at load time; not stored on disk:
  _retailer?: string;
  _retailer_slug?: string;
};

export type InventoryFile = {
  retailer: string;
  retailer_slug: string;
  updated_at?: string;
  currency_default?: string;
  products: InventoryProduct[];
};

const INVENTORY_PATH = process.env.INVENTORY_PATH || path.join(process.cwd(), 'inventory', 'ikea-in.json');

let PRODUCTS: InventoryProduct[] = [];
let LOAD_ERROR: string | null = null;

function loadFile(filePath: string): InventoryProduct[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw) as InventoryFile;
  if (!Array.isArray(parsed?.products)) {
    throw new Error(`inventory: no 'products' array in ${filePath}`);
  }
  return parsed.products.map((p) => ({
    ...p,
    currency: p.currency || parsed.currency_default,
    _retailer: parsed.retailer,
    _retailer_slug: parsed.retailer_slug,
  }));
}

export function loadInventory(): { count: number; error: string | null } {
  try {
    const stat = fs.statSync(INVENTORY_PATH);
    if (stat.isDirectory()) {
      const files = fs
        .readdirSync(INVENTORY_PATH)
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(INVENTORY_PATH, f));
      PRODUCTS = files.flatMap(loadFile);
    } else {
      PRODUCTS = loadFile(INVENTORY_PATH);
    }
    LOAD_ERROR = null;
    console.log(`[inventory] loaded ${PRODUCTS.length} products from ${INVENTORY_PATH}`);
    return { count: PRODUCTS.length, error: null };
  } catch (err: any) {
    LOAD_ERROR = err?.message || String(err);
    PRODUCTS = [];
    console.warn(`[inventory] load failed: ${LOAD_ERROR}. Proceeding without enrichment.`);
    return { count: 0, error: LOAD_ERROR };
  }
}

// Auto-load on import.
loadInventory();

// ─── Fuzzy match ─────────────────────────────────────────────────────────
export type LookupQuery = {
  item?: string | null;
  brand?: string | null;
  sku?: string | null;
  description?: string | null;
};

export type LookupHit = {
  product: InventoryProduct;
  score: number;
  reason: string;
};

const GENERIC_WORDS = new Set([
  'the','a','an','and','or','of','with','for','to','in','on','at',
  'this','that','these','those',
  'my','your','our',
  'new','old','ikea','store','shop','product','item',
]);

function tokenize(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^a-z0-9äöüåéè\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w && w.length > 2 && !GENERIC_WORDS.has(w));
}

export function lookupProduct(q: LookupQuery): LookupHit | null {
  if (PRODUCTS.length === 0) return null;

  const queryText = [q.item, q.brand, q.description].filter(Boolean).join(' ').toLowerCase();
  const queryTokens = new Set(tokenize(queryText));
  const querySku = (q.sku || '').replace(/[^0-9]/g, '');

  let best: LookupHit | null = null;

  for (const p of PRODUCTS) {
    let score = 0;
    const reasons: string[] = [];

    // SKU exact digits match (e.g., IKEA's 702.611.50 → 70261150).
    if (querySku && p.sku) {
      const pSkuDigits = p.sku.replace(/[^0-9]/g, '');
      if (pSkuDigits && querySku.includes(pSkuDigits)) {
        score += 50;
        reasons.push('sku');
      }
    }

    // Exact name match.
    if (p.name && queryText.includes(p.name.toLowerCase())) {
      score += 100;
      reasons.push('name-exact');
    } else {
      // Token overlap with name.
      const nameTokens = tokenize(p.name);
      const hits = nameTokens.filter((t) => queryTokens.has(t));
      if (hits.length > 0) {
        score += 20 * hits.length;
        reasons.push(`name-tokens:${hits.join('|')}`);
      }
    }

    // Alias match.
    if (p.aliases) {
      for (const alias of p.aliases) {
        if (queryText.includes(alias.toLowerCase())) {
          score += 40;
          reasons.push(`alias:${alias}`);
          break;
        }
      }
    }

    // Description tokens (weak signal).
    if (p.description) {
      const descTokens = tokenize(p.description).slice(0, 20);
      const hits = descTokens.filter((t) => queryTokens.has(t));
      if (hits.length > 0) {
        score += Math.min(15, 3 * hits.length);
        reasons.push(`desc:${hits.length}`);
      }
    }

    // Brand signal (small bonus when brand matches).
    if (p.brand && q.brand && p.brand.toLowerCase() === q.brand.toLowerCase()) {
      score += 5;
      reasons.push('brand');
    }

    if (score > (best?.score ?? 0)) {
      best = { product: p, score, reason: reasons.join('+') };
    }
  }

  if (!best || best.score < 40) return null;
  return best;
}

export function inventoryStatus() {
  return {
    path: INVENTORY_PATH,
    count: PRODUCTS.length,
    error: LOAD_ERROR,
    retailers: Array.from(new Set(PRODUCTS.map((p) => p._retailer_slug).filter(Boolean))),
  };
}

export function allProducts(): InventoryProduct[] {
  return PRODUCTS.slice();
}
