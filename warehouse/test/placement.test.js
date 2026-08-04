// Tests for the MRP -> warehouse placement logic.
//
//   node warehouse/test/placement.test.js
//
// The warehouse is a single self-contained HTML file with no build step, so the
// pure functions are extracted from it by name and evaluated here. That keeps
// the app deployable as one file while still letting the logic that matters be
// asserted on. If a function is renamed, this fails loudly rather than silently
// testing nothing.

'use strict';

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Pull a top-level `function name(...) { ... }` out of the file by brace matching.
function extract(name) {
  const start = HTML.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found in warehouse/index.html: ' + name);
  let depth = 0, started = false;
  for (let i = start; i < HTML.length; i++) {
    if (HTML[i] === '{') { depth++; started = true; }
    else if (HTML[i] === '}') { depth--; if (started && depth === 0) return HTML.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces extracting: ' + name);
}

const NAMES = ['mrpPlacementIndex', 'mrpLotPlacement', 'mrpContentLine', 'buildPalletFromMrpLot',
               'mrpPoLineReceived', 'mrpReceiptApplied', 'mrpOrderToParsed', 'mrpOrderQueued',
               'buildTransitPalletForRequest', 'transitPositionsHeld', 'pendingMaterialActions',
               // pendingMaterialActions names a put-away by where it landed.
               'locationText'];
// Constants the extracted functions close over. Pulled from the file too, so a
// rename fails here rather than silently testing a stale literal.
const CONSTS = ['TRANSIT_ZONE', 'IN_PROCESS_ZONE', 'TRANSIT_LOCS',
                'BARREL_LOCS', 'PLANT_LOCS', 'EMPTY_TOTE_LOCS', 'STAGING_ZONE', 'BUILD_ZONE'].map((n) => {
  const m = HTML.match(new RegExp('const ' + n + '=([^;]+);'));
  if (!m) throw new Error('constant not found in warehouse/index.html: ' + n);
  return 'const ' + n + '=' + m[1] + ';';
}).join('\n');
const src = CONSTS + '\n' + NAMES.map(extract).join('\n');
const { mrpPlacementIndex, mrpLotPlacement, mrpContentLine, buildPalletFromMrpLot,
        mrpPoLineReceived, mrpReceiptApplied, mrpOrderToParsed, mrpOrderQueued,
        buildTransitPalletForRequest, transitPositionsHeld, pendingMaterialActions,
        locationText } =
  new Function(src + '; return {' + NAMES.join(',') + '};')();

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) passed++;
  else { failed++; console.error(`FAIL: ${msg}\n  expected ${e}\n  got      ${a}`); }
}
const ok = (c, m) => eq(!!c, true, m);

const LOT = {
  lotId: 'l1', lotNumber: 'B-100', itemId: 'fg1', itemName: 'SSB', sku: 'SSB-1GAL',
  size: '1 gal', qty: 100, unit: 'gal', expirationDate: '2027-01-01',
  origin: 'Coastal Contract', mfg: 'LV',
};
const pallet = (id, lines) => ({ palletId: id, contents: lines });

// --- mrpPlacementIndex ----------------------------------------------------
eq(mrpPlacementIndex([]), {}, 'no pallets yields an empty index');
eq(mrpPlacementIndex(null), {}, 'null pallets tolerated');
eq(mrpPlacementIndex([pallet('EV1', [{ quantityCurrent: 5 }])]), {},
   'lines with no mrpLotId are ignored — hand-built pallets are not MRP stock');
eq(mrpPlacementIndex([pallet('EV1', [{ mrpLotId: 'l1', quantityCurrent: 40 }])]),
   { l1: { placedQty: 40, palletIds: ['EV1'] } }, 'one line indexes to its lot');
eq(mrpPlacementIndex([
  pallet('EV1', [{ mrpLotId: 'l1', quantityCurrent: 40 }]),
  pallet('EV2', [{ mrpLotId: 'l1', quantityCurrent: 25 }, { mrpLotId: 'l2', quantityCurrent: 7 }]),
]), { l1: { placedQty: 65, palletIds: ['EV1', 'EV2'] }, l2: { placedQty: 7, palletIds: ['EV2'] } },
   'quantities sum across pallets and lines');
