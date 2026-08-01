// Applying dock bookings to the MRP. The property that matters is idempotency:
// a booking must create exactly one stock lot however many times it is applied,
// because a second lot silently inflates both inventory and cost.
import { seedData, tx, repo, poLines, poOrderedQty, poReceivedQty, poOutstanding,
         poDerivedStatus, rawStockOnHand, openOrderQty } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

// A plant with one placed order for 600, ready to receive against.
function plant() {
  const D = seedData();
  const raw = D.rawMaterials[0];
  raw.packagings = [{ id: 'pk', sku: 'S', packageType: 'sack', size: '60 kg', unitsPerPackage: 60, isDefault: true }];
  const po = tx.savePurchaseOrder(D, { supplier: 'Acme',
    lines: [{ rawMaterialId: raw.id, qty: 600, unitCost: 5, packagingId: 'pk', containerCount: 10 }] }).po;
  tx.placePurchaseOrder(D, { purchaseOrderId: po.id });
  return { D, raw, po, line: po.lines[0] };
}
const booking = (over) => ({
  sourceLineId: 'wh-line-1', palletId: 'EV1', purchaseOrderId: null,
  purchaseOrderLineId: null, batch: 'SUP-77', qty: 600, receivedAt: '2026-08-01', ...over
});

console.log('\n--- a booking becomes stock ---');
{
  const { D, raw, po, line } = plant();
  const before = rawStockOnHand(D.rawMaterials.find(r => r.id === raw.id));
  const res = tx.applyWarehouseReceipts(D, [booking({ purchaseOrderId: po.id, purchaseOrderLineId: line.id })]);
  ok('the booking applies', res.ok === true && res.applied.length === 1);
  ok('a stock lot is created', !!res.applied[0].lot && res.applied[0].lot.qty === 600);
  ok('carrying the supplier batch as its lot number', res.applied[0].lot.lotNumber === 'SUP-77');
  ok('priced from the order line, not the list price', res.applied[0].lot.unitCost === 5);
  ok('dated by when it landed, not when it was applied', res.applied[0].lot.date === '2026-08-01');
  ok('the stock is on the material', rawStockOnHand(D.rawMaterials.find(r => r.id === raw.id)) === before + 600);
  ok('the order records the delivery', poReceivedQty(po) === 600);
  ok('and completes', poDerivedStatus(po) === 'Received');
  ok('nothing is left owed', poOutstanding(po) === 0);
  ok('the ledger records it', D.warehouseReceipts.length === 1);
  ok('the ledger points at the lot it created', D.warehouseReceipts[0].lotId === res.applied[0].lot.id);
  ok('and at the booking it came from', D.warehouseReceipts[0].sourceLineId === 'wh-line-1');
  ok('and at the pallet it sits on', D.warehouseReceipts[0].palletId === 'EV1');
}

console.log('\n--- IDEMPOTENCY: the property that matters ---');
{
  const { D, raw, po, line } = plant();
  const b = booking({ purchaseOrderId: po.id, purchaseOrderLineId: line.id });

  tx.applyWarehouseReceipts(D, [b]);
  const stockAfterFirst = rawStockOnHand(D.rawMaterials.find(r => r.id === raw.id));
  const lotsAfterFirst = D.rawMaterials.find(r => r.id === raw.id).lots.length;

  const second = tx.applyWarehouseReceipts(D, [b]);
  ok('applying the same booking again applies nothing', second.applied.length === 0);
  ok('it is reported as already applied', second.skipped.length === 1 && second.skipped[0].reason === 'Already applied');
  ok('and is not an error - a retry is legitimate', second.ok === true);
  ok('no second stock lot is minted',
     D.rawMaterials.find(r => r.id === raw.id).lots.length === lotsAfterFirst);
  ok('stock on hand is unchanged', rawStockOnHand(D.rawMaterials.find(r => r.id === raw.id)) === stockAfterFirst);
  ok('the order is not double-credited', poReceivedQty(po) === 600);
  ok('the ledger still holds one row', D.warehouseReceipts.length === 1);

  // the same booking arriving twice in ONE call - two tabs, one queue
  const { D: D2, po: po2, line: line2 } = plant();
  const dup = booking({ purchaseOrderId: po2.id, purchaseOrderLineId: line2.id, qty: 300 });
  const res = tx.applyWarehouseReceipts(D2, [dup, dup]);
  ok('a booking repeated within one call applies once', res.applied.length === 1 && res.skipped.length === 1);
  ok('and credits the order once', poReceivedQty(po2) === 300);
}

