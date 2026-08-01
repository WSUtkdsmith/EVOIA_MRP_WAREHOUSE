// Pure derivation of dock bookings awaiting application to the MRP.
//
// The warehouse books a delivery the moment it lands — the pallet is real and
// has to be pickable. Telling the MRP is a separate step, and this is what the
// MRP reads to find out what it has not been told yet.
//
// Authority note: the *ledger* of what has been applied lives in the MRP, with
// the side that does the writing, not here and not in the warehouse. This module
// only reports what the warehouse has booked and subtracts what the ledger says
// is done; it never decides that something has been applied.

'use strict';

// A pallet content line is a booking against a purchase order when it carries
// the link the warehouse wrote at receipt time.
function bookingsFromWarehouseState(warehouseState) {
  const state = warehouseState && typeof warehouseState === 'object' ? warehouseState : {};
  const pallets = Array.isArray(state.pallets) ? state.pallets : [];
  const out = [];
  pallets.forEach((p) => {
    if (!p || typeof p !== 'object') return;
    const lines = Array.isArray(p.contents) ? p.contents : [];
    lines.forEach((line) => {
      if (!line || !line.mrpPoLineId || !line.mrpPoId) return;
      out.push({
        sourceLineId: line.id || '',
        palletId: p.palletId || '',
        purchaseOrderId: line.mrpPoId,
        purchaseOrderLineId: line.mrpPoLineId,
        orderRef: line.mrpOrderRef || '',
        batch: line.batch || '',
        // What was booked in, not what is left after picking: the MRP is being
        // told what arrived, and picking since is the warehouse's own business.
        qty: Number(line.quantityOriginal) || 0,
        receivedAt: String(p.createdAt || '').slice(0, 10),
      });
    });
  });
  return out.filter((b) => b.sourceLineId && b.qty > 0);
}

// Ledger rows already applied, keyed by the booking they came from.
function appliedSourceIds(mrpData) {
  const data = mrpData && typeof mrpData === 'object' ? mrpData : {};
  const rows = Array.isArray(data.warehouseReceipts) ? data.warehouseReceipts : [];
  const set = {};
  rows.forEach((r) => { if (r && r.sourceLineId) set[r.sourceLineId] = r; });
  return set;
}

// Split what the dock has booked into what the MRP still owes an entry for and
// what it has already recorded. Nothing is hidden: both lists come back.
function derivePendingReceipts(warehouseState, mrpData) {
  const bookings = bookingsFromWarehouseState(warehouseState);
  const applied = appliedSourceIds(mrpData);
  const pending = [];
  const done = [];
  bookings.forEach((b) => {
    const ledger = applied[b.sourceLineId];
    if (ledger) done.push({ ...b, appliedAt: ledger.appliedAt || '', lotId: ledger.lotId || '' });
    else pending.push(b);
  });
  return {
    pending,
    applied: done,
    counts: { pending: pending.length, applied: done.length, total: bookings.length },
  };
}

module.exports = {
  bookingsFromWarehouseState,
  appliedSourceIds,
  derivePendingReceipts,
};