eq(mrpPlacementIndex([pallet('EV1', [{ mrpLotId: 'l1', quantityCurrent: 10 }, { mrpLotId: 'l1', quantityCurrent: 5 }])]),
   { l1: { placedQty: 15, palletIds: ['EV1'] } }, 'a pallet is listed once even with two lines of the same lot');
eq(mrpPlacementIndex([pallet('EV1', [{ mrpLotId: 'l1' }])]),
   { l1: { placedQty: 0, palletIds: ['EV1'] } }, 'a missing quantity counts as zero, not NaN');

// --- mrpLotPlacement ------------------------------------------------------
{
  const p = mrpLotPlacement(LOT, {});
  eq(p.status, 'unplaced', 'nothing placed is unplaced');
  eq(p.remaining, 100, 'all of it remains');
  eq(p.placedQty, 0, 'nothing placed');
}
eq(mrpLotPlacement(LOT, { l1: { placedQty: 40, palletIds: ['EV1'] } }).status, 'partial',
   'some placed is partial');
eq(mrpLotPlacement(LOT, { l1: { placedQty: 40, palletIds: ['EV1'] } }).remaining, 60,
   'remaining is what the MRP holds minus what is placed');
eq(mrpLotPlacement(LOT, { l1: { placedQty: 100, palletIds: ['EV1'] } }).status, 'placed',
   'fully placed');
eq(mrpLotPlacement(LOT, { l1: { placedQty: 100, palletIds: ['EV1'] } }).remaining, 0,
   'nothing left once fully placed');
eq(mrpLotPlacement(LOT, { l1: { placedQty: 130, palletIds: ['EV1'] } }).status, 'over',
   'holding more than the MRP thinks exists is surfaced, not hidden');
eq(mrpLotPlacement(LOT, { l1: { placedQty: 130, palletIds: ['EV1'] } }).remaining, 0,
   'over-placement never reports negative remaining');
eq(mrpLotPlacement({ lotId: 'l1', qty: 0 }, {}).status, 'unplaced', 'a zero-qty lot is unplaced');
eq(mrpLotPlacement(LOT, {}).palletIds, [], 'no pallets when unplaced');

// --- mrpContentLine -------------------------------------------------------
{
  const line = mrpContentLine(LOT, 40);
  eq(line.batch, 'B-100', 'content line carries the lot number as the batch');
  eq(line.quantityOriginal, 40, 'original quantity is what was placed');
  eq(line.quantityCurrent, 40, 'current starts equal to original');
  eq(line.expiration, '2027-01-01', 'expiration crosses over from the MRP lot');
  eq(line.mrpLotId, 'l1', 'the link back to the lot is recorded');
  eq(line.mrpSku, 'SSB-1GAL', 'the storable sku is recorded');
  eq(line.packageType, '1 gal', 'size is used as the package type the warehouse shows');
  ok(line.description.includes('SSB'), 'description names the item');
  ok(line.id, 'line gets an id');
  eq(mrpContentLine(LOT).quantityOriginal, 0, 'a missing quantity is zero, not NaN');
  eq(mrpContentLine(null, 5).batch, '', 'a null lot does not throw');
}

// --- buildPalletFromMrpLot ------------------------------------------------
{
  const p = buildPalletFromMrpLot(LOT, { palletId: 'lv7', qty: 40, now: '2026-07-31T00:00:00Z' });
  eq(p.palletId, 'LV7', 'pallet id is upper-cased like the rest of the app');
  eq(p.locationType, 'floor', 'no location given means the open floor');
  eq(p.zone, 'Open Floor', 'floor placement carries the open-floor zone');
  ok(p.x > 0 && p.y > 0, 'floor placement gets default coordinates');
  eq(p.mfg, 'LV', 'manufacturer defaults to the lot');
  eq(p.origin, 'Coastal Contract', 'origin comes from the lot');
  eq(p.status, 'Active', 'a placed pallet is active');
  eq(p.contents.length, 1, 'one content line');
  eq(p.contents[0].mrpLotId, 'l1', 'the content line is linked');
  eq(p.damage.isDamaged, false, 'damage block initialised like savePallet does');
  eq(p.createdAt, '2026-07-31T00:00:00Z', 'timestamp is injectable so this is deterministic');
}
{
  const p = buildPalletFromMrpLot(LOT, { palletId: 'EV9', qty: 10, locationType: 'rack', location: 'M1A1' });
  eq(p.locationType, 'rack', 'a rack location is honoured');
  eq(p.location, 'M1A1', 'the slot code is recorded');
  eq(p.zone, '', 'rack placement carries no floor zone');
  eq(p.x, 0, 'rack placement has no floor coordinates');
}
eq(buildPalletFromMrpLot(LOT, { palletId: 'EV1', qty: 1, mfg: 'EV' }).mfg, 'EV',
   'an explicit manufacturer overrides the lot');

