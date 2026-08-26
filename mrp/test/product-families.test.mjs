// Reporting families: many tags per product, rolled up along whichever axis
// is asked for.
//
// The seed is a 3 x 4 grid — three blends in four formats — and the family
// membership used to exist only as a SKU convention (FG-PRM-*) and a name
// prefix. Nothing in the data knew those four products were related.
//
// The trap this suite mostly guards is arithmetic, not grouping. Every format
// has unit "ea", but an "ea" is 50g, 100g, 200g or 500g, so a summed unit
// count across formats is a number that means nothing. And once a liquid line
// exists, rolling "dry powders" together with "liquid products" means adding
// kilogrammes to litres. Money is the only measure that adds up across
// everything.

import { seedData, tx, repo, familyById, familiesOf, familyDimensions,
         matchesFamilySelection, netContentOf, familySalesRollup,
         expectedCostForShipment, shipmentEvents, shipmentLines,
         normalizeData } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

const plant = () => {
  const D = seedData();
  const fam = (code) => (D.productFamilies || []).find(f => f.code === code);
  const fg = (sku) => (D.finishedGoods || []).find(f => f.sku === sku);
  return { D, fam, fg };
};

console.log('\n--- the seed knows its own families ---');
{
  const { D, fam, fg } = plant();
  ok('families are seeded', (D.productFamilies || []).length === 6);
  ok('on three axes', familyDimensions(D).map(d => d.dimension).join(',') === 'Blend,Form,Pack');

  const prm = fg('FG-PRM-J100');
  const names = familiesOf(D, prm).map(f => f.name).sort().join(', ');
  ok('a product carries several tags at once', familiesOf(D, prm).length === 3);
  ok('one from each axis', names === 'Dry powder, Premium Reserve, Retail pack');

  // The whole point: four different packages, one blend.
  const inPrm = (D.finishedGoods || []).filter(f =>
    (f.families || []).some(t => t.familyId === fam('BL-PRM').id));
  ok('all four Premium Reserve formats share the blend tag', inPrm.length === 4);
  ok('and they really are different packages',
     new Set(inPrm.map(f => f.netContentQty)).size === 4);

  ok('net content is recorded, not left in prose', prm.netContentQty === 100 && prm.netContentUnit === 'g');
  ok('a sachet pack knows it is 50g, not 25 of something', fg('FG-PRM-S25').netContentQty === 50);

  ok('an unknown family id resolves to nothing', familyById(D, 'nope') === null);
  ok('an untagged item has no families', familiesOf(D, { }).length === 0);
  ok('a null item does not throw', familiesOf(D, null).length === 0);
}

console.log('\n--- net content is the only thing that makes a quantity comparable ---');
{
  ok('recorded content comes back', netContentOf({ netContentQty: 500, netContentUnit: 'g' }).qty === 500);
  // Zero would silently drag a family total down and read as "we sold none",
  // which is a different and far more dangerous claim than "we do not know".
  ok('an unrecorded content is null, not zero', netContentOf({ }) === null);
  ok('and so is a zero', netContentOf({ netContentQty: 0, netContentUnit: 'g' }) === null);
  ok('a null item does not throw', netContentOf(null) === null);
  ok('a missing unit does not invent one', netContentOf({ netContentQty: 5 }).unit === '');
}

