import { ENTITIES, seedData, repo, tx, lotCost, lotProducedQty,
         itemActualUnitCost, batchRecords, computeItemUnitCost,
         exportCsvBundle, importCsvBundle, allTables, csvColumns } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + String(x).slice(0, 400) : '')); } };
const near = (a, b, tol) => Math.abs(a - b) < (tol === undefined ? 0.005 : tol);

/* A tiny plant where every cost is checkable by hand. */
function plant() {
  const d = Object.fromEntries(ENTITIES.map(e => [e, []]));
  d.rawMaterials.push({
    id: 'RM1', name: 'Bean', sku: 'RM1', supplier: '', unitCost: 10, unit: 'kg',
    certStatus: '', leadTimeDays: 0, moq: 0, reorderPoint: 0, onOrder: 0, notes: '',
    composition: [], lots: []
  });
  d.intermediateProducts.push({
    id: 'IP1', name: 'Powder', sku: 'IP1', unit: 'kg', notes: '', composition: [],
    autoComposition: false, hazardClass: '', lots: []
  });
  d.finishedGoods.push({
    id: 'FG1', name: 'Jar', sku: 'FG1', unit: 'ea', notes: '', composition: [],
    autoComposition: false, hazardClass: '', lots: []
  });
  d.processes.push({
    id: 'P1', name: 'Make powder', sku: 'P1', notes: '', productionTimeHours: 4,
    inputs: [{ id: 'i1', itemType: 'raw', itemId: 'RM1', qty: 100 }],
    equipment: [], outputs: [{ id: 'o1', itemType: 'intermediate', itemId: 'IP1', qtyPerBatch: 50, costOverride: '' }]
  });
  return d;
}
const addLot = (item, over) => {
  const lot = {
    id: over.id || ('L' + Math.random().toString(36).slice(2, 8)),
    lotNumber: '', date: '2026-01-01', qty: 0, producedQty: '', unitCost: '',
    batchId: '', processId: '', notes: '', usedDate: '', consumedDate: '',
    sources: [], actualEquipment: [], actualLabor: [], qcChecks: [], ...over
  };
  item.lots.push(lot);
  return lot;
};

console.log('\n--- purchased lots hold the price paid ---');
{
  const d = plant();
  const cheap = addLot(d.rawMaterials[0], { id: 'A', lotNumber: 'A', qty: 100, producedQty: 100, unitCost: 4 });
  const dear = addLot(d.rawMaterials[0], { id: 'B', lotNumber: 'B', qty: 100, producedQty: 100, unitCost: 9 });

  const a = lotCost(d, 'raw', 'RM1', 'A');
  const b = lotCost(d, 'raw', 'RM1', 'B');
  ok('each lot reports its own price', a.unitCost === 4 && b.unitCost === 9);
  ok('and its own total', a.totalCost === 400 && b.totalCost === 900);
  ok('basis is recorded as purchased', a.basis === 'purchased' && !a.estimated);

  // the material's list price is now 10 - neither lot should move
  d.rawMaterials[0].unitCost = 25;
  ok('RAISING THE LIST PRICE DOES NOT REPRICE EXISTING LOTS',
     lotCost(d, 'raw', 'RM1', 'A').unitCost === 4 &&
     lotCost(d, 'raw', 'RM1', 'B').unitCost === 9);
  ok('but the standard cost does move', computeItemUnitCost(d, 'raw', 'RM1') === 25);
}

console.log('\n--- a lot with no recorded price falls back, and says so ---');
{
  const d = plant();
  addLot(d.rawMaterials[0], { id: 'C', qty: 50, producedQty: 50, unitCost: '' });
  const c = lotCost(d, 'raw', 'RM1', 'C');
  ok('falls back to the list price', c.unitCost === 10);
  ok('flagged as estimated', c.estimated === true && c.basis === 'listPrice');
}

console.log('\n--- cost rolls forward along the traceability links ---');
{
  const d = plant();
  addLot(d.rawMaterials[0], { id: 'A', lotNumber: 'A', qty: 0, producedQty: 100, unitCost: 4 });
  // 100 kg of bean at 4 makes 50 kg of powder => 8/kg
  addLot(d.intermediateProducts[0], {
    id: 'P', lotNumber: 'P', qty: 50, producedQty: 50,
    sources: [{ id: 's', groupKey: 'raw:RM1', lotId: 'A', qty: 100 }]
  });
  const p = lotCost(d, 'intermediate', 'IP1', 'P');
  ok('unit cost is input cost over quantity made', near(p.unitCost, 8), String(p.unitCost));
  ok('total cost equals the inputs consumed', near(p.totalCost, 400), String(p.totalCost));
  ok('basis is rolled up', p.basis === 'rolledUp' && p.estimated === false);
  ok('the contributing lot is itemised', p.sources.length === 1 &&
     p.sources[0].lotNumber === 'A' && near(p.sources[0].cost, 400));
}

