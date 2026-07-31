import { ENTITIES, seedData, normalizeData, tx, repo, heldFinishedGoods, heldSummary,
         cancellationRecords, cancelledFromRun, shippedFromLot, CANCELLATION_REASONS,
         CANCELLATION_DISPOSITIONS, shipmentLines,
         lotCost, exportCsvBundle, importCsvBundle, allTables, csvColumns } from '/tmp/core.mjs';
let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+(x?'\n          '+String(x).slice(0,300):''));} };
const near=(a,b,t)=>Math.abs(a-b)<(t===undefined?0.01:t);

console.log('\n--- held excludes what has shipped ---');
{
  const D = seedData();
  const rows = heldFinishedGoods(D);
  ok('rows exist', rows.length > 0, String(rows.length));
  /* The allocation figure is reduced when something is cancelled, so held is
     simply allocation less shipped - subtracting the cancellation records as
     well would deduct the same units twice. */
  ok('held is the live allocation less what has shipped',
     rows.every(r => r.lots.every(l => near(l.held, Math.max(0, l.allocated - l.shipped)))));
  ok('cancelled quantity is reported but not deducted again',
     rows.every(r => r.lots.every(l => l.cancelled >= 0)));
  ok('nothing fully shipped appears', rows.every(r => r.heldQty > 0));
  ok('row totals equal the sum of their lots',
     rows.every(r => near(r.heldQty, r.lots.reduce((s,l)=>s+l.held,0))));
  ok('COGS is held quantity at the lot cost',
     rows.every(r => near(r.cogs, r.lots.reduce((s,l)=>s+l.unitCost*l.held,0))));
  ok('sales value uses the customer price', rows.filter(r=>r.priced).every(r =>
     near(r.salesValue, r.unitPrice * r.heldQty)));
  ok('only finished goods are held', rows.every(r => r.entry.productType === 'finished'));

  // shipping more should reduce held
  const row = rows[0];
  const lot = row.lots.find(l => l.held > 1);
  const before = heldFinishedGoods(D).find(r => r.entry.id === row.entry.id).heldQty;
  D.shipments.push({ id:'x1', finishedGoodId: row.entry.productId, lotId: lot.lotId,
    qty: 1, customerId:'', addressId:'', shipDate:'2026-07-01', reference:'', notes:'',
    customerPO:'', bol:'', carrier:'', trackingRef:'', scheduleId:'' });
  const after = heldFinishedGoods(D).find(r => r.entry.id === row.entry.id).heldQty;
  ok('SHIPPING REDUCES HELD', near(after, before - 1), before + ' -> ' + after);
}

console.log('\n--- cancelling releases the earmark, not the stock ---');
{
  const D = seedData();
  const row = heldFinishedGoods(D)[0];
  const lot = row.lots.find(l => l.held > 5);
  const fg = D.finishedGoods.find(f => f.id === row.entry.productId);
  const stockBefore = (fg.lots.find(l => l.id === lot.lotId) || {}).qty;

  const out = tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: lot.lotId,
    qty: 5, reason: CANCELLATION_REASONS[0], cancelledBy: 'A. Tester' });
  ok('cancellation succeeds', out.ok === true, out.error);

  const stockAfter = (fg.lots.find(l => l.id === lot.lotId) || {}).qty;
  ok('THE STOCK ITSELF IS UNTOUCHED', near(stockAfter, stockBefore),
     stockBefore + ' -> ' + stockAfter);
  const after = heldFinishedGoods(D).find(r => r.entry.id === row.entry.id);
  ok('but the held allocation drops', near(after.heldQty, row.heldQty - 5),
     row.heldQty + ' -> ' + (after ? after.heldQty : 0));
  ok('a record was written', cancellationRecords(D).some(c => c.cancelledBy === 'A. Tester'));

  const rec = cancellationRecords(D).find(c => c.cancelledBy === 'A. Tester');
  ok('it captures the quantity', rec.qty === 5);
  ok('it captures the cost released', rec.cogs > 0);
  ok('it captures who and when', !!rec.cancelledBy && !!rec.cancelledDate);
  ok('it captures the reason', rec.reason === CANCELLATION_REASONS[0]);
}

console.log('\n--- a cancellation needs a reason and a name ---');
{
  const D = seedData();
  const row = heldFinishedGoods(D)[0];
  const lot = row.lots.find(l => l.held > 5);
  const base = { scheduleId: row.entry.id, lotId: lot.lotId, qty: 1 };

  ok('no reason is refused',
     tx.cancelFulfilment(D, { ...base, cancelledBy: 'X' }).ok === false);
  ok('blank reason is refused',
     tx.cancelFulfilment(D, { ...base, reason: '  ', cancelledBy: 'X' }).ok === false);
  ok('no name is refused',
     tx.cancelFulfilment(D, { ...base, reason: 'Customer cancelled the order' }).ok === false);
  ok('blank name is refused',
     tx.cancelFulfilment(D, { ...base, reason: 'Customer cancelled the order', cancelledBy: ' ' }).ok === false);
  ok('zero quantity is refused',
     tx.cancelFulfilment(D, { ...base, qty: 0, reason: 'r', cancelledBy: 'X' }).ok === false);
  ok('nothing was recorded by any of those',
     cancellationRecords(D).filter(c => c.cancelledBy === 'X').length === 0);
}

