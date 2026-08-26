import { SCHEMA, ENTITIES, seedData, allTables, csvColumns, csvPlan,
         exportCsvBundle, csvExportZip, importCsvBundle, parseCsvText,
         deserializeCell, serializeCell, csvEscape, bundleManifest,
         IMPORT_ORDER, repo } from '/tmp/core.mjs';
import { writeFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (x ? '\n          ' + String(x).slice(0, 600) : '')); } };

const emptyDb = () => Object.fromEntries(ENTITIES.map(e => [e, []]));
const filesOf = (bundle) => Object.fromEntries(bundle.map(b => [b.table, b.csv]));

/* Missing key and "" mean the same thing after a CSV trip, so compare
   with both normalised away. Everything else must match exactly. */
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).sort().forEach(k => {
      const nv = normalize(v[k]);
      if (nv === '' || nv === undefined || nv === null) return;
      if (Array.isArray(nv) && nv.length === 0) return;
      if (nv && typeof nv === 'object' && Object.keys(nv).length === 0) return;
      out[k] = nv;
    });
    return out;
  }
  return v;
}
const eq = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

const D = seedData();

console.log('\n--- column layout is human-fillable ---');
{
  const cols = (n) => exportCsvBundle(D).find(b => b.table === n).columns;
  ok('lot_sources exposes sourceType/sourceKey instead of only a packed groupKey',
     cols('lot_sources').includes('sourceType') && cols('lot_sources').includes('sourceKey'));
  ok('lot_sources exposes sourceLotNumber', cols('lot_sources').includes('sourceLotNumber'));
  ok('process_inputs exposes itemKey', cols('process_inputs').includes('itemKey'));
  ok('lots expose ownerKey', cols('lots').includes('ownerKey'));
  ok('equipment refs get a code companion', cols('process_equipment').includes('equipmentCode'));
  ok('component refs get a name companion', cols('lot_qc_checks').includes('componentName'));
  ok('every id column has a companion beside it in lot_sources',
     JSON.stringify(cols('lot_sources')) ===
     JSON.stringify(['parentLotId','parentLotNumber','id','groupKey','sourceType','sourceKey','lotId','sourceLotNumber','qty']),
     cols('lot_sources').join(','));
}

console.log('\n--- companions are actually populated on export ---');
{
  const b = exportCsvBundle(D);
  const src = parseCsvText(b.find(x => x.table === 'lot_sources').csv).rows;
  ok('sourceType filled', src.length > 0 && src.every(r => r.sourceType !== ''));
  ok('sourceKey filled', src.every(r => r.sourceKey !== ''));
  ok('parentLotNumber filled', src.every(r => r.parentLotNumber !== ''));
  const pin = parseCsvText(b.find(x => x.table === 'process_inputs').csv).rows;
  ok('process_inputs itemKey filled', pin.length > 0 && pin.every(r => r.itemKey !== ''));
  ok('process_inputs processSku filled', pin.every(r => r.processSku !== ''));
  const lots = parseCsvText(b.find(x => x.table === 'lots').csv).rows;
  ok('lots ownerKey filled', lots.length > 0 && lots.every(r => r.ownerKey !== ''));
}

console.log('\n--- FULL ROUND TRIP: export -> import into an empty database ---');
{
  const bundle = exportCsvBundle(D);
  const { data, report } = importCsvBundle(emptyDb(), filesOf(bundle));
  ok('import reported no errors', report.errors.length === 0, report.errors.slice(0, 6).join('\n          '));
  ok('nothing skipped', report.skipped === 0);
  console.log('  NOTE  inserted=' + report.inserted + ' updated=' + report.updated + ' skipped=' + report.skipped);

  ENTITIES.forEach(e => {
    ok(e + ' round-trips identically', eq(D[e], data[e]),
       'model=' + (D[e] || []).length + ' imported=' + (data[e] || []).length);
  });
  // CSV carries tables, not app metadata, so compare the collections
  const collectionsOnly = (o) => Object.fromEntries(
    Object.entries(o).filter(([, v]) => Array.isArray(v)));
  ok('WHOLE DATABASE round-trips identically', eq(collectionsOnly(D), collectionsOnly(data)));
}

console.log('\n--- re-importing the same bundle is idempotent ---');
{
  const bundle = exportCsvBundle(D);
  const once = importCsvBundle(emptyDb(), filesOf(bundle)).data;
  const twice = importCsvBundle(once, filesOf(bundle));
  ok('second import inserts nothing new', twice.report.inserted === 0,
     'inserted=' + twice.report.inserted);
  ok('data unchanged after re-import', eq(once, twice.data));
}

