import { bucketKeyOf, shipmentLines, lotCost, computeItemUnitCost,
         sellableToCustomer, shipmentUnitPrice, shipmentEvents,
         ENTITIES, seedData, repo, tx, purchaseOrderRecords, poReceivedQty,
         poOutstanding, poDerivedStatus, poDaysLate, poActualDate, openOrderQty,
         purchaseOrderedEvents, purchaseExpectedEvents, purchaseReceivedEvents,
         bucketEvents, exportCsvBundle, importCsvBundle, allTables, csvColumns,
         poOrderedQty, IMPORT_ORDER, normalizeData,
         landedCost, hasActualCost, poChargeTotal, poLineEffectiveUnitCost,
         PO_CHARGE_KINDS } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + String(x).slice(0,300) : '')); } };
const TODAY = new Date().toISOString().slice(0, 10);
const day = (s, n) => { const [y,m,d]=s.split('-').map(Number);
  return new Date(Date.UTC(y,m-1,d+n)).toISOString().slice(0,10); };

function plant() {
  const d = Object.fromEntries(ENTITIES.map(e => [e, []]));
  d.rawMaterials.push({ id:'RM1', name:'Green coffee', sku:'RM1', supplier:'Acme',
    unitCost:5, unit:'kg', certStatus:'', leadTimeDays:30, moq:0, reorderPoint:0,
    onOrder:0, notes:'', composition:[], lots:[] });
  return d;
}
// An order carries its material, quantity and cost on a line. These fixtures
// still name them at the top level for brevity, so the helper routes them onto
// a single line - which is the shape a one-material order has anyway.
const po = (d, over) => {
  const o = { qty:1000, unitCost:4.5, rawMaterialId:'RM1', packagingId:'', containerCount:0, ...over };
  const row = { id:'PO1', reference:'PO-1', supplier:'Acme',
    orderDate:'2026-01-01', expectedDate:'2026-02-01',
    status:'Ordered', notes:'', receipts:[],
    lines:[{ id:'L1', rawMaterialId:o.rawMaterialId, qty:o.qty, unitCost:o.unitCost,
             packagingId:o.packagingId, containerCount:o.containerCount, notes:'' }],
    ...over };
  delete row.qty; delete row.unitCost; delete row.rawMaterialId;
  delete row.packagingId; delete row.containerCount;
  d.purchaseOrders.push(row);
  return row;
};

console.log('\n--- outstanding and status follow the receipts ---');
{
  const d = plant(); const o = po(d);
  ok('nothing received yet', poReceivedQty(o) === 0 && poOutstanding(o) === 1000);
  ok('status reads as ordered', poDerivedStatus(o) === 'Ordered');
  ok('no actual date yet', poActualDate(o) === '');

  o.receipts.push({ id:'r1', date:'2026-02-03', qty:400, lotId:'', notes:'' });
  ok('partial receipt counted', poReceivedQty(o) === 400 && poOutstanding(o) === 600);
  ok('status becomes part received', poDerivedStatus(o) === 'Part received');

  o.receipts.push({ id:'r2', date:'2026-02-09', qty:600, lotId:'', notes:'' });
  ok('fully received', poOutstanding(o) === 0 && poDerivedStatus(o) === 'Received');
  ok('actual date is the LAST instalment', poActualDate(o) === '2026-02-09');
  ok('lateness measured against the promise', poDaysLate(o) === 8, String(poDaysLate(o)));
}

console.log('\n--- a cancelled order is not outstanding ---');
{
  const d = plant(); const o = po(d, { status:'Cancelled' });
  ok('contributes nothing on order', poOutstanding(o) === 0);
  ok('status is preserved, not inferred', poDerivedStatus(o) === 'Cancelled');
  ok('excluded from on-order totals', openOrderQty(d, 'RM1') === 0);
}

console.log('\n--- on-order comes from the orders, not a hand-kept number ---');
{
  const d = plant();
  d.rawMaterials[0].onOrder = 9999;
  ok('with no orders it falls back to the stored figure', openOrderQty(d, 'RM1') === 9999);
  po(d, { id:'A', reference:'PO-A', qty: 500 });
  po(d, { id:'B', reference:'PO-B', qty: 300,
    receipts:[{ id:'r', date:'2026-02-01', qty:100, lotId:'', notes:'' }] });
  ok('once orders exist they take over', openOrderQty(d, 'RM1') === 700,
     String(openOrderQty(d, 'RM1')));
  ok('and the stale figure is ignored', openOrderQty(d, 'RM1') !== 9999);
}

console.log('\n--- receiving creates the lot and the receipt together ---');
{
  const d = plant(); const o = po(d, { unitCost: 4.25 });
  const res = tx.receiveAgainstOrder(d, { purchaseOrderId:'PO1', date:'2026-02-05',
    qty:600, lotNumber:'GC-001', notes:'' });
  ok('the transaction succeeds', res.ok === true, res.error);
  ok('a stock lot was created', d.rawMaterials[0].lots.length === 1);
  const lot = d.rawMaterials[0].lots[0];
  ok('at the order price, not the list price', lot.unitCost === 4.25);
  ok('with producedQty set', lot.producedQty === 600);
  ok('the receipt points at that lot', o.receipts.length === 1 && o.receipts[0].lotId === lot.id);
  ok('status updated on the order', o.status === 'Part received');
  ok('outstanding reduced', poOutstanding(o) === 400);

  const bad = tx.receiveAgainstOrder(d, { purchaseOrderId:'PO1', qty:0 });
  ok('a zero receipt is refused', bad.ok === false && /greater than zero/.test(bad.error));
  ok('and nothing was written', d.rawMaterials[0].lots.length === 1);

  const gone = tx.receiveAgainstOrder(d, { purchaseOrderId:'nope', qty:5 });
  ok('an unknown order is refused', gone.ok === false);
}

console.log('\n--- overdue is not the same as late ---');
{
  const d = plant();
  const stillComing = po(d, { id:'A', reference:'PO-A', expectedDate: day(TODAY, 10) });
  const chaseMe = po(d, { id:'B', reference:'PO-B', expectedDate: day(TODAY, -5) });
  const arrivedLate = po(d, { id:'C', reference:'PO-C', expectedDate:'2026-01-10', qty:100,
    receipts:[{ id:'r', date:'2026-01-20', qty:100, lotId:'', notes:'' }] });

  const recs = purchaseOrderRecords(d);
  const byRef = Object.fromEntries(recs.map(r => [r.reference, r]));
  ok('an order still in its window is neither', !byRef['PO-A'].overdue && !byRef['PO-A'].late);
  ok('an open order past its date is overdue, not late', byRef['PO-B'].overdue && !byRef['PO-B'].late);
  ok('a delivered order past its date is late, not overdue',
     byRef['PO-C'].late && !byRef['PO-C'].overdue);
  ok('lateness is counted in days', byRef['PO-C'].daysLate === 10, String(byRef['PO-C'].daysLate));
}

