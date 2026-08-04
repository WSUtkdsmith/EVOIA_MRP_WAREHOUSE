// The warehouse <-> Operations handshake. In Process is a custody statement:
// material the warehouse can see but does not control. Six To/From positions are
// the single door, and they free on handover rather than being held for a job.
import { seedData, tx, repo, TRANSIT_POSITIONS, freeTransitPositions,
         occupiedTransitPositions, fefoLots, suggestFefoLot, waitingForPosition,
         inProcessLots, materialRequestStatus, materialReturnStatus,
         materialBalance, nextMaterialRef } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

function plant() {
  const D = seedData();
  const raw = D.rawMaterials[0];
  raw.lots = [
    { id: 'lotA', lotNumber: 'A', qty: 500, producedQty: 500, unitCost: 5, expirationDate: '2027-06-01', sources: [] },
    { id: 'lotB', lotNumber: 'B', qty: 500, producedQty: 500, unitCost: 5, expirationDate: '2026-09-01', sources: [] },
    { id: 'lotC', lotNumber: 'C', qty: 500, producedQty: 500, unitCost: 5, expirationDate: '', sources: [] }
  ];
  D.materialRequests = []; D.materialReturns = [];
  return { D, raw };
}
const req = (D, raw, qty) => tx.raiseMaterialRequest(D, {
  requestedFor: 'Run 1', submit: true,
  lines: [{ itemType: 'raw', itemId: raw.id, qty: qty || 100 }]
}).request;

console.log('\n--- FEFO suggests, the picker decides ---');
{
  const { D, raw } = plant();
  const order = fefoLots(D, 'raw', raw.id).map(l => l.lotNumber);
  ok('earliest expiry comes first', order[0] === 'B');
  ok('an undated lot sorts last, not first', order[order.length - 1] === 'C',
     'unknown expiry is not an urgent one: ' + order.join(','));
  ok('the suggestion is the first FEFO lot', suggestFefoLot(D, 'raw', raw.id).lotNumber === 'B');
  raw.lots.find(l => l.id === 'lotB').qty = 0;
  ok('an empty lot is not offered', !fefoLots(D, 'raw', raw.id).some(l => l.lotNumber === 'B'));
  ok('nothing available yields no suggestion',
     suggestFefoLot(D, 'raw', 'nope') === null);
}

console.log('\n--- a request is raised, not a lot ---');
{
  const { D, raw } = plant();
  const r = req(D, raw, 100);
  ok('the request exists', !!r && r.lines.length === 1);
  ok('it names no lot — the warehouse selects', r.lines[0].lotId === '');
  ok('its line starts pending', r.lines[0].lineStatus === 'Pending');
  ok('a submitted request reads as requested', materialRequestStatus(r) === 'Requested');
  ok('a request with nothing on it is refused',
     tx.raiseMaterialRequest(D, { lines: [] }).ok === false);
  ok('a duplicate reference is refused',
     tx.raiseMaterialRequest(D, { reference: r.reference, lines: [{ itemType: 'raw', itemId: raw.id, qty: 1 }] }).ok === false);
}

console.log('\n--- staging holds a position, receiving frees it ---');
{
  const { D, raw } = plant();
  const r = req(D, raw, 100);
  ok('six positions to start', freeTransitPositions(D).length === 6);

  const staged = tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotB', qty: 100, originLocation: 'M1A1' });
  ok('the warehouse can stage the FEFO lot', staged.ok === true);
  ok('a position is taken', freeTransitPositions(D).length === 5);
  ok('the line records the lot the warehouse chose', r.lines[0].lotId === 'lotB');
  ok('and where it came from, for the return trip', r.lines[0].originLocation === 'M1A1');
  ok('the line reads staged', r.lines[0].lineStatus === 'Staged');
  ok('the request reads staged', materialRequestStatus(r) === 'Staged');
  ok('the lot is not yet in process — the warehouse still has it', !raw.lots.find(l => l.id === 'lotB').inProcess);
  ok('the occupied position names the document', Object.values(occupiedTransitPositions(D))[0].kind === 'request');

  const rec = tx.receiveRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, receivedAt: '2026-08-05' });
  ok('Operations can take custody', rec.ok === true);
  ok('the lot is now in process', raw.lots.find(l => l.id === 'lotB').inProcess === true);
  ok('and records since when', raw.lots.find(l => l.id === 'lotB').inProcessSince === '2026-08-05');
  ok('THE POSITION IS FREED — To/From is transit, not storage', freeTransitPositions(D).length === 6);
  ok('the request reads received', materialRequestStatus(r) === 'Received');
  ok('a lot in process is no longer offered by FEFO',
     !fefoLots(D, 'raw', raw.id).some(l => l.id === 'lotB'));
}