console.log('\n--- faceted selection: same axis widens, different axes narrow ---');
{
  const { D, fam, fg } = plant();
  const prmJar = fg('FG-PRM-J100'), prmPouch = fg('FG-PRM-P500'), clsJar = fg('FG-CLS-J100');
  const m = (item, ids, mode) => matchesFamilySelection(D, item, ids, mode);

  ok('no selection is not an empty selection', m(prmJar, []) && m(prmJar, null));

  // Two tags on the SAME axis: either blend.
  const twoBlends = [fam('BL-PRM').id, fam('BL-CLS').id];
  ok('two blends match a Premium product', m(prmJar, twoBlends));
  ok('and a Classic one', m(clsJar, twoBlends));
  ok('but not a Rich Roast', !m(fg('FG-RCH-J100'), twoBlends));

  // Two tags on DIFFERENT axes: that blend, in that pack.
  const prmAndFs = [fam('BL-PRM').id, fam('PK-FS').id];
  ok('Premium + Foodservice matches the pouch', m(prmPouch, prmAndFs));
  ok('and not the Premium jar — different axis narrows', !m(prmJar, prmAndFs));
  ok('and not a Classic pouch either', !m(fg('FG-CLS-P500'), prmAndFs));

  // The explicit overrides, for raw set logic.
  ok('"any" is a plain union — the Premium jar is in', m(prmJar, prmAndFs, 'any'));
  ok('"all" is a plain intersection — it is not', !m(prmJar, prmAndFs, 'all'));
  ok('"all" still matches something holding both tags', m(prmPouch, prmAndFs, 'all'));

  // Treating everything as AND returns nothing for the two-blend question;
  // treating everything as OR returns half the catalogue for the other.
  ok('faceted beats plain AND on the same-axis question', !m(prmJar, twoBlends, 'all') && m(prmJar, twoBlends));
  ok('and beats plain OR on the cross-axis one', m(prmJar, prmAndFs, 'any') && !m(prmJar, prmAndFs));

  ok('an untagged product matches nothing selected', !m({ families: [] }, [fam('BL-PRM').id]));
  ok('a null item does not throw', !m(null, [fam('BL-PRM').id]));
}

console.log('\n--- the roll-up ---');
{
  const { D, fam } = plant();
  const byBlend = familySalesRollup(D, { dimension: 'Blend' });
  ok('grouping by blend gives a row per blend', byBlend.groups.length === 3);
  ok('named', byBlend.groups.map(g => g.label).join(',') === 'Classic Gold,Rich Roast,Premium Reserve');
  ok('revenue rolls up', byBlend.totals.revenue > 0);
  ok('and the groups account for it',
     Math.abs(byBlend.groups.reduce((n, g) => n + g.totals.revenue, 0) - byBlend.totals.revenue) < 0.02);

  const prm = byBlend.groups.find(g => g.label === 'Premium Reserve');
  ok('Premium Reserve sums across its formats', prm.rows.length > 1);
  ok('with net content in grams', !!prm.totals.netByUnit.g);
  ok('which equals units x content, product by product',
     Math.abs(prm.totals.netByUnit.g -
              prm.rows.reduce((n, r) => n + r.units * r.netContentQty, 0)) < 0.01);

  // The arithmetic this refuses to do.
  ok('there is no summed unit count across formats', prm.totals.units === undefined,
     'a 50g sachet pack plus a 500g pouch is not "2"');
  ok('units survive per product, where they mean something',
     prm.rows.every(r => typeof r.units === 'number'));

  const filtered = familySalesRollup(D, { dimension: 'Blend', tagIds: [fam('PK-FS').id] });
  ok('narrowing by another axis still groups by the first', filtered.groups.length === 3);
  ok('and cuts the revenue down', filtered.totals.revenue < byBlend.totals.revenue);
  ok('to foodservice only', filtered.detail.every(r => r.sku.endsWith('-P500')));

  const byPack = familySalesRollup(D, { dimension: 'Pack' });
  ok('the same data groups along a different axis', byPack.groups.length === 2);
  ok('for the same money', Math.abs(byPack.totals.revenue - byBlend.totals.revenue) < 0.02);
}

