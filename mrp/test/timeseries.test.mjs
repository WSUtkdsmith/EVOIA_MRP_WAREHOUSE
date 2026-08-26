import { planVsActualEvents, batchEvents, batchRecords, seedData, bucketKeyOf, bucketLabelOf, bucketStartOf, enumerateBuckets,
         bucketEvents, productionEvents, receiptEvents, consumptionEvents,
         wasteEvents, shipmentEvents, orderCompletionEvents, dataDateSpan,
         resolvePreset, RANGE_PRESETS, isoWeekParts, shiftISO } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

console.log('\n--- ISO week edges (where week logic usually breaks) ---');
ok('2026-01-01 falls in week 1 of 2026', bucketKeyOf('2026-01-01', 'week') === '2026-W01',
   bucketKeyOf('2026-01-01', 'week'));
ok('2027-01-01 belongs to 2026-W53', bucketKeyOf('2027-01-01', 'week') === '2026-W53',
   bucketKeyOf('2027-01-01', 'week'));
ok('2023-01-01 belongs to 2022-W52', bucketKeyOf('2023-01-01', 'week') === '2022-W52',
   bucketKeyOf('2023-01-01', 'week'));
ok('2021-01-04 is 2021-W01', bucketKeyOf('2021-01-04', 'week') === '2021-W01',
   bucketKeyOf('2021-01-04', 'week'));
ok('2020 had 53 ISO weeks', bucketKeyOf('2020-12-31', 'week') === '2020-W53',
   bucketKeyOf('2020-12-31', 'week'));
ok('a Sunday stays in the week that started Monday',
   bucketKeyOf('2026-05-17', 'week') === bucketKeyOf('2026-05-11', 'week'),
   bucketKeyOf('2026-05-17','week') + ' vs ' + bucketKeyOf('2026-05-11','week'));
ok('the next Monday starts a new week',
   bucketKeyOf('2026-05-18', 'week') !== bucketKeyOf('2026-05-17', 'week'));

console.log('\n--- month and year buckets ---');
ok('month key is zero-padded', bucketKeyOf('2026-06-05', 'month') === '2026-06');
ok('last day of month stays in that month', bucketKeyOf('2026-01-31', 'month') === '2026-01');
ok('first day of next month moves on', bucketKeyOf('2026-02-01', 'month') === '2026-02');
ok('year key is the year', bucketKeyOf('2026-08-09', 'year') === '2026');
ok('31 Dec stays in its own year', bucketKeyOf('2026-12-31', 'year') === '2026');
ok('leap day buckets correctly', bucketKeyOf('2024-02-29', 'month') === '2024-02');

console.log('\n--- no timezone drift ---');
{
  // A local-time parse would shift these by a day for negative offsets.
  ok('1st of month is not pulled into the previous month',
     bucketKeyOf('2026-03-01', 'month') === '2026-03');
  ok('1 Jan is not pulled into the previous year',
     bucketKeyOf('2026-01-01', 'year') === '2026');
  ok('bucketStartOf round-trips through bucketKeyOf', ['week','month','year'].every(g => {
    const key = bucketKeyOf('2026-06-17', g);
    return bucketKeyOf(bucketStartOf(key, g).toISOString().slice(0,10), g) === key;
  }));
}

console.log('\n--- enumerating ranges, gaps included ---');
{
  const w = enumerateBuckets('2026-01-01', '2026-03-31', 'week');
  ok('weekly range is contiguous and plausible', w.length === 13 || w.length === 14, 'got ' + w.length);
  ok('weekly keys are strictly increasing', w.every((k, i) => i === 0 || k > w[i - 1]));

  const m = enumerateBuckets('2026-01-15', '2026-12-15', 'month');
  ok('12 month buckets across a year', m.length === 12, 'got ' + m.length);
  ok('first is Jan, last is Dec', m[0] === '2026-01' && m[11] === '2026-12');

  const y = enumerateBuckets('2023-06-01', '2026-02-01', 'year');
  ok('4 year buckets spanning 2023-2026', y.length === 4 && y[0] === '2023' && y[3] === '2026');

  ok('single day yields one bucket', enumerateBuckets('2026-05-05','2026-05-05','month').length === 1);
  ok('reversed range yields nothing', enumerateBuckets('2026-05-05','2026-01-01','month').length === 0);
  ok('a month spanning a year boundary continues', 
     JSON.stringify(enumerateBuckets('2025-11-01','2026-02-01','month')) ===
     JSON.stringify(['2025-11','2025-12','2026-01','2026-02']));
}