// --- an MRP order becomes a queued order file ------------------------------
// Orders used to be receivable straight from the catalog window, which skipped
// staging, putaway, labels and who signed for it. Now they join the same queue
// a parsed order file lands in and go through Receive Order like anything else.
const ORDER = {
  poId: 'po1', reference: 'PO-1', supplier: 'Acme', orderDate: '2026-07-01',
  expectedDate: '2026-09-01', status: 'Ordered',
  lines: [
    { lineId: 'L1', itemName: 'Green coffee', sku: 'GC-1-60KG', size: '60 kg',
      packageType: 'sack', unit: 'kg', outstanding: 600, containerCount: 10 },
    { lineId: 'L2', itemName: 'Green coffee', sku: 'GC-1-1000KG', size: '1000 kg',
      packageType: 'tote', unit: 'kg', outstanding: 3000, containerCount: 3 },
  ],
};
{
  const parsed = mrpOrderToParsed(ORDER);
  eq(parsed.orderRef, 'PO-1', 'the order reference is what the dock quotes');
  eq(parsed.account, 'Acme', 'the supplier reads as the account');
  eq(parsed.origin, 'Acme', 'the goods come from the supplier');
  eq(parsed.destination, 'Evoia', 'and are bound for us — which is how MFG is detected on import');
  eq(parsed.items.length, 2, 'one item per outstanding order line');
  ok(parsed.items[0].description.includes('Green coffee'), 'the item names the material');
  ok(parsed.items[0].description.includes('GC-1-60KG'), 'and its storable sku');
  eq(parsed.items[0].orderedQty, 600, 'the quantity offered is what is still owed');
  eq(parsed.items[0].mrpPoLineId, 'L1', 'each item remembers the order line it came from');
  eq(parsed.items[1].mrpPoLineId, 'L2', 'including the second container size');
  eq(parsed.items[0].mrpPoId, 'po1', 'and the order');
  eq(parsed.items[0].batch, '', 'no batch is assumed — the dock reads it off what arrives');
  eq(parsed.items[0].shippedQty, 0, 'and nothing is presumed shipped');
  eq(mrpOrderToParsed(null).items, [], 'a missing order yields no items, not a throw');
}

// Queued twice would become two receiving orders for one delivery.
eq(mrpOrderQueued([], 'po1'), false, 'an empty queue holds nothing');
eq(mrpOrderQueued(null, 'po1'), false, 'a missing queue tolerated');
eq(mrpOrderQueued([{ mrpPoId: 'po1', status: 'queued' }], 'po1'), true, 'a queued order is recognised');
eq(mrpOrderQueued([{ mrpPoId: 'other', status: 'queued' }], 'po1'), false, 'a different order is not');
eq(mrpOrderQueued([{ fileName: 'hand.pdf', status: 'queued' }], 'po1'), false,
   'a hand-uploaded order file is not an MRP order');

// The MRP's ledger is the authority on whether a booking has been recorded.
eq(mrpReceiptApplied({ id: 'l1' }, ['l1']), true, 'the ledger says it is recorded');
eq(mrpReceiptApplied({ id: 'l1' }, ['other']), false, 'a booking the ledger does not know is not recorded');
eq(mrpReceiptApplied({ id: 'l1' }, []), false, 'an empty ledger records nothing');
eq(mrpReceiptApplied({ id: 'l1', mrpReceiptStatus: 'applied' }, null),
   true, 'with no ledger to consult the local mark is the fallback');
