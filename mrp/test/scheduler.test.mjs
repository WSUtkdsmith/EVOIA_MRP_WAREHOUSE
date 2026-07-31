import { seedData, planScheduleFIFO, buildStageGraph, buildCapacity, capacityFree,
         earliestSlot, fifoOrder, calendarGrid, shiftMonth, monthLabel,
         datesInRange, daysBetweenISO, ENTITIES } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

const addDays = (s, n) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const TODAY = new Date().toISOString().slice(0, 10);

/* A plant built from scratch, so every expected date is arithmetic
   rather than a guess about the seed data. */
function plant(spec) {
  const db = Object.fromEntries(ENTITIES.map(e => [e, []]));
  (spec.equipment || []).forEach(e =>
    db.equipment.push({ id: e.id, name: e.id, code: e.id, units: e.units, notes: '' }));
  (spec.items || []).forEach(it =>
    db[it.type === 'finished' ? 'finishedGoods' : 'intermediateProducts'].push({
      id: it.id, name: it.id, sku: it.id, unit: 'ea', notes: '',
      composition: [], autoComposition: false, hazardClass: 'N/A', lots: []
    }));
  (spec.processes || []).forEach(p =>
    db.processes.push({
      id: p.id, name: p.id, sku: p.id, notes: '',
      productionTimeHours: p.hours,
      inputs: (p.inputs || []).map(i => ({ id: i.id || (p.id + '-in'), itemType: i.type, itemId: i.item, qty: i.qty })),
      equipment: (p.equipment || []).map(e => ({ id: p.id + '-' + e, equipmentId: e, status: 'Required' })),
      outputs: (p.outputs || []).map(o => ({ id: p.id + '-out-' + o.item, itemType: o.type, itemId: o.item, qtyPerBatch: o.perBatch, costOverride: '' }))
    }));
  (spec.orders || []).forEach((o, i) =>
    db.schedule.push({
      id: 'ord' + i, productType: o.type, productId: o.item, qty: o.qty,
      dueDate: o.due, status: o.status || 'Planned', notes: '', customerId: '',
      completedDate: '', createdDate: o.created || '', fulfillmentLots: []
    }));
  (spec.maintenance || []).forEach((mt, i) =>
    db.maintenance.push({
      id: 'mt' + i, equipmentId: mt.equipment, title: mt.title || 'Service', type: 'Preventive',
      startDate: mt.start, durationHours: mt.hours, recurrence: mt.recurrence || 'None',
      recurUntil: '', status: 'Scheduled', notes: ''
    }));
  return db;
}

console.log('\n--- one order, one machine ---');
{
  const db = plant({
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 48, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 30) }]
  });
  const plan = planScheduleFIFO(db, { from: TODAY });
  ok('one row produced', plan.rows.length === 1);
  const r = plan.rows[0];
  ok('starts today', r.start === TODAY, r.start);
  ok('48h occupies 2 days', r.end === addDays(TODAY, 1), r.start + ' -> ' + r.end);
  ok('not late', !r.late);
  ok('machine load recorded', (plan.load.M1 || []).length === 1);
}

console.log('\n--- FIFO: second order waits for the first ---');
{
  const db = plant({
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 48, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [
      { type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 30), created: '2026-01-01' },
      { type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 30), created: '2026-01-02' }
    ]
  });
  const p = planScheduleFIFO(db, { from: TODAY });
  ok('first order starts today', p.rows[0].start === TODAY);
  ok('second starts after the first ends', p.rows[1].start === addDays(TODAY, 2),
     p.rows[0].start + '->' + p.rows[0].end + ' then ' + p.rows[1].start);
  ok('they do not overlap', p.rows[0].end < p.rows[1].start);
}

console.log('\n--- arrival order decides, not due date ---');
{
  const mk = (created, due) => ({ type: 'finished', item: 'W', qty: 1, due, created });
  const db = plant({
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 24, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [
      mk('2026-01-01', addDays(TODAY, 90)),   // arrived first, due last
      mk('2026-01-02', addDays(TODAY, 10))    // arrived second, due first
    ]
  });
  const p = planScheduleFIFO(db, { from: TODAY });
  ok('the earlier arrival is scheduled first even though it is due later',
     p.rows[0].entry.createdDate === '2026-01-01' && p.rows[0].start === TODAY,
     JSON.stringify(p.rows.map(r => [r.entry.createdDate, r.start])));
  ok('that is FIFO, not earliest-due-date', p.rows[1].start === addDays(TODAY, 1));
}

