import { utilizationSeries, utilizationByEquipment, equipmentHoursOn,
         equipmentActualEvents, equipmentCommittedEvents, equipmentAvailableEvents,
         normalizeEquipment,
         seedData, planScheduleFIFO, calendarHoursOn, stageHoursOn, stageWorkingDays,
         activeOverride, resolveHours,
         defaultCalendar, calendarFor, weeklyHours, calendarIsWorkable,
         ensureOperatingCalendars, normalizeData, WEEKDAY_KEYS,
         exportCsvBundle, importCsvBundle, ENTITIES } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const dow = (s) => new Date(s + 'T00:00:00Z').getUTCDay();

// 2026-07-06 is a Monday; every date below is chosen from that anchor.
const MON = '2026-07-06', TUE = '2026-07-07', FRI = '2026-07-10',
      SAT = '2026-07-11', SUN = '2026-07-12', NEXTMON = '2026-07-13';

const cal = (over) => ({
  id: 'cal1', name: 'Test', isDefault: true,
  hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8,
  hoursSat: 0, hoursSun: 0, notes: '', closures: [], overrides: [], ...over
});

function plant(spec) {
  const db = Object.fromEntries(ENTITIES.map(e => [e, []]));
  (spec.calendars || []).forEach(c => db.operatingCalendars.push(cal(c)));
  (spec.equipment || []).forEach(e =>
    db.equipment.push({ id: e.id, name: e.id, code: e.id, units: e.units || 1,
                        notes: '', calendarId: e.calendarId || '' }));
  (spec.items || []).forEach(it =>
    db[it.type === 'finished' ? 'finishedGoods' : 'intermediateProducts'].push({
      id: it.id, name: it.id, sku: it.id, unit: 'ea', notes: '',
      composition: [], autoComposition: false, hazardClass: 'N/A', lots: [] }));
  (spec.processes || []).forEach(p =>
    db.processes.push({
      id: p.id, name: p.id, sku: p.id, notes: '', productionTimeHours: p.hours,
      inputs: [], equipment: (p.equipment || []).map(e => ({ id: p.id + e, equipmentId: e, status: 'Required' })),
      outputs: (p.outputs || []).map(o => ({ id: p.id + o.item, itemType: o.type, itemId: o.item, qtyPerBatch: o.perBatch, costOverride: '' })) }));
  (spec.orders || []).forEach((o, i) =>
    db.schedule.push({ id: 'o' + i, productType: o.type, productId: o.item, qty: o.qty,
      dueDate: o.due, status: 'Planned', notes: '', customerId: '',
      completedDate: '', createdDate: o.created || '2026-01-0' + (i + 1), fulfillmentLots: [] }));
  return db;
}

console.log('\n--- hours available on a given day ---');
{
  const c = cal();
  ok('a weekday offers its configured hours', calendarHoursOn(c, MON) === 8);
  ok('Saturday is shut when set to zero', calendarHoursOn(c, SAT) === 0);
  ok('Sunday is shut when set to zero', calendarHoursOn(c, SUN) === 0);
  ok('weekday keys line up with real weekdays',
     WEEKDAY_KEYS[dow(MON)] === 'hoursMon' && WEEKDAY_KEYS[dow(SUN)] === 'hoursSun');
  ok('weekly total is the sum of the days', weeklyHours(c) === 40);

  const nights = cal({ hoursSat: 12, hoursSun: 12 });
  ok('a weekend shift is honoured', calendarHoursOn(nights, SAT) === 12);

  const shut = cal({ hoursMon: 0, hoursTue: 0, hoursWed: 0, hoursThu: 0, hoursFri: 0 });
  ok('a calendar with no open hours is detected', calendarIsWorkable(shut) === false);
  ok('a normal calendar is workable', calendarIsWorkable(c) === true);
}

