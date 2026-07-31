// Purchase orders as the record both systems agree on: the MRP raises them,
// the warehouse receives against them. Covers ordering by the container (units
// conserved), what an order is worth, and the reorder forecast that suggests
// them. Asserts intent and invariants, not wording.
import { seedData, repo, tx, suggestPurchaseOrders,
         unitsPerContainer, packagingLabel, qtyFromContainers, containersFromQty,
         poTotalCost, poContainerSummary, poPackaging, rawStockOnHand,
         nextPoReference, poOutstanding, poReceivedQty, openOrderQty,
         poOrderedQty, poLineOutstanding, poDerivedStatus } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

console.log('\n--- containers and units ---');
ok('units per container defaults to 1 when absent', unitsPerContainer(null) === 1);
ok('a zero or negative capacity falls back to 1, never zero',
   unitsPerContainer({ unitsPerPackage: 0 }) === 1 && unitsPerContainer({ unitsPerPackage: -5 }) === 1);
ok('containers x capacity = quantity', qtyFromContainers({ unitsPerPackage: 60 }, 400) === 24000);
ok('a part container still counts as a container', containersFromQty({ unitsPerPackage: 55 }, 100) === 2);
ok('an exact fit does not round up a spare container', containersFromQty({ unitsPerPackage: 50 }, 100) === 2);
ok('zero quantity needs no containers', containersFromQty({ unitsPerPackage: 50 }, 0) === 0);
{
  // The invariant that matters: ordering by the container never leaves you short.
  const per = 60;
  const shortfalls = [1, 59, 60, 61, 1000, 24000, 24001];
  ok('rounding to whole containers always covers the requirement',
     shortfalls.every(q => qtyFromContainers({ unitsPerPackage: per }, containersFromQty({ unitsPerPackage: per }, q)) >= q));
}

console.log('\n--- how a container reads ---');
ok('size and container are combined', packagingLabel({ size: '60 kg', packageType: 'sack' }) === '60 kg sack');
ok('the container word is not repeated when the size already names it',
   packagingLabel({ size: 'case of 1000', packageType: 'case' }) === 'case of 1000');
ok('either half alone still reads', packagingLabel({ size: '', packageType: 'drum' }) === 'drum'
   && packagingLabel({ size: '1 gal', packageType: '' }) === '1 gal');
ok('no packaging reads as nothing', packagingLabel(null) === '');

console.log('\n--- what an order is worth ---');
ok('total is the sum of the lines', poTotalCost({ lines: [{ qty: 400, unitCost: 2.5 }] }) === 1000);
ok('several lines add up',
   poTotalCost({ lines: [{ qty: 400, unitCost: 2.5 }, { qty: 100, unitCost: 3 }] }) === 1300);
ok('a missing cost is zero, not NaN', poTotalCost({ lines: [{ qty: 400 }] }) === 0);
ok('an order with no lines is worth nothing', poTotalCost({ lines: [] }) === 0 && poTotalCost({}) === 0);

