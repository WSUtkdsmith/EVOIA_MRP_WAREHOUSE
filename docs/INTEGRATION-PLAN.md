# Integration Plan — MRP + Warehouse

Living design doc for merging the MRP and Warehouse apps into one multi-tenant
Vercel platform. Records the decisions taken, the data-model mapping, the phased
roadmap, and the open questions.

## Decisions locked in

1. **Target runtime:** Vercel web app (static front-ends + serverless functions),
   Postgres (Neon) for data.
2. **Shape:** one shared backend/DB; MRP and Warehouse remain **two front-end
   modules** over it (no full rewrite of either into the other's stack).
3. **Tenancy:** the platform is **multi-tenant by Business Unit (BU)**.
   - BU 1 = **Evoia** — seeded from the MRP dataset.
   - BU 2 = **Liventia** — seeded from the Warehouse SSB/SOS dataset.
   - Users can **add and name BU 3+**, and **every BU name is editable** (rename).
   - A global BU selector scopes the whole app to one BU at a time.
   - **Physical space is shared (Option A, confirmed):** one global warehouse
     map; pallets/inventory are per-BU, tagged and filterable on that map.
4. **Auth:** intentionally **deferred**. Build on sanitized data. Endpoints are
   structured so an auth middleware slots in cleanly for the downstream security
   developer. `/api/state` currently has no authentication — see "Handoff to
   security" below.

## What a "Business Unit" means here (proposed)

A BU is a **tenant**: an independent business whose inventory, lots, orders,
pallets, and history are its own. Both modules operate on the **currently
selected BU's** data. BU 1 happens to arrive rich in MRP data and BU 2 rich in
warehouse data, but architecturally every BU can use both modules.

### Shared physical space — Option A (CONFIRMED)

The BUs operate from **the same space**, so the **physical warehouse map** (zones,
racks, floor coordinates) is a **shared, global** layout, while the **inventory
that sits in it** is per-BU: every pallet/lot is tagged with its owning BU; the
map shows all pallets and the BU selector filters/highlights one BU's stock. This
answers "whose pallet is in A1?" and prevents two BUs being assigned the same slot.

Scoping under Option A:

| Data | Scope |
|---|---|
| Physical map: zones, racks, slots, floor geometry | **Global** (shared building) |
| Pallets & placement (which BU's stock is where) | **Per-BU** (tagged, filterable) |
| Items/products, item types | **Per-BU** |
| Lots/batches, cost, genealogy | **Per-BU** |
| Purchase orders, sales orders, receiving, shipping | **Per-BU** |
| Schedule, calendars, capacity | **Per-BU** |
| Storage rules (what goes where) | TBD — likely global with per-BU overrides |
| Users / roles / permissions | Deferred (auth phase) |

## Data-model mapping (the integration spine)

The two apps overlap on inventory. Unify them around one stock identity per BU:

| Concept | MRP today | Warehouse today | Unified |
|---|---|---|---|
| Product | `SCHEMA` item / material (SKU) | `settings.itemTypes` (e.g. SSB, SOS) | `item` (per BU) |
| Physical stock unit | `lot` (`producedQty`, `qty`, cost, genealogy, process stage) | pallet content line (`batch`, `expiration`, `quantityOriginal/Current`) | `lot` keyed by (BU, item, batchCode); MRP adds cost + genealogy, WH adds placement |
| Physical location | — (MRP has no map) | pallet → `locationType`/`location`/`zone`/`x,y` | `placement` linking lot qty to a slot on the shared map |
| Receiving | goods-in / PO receipts | `receivingOrders` / `receipts` | one receiving event → creates lots (+ optional pallet placement) |
| Shipping | despatch / sales-order fulfilment | `shipments` / `fulfillments` | one shipping event → draws from placement, satisfies sales orders |
| Orders | purchase + sales orders | order refs on lines (`ref`, `SO-…`) | purchase & sales orders, per BU |
| Planning / costing / scheduling | full | — | MRP-owned, per BU |

Key identity problem to solve: MRP keys lots on `SKU`+lot id; the warehouse keys
on `batch` (e.g. `110-240312`) with an order `ref`. The unified model needs one
canonical lot/batch key both sides read and write.

## Phased roadmap

- **Phase 0 — Baseline (done).** Canonical files on one clean branch; zips
  dropped; filenames de-encoded; `api/state.js` at the Vercel-correct path; MRP
  test gate made path-portable and passing (829 logic assertions, 0 parse
  errors). No integration logic yet.
- **Phase 1 — Backend + tenancy foundation.** Replace the single JSON-blob
  `/api/state` with a real Postgres schema derived from MRP's `SCHEMA`. Add a
  `business_unit` dimension to every tenant-scoped table. Add
  `/api/business-units` (list / create / rename) and BU scoping on data
  endpoints. Migrate the MRP off `window.storage` onto the API. Structure for a
  later auth middleware.
- **Phase 2a — App shell + BU selector (done).** Root `index.html` shell with a
  global Business Unit selector (add / rename, backed by `/api/business-units`)
  and launch cards per module. Graceful fallback to seed units when the backend
  is unreachable. Warehouse wired to be BU-aware (`?bu=` → `/api/state?bu=&module=
  warehouse`, per-BU localStorage key). Pure shell/warehouse helpers verified.
- **Phase 2b — MRP on Vercel (done).** esbuild bundles `mrp/entry.jsx`
  (the default-exported `<App/>` mounted with React 18) + React + lucide into a
  committed `mrp/app.bundle.js` (`npm run build:mrp`). `mrp/index.html` hosts it
  behind a `window.storage` shim that presents the MRP's key/value contract
  (`get→{value}`, `set`) over `/api/state?bu=&module=mrp`, with a localStorage
  mirror for offline. Shell MRP card enabled and BU-scoped. Bundle builds clean
  (0 errors); live browser render is confirmed post-deploy.
  - *Follow-ups:* (a) render-suite CI so the full ~1,397-test gate runs (react is
    now installable); (b) the committed bundle is a build artifact — a later
    Vercel build step could generate it instead; (c) `@vercel/postgres@0.10.0`
    is deprecated in favour of Neon's native SDK — works today, migrate later.
- **Phase 3 — Unify the inventory spine.** Make MRP lots and warehouse pallet
  lines two views of the same stock; connect receiving/shipping across modules
  on the shared map. Catalog gap analysis + agreed schema delta:
  **`docs/PHASE3-CATALOG-GAPS.md`** (packagings as distinct SKUs; shelf-life →
  computed expiry; core storage rules; lot-level origin/mfg/ref/dates).
  - *Step 1 — schema delta (done).* Added the `packagings` shared polymorphic
    table, `shelfLifeDays`/`physicallyStored` on all four entities (+`hazardClass`
    on raw materials), and 8 optional lot columns; taught the importer about
    `packagings` (IMPORT_ORDER); seeded default packagings + computed expiry.
    New `packaging.test.mjs` suite (50 assertions). Gate: 879 logic assertions,
    0 parse errors; MRP bundle rebuilt.
  - *Step 2a — catalog UI (done).* All four catalog modals gained a "Warehouse
    cataloging" section: shelf life, physically-stored, hazard (raw materials),
    and a reusable `PackagingsEditor` (add/remove packagings, set the default).
    Verified by a server-render smoke test (react-dom/server) of every modal in
    add and edit mode plus the new components; logic gate 879, bundle rebuilt.
  - *Step 2b — lot UI (done).* `LotDetailModal` gained a "Warehouse / physical"
    section: packaging selector (the item's storable SKUs), production/arrival
    dates, expiration (auto-computed from production date + shelf life, with an
    Auto button, editable), and origin/mfg/order-ref/container-count. New lots
    default to the item's default packaging. `packagings`/`shelfLifeDays` thread
    from each modal draft through `LotsEditor`. Render-smoke verified.
  - *Follow-up:* the dedicated `ReceivingModal` quick-receive flow could set
    these on receipt too (lots are already editable via the catalog modals).
  - *Step 3* — warehouse reads the unified catalog to slot MRP items on the
    shared map.
- **Phase 4 — Polish + handoff.** Address inherited MRP gaps (process-flow SVG,
  reconstructed regions, conversion-cost pricing, multi-lot shipments) by
  priority; hand the auth seam to the security developer.

## Housekeeping applied in Phase 0

- Zips (`MRPV4.zip`, `Evoia-warehouse-builder-main.zip`) not carried into the
  integrated tree; they only duplicated the loose files and remain in the
  original patch branches' history. Now `.gitignore`d.
- `EVWB REV172.html` (12,646 lines) and `index.html` (14,381 lines) both claimed
  "Revision 172" but differed by ~2,564 lines. `index.html` (larger, deployed)
  is treated as canonical; `EVWB-REV172.html` is parked in `warehouse/archive/`.
  **Confirm it can be deleted.**
- `mrp-console_V4.jsx` and `mrp-console_WORKING.jsx` were byte-identical; kept as
  the single `mrp/mrp-console.jsx`.
- URL-encoded filenames (`%20`) renamed to clean names.
- `state.js` moved from repo root to `api/state.js` (Vercel routes `/api/state`
  from the `api/` directory; at the root the endpoint would not resolve).

## Handoff to security (deferred, not forgotten)

- `/api/state` (and all Phase 1 endpoints) currently have **no authentication** —
  anyone with the deployment URL can read/write data. Acceptable for the
  sanitized-data build; must be closed before real data.
- The warehouse already models `rolePermissions` and `users` client-side; that is
  a starting point but is **not** a security boundary on its own (client-side
  checks are bypassable). Real enforcement belongs at the API layer.

## Open questions for the product owner

1. ~~Shared vs. isolated physical space~~ — **resolved: Option A (shared).**
2. ~~A name for Business Unit 2~~ — **resolved: Liventia (editable).**
3. ~~Delete `EVWB-REV172.html`?~~ — **resolved: keep in `warehouse/archive/` as a
   reference build.**
4. ~~Item types / products shared or per-BU?~~ — **resolved: per-BU** (physical
   space is shared; product catalogs are not).
