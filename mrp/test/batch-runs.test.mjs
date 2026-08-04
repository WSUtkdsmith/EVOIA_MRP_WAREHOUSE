// The batch run clock, and the SOP attached to a process.
//
// Actual production time used to be typed in after the fact, which makes
// actual-vs-planned an estimate wearing a measurement's clothes: the form
// pre-filled the planned hours, so leaving it alone made the two agree by
// construction. This clocks it instead, following the timing model the
// warehouse already runs on orders — start, stop, and a corrections path that
// will not let a time change without saying why.

import { seedData, tx, repo, runElapsedMs, runElapsedHours, fmtDuration,
         activeBatchRun, unloggedBatchRuns, nextBatchRunRef, runHoursForBatch,
         processSop } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

const plant = () => {
  const D = seedData();
  D.batchRuns = [];
  return { D, proc: D.processes[0] };
};
const at = (run, hours) =>
  new Date(new Date(run.startedAt).getTime() + hours * 3600000).toISOString();

console.log('\n--- the clock ---');
{
  const { D, proc } = plant();
  const r = tx.startBatchRun(D, { processId: proc.id, startedBy: 'AB', operatorCount: 2 });
  ok('a run starts', r.ok === true);
  ok('with a reference of its own', r.run.reference === 'RUN-0001');
  ok('and is the active run for that process', activeBatchRun(D, proc.id).id === r.run.id);
  ok('it is not yet loggable — nothing has finished', unloggedBatchRuns(D, proc.id).length === 0);

  // A second Start is a mis-click far more often than two genuine concurrent
  // runs, and silently opening one would double the hours landing on the batch.
  const dup = tx.startBatchRun(D, { processId: proc.id });
  ok('a second clock on the same process is refused', dup.ok === false);
  ok('and says why rather than failing quietly', /already clocked in/.test(dup.error));

  const other = D.processes[1];
  ok('but a different process can run at the same time',
     tx.startBatchRun(D, { processId: other.id }).ok === true);
  ok('each process has its own clock',
     activeBatchRun(D, other.id).id !== activeBatchRun(D, proc.id).id);
  ok('and asking for no process finds any running one', !!activeBatchRun(D));

  ok('an unknown process cannot be started',
     tx.startBatchRun(D, { processId: 'nope' }).ok === false);
}

console.log('\n--- finishing ---');
{
  const { D, proc } = plant();
  const r = tx.startBatchRun(D, { processId: proc.id, operatorCount: 2 }).run;
  const f = tx.finishBatchRun(D, { runId: r.id, finishedAt: at(r, 2.5), finishedBy: 'CD' });
  ok('a run finishes', f.ok === true && f.run.status === 'Finished');
  ok('elapsed comes out of the timestamps', runElapsedHours(f.run) === 2.5);
  ok('and who stopped it is kept', f.run.finishedBy === 'CD');
  ok('it is now waiting to be logged', unloggedBatchRuns(D, proc.id).length === 1);
  ok('and no longer the active run', activeBatchRun(D, proc.id) === null);

  ok('finishing twice is refused', tx.finishBatchRun(D, { runId: r.id }).ok === false);
  ok('an unknown run cannot be finished', tx.finishBatchRun(D, { runId: 'nope' }).ok === false);

  const { D: D2, proc: p2 } = plant();
  const r2 = tx.startBatchRun(D2, { processId: p2.id }).run;
  ok('a finish before the start is refused, not stored as negative time',
     tx.finishBatchRun(D2, { runId: r2.id, finishedAt: at(r2, -1) }).ok === false);
}

console.log('\n--- elapsed is derived, never stored ---');
{
  // A stored duration and a stored pair of timestamps can disagree, and then
  // nobody knows which is true. The timestamps are the record.
  const { D, proc } = plant();
  const r = tx.startBatchRun(D, { processId: proc.id }).run;
  ok('a running clock measures against now, not zero', runElapsedMs(r) >= 0);
  tx.finishBatchRun(D, { runId: r.id, finishedAt: at(r, 1) });
  ok('a finished one is fixed', runElapsedHours(r) === 1);
  ok('and stays fixed when asked again', runElapsedHours(r) === 1);

  ok('no run is no time', runElapsedMs(null) === 0);
  ok('a run with no start is no time', runElapsedMs({}) === 0);
  ok('an unparseable start does not produce NaN', runElapsedMs({ startedAt: 'rubbish' }) === 0);
  ok('an unparseable finish does not either',
     runElapsedMs({ startedAt: '2026-08-01T00:00:00.000Z', finishedAt: 'rubbish' }) === 0);

  ok('durations read as hours and minutes', fmtDuration(3 * 3600000 + 7 * 60000) === '3h 07m');
  ok('under an hour drops the hours', fmtDuration(42 * 60000) === '42m');
  ok('nothing is 0m, not blank', fmtDuration(0) === '0m');
  ok('negative time is clamped rather than shown', fmtDuration(-5000) === '0m');
}