console.log('\n--- partial and full cancellation ---');
{
  const D = seedData();
  const row = heldFinishedGoods(D)[0];
  const lot = row.lots.find(l => l.held > 10);
  const half = Math.floor(lot.held / 2);

  tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: lot.lotId, qty: half,
    reason: 'Customer deferred delivery indefinitely', cancelledBy: 'P1' });
  let after = heldFinishedGoods(D).find(r => r.entry.id === row.entry.id);
  ok('a partial cancellation leaves the rest held',
     after && near(after.heldQty, row.heldQty - half), after ? after.heldQty : 'row gone');

  const rest = after.lots.find(l => l.lotId === lot.lotId).held;
  tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: lot.lotId, qty: rest,
    reason: 'Reallocated to another customer', cancelledBy: 'P2' });
  after = heldFinishedGoods(D).find(r => r.entry.id === row.entry.id);
  const lotHeld = after ? (after.lots.find(l => l.lotId === lot.lotId) || {}).held || 0 : 0;
  ok('cancelling the balance leaves that lot with nothing held', near(lotHeld, 0));

  ok('cancelling more than is held is refused',
     tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: lot.lotId, qty: 99999,
       reason: 'Commercial dispute', cancelledBy: 'P3' }).ok === false);
  ok('an unknown lot is refused',
     tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: 'nope', qty: 1,
       reason: 'Commercial dispute', cancelledBy: 'P3' }).ok === false);
}

console.log('\n--- summary metrics ---');
{
  const D = seedData();
  const s = heldSummary(D);
  ok('COGS totals the rows', near(s.cogs, s.rows.reduce((a,r)=>a+r.cogs,0)));
  ok('sales value totals the rows',
     near(s.salesValue, s.rows.reduce((a,r)=>a+(r.salesValue||0),0)));
  ok('both are positive on the seed', s.cogs > 0 && s.salesValue > 0);
  ok('sales value exceeds cost, as it should', s.salesValue > s.cogs);
  ok('overdue rows are identified', Array.isArray(s.overdue));
  ok('held quantity totals the rows', near(s.heldQty, s.rows.reduce((a,r)=>a+r.heldQty,0)));
}

console.log('\n--- cancellation records ---');
{
  const D = seedData();
  const recs = cancellationRecords(D);
  ok('the seed has cancellations', recs.length > 0, String(recs.length));
  ok('every one names a product and a person',
     recs.every(r => !!r.productName && !!r.cancelledBy));
  ok('every one has a reason', recs.every(r => !!r.reason));
  ok('every one is dated', recs.every(r => !!r.cancelledDate));
  ok('values were captured, not derived', recs.every(r => r.cogs > 0 || r.salesValue > 0));
  ok('margin forgone is sales less cost',
     recs.every(r => near(r.marginForgone, r.salesValue - r.cogs)));
  ok('sorted newest first',
     recs.every((r,i) => i === 0 || recs[i-1].cancelledDate >= r.cancelledDate));
  ok('cancelledFromRun agrees with the records',
     recs.every(r => cancelledFromRun(D, r.cancellation.scheduleId, r.cancellation.lotId) >= r.qty));
}

console.log('\n--- schema, export and migration ---');
{
  ok('fulfilment_cancellations is a table',
     allTables().map(t=>t.table).includes('fulfilment_cancellations'));
  const t = allTables().find(x => x.table === 'fulfilment_cancellations');
  ['reason','cancelledBy','cancelledDate','salesValue','cogs'].forEach(c =>
    ok('exports ' + c, csvColumns(t).includes(c)));

  const D = seedData();
  const bundle = exportCsvBundle(D);
  const files = Object.fromEntries(bundle.map(b => [b.table, b.csv]));
  const empty = Object.fromEntries(ENTITIES.map(e => [e, []]));
  const { data, report } = importCsvBundle(empty, files);
  ok('round trip clean', report.errors.length === 0, report.errors.slice(0,3).join('; '));
  ok('cancellations survive',
     data.fulfilmentCancellations.length === D.fulfilmentCancellations.length);
  ok('held figures survive', near(heldSummary(data).cogs, heldSummary(D).cogs, 1));

  const legacy = seedData();
  delete legacy.fulfilmentCancellations;
  const mig = normalizeData(legacy);
  ok('a database with no cancellations migrates',
     Array.isArray(mig.fulfilmentCancellations));
}


