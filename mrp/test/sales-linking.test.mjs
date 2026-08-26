// Raising sales orders, linking them to production that already exists, and
// the shared sorting the lists are built on.
//
// Two gaps from review sit behind this. There was no way to create a sales
// order at all - the console could review and release the ones that arrived
// with the seed data and nothing else. And releasing a line always raised a
// NEW run, so an order that should have been filled by production already
// planned had no path but to raise a duplicate and delete one afterwards.

import { seedData, tx, repo, sortRows, filterRows, compareBy,
         plannedProductionSplit, ordersForRun, linkableRunsForLine,
         nextRunReference, nextSalesOrderReference, backfillRunReferences,
         runListRows, planScheduleFIFO, familiesOf,
         lineAllocations, lineRequiredQty, lineAllocatedQty, lineUnallocatedQty,
         lineIsReleased, lineRunIds, runCommittedQty, runCapacity, planRunLink,
         normalizeData } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

const plant = () => {
  const D = seedData();
  D.salesOrders = [];
  D.schedule = [];
  return { D, cust: D.customers[0], fg: D.finishedGoods[0], fg2: D.finishedGoods[1] };
};
const order = (D, cust, fg, over) => tx.raiseSalesOrder(D, {
  customerId: cust.id, salesRep: 'Rep', enteredBy: 'Clerk', submit: true,
  lines: [{ finishedGoodId: fg.id, qty: 100 }], ...over
});
const run = (D, fg, over) => repo.create(D, 'schedule', {
  reference: nextRunReference(D), productType: 'finished', productId: fg.id,
  qty: 500, dueDate: '2026-09-01', status: 'Planned', notes: '', customerId: '',
  completedDate: '', createdDate: '2026-08-01', frozen: false, frozenDate: '',
  baselineQty: '', baselineDueDate: '', standardCostAtFulfillment: '',
  fulfillmentLots: [], revisions: [], ...over
});

console.log('\n--- raising a sales order ---');
{
  const { D, cust, fg } = plant();
  const res = order(D, cust, fg);
  ok('an order can be raised', res.ok === true);
  ok('with a reference of its own', res.order.reference === 'SO-00001');
  ok('submitted goes straight to review', res.order.status === 'Submitted');
  ok('who keyed it in is recorded, separately from whose sale it is',
     res.order.enteredBy === 'Clerk' && res.order.salesRep === 'Rep');
  ok('and when', !!res.order.enteredAt);
  ok('its line starts undecided', res.order.lines[0].reviewDecision === 'Pending');
  ok('and unlinked to any run', res.order.lines[0].scheduleId === '');

  // The price list is what makes the concession measurable later: capturing
  // the list price on the line means the list can move without rewriting
  // history.
  const D2 = seedData(); D2.salesOrders = [];
  const fg2b = D2.finishedGoods[0];
  const priced = D2.customers.find(c => (c.priceList || []).some(p => p.finishedGoodId === fg2b.id));
  if (priced) {
    const r2 = order(D2, priced, fg2b);
    ok('the list price is taken from the customer price list', r2.order.lines[0].listPrice > 0);
  } else ok('no priced customer in the seed to check against', true);

  ok('a draft stays a draft', order(D, cust, fg, { submit: false }).order.status === 'Draft');
  ok('the next reference does not collide', nextSalesOrderReference(D) === 'SO-00003');

  ok('an order with no lines is refused',
     tx.raiseSalesOrder(D, { customerId: cust.id, lines: [] }).ok === false);
  ok('a zero-quantity line does not count as a line',
     tx.raiseSalesOrder(D, { customerId: cust.id, lines: [{ finishedGoodId: fg.id, qty: 0 }] }).ok === false);
  ok('an unknown customer is refused', tx.raiseSalesOrder(D, { customerId: 'nope',
     lines: [{ finishedGoodId: fg.id, qty: 1 }] }).ok === false);
  ok('a duplicate reference is refused',
     tx.raiseSalesOrder(D, { reference: 'SO-00001', customerId: cust.id,
       lines: [{ finishedGoodId: fg.id, qty: 1 }] }).ok === false);
}