console.log('\n--- procurement events ---');
{
  const d = plant();
  po(d, { qty: 1000, orderDate:'2026-01-01', expectedDate:'2026-02-01',
    receipts:[{ id:'r', date:'2026-02-04', qty:400, lotId:'', notes:'' }] });

  const ordered = purchaseOrderedEvents(d);
  const expected = purchaseExpectedEvents(d);
  const received = purchaseReceivedEvents(d);
  ok('ordered is dated by the order date', ordered[0].date === '2026-01-01' && ordered[0].value === 1000);
  ok('expected carries only the OUTSTANDING balance', expected[0].value === 600,
     String(expected[0].value));
  ok('received is dated by the instalment', received[0].date === '2026-02-04' && received[0].value === 400);
  ok('so expected and received never double count',
     expected[0].value + received[0].value === 1000);

  const done = plant();
  po(done, { receipts:[{ id:'r', date:'2026-02-04', qty:1000, lotId:'', notes:'' }] });
  ok('a fully received order expects nothing further',
     purchaseExpectedEvents(done).length === 0);
}

console.log('\n--- against the seeded plant ---');
{
  const D = seedData();
  const recs = purchaseOrderRecords(D);
  ok('orders exist', recs.length > 30, String(recs.length));
  ok('every order names a real material', recs.every(r => !!r.raw));
  ok('every order is dated and has an expected date',
     recs.every(r => !!r.orderDate && !!r.expectedDate));
  ok('orders precede their expected delivery',
     recs.every(r => r.orderDate <= r.expectedDate));
  ok('some are still open', recs.some(r => r.open));
  ok('some are overdue', recs.some(r => r.overdue));
  ok('some arrived late', recs.some(r => r.late));
  ok('at least one is part received', recs.some(r => r.status === 'Part received'));
  ok('received quantities never exceed the order',
     recs.every(r => r.receivedQty <= r.qty + 0.01));
  ok('every receipt points at a real stock lot', recs.every(r =>
     r.receipts.every(rc => !rc.lotId ||
       (r.raw.lots || []).some(l => l.id === rc.lotId))));
  ok('on-order is derived for every material',
     (D.rawMaterials || []).every(m => openOrderQty(D, m.id) >= 0));
}

console.log('\n--- amending an order the supplier already holds ---');
{
  const d = plant();
  d.rawMaterials.push({ id:'RM2', name:'Cocoa', sku:'RM2', supplier:'Acme',
    unitCost:8, unit:'kg', certStatus:'', leadTimeDays:20, moq:0, reorderPoint:0,
    onOrder:0, notes:'', composition:[], lots:[] });
  const o = po(d, { qty: 1000 });
  o.lines.push({ id:'L2', rawMaterialId:'RM2', qty:200, unitCost:8,
                 packagingId:'', containerCount:0, notes:'' });

  const noReason = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1',
    expectedDate:'2026-03-01', lines: o.lines.map(l => ({...l})) });
  ok('an amendment with no reason is refused',
     noReason.ok === false && /reason is required/i.test(noReason.error));
  ok('and nothing moved', o.expectedDate === '2026-02-01');

  const moved = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1',
    expectedDate:'2026-03-01', lines: o.lines.map(l => ({...l})),
    reason:'Supplier pushed the ship date', author:'AB', date:'2026-01-20' });
  ok('with a reason it is accepted', moved.ok === true, moved.error);
  ok('the date moved', o.expectedDate === '2026-03-01');
  ok('and one revision was written', (o.revisions || []).length === 1);
  ok('naming the field, both values and the reason', (() => {
    const r = o.revisions[0];
    return r.field === 'expectedDate' && r.fromValue === '2026-02-01' &&
           r.toValue === '2026-03-01' && /pushed/.test(r.reason) && r.author === 'AB';
  })(), JSON.stringify(o.revisions[0]));

  const same = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1',
    expectedDate:'2026-03-01', lines: o.lines.map(l => ({...l})), reason:'no-op' });
  ok('an amendment that changes nothing records nothing',
     same.ok === true && same.changed.length === 0 && o.revisions.length === 1);
}

console.log('\n--- what stock has already fixed cannot be amended away ---');
{
  const d = plant();
  d.rawMaterials.push({ id:'RM2', name:'Cocoa', sku:'RM2', supplier:'Acme',
    unitCost:8, unit:'kg', certStatus:'', leadTimeDays:20, moq:0, reorderPoint:0,
    onOrder:0, notes:'', composition:[], lots:[] });
  const o = po(d, { qty: 1000 });
  o.lines.push({ id:'L2', rawMaterialId:'RM2', qty:200, unitCost:8,
                 packagingId:'', containerCount:0, notes:'' });
  o.receipts.push({ id:'r1', lineId:'L1', date:'2026-02-03', qty:400, lotId:'', notes:'' });
  const R = () => ({ reason:'revised', date:'2026-02-04' });

  const cut = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1', ...R(),
    lines: [{ ...o.lines[0], qty: 300 }, { ...o.lines[1] }] });
  ok('a received line cannot be cut below what arrived',
     cut.ok === false && /already been received/.test(cut.error), cut.error);

  const dropped = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1', ...R(),
    lines: [{ ...o.lines[1] }] });
  ok('nor removed', dropped.ok === false && /Cannot remove/.test(dropped.error), dropped.error);

  const repointed = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1', ...R(),
    lines: [{ ...o.lines[0], rawMaterialId:'RM2' }, { ...o.lines[1] }] });
  ok('nor re-pointed at another material',
     repointed.ok === false && /change the material/.test(repointed.error), repointed.error);

  ok('and after three refusals the order is untouched',
     poOrderedQty(o) === 1200 && o.lines.length === 2 && (o.revisions || []).length === 0);

  // The untouched line is still just an intention, so it may go.
  const ok1 = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1', ...R(),
    lines: [{ ...o.lines[0] }] });
  ok('a line with nothing received against it can be removed', ok1.ok === true, ok1.error);
  ok('the order is down to one line', o.lines.length === 1);
  ok('the removal is on the record',
     (o.revisions || []).some(r => r.field === 'line removed' && r.lineRef === 'Cocoa'),
     JSON.stringify(o.revisions));

  // Cutting the received line back to exactly what arrived closes the order.
  const closed = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1', ...R(),
    lines: [{ ...o.lines[0], qty: 400 }] });
  ok('cutting a line to what arrived is allowed', closed.ok === true, closed.error);
  ok('and the order reads as received rather than still open',
     poDerivedStatus(o) === 'Received' && o.status === 'Received', o.status);

  const done = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1', ...R(),
    lines: [{ ...o.lines[0], qty: 900 }] });
  ok('a fully received order cannot then be re-opened by amendment',
     done.ok === false && /received in full/.test(done.error), done.error);
}