console.log('\n--- what the roll-up refuses to hide ---');
{
  const { D, fam, fg } = plant();

  // A product with no net content still earns money, and saying nothing about
  // it would make the quantity column read as complete when it is not.
  const jar = fg('FG-CLS-J100');
  jar.netContentQty = '';
  const gap = familySalesRollup(D, { dimension: 'Blend' });
  ok('a product with no net content is counted as a gap',
     gap.totals.productsWithoutNetContent >= 1);
  const row = gap.detail.find(r => r.sku === 'FG-CLS-J100');
  if (row) {
    ok('its quantity is unknown rather than zero', row.netTotal === null);
    ok('but its revenue still counts', row.revenue > 0);
  } else ok('that product did not ship in the seed window', true);

  // Kilogrammes and litres in one table. This is the liquid-line case.
  const { D: D2, fg: fg2 } = plant();
  const liquid = repo.create(D2, 'productFamilies', {
    name: 'Liquid', code: 'FM-LIQ', dimension: 'Form', notes: '', sortOrder: 2 });
  const pouch = fg2('FG-PRM-P500');
  pouch.netContentUnit = 'L';
  pouch.netContentQty = 1;
  pouch.families = [{ id: 'x', familyId: liquid.id }];
  const mixed = familySalesRollup(D2, { dimension: 'Form' });
  const units = Object.keys(mixed.totals.netByUnit).sort();
  ok('two units of measure stay two numbers', units.length === 2 && units.join(',') === 'L,g',
     'adding litres to grams would be the whole point of the exercise, wrong');

  // A product tagged twice on the grouping axis appears in both rows, so the
  // rows legitimately over-sum. Better said than discovered.
  const { D: D3, fam: fam3, fg: fg3 } = plant();
  const dbl = fg3('FG-PRM-J100');
  dbl.families = [...dbl.families, { id: 'y', familyId: fam3('BL-CLS').id }];
  const over = familySalesRollup(D3, { dimension: 'Blend' });
  ok('a doubly-tagged product is flagged as an overlap', over.overlaps === true,
     'rows would add to more than the total, silently');

  // A product with no tag on the grouping axis is bucketed, not dropped.
  const { D: D4, fg: fg4 } = plant();
  fg4('FG-RCH-J200').families = [];
  const untagged = familySalesRollup(D4, { dimension: 'Blend' });
  const bucket = untagged.groups.find(g => g.key === '__untagged');
  ok('an untagged product gets its own row rather than vanishing',
     !bucket || bucket.rows.length > 0);
  ok('and the grand total still covers everything',
     Math.abs(familySalesRollup(D4, {}).totals.revenue -
              familySalesRollup(D, {}).totals.revenue) < 0.02);
}

console.log('\n--- expected against actual cost ---');
{
  // Four figures, and the whole point is that the first two are different
  // things: what the recipe said it would cost, and what the lots that
  // actually shipped really cost.
  const { D } = plant();
  const roll = familySalesRollup(D, { dimension: 'Blend' });
  const t = roll.totals;

  ok('expected COGS is reported', typeof t.expectedCogs === 'number' && t.expectedCogs > 0);
  ok('actual COGS is reported', typeof t.actualCogs === 'number' && t.actualCogs > 0);
  ok('they are genuinely different numbers, not one under two names',
     t.expectedCogs !== t.actualCogs);
  ok('deviation is actual minus expected',
     Math.abs(t.deviation - (t.actualCogs - t.expectedCogs)) < 0.02,
     'dev=' + t.deviation + ' act-exp=' + (t.actualCogs - t.expectedCogs));
  ok('actual margin is revenue less what it really cost',
     Math.abs(t.actualMargin - (t.revenue - t.actualCogs)) < 0.02);
  ok('and expected margin measures against the plan',
     Math.abs(t.expectedMargin - (t.revenue - t.expectedCogs)) < 0.02);
  ok('the two margins differ by exactly the deviation',
     Math.abs((t.expectedMargin - t.actualMargin) - t.deviation) < 0.02);

  ok('groups carry the same four figures',
     roll.groups.every(g => typeof g.totals.expectedCogs === 'number' &&
                            typeof g.totals.actualCogs === 'number' &&
                            typeof g.totals.actualMargin === 'number'));
  ok('and they add back to the whole',
     Math.abs(roll.groups.reduce((n, g) => n + g.totals.actualCogs, 0) - t.actualCogs) < 0.05);
  ok('products carry them too',
     roll.detail.every(r => typeof r.expectedCogs === 'number' && typeof r.actualCogs === 'number'));

  // The seed traces every shipment to a lot and a run, so everything is
  // comparable.
  ok('every seeded shipment has a real actual cost', t.shipmentsWithoutActualCost === 0);
  ok('and an expected cost to measure against', t.shipmentsWithoutExpectedCost === 0);
}