console.log('\n--- linking a line to a run that already exists ---');
{
  const { D, cust, fg, fg2 } = plant();
  const o = order(D, cust, fg).order;
  const r = run(D, fg);

  ok('an undecided line cannot be linked',
     tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: o.lines[0].id, scheduleId: r.id }).ok === false);

  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id, decision: 'Accept' });
  const link = tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: o.lines[0].id, scheduleId: r.id });
  ok('an accepted line links to an existing run', link.ok === true);
  ok('and points at it', o.lines[0].scheduleId === r.id);
  ok('no second run was raised — that was the whole point', D.schedule.length === 1);
  ok('the order reads as released once every accepted line has a run', o.status === 'Released');
  ok('the run says which order it is filling', /SO-00001/.test(r.notes));
  ok('and picks up the customer if it had none', r.customerId === cust.id);

  ok('linking twice is refused',
     tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: o.lines[0].id, scheduleId: r.id }).ok === false);

  // The rule that matters: an order for one product filled by a run making
  // another is not a linkage, it is a mistake with a reference number.
  const { D: D2, cust: c2, fg: f2, fg2: g2 } = plant();
  const o2 = order(D2, c2, f2).order;
  tx.reviewSalesOrderLine(D2, { salesOrderId: o2.id, lineId: o2.lines[0].id, decision: 'Accept' });
  const wrong = run(D2, g2);
  const bad = tx.linkSalesOrderLineToRun(D2, { salesOrderId: o2.id, lineId: o2.lines[0].id, scheduleId: wrong.id });
  ok('a run making a different product is refused', bad.ok === false);
  ok('and says so plainly', /does not make the product/.test(bad.error));
  ok('the line is left alone', o2.lines[0].scheduleId === '');

  const cancelled = run(D2, f2, { status: 'Cancelled' });
  ok('a cancelled run cannot be linked',
     tx.linkSalesOrderLineToRun(D2, { salesOrderId: o2.id, lineId: o2.lines[0].id, scheduleId: cancelled.id }).ok === false);
  ok('an unknown run cannot be linked',
     tx.linkSalesOrderLineToRun(D2, { salesOrderId: o2.id, lineId: o2.lines[0].id, scheduleId: 'nope' }).ok === false);

  /* REVERSED on review. This used to allocate the whole line to a run too
     small to make it, on "shown, not blocked" grounds. That was wrong: the
     shortfall was invisible, so a run could be committed to more than it
     makes and nobody would find out until the goods failed to appear. A link
     now takes the run's balance and no more, and the caller is handed the
     remainder to do something about. */
  const small = run(D2, f2, { qty: 10 });
  const partial = tx.linkSalesOrderLineToRun(D2, {
    salesOrderId: o2.id, lineId: o2.lines[0].id, scheduleId: small.id });
  ok('a run too small still links', partial.ok === true);
  ok('but only for what it can actually make', partial.allocated === 10);
  ok('and the shortfall is handed back rather than swallowed', partial.remainder === 90);
  ok('the line is not counted as released', lineIsReleased(o2.lines[0]) === false);
  ok('nor the order', o2.status !== 'Released');
}

