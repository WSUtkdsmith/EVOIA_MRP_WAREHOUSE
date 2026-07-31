import { ENTITIES, seedData, normalizeData, tx, repo, salesOrderRecords,
         salesOrderLineDetail, salesRepSummary, computeItemUnitCost,
         exportCsvBundle, importCsvBundle, allTables, csvColumns } from '/tmp/core.mjs';
let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+(x?'\n          '+String(x).slice(0,300):''));} };
const near=(a,b,t)=>Math.abs(a-b)<(t===undefined?0.01:t);

console.log('\n--- list price and concession stay separate ---');
{
  const D = seedData();
  const recs = salesOrderRecords(D);
  ok('orders exist', recs.length > 0, String(recs.length));
  ok('every order names a customer and a rep',
     recs.every(r => !!r.customerName && !!r.salesRep));
  ok('every line has a list price', recs.every(r => r.lines.every(l => l.listPrice > 0)));
  ok('net is list less the discount',
     recs.every(r => r.lines.every(l =>
       near(l.netPrice, l.listPrice * (1 - l.discountPct / 100)))));
  ok('order net equals the sum of its lines',
     recs.every(r => near(r.netValue, r.lines.reduce((s,l)=>s+(l.lineValue||0),0))));
  ok('gross less discount equals net',
     recs.every(r => near(r.grossValue - r.discountValue, r.netValue, 0.5)));
  ok('some lines carry a concession', recs.some(r => r.discountValue > 0));
  ok('a concession always has a reason recorded',
     recs.every(r => r.lines.every(l => l.discountPct === 0 || !!l.discountReason)));
  ok('below-cost lines are flagged', recs.some(r => r.anyBelowCost));
}

console.log('\n--- the three decisions ---');
{
  const D = seedData();
  const rec = salesOrderRecords(D).find(r => r.pending > 0);
  const line = rec.lines.find(l => l.decision === 'Pending');

  let out = tx.reviewSalesOrderLine(D, { salesOrderId: rec.order.id, lineId: line.line.id,
    decision: 'Accept' });
  ok('Yes is accepted', out.ok === true, out.error);
  let after = salesOrderRecords(D).find(r => r.order.id === rec.order.id)
    .lines.find(l => l.line.id === line.line.id);
  ok('approved quantity is what was asked for', after.approvedQty === after.qty);

  out = tx.reviewSalesOrderLine(D, { salesOrderId: rec.order.id, lineId: line.line.id,
    decision: 'Reject', note: 'No capacity' });
  ok('No is accepted', out.ok === true);
  after = salesOrderRecords(D).find(r => r.order.id === rec.order.id)
    .lines.find(l => l.line.id === line.line.id);
  ok('a rejected line approves nothing', after.approvedQty === 0);
  ok('and keeps the reason', after.line.reviewNote === 'No capacity');

  out = tx.reviewSalesOrderLine(D, { salesOrderId: rec.order.id, lineId: line.line.id,
    decision: 'Adjust', approvedQty: 500, approvedDate: '2026-09-15', note: 'Trimmed' });
  ok('Adjust is accepted', out.ok === true, out.error);
  after = salesOrderRecords(D).find(r => r.order.id === rec.order.id)
    .lines.find(l => l.line.id === line.line.id);
  ok('the adjusted quantity is stored', after.approvedQty === 500);
  ok('the adjusted date is stored', after.approvedDate === '2026-09-15');
  ok('the original request is NOT overwritten', after.qty === line.qty,
     after.qty + ' vs ' + line.qty);

  ok('an adjustment with no quantity is refused',
     tx.reviewSalesOrderLine(D, { salesOrderId: rec.order.id, lineId: line.line.id,
       decision: 'Adjust', approvedQty: 0 }).ok === false);
  ok('an unknown decision is refused',
     tx.reviewSalesOrderLine(D, { salesOrderId: rec.order.id, lineId: line.line.id,
       decision: 'Maybe' }).ok === false);
}