console.log('\n--- parallel units run concurrently ---');
{
  const mk = (i) => ({ type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 30), created: '2026-01-0' + i });
  const db = plant({
    equipment: [{ id: 'M1', units: 3 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 24, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [mk(1), mk(2), mk(3), mk(4)]
  });
  const p = planScheduleFIFO(db, { from: TODAY });
  const starts = p.rows.map(r => r.start);
  ok('three orders start the same day on a 3-unit machine',
     starts.slice(0, 3).every(s => s === TODAY), JSON.stringify(starts));
  ok('the fourth is pushed to the next day', starts[3] === addDays(TODAY, 1), starts[3]);
}

console.log('\n--- multi-stage: sub-assembly finishes before final assembly starts ---');
{
  const db = plant({
    equipment: [{ id: 'SUB', units: 1 }, { id: 'ASM', units: 1 }],
    items: [{ id: 'PART', type: 'intermediate' }, { id: 'PROD', type: 'finished' }],
    processes: [
      { id: 'MAKEPART', hours: 24, equipment: ['SUB'], outputs: [{ type: 'intermediate', item: 'PART', perBatch: 1 }] },
      { id: 'ASSEMBLE', hours: 24, equipment: ['ASM'],
        inputs: [{ type: 'intermediate', item: 'PART', qty: 1 }],
        outputs: [{ type: 'finished', item: 'PROD', perBatch: 1 }] }
    ],
    orders: [{ type: 'finished', item: 'PROD', qty: 1, due: addDays(TODAY, 30) }]
  });
  const p = planScheduleFIFO(db, { from: TODAY });
  const r = p.rows[0];
  ok('two stages planned', r.stages.length === 2, JSON.stringify(r.stages.map(s => s.processName)));
  const part = r.stages.find(s => s.processName === 'MAKEPART');
  const asm = r.stages.find(s => s.processName === 'ASSEMBLE');
  ok('sub-assembly is scheduled first', part.start === TODAY, part.start);
  ok('assembly starts only after the part is finished', asm.start > part.end,
     part.start + '->' + part.end + ' then ' + asm.start);
  ok('order spans both stages', r.start === part.start && r.end === asm.end);
}

console.log('\n--- maintenance blocks the machine ---');
{
  const db = plant({
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 24, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 30) }],
    maintenance: [{ equipment: 'M1', start: TODAY, hours: 48 }]
  });
  const p = planScheduleFIFO(db, { from: TODAY });
  ok('production waits until maintenance clears', p.rows[0].start > TODAY,
     'started ' + p.rows[0].start + ' with maintenance on ' + TODAY);
  ok('maintenance shows in the machine load',
     (p.load.M1 || []).some(w => w.kind === 'maintenance'));
}

console.log('\n--- lateness is measured, not hidden ---');
{
  const db = plant({
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 240, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 2) }]
  });
  const p = planScheduleFIFO(db, { from: TODAY });
  ok('order is flagged late', p.rows[0].late === true);
  ok('lateness counted in days', p.rows[0].lateDays === 7,
     'end ' + p.rows[0].end + ' vs due ' + p.rows[0].dueDate + ' = ' + p.rows[0].lateDays);
  ok('plan summarises late count', p.lateCount === 1 && p.worstLateDays === 7);
}

console.log('\n--- batch scaling is a choice, and it matters ---');
{
  const db = plant({
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 24, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [{ type: 'finished', item: 'W', qty: 5, due: addDays(TODAY, 30) }]
  });
  const perRun = planScheduleFIFO(db, { from: TODAY, scaleByBatch: false });
  const perBatch = planScheduleFIFO(db, { from: TODAY, scaleByBatch: true });
  ok('per-run: 5 units still take one day', perRun.rows[0].end === TODAY, perRun.rows[0].end);
  ok('per-batch: 5 units take five days', perBatch.rows[0].end === addDays(TODAY, 4), perBatch.rows[0].end);
  ok('default is per-run, matching the rest of the app',
     planScheduleFIFO(db, { from: TODAY }).rows[0].end === perRun.rows[0].end);
  ok('the plan reports which model produced it', perBatch.scaleByBatch === true);
}

console.log('\n--- only open orders are planned ---');
{
  const db = plant({
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 24, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [
      { type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 10), status: 'Planned' },
      { type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 10), status: 'Complete' },
      { type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 10), status: 'Cancelled' },
      { type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 10), status: 'In progress' }
    ]
  });
  const p = planScheduleFIFO(db, { from: TODAY });
  ok('complete and cancelled runs are excluded', p.rows.length === 2, 'got ' + p.rows.length);
  ok('planned and in-progress are included',
     p.rows.every(r => r.status !== 'Complete' && r.status !== 'Cancelled'));
}