console.log('\n--- a run cannot be committed to more than it makes ---');
{
  // The rule: a run makes a finite quantity, several lines can draw on it, and
  // the allocations may not exceed it. Without a quantity on the link there
  // was nothing to add up, so nothing to enforce.
  const { D, cust, fg } = plant();
  const r = run(D, fg, { qty: 100 });

  const cap0 = runCapacity(D, r.id, null);
  ok('a fresh run is entirely available', cap0.planned === 100 && cap0.available === 100);
  ok('and nothing is committed', cap0.committed === 0);
  ok('nor over-committed', cap0.overCommitted === false);

  const a = order(D, cust, fg, { lines: [{ finishedGoodId: fg.id, qty: 60 }] }).order;
  tx.reviewSalesOrderLine(D, { salesOrderId: a.id, lineId: a.lines[0].id, decision: 'Accept' });
  const first = tx.linkSalesOrderLineToRun(D, { salesOrderId: a.id, lineId: a.lines[0].id, scheduleId: r.id });
  ok('the first line takes what it needs', first.allocated === 60);
  ok('with nothing left over', first.remainder === 0);
  ok('and is released in full', lineIsReleased(a.lines[0]) === true);
  ok('the run reports what is left', runCapacity(D, r.id, null).available === 40);

  const b = order(D, cust, fg, { lines: [{ finishedGoodId: fg.id, qty: 70 }] }).order;
  tx.reviewSalesOrderLine(D, { salesOrderId: b.id, lineId: b.lines[0].id, decision: 'Accept' });
  const second = tx.linkSalesOrderLineToRun(D, { salesOrderId: b.id, lineId: b.lines[0].id, scheduleId: r.id });
  ok('a second line gets only the balance', second.allocated === 40,
     'taking all 70 would commit the run to 130 of a 100 run');
  ok('and is told what is still uncovered', second.remainder === 30);
  ok('so it is not released', lineIsReleased(b.lines[0]) === false);
  ok('the run is now fully committed', runCapacity(D, r.id, null).available === 0);
  ok('and exactly, not over', runCapacity(D, r.id, null).committed === 100);
  ok('which is the invariant the whole change exists for',
     runCommittedQty(D, r.id) <= 100.0001);

  const c = order(D, cust, fg, { lines: [{ finishedGoodId: fg.id, qty: 10 }] }).order;
  tx.reviewSalesOrderLine(D, { salesOrderId: c.id, lineId: c.lines[0].id, decision: 'Accept' });
  const third = tx.linkSalesOrderLineToRun(D, { salesOrderId: c.id, lineId: c.lines[0].id, scheduleId: r.id });
  ok('a full run refuses a third line outright', third.ok === false);
  ok('and says why', /fully committed/.test(third.error));
}

// "Add remainder as a new run": release covers the balance only.
{
  const { D, cust, fg } = plant();
  const small = run(D, fg, { qty: 40 });
  const o = order(D, cust, fg, { lines: [{ finishedGoodId: fg.id, qty: 100 }] }).order;
  const line = o.lines[0];
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: line.id, decision: 'Accept' });
  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: line.id, scheduleId: small.id });
  ok('40 of 100 covered', lineAllocatedQty(line) === 40 && lineUnallocatedQty(line) === 60);

  const rel = tx.releaseSalesOrderLine(D, { salesOrderId: o.id, lineId: line.id });
  ok('releasing raises a run for the remainder', rel.ok === true);
  ok('for exactly the balance, not the whole line again', rel.run.qty === 60,
     'raising 100 again would double the plant\u2019s commitment');
  ok('the line is now covered in full', lineIsReleased(line) === true);
  ok('across two runs', lineRunIds(line).length === 2);
  ok('and the order reads as released', o.status === 'Released');

  ok('releasing again is refused — there is nothing left',
     tx.releaseSalesOrderLine(D, { salesOrderId: o.id, lineId: line.id }).ok === false);
  ok('and so is linking again',
     tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: line.id,
       scheduleId: run(D, fg).id }).ok === false);
}

// "Link additional runs": several runs, one line.
{
  const { D, cust, fg } = plant();
  const r1 = run(D, fg, { qty: 30 }), r2 = run(D, fg, { qty: 30 }), r3 = run(D, fg, { qty: 100 });
  const o = order(D, cust, fg, { lines: [{ finishedGoodId: fg.id, qty: 75 }] }).order;
  const line = o.lines[0];
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: line.id, decision: 'Accept' });

  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: line.id, scheduleId: r1.id });
  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: line.id, scheduleId: r2.id });
  ok('two runs cover 60 of 75', lineAllocatedQty(line) === 60);
  const last = tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: line.id, scheduleId: r3.id });
  ok('the third takes only the 15 still needed', last.allocated === 15,
     'a link is capped by what the LINE needs as well as by what the run has');
  ok('leaving the big run mostly free', runCapacity(D, r3.id, null).available === 85);
  ok('the line is covered', lineIsReleased(line) === true);
  ok('by three runs', lineRunIds(line).length === 3);

  ok('the same run cannot be linked twice',
     tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: line.id, scheduleId: r1.id }).ok === false);
}

