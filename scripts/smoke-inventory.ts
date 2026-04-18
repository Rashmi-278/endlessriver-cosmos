// Unit-ish test for src/shared/inventory.ts. Runs the in-process matcher
// against realistic Gemini-shaped queries for the 5 demo products.

import { lookupProduct, inventoryStatus, allProducts } from '../src/shared/inventory';

function expect(cond: boolean, label: string) {
  if (!cond) { console.error(`  ✗ FAIL: ${label}`); process.exitCode = 1; }
  else       { console.log(`  ✓ ${label}`); }
}

console.log('=== inventory status ===');
const status = inventoryStatus();
console.log(status);
expect(status.count === 5, 'loaded 5 products');
expect(status.error === null, 'no load error');
expect(status.retailers.includes('ikea-in'), 'retailer slug present');

// Helper: assert that a query matches a specific product id.
function assertMatch(label: string, query: any, expectedId: string) {
  const hit = lookupProduct(query);
  if (!hit) {
    console.error(`  ✗ FAIL: ${label} — no match`);
    process.exitCode = 1;
    return;
  }
  if (hit.product.id !== expectedId) {
    console.error(`  ✗ FAIL: ${label} — expected ${expectedId}, got ${hit.product.id} (score ${hit.score}, ${hit.reason})`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ ${label} → ${hit.product.id} score=${hit.score} (${hit.reason})`);
}

function assertNoMatch(label: string, query: any) {
  const hit = lookupProduct(query);
  if (hit) {
    console.error(`  ✗ FAIL: ${label} — unexpected match ${hit.product.id} score ${hit.score}`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ✓ ${label} → null`);
}

console.log('\n=== IKEA hero products match ===');

// Exact name from Gemini
assertMatch(
  'Gemini says "MARKUS office chair"',
  { item: 'blue MARKUS office chair', brand: 'IKEA' },
  'markus-office-chair-vissle-dark-gray',
);

// Alias only
assertMatch(
  'Gemini says "kallax 4x4 shelf"',
  { item: 'kallax 4x4 shelf', brand: 'IKEA' },
  'kallax-shelf-unit-white-4x4',
);

// SKU-based match (Gemini pulled an 8-digit article number from the yellow tag)
assertMatch(
  'SKU match: "702.611.50" → MARKUS',
  { item: 'some office chair', sku: '702.611.50' },
  'markus-office-chair-vissle-dark-gray',
);

// Generic descriptor → MALM
assertMatch(
  'Gemini says "white queen bed frame"',
  { item: 'white queen bed frame', brand: 'IKEA' },
  'malm-bed-frame-white-queen',
);

// Partial token match → BILLY
assertMatch(
  'Gemini says "tall white bookshelf"',
  { item: 'tall white bookshelf', description: 'narrow bookcase with adjustable shelves' },
  'billy-bookcase-white-80',
);

// POÄNG with typo-ish spelling (missing umlaut)
assertMatch(
  'Gemini says "poang reading chair"',
  { item: 'poang reading chair', brand: 'IKEA' },
  'poang-armchair-birch-knisa-light-beige',
);

console.log('\n=== non-matches (should return null) ===');
assertNoMatch('generic lamp (not in demo inventory)', { item: 'LED desk lamp', brand: 'generic' });
assertNoMatch('random grocery item', { item: 'oat milk carton' });
assertNoMatch('empty query', { item: '' });

console.log('\n=== product count by category ===');
const byCat = new Map<string, number>();
for (const p of allProducts()) byCat.set(p.category || 'other', (byCat.get(p.category || 'other') || 0) + 1);
console.log('  ', Object.fromEntries(byCat));

console.log(`\n${process.exitCode ? 'INVENTORY SMOKE FAILED' : 'INVENTORY SMOKE OK'}`);