console.log('\n--- closures ---');
{
  const c = cal({ closures: [{ id: 'x', startDate: TUE, endDate: '', reason: 'Holiday' }] });
  ok('a single-day closure shuts that day', calendarHoursOn(c, TUE) === 0);
  ok('the day before is unaffected', calendarHoursOn(c, MON) === 8);
  // isClosed was folded into resolveHours, which reports the reason too
  ok('the closure is attributed as such',
     resolveHours(c, TUE).source === 'closure' && resolveHours(c, MON).source === 'base');

  const week = cal({ closures: [{ id: 'y', startDate: MON, endDate: FRI, reason: 'Shutdown' }] });
  ok('a range closes every day inside it',
     [MON, TUE, FRI].every(d => calendarHoursOn(week, d) === 0));
  ok('the following Monday reopens', calendarHoursOn(week, NEXTMON) === 8);

  const bad = cal({ closures: [{ id: 'z', startDate: FRI, endDate: MON, reason: 'reversed' }] });
  ok('a reversed range is treated as a single day, not everything',
     calendarHoursOn(bad, FRI) === 0 && calendarHoursOn(bad, TUE) === 8);
}

console.log('\n--- how many working days a job takes ---');
{
  const db = plant({ calendars: [{}] });
  const span8 = stageWorkingDays(db, [], MON, 8);
  ok('8 hours at 8h/day is one day', span8.days.length === 1 && span8.end === MON);

  const span40 = stageWorkingDays(db, [], MON, 40);
  ok('40 hours at 8h/day is five working days', span40.days.length === 5, span40.days.length);
  ok('and finishes on the Friday', span40.end === FRI, span40.end);

  const span48 = stageWorkingDays(db, [], MON, 48);
  ok('48 hours spills over the weekend to the next Monday',
     span48.end === NEXTMON, span48.end);
  ok('the weekend is not counted as worked',
     span48.days.length === 6 && !span48.days.includes(SAT) && !span48.days.includes(SUN),
     JSON.stringify(span48.days));

  const startWeekend = stageWorkingDays(db, [], SAT, 8);
  ok('a job starting on a closed day begins at the next open one',
     startWeekend.days[0] === NEXTMON, startWeekend.days[0]);

  const zero = stageWorkingDays(db, [], MON, 0);
  ok('a job with no recorded time still occupies one working day',
     zero.days.length === 1 && zero.days[0] === MON);

  const cont = plant({ calendars: [{ hoursSat: 24, hoursSun: 24, hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24 }] });
  ok('the same 48 hours is two days on a 24/7 calendar',
     stageWorkingDays(cont, [], MON, 48).days.length === 2);
}

console.log('\n--- machines can keep their own hours ---');
{
  const db = plant({
    calendars: [{ id: 'cal1', name: 'Day shift', isDefault: true },
                { id: 'cal2', name: 'Two shifts', isDefault: false, hoursMon: 16, hoursTue: 16, hoursWed: 16, hoursThu: 16, hoursFri: 16 }],
    equipment: [{ id: 'DAY' }, { id: 'NIGHT', calendarId: 'cal2' }]
  });
  db.operatingCalendars[1].id = 'cal2';
  ok('a machine without an override follows the facility',
     calendarFor(db, 'DAY').name === 'Day shift');
  ok('a machine with an override follows its own', calendarFor(db, 'NIGHT').name === 'Two shifts');
  ok('the double-shift machine offers more hours', stageHoursOn(db, ['NIGHT'], MON) === 16);
  ok('a stage needing both is limited by the shorter one',
     stageHoursOn(db, ['DAY', 'NIGHT'], MON) === 8,
     String(stageHoursOn(db, ['DAY', 'NIGHT'], MON)));

  const weekendOnly = { id: 'cal3', name: 'Weekend', isDefault: false,
    hoursMon: 0, hoursTue: 0, hoursWed: 0, hoursThu: 0, hoursFri: 0, hoursSat: 8, hoursSun: 8, closures: [] };
  db.operatingCalendars.push(weekendOnly);
  db.equipment.push({ id: 'WKND', name: 'WKND', code: 'WKND', units: 1, notes: '', calendarId: 'cal3' });
  ok('a stage needing machines with no overlapping days gets zero hours',
     stageHoursOn(db, ['DAY', 'WKND'], MON) === 0 && stageHoursOn(db, ['DAY', 'WKND'], SAT) === 0);
}

