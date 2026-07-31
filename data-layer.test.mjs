import { SCHEMA, ENTITIES, repo, tx, seedData, getWasteStreamForComponent,
         computeEffectiveComposition } from '/tmp/core.mjs';

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const todayStr = () => new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ->  ' + extra : '')); }
};

/* Strip ids so two runs that mint different uuids can still be compared
   structurally - the refactor must not change anything except ids. */
const scrub = (o) => JSON.parse(JSON.stringify(o, (k, v) =>
  (k === 'id' || k === 'lotId') ? '<id>' : v));
const same = (a, b) => JSON.stringify(scrub(a)) === JSON.stringify(scrub(b));

const fresh = () => JSON.parse(JSON.stringify(BASE));
const BASE = seedData();

console.log('\n--- schema integrity ---');
// seedVersion is app metadata, not a table - compare collections only
const seedKeys = Object.keys(BASE).filter(k => Array.isArray(BASE[k])).sort();
ok('SCHEMA covers every seeded collection', JSON.stringify(seedKeys) === JSON.stringify(ENTITIES.slice().sort()),
   'seed=' + seedKeys.join(',') + ' schema=' + ENTITIES.slice().sort().join(','));
ok('every table name is unique', new Set(ENTITIES.map(e => SCHEMA[e].table)).size === ENTITIES.length);
let badRef = [];
ENTITIES.forEach(e => {
  Object.entries(SCHEMA[e].refs || {}).forEach(([col, target]) => {
    if (!SCHEMA[target]) badRef.push(e + '.' + col + ' -> ' + target);
  });
  Object.values(SCHEMA[e].children || {}).forEach(ch => {
    Object.entries(ch.refs || {}).forEach(([col, target]) => {
      if (!SCHEMA[target]) badRef.push(e + '.' + ch.table + '.' + col + ' -> ' + target);
    });
  });
});
ok('every FK points at a real table', badRef.length === 0, badRef.join('; '));

console.log('\n--- repo CRUD on every entity ---');
ENTITIES.forEach(e => {
  const d = fresh();
  const before = repo.list(d, e).length;
  const row = repo.create(d, e, { name: 'zz-probe' });
  const grew = repo.list(d, e).length === before + 1;
  const found = repo.find(d, e, row.id) !== null;
  repo.upsert(d, e, row.id, { name: 'zz-probe-2' });
  const replaced = repo.find(d, e, row.id).name === 'zz-probe-2';
  const sameLen = repo.list(d, e).length === before + 1;
  repo.remove(d, e, row.id);
  const shrank = repo.list(d, e).length === before && repo.find(d, e, row.id) === null;
  ok(e + ': create/find/upsert/remove roundtrip', grew && found && replaced && sameLen && shrank);
});

console.log('\n--- upsert preserves id on edit, mints on insert ---');
{
  const d = fresh();
  const existing = d.rawMaterials[0];
  repo.upsert(d, 'rawMaterials', existing.id, { ...existing, name: 'renamed' });
  ok('edit keeps the same id', repo.find(d, 'rawMaterials', existing.id).name === 'renamed');
  ok('edit does not duplicate the row',
     d.rawMaterials.filter(r => r.id === existing.id).length === 1);
  const n = d.rawMaterials.length;
  const made = repo.upsert(d, 'rawMaterials', null, { name: 'brand new' });
  ok('insert appends with a fresh id', d.rawMaterials.length === n + 1 && !!made.id);
}

/* =================================================================
   Equivalence vs V1: the original inline blocks, copied verbatim
   from mrp-console_V1.jsx, run against an identical starting state.
================================================================= */

console.log('\n--- tx.receiveRawLot vs V1 inline ---');
{
  const f = { rawMaterialId: BASE.rawMaterials[0].id, lotNumber: 'TEST-1', date: '2026-01-05', qty: 42, notes: 'n' };
  const a = fresh(), b = fresh();
  // V1:
  (d => {
    const target = d.rawMaterials.find(r => r.id === f.rawMaterialId);
    if (target) target.lots.push({ id: uid(), lotNumber: f.lotNumber, date: f.date, qty: f.qty, notes: f.notes, sources: [], actualEquipment: [], actualLabor: [] });
  })(a);
  tx.receiveRawLot(b, f);
  const av = a.rawMaterials[0].lots.at(-1), bv = b.rawMaterials[0].lots.at(-1);
  ok('lot qty/number/date match', av.qty === bv.qty && av.lotNumber === bv.lotNumber && av.date === bv.date);
  ok('lot count matches', a.rawMaterials[0].lots.length === b.rawMaterials[0].lots.length);
  ok('rest of db untouched', same({ ...a, rawMaterials: null }, { ...b, rawMaterials: null }));
}