console.log('\n--- expected cost is the one fixed at fulfilment ---');
{
  // Today's standard cost moves every time a supplier reprices, which would
  // silently rewrite last quarter's variance. The frozen figure is what was
  // actually planned at the time.
  const { D } = plant();
  const ev = shipmentEvents(D).find(e => e.shipment.scheduleId);
  ok('the seed has a shipment traced to a run', !!ev);
  const run = D.schedule.find(s => s.id === ev.shipment.scheduleId);
  run.standardCostAtFulfillment = 99;
  const cost = expectedCostForShipment(D, ev);
  ok('the frozen cost is used when the run carries one', cost.unitCost === 99);
  ok('and is flagged as frozen', cost.frozen === true);
  ok('expected COGS is that cost times the quantity', Math.abs(cost.cogs - 99 * ev.qty) < 0.01);

  run.standardCostAtFulfillment = '';
  const unfrozen = expectedCostForShipment(D, ev);
  ok('without one it falls back to the standard cost', unfrozen.unitCost > 0);
  ok('and says it is not frozen', unfrozen.frozen === false);

  // The shipment table and the roll-up must not report different variances
  // for the same shipment.
  const line = shipmentLines(D, {}).find(l => l.id === ev.id);
  if (line) {
    const again = expectedCostForShipment(D, ev);
    ok('the table and the roll-up agree on expected cost',
       Math.abs((line.expectedCogs || 0) - (again.cogs || 0)) < 0.01);
    ok('and on the deviation',
       Math.abs((line.costVariance || 0) - (again.deviation || 0)) < 0.01);
  } else ok('that shipment fell outside the default range', true);
}

console.log('\n--- a shipment with no actual cost is not "on plan" ---');
{
  // Transitional, and due to be prevented at source: a shipment with no lot
  // already falls back to standard cost for its actual, so expected and actual
  // are the same number and the deviation would be a spurious zero. Reporting
  // that as on-plan would bake a false clean bill of health into the history.
  const { D } = plant();
  D.shipments.forEach(sh => { sh.lotId = ''; });
  const roll = familySalesRollup(D, { dimension: 'Blend' });

  ok('such shipments are counted', roll.totals.shipmentsWithoutActualCost > 0);
  ok('none of them count towards the deviation', roll.totals.comparableShipments === 0);
  ok('so the deviation is unknown, not zero', roll.totals.deviation === null,
     'a confident 0 would read as "on plan" when the truth is "we do not know"');
  ok('revenue still counts — the sale happened', roll.totals.revenue > 0);
  ok('and actual margin is still reported', typeof roll.totals.actualMargin === 'number');
  ok('per product too', roll.detail.every(r => r.deviation === null));

  // Mixed: some comparable, some not. The deviation must cover only the real
  // ones, and say how many that is.
  const { D: D2 } = plant();
  const withLot = D2.shipments.filter(sh => sh.lotId);
  if (withLot.length > 1) {
    withLot[0].lotId = '';
    const mixed = familySalesRollup(D2, { dimension: 'Blend' });
    ok('a mixed period still reports a deviation', mixed.totals.deviation !== null);
    ok('but only over the shipments that have real costs',
       mixed.totals.comparableShipments === withLot.length - 1);
    ok('and says how many were left out', mixed.totals.shipmentsWithoutActualCost === 1);
  } else ok('not enough lot-traced shipments in the seed to mix', true);
}

console.log('\n--- a shipment with no run has no expected cost ---');
{
  const { D } = plant();
  D.shipments.forEach(sh => { sh.scheduleId = ''; });
  D.schedule.forEach(s => { s.fulfillmentLots = []; });
  const roll = familySalesRollup(D, { dimension: 'Blend' });
  ok('expected COGS is unknown rather than guessed at', roll.totals.expectedCogs === null);
  ok('and so is expected margin', roll.totals.expectedMargin === null);
  ok('those shipments are counted', roll.totals.shipmentsWithoutExpectedCost > 0);
  ok('actual COGS is still real', roll.totals.actualCogs > 0);
  ok('and so is actual margin', typeof roll.totals.actualMargin === 'number');
}