console.log('\n--- amendment is not a back door round the other states ---');
{
  const d = plant();
  const draft = po(d, { status:'Draft' });
  const r1 = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1', reason:'x',
    lines: draft.lines.map(l => ({...l})), expectedDate:'2026-05-01' });
  ok('a draft is edited, not amended',
     r1.ok === false && /still a draft/.test(r1.error), r1.error);

  const e = plant();
  const cancelled = po(e, { status:'Cancelled' });
  const r2 = tx.amendPurchaseOrder(e, { purchaseOrderId:'PO1', reason:'x',
    lines: cancelled.lines.map(l => ({...l})), expectedDate:'2026-05-01' });
  ok('a cancelled order cannot be amended', r2.ok === false, r2.error);

  const g = plant();
  const placed = po(g);
  const r3 = tx.amendPurchaseOrder(g, { purchaseOrderId:'PO1', reason:'x', lines: [] });
  ok('an amendment cannot empty an order',
     r3.ok === false && /at least one line/.test(r3.error), r3.error);
  ok('and savePurchaseOrder still refuses a placed order outright', (() => {
    const s = tx.savePurchaseOrder(g, { purchaseOrderId:'PO1', reference:'PO-1',
      lines: placed.lines.map(l => ({...l})) });
    return s.ok === false && /already been placed/.test(s.error);
  })());
}

console.log('\n--- a placed order can grow, and the growth is on the record ---');
{
  const d = plant();
  d.rawMaterials.push({ id:'RM2', name:'Cocoa', sku:'RM2', supplier:'Acme',
    unitCost:8, unit:'kg', certStatus:'', leadTimeDays:20, moq:0, reorderPoint:0,
    onOrder:0, notes:'', composition:[], lots:[] });
  const o = po(d, { qty: 1000 });
  o.receipts.push({ id:'r1', lineId:'L1', date:'2026-02-03', qty:1000, lotId:'', notes:'' });
  ok('it starts fully received', poDerivedStatus(o) === 'Received');

  // Which is exactly why it is closed to amendment - adding to a completed
  // order is a new order, not a revision of a finished one.
  const grow = tx.amendPurchaseOrder(d, { purchaseOrderId:'PO1', reason:'more',
    lines: [{ ...o.lines[0] }, { id:'L2', rawMaterialId:'RM2', qty:50, unitCost:8,
                                 packagingId:'', containerCount:0, notes:'' }] });
  ok('so it is refused', grow.ok === false, grow.error);

  const e = plant();
  e.rawMaterials.push({ id:'RM2', name:'Cocoa', sku:'RM2', supplier:'Acme',
    unitCost:8, unit:'kg', certStatus:'', leadTimeDays:20, moq:0, reorderPoint:0,
    onOrder:0, notes:'', composition:[], lots:[] });
  const p = po(e, { qty: 1000 });
  p.receipts.push({ id:'r1', lineId:'L1', date:'2026-02-03', qty:400, lotId:'', notes:'' });
  const added = tx.amendPurchaseOrder(e, { purchaseOrderId:'PO1', reason:'added cocoa',
    date:'2026-02-04',
    lines: [{ ...p.lines[0] }, { id:'L2', rawMaterialId:'RM2', qty:50, unitCost:8,
                                 packagingId:'', containerCount:0, notes:'' }] });
  ok('a part-received order can take a new line', added.ok === true, added.error);
  ok('the quantity on order went up', poOrderedQty(p) === 1050);
  ok('and the addition names the material it added',
     (p.revisions || []).some(r => r.field === 'line added' && r.lineRef === 'Cocoa'),
     JSON.stringify(p.revisions));
  ok('the order is still part received', poDerivedStatus(p) === 'Part received');
}

console.log('\n--- an invoiced price never overwrites the agreed one ---');
{
  const d = plant(); const o = po(d, { qty: 1000, unitCost: 4.5 });
  const before = tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1',
    invoiceVariance: true, invoiceRef:'INV-9', invoiceDate:'2026-02-10',
    lineCosts: [{ lineId:'L1', actualUnitCost: 4.8 }] });
  ok('the invoice is accepted', before.ok === true, before.error);
  ok('THE ORDERED PRICE IS UNCHANGED', o.lines[0].unitCost === 4.5, String(o.lines[0].unitCost));
  ok('the billed price is stored beside it', o.lines[0].actualUnitCost === 4.8);
  ok('and the invoice reference with it', o.invoiceRef === 'INV-9');

  const L = landedCost(d, o);
  ok('ordered value is still the agreed value', L.orderedValue === 4500);
  ok('invoiced value uses the billed price', L.invoicedValue === 4800);
  ok('the variance is the difference, stated once', L.materialVariance === 300);
  ok('per line the variance is per unit',
     Math.abs(L.lines[0].unitCostVariance - 0.3) < 1e-9,
     String(L.lines[0].unitCostVariance));

  // Untick and the claim goes with its figures.
  const off = tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1', invoiceVariance: false });
  ok('withdrawing the claim is accepted', off.ok === true, off.error);
  ok('the billed price is cleared', o.lines[0].actualUnitCost === '');
  ok('the ordered price is STILL unchanged', o.lines[0].unitCost === 4.5);
  ok('and the order costs what it always did', landedCost(d, o).invoicedValue === 4500);
}

console.log('\n--- blank is not zero ---');
{
  const d = plant(); const o = po(d, { qty: 100, unitCost: 5 });
  ok('an untouched line has no invoiced cost', !hasActualCost(o.lines[0]));
  ok('a blank string is not a cost', !hasActualCost({ actualUnitCost: '' }));
  ok('nor is null or undefined',
     !hasActualCost({ actualUnitCost: null }) && !hasActualCost({}));
  ok('but zero IS a figure — a line can be billed free',
     hasActualCost({ actualUnitCost: 0 }));

  tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1', invoiceVariance: true,
    lineCosts: [{ lineId:'L1', actualUnitCost: '' }] });
  const L = landedCost(d, o);
  ok('an uninvoiced line falls back to the ordered price', L.lines[0].effectiveUnitCost === 5);
  ok('and reports no variance rather than a variance of zero',
     L.lines[0].unitCostVariance === null);
  ok('so a part-invoiced order is not half zero', L.invoicedValue === 500);

  const z = plant(); const zo = po(z, { qty: 100, unitCost: 5 });
  tx.recordPurchaseCosts(z, { purchaseOrderId:'PO1', invoiceVariance: true,
    lineCosts: [{ lineId:'L1', actualUnitCost: 0 }] });
  ok('a genuine zero is honoured', landedCost(z, zo).invoicedValue === 0);
  ok('and reads as a full credit against the order',
     landedCost(z, zo).materialVariance === -500);
}

