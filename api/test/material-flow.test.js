// Pure-logic tests for the warehouse's material-flow worklist.
'use strict';
const F = require('../_material-flow');

let passed = 0, failed = 0;
function eq(a, e, m) {
  const A = JSON.stringify(a), E = JSON.stringify(e);
  if (A === E) passed++; else { failed++; console.error(`FAIL: ${m}\n  expected ${E}\n  got      ${A}`); }
}
const ok = (c, m) => eq(!!c, true, m);

const base = () => ({
  rawMaterials: [{
    id: 'rm1', name: 'Green coffee', sku: 'GC-1', unit: 'kg',
    packagings: [{ id: 'pk', sku: 'GC-1-60KG', packageType: 'sack', size: '60 kg', isDefault: true }],
    lots: [
      { id: 'A', lotNumber: 'A', qty: 500, expirationDate: '2027-06-01' },
      { id: 'B', lotNumber: 'B', qty: 500, expirationDate: '2026-09-01' },
      { id: 'C', lotNumber: 'C', qty: 500, expirationDate: '' },
      { id: 'D', lotNumber: 'D', qty: 0, expirationDate: '2026-01-01' },
    ],
  }],
  materialRequests: [], materialReturns: [],
});
const request = (over) => ({
  id: 'r1', reference: 'MR-0001', status: 'Requested', requestedFor: 'Run 42',
  requestedDate: '2026-08-01',
  lines: [{ id: 'L1', itemType: 'raw', itemId: 'rm1', qty: 120, lineStatus: 'Pending' }],
  ...over,
});

// --- FEFO ------------------------------------------------------------------
{
  const d = base();
  const c = F.fefoCandidates(d, 'raw', 'rm1');
  eq(c.map((x) => x.lotNumber), ['B', 'A', 'C'],
     'earliest expiry first, undated last, empty lots not offered');
  eq(c[0].qty, 500, 'a candidate carries how much it holds');

  d.rawMaterials[0].lots[1].inProcess = true;
  eq(F.fefoCandidates(d, 'raw', 'rm1').map((x) => x.lotNumber), ['A', 'C'],
     'a lot out with Operations is not offered');

  const d2 = base();
  d2.materialRequests = [request({ lines: [{ id: 'L9', itemType: 'raw', itemId: 'rm1', qty: 10, lotId: 'B', lineStatus: 'Staged' }] })];
  eq(F.fefoCandidates(d2, 'raw', 'rm1').map((x) => x.lotNumber), ['A', 'C'],
     'a lot already promised to a staged line is not offered twice');
  eq(F.fefoCandidates(base(), 'raw', 'nope'), [], 'an unknown item has no candidates');
}

// --- the pick list ---------------------------------------------------------
{
  const d = base();
  d.materialRequests = [request()];
  const f = F.deriveMaterialFlow(d);
  eq(f.counts.openRequests, 1, 'a submitted request is offered to the warehouse');
  eq(f.counts.linesToPick, 1, 'and its line is pending a pick');
  const l = f.requests[0].lines[0];
  eq(l.itemName, 'Green coffee', 'the line names the material');
  eq(l.sku, 'GC-1-60KG', 'and the container it is stored in');
  eq(l.fefoSuggestion.lotNumber, 'B', 'FEFO is suggested');
  eq(l.alternatives.map((a) => a.lotNumber), ['A', 'C'], 'alternatives are offered so the picker can substitute');
  eq(l.stagedLot, null, 'nothing is staged yet');

  d.materialRequests[0].status = 'Draft';
  eq(F.deriveMaterialFlow(d).counts.openRequests, 0, 'a draft has been asked of nobody');
  d.materialRequests[0].status = 'Cancelled';
  eq(F.deriveMaterialFlow(d).counts.openRequests, 0, 'a cancelled request is not picked');
}