console.log('\n--- the forecast ---');
{
  const D = seedData();
  ok('a fully stocked plant suggests nothing', suggestPurchaseOrders(D, { today: '2026-07-31' }).length === 0);

  // Drain one material and clear its cover, so it is genuinely short.
  const raw = D.rawMaterials[0];
  raw.lots.forEach(l => { l.qty = 0; });
  raw.onOrder = 0;
  D.purchaseOrders = D.purchaseOrders.filter(po => !(po.lines || []).some(l => l.rawMaterialId === raw.id));

  const rows = suggestPurchaseOrders(D, { today: '2026-07-31' });
  ok('a material below its reorder point is suggested', rows.some(r => r.rawMaterialId === raw.id));
  const row = rows.find(r => r.rawMaterialId === raw.id);
  ok('the suggestion covers the shortfall', row.qty >= row.shortfall - 0.001);
  ok('the suggestion respects the minimum order quantity', row.qty >= row.moq - 0.001);
  ok('the suggestion is a whole number of containers', Number.isInteger(row.containerCount));
  ok('units are conserved end to end',
     Math.abs(qtyFromContainers(poPackaging(D, { rawMaterialId: raw.id, packagingId: row.packagingId }), row.containerCount) - row.qty) < 0.001);
  ok('the total is priced from the material', Math.abs(row.totalCost - row.qty * row.unitCost) < 0.001);
  ok('expected date allows for the lead time', row.expectedDate > '2026-07-31' || row.leadTimeDays === 0);
  ok('the supplier comes across', row.supplier === (raw.supplier || ''));
  ok('stock on hand is read from the lots', rawStockOnHand(raw) === 0);

  // Raising the orders should satisfy the forecast that produced them.
  const before = D.purchaseOrders.length;
  const { created } = tx.raisePurchaseOrders(D, rows);
  ok('the suggestions are raised as lines across the new orders',
     created.reduce((n, po) => n + (po.lines || []).length, 0) === rows.length);
  ok('orders are grouped, never more than one per suggestion',
     created.length <= rows.length && D.purchaseOrders.length === before + created.length);
  ok('orders are raised as drafts, not silently placed', created.every(po => po.status === 'Draft'));
  ok('every reference is unique',
     new Set(D.purchaseOrders.map(p => p.reference)).size === D.purchaseOrders.length);
  ok('every line carries its container and how many',
     created.every(po => (po.lines || []).length > 0 && po.lines.every(l => l.packagingId && l.containerCount > 0)));
  ok('the ordered quantity is receivable in full',
     created.every(po => Math.abs(poOutstanding(po) - po.lines.reduce((s, l) => s + l.qty, 0)) < 0.001));
  ok('nothing is received yet', created.every(po => poReceivedQty(po) === 0));
  ok('the order now counts as on order for the material', openOrderQty(D, raw.id) >= row.qty - 0.001);
  ok('the forecast no longer asks for what is now on order',
     !suggestPurchaseOrders(D, { today: '2026-07-31' }).some(r => r.rawMaterialId === raw.id));
  ok('the order reads with its container count', /^\d+ × /.test(poContainerSummary(D, created[0])));
}