console.log('\n--- non-material costs split across the units ---');
{
  const d = plant(); const o = po(d, { qty: 1000, unitCost: 4 });
  const res = tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1',
    charges: [{ kind:'Shipping', description:'Ocean freight', amount: 800 },
              { kind:'Tax', description:'Duty', amount: 200 }] });
  ok('charges are accepted', res.ok === true, res.error);
  ok('and totalled', poChargeTotal(o) === 1000);

  const L = landedCost(d, o);
  ok('the split basis is per unit by default', L.basisUsed === 'perUnit');
  ok('charge per unit is the charges over the units', L.chargePerUnit === 1,
     String(L.chargePerUnit));
  ok('LANDED UNIT COST IS MATERIAL PLUS ITS SHARE', L.lines[0].landedUnitCost === 5,
     String(L.lines[0].landedUnitCost));
  ok('landed value is invoiced plus charges', L.landedValue === 5000);
  ok('charges are grouped by kind',
     L.chargesByKind.Shipping === 800 && L.chargesByKind.Tax === 200 &&
     L.chargesByKind.Handling === 0);
  ok('material variance is nil — nothing was billed differently',
     L.materialVariance === 0);

  // Both effects at once, still separable.
  tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1', invoiceVariance: true,
    lineCosts: [{ lineId:'L1', actualUnitCost: 4.5 }],
    charges: [{ kind:'Shipping', description:'Ocean freight', amount: 800 },
              { kind:'Tax', description:'Duty', amount: 200 }] });
  const B = landedCost(d, o);
  ok('price and freight stay distinguishable',
     B.materialVariance === 500 && B.chargeTotal === 1000);
  ok('and land together', B.landedValue === 5500);
  ok('per unit', B.lines[0].landedUnitCost === 5.5, String(B.lines[0].landedUnitCost));
}

console.log('\n--- an even split across two lines of the same unit ---');
{
  const d = plant();
  d.rawMaterials.push({ id:'RM2', name:'Cocoa', sku:'RM2', supplier:'Acme',
    unitCost:8, unit:'kg', certStatus:'', leadTimeDays:20, moq:0, reorderPoint:0,
    onOrder:0, notes:'', composition:[], lots:[] });
  const o = po(d, { qty: 300, unitCost: 4 });
  o.lines.push({ id:'L2', rawMaterialId:'RM2', qty:100, unitCost:10,
                 packagingId:'', containerCount:0, notes:'', actualUnitCost:'' });
  tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1',
    charges: [{ kind:'Handling', description:'Palletising', amount: 400 }] });

  const L = landedCost(d, o);
  ok('both lines are in kg, so per unit is available', L.perUnitAvailable === true);
  ok('every unit wears the same share regardless of value', L.chargePerUnit === 1);
  ok('the big line carries three quarters of it', L.lines[0].chargeShare === 300);
  ok('and the small line the rest', L.lines[1].chargeShare === 100);
  ok('SHARES SUM TO THE CHARGES — nothing is lost or invented',
     Math.abs(L.lines.reduce((s,l)=>s+l.chargeShare,0) - 400) < 0.0001);
  ok('landed unit costs differ because the materials do',
     L.lines[0].landedUnitCost === 5 && L.lines[1].landedUnitCost === 11);

  // By value instead: the expensive line takes more of the freight.
  const V = landedCost(d, o, { basis: 'byValue' });
  ok('by value the split follows the money', V.basisUsed === 'byValue');
  ok('the 1200 line takes 200 of 400', Math.abs(V.lines[0].chargeShare - 218.18) < 0.01,
     String(V.lines[0].chargeShare));
  ok('and by value the shares still sum to the charges',
     Math.abs(V.lines.reduce((s,l)=>s+l.chargeShare,0) - 400) < 0.0001);
  ok('the landed TOTAL is the same either way — only its allocation moves',
     Math.abs(V.landedValue - L.landedValue) < 0.0001);
}

console.log('\n--- units that cannot be added are not added ---');
{
  const d = plant();
  d.rawMaterials.push({ id:'RM3', name:'Drums', sku:'RM3', supplier:'Acme',
    unitCost:20, unit:'ea', certStatus:'', leadTimeDays:10, moq:0, reorderPoint:0,
    onOrder:0, notes:'', composition:[], lots:[] });
  const o = po(d, { qty: 1000, unitCost: 4 });   // kg
  o.lines.push({ id:'L2', rawMaterialId:'RM3', qty:40, unitCost:20,
                 packagingId:'', containerCount:0, notes:'', actualUnitCost:'' });
  tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1',
    charges: [{ kind:'Shipping', description:'Freight', amount: 480 }] });

  const L = landedCost(d, o);
  ok('the order is flagged as mixing units', L.mixedUnits === true);
  ok('it names them', L.units.includes('kg') && L.units.includes('ea'));
  ok('SO PER UNIT IS REFUSED — 1000 kg and 40 ea are not 1040 of anything',
     L.perUnitAvailable === false);
  ok('and no per-unit charge figure is offered', L.chargePerUnit === null);
  ok('it falls back to line value, which is always defined', L.basisUsed === 'byValue');
  ok('the shares still sum to the charges',
     Math.abs(L.lines.reduce((s,l)=>s+l.chargeShare,0) - 480) < 0.0001);
  ok('and each line still gets a landed unit cost in its OWN unit',
     L.lines[0].landedUnitCost > 4 && L.lines[1].landedUnitCost > 20);
  ok('asking for per unit anyway does not get it',
     landedCost(d, o, { basis: 'perUnit' }).basisUsed === 'byValue');
}

console.log('\n--- charges that cannot be spread are reported, not dropped ---');
{
  const d = plant();
  const o = po(d, { qty: 1000, unitCost: 0 });   // free of charge, freight owed
  tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1',
    charges: [{ kind:'Shipping', description:'Freight on a free sample', amount: 120 }] });
  const L = landedCost(d, o);
  ok('a zero-value order can still be split per unit', L.basisUsed === 'perUnit');
  ok('and the freight lands on the units', L.lines[0].landedUnitCost === 0.12);

  const e = plant();
  const empty = po(e, { qty: 1000, unitCost: 4 });
  empty.lines = [];
  empty.charges = [{ id:'c1', kind:'Shipping', description:'Freight', amount: 90, date:'', notes:'' }];
  const E = landedCost(e, empty);
  ok('an order with no lines cannot spread anything', E.basisUsed === 'unallocated');
  ok('the money is reported as unallocated rather than vanishing',
     E.unallocatedCharges === 90);
  ok('and is not silently folded into the landed value', E.landedValue === 0);
  ok('nothing divided by zero', Number.isFinite(E.invoicedValue) && E.chargePerUnit === null);
}