console.log('\n--- substitution is allowed, but must say why ---');
{
  const { D, raw } = plant();
  const r = req(D, raw, 100);
  const bad = tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotA', qty: 100, substituted: true });
  ok('substituting without a reason is refused', bad.ok === false);
  const good = tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotA', qty: 100, substituted: true, substitutionReason: 'B is blocked behind a rack' });
  ok('with a reason it is allowed', good.ok === true);
  ok('and the reason is kept — overriding FEFO is a signal', r.lines[0].substitutionReason.length > 0);
}

console.log('\n--- the door is six wide, and a full door queues ---');
{
  const { D, raw } = plant();
  raw.lots = TRANSIT_POSITIONS.concat(['extra']).map((p, i) =>
    ({ id: 'L' + i, lotNumber: 'L' + i, qty: 100, producedQty: 100, unitCost: 1, expirationDate: '2027-01-0' + (i + 1), sources: [] }));
  const rs = raw.lots.map(() => req(D, raw, 10));
  rs.slice(0, 6).forEach((r, i) => tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: raw.lots[i].id, qty: 10 }));
  ok('six lines fill the door', freeTransitPositions(D).length === 0);

  const seventh = tx.stageRequestLine(D, { materialRequestId: rs[6].id, lineId: rs[6].lines[0].id, lotId: raw.lots[6].id, qty: 10 });
  ok('the seventh cannot be staged', seventh.ok === false);
  ok('it is told why', /position/i.test(seventh.reason || seventh.error));
  const waiting = waitingForPosition(D);
  ok('it shows as waiting rather than vanishing', waiting.length === 1);
  ok('and is marked blocked while the door is full', waiting[0].blocked === true);

  tx.receiveRequestLine(D, { materialRequestId: rs[0].id, lineId: rs[0].lines[0].id });
  ok('receiving one clears a position', freeTransitPositions(D).length === 1);
  ok('now the waiting line can stage',
     tx.stageRequestLine(D, { materialRequestId: rs[6].id, lineId: rs[6].lines[0].id, lotId: raw.lots[6].id, qty: 10 }).ok === true);
}

console.log('\n--- the In Process window ---');
{
  const { D, raw } = plant();
  const r = req(D, raw, 100);
  tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotB', qty: 100 });
  ok('nothing is in process before custody transfers', inProcessLots(D).length === 0);
  tx.receiveRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id });
  const rows = inProcessLots(D);
  ok('the received lot appears', rows.length === 1 && rows[0].lot.id === 'lotB');
  ok('it names the item so the manager can plan', !!rows[0].itemName && rows[0].itemType === 'raw');
}

console.log('\n--- returning: both flavours clear custody ---');
{
  const { D, raw } = plant();
  const r = req(D, raw, 100);
  tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotB', qty: 100, originLocation: 'M1A1' });
  tx.receiveRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id });

  ok('a return must say which flavour it is',
     tx.raiseMaterialReturn(D, { returnType: 'whatever', lines: [{ itemType: 'raw', itemId: raw.id, qty: 40 }] }).ok === false);

  const ret = tx.raiseMaterialReturn(D, {
    returnType: 'leftover', materialRequestId: r.id,
    lines: [{ itemType: 'raw', itemId: raw.id, lotId: 'lotB', qty: 40, suggestedLocation: 'M1A1' }]
  })['return'];
  ok('a leftover return is raised', !!ret && ret.returnType === 'leftover');
  ok('it suggests where the material came from', ret.lines[0].suggestedLocation === 'M1A1');
  ok('a return not yet staged holds no position', freeTransitPositions(D).length === 6);

  tx.stageReturnLine(D, { materialReturnId: ret.id, lineId: ret.lines[0].id });
  ok('staging a return holds a position too — one door, both ways', freeTransitPositions(D).length === 5);
  ok('the occupied position knows it is a return', Object.values(occupiedTransitPositions(D))[0].kind === 'return');

  const acc = tx.acceptReturnLine(D, { materialReturnId: ret.id, lineId: ret.lines[0].id });
  ok('the warehouse can accept it', acc.ok === true);
  ok('custody returns — the lot is no longer in process', raw.lots.find(l => l.id === 'lotB').inProcess === false);
  ok('and the position frees', freeTransitPositions(D).length === 6);
  ok('the return reads accepted', materialReturnStatus(ret) === 'Accepted');
  ok('the lot is available to FEFO again', fefoLots(D, 'raw', raw.id).some(l => l.id === 'lotB'));
  ok('it is out of the In Process window', inProcessLots(D).length === 0);
}