console.log('\n--- SPREADSHEET IMPORT: no ids at all, natural keys only ---');
{
  // strip every id-bearing column, keeping only human columns
  const ID_COLS = new Set(['id','ownerId','parentLotId','lotId','processId','customerId',
    'componentId','equipmentId','rawMaterialId','finishedGoodId','itemId','productId',
    'groupKey','addressId','priceListId','scheduleId']);
  const bundle = exportCsvBundle(D);
  const stripped = {};
  // schedule_revisions is a machine-written audit log keyed on internal ids.
  // A production run has no natural key, and nobody authors an audit trail in
  // a spreadsheet, so requiring the id there is correct rather than a gap.
  // Audit records keyed on a production run. A run has no natural key, and
  // nobody authors a cancellation log in a spreadsheet, so requiring the id
  // here is correct rather than a gap.
  // Allocations hang off a sales order LINE, and a line has no natural key of
  // its own - only its parent order does. A run is now referenceable by number,
  // but that is only half the link, so this stays id-linked like the rest.
  // Allocating production to an order line is not a spreadsheet job anyway.
  const MACHINE_LINKED = ['schedule_revisions', 'schedule_fulfillment_lots',
                          'fulfilment_cancellations', 'sales_order_run_allocations'];
  bundle.filter(b => MACHINE_LINKED.indexOf(b.table) < 0).forEach(b => {
    const { header, rows } = parseCsvText(b.csv);
    const keep = header.filter(h => !ID_COLS.has(h));
    stripped[b.table] = [keep.join(',')]
      .concat(rows.map(r => keep.map(h => csvEscape(r[h])).join(',')))
      .join('\r\n') + '\r\n';
  });

  const { data, report } = importCsvBundle(emptyDb(), stripped);
  ok('id-free import reports no errors', report.errors.length === 0,
     report.errors.slice(0, 8).join('\n          '));
  ok('id-free import skipped nothing', report.skipped === 0);
  console.log('  NOTE  inserted=' + report.inserted + ' skipped=' + report.skipped);

  // ids will differ (they are generated), so compare by natural key
  ok('same number of raw materials', data.rawMaterials.length === D.rawMaterials.length);
  ok('same number of components', data.components.length === D.components.length);
  ok('same number of equipment', data.equipment.length === D.equipment.length);
  ok('same number of processes', data.processes.length === D.processes.length);

  const srcRm = D.rawMaterials.find(r => r.lots && r.lots.length);
  const gotRm = data.rawMaterials.find(r => r.sku === srcRm.sku);
  ok('a raw material matched by SKU carries its lots',
     gotRm && gotRm.lots.length === srcRm.lots.length,
     gotRm ? gotRm.lots.length + ' vs ' + srcRm.lots.length : 'not found');
  ok('its scalar fields survived', gotRm && gotRm.name === srcRm.name && gotRm.unitCost === srcRm.unitCost);

  // references were rebuilt from natural keys, pointing at NEW ids
  const srcProc = D.processes.find(p => p.inputs && p.inputs.length);
  const gotProc = data.processes.find(p => p.sku === srcProc.sku);
  ok('process matched by SKU has the same input count',
     gotProc && gotProc.inputs.length === srcProc.inputs.length);
  const resolved = gotProc.inputs.every(inp => {
    const ent = { raw: 'rawMaterials', intermediate: 'intermediateProducts', finished: 'finishedGoods' }[inp.itemType];
    return !!data[ent].find(x => x.id === inp.itemId);
  });
  ok('every rebuilt process input points at a real item', resolved);

  const gotSources = data.intermediateProducts.concat(data.finishedGoods)
    .flatMap(i => i.lots).flatMap(l => l.sources || []);
  ok('batch sources were rebuilt', gotSources.length > 0);
  ok('every rebuilt source groupKey resolves', gotSources.every(s => {
    const [t, id] = String(s.groupKey).split(':');
    const ent = { raw: 'rawMaterials', intermediate: 'intermediateProducts', finished: 'finishedGoods', waste: 'wasteStreams' }[t];
    return ent && !!data[ent].find(x => x.id === id);
  }));
  ok('every rebuilt source lotId resolves', gotSources.every(s =>
    !s.lotId || Object.values({ r: data.rawMaterials, i: data.intermediateProducts, f: data.finishedGoods })
      .some(arr => arr.some(it => (it.lots || []).some(l => l.id === s.lotId)))));
}

console.log('\n--- partial import: only the priority tables ---');
{
  const base = seedData();
  const only = { equipment: exportCsvBundle(D).find(b => b.table === 'equipment').csv };
  const { data, report } = importCsvBundle(base, only);
  ok('single-file import runs clean', report.errors.length === 0, report.errors.join('; '));
  ok('matched existing equipment by code rather than duplicating',
     data.equipment.length === base.equipment.length,
     base.equipment.length + ' -> ' + data.equipment.length);
  ok('reported as updates', report.updated === base.equipment.length);
}