console.log('\n--- the plan respects the calendar ---');
{
  const mk = (cals) => plant({
    calendars: cals,
    equipment: [{ id: 'M1' }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 40, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(MON, 60) }]
  });

  const day = planScheduleFIFO(mk([{}]), { from: MON });
  ok('40 hours at 8h/day runs Monday to Friday',
     day.rows[0].start === MON && day.rows[0].end === FRI,
     day.rows[0].start + ' -> ' + day.rows[0].end);

  const cont = planScheduleFIFO(mk([{ hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 24, hoursSun: 24 }]), { from: MON });
  ok('the same job is two days round the clock',
     cont.rows[0].end === TUE, cont.rows[0].end);
  ok('shorter hours therefore push the finish out',
     day.rows[0].end > cont.rows[0].end);
}

console.log('\n--- closed days do not consume capacity ---');
{
  const db = plant({
    calendars: [{ closures: [{ id: 'c1', startDate: TUE, endDate: TUE, reason: 'Holiday' }] }],
    equipment: [{ id: 'M1' }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 16, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(MON, 60) }]
  });
  const p = planScheduleFIFO(db, { from: MON });
  const stage = p.rows[0].stages[0];
  ok('work steps over the holiday', stage.workingDays.indexOf(TUE) < 0,
     JSON.stringify(stage.workingDays));
  ok('it takes two working days spanning three calendar days',
     stage.workingDays.length === 2 && stage.start === MON && stage.end === '2026-07-08',
     stage.start + ' -> ' + stage.end);
}

