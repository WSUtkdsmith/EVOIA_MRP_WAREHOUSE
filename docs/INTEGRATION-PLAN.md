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
  - *Step 3a — catalog API + warehouse read (done).* `GET /api/catalog?bu=<id>`
    derives storable SKUs and stock from the BU's MRP data, so the warehouse
    never parses MRP internals. Derivation is pure (`api/_catalog.js`, 47
    assertions) and ages each lot against a reference date into
    `ok` / `expiring` / `expired` / `unknown`, counting uncataloged items rather
    than dropping them. The warehouse gained an **MRP Catalog** window (topbar,
    with an in-stock badge): storable-SKU and stock views, search, and
    expired/expiring filters. Read-only.
    - *Verified against the real seed:* 60 SKUs, 762 lots (442 in stock, 90
      expired, 207 expiring, 0 uncataloged); every lot joins to a SKU; all eight
      render paths simulated against a DOM stub.
    - *Note:* the catalog payload is ~480 KB for 762 lots. Fine now; if it grows,
      add server-side filtering/paging rather than trimming client-side.
  - *Step 3b — placement / write direction (done).* From the MRP Catalog, a lot
    can be **placed**: it creates a warehouse pallet whose content line links
    back via `mrpLotId` (carrying `mrpSku`, `mrpItemId` and **expiration**, which
    the warehouse's own lines never had), into a free rack slot or the open
    floor. The catalog shows each lot's placement state — not placed / partially
    placed / on pallet(s) / **over-placed** — and only offers Place while
    quantity remains.
    - **Ownership split (the design decision):** the MRP owns the lot (what was
      produced, what it cost, where it came from); the warehouse owns placement
      (which pallet, which slot, and the working quantity picking draws down).
      Where the two disagree the difference is **shown, not reconciled** — a real
      two-way quantity sync needs conflict rules nobody has specified. That is
      why `over` is a visible state rather than a clamp.
    - Placement reuses the app's own mechanics (`canMoveToLocation`, `bump`,
      `hist`, `addReceiptLog`, `save`), so a placed pallet is an ordinary pallet:
      it moves, picks, ships and reconciles like any other.
    - **The warehouse now has tests** — `warehouse/test/placement.test.js` (45
      assertions) extracts the pure helpers from the single-file app by name and
      asserts on them, closing the "no tests" gap flagged at the start. Verified
      end-to-end against the real seed: unplaced → partial → placed across two
      pallets, other lots unaffected.
  - *Not yet:* drag-to-place on the map, and multi-slot footprints from
    `packagesPerSlot`.

## Phase 4 — Single-entry receiving (the reverse write direction)

Goods that are *purchased* arrive at the dock before the MRP knows about them,
so Phase 3's MRP → warehouse direction is backwards for them. Today receiving is
keyed twice, once per system, and the two can diverge silently.

**The design (agreed):** the **purchase order is the contract between the two
systems**. The MRP raises it from the reorder forecast — vendor, material,
container size, quantity, total cost — and the warehouse receives against that
reference. This removes the matching problem entirely: the dock never guesses an
item, it quotes an order that already names everything. Applied via **Option A
(pending queue)**: the warehouse records intent, the MRP applies it through its
own `tx`, so the MRP's data-layer enforcement stays authoritative and no
transaction logic is duplicated.

- *Step 1 — purchase-order model + forecast (done).*
  - `purchaseOrders` gained `packagingId` and `containerCount`. `qty` stays
    authoritative in the material's own unit and containerCount is derived
    through the packaging, so **units are conserved**: containers ×
    units-per-container = quantity, and rounding to whole containers can only
    ever round *up*, never below the shortfall that triggered the order.
  - `poTotalCost` is always derived from quantity × unit cost, never stored, so
    it cannot disagree with them. `poContainerSummary` reads "400 × 60 kg sack".
  - `suggestPurchaseOrders(data)` — the forecast. A material is short when
    on-hand plus on-order will not cover its reorder point; the shortfall is
    rounded up to whole containers and to the MOQ. Returns rows to review;
    nothing is written until accepted.
  - `tx.raisePurchaseOrders` writes them as **Draft** (an accepted suggestion is
    not an order that has been placed), `tx.placePurchaseOrder` moves Draft →
    Ordered, and `tx.receivablePurchaseOrders` is what the warehouse may receive
    against — placed and not yet complete. That lifecycle exists because
    `poDerivedStatus` deliberately treats Draft as sticky: without an explicit
    placing step, a delivery could be booked against an order nobody ever sent.
  - Seed packagings now carry **real container capacities** (60 kg sack, 1000 kg
    tote, case of 12/24). The earlier placeholder of 1 unit per container made
    orders read as "24,000 × 55 gal drum" for 24,000 kg.
  - `mrp/test/purchase-planning.test.mjs` — 53 assertions.