console.log('\n--- releasing raises a run for what was AGREED ---');
{
  const D = seedData();
  const rec = salesOrderRecords(D).find(r => r.pending > 0);
  const line = rec.lines.find(l => l.decision === 'Pending');
  const before = (D.schedule || []).length;

  tx.reviewSalesOrderLine(D, { salesOrderId: rec.order.id, lineId: line.line.id,
    decision: 'Adjust', approvedQty: 750, approvedDate: '2026-10-01' });
  const out = tx.releaseSalesOrderLine(D, { salesOrderId: rec.order.id, lineId: line.line.id });
  ok('release succeeds', out.ok === true, out.error);
  ok('a run was added', (D.schedule || []).length === before + 1);
  ok('at the ADJUSTED quantity, not what was asked for', out.run.qty === 750,
     out.run.qty + ' vs asked ' + line.qty);
  ok('and the adjusted date', out.run.dueDate === '2026-10-01');
  ok('carrying the customer', out.run.customerId === rec.order.customerId);
  ok('and naming the order it came from', /SO-/.test(out.run.notes));
  ok('the line records its run', out.line.scheduleId === out.run.id);

  ok('releasing twice is refused',
     tx.releaseSalesOrderLine(D, { salesOrderId: rec.order.id, lineId: line.line.id }).ok === false);
  ok('a released line cannot be re-reviewed',
     tx.reviewSalesOrderLine(D, { salesOrderId: rec.order.id, lineId: line.line.id,
       decision: 'Reject' }).ok === false);

  const pendingLine = salesOrderRecords(D).flatMap(r => r.lines)
    .find(l => l.decision === 'Pending' && !l.released);
  if (pendingLine) {
    ok('a pending line cannot be released',
       tx.releaseSalesOrderLine(D, { salesOrderId: pendingLine.order.id,
         lineId: pendingLine.line.id }).ok === false);
  } else ok('no pending line left to test', true);

  const rejected = salesOrderRecords(D).flatMap(r => r.lines).find(l => l.decision === 'Reject');
  if (rejected) {
    ok('a rejected line cannot be released',
       tx.releaseSalesOrderLine(D, { salesOrderId: rejected.order.id,
         lineId: rejected.line.id }).ok === false);
  } else ok('no rejected line to test', true);
}

console.log('\n--- released lines trace to real runs ---');
{
  const D = seedData();
  const released = salesOrderRecords(D).flatMap(r => r.lines).filter(l => l.released);
  ok('the seed has released lines', released.length > 0, String(released.length));
  ok('every one points at a run that exists',
     released.every(l => (D.schedule || []).some(s => s.id === l.scheduleId)));
  ok('the run is for the same product',
     released.every(l => {
       const run = (D.schedule || []).find(s => s.id === l.scheduleId);
       return run && run.productId === l.line.finishedGoodId;
     }));
  ok('and carries the approved quantity',
     released.every(l => {
       const run = (D.schedule || []).find(s => s.id === l.scheduleId);
       return run && near(run.qty, l.approvedQty);
     }));
}

console.log('\n--- rep summary ---');
{
  const D = seedData();
  const reps = salesRepSummary(D);
  ok('reps are summarised', reps.length > 0);
  ok('sorted by discount, worst first',
     reps.every((r,i) => i === 0 || reps[i-1].discountPct >= r.discountPct));
  ok('discount percentage is discount over list',
     reps.every(r => r.gross === 0 || near(r.discountPct, (r.discount / r.gross) * 100)));
  ok('totals tie back to the orders',
     near(reps.reduce((s,r)=>s+r.gross,0),
          salesOrderRecords(D).reduce((s,r)=>s+r.grossValue,0), 1));
}

console.log('\n--- schema, export and migration ---');
{
  const tables = allTables().map(t => t.table);
  ok('sales_orders is a table', tables.includes('sales_orders'));
  ok('sales_order_lines is a table', tables.includes('sales_order_lines'));
  const lt = allTables().find(t => t.table === 'sales_order_lines');
  ok('lines carry their order', csvColumns(lt)[0] === 'salesOrderId');
  ok('and a readable order reference', csvColumns(lt).includes('salesOrderRef'));
  ['listPrice','discountPct','reviewDecision','approvedQty','scheduleId'].forEach(c =>
    ok('lines export ' + c, csvColumns(lt).includes(c)));

  const D = seedData();
  const bundle = exportCsvBundle(D);
  const files = Object.fromEntries(bundle.map(b => [b.table, b.csv]));
  const empty = Object.fromEntries(ENTITIES.map(e => [e, []]));
  const { data, report } = importCsvBundle(empty, files);
  ok('round trip clean', report.errors.length === 0, report.errors.slice(0,3).join('; '));
  ok('orders survive', data.salesOrders.length === D.salesOrders.length);
  ok('lines survive',
     data.salesOrders.reduce((s,o)=>s+(o.lines||[]).length,0) ===
     D.salesOrders.reduce((s,o)=>s+(o.lines||[]).length,0));
  ok('decisions survive',
     JSON.stringify(salesOrderRecords(data).map(r=>r.pending).sort()) ===
     JSON.stringify(salesOrderRecords(D).map(r=>r.pending).sort()));
  ok('values survive',
     near(salesOrderRecords(data).reduce((s,r)=>s+r.netValue,0),
          salesOrderRecords(D).reduce((s,r)=>s+r.netValue,0), 1));

  const legacy = seedData();
  delete legacy.salesOrders;
  const mig = normalizeData(legacy);
  ok('a database with no sales orders migrates', Array.isArray(mig.salesOrders));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