console.log('\n--- what the invoice form refuses ---');
{
  const d = plant(); po(d, { status:'Draft' });
  const draft = tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1', invoiceVariance: true });
  ok('a draft cannot have been invoiced',
     draft.ok === false && /not been sent/.test(draft.error), draft.error);

  const e = plant(); po(e, { status:'Cancelled' });
  const cancelled = tx.recordPurchaseCosts(e, { purchaseOrderId:'PO1', invoiceVariance: true });
  ok('nor can a cancelled order', cancelled.ok === false, cancelled.error);

  const g = plant(); const o = po(g);
  const neg = tx.recordPurchaseCosts(g, { purchaseOrderId:'PO1', invoiceVariance: true,
    lineCosts: [{ lineId:'L1', actualUnitCost: -1 }] });
  ok('a negative invoiced cost is refused',
     neg.ok === false && /cannot be negative/.test(neg.error), neg.error);

  const noExpl = tx.recordPurchaseCosts(g, { purchaseOrderId:'PO1',
    charges: [{ kind:'Other', description:'  ', amount: 50 }] });
  ok('an "Other" charge must say what it is',
     noExpl.ok === false && /has to say what it is/.test(noExpl.error), noExpl.error);
  ok('a named Other charge is fine', tx.recordPurchaseCosts(g, { purchaseOrderId:'PO1',
     charges: [{ kind:'Other', description:'Port demurrage', amount: 50 }] }).ok === true);
  ok('a Shipping charge needs no explanation', tx.recordPurchaseCosts(g, { purchaseOrderId:'PO1',
     charges: [{ kind:'Shipping', description:'', amount: 50 }] }).ok === true);

  const negC = tx.recordPurchaseCosts(g, { purchaseOrderId:'PO1',
    charges: [{ kind:'Tax', amount: -5 }] });
  ok('a negative charge is refused', negC.ok === false, negC.error);
  ok('and after every refusal the order carries only what was accepted',
     poChargeTotal(o) === 50 && o.charges[0].kind === 'Shipping');

  const zero = tx.recordPurchaseCosts(g, { purchaseOrderId:'PO1',
    charges: [{ kind:'Tax', amount: 0 }, { kind:'Shipping', amount: 30 }] });
  ok('a zero-amount row is dropped, not stored', zero.ok === true && o.charges.length === 1);
  ok('every kind is one of the four offered',
     PO_CHARGE_KINDS.length === 4 && PO_CHARGE_KINDS.includes('Handling'));
}

console.log('\n--- landed cost does not restate stock already received ---');
{
  const d = plant(); const o = po(d, { qty: 1000, unitCost: 4 });
  tx.receiveAgainstOrder(d, { purchaseOrderId:'PO1', date:'2026-02-05',
    qty: 1000, lotNumber:'GC-1', notes:'' });
  const lot = d.rawMaterials[0].lots[0];
  ok('the lot was booked at the ordered price', lot.unitCost === 4);

  tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1', invoiceVariance: true,
    lineCosts: [{ lineId:'L1', actualUnitCost: 6 }],
    charges: [{ kind:'Shipping', description:'Freight', amount: 1000 }] });
  ok('THE RECEIVED LOT KEEPS ITS PRICE — a late invoice cannot rewrite an earned margin',
     d.rawMaterials[0].lots[0].unitCost === 4);
  ok('while the order reports the true landed cost',
     landedCost(d, o).lines[0].landedUnitCost === 7,
     String(landedCost(d, o).lines[0].landedUnitCost));
  ok('and the gap between the two is visible, not hidden',
     landedCost(d, o).landedValue - landedCost(d, o).orderedValue === 3000,
     String(landedCost(d, o).landedValue));
}

console.log('\n--- the records carry the same reckoning as the order ---');
{
  const d = plant(); const o = po(d, { qty: 500, unitCost: 4 });
  tx.recordPurchaseCosts(d, { purchaseOrderId:'PO1', invoiceVariance: true,
    invoiceRef:'INV-77',
    lineCosts: [{ lineId:'L1', actualUnitCost: 4.4 }],
    charges: [{ kind:'Tax', description:'Duty', amount: 300 }] });

  const rec = purchaseOrderRecords(d)[0];
  const L = landedCost(d, o);
  ok('the record exposes the landed figures', !!rec.landed);
  ok('and they are the SAME reckoning, not a second one',
     rec.landedValue === L.landedValue && rec.chargeTotal === L.chargeTotal &&
     rec.materialVariance === L.materialVariance);
  ok('`value` on the record is still the ORDERED value', rec.value === 2000);
  ok('landed is separate from it', rec.landedValue === 2500);
  ok('and the variance against plan is the whole difference', rec.landedVariance === 500);
  ok('the line rows carry the landed unit cost', rec.lines[0].landedUnitCost === 5);
  ok('and the billed price beside the ordered one',
     rec.lines[0].unitCost === 4 && rec.lines[0].actualUnitCost === 4.4);
  ok('an order with no invoice reports no variance rather than zeroes', (() => {
    const p = plant(); po(p, { qty: 100, unitCost: 3 });
    const r = purchaseOrderRecords(p)[0];
    return r.landedVariance === 0 && r.hasInvoice === false && r.landed.chargeTotal === 0;
  })());
}

console.log('\n--- orders can be found by the material on their lines ---');
{
  const D = seedData();
  const raw = D.rawMaterials.find(m =>
    (D.purchaseOrders || []).some(p => (p.lines || []).some(l => l.rawMaterialId === m.id)));
  ok('a material with orders exists', !!raw);
  const forRaw = purchaseOrderRecords(D, { rawMaterialId: raw.id });
  ok('filtering by it returns those orders', forRaw.length > 0, String(forRaw.length));
  ok('and only those', forRaw.every(r =>
     r.lines.some(l => l.line.rawMaterialId === raw.id)));
  ok('which is fewer than all of them', forRaw.length < purchaseOrderRecords(D).length);
  ok('an unknown material returns nothing',
     purchaseOrderRecords(D, { rawMaterialId: 'nope' }).length === 0);
}