console.log('\n--- capacity still holds under a restricted calendar ---');
{
  const orders = Array.from({ length: 8 }, (_, i) => ({
    type: 'finished', item: 'W', qty: 1, due: addDays(MON, 120), created: '2026-01-' + String(i + 1).padStart(2, '0') }));
  const db = plant({
    calendars: [{}],
    equipment: [{ id: 'M1', units: 2 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 24, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders
  });
  const p = planScheduleFIFO(db, { from: MON });
  ok('all eight placed', p.rows.every(r => !r.unplaceable));
  const perDay = {};
  p.rows.forEach(r => r.stages.forEach(s => s.workingDays.forEach(d => { perDay[d] = (perDay[d] || 0) + 1; })));
  const over = Object.entries(perDay).filter(([, n]) => n > 2);
  ok('no day exceeds the two units', over.length === 0, JSON.stringify(over.slice(0, 4)));
  const weekendUsed = Object.keys(perDay).filter(d => dow(d) === 0 || dow(d) === 6);
  ok('nothing was scheduled onto a closed weekend', weekendUsed.length === 0,
     weekendUsed.slice(0, 3).join(', '));
}

console.log('\n--- a plant that is never open is reported, not hung ---');
{
  const db = plant({
    calendars: [{ hoursMon: 0, hoursTue: 0, hoursWed: 0, hoursThu: 0, hoursFri: 0 }],
    equipment: [{ id: 'M1' }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 8, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(MON, 30) }]
  });
  const t0 = Date.now();
  const p = planScheduleFIFO(db, { from: MON });
  ok('it returns quickly rather than grinding', Date.now() - t0 < 3000);
  ok('and explains why', p.noOpenHours === true &&
     /no open hours/i.test(p.rows[0].reason || ''), p.rows[0].reason);
}

console.log('\n--- migration protects existing plans ---');
{
  const legacy = seedData();
  delete legacy.operatingCalendars;
  const migrated = normalizeData(legacy);
  const c = defaultCalendar(migrated);
  ok('a database with no calendar gets one', !!c && !!c.id);
  ok('and it is round-the-clock, matching the old behaviour',
     weeklyHours(c) === 168, weeklyHours(c) + 'h/week');

  const fresh = seedData();
  ok('a NEW database gets a realistic staffed pattern, not 24/7',
     weeklyHours(defaultCalendar(fresh)) > 0 && weeklyHours(defaultCalendar(fresh)) < 168,
     weeklyHours(defaultCalendar(fresh)) + 'h/week');

  ok('hours are clamped to a real day',
     ensureOperatingCalendars([{ hoursMon: 99, hoursTue: -5 }])[0].hoursMon === 24 &&
     ensureOperatingCalendars([{ hoursMon: 99, hoursTue: -5 }])[0].hoursTue === 0);
  ok('exactly one calendar is marked default',
     ensureOperatingCalendars([{ name: 'a' }, { name: 'b' }]).filter(c => c.isDefault).length === 1);
}

console.log('\n--- calendars survive export and import ---');
{
  const d = seedData();
  d.operatingCalendars[0].closures.push({ id: 'cl1', startDate: '2026-12-24', endDate: '2026-12-26', reason: 'Christmas' });
  const bundle = exportCsvBundle(d);
  const names = bundle.map(b => b.table);
  ok('operating_calendars is exported', names.includes('operating_calendars'));
  ok('calendar_closures is exported', names.includes('calendar_closures'));

  const files = Object.fromEntries(bundle.map(b => [b.table, b.csv]));
  const empty = Object.fromEntries(ENTITIES.map(e => [e, []]));
  const { data, report } = importCsvBundle(empty, files);
  ok('round trip reports no errors', report.errors.length === 0, report.errors.slice(0, 4).join('; '));
  const back = defaultCalendar(data);
  ok('hours survive', weeklyHours(back) === weeklyHours(defaultCalendar(d)),
     weeklyHours(back) + ' vs ' + weeklyHours(defaultCalendar(d)));
  ok('the default flag survives', back.isDefault === true);
  const added = (back.closures || []).find(c => c.reason === 'Christmas');
  ok('closures survive', !!added && (back.closures || []).length === (defaultCalendar(d).closures || []).length,
     JSON.stringify((back.closures || []).map(c => c.reason)));
  ok('a closed date is still closed after the round trip',
     calendarHoursOn(back, '2026-12-25') === 0);
}


console.log('\n--- temporary changes to the pattern ---');
{
  const surge = {
    id: 'ov1', startDate: MON, endDate: FRI, label: '24/5 push',
    hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24,
    hoursSat: 0, hoursSun: 0
  };
  const c = cal({ overrides: [surge] });

  ok('inside the period the temporary hours apply', calendarHoursOn(c, MON) === 24);
  ok('and it reports why', resolveHours(c, MON).source === 'override' &&
     resolveHours(c, MON).label === '24/5 push');
  ok('after the period the base pattern returns',
     calendarHoursOn(c, NEXTMON) === 8 && resolveHours(c, NEXTMON).source === 'base');
  ok('a rest day inside the period stays shut if the period says so',
     calendarHoursOn(c, SAT) === 0);
  ok('activeOverride finds it', (activeOverride(c, TUE) || {}).id === 'ov1');
  ok('and returns nothing outside it', activeOverride(c, NEXTMON) === null);

  const before = addDays(MON, -3);
  ok('before the period the base applies', resolveHours(c, before).source === 'base');
}

console.log('\n--- a closure still beats a surge ---');
{
  const c = cal({
    overrides: [{ id: 'ov', startDate: MON, endDate: FRI, label: 'Push',
      hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 0, hoursSun: 0 }],
    closures: [{ id: 'cl', startDate: TUE, endDate: TUE, reason: 'Public holiday' }]
  });
  ok('the holiday inside the surge is still shut', calendarHoursOn(c, TUE) === 0);
  ok('and is attributed to the closure, not the surge',
     resolveHours(c, TUE).source === 'closure', resolveHours(c, TUE).source);
  ok('surrounding surge days are unaffected',
     calendarHoursOn(c, MON) === 24 && calendarHoursOn(c, FRI) === 24);
}

console.log('\n--- overlapping periods ---');
{
  const c = cal({ overrides: [
    { id: 'a', startDate: MON, endDate: NEXTMON, label: 'Broad', hoursMon: 16, hoursTue: 16, hoursWed: 16, hoursThu: 16, hoursFri: 16, hoursSat: 0, hoursSun: 0 },
    { id: 'b', startDate: TUE, endDate: TUE, label: 'Narrow', hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 0, hoursSun: 0 }
  ]});
  ok('the later entry wins where they overlap',
     calendarHoursOn(c, TUE) === 24 && (activeOverride(c, TUE) || {}).id === 'b');
  ok('the earlier one still applies elsewhere', calendarHoursOn(c, MON) === 16);

  const rev = cal({ overrides: [{ id: 'r', startDate: FRI, endDate: MON, label: 'reversed',
    hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 0, hoursSun: 0 }] });
  ok('a reversed range applies to the start date only, not everything',
     calendarHoursOn(rev, FRI) === 24 && calendarHoursOn(rev, TUE) === 8);
}

console.log('\n--- a surge actually pulls work in ---');
{
  const mk = (overrides) => {
    const db = plant({
      calendars: [{ overrides }],
      equipment: [{ id: 'M1' }],
      items: [{ id: 'W', type: 'finished' }],
      processes: [{ id: 'P1', hours: 120, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
      orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(MON, 90) }]
    });
    return planScheduleFIFO(db, { from: MON });
  };
  const normal = mk([]);
  const pushed = mk([{ id: 'ov', startDate: MON, endDate: addDays(MON, 13), label: 'Push',
    hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 0, hoursSun: 0 }]);

  ok('120 hours at 8h/day takes fifteen working days',
     normal.rows[0].stages[0].workingDays.length === 15,
     String(normal.rows[0].stages[0].workingDays.length));
  ok('at 24h/day it takes five', pushed.rows[0].stages[0].workingDays.length === 5,
     String(pushed.rows[0].stages[0].workingDays.length));
  ok('so the surge finishes it sooner', pushed.rows[0].end < normal.rows[0].end,
     pushed.rows[0].end + ' vs ' + normal.rows[0].end);
}

console.log('\n--- work spanning the end of a surge ---');
{
  // 80 hours starting inside a 2-day surge: 48h at 24/day, then 8h/day after.
  const db = plant({
    calendars: [{ overrides: [{ id: 'ov', startDate: MON, endDate: TUE, label: 'Two days',
      hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 0, hoursSun: 0 }] }],
    equipment: [{ id: 'M1' }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 80, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(MON, 90) }]
  });
  const p = planScheduleFIFO(db, { from: MON });
  const days = p.rows[0].stages[0].workingDays;
  // 24 + 24 = 48 in the surge, 32 left at 8/day = 4 more days => 6 working days
  ok('the rate changes mid-job as the period ends', days.length === 6, String(days.length));
  ok('it starts on the first surge day', days[0] === MON);
}

