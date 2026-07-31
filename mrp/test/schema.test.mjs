import { SCHEMA, ENTITIES, repo, tx, seedData, normalizeData,
         allTables, csvColumns, parseColType, backfillRowIds } from '/tmp/core.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + x : '')); } };

const D = seedData();
const TABLES = allTables();

console.log('\n--- schema shape ---');
console.log('  NOTE  distinct tables: ' + TABLES.length);
ok('table count is sane', TABLES.length > 15 && TABLES.length < 60, 'got ' + TABLES.length);
ok('all table names unique', new Set(TABLES.map(t => t.table)).size === TABLES.length);
ok('every table has a pk', TABLES.every(t => t.pk));
ok('every non-root table has an fk or an owner discriminator',
   TABLES.filter(t => t.parentTable).every(t => t.fk || t.polymorphic));
{
  const bad = [];
  TABLES.forEach(t => Object.entries(t.columns).forEach(([c, spec]) => {
    const p = parseColType(spec);
    if (p.kind === 'ref' && !SCHEMA[p.ref]) bad.push(t.table + '.' + c + ' -> ' + p.ref);
    if (!['str','num','bool','date','ref','enum'].includes(p.kind)) bad.push(t.table + '.' + c + ' bad type ' + p.kind);
  }));
  ok('every column type valid and every ref resolves', bad.length === 0, bad.join('\n          '));
}

/* ---- the reconciliation that matters: declared vs actual, both ways ---- */
console.log('\n--- declared schema vs real data ---');
{
  const missing = [], undeclared = [];
  const walk = (rows, def, path) => {
    if (!Array.isArray(rows) || !rows.length) return;
    const declared = new Set([
      ...Object.keys(def.columns || {}),
      ...Object.keys(def.children || {}),
      ...Object.keys(def.embeds || {}),
      def.fk
    ].filter(Boolean));
    const seen = new Set();
    rows.forEach(r => Object.keys(r || {}).forEach(k => seen.add(k)));
    seen.forEach(k => { if (!declared.has(k)) undeclared.push(path + '.' + k); });
    Object.keys(def.columns || {}).forEach(k => {
      if (!seen.has(k)) missing.push(path + '.' + k);
    });
    Object.entries(def.children || {}).forEach(([k, cd]) =>
      walk(rows.flatMap(r => (r && r[k]) || []), cd, path + '.' + k));
  };
  Object.entries(SCHEMA).forEach(([e, def]) => walk(D[e], def, e));

  ok('no field in the data is undeclared in the schema', undeclared.length === 0,
     undeclared.join('\n          '));
  console.log('  NOTE  declared-but-absent in seed (optional/runtime fields): ' +
    (missing.length ? missing.join(', ') : 'none'));
}

console.log('\n--- primary keys present on every row ---');
{
  const noPk = [];
  const walk = (rows, def, path) => {
    if (!Array.isArray(rows)) return;
    const pk = def.pk || 'id';
    rows.forEach((r, i) => {
      if (r && !r[pk]) noPk.push(path + '[' + i + ']');
      Object.entries(def.children || {}).forEach(([k, cd]) => walk(r && r[k], cd, path + '.' + k));
    });
  };
  Object.entries(SCHEMA).forEach(([e, def]) => walk(D[e], def, e));
  ok('every row in seed data has a primary key', noPk.length === 0, noPk.slice(0, 10).join(', '));
}

console.log('\n--- process inputs specifically (the gap we fixed) ---');
{
  const allInputs = D.processes.flatMap(p => p.inputs || []);
  ok('process inputs exist in seed', allInputs.length > 0);
  ok('every process input now has an id', allInputs.every(i => !!i.id), 'n=' + allInputs.length);
  ok('input ids are unique', new Set(allInputs.map(i => i.id)).size === allInputs.length);

  // and through the migration path, from legacy data with no ids at all
  const legacy = JSON.parse(JSON.stringify(D));
  legacy.processes.forEach(p => (p.inputs || []).forEach(i => { delete i.id; }));
  const fixed = normalizeData(legacy);
  const after = fixed.processes.flatMap(p => p.inputs || []);
  ok('migration path mints ids for legacy inputs', after.length > 0 && after.every(i => !!i.id));
}

