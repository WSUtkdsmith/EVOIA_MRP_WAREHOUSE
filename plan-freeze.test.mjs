import { SCHEMA, ENTITIES, seedData, normalizeData, repo, tx,
         planVsActualEvents, fulfilledQtyOf, targetForBucket, withTargets,
         bucketEvents, productionEvents, exportCsvBundle, importCsvBundle,
         allTables, csvColumns } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + String(x).slice(0, 400) : '')); } };

const run = (over) => ({
  id: 'r1', productType: 'finished', productId: 'FG1', qty: 100,
  dueDate: '2026-08-20', status: 'Planned', notes: '', customerId: '',
  completedDate: '', createdDate: '2026-07-01',
  frozen: false, frozenDate: '', baselineQty: '', baselineDueDate: '',
  fulfillmentLots: [], revisions: [], ...over
});
const db = (entries) => {
  const d = Object.fromEntries(ENTITIES.map(e => [e, []]));
  (entries || []).forEach(e => d.schedule.push(e));
  return d;
};

console.log('\n--- freezing captures the commitment ---');
{
  const d = db([run()]);
  tx.freezeRun(d, { scheduleId: 'r1', date: '2026-07-15' });
  const r = repo.find(d, 'schedule', 'r1');
  ok('run is marked frozen', r.frozen === true);
  ok('freeze date recorded', r.frozenDate === '2026-07-15');
  ok('baseline captures the quantity', r.baselineQty === 100);
  ok('baseline captures the due date', r.baselineDueDate === '2026-08-20');

  // move the live figures via the sanctioned path, then re-freeze
  tx.amendFrozenRun(d, { scheduleId: 'r1', changes: { qty: 80 }, reason: 'x' });
  tx.freezeRun(d, { scheduleId: 'r1', date: '2026-07-20' });
  ok('re-freezing does NOT move an existing baseline',
     repo.find(d, 'schedule', 'r1').baselineQty === 100,
     String(repo.find(d, 'schedule', 'r1').baselineQty));
  ok('nor the freeze date', repo.find(d, 'schedule', 'r1').frozenDate === '2026-07-15');
}

console.log('\n--- an unfrozen run edits normally ---');
{
  const d = db([run()]);
  let threw = false;
  try { repo.upsert(d, 'schedule', 'r1', { ...run(), qty: 55 }); } catch (e) { threw = true; }
  ok('no refusal when not frozen', !threw);
  ok('the edit applied', repo.find(d, 'schedule', 'r1').qty === 55);
}

console.log('\n--- a frozen run REFUSES a silent edit ---');
{
  const d = db([run({ frozen: true, baselineQty: 100, baselineDueDate: '2026-08-20' })]);

  const attempt = (patch) => {
    try { repo.upsert(d, 'schedule', 'r1', { ...repo.find(d, 'schedule', 'r1'), ...patch }); return null; }
    catch (e) { return e.message; }
  };

  ok('changing quantity is refused', /frozen/i.test(attempt({ qty: 50 }) || ''), attempt({ qty: 50 }));
  ok('changing the due date is refused', /frozen/i.test(attempt({ dueDate: '2026-09-01' }) || ''));
  ok('changing the product is refused', /frozen/i.test(attempt({ productId: 'FG2' }) || ''));
  ok('the refusal names the field', /qty/.test(attempt({ qty: 50 }) || ''), attempt({ qty: 50 }));
  ok('nothing was written despite the attempt', repo.find(d, 'schedule', 'r1').qty === 100);

  // fields that are not commitments stay editable
  ok('notes remain editable on a frozen run', attempt({ notes: 'ran late' }) === null);
  ok('status remains editable', attempt({ status: 'In progress' }) === null);
  ok('fulfilment remains recordable',
     attempt({ fulfillmentLots: [{ id: 'f1', lotId: 'L1', qty: 90 }] }) === null);
}

console.log('\n--- amending a frozen run leaves a record ---');
{
  const d = db([run({ frozen: true, frozenDate: '2026-07-15', baselineQty: 100, baselineDueDate: '2026-08-20' })]);
  const res = tx.amendFrozenRun(d, {
    scheduleId: 'r1', changes: { qty: 80, dueDate: '2026-08-27' },
    reason: 'Customer cut the order', author: 'JS', date: '2026-08-01'
  });
  const r = repo.find(d, 'schedule', 'r1');
  ok('amendment succeeds', res.ok === true, res.error);
  ok('both fields changed', r.qty === 80 && r.dueDate === '2026-08-27');
  ok('two revisions written', r.revisions.length === 2, String(r.revisions.length));

  const q = r.revisions.find(x => x.field === 'qty');
  ok('revision records the old value', q.fromValue === '100', q.fromValue);
  ok('revision records the new value', q.toValue === '80', q.toValue);
  ok('revision records the reason', q.reason === 'Customer cut the order');
  ok('revision records who and when', q.author === 'JS' && q.at === '2026-08-01');

  ok('THE BASELINE DID NOT MOVE', r.baselineQty === 100 && r.baselineDueDate === '2026-08-20',
     r.baselineQty + ' / ' + r.baselineDueDate);
}