console.log('\n--- typing the times, which is allowed but never silent ---');
{
  // The clock gets forgotten at the start of a run and left going over lunch.
  // Both are normal, and a system that cannot express them gets worked around
  // instead of used.
  const { D, proc } = plant();
  const r = tx.startBatchRun(D, { processId: proc.id, operatorCount: 1 }).run;
  tx.finishBatchRun(D, { runId: r.id, finishedAt: at(r, 5) });
  const clockedStart = r.startedAt, clockedFinish = r.finishedAt;

  ok('a correction without a reason is refused',
     tx.setBatchRunTimes(D, { runId: r.id, startedAt: clockedStart, finishedAt: at(r, 3) }).ok === false);
  ok('an empty reason counts as none',
     tx.setBatchRunTimes(D, { runId: r.id, startedAt: clockedStart, finishedAt: at(r, 3), reason: '   ' }).ok === false);
  ok('the run is untouched by a refused correction', runElapsedHours(r) === 5);

  const c = tx.setBatchRunTimes(D, { runId: r.id, startedAt: clockedStart,
    finishedAt: at(r, 3), reason: 'clock left running through the break', operatorCount: 2 });
  ok('with a reason it goes through', c.ok === true);
  ok('and the time changes', runElapsedHours(r) === 3);
  ok('it is marked as entered by hand', r.manual === true);
  ok('the reason is kept, not just demanded', /through the break/.test(r.manualReason));
  ok('and the clocked times survive alongside it',
     r.originalStartedAt === clockedStart && r.originalFinishedAt === clockedFinish);
  ok('operator count can be corrected too', r.operatorCount === 2);

  // A second correction must not erase the evidence of the first.
  tx.setBatchRunTimes(D, { runId: r.id, startedAt: clockedStart, finishedAt: at(r, 4),
    reason: 'second look at the batch sheet' });
  ok('a later correction keeps the original clocked times, not the previous correction',
     r.originalFinishedAt === clockedFinish);
  ok('while the reason moves on', /second look/.test(r.manualReason));

  ok('a finish before the start is still refused when typed',
     tx.setBatchRunTimes(D, { runId: r.id, startedAt: clockedFinish, finishedAt: clockedStart,
       reason: 'typo' }).ok === false);
  ok('a start is required', tx.setBatchRunTimes(D, { runId: r.id, startedAt: '', reason: 'x' }).ok === false);
  ok('an unknown run cannot be corrected',
     tx.setBatchRunTimes(D, { runId: 'nope', startedAt: clockedStart, reason: 'x' }).ok === false);
}

// A run recorded entirely by hand: no finish yet means it is still open.
{
  const { D, proc } = plant();
  const r = tx.startBatchRun(D, { processId: proc.id }).run;
  const res = tx.setBatchRunTimes(D, { runId: r.id, startedAt: r.startedAt, finishedAt: '',
    reason: 'started late, still running' });
  ok('clearing the finish reopens the run', res.ok === true && r.status === 'Running');
  ok('and it is the active run again', activeBatchRun(D, proc.id).id === r.id);
}

console.log('\n--- equipment hours and labour hours are not the same number ---');
{
  // A machine running two hours is two equipment-hours however many people
  // watched it; two operators on that run is four labour-hours. Typing both by
  // hand is exactly where that distinction used to get lost.
  const { D, proc } = plant();
  const r = tx.startBatchRun(D, { processId: proc.id, operatorCount: 2 }).run;
  tx.finishBatchRun(D, { runId: r.id, finishedAt: at(r, 2) });

  const h = runHoursForBatch(r, 3);
  ok('elapsed is the run', h.elapsedHours === 2);
  ok('each machine ran for the run, not a share of it', h.equipmentHoursEach === 2);
  ok('three machines for two hours is six equipment hours', h.equipmentHoursTotal === 6);
  ok('each operator worked the run', h.laborHoursEach === 2);
  ok('two operators for two hours is four labour hours', h.laborHoursTotal === 4);

  ok('no equipment is no equipment hours', runHoursForBatch(r, 0).equipmentHoursTotal === 0);
  const solo = runHoursForBatch({ startedAt: r.startedAt, finishedAt: r.finishedAt }, 1);
  ok('an unstated operator count is one, not zero', solo.operators === 1 && solo.laborHoursTotal === 2);
}

