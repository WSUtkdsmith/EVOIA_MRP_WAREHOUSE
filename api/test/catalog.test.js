// Pure-logic tests for the shared inventory catalog derivation. No database, no
// installed dependencies — runs with plain node.
//
//   node api/test/catalog.test.js

'use strict';

const C = require('../_catalog');

let passed = 0;
let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}\n  expected ${e}\n  got      ${a}`); }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

const REF = new Date(Date.UTC(2026, 6, 31)); // 2026-07-31, fixed so results are stable

const FIXTURE = {
  finishedGoods: [{
    id: 'fg1', name: 'SSB', sku: 'SSB', unit: 'gal', hazardClass: 'N/A',
    shelfLifeDays: 540, physicallyStored: true,
    packagings: [
      { id: 'p1', sku: 'SSB-1GAL', packageType: 'jug', size: '1 gal', unitsPerPackage: 1, packagesPerSlot: 4, isDefault: true },
      { id: 'p2', sku: 'SSB-25GAL', packageType: 'jug', size: '2.5 gal', unitsPerPackage: 1, packagesPerSlot: 2, isDefault: false },
    ],
    lots: [
      { id: 'l1', lotNumber: '110-240312', qty: 277, producedQty: 808, packagingId: 'p2',
        productionDate: '2024-12-03', expirationDate: '2025-12-09', origin: 'Coastal Contract',
        mfg: 'LV', orderRef: '721645', containerCount: 3, date: '2024-03-05' },
      { id: 'l2', lotNumber: 'FRESH-1', qty: 100, producedQty: 100, packagingId: 'p1',
        productionDate: '2026-07-01', expirationDate: '2027-12-01' },
      { id: 'l3', lotNumber: 'SOON-1', qty: 5, producedQty: 5, packagingId: 'p1',
        expirationDate: '2026-09-01' },
      { id: 'l4', lotNumber: 'NODATE', qty: 0, producedQty: 9 }, // no packaging, no expiry
    ],
  }],
  rawMaterials: [{
    id: 'rm1', name: 'Solvent', sku: 'RM-1', unit: 'L', physicallyStored: true,
    packagings: [{ id: 'p3', sku: 'RM-1-55GAL', packageType: 'drum', size: '55 gal', packagesPerSlot: 1, isDefault: true }],
    lots: [{ id: 'l5', lotNumber: 'R-1', qty: 40, packagingId: 'p3', expirationDate: '2027-01-01' }],
  }],
  intermediateProducts: [{
    id: 'ip1', name: 'Transient WIP', sku: 'IP-1', physicallyStored: false, packagings: [], lots: [],
  }],
  wasteStreams: [{
    id: 'ws1', name: 'Solvent loss', sku: 'WS-1', physicallyStored: true, packagings: [], lots: [],
  }],
};

const cat = C.deriveCatalog(FIXTURE, REF);

// --- skus -----------------------------------------------------------------
eq(cat.skus.length, 3, 'one sku row per packaging across all entities');
const ssb25 = cat.skus.find((s) => s.sku === 'SSB-25GAL');
eq(ssb25.size, '2.5 gal', 'sku carries its size');
eq(ssb25.packagesPerSlot, 2, 'sku carries its footprint');
eq(ssb25.itemType, 'finished', 'sku carries the item type tag');
eq(ssb25.itemName, 'SSB', 'sku carries the item name');
eq(ssb25.isDefault, false, 'non-default packaging flagged as such');
ok(cat.skus.some((s) => s.itemType === 'raw'), 'raw material packagings included');
ok(cat.skus.every((s) => s.skuId), 'every sku row has a stable id');

// --- lots -----------------------------------------------------------------
eq(cat.lots.length, 5, 'every lot appears, including qty 0 and uncataloged');
const l1 = cat.lots.find((l) => l.lotId === 'l1');
eq(l1.sku, 'SSB-25GAL', 'lot joins to the packaging it references');
eq(l1.size, '2.5 gal', 'lot carries its size from the packaging');
eq(l1.qty, 277, 'lot carries remaining qty');
eq(l1.producedQty, 808, 'lot carries produced qty (what was made)');
eq(l1.origin, 'Coastal Contract', 'lot carries origin');
eq(l1.mfg, 'LV', 'lot carries manufacturer');
eq(l1.orderRef, '721645', 'lot carries order ref');
eq(l1.containerCount, 3, 'lot carries container count');
eq(l1.recordedDate, '2024-03-05', 'the MRP original date is preserved as recordedDate');

const l4 = cat.lots.find((l) => l.lotId === 'l4');
eq(l4.sku, 'SSB-1GAL', 'a lot with no packagingId falls back to the default packaging');
eq(l4.status, 'unknown', 'a lot with no expiry has unknown status');
eq(l4.monthsUntilExpiration, null, 'unknown status carries no month count');

// --- expiry -------------------------------------------------------------
eq(l1.status, 'expired', 'a past expiry is expired');
ok(l1.monthsUntilExpiration < 0, 'expired lots report negative months');
eq(cat.lots.find((l) => l.lotId === 'l2').status, 'ok', 'a far-future expiry is ok');
eq(cat.lots.find((l) => l.lotId === 'l3').status, 'expiring', 'an expiry inside the window is expiring');

eq(C.expiryStatus('2026-07-31', REF).status, 'expiring', 'expiring on the reference date is not yet expired');
eq(C.expiryStatus('2026-07-30', REF).status, 'expired', 'yesterday is expired');
eq(C.expiryStatus('', REF).status, 'unknown', 'empty expiry is unknown');
eq(C.expiryStatus('not-a-date', REF).status, 'unknown', 'unparseable expiry is unknown');

eq(C.monthsBetween(new Date(Date.UTC(2026, 0, 15)), new Date(Date.UTC(2026, 2, 1))), 1,
   'month diff truncates the way a person reads it');
eq(C.monthsBetween(new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2027, 0, 1))), 12,
   'a full year is 12 months');

// --- counts ---------------------------------------------------------------
eq(cat.counts.skus, 3, 'sku count');
eq(cat.counts.lots, 5, 'lot count');
eq(cat.counts.lotsInStock, 4, 'in-stock count excludes zero-qty lots');
eq(cat.counts.expired, 1, 'expired count covers in-stock lots only');
eq(cat.counts.expiring, 1, 'expiring count covers in-stock lots only');
eq(cat.counts.uncataloged, 1, 'a stored item with no packaging is counted as uncataloged');

// --- robustness -----------------------------------------------------------
const empty = C.deriveCatalog(null, REF);
eq(empty.skus.length, 0, 'null data yields an empty catalog, not a throw');
eq(empty.counts.lots, 0, 'null data yields zero lots');
eq(C.deriveCatalog({ finishedGoods: 'nonsense' }, REF).skus.length, 0, 'malformed collection ignored');
eq(C.deriveCatalog({ finishedGoods: [null, { id: 'x' }] }, REF).skus.length, 0, 'null/packaging-less items skipped');
ok(C.deriveCatalog(FIXTURE).lots.length === 5, 'a missing reference date still derives lots');

// --- extractMrpData -------------------------------------------------------
eq(C.extractMrpData({ [C.MRP_DATA_KEY]: JSON.stringify({ a: 1 }) }), { a: 1 }, 'parses the JSON string blob');
eq(C.extractMrpData({ [C.MRP_DATA_KEY]: { a: 1 } }), { a: 1 }, 'accepts an already-parsed object');
eq(C.extractMrpData({}), null, 'missing key yields null');
eq(C.extractMrpData(null), null, 'null state yields null');
eq(C.extractMrpData({ [C.MRP_DATA_KEY]: '{bad json' }), null, 'unparseable blob yields null, not a throw');

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