console.log('\n--- clearing custody without a return is an exception ---');
{
  const { D, raw } = plant();
  const r = req(D, raw, 100);
  tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotB', qty: 100 });
  tx.receiveRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id });

  ok('clearing without a reason is refused',
     tx.clearInProcess(D, { itemType: 'raw', itemId: raw.id, lotId: 'lotB' }).ok === false);
  const cleared = tx.clearInProcess(D, { itemType: 'raw', itemId: raw.id, lotId: 'lotB', reason: 'Scrapped on the line' });
  ok('with a reason it is allowed', cleared.ok === true);
  ok('the lot leaves custody', raw.lots.find(l => l.id === 'lotB').inProcess === false);
  ok('THE REASON IS RECORDED, not silently dropped',
     raw.lots.find(l => l.id === 'lotB').inProcessClearedReason === 'Scrapped on the line');
  ok('clearing a lot that is not out is refused',
     tx.clearInProcess(D, { itemType: 'raw', itemId: raw.id, lotId: 'lotA', reason: 'x' }).ok === false);
}

console.log('\n--- guards ---');
{
  const { D, raw } = plant();
  const r = req(D, raw, 100);
  ok('staging a lot that does not exist is refused',
     tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'nope', qty: 10 }).ok === false);
  ok('staging more than the lot holds is refused',
     tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotA', qty: 99999 }).ok === false);
  ok('receiving a line that is not staged is refused',
     tx.receiveRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id }).ok === false);
  tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotA', qty: 10 });
  ok('staging the same line twice is refused',
     tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotB', qty: 10 }).ok === false);
  ok('a lot already out with Operations cannot be staged again', (() => {
    tx.receiveRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id });
    const r2 = req(D, raw, 10);
    return tx.stageRequestLine(D, { materialRequestId: r2.id, lineId: r2.lines[0].id, lotId: 'lotA', qty: 10 }).ok === false;
  })());
  const draft = tx.raiseMaterialRequest(D, { lines: [{ itemType: 'raw', itemId: raw.id, qty: 5 }] }).request;
  ok('a draft cannot be staged against', 
     tx.stageRequestLine(D, { materialRequestId: draft.id, lineId: draft.lines[0].id, lotId: 'lotC', qty: 5 }).ok === false);
}

console.log('\n--- references ---');
ok('request references climb', nextMaterialRef({ materialRequests: [{ reference: 'MR-0007' }] }, 'materialRequests', 'MR-') === 'MR-0008');
ok('return references climb separately', nextMaterialRef({ materialReturns: [] }, 'materialReturns', 'RET-') === 'RET-0001');

console.log('\n--- the material balance ---');
{
  const { D, raw } = plant();
  const r = req(D, raw, 100);
  tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotB', qty: 100 });
  tx.receiveRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id });
  let bal = materialBalance(D, 'raw', raw.id, 'lotB');
  ok('issued is what Operations took', bal.issued === 100);
  ok('nothing consumed or returned yet', bal.consumed === 0 && bal.returned === 0);
  ok('so the whole issue is outstanding', bal.discrepancy === 100 && bal.balanced === false);

  const ret = tx.raiseMaterialReturn(D, { returnType: 'leftover',
    lines: [{ itemType: 'raw', itemId: raw.id, lotId: 'lotB', qty: 100 }] })['return'];
  tx.stageReturnLine(D, { materialReturnId: ret.id, lineId: ret.lines[0].id });
  tx.acceptReturnLine(D, { materialReturnId: ret.id, lineId: ret.lines[0].id });
  bal = materialBalance(D, 'raw', raw.id, 'lotB');
  ok('returning it all balances the lot', bal.returned === 100 && bal.balanced === true);
}