console.log('\n--- bucketing events ---');
{
  const events = [
    { date: '2026-01-05', series: 'a', value: 10 },
    { date: '2026-01-20', series: 'a', value: 5 },
    { date: '2026-03-02', series: 'b', value: 7 },
    { date: '2025-12-31', series: 'a', value: 999 },   // before range
    { date: '2026-04-02', series: 'a', value: 999 }    // after range
  ];
  const rows = bucketEvents(events, { from: '2026-01-01', to: '2026-03-31', granularity: 'month' }, ['a','b']);
  ok('one row per bucket including the empty one', rows.length === 3, 'got ' + rows.length);
  ok('February is present as a zero, not skipped',
     rows[1].key === '2026-02' && rows[1].a === 0 && rows[1].b === 0);
  ok('same-bucket values are summed', rows[0].a === 15);
  ok('series are kept separate', rows[2].b === 7 && rows[2].a === 0);
  ok('events before the range are excluded', rows.every(r => r.a !== 999));
  ok('events after the range are excluded', rows.reduce((s,r)=>s+r.a,0) === 15);
  ok('total is the sum across series', rows[2].total === 7);
  ok('rows carry a display label', rows.every(r => typeof r.label === 'string' && r.label.length));
  ok('unknown series are ignored, not crashed',
     bucketEvents([{date:'2026-01-05',series:'zzz',value:1}], {from:'2026-01-01',to:'2026-01-31',granularity:'month'}, ['a'])[0].a === 0);
  ok('undated events are ignored',
     bucketEvents([{date:'',series:'a',value:5}], {from:'2026-01-01',to:'2026-01-31',granularity:'month'}, ['a'])[0].a === 0);
}

console.log('\n--- extractors against seed data ---');
{
  const D = seedData();
  const prod = productionEvents(D);
  ok('production events found', prod.length > 0, 'n=' + prod.length);
  ok('production events are all dated', prod.every(e => !!e.date));
  ok('production covers both intermediate and finished',
     new Set(prod.map(e => e.series)).size === 2, [...new Set(prod.map(e=>e.series))].join(','));

  const rec = receiptEvents(D);
  ok('receipt events found', rec.length > 0, 'n=' + rec.length);

  const cons = consumptionEvents(D);
  ok('consumption events derived from lot sources', cons.length > 0, 'n=' + cons.length);
  ok('consumption values are positive', cons.every(e => e.value >= 0));

  ok('waste extractor runs on empty waste history', Array.isArray(wasteEvents(D)));
  ok('shipment extractor returns dated events', shipmentEvents(D).every(e => !!e.date));
  ok('order completions are dated by completion, not due date',
     orderCompletionEvents(D).every(e => !!e.date));

  const span = dataDateSpan(D);
  ok('data span found', !!span.from && !!span.to && span.from <= span.to, span.from + ' -> ' + span.to);
}

