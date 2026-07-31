# Evoia — Integrated MRP + Warehouse

A single platform combining two existing applications over one shared backend,
**multi-tenant by Business Unit**, deployed as a Vercel web app.

- **MRP module** (`mrp/`) — purchasing, goods-in, multi-stage production with lot
  genealogy, finite-capacity scheduling, despatch, sales orders, and lot-level
  costing. React single-file app with a schema-driven data layer (`SCHEMA` /
  `repo` / `tx`) and a 12-suite logic test gate. Seeds **Business Unit 1 (Evoia)**.
- **Warehouse module** (`warehouse/`) — physical warehouse map (racks, floor,
  zones), pallet putaway/picking, receiving/shipping, damage capture,
  reconciliation counts, roles/permissions, and QR label generation. Vanilla
  HTML/JS. Seeds **Business Unit 2** (to be named).
- **Backend** (`api/`) — Vercel serverless functions over Postgres (Neon).

> Status: **Phase 0 — baseline assembled.** Both modules are present as-is over a
> clean structure with the MRP test gate wired and passing. Integration work
> (shared backend, Business Unit tenancy, unified inventory) is planned in
> `docs/INTEGRATION-PLAN.md` and has not started. Authentication is intentionally
> deferred to a downstream security developer; the app runs on sanitized data.

## Layout

```
api/
  state.js                     # Vercel /api/state endpoint (Postgres-backed)
mrp/
  mrp-console.jsx              # MRP application (React, single file)
  HANDOFF.md  AUDIT.md  CHANGELOG.md
  tools/mkcore.sh  tools/run-tests.sh
  test/*.test.mjs              # 12 pure-logic suites (node, no deps)
  test/render.test.js          # render suite (needs react/react-dom + tsc)
  test/rendertest/node_modules/lucide-react/index.js   # committed icon stub
warehouse/
  index.html                   # Warehouse application (canonical build)
  Original-Source-Inventory.csv
  CHANGELOG.md
  archive/EVWB-REV172.html     # older snapshot, pending confirmation it can go
docs/
  INTEGRATION-PLAN.md          # architecture + phased roadmap + open decisions
```

## Running the MRP test gate

```bash
npm test          # 12 logic suites (node only) — 829 assertions
npm run test:full # + tsc syntax check; render suite is run separately
```

The gate is path-portable — it resolves the module root from the script
location, so it runs from any directory and in CI.