console.log('\n--- a plant that only runs during campaigns ---');
{
  const c = cal({
    hoursMon: 0, hoursTue: 0, hoursWed: 0, hoursThu: 0, hoursFri: 0,
    overrides: [{ id: 'camp', startDate: MON, endDate: FRI, label: 'Campaign',
      hoursMon: 12, hoursTue: 12, hoursWed: 12, hoursThu: 12, hoursFri: 12, hoursSat: 0, hoursSun: 0 }]
  });
  ok('a zero base with an open period is still workable', calendarIsWorkable(c) === true);
  ok('and a base with nothing anywhere is not', calendarIsWorkable(cal({
    hoursMon: 0, hoursTue: 0, hoursWed: 0, hoursThu: 0, hoursFri: 0 })) === false);
}

console.log('\n--- temporary changes survive export and import ---');
{
  const d = seedData();
  d.operatingCalendars[0].overrides.push({
    id: 'ov9', startDate: '2026-09-07', endDate: '2026-09-18', label: 'Autumn push',
    hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 0, hoursSun: 0
  });
  const bundle = exportCsvBundle(d);
  ok('calendar_overrides is exported', bundle.some(b => b.table === 'calendar_overrides'));
  const files = Object.fromEntries(bundle.map(b => [b.table, b.csv]));
  const { data, report } = importCsvBundle(Object.fromEntries(ENTITIES.map(e => [e, []])), files);
  ok('round trip is clean', report.errors.length === 0, report.errors.slice(0, 3).join('; '));
  const back = defaultCalendar(data);
  ok('the period survives', (back.overrides || []).length === 1 &&
     back.overrides[0].label === 'Autumn push', JSON.stringify(back.overrides));
  const baseMon = defaultCalendar(d).hoursMon;
  ok('and still takes effect on the right dates',
     calendarHoursOn(back, '2026-09-07') === 24 && calendarHoursOn(back, '2026-09-21') === baseMon,
     calendarHoursOn(back, '2026-09-21') + ' vs base ' + baseMon);
}