console.log('\n--- two deliveries at different prices blend correctly ---');
{
  const d = plant();
  addLot(d.rawMaterials[0], { id: 'A', lotNumber: 'A', qty: 0, producedQty: 60, unitCost: 5 });
  addLot(d.rawMaterials[0], { id: 'B', lotNumber: 'B', qty: 0, producedQty: 40, unitCost: 10 });
  // 60 @ 5 = 300, 40 @ 10 = 400, total 700 over 50 kg made => 14/kg
  addLot(d.intermediateProducts[0], {
    id: 'P', qty: 50, producedQty: 50,
    sources: [{ id: 's1', groupKey: 'raw:RM1', lotId: 'A', qty: 60 },
              { id: 's2', groupKey: 'raw:RM1', lotId: 'B', qty: 40 }]
  });
  const p = lotCost(d, 'intermediate', 'IP1', 'P');
  ok('blended cost is quantity-weighted, not averaged', near(p.unitCost, 14), String(p.unitCost));
  ok('both deliveries appear in the breakdown', p.sources.length === 2);
}

console.log('\n--- producedQty, not remaining qty, divides the cost ---');
{
  const d = plant();
  addLot(d.rawMaterials[0], { id: 'A', qty: 0, producedQty: 100, unitCost: 4 });
  const lot = addLot(d.intermediateProducts[0], {
    id: 'P', qty: 50, producedQty: 50,
    sources: [{ id: 's', groupKey: 'raw:RM1', lotId: 'A', qty: 100 }]
  });
  const before = lotCost(d, 'intermediate', 'IP1', 'P').unitCost;
  // draw the lot most of the way down, as consumption would
  lot.qty = 5;
  const after = lotCost(d, 'intermediate', 'IP1', 'P', {}).unitCost;
  ok('DRAWING A LOT DOWN DOES NOT CHANGE ITS UNIT COST',
     near(before, after) && near(after, 8), before + ' -> ' + after);
  ok('lotProducedQty prefers the recorded figure', lotProducedQty(lot) === 50);
  ok('and falls back to remaining when absent',
     lotProducedQty({ qty: 7, producedQty: '' }) === 7);
}

console.log('\n--- three levels deep ---');
{
  const d = plant();
  addLot(d.rawMaterials[0], { id: 'A', qty: 0, producedQty: 100, unitCost: 4 });
  addLot(d.intermediateProducts[0], {
    id: 'P', qty: 0, producedQty: 50,
    sources: [{ id: 's', groupKey: 'raw:RM1', lotId: 'A', qty: 100 }]
  });
  // 25 kg of powder at 8 = 200, over 500 jars => 0.40 each
  addLot(d.finishedGoods[0], {
    id: 'F', qty: 500, producedQty: 500,
    sources: [{ id: 's', groupKey: 'intermediate:IP1', lotId: 'P', qty: 25 }]
  });
  const f = lotCost(d, 'finished', 'FG1', 'F');
  ok('cost carries through two conversions', near(f.unitCost, 0.4), String(f.unitCost));
  ok('and the immediate parent is itemised',
     f.sources.length === 1 && near(f.sources[0].unitCost, 8));
}

console.log('\n--- an estimate anywhere upstream is flagged downstream ---');
{
  const d = plant();
  addLot(d.rawMaterials[0], { id: 'A', qty: 0, producedQty: 100, unitCost: '' });
  addLot(d.intermediateProducts[0], {
    id: 'P', qty: 50, producedQty: 50,
    sources: [{ id: 's', groupKey: 'raw:RM1', lotId: 'A', qty: 100 }]
  });
  const p = lotCost(d, 'intermediate', 'IP1', 'P');
  ok('the downstream lot inherits the estimate flag', p.estimated === true);
  ok('the offending contribution is marked', p.sources[0].estimated === true);
}