console.log('\n--- the run and the batch it produced ---');
{
  const { D, proc } = plant();
  const r = tx.startBatchRun(D, { processId: proc.id, operatorCount: 2 }).run;
  tx.finishBatchRun(D, { runId: r.id, finishedAt: at(r, 2) });
  ok('the run is offered to the batch log', unloggedBatchRuns(D, proc.id)[0].id === r.id);

  const out = proc.outputs[0];
  tx.logProductionBatch(D, {
    processId: proc.id, date: '2026-08-12', notes: '', sources: [],
    outputs: [{ outputId: out.id, lotNumber: 'RUN-LOT-1', qty: 5, qcChecks: [] }],
    actualEquipment: [], actualLabor: [], runId: r.id
  });
  ok('logging stamps the batch onto the run', !!r.batchId);
  ok('so it is not offered a second time', unloggedBatchRuns(D, proc.id).length === 0);

  // A stale id in a form is not authority to close someone else's clock.
  const other = D.processes[1];
  const r2 = tx.startBatchRun(D, { processId: other.id }).run;
  tx.finishBatchRun(D, { runId: r2.id, finishedAt: at(r2, 1) });
  tx.logProductionBatch(D, {
    processId: proc.id, date: '2026-08-12', notes: '', sources: [],
    outputs: [{ outputId: out.id, lotNumber: 'RUN-LOT-2', qty: 5, qcChecks: [] }],
    actualEquipment: [], actualLabor: [], runId: r2.id
  });
  ok("a run belonging to another process is not claimed", !r2.batchId);

  ok('logging with no run at all still works',
     tx.logProductionBatch(D, {
       processId: proc.id, date: '2026-08-12', notes: '', sources: [],
       outputs: [{ outputId: out.id, lotNumber: 'RUN-LOT-3', qty: 5, qcChecks: [] }],
       actualEquipment: [], actualLabor: []
     }).length === 1);
}

console.log('\n--- cancelling ---');
{
  const { D, proc } = plant();
  const r = tx.startBatchRun(D, { processId: proc.id }).run;
  ok('a run can be abandoned', tx.cancelBatchRun(D, { runId: r.id, reason: 'wrong process' }).ok === true);
  ok('and stops being the active clock', activeBatchRun(D, proc.id) === null);
  ok('and is not offered to the batch log', unloggedBatchRuns(D, proc.id).length === 0);

  const r2 = tx.startBatchRun(D, { processId: proc.id }).run;
  tx.finishBatchRun(D, { runId: r2.id, finishedAt: at(r2, 1) });
  r2.batchId = 'someBatch';
  ok('a run already written up as a batch cannot be cancelled out from under it',
     tx.cancelBatchRun(D, { runId: r2.id }).ok === false);
}

console.log('\n--- references ---');
{
  const { D, proc } = plant();
  ok('the first reference is RUN-0001', nextBatchRunRef(D) === 'RUN-0001');
  tx.startBatchRun(D, { processId: proc.id });
  ok('and the next is RUN-0002', nextBatchRunRef(D) === 'RUN-0002');
  // Deleting a run must not hand its number to the next one.
  D.batchRuns.push({ id: 'x', reference: 'RUN-0002', processId: proc.id, status: 'Cancelled' });
  ok('a taken reference is skipped rather than reused', nextBatchRunRef(D) === 'RUN-0003');
}

console.log('\n--- the SOP on a process ---');
{
  const { D, proc } = plant();
  ok('a process with no document says so', processSop(proc) === null);
  ok('a missing process does not throw', processSop(null) === null);

  repo.upsert(D, 'processes', proc.id, {
    ...proc, sopKey: 'lot_attachment:abc', sopFileName: 'SOP-014.pdf',
    sopFileType: 'application/pdf', sopFileSize: 91234, sopVersion: 'Rev C',
    sopUploadedAt: '2026-08-12'
  });
  const sop = processSop(repo.find(D, 'processes', proc.id));
  ok('once attached it reports the key storage needs', sop.key === 'lot_attachment:abc');
  ok('and the name a person recognises', sop.fileName === 'SOP-014.pdf');
  ok('and the revision they were working to', sop.version === 'Rev C');

  // Which revision is current is the quality system's business, not ours -
  // free text records what the operator actually had rather than guessing a
  // format and being wrong.
  repo.upsert(D, 'processes', proc.id, { ...repo.find(D, 'processes', proc.id), sopVersion: '2024-11-02 draft' });
  ok('any revision convention is accepted',
     processSop(repo.find(D, 'processes', proc.id)).version === '2024-11-02 draft');

  const bare = processSop({ sopKey: 'k' });
  ok('a key with no filename still opens, under a sensible label', bare.fileName === 'SOP');
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