// Unlinking gives the capacity back.
{
  const { D, cust, fg } = plant();
  const r1 = run(D, fg, { qty: 50 }), r2 = run(D, fg, { qty: 50 });
  const o = order(D, cust, fg, { lines: [{ finishedGoodId: fg.id, qty: 80 }] }).order;
  const line = o.lines[0];
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: line.id, decision: 'Accept' });
  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: line.id, scheduleId: r1.id });
  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: line.id, scheduleId: r2.id });
  ok('covered by two runs', lineIsReleased(line) === true);

  const un = tx.unlinkSalesOrderLine(D, { salesOrderId: o.id, lineId: line.id, scheduleId: r1.id });
  ok('one run can be unlinked by name', un.ok === true && un.removed === 1);
  ok('returning its capacity', runCapacity(D, r1.id, null).available === 50);
  ok('the other allocation survives', lineRunIds(line).length === 1);
  ok('and the line is short again', lineUnallocatedQty(line) === 50);
  ok('so the order is no longer released', o.status !== 'Released');

  ok('unlinking a run the line does not use is refused',
     tx.unlinkSalesOrderLine(D, { salesOrderId: o.id, lineId: line.id, scheduleId: r1.id }).ok === false);

  tx.unlinkSalesOrderLine(D, { salesOrderId: o.id, lineId: line.id });
  ok('unlinking with no run named removes them all', lineAllocations(line).length === 0);
  ok('and every run is free again',
     runCapacity(D, r2.id, null).available === 50);
}

// A cancelled order is not a commitment, so it must not hold capacity.
{
  const { D, cust, fg } = plant();
  const r = run(D, fg, { qty: 100 });
  const o = order(D, cust, fg, { lines: [{ finishedGoodId: fg.id, qty: 100 }] }).order;
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id, decision: 'Accept' });
  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: o.lines[0].id, scheduleId: r.id });
  ok('the run is fully committed', runCapacity(D, r.id, null).available === 0);
  o.status = 'Cancelled';
  ok('cancelling the order frees the capacity', runCapacity(D, r.id, null).available === 100,
     'otherwise a withdrawn order would keep the plant booked against nothing');
}

// An adjusted line is measured against what the plant agreed to, not what
// was asked for.
{
  const { D, cust, fg } = plant();
  const r = run(D, fg, { qty: 100 });
  const o = order(D, cust, fg, { lines: [{ finishedGoodId: fg.id, qty: 90 }] }).order;
  const line = o.lines[0];
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: line.id, decision: 'Adjust', approvedQty: 40 });
  ok('the line needs the approved quantity', lineRequiredQty(line) === 40);
  const res = tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: line.id, scheduleId: r.id });
  ok('and takes only that', res.allocated === 40);
  ok('leaving the rest of the run free', runCapacity(D, r.id, null).available === 60);
}

// Working out the link before writing it, for the prompt.
{
  const { D, cust, fg } = plant();
  const r = run(D, fg, { qty: 25 });
  const o = order(D, cust, fg, { lines: [{ finishedGoodId: fg.id, qty: 100 }] }).order;
  const line = o.lines[0];
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: line.id, decision: 'Accept' });

  const plan = planRunLink(D, line, r.id, null);
  ok('the plan says what would be taken', plan.qty === 25);
  ok('and what would be left over', plan.remainder === 75);
  ok('and that it is not a full cover', plan.full === false && plan.none === false);
  ok('nothing was written', lineAllocations(line).length === 0);

  const big = run(D, fg, { qty: 500 });
  const full = planRunLink(D, line, big.id, null);
  ok('a big enough run covers it', full.qty === 100 && full.remainder === 0 && full.full === true);
  ok('asking for less takes less', planRunLink(D, line, big.id, 30).qty === 30);
  ok('asking for more than the line needs is still capped',
     planRunLink(D, line, big.id, 9999).qty === 100);

  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: line.id, scheduleId: big.id });
  ok('once covered, a further link plans nothing', planRunLink(D, line, r.id, null).none === true);
}