console.log('\n--- tx.shipFinishedGoods vs V1 inline ---');
{
  const fg = BASE.finishedGoods.find(x => x.lots && x.lots.length);
  const f = { finishedGoodId: fg.id, lotId: fg.lots[0].id, qty: 2, customerId: BASE.customers[0].id, date: '2026-02-02' };
  const a = fresh(), b = fresh();
  (d => {
    const targetFg = d.finishedGoods.find(x => x.id === f.finishedGoodId);
    const lot = targetFg ? targetFg.lots.find(l => l.id === f.lotId) : null;
    if (lot) lot.qty = Math.max(0, (Number(lot.qty) || 0) - Number(f.qty));
    d.shipments.push({ ...f, id: uid() });
  })(a);
  tx.shipFinishedGoods(b, { ...f });
  ok('source lot drawn down identically', same(a.finishedGoods, b.finishedGoods));
  /* tx.shipFinishedGoods now also links the despatch to the run whose lot it
     drew on - an intentional divergence from V1, since fulfilment cannot be
     reconciled against despatch without it. Everything else must still match. */
  const dropLink = (o) => JSON.parse(JSON.stringify(o), function (k, v) {
    return k === 'scheduleId' ? undefined : v;
  });
  ok('shipment row otherwise identical', same(dropLink(a.shipments), dropLink(b.shipments)));
  ok('whole db otherwise identical', same(dropLink(a), dropLink(b)));
  ok('and the despatch records which run it satisfies',
     'scheduleId' in b.shipments[b.shipments.length - 1]);
}

console.log('\n--- tx.consumeLot vs V1 inline ---');
{
  const src = BASE.rawMaterials.find(r => r.lots && r.lots.length);
  const lot = src.lots[0];
  const reason = 'Spoiled';
  const lotPatch = {
    disposition: { reason, disposeImmediately: false, accumulateAsWaste: true, note: 'x', date: todayStr() },
    notes: (lot.notes ? lot.notes + ' \u2014 ' : '') + '[' + reason + '] x',
    qty: 0,
    consumedDate: lot.consumedDate || todayStr()
  };
  const itemType = 'raw', itemId = src.id;
  const a = fresh(), b = fresh();
  (d => {  // V1 inline
    const targetArray = itemType === 'raw' ? d.rawMaterials : itemType === 'finished' ? d.finishedGoods : d.intermediateProducts;
    const targetItem = targetArray.find(x => x.id === itemId);
    const targetLot = targetItem ? (targetItem.lots || []).find(l => l.id === lot.id) : null;
    if (!targetLot) return;
    const remainingQty = Number(targetLot.qty) || 0;
    if (remainingQty > 0) {
      computeEffectiveComposition(d, itemType, itemId).forEach(c => {
        const wasteQty = remainingQty * ((Number(c.percentage) || 0) / 100);
        if (wasteQty <= 0) return;
        const ws = getWasteStreamForComponent(d, c.componentId);
        if (!ws || !ws.accumulate) return;
        const wsTarget = d.wasteStreams.find(x => x.id === ws.id);
        if (!wsTarget) return;
        wsTarget.lots.push({
          id: uid(), lotNumber: '', date: todayStr(), qty: Math.round(wasteQty * 100) / 100,
          notes: 'Auto-logged from consuming lot ' + (targetLot.lotNumber || targetLot.id) + ' (' + reason + ')',
          sources: [], actualEquipment: [], actualLabor: []
        });
      });
    }
    Object.assign(targetLot, lotPatch);
  })(a);
  tx.consumeLot(b, { itemType, itemId, lotId: lot.id, lotPatch, accumulateAsWaste: true, flagDaughterLots: false });
  ok('consumed lot state identical', same(a.rawMaterials, b.rawMaterials));
  const aw = a.wasteStreams.flatMap(w => w.lots.map(l => l.qty));
  const bw = b.wasteStreams.flatMap(w => w.lots.map(l => l.qty));
  ok('waste accrued identically', JSON.stringify(aw) === JSON.stringify(bw), aw + ' vs ' + bw);
  ok('consumed lot qty is 0', repo.findItemLot(b, itemType, itemId, lot.id).qty === 0);
}