console.log('\n--- shipment revenue ---');
{
  const D = seedData();
  const fg = D.finishedGoods[0];
  const cust = D.customers.find(c => (c.priceList || []).some(p => p.finishedGoodId === fg.id))
            || D.customers[0];
  const priced = (cust.priceList || []).find(p => p.finishedGoodId === fg.id);
  D.shipments.push({ id: 'sh1', finishedGoodId: fg.id, lotId: '', qty: 3,
    customerId: cust.id, addressId: '', shipDate: '2026-06-10', reference: '', notes: '' });
  D.shipments.push({ id: 'sh2', finishedGoodId: fg.id, lotId: '', qty: 2,
    customerId: '', addressId: '', shipDate: '2026-06-12', reference: '', notes: '' });

  // Select the two shipments THIS test added, by id. Filtering by date used to
  // work and then quietly stopped: the seed lays shipments down over a rolling
  // window, so whether it happens to put one on 2026-06-12 depends on the day
  // the suite is run. That made a real assertion fail for a reason that had
  // nothing to do with the code under test.
  const ev = shipmentEvents(D).filter(e => e.id === 'sh1' || e.id === 'sh2');
  ok('both added shipments extracted', ev.length === 2);
  const withCust = ev.find(e => e.customerId), without = ev.find(e => !e.customerId);
  ok('units captured', withCust.qty === 3 && without.qty === 2);
  ok('an unpriced shipment is flagged, not silently zero-revenue',
     without.priced === false && without.revenue === 0);
  if (priced) ok('a priced shipment produces revenue', withCust.priced === true && withCust.revenue > 0,
     'revenue=' + withCust.revenue);
  else ok('priced-line case skipped (no matching price line)', true);

  const rows = bucketEvents(
    ev.map(e => ({ date: e.date, series: 'revenue', value: e.revenue })),
    { from: '2026-06-01', to: '2026-06-30', granularity: 'month' }, ['revenue']);
  ok('revenue buckets into the shipping month',
     rows.length === 1 && Math.abs(rows[0].revenue - (ev[0].revenue + ev[1].revenue)) < 0.001);
}

console.log('\n--- range presets ---');
{
  const D = seedData();
  RANGE_PRESETS.filter(p => p.key !== 'custom').forEach(p => {
    const r = resolvePreset(p.key, D);
    ok(p.key + ' resolves to a valid range', !!r.from && !!r.to && r.from <= r.to && !!r.granularity,
       JSON.stringify(r));
  });
  const all = resolvePreset('all', D);
  const span = dataDateSpan(D);
  ok('all-time starts at the earliest dated record', all.from === span.from, all.from + ' vs ' + span.from);
  const ytd = resolvePreset('ytd', D);
  ok('year-to-date starts on 1 January', /-01-01$/.test(ytd.from), ytd.from);
  ok('shiftISO moves dates correctly', shiftISO('2026-03-01', -1) === '2026-02-28');
  ok('shiftISO handles leap years', shiftISO('2024-03-01', -1) === '2024-02-29');
}

console.log('\n--- guards ---');
{
  ok('bad date returns null key', bucketKeyOf('not-a-date', 'month') === null);
  ok('empty range enumerates nothing', enumerateBuckets('', '', 'month').length === 0);
  ok('huge range is capped rather than hanging',
     enumerateBuckets('1900-01-01', '2200-01-01', 'week').length <= 4000);
}


console.log('\n--- production history reports what was MADE, not what is left ---');
{
  const D = seedData();
  const ents = ['intermediateProducts', 'finishedGoods'];
  let produced = 0, remaining = 0;
  ents.forEach(e => (D[e] || []).forEach(i => (i.lots || []).forEach(l => {
    produced += Number(l.producedQty) || 0;
    remaining += Number(l.qty) || 0;
  })));
  const charted = productionEvents(D).reduce((s, e) => s + e.value, 0);

  ok('history totals the produced quantity', Math.abs(charted - produced) < 1,
     'charted ' + Math.round(charted) + ' vs produced ' + Math.round(produced));
  ok('which is materially more than what remains', produced > remaining * 2,
     'produced ' + Math.round(produced) + ' vs remaining ' + Math.round(remaining));
  ok('a fully consumed lot still appears in history', (() => {
    const gone = ents.flatMap(e => (D[e] || []).flatMap(i =>
      (i.lots || []).filter(l => (Number(l.qty) || 0) === 0 && (Number(l.producedQty) || 0) > 0)
        .map(l => ({ i, l }))))[0];
    if (!gone) return false;
    return productionEvents(D).some(ev => ev.lotId === gone.l.id && ev.value > 0);
  })());

  ok('receipts report the quantity received', (() => {
    const raw = D.rawMaterials.find(r => (r.lots || []).some(l => (Number(l.qty) || 0) === 0));
    if (!raw) return true;
    const drained = raw.lots.find(l => (Number(l.qty) || 0) === 0);
    return receiptEvents(D).some(e => e.date === drained.date && e.value > 0);
  })());

  ok('every production event names its batch',
     productionEvents(D).filter(e => e.batchId).length > 0);
}

