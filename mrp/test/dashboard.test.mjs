// Dashboard measures: shipment adherence, per-material flow, and stock
// valuation with its written-down history.
//
// Three things behind this, all of them about a number that looked informative
// and was not:
//
//   - Completion against due date measured RUNS. A run can finish on time and
//     the goods still reach the customer late, and it is the second one the
//     customer experiences.
//   - The raw material flow chart added kilogrammes of green coffee to metres
//     of sachet film to litres of nitrogen. The bar had no unit, so it had no
//     meaning.
//   - There was no valuation at all, and no way to ask what stock was worth
//     last month — a figure recomputed today can only answer "now".

import { seedData, tx, repo, shipmentAdherenceEvents, inventoryValuation,
         receiptEvents, consumptionEvents, normalizeData } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

console.log('\n--- shipments against the date promised to the customer ---');
{
  const D = seedData();
  const ev = shipmentAdherenceEvents(D);
  ok('every shipment is judged', ev.length === (D.shipments || []).length);
  ok('each carries the date it was measured against', ev.every(e => !e.measurable || !!e.promisedDate));
  ok('and says where that date came from', ev.every(e => !e.measurable || !!e.promisedBasis));
  ok('on-time and late are decided by the ship date',
     ev.filter(e => e.measurable).every(e => e.late === (e.date > e.promisedDate)));
  ok('and lateness is measured in days', ev.filter(e => e.late).every(e => e.daysLate > 0));
  ok('an on-time shipment is not reported as late',
     ev.filter(e => e.measurable && !e.late).every(e => (e.daysLate || 0) <= 0));
}

// The promised date is looked for in the order it carries weight: what the
// plant committed to, then what the customer asked for, then the run.
{
  const D = seedData();
  D.salesOrders = []; D.shipments = []; D.schedule = [];
  const cust = D.customers[0], fg = D.finishedGoods[0];
  const run = repo.create(D, 'schedule', {
    reference: 'RUN-00001', productType: 'finished', productId: fg.id, qty: 100,
    dueDate: '2026-06-20', status: 'Complete', notes: '', customerId: '',
    completedDate: '2026-06-18', createdDate: '2026-06-01',
    frozen: true, frozenDate: '2026-06-01', baselineQty: 100, baselineDueDate: '2026-06-15',
    standardCostAtFulfillment: '', fulfillmentLots: [], revisions: []
  });
  const ship = { id: 'sh1', finishedGoodId: fg.id, lotId: '', qty: 5, customerId: cust.id,
                 addressId: '', shipDate: '2026-06-18', scheduleId: run.id, reference: '' };
  D.shipments.push(ship);

  const runOnly = shipmentAdherenceEvents(D)[0];
  ok('with no sales order, the run’s frozen baseline is used',
     runOnly.promisedBasis === 'runBaseline' && runOnly.promisedDate === '2026-06-15');
  ok('and shipping after it is late', runOnly.late === true && runOnly.daysLate === 3);

  const o = tx.raiseSalesOrder(D, { customerId: cust.id, submit: true, requestedDate: '2026-06-25',
    lines: [{ finishedGoodId: fg.id, qty: 100 }] }).order;
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id, decision: 'Accept' });
  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: o.lines[0].id, scheduleId: run.id });

  // Accepting a line IS the commitment, so reviewing stamps approvedDate and
  // the basis goes straight to "committed" carrying the requested date.
  const viaOrder = shipmentAdherenceEvents(D)[0];
  ok('once an order is attached, its date wins over the run’s',
     viaOrder.promisedDate === '2026-06-25');
  ok('and the same shipment is now on time', viaOrder.late === false);

  // What the plant committed to and what the customer asked for can differ,
  // and the commitment is the one adherence is judged against.
  o.lines[0].approvedDate = '2026-06-16';
  o.lines[0].requestedDate = '2026-06-30';
  const committed = shipmentAdherenceEvents(D)[0];
  ok('what the plant COMMITTED to outranks what was asked for',
     committed.promisedBasis === 'committed' && committed.promisedDate === '2026-06-16');
  ok('which makes it late again', committed.late === true);

  o.lines[0].approvedDate = '';
  const requested = shipmentAdherenceEvents(D)[0];
  ok('with no commitment, the customer’s requested date is used',
     requested.promisedBasis === 'requested' && requested.promisedDate === '2026-06-30');

  // An unfrozen due date may have been moved to match what happened, so it is
  // the last resort rather than the first.
  const D2 = seedData();
  D2.salesOrders = []; D2.shipments = [];
  D2.schedule = [{ ...run, id: 'r2', frozen: false, baselineDueDate: '' }];
  D2.shipments.push({ ...ship, scheduleId: 'r2' });
  ok('an unfrozen run falls back to its current due date, and says so',
     shipmentAdherenceEvents(D2)[0].promisedBasis === 'runDueDate');

  // Guessing a date and calling the result on-time would be worse than
  // admitting the shipment cannot be judged.
  const D3 = seedData();
  D3.salesOrders = []; D3.schedule = [];
  D3.shipments = [{ ...ship, scheduleId: '' }];
  const orphan = shipmentAdherenceEvents(D3)[0];
  ok('a shipment with no traceable promise is not scored', orphan.measurable === false);
  ok('nor silently counted as on time', orphan.series === 'unmeasured' && orphan.late === false);
  ok('and its lateness is unknown rather than zero', orphan.daysLate === null);

  // A cancelled order is not a commitment.
  const D4 = seedData();
  D4.shipments = [{ ...ship, scheduleId: run.id }];
  D4.schedule = [run];
  D4.salesOrders = [{ ...o, status: 'Cancelled' }];
  ok('a cancelled order does not supply a promised date',
     shipmentAdherenceEvents(D4)[0].promisedBasis === 'runBaseline');

  ok('no shipments is no events', shipmentAdherenceEvents({ }).length === 0);
  ok('a shipment with no date is skipped',
     shipmentAdherenceEvents({ shipments: [{ id: 'x' }] }).length === 0);
}