console.log('\n--- tx.logProductionBatch vs V1 inline ---');
{
  const proc = BASE.processes.find(p => p.outputs && p.outputs.length && p.inputs && p.inputs.length);
  const outLine = proc.outputs[0];
  const inLine = proc.inputs[0];
  const srcEntity = inLine.itemType === 'raw' ? 'rawMaterials'
    : inLine.itemType === 'finished' ? 'finishedGoods' : 'intermediateProducts';
  const srcItem = BASE[srcEntity].find(x => x.id === inLine.itemId);
  const srcLot = srcItem && (srcItem.lots || []).find(l => (Number(l.qty) || 0) > 1);

  const payload = {
    processId: proc.id, date: '2026-03-03', notes: 'batch note',
    sources: srcLot ? [{ id: uid(), groupKey: inLine.itemType + ':' + inLine.itemId, lotId: srcLot.id, qty: 1 }] : [],
    outputs: [{ outputId: outLine.id, lotNumber: 'BATCH-TEST-01', qty: 3, qcChecks: [] }],
    actualEquipment: [], actualLabor: [], wasteAllocations: []
  };

  const a = fresh(), b = fresh();
  const createdA = [];
  (d => {  // V1 inline
    const p = d.processes.find(x => x.id === payload.processId);
    if (!p) return;
    payload.outputs.forEach(entry => {
      if (!(entry.qty > 0)) return;
      const ol = p.outputs.find(o => o.id === entry.outputId);
      if (!ol) return;
      const targetArray = ol.itemType === 'finished' ? d.finishedGoods : d.intermediateProducts;
      const target = targetArray.find(x => x.id === ol.itemId);
      if (!target) return;
      const qcChecks = (entry.qcChecks || []).filter(q => q.mode !== 'estimated');
      const lotId = uid();
      target.lots.push({
        id: lotId, lotNumber: entry.lotNumber, date: payload.date, qty: entry.qty, notes: payload.notes,
        sources: payload.sources, actualEquipment: payload.actualEquipment, actualLabor: payload.actualLabor, qcChecks
      });
      createdA.push({ lotId, itemType: ol.itemType, itemId: ol.itemId, lotNumber: entry.lotNumber, qty: entry.qty, unit: target.unit, date: payload.date, qcChecks });
    });
    payload.sources.forEach(s => {
      const qty = Number(s.qty) || 0;
      if (qty <= 0 || !s.lotId) return;
      const sep = s.groupKey.indexOf(':');
      const it = s.groupKey.slice(0, sep), ii = s.groupKey.slice(sep + 1);
      const arr = it === 'raw' ? d.rawMaterials : it === 'finished' ? d.finishedGoods : d.intermediateProducts;
      const si = arr.find(x => x.id === ii);
      if (!si) return;
      const l = (si.lots || []).find(x => x.id === s.lotId);
      if (!l) return;
      l.qty = Math.max(0, (Number(l.qty) || 0) - qty);
      if (!l.usedDate) l.usedDate = payload.date;
      if (l.qty <= 0 && !l.consumedDate) l.consumedDate = payload.date;
    });
  })(a);
  const createdB = tx.logProductionBatch(b, payload);

  ok('created-lot manifest identical', same(createdA, createdB),
     JSON.stringify(scrub(createdA)) + ' vs ' + JSON.stringify(scrub(createdB)));
  /* tx.logProductionBatch now also stamps producedQty, batchId and processId -
     an intentional divergence from V1, since lot-level costing and batch
     records depend on them. Everything else must still match exactly. */
  const stripNew = (o) => JSON.parse(JSON.stringify(o), function (k, v) {
    return ['producedQty','batchId','processId','unitCost'].indexOf(k) >= 0 ? undefined : v;
  });
  ok('output lots otherwise written identically',
     same(stripNew(a.intermediateProducts), stripNew(b.intermediateProducts)));
  {
    const newLot = b.intermediateProducts.flatMap(i => i.lots)
      .find(l => l.lotNumber === 'BATCH-TEST-01');
    ok('and the new lot records what it produced', newLot && newLot.producedQty === 3);
    ok('and which batch and process made it',
       newLot && !!newLot.batchId && newLot.processId === payload.processId);
  }
  ok('finished goods identical', same(a.finishedGoods, b.finishedGoods));
  ok('source lot drawn down identically', same(a[srcEntity], b[srcEntity]));
  ok('one output lot created', createdB.length === 1 && createdB[0].qty === 3);
  if (srcLot) {
    const stampBefore = srcLot.usedDate;
    const after = repo.findItemLot(b, inLine.itemType, inLine.itemId, srcLot.id);
    ok('source lot qty reduced by 1', after.qty === srcLot.qty - 1, srcLot.qty + ' -> ' + after.qty);
    // first use stamps the date; a lot already in use keeps its original stamp
    ok('usedDate is stamped, and an existing stamp is not moved',
       stampBefore ? after.usedDate === stampBefore : after.usedDate === payload.date,
       'before=' + stampBefore + ' after=' + after.usedDate);
  }
}

console.log('\n--- tx.attachFileToLots ---');
{
  const d = fresh();
  const ip = d.intermediateProducts.find(x => x.lots && x.lots.length);
  const att = { key: 'k1', fileName: 'scan.pdf' };
  tx.attachFileToLots(d, [{ itemType: 'intermediate', itemId: ip.id, lotId: ip.lots[0].id }], att);
  ok('attachment written to the target lot', d.intermediateProducts.find(x => x.id === ip.id).lots[0].attachment.key === 'k1');
}

console.log('\n--- itemType mapping ---');
ok('raw/intermediate/finished/waste all map to real tables',
   ['raw', 'intermediate', 'finished', 'waste'].every(t => !!SCHEMA[
     { raw: 'rawMaterials', intermediate: 'intermediateProducts', finished: 'finishedGoods', waste: 'wasteStreams' }[t]]));

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