eq(mrpReceiptApplied({ id: 'l1', mrpReceiptStatus: 'pending' }, null), false, 'pending stays pending');
eq(mrpReceiptApplied(null, ['l1']), false, 'no line is not recorded');

// --- picking material for a request -----------------------------------------
const REQ = { requestId: 'r1', reference: 'MR-0001', requestedFor: 'Run 42' };
const REQ_LINE = { lineId: 'L1', itemId: 'rm1', itemName: 'Green coffee', sku: 'GC-1-60KG',
                   size: '60 kg', unit: 'kg', qty: 120 };
const LOT_PICKED = { lotId: 'lotB', lotNumber: 'B', expirationDate: '2026-09-01' };

{
  const p = buildTransitPalletForRequest(REQ_LINE, REQ, {
    palletId: 'ev7', qty: 120, position: 'TP2', lot: LOT_PICKED, now: '2026-08-05T00:00:00Z' });
  eq(p.palletId, 'EV7', 'pallet id upper-cased like the rest of the app');
  eq(p.locationType, 'transit', 'a pick goes to the door, not to storage');
  eq(p.transitLocation, 'TP2', 'into the position chosen');
  eq(p.transitDirection, 'request', 'moving out to Operations, which is what the badge reads');
  eq(p.contents[0].batch, 'B', 'the lot picked becomes the batch on the pallet');
  eq(p.contents[0].expiration, '2026-09-01', 'expiry carries across so the floor can see it');
  eq(p.contents[0].mrpLotId, 'lotB', 'linked to the MRP lot');
  eq(p.mrpRequestLineId, 'L1', 'and to the request line it satisfies');
  eq(p.mrpFlowAction, 'stage', 'the action is a staging');
  eq(p.mrpFlowStatus, 'pending', 'pending until the MRP records it — the same rule receipts follow');
  eq(p.mrpSubstituted, false, 'no substitution by default');
  eq(p.createdAt, '2026-08-05T00:00:00Z', 'timestamp injectable, so this is deterministic');

  const sub = buildTransitPalletForRequest(REQ_LINE, REQ, {
    palletId: 'EV8', qty: 10, position: 'TP3', lot: LOT_PICKED,
    substituted: true, substitutionReason: 'B blocked behind a rack' });
  eq(sub.mrpSubstituted, true, 'a substitution is flagged');
  eq(sub.mrpSubstitutionReason, 'B blocked behind a rack', 'and its reason kept');
  eq(buildTransitPalletForRequest(REQ_LINE, REQ, { palletId: 'X', qty: 5, substituted: false, substitutionReason: 'ignored' }).mrpSubstitutionReason,
     '', 'a reason without a substitution is dropped rather than stored misleadingly');
}

// The warehouse must not put two pallets in one position while the MRP catches up.
{
  const a = buildTransitPalletForRequest(REQ_LINE, REQ, { palletId: 'EV1', qty: 10, position: 'TP1', lot: LOT_PICKED });
  const b = buildTransitPalletForRequest(REQ_LINE, REQ, { palletId: 'EV2', qty: 10, position: 'TP4', lot: LOT_PICKED });
  const held = transitPositionsHeld([a, b, pallet('EV3', [])]);
  eq(Object.keys(held).sort(), ['TP1', 'TP4'], 'only pallets in the door hold a position');
  eq(transitPositionsHeld([]), {}, 'nothing staged holds nothing');
  eq(transitPositionsHeld(null), {}, 'null pallets tolerated');
}

// What the MRP has not been told yet.
{
  const a = buildTransitPalletForRequest(REQ_LINE, REQ, { palletId: 'EV1', qty: 120, position: 'TP1', lot: LOT_PICKED });
  const actions = pendingMaterialActions([a]);
  eq(actions.length, 1, 'a staged pick is an action waiting to be recorded');
  eq(actions[0].kind, 'stage', 'named for what it was');
  eq(actions[0].lineId, 'L1', 'carrying the line it satisfies');
  eq(actions[0].lotId, 'lotB', 'and the lot actually picked');
  eq(actions[0].qty, 120, 'and how much');
  eq(actions[0].position, 'TP1', 'and where it is sitting');

  a.mrpFlowStatus = 'applied';
  eq(pendingMaterialActions([a]).length, 0, 'once recorded it stops being pending — no double staging');
  eq(pendingMaterialActions([pallet('EV9', [])]).length, 0, 'an ordinary pallet is not a material-flow action');
  eq(pendingMaterialActions(null).length, 0, 'null pallets tolerated');
}