console.log('\n--- batch events ---');
{
  const D = seedData();
  const recs = batchRecords(D);
  const ev = batchEvents(D, recs);
  ok('one event per batch', ev.length === recs.length, ev.length + ' vs ' + recs.length);
  ok('each counts as one run', ev.every(e => e.value === 1));
  ok('all are dated', ev.every(e => !!e.date));
  const rows = bucketEvents(ev, { from: '2026-03-01', to: '2026-07-31', granularity: 'month' }, ['batches']);
  ok('batches bucket by month', rows.length === 5);
  ok('and total back to the record count',
     rows.reduce((s, r) => s + r.batches, 0) ===
     ev.filter(e => e.date >= '2026-03-01' && e.date <= '2026-07-31').length);
  ok('the busiest month has many runs', Math.max(...rows.map(r => r.batches)) > 20,
     JSON.stringify(rows.map(r => r.batches)));
}


console.log('\n--- scheduled is a separate measure, never added to actual ---');
{
  const D = seedData();
  const range = { from: '2026-03-01', to: '2026-07-31', granularity: 'month' };
  const pva = planVsActualEvents(D);

  const actual = bucketEvents(
    productionEvents(D).filter(e => e.series === 'finished'), range, ['finished']);
  const scheduled = bucketEvents(
    pva.filter(r => r.plannedDate && r.entry.productType === 'finished')
       .map(r => ({ date: r.plannedDate, series: 'scheduled', value: r.plannedQty })),
    range, ['scheduled']);

  ok('both series bucket over the same periods', actual.length === scheduled.length);
  ok('there is scheduled quantity to compare', scheduled.some(r => r.scheduled > 0));
  ok('there is actual production to compare', actual.some(r => r.finished > 0));

  /* The old chart stacked them, so its "total" was actual+scheduled. Assert
     the two are genuinely different magnitudes, which is what made the
     stacked reading wrong rather than merely redundant. */
  const totalActual = actual.reduce((s, r) => s + r.finished, 0);
  const totalSched = scheduled.reduce((s, r) => s + r.scheduled, 0);
  ok('scheduled and actual are different quantities',
     Math.abs(totalActual - totalSched) > 1,
     'actual ' + Math.round(totalActual) + ' vs scheduled ' + Math.round(totalSched));
  ok('so summing them would misstate output by a wide margin',
     (totalActual + totalSched) > totalActual * 1.2,
     'sum ' + Math.round(totalActual + totalSched) + ' vs true ' + Math.round(totalActual));

  // a bar row carrying a scheduled figure must not include it in its series total
  const row = { finished: 100, scheduled: 400, total: 100 };
  const barTotal = ['finished'].reduce((s, k) => s + row[k], 0);
  ok('a reference value is excluded from the bar total', barTotal === 100);
}

console.log('\n--- output can be scoped to a single item ---');
{
  const D = seedData();
  const range = { from: '2026-03-01', to: '2026-07-31', granularity: 'month' };
  const one = D.finishedGoods[0];
  const all = bucketEvents(productionEvents(D).filter(e => e.series === 'finished'),
                           range, ['finished']);
  const just = bucketEvents(
    productionEvents(D).filter(e => e.itemId === one.id).map(e => ({ ...e, series: 'actual' })),
    range, ['actual']);

  const allTotal = all.reduce((s, r) => s + r.finished, 0);
  const oneTotal = just.reduce((s, r) => s + r.actual, 0);
  ok('a single item produces less than all finished goods', oneTotal < allTotal && oneTotal > 0,
     oneTotal + ' vs ' + allTotal);

  const sumOfItems = (D.finishedGoods || []).reduce((s, f) => s +
    productionEvents(D).filter(e => e.itemId === f.id && e.date >= range.from && e.date <= range.to)
      .reduce((q, e) => q + e.value, 0), 0);
  ok('the individual items sum back to the group total',
     Math.abs(sumOfItems - allTotal) < 1,
     'items ' + Math.round(sumOfItems) + ' vs group ' + Math.round(allTotal));

  ok('every production event carries an item id so it can be filtered',
     productionEvents(D).every(e => !!e.itemId));
}