// Data written before allocations existed.
{
  const { D, cust, fg } = plant();
  const r = run(D, fg, { qty: 100 });
  const o = order(D, cust, fg, { lines: [{ finishedGoodId: fg.id, qty: 60 }] }).order;
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id, decision: 'Accept' });
  // The old shape: a bare id, no quantity anywhere.
  o.lines[0].scheduleId = r.id;
  delete o.lines[0].runAllocations;

  const back = normalizeData(JSON.parse(JSON.stringify(D)));
  const migrated = back.salesOrders.find(x => x.reference === o.reference).lines[0];
  ok('a bare scheduleId becomes an allocation', lineAllocations(migrated).length === 1);
  ok('for what the line needs, which is what the old link meant',
     lineAllocatedQty(migrated) === 60);
  ok('so the line reads as released', lineIsReleased(migrated) === true);
  ok('and the run reports the commitment', runCommittedQty(back, r.id) === 60);

  // Migrating twice must not double the allocation.
  const twice = normalizeData(JSON.parse(JSON.stringify(back)));
  ok('normalising again changes nothing',
     lineAllocatedQty(twice.salesOrders.find(x => x.reference === o.reference).lines[0]) === 60);

  ok('every seeded released line carries an allocation',
     seedData().salesOrders.flatMap(x => x.lines).filter(l => l.scheduleId)
       .every(l => lineAllocations(l).length > 0));
}

// Robustness.
{
  ok('a line with nothing allocated needs everything',
     lineUnallocatedQty({ qty: 10, reviewDecision: 'Accept' }) === 10);
  ok('a null line needs nothing', lineRequiredQty(null) === 0);
  ok('and has no allocations', lineAllocations(null).length === 0);
  ok('an allocation with no run is ignored',
     lineAllocations({ runAllocations: [{ qty: 5 }] }).length === 0);
  ok('an unknown run has no capacity', runCapacity(seedData(), 'nope', null).planned === 0);
  ok('null data does not throw', runCommittedQty(null, 'x') === 0);
}

console.log('\n--- one run, several orders ---');
{
  const { D, cust, fg } = plant();
  const r = run(D, fg);
  const a = order(D, cust, fg).order, b = order(D, cust, fg).order;
  [a, b].forEach(o => {
    tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id, decision: 'Accept' });
    tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: o.lines[0].id, scheduleId: r.id });
  });
  const filling = ordersForRun(D, r.id);
  ok('one run can fill more than one order', filling.length === 2);
  ok('and names them both', filling.map(f => f.reference).sort().join(',') === 'SO-00001,SO-00002');
  // customerId would be a lie at this point, so the first one in stays rather
  // than the last one overwriting it.
  ok('the run does not pretend to belong to whichever order linked last',
     r.customerId === cust.id);
}

console.log('\n--- unlinking ---');
{
  const { D, cust, fg } = plant();
  const o = order(D, cust, fg).order;
  const r = run(D, fg);
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id, decision: 'Accept' });
  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: o.lines[0].id, scheduleId: r.id });

  const un = tx.unlinkSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id });
  ok('a line can be unlinked', un.ok === true && o.lines[0].scheduleId === '');
  ok('the order stops claiming to be released', o.status === 'Reviewed');
  // Only the link is undone. The plant may well have started the run, so
  // deleting it is a separate and deliberate act.
  ok('the run itself survives', D.schedule.length === 1);
  ok('unlinking nothing is refused',
     tx.unlinkSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id }).ok === false);

  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: o.lines[0].id, scheduleId: r.id });
  r.status = 'Complete';
  ok('a completed run cannot be unlinked — that would lose what filled the order',
     tx.unlinkSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id }).ok === false);
}