console.log('\n--- guards ---');
{
  const d = plant();
  ok('a missing lot reports zero rather than throwing',
     lotCost(d, 'intermediate', 'IP1', 'nope').basis === 'missing');

  // self-referential genealogy
  addLot(d.intermediateProducts[0], {
    id: 'X', qty: 10, producedQty: 10,
    sources: [{ id: 's', groupKey: 'intermediate:IP1', lotId: 'X', qty: 5 }]
  });
  const t0 = Date.now();
  const x = lotCost(d, 'intermediate', 'IP1', 'X');
  ok('a cyclic genealogy terminates', Date.now() - t0 < 2000);
  ok('and is reported', x.estimated === true);

  const d2 = plant();
  addLot(d2.intermediateProducts[0], { id: 'N', qty: 10, producedQty: 10, sources: [] });
  const n = lotCost(d2, 'intermediate', 'IP1', 'N');
  ok('a produced lot with no sources falls back to standard cost',
     n.basis === 'standardCost' && n.estimated === true);
}

console.log('\n--- weighted actual cost of stock on hand ---');
{
  const d = plant();
  addLot(d.rawMaterials[0], { id: 'A', qty: 30, producedQty: 100, unitCost: 4 });
  addLot(d.rawMaterials[0], { id: 'B', qty: 70, producedQty: 100, unitCost: 9 });
  const a = itemActualUnitCost(d, 'raw', 'RM1');
  // 30 @ 4 + 70 @ 9 = 750 over 100 => 7.50
  ok('weighted by remaining stock, not by lot count', near(a.unitCost, 7.5), String(a.unitCost));
  ok('stock quantity and value reported', a.stockQty === 100 && near(a.stockValue, 750));
  const d2 = plant();
  addLot(d2.rawMaterials[0], { id: 'Z', qty: 0, producedQty: 10, unitCost: 4 });
  ok('an item with no stock reports null', itemActualUnitCost(d2, 'raw', 'RM1') === null);
}

console.log('\n--- batch records ---');
{
  const d = plant();
  addLot(d.rawMaterials[0], { id: 'A', lotNumber: 'GRN-1', qty: 0, producedQty: 100, unitCost: 4 });
  addLot(d.intermediateProducts[0], {
    id: 'P', lotNumber: 'PWD-1', qty: 50, producedQty: 50, date: '2026-02-05',
    batchId: 'BATCH-1', processId: 'P1',
    sources: [{ id: 's', groupKey: 'raw:RM1', lotId: 'A', qty: 100 }],
    actualEquipment: [{ id: 'e', equipmentId: 'EQ-X', hours: 4 }],
    actualLabor: [{ id: 'l', operatorName: 'A. Smith', hours: 3.5 }],
    qcChecks: [{ id: 'q', componentId: '', mode: 'manual', measuredValue: 3.4, concentration: 3.4 }]
  });

  const recs = batchRecords(d);
  ok('one record for the batch', recs.length === 1);
  const r = recs[0];
  ok('it names the process', r.processName === 'Make powder');
  ok('it is dated', r.date === '2026-02-05');
  ok('outputs listed with cost', r.outputs.length === 1 && near(r.outputs[0].unitCost, 8));
  ok('inputs listed with cost', r.inputs.length === 1 &&
     r.inputs[0].lotNumber === 'GRN-1' && near(r.inputs[0].cost, 400));
  ok('input and output cost balance', near(r.inputCost, r.outputCost));
  ok('equipment hours captured', r.equipmentHours === 4);
  ok('labour hours captured', r.labourHours === 3.5);
  ok('QC count captured', r.qcChecks === 1);

  // purchased lots are not batches
  ok('a purchased lot produces no batch record',
     recs.every(x => x.outputs.every(o => o.itemType !== 'raw')));

  ok('filtering by process works', batchRecords(d, { processId: 'P1' }).length === 1 &&
     batchRecords(d, { processId: 'nope' }).length === 0);
  ok('filtering by date works',
     batchRecords(d, { from: '2026-02-01', to: '2026-02-28' }).length === 1 &&
     batchRecords(d, { from: '2026-03-01', to: '2026-03-31' }).length === 0);
}

console.log('\n--- a batch with several outputs groups as one record ---');
{
  const d = plant();
  d.wasteStreams.push({ id: 'WS1', name: 'Chaff', sku: 'WS1', unit: 'kg', notes: '',
    componentId: '', accumulate: true, hazardClass: '', lots: [] });
  addLot(d.rawMaterials[0], { id: 'A', qty: 0, producedQty: 100, unitCost: 4 });
  const shared = { batchId: 'B9', processId: 'P1', date: '2026-04-01' };
  addLot(d.intermediateProducts[0], { id: 'P', lotNumber: 'PWD-9', qty: 50, producedQty: 50,
    sources: [{ id: 's', groupKey: 'raw:RM1', lotId: 'A', qty: 100 }], ...shared });
  addLot(d.wasteStreams[0], { id: 'W', lotNumber: 'CHF-9', qty: 3, producedQty: 3, ...shared });
  const recs = batchRecords(d);
  ok('one record, two outputs', recs.length === 1 && recs[0].outputs.length === 2);
  ok('the by-product carries no material cost',
     near(recs[0].outputs.find(o => o.itemType === 'waste').totalCost, 0));
  ok('so all cost lands on the good output',
     near(recs[0].outputCost, 400), String(recs[0].outputCost));
}

