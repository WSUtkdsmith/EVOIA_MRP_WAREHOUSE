// Pure-logic tests for Business Unit tenancy helpers. No database, no installed
// dependencies — runs with plain node, same spirit as the MRP logic suites.
//
//   node api/test/tenancy.test.js
//
// The SQL layer (api/_db.js) needs a live Postgres and is verified against a
// Neon database in deployment, not here.

'use strict';

const T = require('../_tenancy');

let passed = 0;
let failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}\n  expected ${e}\n  got      ${a}`); }
}
function ok(cond, msg) { eq(!!cond, true, msg); }

// slugify
eq(T.slugify('Evoia'), 'evoia', 'slugify lowercases');
eq(T.slugify('Café Foods'), 'cafe-foods', 'slugify strips accents and spaces');
eq(T.slugify('  Multi   Word  BU! '), 'multi-word-bu', 'slugify collapses separators and trims');
eq(T.slugify('###'), '', 'slugify of punctuation-only is empty');
eq(T.slugify(''), '', 'slugify of empty is empty');
eq(T.slugify(null), '', 'slugify of null is empty');
ok(T.slugify('x'.repeat(80)).length <= 40, 'slugify caps length at 40');

// uniqueBuId
eq(T.uniqueBuId('Evoia', []), 'evoia', 'uniqueBuId base when free');
eq(T.uniqueBuId('Evoia', ['evoia']), 'evoia-2', 'uniqueBuId suffixes on collision');
eq(T.uniqueBuId('Evoia', ['evoia', 'evoia-2']), 'evoia-3', 'uniqueBuId increments suffix');
eq(T.uniqueBuId('###', []), 'bu', 'uniqueBuId falls back to bu when slug empty');
eq(T.uniqueBuId('###', ['bu']), 'bu-2', 'uniqueBuId suffixes the bu fallback');

// validateBuName
ok(T.validateBuName('Liventia').ok, 'validateBuName accepts a normal name');
eq(T.validateBuName('  Liventia  ').value, 'Liventia', 'validateBuName trims');
ok(!T.validateBuName('').ok, 'validateBuName rejects empty');
ok(!T.validateBuName('   ').ok, 'validateBuName rejects whitespace-only');
ok(!T.validateBuName(null).ok, 'validateBuName rejects null');
ok(!T.validateBuName('x'.repeat(61)).ok, 'validateBuName rejects over 60 chars');
ok(T.validateBuName('x'.repeat(60)).ok, 'validateBuName accepts exactly 60 chars');

// validateModule
ok(T.validateModule('mrp'), 'validateModule accepts mrp');
ok(T.validateModule('warehouse'), 'validateModule accepts warehouse');
ok(!T.validateModule('bogus'), 'validateModule rejects unknown module');
ok(!T.validateModule(''), 'validateModule rejects empty');

// seed + legacy invariants
eq(T.SEED_UNITS.map((u) => u.id), ['evoia', 'liventia'], 'seed units are evoia, liventia');
eq(T.SEED_UNITS.map((u) => u.seq), [1, 2], 'seed units are ordered 1, 2');
eq(T.LEGACY_DEFAULT_BU, 'liventia', 'legacy default BU is liventia (warehouse was BU2)');
eq(T.LEGACY_DEFAULT_MODULE, 'warehouse', 'legacy default module is warehouse');
ok(T.validateModule(T.LEGACY_DEFAULT_MODULE), 'legacy default module is a valid module');

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