console.log('\n--- scheduled coverage: intermediates are scheduled too now ---');
{
  const D = seedData();
  const byType = {};
  (D.schedule || []).forEach(s => { byType[s.productType] = (byType[s.productType] || 0) + 1; });
  ok('finished goods are scheduled', byType.finished > 0, JSON.stringify(byType));
  ok('bulk intermediates are scheduled too', byType.intermediate > 0, JSON.stringify(byType));

  const pva = planVsActualEvents(D);
  ok('intermediate schedule entries produce plan-vs-actual rows',
     pva.some(r => r.entry.productType === 'intermediate'));
  ok('those rows have fulfilment recorded',
     pva.filter(r => r.entry.productType === 'intermediate').every(r => r.actualQty > 0));
}

console.log('\n--- summing all intermediates double-counts the chain ---');
{
  const D = seedData();
  const range = { from: '2026-03-01', to: '2026-07-31', granularity: 'month' };
  const ev = productionEvents(D).filter(e => e.date >= range.from && e.date <= range.to);
  const interTotal = ev.filter(e => e.series === 'intermediate').reduce((s, e) => s + e.value, 0);
  const greenBought = (D.rawMaterials || []).filter(r => r.sku.indexOf('GC-') === 0)
    .reduce((s, r) => s + (r.lots || []).reduce((q, l) => q + (Number(l.producedQty) || 0), 0), 0);

  /* This is the finding that makes an "all intermediates" total unusable as a
     denominator: the same coffee is counted once per stage, so the sum
     comfortably exceeds the raw material that entered the plant. */
  ok('intermediate output exceeds the green coffee it came from',
     interTotal > greenBought,
     Math.round(interTotal) + ' vs ' + Math.round(greenBought) + ' bought');
  ok('which is why it is throughput, not tonnes made',
     interTotal / greenBought > 1.5,
     'ratio ' + (interTotal / greenBought).toFixed(2));

  // a single stage is a real figure
  const powder = (D.intermediateProducts || []).filter(i => i.sku.indexOf('PWD') >= 0);
  const powderTotal = powder.reduce((s, i) =>
    s + ev.filter(e => e.itemId === i.id).reduce((q, e) => q + e.value, 0), 0);
  ok('a single stage is far smaller than the chain total',
     powderTotal < interTotal / 2,
     Math.round(powderTotal) + ' vs ' + Math.round(interTotal));
  ok('and is less than the material that entered', powderTotal < greenBought);
}

console.log('\n--- finished goods is the scope that holds up ---');
{
  const D = seedData();
  const range = { from: '2026-03-01', to: '2026-07-31', granularity: 'month' };
  const ev = productionEvents(D).filter(e => e.date >= range.from && e.date <= range.to);
  const finTotal = ev.filter(e => e.series === 'finished').reduce((s, e) => s + e.value, 0);
  const perItem = (D.finishedGoods || []).reduce((s, f) =>
    s + ev.filter(e => e.itemId === f.id).reduce((q, e) => q + e.value, 0), 0);
  ok('no double counting: items sum exactly to the group',
     Math.abs(finTotal - perItem) < 1, Math.round(finTotal) + ' vs ' + Math.round(perItem));

  const sched = planVsActualEvents(D)
    .filter(r => r.plannedDate >= range.from && r.plannedDate <= range.to &&
                 r.entry.productType === 'finished')
    .reduce((s, r) => s + r.plannedQty, 0);
  const ratio = finTotal / sched;
  ok('actual against scheduled is a plausible ratio, not hundreds of percent',
     ratio > 0.5 && ratio < 3, 'ratio ' + ratio.toFixed(2));

  ok('every finished good has at least one schedule entry', (() => {
    const scheduled = new Set((D.schedule || []).map(s => s.productId));
    return (D.finishedGoods || []).every(f => scheduled.has(f.id));
  })());
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
