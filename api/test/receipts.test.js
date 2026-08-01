// Pure-logic tests for deriving dock bookings awaiting application.
'use strict';
const R = require('../_receipts');

let passed = 0, failed = 0;
function eq(a, e, m) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) passed++; else { failed++; console.error(`FAIL: ${m}\n  expected ${E}\n  got      ${A}`); }
}
const ok = (c, m) => eq(!!c, true, m);

const WH = {
  pallets: [
    { palletId: 'EV1', createdAt: '2026-08-01T09:00:00Z', contents: [
      { id: 'l1', batch: 'SUP-1', quantityOriginal: 600, quantityCurrent: 400,
        mrpPoId: 'po1', mrpPoLineId: 'pl1', mrpOrderRef: 'PO-1' },
    ]},
    { palletId: 'EV2', createdAt: '2026-08-02T09:00:00Z', contents: [
      { id: 'l2', batch: 'SUP-2', quantityOriginal: 300, quantityCurrent: 300,
        mrpPoId: 'po1', mrpPoLineId: 'pl2', mrpOrderRef: 'PO-1' },
      { id: 'l3', batch: 'HAND', quantityOriginal: 50, quantityCurrent: 50 }, // not MRP stock
    ]},
  ],
};

const all = R.bookingsFromWarehouseState(WH);
eq(all.length, 2, 'only lines linked to an order line are bookings');
eq(all[0].sourceLineId, 'l1', 'the content line id is the booking identity');
eq(all[0].palletId, 'EV1', 'the pallet is recorded');
eq(all[0].qty, 600, 'what arrived is booked, not what is left after picking');
eq(all[0].batch, 'SUP-1', 'the supplier batch carries over');
eq(all[0].receivedAt, '2026-08-01', 'received date is the day it landed');
eq(all[0].purchaseOrderLineId, 'pl1', 'the exact order line is named');
ok(!all.some((b) => b.batch === 'HAND'), 'a hand-built pallet line is not a booking');

eq(R.bookingsFromWarehouseState(null), [], 'null state yields nothing');
eq(R.bookingsFromWarehouseState({ pallets: 'nonsense' }), [], 'malformed pallets ignored');
eq(R.bookingsFromWarehouseState({ pallets: [null] }), [], 'a null pallet is skipped');
eq(R.bookingsFromWarehouseState({ pallets: [{ palletId: 'X', contents: [
  { id: 'z', quantityOriginal: 0, mrpPoId: 'p', mrpPoLineId: 'l' }] }] }), [],
  'a zero-quantity booking is not offered');

// --- pending vs applied ---------------------------------------------------
const none = R.derivePendingReceipts(WH, { warehouseReceipts: [] });
eq(none.counts, { pending: 2, applied: 0, total: 2 }, 'nothing applied yet');

const half = R.derivePendingReceipts(WH, {
  warehouseReceipts: [{ sourceLineId: 'l1', appliedAt: '2026-08-03', lotId: 'lot9' }],
});
eq(half.counts, { pending: 1, applied: 1, total: 2 }, 'the ledger takes one out of pending');
eq(half.pending[0].sourceLineId, 'l2', 'the remaining one is the unapplied booking');
eq(half.applied[0].lotId, 'lot9', 'an applied booking reports the lot it became');
eq(half.applied[0].appliedAt, '2026-08-03', 'and when it was applied');

const done = R.derivePendingReceipts(WH, {
  warehouseReceipts: [{ sourceLineId: 'l1' }, { sourceLineId: 'l2' }],
});
eq(done.counts.pending, 0, 'once every booking is in the ledger nothing is pending');

eq(R.derivePendingReceipts(WH, null).counts.pending, 2, 'no MRP data means nothing is applied yet');
eq(R.derivePendingReceipts(null, null).counts.total, 0, 'no warehouse data means no bookings');
eq(R.appliedSourceIds({ warehouseReceipts: [{ sourceLineId: 'a' }] }).a.sourceLineId, 'a',
   'ledger rows index by the booking they came from');
eq(R.appliedSourceIds(null), {}, 'null MRP data yields an empty ledger index');

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
