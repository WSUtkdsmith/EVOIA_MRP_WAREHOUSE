// SQL layer for Business Unit tenancy over Postgres (Neon, via the Vercel
// Storage integration). Pure, testable helpers live in api/_tenancy.js; this
// file is the only place that talks to the database.
//
// Storage model (Phase 1 — deliberately not a full normalization of the MRP's
// 34 tables yet; that comes in Phase 3 when we unify the inventory spine and
// need relational cross-module queries):
//
//   business_units   one row per tenant (id, name, seq) — first-class, CRUD
//   module_state     per (business_unit, module) JSON blob — reuses the proven
//                    whole-state approach both apps already use
//   global_state     per-key JSON blob for BU-independent data, e.g. the shared
//                    physical warehouse map/layout (Option A)
//
// Auth is intentionally deferred (see docs/INTEGRATION-PLAN.md). These endpoints
// have no authentication of their own yet; access control is the downstream
// security developer's task and belongs at this API layer.

'use strict';

const { sql } = require('@vercel/postgres');
const T = require('./_tenancy');

let schemaReady = null; // memoize per warm serverless instance

async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS business_units (
      id         text PRIMARY KEY,
      name       text NOT NULL,
      seq        integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await sql`CREATE TABLE IF NOT EXISTS module_state (
      business_unit_id text NOT NULL REFERENCES business_units(id) ON DELETE CASCADE,
      module           text NOT NULL,
      data             jsonb NOT NULL,
      updated_at       timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (business_unit_id, module)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS global_state (
      key        text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`;
    await seedIfEmpty();
    await migrateLegacyState();
  })();
  return schemaReady;
}

async function seedIfEmpty() {
  const { rows } = await sql`SELECT count(*)::int AS n FROM business_units`;
  if (rows[0].n > 0) return;
  for (const u of T.SEED_UNITS) {
    await sql`INSERT INTO business_units (id, name, seq)
              VALUES (${u.id}, ${u.name}, ${u.seq})
              ON CONFLICT (id) DO NOTHING`;
  }
}

// The pre-tenancy app stored the whole warehouse state as one row in app_state
// keyed 'main'. If that legacy row still exists and Liventia has no warehouse
// state yet, fold it in — that shared inventory was Business Unit 2's.
async function migrateLegacyState() {
  const reg = await sql`SELECT to_regclass('public.app_state') AS t`;
  if (!reg.rows[0].t) return;
  const legacy = await sql`SELECT data FROM app_state WHERE id = 'main'`;
  if (legacy.rows.length === 0) return;
  const already = await sql`SELECT 1 FROM module_state
                            WHERE business_unit_id = ${T.LEGACY_DEFAULT_BU}
                              AND module = ${T.LEGACY_DEFAULT_MODULE}`;
  if (already.rows.length) return;
  await sql`INSERT INTO module_state (business_unit_id, module, data)
            VALUES (${T.LEGACY_DEFAULT_BU}, ${T.LEGACY_DEFAULT_MODULE},
                    ${JSON.stringify(legacy.rows[0].data)}::jsonb)
            ON CONFLICT DO NOTHING`;
}

// --- Business units -------------------------------------------------------

async function listUnits() {
  const { rows } = await sql`SELECT id, name, seq FROM business_units ORDER BY seq, name`;
  return rows;
}

async function unitExists(id) {
  const { rows } = await sql`SELECT 1 FROM business_units WHERE id = ${id}`;
  return rows.length > 0;
}

async function createUnit(name) {
  const existing = await sql`SELECT id FROM business_units`;
  const id = T.uniqueBuId(name, existing.rows.map((r) => r.id));
  const seqRow = await sql`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM business_units`;
  const seq = seqRow.rows[0].n;
  await sql`INSERT INTO business_units (id, name, seq) VALUES (${id}, ${name}, ${seq})`;
  return { id, name, seq };
}

async function renameUnit(id, name) {
  const { rowCount } = await sql`UPDATE business_units
                                 SET name = ${name}, updated_at = now()
                                 WHERE id = ${id}`;
  return rowCount > 0;
}

async function deleteUnit(id) {
  const { rows } = await sql`SELECT count(*)::int AS n FROM business_units`;
  if (rows[0].n <= 1) return { ok: false, error: 'Cannot delete the last business unit' };
  const { rowCount } = await sql`DELETE FROM business_units WHERE id = ${id}`;
  return rowCount > 0 ? { ok: true } : { ok: false, error: 'Business unit not found' };
}

// --- Per-BU module state --------------------------------------------------

async function getModuleState(buId, module) {
  const { rows } = await sql`SELECT data, updated_at FROM module_state
                             WHERE business_unit_id = ${buId} AND module = ${module}`;
  if (rows.length === 0) return { data: null, updatedAt: null };
  return { data: rows[0].data, updatedAt: rows[0].updated_at };
}

async function setModuleState(buId, module, data) {
  await sql`INSERT INTO module_state (business_unit_id, module, data)
            VALUES (${buId}, ${module}, ${JSON.stringify(data)}::jsonb)
            ON CONFLICT (business_unit_id, module)
            DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
}

// --- Shared / global state (BU-independent, e.g. the physical map) ---------

async function getGlobal(key) {
  const { rows } = await sql`SELECT data, updated_at FROM global_state WHERE key = ${key}`;
  if (rows.length === 0) return { data: null, updatedAt: null };
  return { data: rows[0].data, updatedAt: rows[0].updated_at };
}

async function setGlobal(key, data) {
  await sql`INSERT INTO global_state (key, data)
            VALUES (${key}, ${JSON.stringify(data)}::jsonb)
            ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`;
}

module.exports = {
  ensureSchema,
  listUnits, unitExists, createUnit, renameUnit, deleteUnit,
  getModuleState, setModuleState,
  getGlobal, setGlobal,
};