console.log('\n--- partial deliveries ---');
{
  const { D, po, line } = plant();
  tx.applyWarehouseReceipts(D, [booking({ sourceLineId: 'a', purchaseOrderId: po.id, purchaseOrderLineId: line.id, qty: 200, batch: 'B1' })]);
  ok('a part delivery leaves the order open', poDerivedStatus(po) === 'Part received');
  ok('with the balance still owed', poOutstanding(po) === 400);
  tx.applyWarehouseReceipts(D, [booking({ sourceLineId: 'b', purchaseOrderId: po.id, purchaseOrderLineId: line.id, qty: 400, batch: 'B2' })]);
  ok('the balance completes it', poDerivedStatus(po) === 'Received');
  ok('two distinct bookings mean two ledger rows', D.warehouseReceipts.length === 2);
  ok('and two stock lots, one per delivery',
     D.rawMaterials[0].lots.filter(l => ['B1', 'B2'].includes(l.lotNumber)).length === 2);
}

console.log('\n--- a booking that cannot be applied is reported, not dropped ---');
{
  const { D, po, line } = plant();
  const over = tx.applyWarehouseReceipts(D, [booking({ sourceLineId: 'x', purchaseOrderId: po.id, purchaseOrderLineId: line.id, qty: 9999 })]);
  ok('more than the line owes is refused', over.failed.length === 1 && over.ok === false);
  ok('and nothing was written', D.warehouseReceipts.length === 0 && poReceivedQty(po) === 0);
  ok('the reason is given back', /still owes/.test(over.failed[0].reason));

  const gone = tx.applyWarehouseReceipts(D, [booking({ sourceLineId: 'y', purchaseOrderId: 'nope', purchaseOrderLineId: line.id })]);
  ok('an order that no longer exists is reported', gone.failed.length === 1);

  const badLine = tx.applyWarehouseReceipts(D, [booking({ sourceLineId: 'z', purchaseOrderId: po.id, purchaseOrderLineId: 'nope' })]);
  ok('a line that no longer exists is reported', badLine.failed.length === 1);

  tx.cancelPurchaseOrder(D, { purchaseOrderId: po.id });
  const cancelled = tx.applyWarehouseReceipts(D, [booking({ sourceLineId: 'c', purchaseOrderId: po.id, purchaseOrderLineId: line.id, qty: 10 })]);
  ok('a cancelled order does not accept stock', cancelled.failed.length === 1 && /cancelled/i.test(cancelled.failed[0].reason));
  ok('still nothing written', D.warehouseReceipts.length === 0);
}

console.log('\n--- a failure does not stop the rest of the queue ---');
{
  const { D, po, line } = plant();
  const res = tx.applyWarehouseReceipts(D, [
    booking({ sourceLineId: 'good-1', purchaseOrderId: po.id, purchaseOrderLineId: line.id, qty: 100, batch: 'G1' }),
    booking({ sourceLineId: 'bad', purchaseOrderId: 'nope', purchaseOrderLineId: line.id, qty: 50 }),
    booking({ sourceLineId: 'good-2', purchaseOrderId: po.id, purchaseOrderLineId: line.id, qty: 200, batch: 'G2' })
  ]);
  ok('the good bookings applied', res.applied.length === 2);
  ok('the bad one is reported', res.failed.length === 1);
  ok('the call reports overall failure so it is not ignored', res.ok === false);
  ok('the order was credited for the good ones only', poReceivedQty(po) === 300);
  ok('the ledger holds only what was applied', D.warehouseReceipts.length === 2);
}

console.log('\n--- defensive ---');
{
  const { D } = plant();
  ok('no bookings is a no-op', tx.applyWarehouseReceipts(D, []).applied.length === 0);
  ok('null is a no-op', tx.applyWarehouseReceipts(D, null).applied.length === 0);
  ok('a booking with no source id is ignored', tx.applyWarehouseReceipts(D, [{ qty: 5 }]).applied.length === 0);
  ok('the ledger is created if absent', Array.isArray(D.warehouseReceipts));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