// --- the door --------------------------------------------------------------
{
  const d = base();
  d.materialRequests = [request({
    lines: [{ id: 'L1', itemType: 'raw', itemId: 'rm1', qty: 120, lotId: 'B', lineStatus: 'Staged', position: 'TP3' }],
  })];
  const f = F.deriveMaterialFlow(d);
  eq(f.counts.freePositions, 5, 'a staged line holds a position');
  eq(f.positions.find((p) => p.position === 'TP3').held.direction, 'out',
     'a request is moving out to Operations');
  eq(f.positions.find((p) => p.position === 'TP1').held, null, 'other positions stay free');
  eq(f.requests[0].lines[0].stagedLot.lotNumber, 'B', 'the staged line reports the lot picked');
  eq(f.requests[0].lines[0].fefoSuggestion, null, 'a line already picked needs no suggestion');
  eq(f.counts.linesToPick, 0, 'and is no longer waiting to be picked');

  d.materialReturns = [{
    id: 'ret1', reference: 'RET-0001', returnType: 'leftover', status: 'Returned',
    lines: [{ id: 'RL1', itemType: 'raw', itemId: 'rm1', lotId: 'B', qty: 40, lineStatus: 'Staged', position: 'TP4', suggestedLocation: 'M1A1' }],
  }];
  const g = F.deriveMaterialFlow(d);
  eq(g.counts.freePositions, 4, 'both directions share the same six positions — one door');
  eq(g.positions.find((p) => p.position === 'TP4').held.direction, 'in', 'a return is coming back in');
  eq(g.returns[0].lines[0].suggestedLocation, 'M1A1',
     'a leftover says where it came from, so it goes straight back');
  eq(g.returns[0].returnType, 'leftover', 'the flavour is stated before anyone walks to the floor');
}

// --- a full door is called out, not left to be inferred --------------------
{
  const d = base();
  d.materialRequests = ['TP1', 'TP2', 'TP3', 'TP4', 'TP5', 'TP6'].map((pos, i) => request({
    id: 'r' + i, reference: 'MR-' + i,
    lines: [{ id: 'L' + i, itemType: 'raw', itemId: 'rm1', qty: 10, lotId: 'A', lineStatus: 'Staged', position: pos }],
  })).concat([request({ id: 'rx', reference: 'MR-X' })]);
  const f = F.deriveMaterialFlow(d);
  eq(f.counts.freePositions, 0, 'the door is full');
  eq(f.counts.linesToPick, 1, 'and a line is still waiting');
  eq(f.counts.doorFull, true, 'which is reported plainly rather than left to be worked out');

  const d2 = base();
  d2.materialRequests = [request()];
  eq(F.deriveMaterialFlow(d2).counts.doorFull, false, 'a free door is not flagged as full');
}

// --- custody ---------------------------------------------------------------
{
  const d = base();
  d.rawMaterials[0].lots[0].inProcess = true;
  d.rawMaterials[0].lots[0].inProcessSince = '2026-08-05';
  const f = F.deriveMaterialFlow(d);
  eq(f.counts.inProcess, 1, 'a lot out with Operations shows in the custody list');
  eq(f.inProcess[0].lotNumber, 'A', 'named');
  eq(f.inProcess[0].since, '2026-08-05', 'with when it went out');
  eq(f.inProcess[0].itemName, 'Green coffee', 'and what it is, so the manager can plan');

  d.rawMaterials[0].lots[2].inProcess = true;
  d.rawMaterials[0].lots[2].inProcessSince = '2026-08-01';
  eq(F.deriveMaterialFlow(d).inProcess.map((r) => r.lotNumber), ['C', 'A'],
     'oldest out first — what has been away longest is what to chase');
}

// --- robustness ------------------------------------------------------------
eq(F.deriveMaterialFlow(null).counts.openRequests, 0, 'null data yields an empty worklist');
eq(F.deriveMaterialFlow({}).counts.freePositions, 6, 'with the whole door free');
eq(F.deriveMaterialFlow({ materialRequests: 'nonsense' }).requests, [], 'malformed requests ignored');
eq(F.deriveMaterialFlow({ materialRequests: [null] }).requests, [], 'a null request is skipped');
{
  const d = base();
  d.materialRequests = [request({ lines: [{ id: 'L1', itemType: 'raw', itemId: 'gone', qty: 5, lineStatus: 'Pending' }] })];
  eq(F.deriveMaterialFlow(d).requests[0].lines[0].itemName, '(deleted item)',
     'a line whose item vanished still shows, rather than disappearing silently');
}
eq(F.TRANSIT_POSITIONS.length, 6, 'six positions, matching the warehouse');

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