console.log('\n--- an amendment without a reason is refused ---');
{
  const d = db([run({ frozen: true, baselineQty: 100 })]);
  const blank = tx.amendFrozenRun(d, { scheduleId: 'r1', changes: { qty: 10 }, reason: '' });
  ok('empty reason refused', blank.ok === false && /reason/i.test(blank.error), blank.error);
  const spaces = tx.amendFrozenRun(d, { scheduleId: 'r1', changes: { qty: 10 }, reason: '   ' });
  ok('whitespace-only reason refused', spaces.ok === false);
  ok('nothing changed', repo.find(d, 'schedule', 'r1').qty === 100);
  ok('no revision written', repo.find(d, 'schedule', 'r1').revisions.length === 0);

  const notFrozen = tx.amendFrozenRun(db([run()]), { scheduleId: 'r1', changes: { qty: 5 }, reason: 'x' });
  ok('amending an unfrozen run is refused', notFrozen.ok === false && /not frozen/i.test(notFrozen.error));
}

console.log('\n--- a no-op amendment writes nothing ---');
{
  const d = db([run({ frozen: true, baselineQty: 100 })]);
  const res = tx.amendFrozenRun(d, { scheduleId: 'r1', changes: { qty: 100 }, reason: 'no change' });
  ok('reported as no change', res.ok === true && res.changed.length === 0);
  ok('no revision for an unchanged value', repo.find(d, 'schedule', 'r1').revisions.length === 0);
}

console.log('\n--- the log accumulates, it does not replace ---');
{
  const d = db([run({ frozen: true, baselineQty: 100, baselineDueDate: '2026-08-20' })]);
  tx.amendFrozenRun(d, { scheduleId: 'r1', changes: { qty: 90 }, reason: 'first', date: '2026-08-01' });
  tx.amendFrozenRun(d, { scheduleId: 'r1', changes: { qty: 70 }, reason: 'second', date: '2026-08-05' });
  const revs = repo.find(d, 'schedule', 'r1').revisions;
  ok('two separate records', revs.length === 2);
  ok('the first record survives the second amendment',
     revs[0].fromValue === '100' && revs[0].toValue === '90' && revs[0].reason === 'first');
  ok('the second chains from the first', revs[1].fromValue === '90' && revs[1].toValue === '70');
  ok('baseline still the original commitment', repo.find(d, 'schedule', 'r1').baselineQty === 100);
}

console.log('\n--- scheduled against actual ---');
{
  const d = db([
    run({ id: 'a', frozen: true, baselineQty: 100, baselineDueDate: '2026-08-20',
          qty: 100, status: 'Complete', completedDate: '2026-08-22',
          fulfillmentLots: [{ id: 'f1', lotId: 'L1', qty: 95 }] }),
    run({ id: 'b', frozen: false, qty: 50, status: 'Complete', completedDate: '2026-08-10',
          dueDate: '2026-08-10', fulfillmentLots: [{ id: 'f2', lotId: 'L2', qty: 50 }] }),
    run({ id: 'c', status: 'Cancelled' })
  ]);
  const rows = planVsActualEvents(d);
  ok('cancelled runs excluded', rows.length === 2);

  const a = rows.find(r => r.entry.id === 'a');
  ok('planned reads from the baseline, not the live figure', a.plannedQty === 100);
  ok('actual reads from fulfilment lots', a.actualQty === 95);
  ok('shortfall computed', a.qtyVariance === -5);
  ok('lateness computed against the baseline date', a.daysLate === 2, String(a.daysLate));
  ok('flagged as measurable', a.measurable === true);

  const b = rows.find(r => r.entry.id === 'b');
  ok('an unfrozen run is flagged NOT measurable', b.measurable === false);
  ok('but still reports its numbers', b.plannedQty === 50 && b.actualQty === 50);

  ok('fulfilledQtyOf sums lots', fulfilledQtyOf({ fulfillmentLots: [{ qty: 3 }, { qty: 4 }] }) === 7);
  ok('and copes with none', fulfilledQtyOf({}) === 0);
}

