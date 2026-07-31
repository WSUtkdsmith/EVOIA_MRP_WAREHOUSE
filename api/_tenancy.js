// Pure, dependency-free helpers for Business Unit tenancy.
//
// No database import lives here on purpose: this module is unit-testable in
// node with nothing installed (see api/test/tenancy.test.js). The SQL layer
// that uses these helpers is api/_db.js.
//
// A "Business Unit" (BU) is a tenant: an independent business whose inventory,
// lots, orders and pallets are its own. Both front-end modules (mrp, warehouse)
// operate on the currently selected BU's data. Physical warehouse *space* is
// shared across BUs (Option A) and lives in global_state, not per BU.

'use strict';

// The two front-end modules whose state is stored per BU.
const MODULES = ['mrp', 'warehouse'];

// Seeded on first run. BU1 arrives rich in MRP data, BU2 in warehouse data;
// names are editable afterwards via the rename endpoint.
const SEED_UNITS = [
  { id: 'evoia', name: 'Evoia', seq: 1 },
  { id: 'liventia', name: 'Liventia', seq: 2 },
];

// The legacy pre-tenancy endpoint stored the whole warehouse state as one row.
// That shared inventory was Business Unit 2 (Liventia)'s, so migration folds it
// there. Kept as named constants so the default and the migration agree.
const LEGACY_DEFAULT_BU = 'liventia';
const LEGACY_DEFAULT_MODULE = 'warehouse';

// Turn a display name into a stable, URL-safe id.
function slugify(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Generate an id that does not collide with any existing one.
function uniqueBuId(name, existingIds) {
  const taken = new Set(existingIds || []);
  const base = slugify(name) || 'bu';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function validateBuName(name) {
  const n = String(name == null ? '' : name).trim();
  if (!n) return { ok: false, error: 'Business unit name is required' };
  if (n.length > 60) return { ok: false, error: 'Business unit name must be 60 characters or fewer' };
  return { ok: true, value: n };
}

function validateModule(module) {
  return MODULES.includes(module);
}

module.exports = {
  MODULES,
  SEED_UNITS,
  LEGACY_DEFAULT_BU,
  LEGACY_DEFAULT_MODULE,
  slugify,
  uniqueBuId,
  validateBuName,
  validateModule,
};
