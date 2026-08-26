// Stock valuation and the daily snapshot row.
//
// The whole reason snapshots exist: a valuation recomputed from today's data
// can only answer "what is it worth now". Lots get consumed and costs get
// recalculated, so a figure not written down on the day is gone. These tests
// mostly guard the two ways that record could quietly go wrong — a day
// counted twice, or a soft figure passed off as a hard one.

'use strict';

const V = require('../_valuation');

let passed = 0, failed = 0;
function eq(a, e, m) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) passed++; else { failed++; console.error(`FAIL: ${m}\n  expected ${E}\n  got      ${A}`); }
}
const ok = (c, m) => eq(!!c, true, m);

const plant = () => ({
  rawMaterials: [
    { name: 'Green coffee', unitCost: 2, lots: [
      { qty: 100, unitCost: 3 },      // known cost
      { qty: 50 },                    // falls back to standard
      { qty: 0, unitCost: 99 },       // empty: not stock
    ] },
  ],
  intermediateProducts: [{ name: 'Roasted', unitCost: 7, lots: [{ qty: 10, unitCost: 8 }] }],
  finishedGoods: [{ name: 'Jar', unitCost: 5, lots: [{ qty: 4, unitCost: 6 }] }],
  wasteStreams: [{ name: 'Grounds', lots: [{ qty: 500 }] }],
});

// --- what the stock is worth ------------------------------------------------
{
  const v = V.valueInventory(plant());
  eq(v.byKey.raw.value, 400, 'a lot is valued at its own cost where known (100x3 + 50x2)');
  eq(v.byKey.raw.lots, 2, 'an empty lot is not stock and is not counted');
  eq(v.byKey.raw.estimatedLots, 1, 'the lot that fell back to standard cost is counted as an estimate');
  eq(v.byKey.intermediate.value, 80, 'intermediates valued the same way');
  eq(v.byKey.finished.value, 24, 'and finished goods');
  eq(v.total, 504, 'the total is the three stock categories');

  // A heap of spent grounds is not working capital in the way the other three
  // are, and folding it in would flatter the figure.
  ok(v.byKey.waste.lots === 1, 'waste is still valued');
  eq(v.total, 504, 'but deliberately left out of the total');

  eq(v.totalLots, 4, 'lots counted across the three stock categories');
  eq(v.estimatedLots, 1, 'and so are the estimated ones');
  // A number people act on has to say how soft it is.
  eq(v.basis, 'lotUnitCost', 'the method is stated, so this cannot be mistaken for a genealogy-traced figure');
}

// --- robustness -------------------------------------------------------------
{
  eq(V.valueInventory(null).total, 0, 'null data values at nothing');
  eq(V.valueInventory({}).total, 0, 'empty data too');
  eq(V.valueInventory({ rawMaterials: 'nonsense' }).byKey.raw.value, 0, 'malformed collection ignored');
  eq(V.valueInventory({ rawMaterials: [null] }).byKey.raw.lots, 0, 'a null item is skipped');
  eq(V.valueInventory({ rawMaterials: [{ lots: [null] }] }).byKey.raw.lots, 0, 'a null lot is skipped');
  eq(V.valueInventory({ rawMaterials: [{ lots: [{ qty: -5, unitCost: 2 }] }] }).byKey.raw.value, 0,
     'a negative quantity is not stock, and is certainly not negative value');
  eq(V.valueInventory({ rawMaterials: [{ lots: [{ qty: 10 }] }] }).byKey.raw.value, 0,
     'no cost anywhere values at zero rather than NaN');
  eq(V.valueInventory({ rawMaterials: [{ lots: [{ qty: 10 }] }] }).byKey.raw.estimatedLots, 1,
     'and says the figure is an estimate');
}

// --- the row a capture writes ----------------------------------------------
{
  const row = V.snapshotRow(plant(), { date: '2026-08-26', source: 'cron', capturedAt: 'T' });
  eq(row.date, '2026-08-26', 'the row is dated');
  eq(row.source, 'cron', 'and says where it came from');
  eq(row.capturedAt, 'T', 'and when');
  eq([row.rawValue, row.intermediateValue, row.finishedValue], [400, 80, 24], 'with a value per category');
  eq(row.totalValue, 504, 'and the total');
  eq(row.wasteValue, 0, 'waste recorded separately');
  eq(row.estimatedLots, 1, 'and how much of it rests on standard cost');

  // The MRP reads these back; a key it does not know simply comes through as
  // a blank column, which is the kind of thing nobody notices for a month.
  const expected = ['date', 'capturedAt', 'source', 'rawValue', 'intermediateValue',
    'finishedValue', 'wasteValue', 'totalValue', 'rawLots', 'intermediateLots',
    'finishedLots', 'estimatedLots', 'notes'];
  eq(Object.keys(row).sort(), expected.slice().sort(),
     'the row shape matches the MRP inventorySnapshots columns exactly');

  eq(V.snapshotRow(plant(), { date: '2026-08-26T23:59:00Z' }).date, '2026-08-26',
     'a timestamp is trimmed to its date');
  eq(V.snapshotRow(null, { date: '2026-08-26' }).totalValue, 0, 'null data still produces a row');
}

// --- one row per day, whatever happens --------------------------------------
{
  // A cron retry, an overlapping invocation, or somebody pressing the
  // dashboard button after the job fired must not double-count a day.
  const row = V.snapshotRow(plant(), { date: '2026-08-26' });
  const first = V.upsertSnapshot([], row);
  eq([first.replaced, first.list.length], [false, 1], 'the first capture inserts');
  ok(!!first.list[0].id, 'and the row gets an id');

  const again = V.upsertSnapshot(first.list, row);
  eq([again.replaced, again.list.length], [true, 1], 'a second capture on the same day replaces');

  const moved = V.upsertSnapshot(first.list,
    V.snapshotRow({ rawMaterials: [{ lots: [{ qty: 1, unitCost: 11 }] }] }, { date: '2026-08-26' }));
  eq(moved.list.length, 1, 'still one row for that day');
  eq(moved.list[0].rawValue, 11, 'carrying the newer figure');
  ok(!!moved.list[0].id, 'and keeping its id rather than losing it in the replace');

  const nextDay = V.upsertSnapshot(first.list, V.snapshotRow(plant(), { date: '2026-08-27' }));
  eq(nextDay.list.length, 2, 'a different day appends');
  eq(nextDay.replaced, false, 'and is not a replacement');

  eq(V.upsertSnapshot(null, row).list.length, 1, 'null history tolerated');
  eq(V.upsertSnapshot('nonsense', row).list.length, 1, 'malformed history tolerated');
  eq(V.upsertSnapshot([null], row).list.length, 2, 'a null row in the history is not mistaken for a match');
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