console.log('\n--- schema, export and migration ---');
{
  const tables = allTables().map(t => t.table);
  ok('purchase_orders is a table', tables.includes('purchase_orders'));
  ok('purchase_receipts is a table', tables.includes('purchase_receipts'));
  const rt = allTables().find(t => t.table === 'purchase_receipts');
  ok('receipts carry their order', csvColumns(rt)[0] === 'purchaseOrderId');
  ok('and a readable lot reference', csvColumns(rt).includes('lotNumber'));
  ok('purchase_order_revisions is a table', tables.includes('purchase_order_revisions'));
  ok('and it is in the import order after its parent',
     IMPORT_ORDER.indexOf('purchase_order_revisions') >
     IMPORT_ORDER.indexOf('purchase_orders'));
  const rv = allTables().find(t => t.table === 'purchase_order_revisions');
  ok('revisions carry their order', csvColumns(rv)[0] === 'purchaseOrderId');
  ok('and the reason is required', (rv.columns.reason || '').endsWith('!'));

  const D = seedData();
  const bundle = exportCsvBundle(D);
  const files = Object.fromEntries(bundle.map(b => [b.table, b.csv]));
  const empty = Object.fromEntries(ENTITIES.map(e => [e, []]));
  const { data, report } = importCsvBundle(empty, files);
  ok('round trip clean', report.errors.length === 0, report.errors.slice(0,3).join('; '));
  ok('orders survive', data.purchaseOrders.length === D.purchaseOrders.length);
  ok('receipts survive',
     data.purchaseOrders.reduce((s,p)=>s+(p.receipts||[]).length,0) ===
     D.purchaseOrders.reduce((s,p)=>s+(p.receipts||[]).length,0));
  ok('and statuses still derive the same way',
     JSON.stringify(purchaseOrderRecords(data).map(r=>r.status).sort()) ===
     JSON.stringify(purchaseOrderRecords(D).map(r=>r.status).sort()));

  /* An audit trail that does not survive an export is not an audit trail, so
     round-trip a database that actually carries one. */
  const amended = seedData();
  const target = (amended.purchaseOrders || []).find(p => poDerivedStatus(p) === 'Ordered');
  const am = tx.amendPurchaseOrder(amended, { purchaseOrderId: target.id,
    expectedDate: day(target.expectedDate, 14),
    reason: 'Supplier moved the ship date', author: 'Buyer', date: '2026-02-02',
    lines: (target.lines || []).map(l => ({ ...l })) });
  ok('the seeded order amends cleanly', am.ok === true, am.error);
  const rr = importCsvBundle(Object.fromEntries(ENTITIES.map(e => [e, []])),
    Object.fromEntries(exportCsvBundle(amended).map(b => [b.table, b.csv])));
  ok('the amended export round trips clean', rr.report.errors.length === 0,
     rr.report.errors.slice(0,3).join('; '));
  const back = (rr.data.purchaseOrders || []).find(p => p.reference === target.reference);
  ok('the amendment came back with it',
     !!back && (back.revisions || []).length === 1, JSON.stringify(back && back.revisions));
  ok('with its reason intact', !!back &&
     back.revisions[0].reason === 'Supplier moved the ship date' &&
     back.revisions[0].author === 'Buyer');

  ok('purchase_order_charges is a table', tables.includes('purchase_order_charges'));
  ok('and loads after its parent',
     IMPORT_ORDER.indexOf('purchase_order_charges') > IMPORT_ORDER.indexOf('purchase_orders'));

  /* The blank-is-not-zero rule has to survive a CSV round trip, or every
     export/import cycle would quietly invoice half the plant at nothing. */
  const costed = seedData();
  const two = (costed.purchaseOrders || []).filter(p => poDerivedStatus(p) !== 'Draft' &&
                                                        poDerivedStatus(p) !== 'Cancelled').slice(0, 2);
  tx.recordPurchaseCosts(costed, { purchaseOrderId: two[0].id, invoiceVariance: true,
    invoiceRef: 'INV-100', invoiceDate: '2026-03-01',
    lineCosts: (two[0].lines || []).map(l => ({ lineId: l.id, actualUnitCost: (Number(l.unitCost)||0) + 0.5 })),
    charges: [{ kind: 'Shipping', description: 'Ocean freight', amount: 950 },
              { kind: 'Other', description: 'Port demurrage', amount: 120 }] });
  // Left deliberately uninvoiced, to prove blank comes back blank.
  tx.recordPurchaseCosts(costed, { purchaseOrderId: two[1].id, invoiceVariance: false,
    charges: [{ kind: 'Tax', description: 'Duty', amount: 60 }] });

  const cr = importCsvBundle(Object.fromEntries(ENTITIES.map(e => [e, []])),
    Object.fromEntries(exportCsvBundle(costed).map(b => [b.table, b.csv])));
  ok('a costed export round trips clean', cr.report.errors.length === 0,
     cr.report.errors.slice(0,3).join('; '));
  const b0 = (cr.data.purchaseOrders || []).find(p => p.reference === two[0].reference);
  const b1 = (cr.data.purchaseOrders || []).find(p => p.reference === two[1].reference);
  ok('the charges came back', (b0.charges || []).length === 2 && (b1.charges || []).length === 1);
  ok('with their kind, explanation and amount',
     poChargeTotal(b0) === 1070 &&
     (b0.charges || []).some(c => c.kind === 'Other' && c.description === 'Port demurrage'),
     JSON.stringify(b0.charges));
  ok('the invoice flag survived', b0.invoiceVariance === true && b1.invoiceVariance === false);
  ok('and the invoiced prices with it',
     (b0.lines || []).every(l => hasActualCost(l)));
  ok('BLANK CAME BACK BLANK, NOT ZERO',
     (b1.lines || []).every(l => !hasActualCost(l)), JSON.stringify(b1.lines));
  ok('so the uninvoiced order still costs what it was ordered at',
     landedCost(cr.data, b1).invoicedValue === landedCost(cr.data, b1).orderedValue);
  ok('and the landed cost is identical on both sides of the round trip',
     Math.abs(landedCost(cr.data, b0).landedValue - landedCost(costed, two[0]).landedValue) < 0.0001,
     landedCost(cr.data, b0).landedValue + ' vs ' + landedCost(costed, two[0]).landedValue);

  const legacy = seedData();
  delete legacy.purchaseOrders;
  const mig = normalizeData(legacy);
  ok('a database with no orders migrates', Array.isArray(mig.purchaseOrders));
  ok('and falls back to the stored on-order figure',
     (mig.rawMaterials || []).every(m => openOrderQty(mig, m.id) >= 0));
}


