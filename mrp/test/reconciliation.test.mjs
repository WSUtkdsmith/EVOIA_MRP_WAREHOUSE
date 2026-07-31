import { ENTITIES, seedData, normalizeData, tx, repo,
         fulfilmentReconciliation, heldSummary, shipmentTrace,
         shippedFromLot, expectedUnitCost, computeItemUnitCost, lotCost,
         exportCsvBundle, importCsvBundle, allTables, csvColumns } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + String(x).slice(0,300) : '')); } };
const near = (a,b,t) => Math.abs(a-b) < (t===undefined?0.01:t);

console.log('\n--- shipped-from-lot ---');
{
  const D = seedData();
  const lotId = D.shipments[0].lotId;
  const manual = (D.shipments||[]).filter(s=>s.lotId===lotId).reduce((s,x)=>s+x.qty,0);
  ok('sums every despatch from that lot', shippedFromLot(D, lotId) === manual);
  ok('an unknown lot ships nothing', shippedFromLot(D, 'nope') === 0);
  ok('a blank lot ships nothing', shippedFromLot(D, '') === 0);
}

console.log('\n--- fulfilment reconciles against despatch ---');
{
  const D = seedData();
  const rows = fulfilmentReconciliation(D);
  ok('rows exist', rows.length > 0, String(rows.length));
  ok('only finished goods are reconciled',
     rows.every(r => r.entry.productType === 'finished'));
  ok('only completed runs appear', rows.every(r => r.entry.status === 'Complete'));
  ok('every row has fulfilment lots', rows.every(r => r.lots.length > 0));

  rows.forEach(() => {});
  ok('fulfilled quantity is the sum of its lots',
     rows.every(r => near(r.fulfilledQty, r.lots.reduce((s,l)=>s+l.fulfilledQty,0))));
  ok('shipped quantity is the sum of despatches from those lots',
     rows.every(r => near(r.shippedQty, r.lots.reduce((s,l)=>s+l.shippedQty,0))));
  ok('unshipped is fulfilled less shipped, never negative',
     rows.every(r => r.unshippedQty >= 0 &&
       near(r.unshippedQty, Math.max(0, r.fulfilledQty - r.shippedQty))));
  ok('status flags are mutually exclusive', rows.every(r =>
     [r.fullyShipped, r.partShipped, r.notShipped].filter(Boolean).length === 1 || r.overShipped));
}

console.log('\n--- expected cost is FIXED at fulfilment ---');
{
  const D = seedData();
  const rows = fulfilmentReconciliation(D);
  ok('every completed run has a fixed expected cost',
     rows.every(r => r.expectedIsFrozen), 
     rows.filter(r=>!r.expectedIsFrozen).length + ' unfrozen');
  ok('and it differs from actual, which is the point',
     rows.some(r => Math.abs(r.costVariance) > 1));

  /* The whole reason for freezing: a supplier price rise must not rewrite a
     variance that was already reported. */
  const raised = seedData();
  raised.rawMaterials.forEach(r => { r.unitCost = (Number(r.unitCost)||0) * 4; });
  const after = fulfilmentReconciliation(raised);
  const bySku = (rs) => Object.fromEntries(rs.map(r => [r.entry.id, r]));
  ok('expected cost is unchanged by a supplier increase',
     near(after.reduce((s,r)=>s+r.expectedCost,0), rows.reduce((s,r)=>s+r.expectedCost,0), 0.5),
     after.reduce((s,r)=>s+r.expectedCost,0).toFixed(0) + ' vs ' + rows.reduce((s,r)=>s+r.expectedCost,0).toFixed(0));
  ok('actual cost is unchanged too, since lots hold their own price',
     near(after.reduce((s,r)=>s+r.actualCost,0), rows.reduce((s,r)=>s+r.actualCost,0), 0.5));
  ok('so the reported variance is stable',
     near(after.reduce((s,r)=>s+r.costVariance,0), rows.reduce((s,r)=>s+r.costVariance,0), 0.5));

  // a run with no frozen figure falls back and says so
  const legacy = seedData();
  legacy.schedule.forEach(s => { s.standardCostAtFulfillment = ""; });
  const fb = fulfilmentReconciliation(legacy);
  ok('a run without the fixed figure falls back to standard',
     fb.every(r => !r.expectedIsFrozen));
  ok('and still produces a number', fb.every(r => r.expectedCost >= 0));
}

