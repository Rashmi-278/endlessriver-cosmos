# Retailer Inventory

Structured product catalogs the Shopping Cart skill uses to enrich photo-based captures. When a user snaps a product, Gemini Flash extracts a rough guess (name, price estimate, etc.); the skill then fuzzy-matches that guess against any loaded inventory and, on a hit, overrides the guess with **canonical** values — real price, exact name, SKU, aisle/bin, image, product URL.

No inventory? No problem. Gemini's output is stored as-is. Inventory is an **enrichment layer**, not a dependency.

---

## How it loads

On server boot, the skill reads `INVENTORY_PATH` (env var). Default: `./inventory/ikea-in.json` (the demo file). Point it at your own JSON to replace the demo:

```bash
# Single retailer
INVENTORY_PATH=/data/inventories/my-store.json

# Multiple retailers — use a directory; all *.json files are merged
INVENTORY_PATH=/data/inventories/
```

Updates require a server restart (simple; add file-watch if you need live reload).

---

## Schema

A file looks like this:

```json
{
  "retailer": "IKEA India",
  "retailer_slug": "ikea-in",
  "updated_at": "2026-04-18T00:00:00Z",
  "currency_default": "INR",
  "products": [ { ...product... }, ... ]
}
```

**File-level fields:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `retailer` | string | ✅ | Human name for the chain. Shown in TTS ("from IKEA") |
| `retailer_slug` | string | ✅ | Stable short id, used internally. Lowercase, hyphenated. |
| `updated_at` | ISO datetime | ✅ | When this catalog was refreshed. |
| `currency_default` | ISO-4217 code | ✅ | Fallback currency if a product doesn't specify one. |
| `products` | array | ✅ | See product schema below. |

**Product schema:**

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | ✅ | Unique within the file. Stable across refreshes if possible. |
| `name` | string | ✅ | Canonical display name. For IKEA this is the article name (e.g. `MARKUS office chair`). |
| `aliases` | string[] | ⭕ | Alternate names, abbreviations, or search keywords. Used for fuzzy match. |
| `brand` | string | ⭕ | Usually same as the retailer but can differ (e.g. a reseller selling Dyson). |
| `sku` | string | ⭕ | Retailer's SKU or article number. |
| `category` | string | ⭕ | `furniture`, `electronics`, `grocery`, `home`, `clothing`, `lighting`, `storage`, etc. |
| `subcategory` | string | ⭕ | More specific bucket ("office chairs", "armchairs"). |
| `room` | string | ⭕ | `bedroom`, `living_room`, `kitchen`, `dining`, `bathroom`, `office`, `outdoor`, `kids`, `hallway`. |
| `color` | string | ⭕ | Free text. |
| `material` | string | ⭕ | Free text. |
| `price` | number | ⭕ | Price in the currency below. Required if you want price display. |
| `currency` | ISO-4217 | ⭕ | `INR`, `USD`, `EUR`, etc. Falls back to `currency_default`. |
| `price_usd_est` | number | ⭕ | Best-effort USD for cross-store totals. |
| `aisle` | string | ⭕ | IKEA marketplace self-pickup aisle. |
| `bin` | string | ⭕ | IKEA marketplace self-pickup bin. |
| `pickup_type` | enum | ⭕ | `marketplace` / `showroom` / `unknown`. |
| `image_url` | URL | ⭕ | Canonical product image. |
| `product_url` | URL | ⭕ | Retailer's product page. |
| `description` | string | ⭕ | Long description. Used as extra fuzzy-match signal. |
| `dimensions_cm` | object | ⭕ | `{ w, d, h }` in centimetres. Useful for furniture pickup fit. |

All ⭕ fields are genuinely optional — the match just uses whatever you provide.

---

## How matching works

When a photo is captured, the skill:

1. Sends the image + IKEA-aware prompt to Gemini Flash.
2. Gets back `{ item, brand, sku, price, aisle, bin, ... }` — Gemini's best guess.
3. Builds a search query from `item` + `brand` + `sku`.
4. Scans every loaded product, scoring each against the query:
   - **+100** exact match on `name` (case-insensitive)
   - **+50** SKU match
   - **+40** any `alias` appears in the query
   - **+20** query contains the product's `name`
   - **+5** query contains a meaningful noun from the `description`
5. Picks the highest-scoring product above a threshold (score ≥ 40).
6. Overrides Gemini's fields with the canonical values. Keeps Gemini's `notes` because it often has color/condition details.
7. Falls back to Gemini's raw output if no product scores high enough.

This means even if Gemini hallucinates the price or SKU, the user ends up with correct canonical data as long as the item is in the inventory.

---

## Uploading your own inventory (retailer flow)

Future API (not yet built — see TODOs):

```
POST /shopping-cart/admin/inventory
Headers:
  x-admin-secret: <retailer admin token>
Body:
  { retailer, retailer_slug, products: [...] }
```

For the demo today: just replace `inventory/ikea-in.json` in the repo or mount a volume at `INVENTORY_PATH` on Render.

---

## Current demo data

`ikea-in.json` — 5 iconic IKEA India products:

| ID | Name | Price | Room |
|---|---|---|---|
| `markus-office-chair-vissle-dark-gray` | MARKUS office chair | ₹24,990 | office |
| `kallax-shelf-unit-white-4x4` | KALLAX shelf unit | ₹14,990 | living_room |
| `malm-bed-frame-white-queen` | MALM bed frame | ₹26,990 | bedroom |
| `billy-bookcase-white-80` | BILLY bookcase | ₹7,990 | living_room |
| `poang-armchair-birch-knisa-light-beige` | POÄNG armchair | ₹8,500 | living_room |

These 5 are the classic IKEA hero products — what a demo walkthrough would touch. Real retailers would upload the full catalog.