console.log('\n--- logging a batch stamps identity and cost basis ---');
{
  const d = plant();
  addLot(d.rawMaterials[0], { id: 'A', lotNumber: 'G1', qty: 100, producedQty: 100, unitCost: 4 });
  const created = tx.logProductionBatch(d, {
    processId: 'P1', date: '2026-05-05', notes: '',
    sources: [{ id: 's', groupKey: 'raw:RM1', lotId: 'A', qty: 100 }],
    outputs: [{ outputId: 'o1', lotNumber: 'PWD-NEW', qty: 50, qcChecks: [] }],
    actualEquipment: [], actualLabor: [], wasteAllocations: []
  });
  ok('the lot was created', created.length === 1);
  const lot = d.intermediateProducts[0].lots.find(l => l.lotNumber === 'PWD-NEW');
  ok('producedQty recorded at creation', lot.producedQty === 50);
  ok('batch identity stamped', !!lot.batchId);
  ok('process recorded on the lot', lot.processId === 'P1');
  ok('it appears as a batch record', batchRecords(d).some(b => b.batchId === lot.batchId));
  ok('and it costs correctly', near(lotCost(d, 'intermediate', 'IP1', lot.id).unitCost, 8));
}

console.log('\n--- goods-in records the price paid ---');
{
  const d = plant();
  const lot = tx.receiveRawLot(d, { rawMaterialId: 'RM1', lotNumber: 'GI-1',
    date: '2026-06-01', qty: 200, notes: '', unitCost: 6.25 });
  ok('the price is stored on the lot', lot.unitCost === 6.25);
  ok('producedQty set from the received quantity', lot.producedQty === 200);
  ok('and it costs from that, not the list price',
     lotCost(d, 'raw', 'RM1', lot.id).unitCost === 6.25);

  const noPrice = tx.receiveRawLot(d, { rawMaterialId: 'RM1', lotNumber: 'GI-2',
    date: '2026-06-02', qty: 10, notes: '' });
  ok('omitting the price falls back to the list price, recorded on the lot',
     noPrice.unitCost === 10);
}

console.log('\n--- against the real dataset ---');
{
  const d = seedData();
  const cache = {};
  const recs = batchRecords(d);
  ok('the seed produces batch records', recs.length > 100, String(recs.length));
  ok('every record names a real process', recs.every(r => !!r.process));
  ok('every record is dated', recs.every(r => !!r.date));
  ok('input and output cost balance on every batch',
     recs.every(r => r.inputs.length === 0 || near(r.inputCost, r.outputCost, 0.5)),
     recs.filter(r => r.inputs.length && !near(r.inputCost, r.outputCost, 0.5))
         .slice(0, 2).map(r => r.processName + ': ' + r.inputCost + ' vs ' + r.outputCost).join('; '));

  const green = d.rawMaterials.find(x => x.sku === 'GC-BR-SANTOS');
  const prices = (green.lots || []).map(l => Number(l.unitCost));
  ok('purchased lots carry prices', prices.every(p => p > 0));
  ok('and those prices change over the period', new Set(prices).size > 1,
     JSON.stringify(prices));

  const early = (green.lots || []).slice().sort((a, b) => a.date.localeCompare(b.date))[0];
  const late = (green.lots || []).slice().sort((a, b) => b.date.localeCompare(a.date))[0];
  ok('the later delivery is dearer, reflecting the supplier increase',
     Number(late.unitCost) > Number(early.unitCost),
     early.date + ' @ ' + early.unitCost + ' vs ' + late.date + ' @ ' + late.unitCost);

  const pw = d.intermediateProducts.find(x => x.sku === 'IP-PWD-CLS');
  const costs = (pw.lots || []).map(l => lotCost(d, 'intermediate', pw.id, l.id, cache).unitCost);
  ok('powder lots roll up to non-zero costs', costs.every(c => c > 0));
  ok('and they differ between batches', new Set(costs.map(c => c.toFixed(2))).size > 1);
  ok('actual cost differs from the standard cost',
     !near(itemActualUnitCost(d, 'intermediate', pw.id, cache).unitCost,
           computeItemUnitCost(d, 'intermediate', pw.id), 0.01));
}