console.log('\n--- recording what the warehouse did ---');
{
  const { D, raw } = plant();
  const r = req(D, raw, 100);
  const act = { kind: 'stage', requestId: r.id, lineId: r.lines[0].id, lotId: 'lotB',
                qty: 100, position: 'TP1', originLocation: 'M1A1' };

  const res = tx.applyWarehouseMaterialActions(D, [act]);
  ok('a pick taken on the floor is recorded', res.ok === true && res.applied.length === 1);
  ok('the line is staged in the MRP', r.lines[0].lineStatus === 'Staged');
  ok('with the lot the warehouse actually picked', r.lines[0].lotId === 'lotB');
  ok('and where it came from', r.lines[0].originLocation === 'M1A1');
  ok('holding the position it is sitting in', r.lines[0].position === 'TP1');

  // The property that matters: a re-sync must not stage it twice.
  const again = tx.applyWarehouseMaterialActions(D, [act]);
  ok('replaying it applies nothing', again.applied.length === 0);
  ok('it is reported as already staged, not as a failure', again.skipped.length === 1 && again.ok === true);
  ok('the position is not double-claimed', freeTransitPositions(D).length === 5);

  // The same action arriving twice in one batch.
  const { D: D2, raw: raw2 } = plant();
  const r2 = req(D2, raw2, 50);
  const a2 = { kind: 'stage', requestId: r2.id, lineId: r2.lines[0].id, lotId: 'lotB', qty: 50, position: 'TP1' };
  const dup = tx.applyWarehouseMaterialActions(D2, [a2, a2]);
  ok('a repeat inside one batch stages once', dup.applied.length === 1 && dup.skipped.length === 1);
}

console.log('\n--- recording a put-away ---');
{
  const { D, raw } = plant();
  const r = req(D, raw, 100);
  tx.stageRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id, lotId: 'lotB', qty: 100 });
  tx.receiveRequestLine(D, { materialRequestId: r.id, lineId: r.lines[0].id });
  const ret = tx.raiseMaterialReturn(D, { returnType: 'leftover',
    lines: [{ itemType: 'raw', itemId: raw.id, lotId: 'lotB', qty: 40 }] })['return'];

  // The warehouse has already taken it back physically, without the MRP having
  // seen it staged — the applier should not refuse a move that has happened.
  const res = tx.applyWarehouseMaterialActions(D, [{ kind: 'accept', returnId: ret.id, lineId: ret.lines[0].id }]);
  ok('a put-away is recorded even if the MRP never saw it staged', res.ok === true && res.applied.length === 1);
  ok('custody returns to the warehouse', raw.lots.find(l => l.id === 'lotB').inProcess === false);
  ok('the return line reads accepted', ret.lines[0].lineStatus === 'Accepted');
  ok('and the door is clear', freeTransitPositions(D).length === 6);

  const again = tx.applyWarehouseMaterialActions(D, [{ kind: 'accept', returnId: ret.id, lineId: ret.lines[0].id }]);
  ok('replaying the put-away changes nothing', again.applied.length === 0 && again.skipped.length === 1);
}

console.log('\n--- one bad action does not stop the rest ---');
{
  const { D, raw } = plant();
  const a = req(D, raw, 10), b = req(D, raw, 10);
  const res = tx.applyWarehouseMaterialActions(D, [
    { kind: 'stage', requestId: a.id, lineId: a.lines[0].id, lotId: 'lotB', qty: 10, position: 'TP1' },
    { kind: 'stage', requestId: 'nope', lineId: 'x', lotId: 'lotA', qty: 5, position: 'TP2' },
    { kind: 'stage', requestId: b.id, lineId: b.lines[0].id, lotId: 'lotA', qty: 10, position: 'TP3' }
  ]);
  ok('the good ones are recorded', res.applied.length === 2);
  ok('the bad one is reported with its reason', res.failed.length === 1 && !!res.failed[0].reason);
  ok('the batch reports overall failure so it is not ignored', res.ok === false);
  ok('nothing else is disturbed', freeTransitPositions(D).length === 4);

  ok('an unknown action is refused, not guessed at',
     tx.applyWarehouseMaterialActions(D, [{ kind: 'teleport' }]).failed.length === 1);
  ok('no actions is a no-op', tx.applyWarehouseMaterialActions(D, []).applied.length === 0);
  ok('null is a no-op', tx.applyWarehouseMaterialActions(D, null).applied.length === 0);
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