console.log('\n--- a second pattern assigned to a machine changes its plan ---');
{
  // Same job, same machine. The only difference is which calendar the
  // machine follows, which is exactly what the new picker sets.
  const build = (calendarId, extraCals) => {
    const db = plant({
      calendars: [{ id: 'cal1', name: 'Day shift', isDefault: true }].concat(extraCals || []),
      equipment: [{ id: 'M1', calendarId }],
      items: [{ id: 'W', type: 'finished' }],
      processes: [{ id: 'P1', hours: 48, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
      orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(MON, 60) }]
    });
    db.operatingCalendars.forEach((c, i) => { c.id = i === 0 ? 'cal1' : 'cal2'; });
    return planScheduleFIFO(db, { from: MON });
  };

  const twoShift = { id: 'cal2', name: 'Two shifts', isDefault: false,
    hoursMon: 16, hoursTue: 16, hoursWed: 16, hoursThu: 16, hoursFri: 16, hoursSat: 0, hoursSun: 0 };

  const onDefault = build('', [twoShift]);
  const onSecond  = build('cal2', [twoShift]);

  ok('48h at 8h/day takes six working days',
     onDefault.rows[0].stages[0].workingDays.length === 6,
     String(onDefault.rows[0].stages[0].workingDays.length));
  ok('the same job on a 16h machine takes three',
     onSecond.rows[0].stages[0].workingDays.length === 3,
     String(onSecond.rows[0].stages[0].workingDays.length));
  ok('so assigning the pattern finishes it sooner',
     onSecond.rows[0].end < onDefault.rows[0].end,
     onSecond.rows[0].end + ' vs ' + onDefault.rows[0].end);
  ok('an empty calendarId means the facility default',
     calendarFor(plant({ calendars: [{}], equipment: [{ id: 'M1', calendarId: '' }] }), 'M1').isDefault === true);
}

console.log('\n--- equipment migration ---');
{
  ok('missing calendarId is backfilled as empty',
     normalizeEquipment([{ id: 'a', name: 'x' }])[0].calendarId === '');
  ok('an existing assignment is preserved',
     normalizeEquipment([{ id: 'a', calendarId: 'cal9' }])[0].calendarId === 'cal9');
  ok('a non-array is tolerated', normalizeEquipment(undefined).length === 0);
}

console.log('\n--- calendars survive export/import with equipment assignments ---');
{
  const d = seedData();
  d.operatingCalendars.push({ id: 'cal2', name: 'Two shifts', isDefault: false,
    hoursMon: 16, hoursTue: 16, hoursWed: 16, hoursThu: 16, hoursFri: 16,
    hoursSat: 0, hoursSun: 0, notes: '', closures: [], overrides: [] });
  d.equipment[0].calendarId = 'cal2';

  const bundle = exportCsvBundle(d);
  const eqCsv = bundle.find(b => b.table === 'equipment');
  ok('equipment exports a readable calendar name', eqCsv.columns.includes('calendarName'));

  const files = Object.fromEntries(bundle.map(b => [b.table, b.csv]));
  const { data, report } = importCsvBundle(Object.fromEntries(ENTITIES.map(e => [e, []])), files);
  ok('round trip clean', report.errors.length === 0, report.errors.slice(0, 3).join('; '));
  ok('the added pattern survives alongside the seeded ones',
     data.operatingCalendars.length === d.operatingCalendars.length,
     data.operatingCalendars.length + ' vs ' + d.operatingCalendars.length);
  const back = data.equipment.find(e => e.calendarId);
  ok('the machine assignment survives', !!back);
  ok('and resolves to the right pattern',
     back && calendarFor(data, back.id).name === 'Two shifts',
     back ? calendarFor(data, back.id).name : '');
}


console.log('\n--- available hours: calendar x units ---');
{
  const db = plant({ calendars: [{}], equipment: [{ id: 'M1', units: 1 }, { id: 'M2', units: 3 }] });
  ok('one unit on an 8h day offers 8h', equipmentHoursOn(db, db.equipment[0], MON) === 8);
  ok('three units offer 24h', equipmentHoursOn(db, db.equipment[1], MON) === 24);
  ok('a closed day offers nothing', equipmentHoursOn(db, db.equipment[0], SAT) === 0);

  const ev = equipmentAvailableEvents(db, MON, FRI, 'M1');
  ok('one capacity event per open day', ev.length === 5, String(ev.length));
  ok('and they total the week', ev.reduce((a, e) => a + e.value, 0) === 40);
  ok('a weekend range yields none', equipmentAvailableEvents(db, SAT, SUN, 'M1').length === 0);
}