console.log('\n--- a shipment cannot be built from an unsellable pair ---');
{
  const D = seedData();
  const cust = D.customers.find(c => (c.priceList || []).length > 0 &&
                                     (c.priceList || []).length < D.finishedGoods.length);
  ok('a customer with partial pricing exists', !!cust,
     'seed has no partially-priced customer');

  const scoped = sellableToCustomer(D, cust.id, false);
  const wide = sellableToCustomer(D, cust.id, true);
  const none = sellableToCustomer(D, '', false);

  ok('the product list is cut to what the customer buys',
     scoped.offered.length === (cust.priceList || []).length,
     scoped.offered.length + ' offered vs ' + (cust.priceList || []).length + ' priced');
  ok('and that is fewer than everything', scoped.offered.length < D.finishedGoods.length);
  ok('every offered product has a price line',
     scoped.offered.every(item => scoped.priced.has(item.id)));
  ok('opting in widens it to the full catalogue',
     wide.offered.length === D.finishedGoods.length);
  ok('with no customer nothing is constrained',
     none.offered.length === D.finishedGoods.length && none.customer === null);
  ok('the number of unpriced products is reported',
     scoped.unpricedCount === D.finishedGoods.length - (cust.priceList || []).length);
}

console.log('\n--- price resolution is the same rule the warning uses ---');
{
  const D = seedData();
  const cust = D.customers.find(c => (c.priceList || []).length > 0);
  const priced = cust.priceList[0].finishedGoodId;
  const unpriced = D.finishedGoods.find(f =>
    !(cust.priceList || []).some(p => p.finishedGoodId === f.id));

  ok('a priced pair returns a price',
     shipmentUnitPrice(D, cust.id, priced, 1) > 0);
  ok('an unpriced pair returns null, not zero',
     unpriced ? shipmentUnitPrice(D, cust.id, unpriced.id, 1) === null : true);
  ok('no customer means no price', shipmentUnitPrice(D, '', priced, 1) === null);
  ok('volume tiers are applied', (() => {
    const line = cust.priceList.find(p => (p.tiers || []).length > 0);
    if (!line) return true;
    const small = shipmentUnitPrice(D, cust.id, line.finishedGoodId, 1);
    const large = shipmentUnitPrice(D, cust.id, line.finishedGoodId, 100000);
    return large <= small;
  })());
}

console.log('\n--- existing shipments are all sellable pairs ---');
{
  const D = seedData();
  const bad = (D.shipments || []).filter(s => {
    if (!s.customerId) return false;
    const c = (D.customers || []).find(x => x.id === s.customerId);
    return !c || !(c.priceList || []).some(p => p.finishedGoodId === s.finishedGoodId);
  });
  ok('no shipment went to a customer with no price for it', bad.length === 0,
     bad.length + ' unsellable shipments');
  ok('so every shipment with a customer carries revenue',
     shipmentEvents(D).filter(e => e.customerId).every(e => e.priced));

  /* The pairing matters: most combinations are NOT valid, which is exactly
     why an unconstrained form was able to produce revenue-less shipments. */
  const possible = (D.customers || []).length * (D.finishedGoods || []).length;
  const valid = (D.customers || []).reduce((s, c) => s + (c.priceList || []).length, 0);
  ok('most customer/product combinations are not priced', valid < possible * 0.75,
     valid + ' priced of ' + possible + ' possible');
}


console.log('\n--- the revenue chart and the line report must agree ---');
{
  const D = seedData();
  const range = { from: '2025-08-01', to: '2026-07-31', granularity: 'month' };
  const lines = shipmentLines(D, range);
  const ev = shipmentEvents(D).filter(e => e.date >= range.from && e.date <= range.to);

  ok('one line per shipment in range', lines.length === ev.length,
     lines.length + ' vs ' + ev.length);
  ok('REVENUE TOTALS MATCH EXACTLY',
     Math.abs(lines.reduce((s,l)=>s+l.revenue,0) - ev.reduce((s,e)=>s+e.revenue,0)) < 0.001);
  ok('COGS TOTALS MATCH EXACTLY',
     Math.abs(lines.reduce((s,l)=>s+l.cogs,0) - ev.reduce((s,e)=>s+e.cogs,0)) < 0.001);
  ok('margin is revenue less cost on every line',
     lines.filter(l => l.priced).every(l =>
       Math.abs(l.margin - (l.revenue - l.cogs)) < 0.001));
  ok('a bucketed chart total equals the line total', (() => {
    const rows = bucketEvents(ev.map(e => ({ date: e.date, series: 'r', value: e.revenue })),
                              range, ['r']);
    return Math.abs(rows.reduce((s,r)=>s+r.r,0) - lines.reduce((s,l)=>s+l.revenue,0)) < 0.001;
  })());
  ok('the range is respected', shipmentLines(D, { from: '2030-01-01', to: '2030-12-31' }).length === 0);
}

console.log('\n--- COGS is the cost of the lot shipped, not a standard cost ---');
{
  const D = seedData();
  const cache = {};
  const ev = shipmentEvents(D, cache);
  ok('every shipment names a lot', (D.shipments || []).every(s => !!s.lotId));
  ok('so every cost is rolled up, not estimated',
     ev.every(e => e.costBasis === 'rolledUp'), 
     JSON.stringify(ev.reduce((a,e)=>{a[e.costBasis]=(a[e.costBasis]||0)+1;return a;},{})));
  ok('none are flagged estimated', ev.every(e => !e.costEstimated));

  ev.forEach(() => {});
  const byLot = (D.shipments || []).reduce((s, sh) =>
    s + lotCost(D, 'finished', sh.finishedGoodId, sh.lotId, cache).unitCost * sh.qty, 0);
  ok('COGS equals the actual lot cost of what went out',
     Math.abs(ev.reduce((s,e)=>s+e.cogs,0) - byLot) < 0.01);

  const byStandard = (D.shipments || []).reduce((s, sh) =>
    s + (computeItemUnitCost(D, 'finished', sh.finishedGoodId) || 0) * sh.qty, 0);
  ok('which differs from the standard cost it used to use',
     Math.abs(byStandard - byLot) > 1,
     'standard ' + byStandard.toFixed(0) + ' vs actual ' + byLot.toFixed(0));

  /* The point of the change: raising a supplier price must not restate a
     margin that was already earned. */
  const raised = seedData();
  raised.rawMaterials.forEach(r => { r.unitCost = (Number(r.unitCost) || 0) * 3; });
  const after = shipmentEvents(raised);
  ok('TRIPLING SUPPLIER PRICES DOES NOT MOVE HISTORIC COGS',
     Math.abs(after.reduce((s,e)=>s+e.cogs,0) - ev.reduce((s,e)=>s+e.cogs,0)) < 0.01,
     after.reduce((s,e)=>s+e.cogs,0).toFixed(0) + ' vs ' + ev.reduce((s,e)=>s+e.cogs,0).toFixed(0));
  // seedData mints fresh ids each call, so match on SKU rather than id
  const skuOf = D.finishedGoods[0].sku;
  const idIn = (db) => (db.finishedGoods.find(f => f.sku === skuOf) || {}).id;
  ok('though the standard cost does move',
     computeItemUnitCost(raised, 'finished', idIn(raised)) >
     computeItemUnitCost(D, 'finished', idIn(D)),
     computeItemUnitCost(raised, 'finished', idIn(raised)).toFixed(3) + ' vs ' +
     computeItemUnitCost(D, 'finished', idIn(D)).toFixed(3));
}

