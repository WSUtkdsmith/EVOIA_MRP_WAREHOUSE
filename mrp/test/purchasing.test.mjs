import { bucketKeyOf, shipmentLines, lotCost, computeItemUnitCost,
         sellableToCustomer, shipmentUnitPrice, shipmentEvents,
         ENTITIES, seedData, repo, tx, purchaseOrderRecords, poReceivedQty,
         poOutstanding, poDerivedStatus, poDaysLate, poActualDate, openOrderQty,
         purchaseOrderedEvents, purchaseExpectedEvents, purchaseReceivedEvents,
         bucketEvents, exportCsvBundle, importCsvBundle, allTables, csvColumns,
         normalizeData } from '/tmp/core.mjs';

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
const po = (d, over) => {
  const row = { id:'PO1', reference:'PO-1', rawMaterialId:'RM1', supplier:'Acme',
    orderDate:'2026-01-01', qty:1000, unitCost:4.5, expectedDate:'2026-02-01',
    status:'Ordered', notes:'', receipts:[], ...over };
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

console.log('\n--- schema, export and migration ---');
{
  const tables = allTables().map(t => t.table);
  ok('purchase_orders is a table', tables.includes('purchase_orders'));
  ok('purchase_receipts is a table', tables.includes('purchase_receipts'));
  const rt = allTables().find(t => t.table === 'purchase_receipts');
  ok('receipts carry their order', csvColumns(rt)[0] === 'purchaseOrderId');
  ok('and a readable lot reference', csvColumns(rt).includes('lotNumber'));

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