console.log('\n--- utilisation is measured against those hours ---');
{
  const db = plant({
    calendars: [{}],
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 16, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(MON, 60) }]
  });
  const plan = planScheduleFIFO(db, { from: MON });
  const range = { from: MON, to: FRI, granularity: 'week' };
  const rows = utilizationSeries(db, plan, range);

  ok('one weekly bucket', rows.length === 1, String(rows.length));
  ok('available is the 40-hour week', rows[0].available === 40, String(rows[0].available));
  ok('16 committed hours are counted', rows[0].committed === 16, String(rows[0].committed));
  ok('utilisation is 40%', rows[0].utilization === 40, String(rows[0].utilization));
  ok('not flagged over capacity', rows[0].overCapacity === false);
  ok('the reference line is the available hours', rows[0].target === 40);
}

console.log('\n--- over-capacity is detected ---');
{
  const mk = (n) => plant({
    calendars: [{}],
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 40, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: Array.from({ length: n }, (_, i) => ({
      type: 'finished', item: 'W', qty: 1, due: addDays(MON, 120),
      created: '2026-01-' + String(i + 1).padStart(2, '0') }))
  });
  const db = mk(3);
  const plan = planScheduleFIFO(db, { from: MON });
  const rows = utilizationSeries(db, plan, { from: MON, to: addDays(MON, 27), granularity: 'week' });
  const wk1 = rows[0];
  ok('the first week is fully committed', wk1.committed === 40 && wk1.utilization === 100,
     wk1.committed + 'h / ' + wk1.utilization + '%');
  ok('capacity is never exceeded, because the planner respects it',
     rows.every(r => !r.overCapacity),
     JSON.stringify(rows.map(r => r.utilization)));
  ok('the work spreads across weeks instead',
     rows.filter(r => r.committed > 0).length === 3,
     String(rows.filter(r => r.committed > 0).length));
}

console.log('\n--- actual hours come from logged batches ---');
{
  const db = plant({
    calendars: [{}],
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'intermediate' }]
  });
  db.intermediateProducts[0].lots.push({
    id: 'L1', lotNumber: 'A', date: MON, qty: 1, notes: '',
    sources: [], actualLabor: [], qcChecks: [],
    actualEquipment: [{ id: 'ae1', equipmentId: 'M1', hours: 6 }]
  });
  const ev = equipmentActualEvents(db);
  ok('the logged hours are picked up', ev.length === 1 && ev[0].value === 6);
  ok('dated by the lot', ev[0].date === MON);
  ok('filtering by machine works', equipmentActualEvents(db, 'M2').length === 0);

  const rows = utilizationSeries(db, { rows: [] }, { from: MON, to: FRI, granularity: 'week' });
  ok('actual feeds the chart', rows[0].actual === 6);
  ok('and counts toward utilisation', rows[0].utilization === 15, String(rows[0].utilization));
}

console.log('\n--- a machine on its own pattern gets its own denominator ---');
{
  const twoShift = { id: 'cal2', name: 'Two shifts', isDefault: false,
    hoursMon: 16, hoursTue: 16, hoursWed: 16, hoursThu: 16, hoursFri: 16, hoursSat: 0, hoursSun: 0 };
  const db = plant({
    calendars: [{ id: 'cal1', name: 'Day', isDefault: true }, twoShift],
    equipment: [{ id: 'DAY' }, { id: 'NIGHT', calendarId: 'cal2' }]
  });
  db.operatingCalendars[0].id = 'cal1'; db.operatingCalendars[1].id = 'cal2';
  const range = { from: MON, to: FRI, granularity: 'week' };
  ok('the day-shift machine has a 40h week',
     utilizationSeries(db, { rows: [] }, range, 'DAY')[0].available === 40);
  ok('the two-shift machine has an 80h week',
     utilizationSeries(db, { rows: [] }, range, 'NIGHT')[0].available === 80);
  ok('all-equipment totals both', utilizationSeries(db, { rows: [] }, range)[0].available === 120);
}