console.log('\n--- run numbers are stable ---');
{
  // A traveller printed last week has to keep pointing at the same job, so a
  // reference is assigned once and never recomputed from position.
  const rows = backfillRunReferences([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  ok('every run gets a number', rows.every(r => !!r.reference));
  ok('numbered in order', rows.map(r => r.reference).join(',') === 'RUN-00001,RUN-00002,RUN-00003');

  const again = backfillRunReferences(rows);
  ok('a second pass changes nothing', again.map(r => r.reference).join(',') === 'RUN-00001,RUN-00002,RUN-00003');

  // The failure this prevents: inserting a run must not renumber the others.
  const inserted = backfillRunReferences([{ id: 'z' }, ...rows]);
  ok('inserting a run leaves the existing numbers alone',
     inserted.filter(r => r.id !== 'z').map(r => r.reference).join(',') === 'RUN-00001,RUN-00002,RUN-00003');
  ok('and the newcomer takes a free number', inserted[0].reference === 'RUN-00004');

  ok('an existing reference is never overwritten',
     backfillRunReferences([{ id: 'a', reference: 'CUSTOM-1' }])[0].reference === 'CUSTOM-1');
  ok('and is not handed to anyone else',
     backfillRunReferences([{ id: 'a', reference: 'RUN-00001' }, { id: 'b' }])[1].reference === 'RUN-00002');
  ok('null tolerated', backfillRunReferences(null).length === 0);

  const D = seedData();
  ok('every seeded run comes out numbered', (D.schedule || []).every(r => !!r.reference));
  ok('and normalising does not renumber them', (() => {
    const before = D.schedule.map(r => r.reference).join(',');
    return normalizeData(JSON.parse(JSON.stringify(D))).schedule.map(r => r.reference).join(',') === before;
  })());
}

console.log('\n--- assigned versus unassigned production ---');
{
  const { D, cust, fg } = plant();
  const empty = plannedProductionSplit(D);
  ok('nothing scheduled is not "all spoken for"', empty.unassignedPct === null,
     'a 0% reading would say something different from "there is no plan"');

  const r1 = run(D, fg, { qty: 300 });
  run(D, fg, { qty: 700 });
  const before = plannedProductionSplit(D);
  ok('a run with no order behind it is unassigned', before.counts.unassigned === 2);
  ok('and its quantity counts', before.qty.unassigned === 1000);
  ok('with nothing ordered, all of it is unassigned', before.unassignedPct === 100);

  const o = order(D, cust, fg).order;
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id, decision: 'Accept' });
  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: o.lines[0].id, scheduleId: r1.id });
  const after = plannedProductionSplit(D);
  ok('linking moves a run across', after.counts.assigned === 1 && after.counts.unassigned === 1);
  ok('by quantity, not by count', after.qty.assigned === 300 && after.qty.unassigned === 700);
  ok('and the share is of output, not of runs', after.unassignedPct === 70);

  // The question is what is coming, not what already came.
  run(D, fg, { qty: 999, status: 'Complete' });
  run(D, fg, { qty: 999, status: 'Cancelled' });
  ok('completed and cancelled runs are out of the picture',
     plannedProductionSplit(D).qty.total === 1000);

  // A cancelled order is not a commitment, so what it linked reverts to
  // unassigned rather than staying quietly counted as sold.
  o.status = 'Cancelled';
  ok('a cancelled order stops assigning its run',
     plannedProductionSplit(D).counts.unassigned === 2);

  ok('null data does not throw', plannedProductionSplit(null).counts.total === 0);
}