console.log('\n--- adding genuinely new rows ---');
{
  const base = seedData();
  const csv = 'id,name,code,units,notes\r\n' +
              ',Vacuum oven,EQ-VAC,2,Bought secondhand\r\n' +
              ',"Mixer, twin-shaft",EQ-MIX2,1,"Notes with ""quotes"" and, commas"\r\n';
  const { data, report } = importCsvBundle(base, { equipment: csv });
  ok('two new rows inserted', report.inserted === 2, JSON.stringify(report.tables[0]));
  const vac = data.equipment.find(e => e.code === 'EQ-VAC');
  const mix = data.equipment.find(e => e.code === 'EQ-MIX2');
  ok('generated an id for a blank id column', vac && !!vac.id && vac.id.length > 4);
  ok('numeric column coerced from text', vac && vac.units === 2 && typeof vac.units === 'number');
  ok('quoted comma in name preserved', mix && mix.name === 'Mixer, twin-shaft');
  ok('escaped quotes preserved', mix && mix.notes === 'Notes with "quotes" and, commas');
}

console.log('\n--- error handling ---');
{
  const base = seedData();

  const badEnum = 'processId,processSku,id,itemType,itemId,itemKey,qty\r\n' +
                  ',PR-DRIVE,,widget,,RM-MOTOR-250,1\r\n';
  let r = importCsvBundle(base, { process_inputs: badEnum }).report;
  ok('rejects a value outside an enum', r.errors.some(e => /not one of/.test(e)), r.errors.join('; '));
  ok('bad row is skipped, not silently written', r.skipped === 1);

  const badRef = 'id,name,code,units,notes\r\n,Thing,EQ-NEW,1,\r\n';
  const badMaint = 'id,equipmentId,equipmentCode,title,type,startDate,durationHours,recurrence,recurUntil,status,notes\r\n' +
                   ',,EQ-DOES-NOT-EXIST,Service,Cleaning,2026-01-01,2,Monthly,,Scheduled,\r\n';
  r = importCsvBundle(base, { equipment: badRef, maintenance: badMaint }).report;
  ok('unresolvable reference is reported', r.errors.some(e => /no Equipment matching/.test(e)), r.errors.join('; '));

  const missingReq = 'id,name,code,units,notes\r\n,,EQ-X,1,\r\n';
  r = importCsvBundle(base, { equipment: missingReq }).report;
  ok('missing required column is reported', r.errors.some(e => /name is required/.test(e)), r.errors.join('; '));

  r = importCsvBundle(base, { equipment: 'id,name,code,units,notes,bogus\r\n,A,EQ-Q,1,,x\r\n' }).report;
  ok('unrecognised column is reported', r.errors.some(e => /Unrecognised column/.test(e)), r.errors.join('; '));

  r = importCsvBundle(base, { not_a_table: 'a,b\r\n1,2\r\n' }).report;
  ok('unknown file is warned about, not fatal', r.warnings.some(w => /Ignored unknown file/.test(w)));

  const before = JSON.stringify(base);
  importCsvBundle(base, { equipment: badRef });
  ok('import never mutates the database it was given', JSON.stringify(base) === before);
}

console.log('\n--- CSV reader edge cases ---');
{
  ok('CRLF and LF both parse',
     parseCsvText('a,b\r\n1,2\r\n').rows.length === 1 &&
     parseCsvText('a,b\n1,2\n').rows.length === 1);
  ok('blank lines ignored', parseCsvText('a,b\r\n1,2\r\n\r\n\r\n').rows.length === 1);
  ok('quoted newline stays inside the cell',
     parseCsvText('a,b\r\n"line1\nline2",2\r\n').rows[0].a === 'line1\nline2');
  ok('BOM stripped from the first header', parseCsvText('\uFEFFa,b\r\n1,2\r\n').header[0] === 'a');
  ok('trailing row without newline still parses', parseCsvText('a,b\r\n1,2').rows.length === 1);
  ok('booleans accept yes/1/true',
     deserializeCell('yes','bool') === true && deserializeCell('1','bool') === true &&
     deserializeCell('TRUE','bool') === true && deserializeCell('no','bool') === false);
  ok('thousands separators tolerated on numbers', deserializeCell('1,234.5','num') === 1234.5);
}

console.log('\n--- zip still valid ---');
{
  const { bytes, bundle } = csvExportZip(D);
  writeFileSync('/tmp/export2.zip', bytes);
  ok('zip signature intact', bytes[0] === 0x50 && bytes[1] === 0x4b);
  console.log('  NOTE  wrote /tmp/export2.zip (' + bytes.length + ' bytes, ' + (bundle.length + 1) + ' entries)');
  const man = bundleManifest(bundle);
  ok('manifest explains the id/companion rule', /leave every id column blank/.test(man));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail ? 1 : 0);