console.log('\n--- targets ---');
{
  const d = Object.fromEntries(ENTITIES.map(e => [e, []]));
  d.productionTargets.push(
    { id: 't1', periodType: 'month', periodKey: '2026-08', productType: '', productId: '', targetQty: 500, notes: '' },
    { id: 't2', periodType: 'month', periodKey: '2026-08', productType: 'finished', productId: 'FG1', targetQty: 200, notes: '' },
    { id: 't3', periodType: 'week', periodKey: '2026-W32', productType: '', productId: '', targetQty: 120, notes: '' }
  );
  ok('site-wide monthly target found', targetForBucket(d, '2026-08', 'month') === 500);
  ok('per-product target found', targetForBucket(d, '2026-08', 'month', 'FG1') === 200);
  ok('a product with no target of its own gets none',
     targetForBucket(d, '2026-08', 'month', 'FG9') === null);
  ok('weekly targets are separate from monthly', targetForBucket(d, '2026-W32', 'week') === 120);
  ok('granularity must match', targetForBucket(d, '2026-08', 'week') === null);
  ok('a period with no target returns null', targetForBucket(d, '2026-09', 'month') === null);

  const rows = withTargets(
    [{ key: '2026-08', label: 'Aug', total: 620 }, { key: '2026-09', label: 'Sep', total: 100 }],
    d, 'month');
  ok('target attached to the matching bucket', rows[0].target === 500);
  ok('over-target flagged', rows[0].overTarget === true);
  ok('attainment percentage computed', rows[0].attainment === 124, String(rows[0].attainment));
  ok('a bucket with no target stays blank', rows[1].target === '' && rows[1].overTarget === false);
}

console.log('\n--- schema and round trip ---');
{
  const tables = allTables().map(t => t.table);
  ok('production_targets is a table', tables.includes('production_targets'));
  ok('schedule_revisions is a table', tables.includes('schedule_revisions'));

  const revDef = allTables().find(t => t.table === 'schedule_revisions');
  ok('revisions carry their parent run', csvColumns(revDef)[0] === 'scheduleId');
  ok('revisions record reason and author',
     csvColumns(revDef).includes('reason') && csvColumns(revDef).includes('author'));

  const d = seedData();
  // use a run with no history of its own so the assertions below are exact
  d.schedule = [d.schedule.find(s => !s.frozen && (s.revisions || []).length === 0) || d.schedule[0]];
  d.schedule[0].revisions = [];
  d.schedule[0].frozen = true;
  d.schedule[0].frozenDate = '2026-07-15';
  d.schedule[0].baselineQty = d.schedule[0].qty;
  d.schedule[0].baselineDueDate = d.schedule[0].dueDate;
  tx.amendFrozenRun(d, { scheduleId: d.schedule[0].id, changes: { qty: 7 },
    reason: 'Material shortfall, agreed with planning', author: 'AB', date: '2026-08-01' });
  d.productionTargets.push({ id: 'tt', periodType: 'month', periodKey: '2026-08',
    productType: '', productId: '', targetQty: 400, notes: 'Q3 stretch' });

  const bundle = exportCsvBundle(d);
  const files = Object.fromEntries(bundle.map(b => [b.table, b.csv]));
  const empty = Object.fromEntries(ENTITIES.map(e => [e, []]));
  const { data, report } = importCsvBundle(empty, files);
  ok('round trip clean', report.errors.length === 0, report.errors.slice(0, 4).join('; '));

  const back = data.schedule.find(s => s.frozen);
  ok('frozen flag survives', !!back);
  ok('baseline survives', back && Number(back.baselineQty) === Number(d.schedule[0].baselineQty),
     back ? back.baselineQty + ' vs ' + d.schedule[0].baselineQty : '');
  ok('the revision record survives', back && (back.revisions || []).length === 1,
     back ? JSON.stringify(back.revisions) : '');
  ok('and keeps its reason', back && back.revisions[0].reason === 'Material shortfall, agreed with planning');
  ok('targets survive', data.productionTargets.length === d.productionTargets.length &&
     data.productionTargets.some(t => Number(t.targetQty) === 400),
     data.productionTargets.length + ' vs ' + d.productionTargets.length);
}

console.log('\n--- migration of a database that predates all this ---');
{
  const legacy = seedData();
  legacy.schedule.forEach(s => {
    delete s.frozen; delete s.baselineQty; delete s.baselineDueDate; delete s.revisions;
  });
  delete legacy.productionTargets;
  const m = normalizeData(legacy);
  ok('old runs come back unfrozen, not locked', m.schedule.every(s => s.frozen === false));
  ok('every run has a revision list', m.schedule.every(s => Array.isArray(s.revisions)));
  ok('targets collection exists', Array.isArray(m.productionTargets));
  ok('old runs stay editable', (() => {
    try { repo.upsert(m, 'schedule', m.schedule[0].id, { ...m.schedule[0], qty: 999 }); return true; }
    catch (e) { return false; }
  })());
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