console.log('\n--- what can be linked ---');
{
  const { D, cust, fg, fg2 } = plant();
  const open = run(D, fg);
  run(D, fg, { status: 'Complete' });
  run(D, fg, { status: 'Cancelled' });
  run(D, fg2);
  const offered = linkableRunsForLine(D, fg.id);
  ok('only open runs for the right product are offered', offered.length === 1);
  ok('and it is the open one', offered[0].id === open.id);

  const soon = run(D, fg, { dueDate: '2026-07-01' });
  ok('soonest due first — that is nearly always the one being looked for',
     linkableRunsForLine(D, fg.id)[0].id === soon.id);
  ok('an unknown product offers nothing', linkableRunsForLine(D, 'nope').length === 0);
}

console.log('\n--- the run list rows ---');
{
  const D = seedData();
  const plan = planScheduleFIFO(D);
  const rows = runListRows(D, plan);
  ok('one row per run', rows.length === (D.schedule || []).length);
  ok('each carries its run number', rows.every(r => typeof r.reference === 'string'));
  ok('and the product it makes', rows.every(r => !!r.productName));

  // Planned dates come from the capacity plan, not the run record: a run
  // stores when it is DUE, and when the work lands depends on the queue.
  const planned = rows.filter(r => r.plannedStart);
  ok('open runs pick up a planned start', planned.length > 0);
  ok('and a planned completion', planned.every(r => !!r.plannedEnd));
  ok('which is not before the start', planned.every(r => r.plannedEnd >= r.plannedStart));
  ok('and is genuinely different from the due date on at least some runs',
     planned.some(r => r.plannedEnd !== r.dueDate),
     'otherwise the plan would just be echoing the due date');

  // Back-filling a forward-looking plan for something already finished would
  // invent a schedule that never existed.
  const closed = rows.filter(r => r.status === 'Complete' || r.status === 'Cancelled');
  ok('closed runs have no planned dates', closed.every(r => !r.plannedStart && !r.plannedEnd));

  ok('finished-goods runs carry their product families',
     rows.some(r => r.familyIds.length > 0));
  ok('and the names are resolved for searching',
     rows.filter(r => r.familyIds.length).every(r => !!r.familyNames));
  // Family tags live on finished goods only.
  ok('an intermediate run has no families',
     rows.filter(r => r.entry.productType === 'intermediate').every(r => r.familyIds.length === 0));

  ok('no plan at all still produces rows', runListRows(D, null).length === rows.length);
  ok('with no planned dates', runListRows(D, null).every(r => !r.plannedStart));
  ok('null data does not throw', runListRows(null, plan).length === 0);
}

// A run can serve several sales orders, and those need not share a customer.
{
  const { D, cust, fg } = plant();
  const other = D.customers[1];
  const r = run(D, fg);
  ok('a run with no customer and no orders lists none',
     runListRows(D, null)[0].customerIds.length === 0);

  r.customerId = cust.id;
  ok('the run’s own customer counts', runListRows(D, null)[0].customerIds.indexOf(cust.id) !== -1);

  const o = tx.raiseSalesOrder(D, { customerId: other.id, submit: true,
    lines: [{ finishedGoodId: fg.id, qty: 10 }] }).order;
  tx.reviewSalesOrderLine(D, { salesOrderId: o.id, lineId: o.lines[0].id, decision: 'Accept' });
  tx.linkSalesOrderLineToRun(D, { salesOrderId: o.id, lineId: o.lines[0].id, scheduleId: r.id });

  const row = runListRows(D, null)[0];
  ok('a customer reached only through a linked order counts too',
     row.customerIds.indexOf(other.id) !== -1,
     'filtering on the run’s own customer alone would hide this run from them');
  ok('both customers are listed', row.customerIds.length === 2);
  ok('and named, so the row is searchable',
     row.customerName.includes(cust.name) && row.customerName.includes(other.name));

  // The same customer twice is still one customer.
  const o2 = tx.raiseSalesOrder(D, { customerId: other.id, submit: true,
    lines: [{ finishedGoodId: fg.id, qty: 5 }] }).order;
  tx.reviewSalesOrderLine(D, { salesOrderId: o2.id, lineId: o2.lines[0].id, decision: 'Accept' });
  tx.linkSalesOrderLineToRun(D, { salesOrderId: o2.id, lineId: o2.lines[0].id, scheduleId: r.id });
  ok('a customer on two orders is not listed twice',
     runListRows(D, null)[0].customerIds.length === 2);
}

