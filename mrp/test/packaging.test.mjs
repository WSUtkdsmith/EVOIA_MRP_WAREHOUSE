// Phase 3 — warehouse cataloging. Locks the contract added so MRP items can be
// physically cataloged and slotted: packaging variants (distinct SKUs), shelf
// life, and the new lot-level fields (packaging, dates, origin/mfg/ref). Asserts
// intent, not markup, in the house style.
import { SCHEMA, ENTITIES, seedData, allTables, exportCsvBundle, importCsvBundle } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

const CATALOG = ['rawMaterials', 'intermediateProducts', 'finishedGoods', 'wasteStreams'];
const D = seedData();

console.log('\n--- schema: cataloging columns on the four entities ---');
CATALOG.forEach(e => {
  ok(e + ' declares shelfLifeDays', 'shelfLifeDays' in SCHEMA[e].columns);
  ok(e + ' declares physicallyStored', 'physicallyStored' in SCHEMA[e].columns);
  ok(e + ' has a packagings child', !!SCHEMA[e].children.packagings);
});
ok('rawMaterials now declares hazardClass (parity with the others)',
   'hazardClass' in SCHEMA.rawMaterials.columns);

console.log('\n--- packagings is one shared polymorphic table ---');
const pkg = allTables().find(t => t.table === 'packagings');
ok('packagings table exists and is polymorphic', !!pkg && !!pkg.polymorphic);
ok('packagings keyed by sku', pkg && pkg.naturalKey === 'sku');
['sku', 'packageType', 'size', 'unitsPerPackage', 'packagesPerSlot', 'isDefault']
  .forEach(c => ok('packagings has column ' + c, c in pkg.columns));

console.log('\n--- lot-level cataloging columns (all optional) ---');
const lots = allTables().find(t => t.table === 'lots');
const NEW_LOT = ['packagingId', 'expirationDate', 'productionDate', 'arrivalDate',
                 'origin', 'mfg', 'orderRef', 'containerCount'];
NEW_LOT.forEach(c => ok('lots has column ' + c, c in lots.columns));
ok('new lot columns are all optional (no required flag)',
   NEW_LOT.every(c => !String(lots.columns[c]).includes('!')),
   NEW_LOT.filter(c => String(lots.columns[c]).includes('!')).join(', '));

console.log('\n--- seed: every catalog item is cataloged ---');
CATALOG.forEach(e => {
  const items = D[e] || [];
  ok(e + ': every item has >=1 packaging',
     items.length > 0 && items.every(i => Array.isArray(i.packagings) && i.packagings.length > 0));
  ok(e + ': exactly one default packaging per item',
     items.every(i => i.packagings.filter(p => p.isDefault).length === 1));
  ok(e + ': packaging skus unique within an item',
     items.every(i => new Set(i.packagings.map(p => p.sku)).size === i.packagings.length));
  ok(e + ': every item has a positive shelf life',
     items.every(i => typeof i.shelfLifeDays === 'number' && i.shelfLifeDays > 0));
});

console.log('\n--- seed: lots carry packaging + computed expiry ---');
const allLots = CATALOG.flatMap(e => (D[e] || []).flatMap(i => (i.lots || []).map(l => ({ i, l }))));
ok('every seed lot references a packaging of its own item',
   allLots.every(({ i, l }) => i.packagings.some(p => p.id === l.packagingId)));
ok('every seed lot has an expiration date', allLots.every(({ l }) => !!l.expirationDate));
const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
ok('expiration = production date + shelf life',
   allLots.every(({ i, l }) => !l.productionDate || l.expirationDate === addDays(l.productionDate, i.shelfLifeDays)));

console.log('\n--- packagings survive a CSV round-trip ---');
{
  const emptyDb = () => Object.fromEntries(ENTITIES.map(e => [e, []]));
  const filesOf = (b) => Object.fromEntries(b.map(x => [x.table, x.csv]));
  const { data } = importCsvBundle(emptyDb(), filesOf(exportCsvBundle(D)));
  const count = (db) => CATALOG.reduce((s, e) => s + (db[e] || []).reduce((n, i) => n + ((i.packagings || []).length), 0), 0);
  ok('packaging count preserved on round-trip', count(D) === count(data) && count(D) > 0, count(D) + ' vs ' + count(data));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