console.log('\n--- cost fields survive export and import ---');
{
  const d = seedData();
  const t = allTables().find(x => x.table === 'lots');
  const cols = csvColumns(t);
  ok('lots export a unit cost', cols.includes('unitCost'));
  ok('lots export the produced quantity', cols.includes('producedQty'));
  ok('lots export batch identity', cols.includes('batchId') && cols.includes('processId'));

  const bundle = exportCsvBundle(d);
  const files = Object.fromEntries(bundle.map(b => [b.table, b.csv]));
  const empty = Object.fromEntries(ENTITIES.map(e => [e, []]));
  const { data, report } = importCsvBundle(empty, files);
  ok('round trip clean', report.errors.length === 0, report.errors.slice(0, 3).join('; '));

  const gA = d.rawMaterials.find(x => x.sku === 'GC-BR-SANTOS');
  const gB = data.rawMaterials.find(x => x.sku === 'GC-BR-SANTOS');
  ok('purchased prices survive',
     JSON.stringify((gA.lots || []).map(l => Number(l.unitCost))) ===
     JSON.stringify((gB.lots || []).map(l => Number(l.unitCost))));
  ok('batch records rebuild after a round trip',
     batchRecords(data).length === batchRecords(d).length,
     batchRecords(data).length + ' vs ' + batchRecords(d).length);
}


console.log('\n--- by-products are costed as a decision, not an estimate ---');
{
  const d = plant();
  d.wasteStreams.push({ id: 'WS1', name: 'Chaff', sku: 'WS1', unit: 'kg', notes: '',
    componentId: '', accumulate: true, hazardClass: '', lots: [] });
  addLot(d.wasteStreams[0], { id: 'W', lotNumber: 'CHF-1', qty: 5, producedQty: 5 });
  const c = lotCost(d, 'waste', 'WS1', 'W');
  ok('a waste stream item resolves', c.basis !== 'missing', c.basis);
  ok('it carries no material cost', c.unitCost === 0 && c.totalCost === 0);
  ok('and is NOT flagged as an estimate', c.estimated === false, 'basis=' + c.basis);
}

console.log('\n--- current inventory traces back to a batch ---');
{
  const d = seedData();
  const ents = { raw: 'rawMaterials', intermediate: 'intermediateProducts',
                 finished: 'finishedGoods', waste: 'wasteStreams' };
  let stock = 0, traceable = 0, purchasedInStock = 0;
  Object.entries(ents).forEach(([t, e]) => (d[e] || []).forEach(i => (i.lots || []).forEach(l => {
    if ((Number(l.qty) || 0) <= 0) return;
    stock++;
    if (l.batchId) traceable++;
    else if (t === 'raw') purchasedInStock++;
  })));
  ok('there is stock on hand', stock > 300, String(stock));
  ok('every produced lot in stock names its batch',
     traceable + purchasedInStock === stock,
     stock + ' in stock, ' + traceable + ' traceable, ' + purchasedInStock + ' purchased');

  const recs = batchRecords(d);
  const live = recs.filter(r => r.outputs.some(o => o.remainingQty > 0));
  ok('most batches still have output in stock', live.length > 300, String(live.length));

  // work in progress at every stage of the chain
  const wip = d.intermediateProducts.filter(i => (i.lots || []).some(l => (Number(l.qty) || 0) > 0));
  ok('every intermediate product holds some stock',
     wip.length === d.intermediateProducts.length,
     wip.length + ' of ' + d.intermediateProducts.length);
  ['SORT', 'ROAST', 'GRIND', 'EXT', 'CONC', 'PWD'].forEach(stage => {
    ok('work in progress exists at the ' + stage.toLowerCase() + ' stage',
       wip.some(i => i.sku.includes(stage)));
  });

  ok('no lot reports more remaining than it produced',
     Object.entries(ents).every(([, e]) => (d[e] || []).every(i =>
       (i.lots || []).every(l => (Number(l.qty) || 0) <= (Number(l.producedQty) || 0) + 0.01))));

  const cache = {};
  const bases = {};
  Object.entries(ents).forEach(([t, e]) => (d[e] || []).forEach(i => (i.lots || []).forEach(l => {
    bases[lotCost(d, t, i.id, l.id, cache).basis] = true;
  })));
  ok('no lot is unresolvable', !bases.missing, Object.keys(bases).join(', '));
  ok('no batch is falsely flagged as estimated',
     recs.every(r => !r.estimated), String(recs.filter(r => r.estimated).length));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