console.log('\n--- per-machine roll-up ---');
{
  const d = seedData();
  const plan = planScheduleFIFO(d);
  const span = { from: '2026-05-01', to: '2026-12-31', granularity: 'month' };
  const byEq = utilizationByEquipment(d, plan, span);
  ok('one row per machine', byEq.length === d.equipment.length);
  ok('every row carries a calendar name', byEq.every(r => r.calendar && r.calendar.name));
  ok('sorted busiest first',
     byEq.every((r, i) => i === 0 || (byEq[i-1].utilization || 0) >= (r.utilization || 0)));
  ok('used equals its parts',
     byEq.every(r => Math.abs(r.used - (r.actual + r.committed + r.maintenance)) < 0.01));
  ok('a machine with no calendar hours reports null rather than dividing by zero', (() => {
    const shut = seedData();
    // every pattern must be shut, not just the default - machines may follow another
    shut.operatingCalendars.forEach(c => {
      c.hoursMon = 0; c.hoursTue = 0; c.hoursWed = 0; c.hoursThu = 0;
      c.hoursFri = 0; c.hoursSat = 0; c.hoursSun = 0;
    });
    return utilizationByEquipment(shut, { rows: [] }, span).every(r => r.utilization === null);
  })());
}


console.log('\n--- planning limit line ---');
{
  const db = plant({
    calendars: [{}],
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'intermediate' }]
  });
  // 36 recorded hours in a 40-hour week = 90% utilisation
  db.intermediateProducts[0].lots.push({
    id: 'L1', lotNumber: 'A', date: MON, qty: 1, notes: '',
    sources: [], actualLabor: [], qcChecks: [],
    actualEquipment: [{ id: 'ae', equipmentId: 'M1', hours: 36 }]
  });
  const range = { from: MON, to: FRI, granularity: 'week' };
  const at85 = utilizationSeries(db, { rows: [] }, range, '', 85)[0];
  const at95 = utilizationSeries(db, { rows: [] }, range, '', 95)[0];
  const at100 = utilizationSeries(db, { rows: [] }, range, '', 100)[0];

  ok('the limit is a fraction of available', at85.limit === 34 && at95.limit === 38,
     at85.limit + ' / ' + at95.limit);
  ok('utilisation is unaffected by the limit', at85.utilization === 90 && at95.utilization === 90);
  ok('90% breaches an 85% limit', at85.overLimit === true);
  ok('but not a 95% limit', at95.overLimit === false);
  ok('and never breaches capacity', at85.overCapacity === false && at95.overCapacity === false);
  ok('a 100% limit equals the ceiling', at100.limit === at100.available);
  ok('omitting the limit defaults to 100%',
     utilizationSeries(db, { rows: [] }, range)[0].limit === 40);

  ok('the bar label value is the utilisation figure', at85.utilization === 90);
}

console.log('\n--- limit vs capacity are independent signals ---');
{
  const db = plant({
    calendars: [{}],
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'intermediate' }]
  });
  // 48 recorded hours in a 40-hour week: physically impossible, and logged anyway
  db.intermediateProducts[0].lots.push({
    id: 'L2', lotNumber: 'B', date: MON, qty: 1, notes: '',
    sources: [], actualLabor: [], qcChecks: [],
    actualEquipment: [{ id: 'ae2', equipmentId: 'M1', hours: 48 }]
  });
  const r = utilizationSeries(db, { rows: [] }, { from: MON, to: FRI, granularity: 'week' }, '', 85)[0];
  ok('over capacity is flagged', r.overCapacity === true);
  ok('over limit is flagged too', r.overLimit === true);
  ok('utilisation exceeds 100%', r.utilization === 120, String(r.utilization));
}

console.log('\n--- roll-up carries the limit breach count ---');
{
  const d = seedData();
  const plan = planScheduleFIFO(d);
  const span = { from: '2026-07-01', to: '2026-12-31', granularity: 'month' };
  const strict = utilizationByEquipment(d, plan, span, 5);
  const loose = utilizationByEquipment(d, plan, span, 100);
  ok('a very low limit is breached by busy machines',
     strict.some(r => r.overLimitPeriods > 0));
  ok('a 100% limit is breached far less',
     loose.reduce((s, r) => s + r.overLimitPeriods, 0) <=
     strict.reduce((s, r) => s + r.overLimitPeriods, 0));
  ok('capacity breaches are unaffected by the limit',
     JSON.stringify(strict.map(r => r.overPeriods)) ===
     JSON.stringify(loose.map(r => r.overPeriods)));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