console.log('\n--- degenerate input does not hang or crash ---');
{
  const empty = Object.fromEntries(ENTITIES.map(e => [e, []]));
  ok('empty database plans nothing', planScheduleFIFO(empty, { from: TODAY }).rows.length === 0);

  const orphan = plant({
    items: [{ id: 'W', type: 'finished' }],
    orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 10) }]
  });
  const p = planScheduleFIFO(orphan, { from: TODAY });
  ok('an order with no process is reported, not dropped',
     p.rows.length === 1 && p.rows[0].unplaceable && /No process/.test(p.rows[0].reason),
     JSON.stringify(p.rows[0].reason));

  // circular: A needs B, B needs A
  const loop = plant({
    equipment: [{ id: 'M1', units: 1 }],
    items: [{ id: 'A', type: 'intermediate' }, { id: 'B', type: 'intermediate' }],
    processes: [
      { id: 'PA', hours: 24, equipment: ['M1'], inputs: [{ type: 'intermediate', item: 'B', qty: 1 }], outputs: [{ type: 'intermediate', item: 'A', perBatch: 1 }] },
      { id: 'PB', hours: 24, equipment: ['M1'], inputs: [{ type: 'intermediate', item: 'A', qty: 1 }], outputs: [{ type: 'intermediate', item: 'B', perBatch: 1 }] }
    ],
    orders: [{ type: 'intermediate', item: 'A', qty: 1, due: addDays(TODAY, 30) }]
  });
  const start = Date.now();
  const lp = planScheduleFIFO(loop, { from: TODAY });
  ok('a circular bill of materials terminates', Date.now() - start < 4000 && lp.rows.length === 1);

  const noEq = plant({
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 24, equipment: [], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: [{ type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 10) }]
  });
  ok('a process needing no equipment schedules immediately',
     planScheduleFIFO(noEq, { from: TODAY }).rows[0].start === TODAY);
}

console.log('\n--- capacity is never oversubscribed ---');
{
  const mk = (i) => ({ type: 'finished', item: 'W', qty: 1, due: addDays(TODAY, 60), created: '2026-01-' + String(i).padStart(2, '0') });
  const db = plant({
    equipment: [{ id: 'M1', units: 2 }],
    items: [{ id: 'W', type: 'finished' }],
    processes: [{ id: 'P1', hours: 72, equipment: ['M1'], outputs: [{ type: 'finished', item: 'W', perBatch: 1 }] }],
    orders: Array.from({ length: 12 }, (_, i) => mk(i + 1))
  });
  const p = planScheduleFIFO(db, { from: TODAY });
  const perDay = {};
  p.rows.forEach(r => r.stages.forEach(s =>
    datesInRange(s.start, s.end).forEach(d => { perDay[d] = (perDay[d] || 0) + 1; })));
  const over = Object.entries(perDay).filter(([, n]) => n > 2);
  ok('no day exceeds the 2 available units', over.length === 0,
     over.slice(0, 4).map(([d, n]) => d + '=' + n).join(', '));
  ok('all twelve orders were placed', p.rows.every(r => !r.unplaceable));
  ok('starts are non-decreasing in arrival order',
     p.rows.every((r, i) => i === 0 || r.start >= p.rows[i - 1].start));
}

console.log('\n--- calendar grid ---');
{
  const cells = calendarGrid('2026-07');
  ok('always six weeks', cells.length === 42);
  ok('starts on a Monday', new Date(cells[0].date + 'T00:00:00Z').getUTCDay() === 1,
     cells[0].date);
  ok('contains every day of the month',
     cells.filter(c => c.inMonth).length === 31, cells.filter(c => c.inMonth).length);
  ok('leading days marked out of month', cells[0].inMonth === false || cells[0].day === 1);
  ok('February 2024 has 29 in-month days',
     calendarGrid('2024-02').filter(c => c.inMonth).length === 29);
  ok('month navigation wraps the year',
     shiftMonth('2026-12', 1) === '2027-01' && shiftMonth('2026-01', -1) === '2025-12');
  ok('month label reads naturally', monthLabel('2026-07') === 'Jul 2026', monthLabel('2026-07'));
  ok('dates in range are inclusive', datesInRange('2026-01-01', '2026-01-03').length === 3);
  ok('reversed range is empty', datesInRange('2026-01-03', '2026-01-01').length === 0);
  ok('daysBetween is signed', daysBetweenISO('2026-01-01', '2026-01-11') === 10 &&
     daysBetweenISO('2026-01-11', '2026-01-01') === -10);
}

console.log('\n--- runs against the real seed data ---');
{
  const d = seedData();
  const p = planScheduleFIFO(d, { from: TODAY });
  ok('seed data plans without error', p.rows.length > 0);
  ok('every planned order has a start and end',
     p.rows.filter(r => !r.unplaceable).every(r => r.start && r.end && r.start <= r.end));
  ok('machine load is populated', Object.keys(p.load).length > 0);
  console.log('  NOTE  ' + p.rows.length + ' orders, ' + p.lateCount + ' late, ' +
    p.unplaceableCount + ' unplaceable (per-run timing)');
  const pb = planScheduleFIFO(d, { from: TODAY, scaleByBatch: true });
  console.log('  NOTE  with batch scaling: ' + pb.lateCount + ' late, ' +
    pb.unplaceableCount + ' unplaceable, worst ' + pb.worstLateDays + ' days');
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