console.log('\n--- sorting, shared by every list ---');
{
  const rows = [
    { name: 'beta', qty: 2, due: '2026-03-01' },
    { name: 'Alpha', qty: 10, due: '' },
    { name: 'gamma', qty: 1, due: '2026-01-01' }
  ];
  ok('text sorts case-insensitively — Alpha before beta, not after',
     sortRows(rows, { key: 'name', dir: 'asc' }, [{ key: 'name', kind: 'str' }])
       .map(r => r.name).join(',') === 'Alpha,beta,gamma');
  ok('numbers sort as numbers, not as text',
     sortRows(rows, { key: 'qty', dir: 'asc' }, [{ key: 'qty', kind: 'num' }])
       .map(r => r.qty).join(',') === '1,2,10');
  ok('descending reverses', sortRows(rows, { key: 'qty', dir: 'desc' }, [{ key: 'qty', kind: 'num' }])
       .map(r => r.qty).join(',') === '10,2,1');

  // A blank due date is not "the earliest". Sorting it to the top puts the
  // least informative rows where the eye lands first.
  ok('blanks sort last ascending',
     sortRows(rows, { key: 'due', dir: 'asc' }, [{ key: 'due', kind: 'str' }])
       .map(r => r.name).join(',') === 'gamma,beta,Alpha');
  ok('and last descending too — not flipped to the top',
     sortRows(rows, { key: 'due', dir: 'desc' }, [{ key: 'due', kind: 'str' }])
       .map(r => r.name).join(',') === 'beta,gamma,Alpha');

  // Equal rows must not swap between renders or the list flickers.
  const tied = [{ n: 'a', k: 1 }, { n: 'b', k: 1 }, { n: 'c', k: 1 }];
  ok('ties keep their original order', sortRows(tied, { key: 'k', dir: 'asc' }, [{ key: 'k', kind: 'num' }])
       .map(r => r.n).join(',') === 'a,b,c');
  ok('and still do descending', sortRows(tied, { key: 'k', dir: 'desc' }, [{ key: 'k', kind: 'num' }])
       .map(r => r.n).join(',') === 'a,b,c');

  ok('numeric-aware text sorts RUN-2 before RUN-10',
     sortRows([{ r: 'RUN-10' }, { r: 'RUN-2' }], { key: 'r', dir: 'asc' }, [{ key: 'r', kind: 'str' }])
       .map(x => x.r).join(',') === 'RUN-2,RUN-10');

  ok('no sort key leaves the order alone',
     sortRows(rows, { key: '', dir: 'asc' }, []).map(r => r.name).join(',') === 'beta,Alpha,gamma');
  ok('null rows tolerated', sortRows(null, { key: 'name', dir: 'asc' }, []).length === 0);
  ok('two blanks are equal', compareBy({ a: '' }, { a: '' }, 'a', 'asc', 'str') === 0);
}

console.log('\n--- filtering ---');
{
  const rows = [
    { name: 'Green coffee', sku: 'GC-1', lines: [{ p: 'Widget' }] },
    { name: 'Sugar', sku: 'SG-9', lines: [{ p: 'Gadget' }] }
  ];
  const fields = ['name', 'sku', r => r.lines.map(l => l.p).join(' ')];
  ok('matches on a plain field', filterRows(rows, 'sugar', fields).length === 1);
  ok('case-insensitively', filterRows(rows, 'GREEN', fields).length === 1);
  ok('on a partial word', filterRows(rows, 'off', fields).length === 1);
  ok('and through an accessor, so derived text is searchable too',
     filterRows(rows, 'gadget', fields)[0].name === 'Sugar');
  ok('an empty query is not a filter', filterRows(rows, '   ', fields).length === 2);
  ok('no match is empty, not everything', filterRows(rows, 'zzz', fields).length === 0);
  ok('null rows tolerated', filterRows(null, 'x', fields).length === 0);
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