- *Step 1b — orders hold several lines (done).* An order routinely covers
  several materials from one supplier, and just as often **the same material in
  two container sizes**, which the warehouse receives and stores as separate
  stock. So material, quantity, cost and container moved off the order header
  onto a `purchase_order_lines` child — mirroring how `sales_orders` already
  carries its products.
  - Receipts now name the line they satisfy (`purchase_receipts.lineId`), so one
    size arriving does not close another. `poOrderedQty`, `poLineOutstanding`
    and `poLineReceivedQty` aggregate; `poOutstanding`/`poReceivedQty`/
    `poDerivedStatus` keep their old contracts, which is why the 96 existing
    purchasing assertions survived the change untouched.
  - `normalizePurchaseOrders` migrates any order written in the old shape into a
    single line and attributes its receipts to it, then drops the legacy header
    fields so a quantity only ever lives in one place.
  - `raisePurchaseOrders` groups suggestions **one order per supplier** by
    default (`groupBySupplier: false` to split), and the order is expected when
    its slowest line is.
  - `purchase_order_lines` had to be added to `IMPORT_ORDER` — the same trap
    `packagings` hit: without it the lines exported fine and imported to nothing.
- *Step 2 — MRP UI (done).* The order modal lists its lines (material,
  containers, quantity, unit cost, line total, outstanding) and the purchasing
  tab's material filter matches on any line. A new **Reorder forecast** segment
  on the purchasing tab carries the whole raise-and-place flow:
  - Every short material listed with on-hand, on-order, reorder point,
    container, quantity and cost. Rows can be **excluded**, and the **container
    count edited** — quantity follows it, because ordering is by the container.
    Editing below the shortfall is allowed but called out rather than blocked.
  - A running summary of how many **supplier orders** will be raised and what
    they are worth, then **Raise draft orders**.
  - Drafts are surfaced with their own banner and list, and **Place all drafts**
    makes them receivable — the deliberate second step, since a draft is an
    intention and a placed order is a commitment the warehouse can receive
    against.
  - Items with no packaging are flagged in place ("the warehouse cannot slot
    it") rather than quietly ordered by bare quantity.
  - Render-smoke covers all four states: stocked (empty state), short
    (suggestions), drafts pending, and the whole tab.
- *Step 3 — the dock quotes an order (done).*
  - `/api/catalog` now returns `purchaseOrders[]`: placed orders that still owe
    something, one entry per line, each naming the material, the container it
    was bought in, how many to expect, and what is outstanding. Draft, cancelled
    and fully-received orders are excluded — a draft has been sent to nobody.
    `deriveReceivableOrders` mirrors the MRP's `tx.receivablePurchaseOrders`;
    duplicating it is acceptable for a **read**, and deliberately does not extend
    to the write (step 4 goes through the MRP's own transaction).
  - Warehouse: an **Inbound purchase orders** view in the MRP Catalog window,
    one row per order line with overdue dates called out, and a **Receive**
    action per line. Receiving asks for pallet, quantity, supplier batch and
    location, refuses more than the order still owes, and books a real pallet
    that picks and ships like any other.
  - The receipt records `mrpPoId` / `mrpPoLineId` / `mrpOrderRef` and is marked
    **`mrpReceiptStatus: 'pending'`** — the MRP has not been told yet. That mark
    is the seed of step 4's ledger, and `mrpPoLineReceived` already counts
    pending receipts so two people receiving the same delivery an hour apart see
    the second as already booked.
  - Tests: catalog 69 assertions (up 22), warehouse 71 (up 26).
- *Step 3b — purchase order editor (done).* The forecast could only raise orders
  for materials it flagged as short, and orders were read-only once raised — so
  the multi-line model was not reachable from the UI at all. Now:
  - **New purchase order** on the purchasing tab opens a full editor: reference
    (auto-minted), supplier, dates, notes, and a line editor.
  - Per line: material, **container picked per line**, container count → quantity
    derived (units conserved), unit cost, live line total and order total. The
    same material can appear on several lines, one per container size — the case
    the line model exists for, now authorable by hand.
  - A material with no packaging can still be ordered, by quantity, and says so.
  - **Save draft** or **Save and place**. Opening a draft opens it editable;
    anything placed opens read-only with a **Cancel order** action, and a
    received order offers no cancel at all.
  - Guards live in the data layer, not the modal: `tx.savePurchaseOrder` refuses
    to edit a non-draft (the supplier holds it, and stock may have landed
    against lines that must not move underneath receipts), refuses a duplicate
    reference, and drops abandoned half-filled rows rather than failing the
    save. `tx.cancelPurchaseOrder` refuses an order already received in full.
  - 22 new assertions; render-smoke covers empty, two-container-size draft,
    placed (read-only, zero inputs), received, and the tab button.
- *Step 4 (next)* — apply pending receipts to the MRP through
  `tx.receiveAgainstOrder`, flipping them to `applied`. The idempotency ledger
  is the careful part: a re-synced or edited receipt must never mint a second
  lot.
- *Step 4* — the pending-receipt queue and its idempotency ledger (the careful
  part: a re-synced or edited receipt must not mint a second lot).
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