// The other direction: material put away off a return. Custody comes back to
// the warehouse the moment the pallet lands, so the action is raised there and
// the MRP is told after — the same way a pick is.
{
  const putAway = (over) => ({
    palletId: 'EV7', mrpFlowStatus: 'pending', mrpFlowAction: 'accept',
    mrpReturnId: 'ret1', mrpReturnLineId: 'RL1', mrpPutawayLocation: 'M1A1',
    locationType: 'rack', location: 'M1A1',
    contents: [{ mrpLotId: 'lotB', quantityCurrent: 40 }],
    ...over,
  });
  const actions = pendingMaterialActions([putAway()]);
  eq(actions.length, 1, 'a put-away is an action waiting to be recorded');
  eq(actions[0].kind, 'accept', 'named for the custody it takes back');
  eq([actions[0].returnId, actions[0].lineId], ['ret1', 'RL1'], 'carrying the return line it closes');
  eq(actions[0].location, 'Main Storage M1A1',
     'and where it went, spelled out — the MRP records a place, not a code');

  eq(pendingMaterialActions([putAway({ mrpReturnLineId: '' })]).length, 0,
     'an accept with no line to point at is not offered');
  eq(pendingMaterialActions([putAway({ mrpFlowStatus: 'applied' })]).length, 0,
     'once recorded it stops being pending — no double accepting');

  const both = pendingMaterialActions([
    buildTransitPalletForRequest(REQ_LINE, REQ, { palletId: 'EV1', qty: 120, position: 'TP1', lot: LOT_PICKED }),
    putAway(),
  ]);
  eq(both.map((x) => x.kind), ['stage', 'accept'], 'both directions ride in one batch');
}

// --- To/From Process and In Process -----------------------------------------
// The door between the warehouse and Operations, and the custody region that is
// deliberately not a place. Constants and the locParts branch are read straight
// out of the file so a rename fails loudly.
{
  const constOf = (name) => {
    const m = HTML.match(new RegExp('const ' + name + "=([^;]+);"));
    if (!m) throw new Error('constant not found: ' + name);
    return eval(m[1]);
  };
  const TRANSIT_LOCS = constOf('TRANSIT_LOCS');
  const TRANSIT_ZONE = constOf('TRANSIT_ZONE');
  const IN_PROCESS_ZONE = constOf('IN_PROCESS_ZONE');

  eq(TRANSIT_LOCS.length, 6, 'the door is six positions wide');
  eq(TRANSIT_LOCS, ['TP1','TP2','TP3','TP4','TP5','TP6'], 'named TP1..TP6');
  eq(TRANSIT_ZONE, 'To/From Process', 'the zone is named for what it does');
  eq(IN_PROCESS_ZONE, 'In Process', 'custody region is named In Process');
  ok(!/IN_PROCESS_LOCS/.test(HTML),
     'In Process has NO positions — it is custody, not capacity, and must never be slotted');

  // Transit positions are real locations the app knows about...
  ok(/TRANSIT_LOCS\.forEach\(loc=>RACK\.push\(loc\)\)/.test(HTML),
     'transit positions are registered as addressable locations');
  // ...but the map draws no cells for In Process.
  ok(/class="transitGrid"|transitGrid/.test(HTML), 'To/From renders a grid of positions');
  ok(!/inProcessGrid/.test(HTML), 'In Process renders no grid — nothing to slot');

  // The discipline rule: hand-moving a pallet into the door is refused.
  ok(/parts\.isTransit && !\(opts && opts\.materialFlow\)/.test(HTML),
     'a hand-driven move into To/From is refused unless it comes from material flow');
  ok(/positions are filled by material requests and returns/.test(HTML),
     'and the refusal says why, so the door does not quietly become six more slots');

  // locationText names both zones rather than falling through to Open Floor.
  ok(/p\.locationType==='transit'/.test(HTML), 'transit pallets report the To/From zone');
  ok(/p\.locationType==='inprocess'/.test(HTML), 'in-process pallets report the In Process zone');
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