console.log('\n--- natural keys (what an import spreadsheet will carry) ---');
{
  const withNk = TABLES.filter(t => t.naturalKey);
  console.log('  NOTE  natural keys: ' + withNk.map(t => t.table + '.' + t.naturalKey).join(', '));
  const dupes = [];
  ENTITIES.forEach(e => {
    const nk = SCHEMA[e].naturalKey;
    if (!nk) return;
    const vals = repo.list(D, e).map(r => r[nk]).filter(v => v !== '' && v != null);
    if (new Set(vals).size !== vals.length) dupes.push(e + '.' + nk);
  });
  ok('natural keys are unique in seed data', dupes.length === 0, dupes.join(', '));

  const priority = ['components', 'rawMaterials', 'equipment', 'processes'];
  ok('every priority-import entity has a natural key',
     priority.every(e => !!SCHEMA[e].naturalKey),
     priority.filter(e => !SCHEMA[e].naturalKey).join(', '));
}

console.log('\n--- CSV headers for the priority imports ---');
{
  const show = (tableName) => {
    const t = TABLES.find(x => x.table === tableName);
    console.log('  ' + tableName.padEnd(28) + csvColumns(t).join(','));
    return t;
  };
  ['components', 'raw_materials', 'equipment', 'processes',
   'process_inputs', 'process_equipment', 'process_outputs',
   'lots', 'composition', 'lot_sources', 'lot_actual_equipment', 'lot_actual_labor', 'lot_qc_checks'
  ].forEach(show);

  const comp = TABLES.find(t => t.table === 'components');
  ok('embedded qcCalibration flattened to prefixed columns',
     csvColumns(comp).includes('qcCalibration_slope') && csvColumns(comp).includes('qcCalibration_enabled'));
  const lots = TABLES.find(t => t.table === 'lots');
  ok('polymorphic tables lead with the owner discriminator',
     csvColumns(lots)[0] === 'ownerType' && csvColumns(lots)[1] === 'ownerId');
  const pin = TABLES.find(t => t.table === 'process_inputs');
  ok('plain child tables lead with their parent FK', csvColumns(pin)[0] === 'processId');
  ok('lot embeds flattened too', csvColumns(lots).includes('disposition_reason') && csvColumns(lots).includes('attachment_fileName'));
  const dupCols = [];
  TABLES.forEach(t => { const c = csvColumns(t); if (new Set(c).size !== c.length) dupCols.push(t.table); });
  ok('no table emits a duplicate CSV column', dupCols.length === 0, dupCols.join(', '));
}

console.log('\n--- backfill is idempotent and non-destructive ---');
{
  const a = seedData();
  const before = JSON.stringify(a);
  backfillRowIds(a);
  ok('re-running backfill changes nothing', JSON.stringify(a) === before);
}

console.log('\n--- existing behaviour still intact ---');
{
  const d = seedData();
  const rm = d.rawMaterials[0];
  const n = rm.lots.length;
  tx.receiveRawLot(d, { rawMaterialId: rm.id, lotNumber: 'X1', date: '2026-01-01', qty: 5, notes: '' });
  ok('tx.receiveRawLot still works', d.rawMaterials[0].lots.length === n + 1);
  const p = d.processes.find(x => x.outputs && x.outputs.length);
  const created = tx.logProductionBatch(d, {
    processId: p.id, date: '2026-01-02', notes: '', sources: [],
    outputs: [{ outputId: p.outputs[0].id, lotNumber: 'B1', qty: 2, qcChecks: [] }],
    actualEquipment: [], actualLabor: [], wasteAllocations: []
  });
  ok('tx.logProductionBatch still works', created.length === 1 && created[0].qty === 2);
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
