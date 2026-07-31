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

const NAMES = ['mrpPlacementIndex', 'mrpLotPlacement', 'mrpContentLine', 'buildPalletFromMrpLot'];
const src = NAMES.map(extract).join('\n');
const { mrpPlacementIndex, mrpLotPlacement, mrpContentLine, buildPalletFromMrpLot } =
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

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