console.log('\n--- freezing happens on completion, once ---');
{
  const d = Object.fromEntries(ENTITIES.map(e => [e, []]));
  d.rawMaterials.push({ id:'RM1', name:'Bean', sku:'RM1', unitCost:10, unit:'kg',
    supplier:'', certStatus:'', leadTimeDays:0, moq:0, reorderPoint:0, onOrder:0,
    notes:'', composition:[], lots:[] });
  d.finishedGoods.push({ id:'FG1', name:'Jar', sku:'FG1', unit:'ea', notes:'',
    composition:[], autoComposition:false, hazardClass:'', lots:[] });
  d.processes.push({ id:'P1', name:'Pack', sku:'P1', notes:'', productionTimeHours:1,
    inputs:[{id:'i',itemType:'raw',itemId:'RM1',qty:10}], equipment:[],
    outputs:[{id:'o',itemType:'finished',itemId:'FG1',qtyPerBatch:100,costOverride:''}] });
  const before = computeItemUnitCost(d, 'finished', 'FG1');
  ok('a standard cost is computable', before > 0);

  d.schedule.push({ id:'S1', productType:'finished', productId:'FG1', qty:100,
    dueDate:'2026-01-01', status:'Complete', completedDate:'2026-01-01', notes:'',
    customerId:'', createdDate:'', frozen:false, frozenDate:'', baselineQty:'',
    baselineDueDate:'', standardCostAtFulfillment: before,
    fulfillmentLots:[], revisions:[] });

  d.rawMaterials[0].unitCost = 40;
  const nowStandard = computeItemUnitCost(d, 'finished', 'FG1');
  ok('the live standard moved', nowStandard > before);
  ok('but the frozen figure did not',
     expectedUnitCost(d, d.schedule[0]).unitCost === before);
  ok('and reports itself as frozen', expectedUnitCost(d, d.schedule[0]).frozen === true);
}

/* The summary block moved to held-stock.test.mjs when the panel became Held
   Finished Goods; heldSummary reports on held stock, not on reconciliation. */

console.log('\n--- shipment trace ---');
{
  const D = seedData();
  const sh = D.shipments[0];
  const t = shipmentTrace(D, sh.id);
  ok('trace resolves', !!t);
  ok('names the product and customer', !!t.productName && !!t.customerName);
  ok('carries the despatch paperwork',
     !!t.shipment.customerPO && !!t.shipment.bol && !!t.shipment.carrier);
  ok('resolves the lot that went out', !!t.lot && !!t.lot.lotNumber);
  ok('resolves the batch that made it', !!t.batch, 'no batch record found');
  ok('the batch names what it consumed', t.batch && t.batch.inputs.length > 0);
  ok('links to the run it fulfils', !!t.run);
  ok('reports actual cost from the lot', t.unitCost > 0 && t.costBasis === 'rolledUp');
  ok('reports expected cost from the frozen figure',
     t.expectedUnitCost > 0 && t.expectedIsFrozen === true);
  ok('computes a variance', t.costVariance !== null);
  ok('computes margin', t.margin !== null && near(t.margin, t.revenue - t.cogs));
  ok('reports how much of the lot has shipped in total', t.lotShippedTotal >= t.qty);
  ok('an unknown shipment traces to null', shipmentTrace(D, 'nope') === null);
}

console.log('\n--- schema, export and migration ---');
{
  const t = allTables().find(x => x.table === 'shipments');
  const cols = csvColumns(t);
  ['customerPO','bol','carrier','trackingRef','scheduleId'].forEach(c =>
    ok('shipments export ' + c, cols.includes(c)));
  const st = allTables().find(x => x.table === 'production_schedule');
  ok('schedule exports the frozen standard cost',
     csvColumns(st).includes('standardCostAtFulfillment'));

  const D = seedData();
  const bundle = exportCsvBundle(D);
  const files = Object.fromEntries(bundle.map(b => [b.table, b.csv]));
  const empty = Object.fromEntries(ENTITIES.map(e => [e, []]));
  const { data, report } = importCsvBundle(empty, files);
  ok('round trip clean', report.errors.length === 0, report.errors.slice(0,3).join('; '));
  ok('paperwork survives', data.shipments.every(s => !!s.bol && !!s.carrier));
  ok('frozen costs survive',
     fulfilmentReconciliation(data).every(r => r.expectedIsFrozen));
  ok('held cost is identical after a round trip',
     near(heldSummary(data).cogs, heldSummary(D).cogs, 0.5),
     heldSummary(data).cogs + ' vs ' + heldSummary(D).cogs);

  const legacy = seedData();
  legacy.shipments.forEach(s => {
    delete s.customerPO; delete s.bol; delete s.carrier; delete s.trackingRef; delete s.scheduleId;
  });
  const mig = normalizeData(legacy);
  ok('old shipments migrate', mig.shipments.every(s =>
     s.customerPO === '' || typeof s.customerPO === 'string'));
  ok('and still trace by lot even without the run link',
     !!shipmentTrace(mig, mig.shipments[0].id).run);
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