console.log('\n--- one order, several lines ---');
{
  // The case that motivated lines: the same material ordered in two container
  // sizes, which the warehouse receives and stores as separate stock.
  const D = seedData();
  const raw = D.rawMaterials[0];
  const [small, large] = [
    { id: 'pk-small', sku: raw.sku + '-SM', packageType: 'sack', size: '60 kg', unitsPerPackage: 60, packagesPerSlot: 12, isDefault: true },
    { id: 'pk-large', sku: raw.sku + '-LG', packageType: 'tote', size: '1000 kg', unitsPerPackage: 1000, packagesPerSlot: 1, isDefault: false }
  ];
  raw.packagings = [small, large];
  // Clear the seed's own orders for this material so the figures below are
  // about these two lines and nothing else.
  D.purchaseOrders = D.purchaseOrders.filter(po => !(po.lines || []).some(l => l.rawMaterialId === raw.id));

  const { created } = tx.raisePurchaseOrders(D, [
    { rawMaterialId: raw.id, supplier: 'Acme', qty: 600, unitCost: 5, packagingId: 'pk-small', containerCount: 10, expectedDate: '2026-09-01' },
    { rawMaterialId: raw.id, supplier: 'Acme', qty: 3000, unitCost: 4.5, packagingId: 'pk-large', containerCount: 3, expectedDate: '2026-09-08' }
  ]);
  ok('both sizes land on one order for the supplier', created.length === 1 && created[0].lines.length === 2);
  const po = created[0];
  ok('each line keeps its own container', po.lines[0].packagingId === 'pk-small' && po.lines[1].packagingId === 'pk-large');
  ok('each line keeps its own price', po.lines[0].unitCost === 5 && po.lines[1].unitCost === 4.5);
  ok('ordered quantity is the sum of the lines', poOrderedQty(po) === 3600);
  ok('order value is the sum of the lines', Math.abs(poTotalCost(po) - (600 * 5 + 3000 * 4.5)) < 0.001);
  ok('the order is expected when its slowest line is', po.expectedDate === '2026-09-08');
  ok('the summary names both containers',
     /10 × 60 kg sack/.test(poContainerSummary(D, po)) && /3 × 1000 kg tote/.test(poContainerSummary(D, po)));
  ok('both lines count toward what is on order', Math.abs(openOrderQty(D, raw.id) - 3600) < 0.001);

  // Receiving is per line, so one size arriving does not close the other.
  tx.placePurchaseOrder(D, { purchaseOrderId: po.id });
  const res = tx.receiveAgainstOrder(D, { purchaseOrderId: po.id, lineId: po.lines[1].id, qty: 3000, lotNumber: 'TOTE-1' });
  ok('a named line can be received', res.ok === true && res.line.id === po.lines[1].id);
  ok('the lot is priced from that line, not the other', res.lot.unitCost === 4.5);
  ok('that line is settled', poLineOutstanding(po, po.lines[1]) === 0);
  ok('the other line is untouched', poLineOutstanding(po, po.lines[0]) === 600);
  ok('the order as a whole is only part received', poDerivedStatus(po) === 'Part received');
  ok('and stays receivable', tx.receivablePurchaseOrders(D).some(p => p.id === po.id));

  tx.receiveAgainstOrder(D, { purchaseOrderId: po.id, lineId: po.lines[0].id, qty: 600, lotNumber: 'SACK-1' });
  ok('receiving the rest completes the order', poDerivedStatus(po) === 'Received');
  ok('each delivery is attributed to its own line',
     po.receipts.length === 2 && new Set(po.receipts.map(r => r.lineId)).size === 2);
  ok('two separate stock lots were created',
     raw.lots.filter(l => ['TOTE-1', 'SACK-1'].includes(l.lotNumber)).length === 2);
}

console.log('\n--- a delivery need not name a line ---');
{
  const D = seedData();
  const raw = D.rawMaterials[0];
  const { created } = tx.raisePurchaseOrders(D, [
    { rawMaterialId: raw.id, supplier: 'Solo', qty: 100, unitCost: 2 }
  ]);
  const po = created[0];
  tx.placePurchaseOrder(D, { purchaseOrderId: po.id });
  const res = tx.receiveAgainstOrder(D, { purchaseOrderId: po.id, qty: 40, lotNumber: 'X' });
  ok('a single-line order receives without ceremony', res.ok === true);
  ok('and the receipt is still attributed to the line', po.receipts[0].lineId === po.lines[0].id);
}

console.log('\n--- raising is defensive ---');
{
  const D = seedData();
  const n = D.purchaseOrders.length;
  tx.raisePurchaseOrders(D, []);
  tx.raisePurchaseOrders(D, null);
  tx.raisePurchaseOrders(D, [{ rawMaterialId: 'nope', qty: 10 }]);
  tx.raisePurchaseOrders(D, [{ rawMaterialId: D.rawMaterials[0].id, qty: 0 }]);
  ok('nothing is raised from empty, unknown or zero-quantity rows', D.purchaseOrders.length === n);
}