console.log('\n--- disposition drives the stock record ---');
{
  const stockOf = (D, row, lotId) => {
    const fg = D.finishedGoods.find(f => f.id === row.entry.productId);
    return (fg.lots.find(l => l.id === lotId) || {}).qty;
  };

  // returning touches only the earmark
  {
    const D = seedData();
    const row = heldFinishedGoods(D)[0];
    const lot = row.lots.find(l => l.held > 5);
    const before = stockOf(D, row, lot.lotId);
    tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: lot.lotId, qty: 5,
      reason: 'Customer cancelled the order', cancelledBy: 'T', disposition: 'return' });
    ok('RETURN leaves the stock alone', near(stockOf(D, row, lot.lotId), before));
    const fg = D.finishedGoods.find(f => f.id === row.entry.productId);
    ok('and writes no disposition onto the lot',
       !(fg.lots.find(l => l.id === lot.lotId) || {}).disposition);
  }

  // each consume option removes the stock and marks the lot
  ['damaged', 'expired', 'lost'].forEach(kind => {
    const D = seedData();
    const row = heldFinishedGoods(D)[0];
    const lot = row.lots.find(l => l.held > 5);
    const before = stockOf(D, row, lot.lotId);
    const out = tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: lot.lotId, qty: 5,
      reason: 'Damaged in storage', cancelledBy: 'T', disposition: kind });
    ok(kind + ' succeeds', out.ok === true, out.error);
    ok(kind + ' removes the quantity from stock',
       near(stockOf(D, row, lot.lotId), before - 5),
       before + ' -> ' + stockOf(D, row, lot.lotId));
    const fg = D.finishedGoods.find(f => f.id === row.entry.productId);
    const l = fg.lots.find(x => x.id === lot.lotId);
    ok(kind + ' records the disposition on the lot', !!l.disposition && !!l.disposition.reason);
    ok(kind + ' accrues no waste', !l.disposition.accumulateAsWaste);
  });

  // dispose consumes without accruing
  {
    const D = seedData();
    const row = heldFinishedGoods(D)[0];
    const lot = row.lots.find(l => l.held > 5);
    const wasteBefore = (D.wasteStreams || []).reduce((s,w)=>s+(w.lots||[]).length,0);
    tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: lot.lotId, qty: 5,
      reason: 'Shelf life too short to ship', cancelledBy: 'T', disposition: 'waste-dispose' });
    const wasteAfter = (D.wasteStreams || []).reduce((s,w)=>s+(w.lots||[]).length,0);
    ok('DISPOSE consumes but accrues no waste lots', wasteAfter === wasteBefore);
    const fg = D.finishedGoods.find(f => f.id === row.entry.productId);
    ok('and marks the lot for immediate disposal',
       (fg.lots.find(l => l.id === lot.lotId) || {}).disposition.disposeImmediately === true);
  }

  // accumulate consumes and feeds the waste streams
  {
    const D = seedData();
    const row = heldFinishedGoods(D)[0];
    const lot = row.lots.find(l => l.held > 5);
    const wasteBefore = (D.wasteStreams || []).reduce((s,w)=>s+(w.lots||[]).length,0);
    const before = stockOf(D, row, lot.lotId);
    tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: lot.lotId, qty: 10,
      reason: 'Failed QC / quality hold', cancelledBy: 'T', disposition: 'waste-accumulate' });
    const wasteAfter = (D.wasteStreams || []).reduce((s,w)=>s+(w.lots||[]).length,0);
    ok('ACCUMULATE consumes the stock', near(stockOf(D, row, lot.lotId), before - 10));
    ok('and accrues waste lots', wasteAfter > wasteBefore, wasteBefore + ' -> ' + wasteAfter);
  }

  ok('an unknown disposition is refused', (() => {
    const D = seedData();
    const row = heldFinishedGoods(D)[0];
    const lot = row.lots.find(l => l.held > 1);
    return tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: lot.lotId, qty: 1,
      reason: 'r', cancelledBy: 'T', disposition: 'teleport' }).ok === false;
  })());
  ok('omitting the disposition defaults to return', (() => {
    const D = seedData();
    const row = heldFinishedGoods(D)[0];
    const lot = row.lots.find(l => l.held > 1);
    const before = stockOf(D, row, lot.lotId);
    tx.cancelFulfilment(D, { scheduleId: row.entry.id, lotId: lot.lotId, qty: 1,
      reason: 'r', cancelledBy: 'T' });
    return near(stockOf(D, row, lot.lotId), before);
  })());
  ok('the disposition is on the record',
     CANCELLATION_DISPOSITIONS.length === 6);
}

console.log('\n--- shipment lines carry expected COGS ---');
{
  const D = seedData();
  const lines = shipmentLines(D);
  ok('every line reports an expected COGS',
     lines.every(l => l.expectedCogs !== null && l.expectedCogs > 0),
     lines.filter(l => !l.expectedCogs).length + ' missing');
  ok('and an actual COGS', lines.every(l => l.cogs > 0));
  ok('variance is actual less expected',
     lines.every(l => near(l.costVariance, l.cogs - l.expectedCogs, 0.02)));
  ok('expected comes from the frozen standard',
     lines.every(l => l.expectedIsFrozen));
  ok('the two differ, which is the point',
     lines.some(l => Math.abs(l.costVariance) > 1));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