console.log('\n--- managing families ---');
{
  const { D } = plant();
  const before = D.productFamilies.length;
  const made = tx.saveProductFamily(D, { name: 'Liquid drinks', dimension: 'Form' });
  ok('a family can be added', made.ok === true);
  ok('and derives a code when none is given', !!made.family.code);
  ok('it appears on its axis',
     familyDimensions(D).find(d => d.dimension === 'Form').families.length === 2);

  // Without an axis a filter cannot tell widening from narrowing, so it is
  // required rather than defaulted.
  const noDim = tx.saveProductFamily(D, { name: 'Something', dimension: '' });
  ok('a family without an axis is refused', noDim.ok === false);
  ok('and says why that matters', /widening from narrowing/.test(noDim.error));
  ok('a family without a name is refused',
     tx.saveProductFamily(D, { name: '', dimension: 'Form' }).ok === false);
  ok('a duplicate code is refused',
     tx.saveProductFamily(D, { name: 'Other', code: made.family.code, dimension: 'Form' }).ok === false);
  ok('but editing that same family keeps its own code',
     tx.saveProductFamily(D, { id: made.family.id, name: 'Liquid drinks',
       code: made.family.code, dimension: 'Form' }).ok === true);

  ok('an unused family can be deleted', tx.deleteProductFamily(D, { id: made.family.id }).ok === true);
  ok('and is gone', D.productFamilies.length === before);

  // Deleting a family in use would strip tags off products and rewrite every
  // report that used it, with no record of why.
  const inUse = D.productFamilies.find(f => f.code === 'BL-PRM');
  const refused = tx.deleteProductFamily(D, { id: inUse.id });
  ok('a family still on products cannot be deleted', refused.ok === false);
  ok('and the message says how many', /4 product/.test(refused.error));
  ok('an unknown family cannot be deleted', tx.deleteProductFamily(D, { id: 'nope' }).ok === false);
}

console.log('\n--- tagging ---');
{
  const { D, fam, fg } = plant();
  const item = fg('FG-CLS-J100');
  const ids = [fam('BL-PRM').id, fam('FM-DRY').id];
  const res = tx.setFamilyTags(D, { itemId: item.id, familyIds: ids });
  ok('tags can be replaced wholesale', res.ok === true && item.families.length === 2);
  ok('with what was asked for',
     item.families.map(t => t.familyId).sort().join(',') === ids.slice().sort().join(','));

  ok('the same tag twice is still one tag',
     tx.setFamilyTags(D, { itemId: item.id, familyIds: [ids[0], ids[0]] }).tags.length === 1);
  ok('an unknown family is dropped rather than stored as a dangling id',
     tx.setFamilyTags(D, { itemId: item.id, familyIds: ['nope'] }).tags.length === 0);
  ok('clearing all tags is allowed',
     tx.setFamilyTags(D, { itemId: item.id, familyIds: [] }).tags.length === 0);
  ok('an unknown product is refused',
     tx.setFamilyTags(D, { itemId: 'nope', familyIds: ids }).ok === false);

  // Re-applying a tag must not churn its row id, or the CSV round trip would
  // show a change where nothing changed.
  tx.setFamilyTags(D, { itemId: item.id, familyIds: ids });
  const firstId = item.families[0].id;
  tx.setFamilyTags(D, { itemId: item.id, familyIds: ids });
  ok('a tag that stays keeps its row id', item.families[0].id === firstId);
}

console.log('\n--- it survives a round trip ---');
{
  const { D } = plant();
  const back = normalizeData(JSON.parse(JSON.stringify(D)));
  ok('families survive normalising', (back.productFamilies || []).length === 6);
  ok('and so do the tags on a product',
     (back.finishedGoods.find(f => f.sku === 'FG-PRM-J100').families || []).length === 3);
  ok('and net content', back.finishedGoods.find(f => f.sku === 'FG-PRM-J100').netContentQty === 100);
  ok('the roll-up reads the same afterwards',
     Math.abs(familySalesRollup(back, {}).totals.revenue -
              familySalesRollup(D, {}).totals.revenue) < 0.02);

  ok('data with no families at all does not throw',
     familySalesRollup({ }, { dimension: 'Blend' }).totals.revenue === 0);
  ok('nor does a null', familyDimensions(null).length === 0);
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