console.log('\n--- authoring an order by hand ---');
{
  const D = seedData();
  const raw = D.rawMaterials[0];
  const packs = [
    { id: 'pk-s', sku: 'S', packageType: 'sack', size: '60 kg', unitsPerPackage: 60, isDefault: true },
    { id: 'pk-t', sku: 'T', packageType: 'tote', size: '1000 kg', unitsPerPackage: 1000 }
  ];
  raw.packagings = packs;

  const bad = tx.savePurchaseOrder(D, { reference: 'HAND-1', supplier: 'Acme', lines: [] });
  ok('an order with no usable line is refused', bad.ok === false);

  const halfFilled = tx.savePurchaseOrder(D, { reference: 'HAND-1', supplier: 'Acme', lines: [
    { rawMaterialId: raw.id, qty: 600, unitCost: 5, packagingId: 'pk-s', containerCount: 10 },
    { rawMaterialId: '', qty: 0 },                    // abandoned row
    { rawMaterialId: raw.id, qty: 0, unitCost: 5 }    // no quantity
  ]});
  ok('a hand-written order saves', halfFilled.ok === true);
  ok('and drops the half-filled rows rather than refusing the save',
     halfFilled.po.lines.length === 1);
  ok('it is a draft until deliberately placed', halfFilled.po.status === 'Draft');

  // the case the whole line model exists for
  const two = tx.savePurchaseOrder(D, { purchaseOrderId: halfFilled.po.id, reference: 'HAND-1',
    supplier: 'Acme', lines: [
      { rawMaterialId: raw.id, qty: 600, unitCost: 5, packagingId: 'pk-s', containerCount: 10 },
      { rawMaterialId: raw.id, qty: 3000, unitCost: 4.5, packagingId: 'pk-t', containerCount: 3 }
    ]});
  ok('the same material can be ordered in two container sizes on one order',
     two.ok === true && two.po.lines.length === 2);
  ok('each size keeps its own container', two.po.lines[0].packagingId === 'pk-s' && two.po.lines[1].packagingId === 'pk-t');
  ok('and its own price', two.po.lines[0].unitCost === 5 && two.po.lines[1].unitCost === 4.5);
  ok('editing did not duplicate the order',
     D.purchaseOrders.filter(p => p.reference === 'HAND-1').length === 1);
  ok('order value is the sum of the lines', Math.abs(poTotalCost(two.po) - (600 * 5 + 3000 * 4.5)) < 0.001);

  const dupe = tx.savePurchaseOrder(D, { reference: 'HAND-1', supplier: 'X',
    lines: [{ rawMaterialId: raw.id, qty: 1, unitCost: 1 }] });
  ok('a reference already in use is refused', dupe.ok === false);

  const auto = tx.savePurchaseOrder(D, { supplier: 'X', lines: [{ rawMaterialId: raw.id, qty: 1, unitCost: 1 }] });
  ok('a missing reference is minted', auto.ok === true && !!auto.po.reference);

  // once placed it is a commitment, not a draft
  tx.placePurchaseOrder(D, { purchaseOrderId: two.po.id });
  const afterPlace = tx.savePurchaseOrder(D, { purchaseOrderId: two.po.id, reference: 'HAND-1',
    supplier: 'Acme', lines: [{ rawMaterialId: raw.id, qty: 999, unitCost: 5 }] });
  ok('a placed order cannot be edited', afterPlace.ok === false);
  ok('and its lines are untouched by the attempt', two.po.lines.length === 2);
  ok('editing an order that does not exist is refused',
     tx.savePurchaseOrder(D, { purchaseOrderId: 'nope', lines: [{ rawMaterialId: raw.id, qty: 1 }] }).ok === false);
}