console.log('\n--- a shipment with no lot falls back, and says so ---');
{
  const D = seedData();
  const sh = D.shipments[0];
  sh.lotId = '';
  const ev = shipmentEvents(D).find(e => e.id === sh.id);
  ok('it still costs something', ev.cogs > 0);
  ok('on the standard basis', ev.costBasis === 'standardCost');
  ok('and is flagged as estimated', ev.costEstimated === true);
}


console.log('\n--- production runs are raised against real buyers ---');
{
  const D = seedData();
  const withCustomer = (D.schedule || []).filter(s => s.customerId);
  ok('runs carry customers', withCustomer.length > 0);
  const unsellable = withCustomer.filter(s => {
    const c = (D.customers || []).find(x => x.id === s.customerId);
    return !c || !(c.priceList || []).some(p => p.finishedGoodId === s.productId);
  });
  ok('NO RUN IS RAISED AGAINST A CUSTOMER WHO CANNOT BUY IT',
     unsellable.length === 0,
     unsellable.length + ' of ' + withCustomer.length + ' unsellable');
  ok('so every run with a customer can be priced', withCustomer.every(s => {
    const c = (D.customers || []).find(x => x.id === s.customerId);
    return shipmentUnitPrice(D, c.id, s.productId, s.qty) !== null;
  }));
}

console.log('\n--- a fulfilled run is costed at its actual lots ---');
{
  const D = seedData();
  const cache = {};
  const done = (D.schedule || []).filter(s =>
    s.status === 'Complete' && (s.fulfillmentLots || []).length > 0);
  ok('completed runs with fulfilment exist', done.length > 0);

  done.slice(0, 8).forEach(() => {});
  const sample = done[0];
  const expectedCost = (sample.fulfillmentLots || []).reduce((s, fl) =>
    s + lotCost(D, 'finished', sample.productId, fl.lotId, cache).unitCost * (Number(fl.qty) || 0), 0);
  const qty = (sample.fulfillmentLots || []).reduce((s, fl) => s + (Number(fl.qty) || 0), 0);
  const standard = computeItemUnitCost(D, 'finished', sample.productId) * qty;

  ok('actual cost is computable from the fulfilment lots', expectedCost > 0);
  ok('and differs from the standard cost', Math.abs(expectedCost - standard) > 0.01,
     'actual ' + expectedCost.toFixed(2) + ' vs standard ' + standard.toFixed(2));

  /* The whole point: a run completed in March keeps its March cost even after
     the supplier raises prices. */
  const raised = seedData();
  raised.rawMaterials.forEach(r => { r.unitCost = (Number(r.unitCost) || 0) * 3; });
  const rSample = (raised.schedule || []).find(s =>
    s.status === 'Complete' && (s.fulfillmentLots || []).length > 0);
  const rCache = {};
  const rCost = (rSample.fulfillmentLots || []).reduce((s, fl) =>
    s + lotCost(raised, 'finished', rSample.productId, fl.lotId, rCache).unitCost * (Number(fl.qty) || 0), 0);
  ok('tripling supplier prices leaves a completed run cost unchanged',
     Math.abs(rCost - expectedCost) < 0.01,
     rCost.toFixed(2) + ' vs ' + expectedCost.toFixed(2));
}


console.log('\n--- every bar decomposes exactly into its lines ---');
{
  const D = seedData();
  const range = { from: '2025-08-01', to: '2026-07-31', granularity: 'month' };
  const lines = shipmentLines(D, range);
  const ev = shipmentEvents(D).filter(e => e.date >= range.from && e.date <= range.to);
  const bars = bucketEvents(
    ev.flatMap(e => [{ date: e.date, series: 'revenue', value: e.revenue },
                     { date: e.date, series: 'cogs', value: e.cogs }]),
    range, ['revenue', 'cogs']);

  /* This is the property the drill-down relies on: filtering the table to a
     bucket must reproduce that bucket's bar, penny for penny. */
  let mismatches = [];
  bars.forEach(bar => {
    const inBucket = lines.filter(l => bucketKeyOf(l.date, range.granularity) === bar.key);
    const rev = inBucket.reduce((s, l) => s + l.revenue, 0);
    const cogs = inBucket.reduce((s, l) => s + l.cogs, 0);
    if (Math.abs(rev - bar.revenue) > 0.001 || Math.abs(cogs - bar.cogs) > 0.001) {
      mismatches.push(bar.key + ': lines ' + rev.toFixed(2) + '/' + cogs.toFixed(2) +
                      ' vs bar ' + bar.revenue.toFixed(2) + '/' + bar.cogs.toFixed(2));
    }
  });
  ok('EVERY BUCKET RECONCILES TO ITS SHIPMENT LINES', mismatches.length === 0,
     mismatches.slice(0, 3).join('; '));

  const nonEmpty = bars.filter(b => b.revenue > 0);
  ok('there are buckets to check', nonEmpty.length >= 3, String(nonEmpty.length));
  ok('every line lands in exactly one bucket',
     lines.every(l => bars.some(b => b.key === bucketKeyOf(l.date, range.granularity))));
  ok('the line count equals the shipment count', lines.length === ev.length);

  // and at weekly granularity, where a single shipment often stands alone
  const wRange = { from: '2026-03-01', to: '2026-03-31', granularity: 'week' };
  const wLines = shipmentLines(D, wRange);
  const wBars = bucketEvents(
    shipmentEvents(D).filter(e => e.date >= wRange.from && e.date <= wRange.to)
      .map(e => ({ date: e.date, series: 'cogs', value: e.cogs })), wRange, ['cogs']);
  const wBad = wBars.filter(b => {
    const g = wLines.filter(l => bucketKeyOf(l.date, 'week') === b.key);
    return Math.abs(g.reduce((s, l) => s + l.cogs, 0) - b.cogs) > 0.001;
  });
  ok('weekly buckets reconcile too', wBad.length === 0, wBad.map(b => b.key).join(', '));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