console.log('\n--- raw material flow, one material at a time ---');
{
  // Consumption events had no itemId, so the only possible view was every raw
  // material added together — which mixes units and means nothing.
  const D = seedData();
  const consumed = consumptionEvents(D).filter(e => e.series === 'raw');
  ok('consumption events exist', consumed.length > 0);
  ok('and every one names the material it drew', consumed.every(e => !!e.itemId));

  const raw = D.rawMaterials[0];
  const mine = consumed.filter(e => e.itemId === raw.id);
  ok('so consumption can be narrowed to one material', mine.length > 0);
  ok('and narrowing actually excludes the others', mine.length < consumed.length);

  const received = receiptEvents(D);
  ok('receipts already carried the material', received.every(e => !!e.itemId));
  ok('so both halves of the chart can be scoped together',
     received.filter(e => e.itemId === raw.id).length > 0);

  // The reason it mattered: the seed genuinely mixes units of measure.
  const units = new Set((D.rawMaterials || []).map(r => r.unit).filter(Boolean));
  ok('the raw materials really do span several units of measure', units.size > 1,
     'units present: ' + [...units].join(', '));
}

console.log('\n--- what the stock is worth ---');
{
  const D = seedData();
  const v = inventoryValuation(D);
  ok('raw material on hand is valued', v.byKey.raw.value > 0);
  ok('intermediate products too', v.byKey.intermediate.value > 0);
  ok('and finished goods', v.byKey.finished.value > 0);
  ok('the total is those three',
     Math.abs(v.total - (v.byKey.raw.value + v.byKey.intermediate.value + v.byKey.finished.value)) < 0.02);
  // A heap of spent grounds is not working capital in the way the others are.
  ok('waste is valued but kept out of the total', !!v.byKey.waste && v.total ===
     Math.round((v.byKey.raw.value + v.byKey.intermediate.value + v.byKey.finished.value) * 100) / 100);

  ok('each category lists its items', v.byKey.raw.items.length > 0);
  ok('worth first, since that is what the reader is looking for',
     v.byKey.raw.items.every((r, i, a) => i === 0 || a[i - 1].value >= r.value));
  ok('items with no stock are left out by default', v.byKey.raw.items.every(r => r.lots > 0));
  ok('unless asked for', inventoryValuation(D, { includeEmpty: true }).byKey.raw.items.length >=
     v.byKey.raw.items.length);

  // A valuation gets acted on, so how soft it is has to travel with it.
  ok('the number of lots behind the figure is reported', v.totalLots > 0);
  ok('and how many rested on standard cost', typeof v.estimatedLots === 'number');

  const empty = inventoryValuation({});
  ok('empty data values at nothing rather than throwing', empty.total === 0);
  ok('null data too', inventoryValuation(null).total === 0);
}

console.log('\n--- the history is written down, never rebuilt ---');
{
  const D = seedData();
  ok('nothing is recorded to begin with', (D.inventorySnapshots || []).length === 0);

  const first = tx.captureInventorySnapshot(D, { date: '2026-08-26', source: 'cron' });
  ok('a snapshot can be taken', first.ok === true);
  ok('it is not a replacement', first.replaced === false);
  ok('and records the total', first.snapshot.totalValue > 0);
  ok('split by category',
     first.snapshot.rawValue > 0 && first.snapshot.intermediateValue > 0 && first.snapshot.finishedValue > 0);
  ok('saying where it came from', first.snapshot.source === 'cron');
  ok('and when it was taken', !!first.snapshot.capturedAt);

  // A cron retry, an overlapping run, or the dashboard button after the job
  // has fired must not double-count a day.
  const again = tx.captureInventorySnapshot(D, { date: '2026-08-26', source: 'manual' });
  ok('capturing the same day again replaces', again.replaced === true);
  ok('leaving one row for that day', D.inventorySnapshots.length === 1);
  ok('carrying the newer source', D.inventorySnapshots[0].source === 'manual');

  tx.captureInventorySnapshot(D, { date: '2026-08-27' });
  ok('a different day appends', D.inventorySnapshots.length === 2);

  ok('a snapshot needs a real date',
     tx.captureInventorySnapshot(D, { date: 'whenever' }).ok === false);
  ok('and defaults to today when none is given',
     tx.captureInventorySnapshot(D, {}).ok === true);

  // The point of writing it down: the recomputed figure moves, the record
  // does not.
  const recorded = D.inventorySnapshots.find(s => s.date === '2026-08-26').totalValue;
  D.rawMaterials[0].lots.forEach(l => { l.qty = 0; });
  ok('draining the stock changes what it is worth now', inventoryValuation(D).total < recorded);
  ok('but the recorded figure is unmoved — that is the whole point',
     D.inventorySnapshots.find(s => s.date === '2026-08-26').totalValue === recorded);

  const back = normalizeData(JSON.parse(JSON.stringify(D)));
  ok('snapshots survive a round trip',
     (back.inventorySnapshots || []).length === D.inventorySnapshots.length);
  ok('with their values intact',
     back.inventorySnapshots.find(s => s.date === '2026-08-26').totalValue === recorded);
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