console.log('\n--- cancelling ---');
{
  const D = seedData();
  const raw = D.rawMaterials[0];
  const made = tx.savePurchaseOrder(D, { supplier: 'Acme', lines: [{ rawMaterialId: raw.id, qty: 100, unitCost: 2 }] });
  const po = made.po;
  ok('a draft can be cancelled', tx.cancelPurchaseOrder(D, { purchaseOrderId: po.id, reason: 'no longer needed' }).ok === true);
  ok('the reason is recorded', /no longer needed/.test(po.notes));
  ok('a cancelled order owes nothing', poOutstanding(po) === 0);
  ok('and stops counting as cover', openOrderQty(D, raw.id) === 0 || !D.purchaseOrders.some(p => p.id === po.id && p.status !== 'Cancelled'));
  ok('cancelling twice is refused', tx.cancelPurchaseOrder(D, { purchaseOrderId: po.id }).ok === false);
  ok('it is no longer receivable', !tx.receivablePurchaseOrders(D).some(p => p.id === po.id));

  const done = tx.savePurchaseOrder(D, { supplier: 'B', lines: [{ rawMaterialId: raw.id, qty: 10, unitCost: 1 }] }).po;
  tx.placePurchaseOrder(D, { purchaseOrderId: done.id });
  tx.receiveAgainstOrder(D, { purchaseOrderId: done.id, qty: 10, lotNumber: 'ALL-IN' });
  ok('an order received in full cannot be cancelled',
     tx.cancelPurchaseOrder(D, { purchaseOrderId: done.id }).ok === false);
  ok('cancelling an order that does not exist is refused',
     tx.cancelPurchaseOrder(D, { purchaseOrderId: 'nope' }).ok === false);
}

console.log('\n--- references ---');
{
  const D = seedData();
  const ref = nextPoReference(D);
  ok('a minted reference is not already in use', !D.purchaseOrders.some(p => p.reference === ref));
  ok('references keep climbing past the highest existing number',
     nextPoReference({ purchaseOrders: [{ reference: 'PO-0009' }] }) === 'PO-0010');
  ok('an empty database still mints a first reference',
     nextPoReference({ purchaseOrders: [] }) === 'PO-0001');
}

console.log('\n--- receiving against the order still works end to end ---');
{
  const D = seedData();
  const raw = D.rawMaterials[0];
  raw.lots.forEach(l => { l.qty = 0; });
  raw.onOrder = 0;
  D.purchaseOrders = D.purchaseOrders.filter(po => !(po.lines || []).some(l => l.rawMaterialId === raw.id));
  const rows = suggestPurchaseOrders(D, { today: '2026-07-31' }).filter(r => r.rawMaterialId === raw.id);
  const po = tx.raisePurchaseOrders(D, rows).created[0];
  const half = po.lines[0].qty / 2;

  ok('a draft order is not receivable until it is placed',
     !tx.receivablePurchaseOrders(D).some(p => p.id === po.id));
  ok('placing the order succeeds', tx.placePurchaseOrder(D, { purchaseOrderId: po.id }).ok === true);
  ok('a placed order is receivable', tx.receivablePurchaseOrders(D).some(p => p.id === po.id));
  ok('placing it twice is refused', tx.placePurchaseOrder(D, { purchaseOrderId: po.id }).ok === false);

  const first = tx.receiveAgainstOrder(D, { purchaseOrderId: po.id, date: '2026-08-01', qty: half, lotNumber: 'DOCK-1' });
  ok('a part delivery is accepted', first.ok === true);
  ok('it creates a stock lot', !!first.lot && first.lot.qty === half);
  ok('the order shows part received', po.status === 'Part received');
  ok('the balance is still outstanding', Math.abs(poOutstanding(po) - half) < 0.001);
  ok('the lot is priced from the line', first.lot.unitCost === po.lines[0].unitCost);

  const second = tx.receiveAgainstOrder(D, { purchaseOrderId: po.id, date: '2026-08-09', qty: half, lotNumber: 'DOCK-2' });
  ok('the balance can be received', second.ok === true);
  ok('the order completes', po.status === 'Received');
  ok('nothing is left outstanding', poOutstanding(po) === 0);
  ok('each delivery is its own receipt', (po.receipts || []).length === 2);
  ok('every receipt points at the lot it created', (po.receipts || []).every(r => !!r.lotId));
  ok('the stock landed on the material',
     rawStockOnHand(D.rawMaterials.find(r => r.id === raw.id)) >= po.lines[0].qty - 0.001);
  ok('a completed order drops out of the receivable list',
     !tx.receivablePurchaseOrders(D).some(p => p.id === po.id));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
