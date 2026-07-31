// Purchase orders as the record both systems agree on: the MRP raises them,
// the warehouse receives against them. Covers ordering by the container (units
// conserved), what an order is worth, and the reorder forecast that suggests
// them. Asserts intent and invariants, not wording.
import { seedData, repo, tx, suggestPurchaseOrders,
         unitsPerContainer, packagingLabel, qtyFromContainers, containersFromQty,
         poTotalCost, poContainerSummary, poPackaging, rawStockOnHand,
         nextPoReference, poOutstanding, poReceivedQty, openOrderQty } from '/tmp/core.mjs';

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
ok('total is quantity x unit cost', poTotalCost({ qty: 400, unitCost: 2.5 }) === 1000);
ok('a missing cost is zero, not NaN', poTotalCost({ qty: 400 }) === 0);
ok('an empty order is worth nothing', poTotalCost({}) === 0);

console.log('\n--- the forecast ---');
{
  const D = seedData();
  ok('a fully stocked plant suggests nothing', suggestPurchaseOrders(D, { today: '2026-07-31' }).length === 0);

  // Drain one material and clear its cover, so it is genuinely short.
  const raw = D.rawMaterials[0];
  raw.lots.forEach(l => { l.qty = 0; });
  raw.onOrder = 0;
  D.purchaseOrders = D.purchaseOrders.filter(po => po.rawMaterialId !== raw.id);

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
  ok('one order per suggestion', created.length === rows.length && D.purchaseOrders.length === before + rows.length);
  ok('orders are raised as drafts, not silently placed', created.every(po => po.status === 'Draft'));
  ok('every reference is unique',
     new Set(D.purchaseOrders.map(p => p.reference)).size === D.purchaseOrders.length);
  ok('the order carries the container and how many', created.every(po => po.packagingId && po.containerCount > 0));
  ok('the ordered quantity is receivable in full', created.every(po => poOutstanding(po) === po.qty));
  ok('nothing is received yet', created.every(po => poReceivedQty(po) === 0));
  ok('the order now counts as on order for the material', openOrderQty(D, raw.id) >= row.qty - 0.001);
  ok('the forecast no longer asks for what is now on order',
     !suggestPurchaseOrders(D, { today: '2026-07-31' }).some(r => r.rawMaterialId === raw.id));
  ok('the order reads with its container count', /^\d+ × /.test(poContainerSummary(D, created[0])));
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
  D.purchaseOrders = D.purchaseOrders.filter(po => po.rawMaterialId !== raw.id);
  const rows = suggestPurchaseOrders(D, { today: '2026-07-31' }).filter(r => r.rawMaterialId === raw.id);
  const po = tx.raisePurchaseOrders(D, rows).created[0];
  const half = po.qty / 2;

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
  ok('the lot is priced from the order', first.lot.unitCost === po.unitCost);

  const second = tx.receiveAgainstOrder(D, { purchaseOrderId: po.id, date: '2026-08-09', qty: half, lotNumber: 'DOCK-2' });
  ok('the balance can be received', second.ok === true);
  ok('the order completes', po.status === 'Received');
  ok('nothing is left outstanding', poOutstanding(po) === 0);
  ok('each delivery is its own receipt', (po.receipts || []).length === 2);
  ok('every receipt points at the lot it created', (po.receipts || []).every(r => !!r.lotId));
  ok('the stock landed on the material', rawStockOnHand(D.rawMaterials.find(r => r.id === raw.id)) >= po.qty - 0.001);
  ok('a completed order drops out of the receivable list',
     !tx.receivablePurchaseOrders(D).some(p => p.id === po.id));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
