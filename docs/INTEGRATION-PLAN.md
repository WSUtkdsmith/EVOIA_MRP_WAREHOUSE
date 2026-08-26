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

## ⚑ Flags for implementation

Everything that must be decided, built or checked before this runs a real
operation. Kept in one place deliberately — these were otherwise scattered
through the phase notes below and easy to lose.

### Blocking before real data

| # | Flag | Why it matters |
|---|---|---|
| 1 | **No authentication anywhere.** Every endpoint is open; anyone with the URL can read or write. | Fine for the sanitized build, unacceptable with real inventory and costs. Owned by the downstream security developer — see *Handoff to security*. Client-side `rolePermissions` is **not** a boundary. |
| 2 | **Go-live seeding runs warehouse → MRP, not MRP → warehouse.** Not built. | At go-live the **warehouse is the source of truth for what is on the floor**; the MRP starts empty. The seeded demo is the opposite way round (MRP rich, warehouse empty), which is an artifact of the sample data, not the real shape. Onboarding needs a one-time path that reads existing pallets and creates the matching MRP lots (batch, expiry, quantity, location already known) so the MRP starts life agreeing with the floor. Same ledger/idempotency shape as Phase 4 step 4, pointed the other way. |
| 3 | **Placement does not scale by hand.** | 442 in-stock lots in the seed alone. Whichever direction the initial load runs, it needs a bulk/CSV path — nobody is clicking Place 442 times. |
| 4 | **The consumption gate is enforced in the UI, not in `tx.logProductionBatch`.** | The batch log will not let you select warehouse stock, and blocks Save if a selection goes stale — but the transaction itself still consumes whatever it is handed. Anything that writes a batch without going through the modal (an import, an API caller, a future mobile client) bypasses the rule entirely. Enforcing it in the transaction is the right end state; it is not done yet because **it would refuse every batch against existing data**, where no lot carries `inProcess`. That is not a bug in the rule, it is flag 2 arriving early: until go-live seeding sets custody correctly, hard enforcement and the seeded dataset cannot both be true. **Decide together with flag 2, not separately.** |
| 5 | **Go-live seeding must decide the custody of every existing lot.** | With the gate in place, a lot with no `inProcess` flag is unconsumable. At go-live essentially everything on the floor is warehouse stock — correct, and it means production's first act is to raise material requests, which is the intended protocol. But **anything genuinely mid-process at cutover must be flagged In Process during seeding** or the line will be unable to log the batch it is standing in front of. Needs an explicit step in the onboarding path, not an afterthought. |
| 6 | **A shipment can be raised with no lot reference, and then has no actual cost of its own.** | `shipmentEvents` falls back to standard cost for such a shipment, which means Expected COGS and Actual COGS come out identical and the deviation is a **spurious zero** — reading as "on plan" when the truth is "we do not know what this cost". The roll-ups exclude those shipments from the deviation and report the count rather than absorbing them, so nothing is silently misstated in the meantime. **The fix is at source: shipments should not be raisable without a real lot.** Confirmed as the intended end state; until it lands, treat any period with a non-zero `shipmentsWithoutActualCost` as partially unmeasured. |

### Awaiting a decision

| # | Item | Needs |
|---|---|---|
| B | **The nightly valuation snapshot fires at 23:59 UTC.** `vercel.json` sets `59 23 * * *`, and Vercel crons only run on UTC. | The plant's timezone. "11:59 pm local" is a different instant, and for anywhere west of UTC a different *date* — which shifts a day's movement into the wrong bucket rather than losing it, but is still wrong. Tell me the timezone and I will set the cron offset. Also worth deciding: Vercel's Hobby plan runs crons **once a day at an approximate time**, so if the exact minute matters the project needs to be on Pro. |
| A | **"Semi-finished goods" as a fifth material category.** Not built — see `docs/SEMI-FINISHED-GOODS.md`. The capability already exists (bulk = an intermediate product; packing = a process), so the fifth `itemType` would buy a label at the cost of widening the polymorphic surface everywhere. A `stage` flag on intermediate products is the cheap version, under an hour. | Five questions in that doc — chiefly whether a semi-finished good can be **sold as-is**, and whether anything needs to **report on it separately**. Either would justify the type; a labelling preference would not. |

### Design notes to preserve (so they are not "fixed" by mistake)

- **`Place` is not a receiving bypass, and should not be routed through putaway.**
  It acts only on lots that **already exist** in the MRP; receiving creates lots
  that do not. The two sets are disjoint by construction. The warehouse itself
  already accepts stock existing without a putaway cycle —
  `saveManufacturedBatch` sets `pendingPutaway = false`. Place's ongoing role is
  **production output**: a lot comes off the line and needs a home, and nothing
  else owns that event (`saveManufacturedBatch` covers only empty-tote → filled).
- **Receiving an MRP order *is* routed through the normal flow**, deliberately —
  it becomes a queued order file and goes in via Receive Order. The first cut let
  it bypass staging, putaway, labels, damage capture and signature; that was a
  real error and was corrected. Do not add a second door to receiving.
- **Parsing is not running, and unit tests are not startup.** Removing a
  superseded receive path also removed `submitMrpPlacement`, which `init()` still
  wired to a form. The file parsed, every extracted-function test passed, and the
  app was **dead on load** — `init()` threw on the first missing name, so no zone
  rendered and the map came up empty. `warehouse/test/startup.test.js` now checks
  every startup handler, every element it is wired to, and every renderer in the
  dispatch table; it fails if a definition is deleted while a reference survives.
- **`IMPORT_ORDER` is a hardcoded list and has caught us twice.** Any new child
  table must be registered there or it will export correctly and import to
  nothing. Bit `packagings`, then `purchase_order_lines`. The CSV round-trip test
  is what caught both — keep it.
- **The batch log may only consume In Process material.** Production used to be
  able to draw any lot in the MRP, which meant taking material off the rack with
  no pick, no document and no position — the receiving bypass again, in the other
  direction. Warehouse stock is now **listed but not selectable**, under its own
  "Inventory in storage — request material" heading. It is listed rather than
  hidden on purpose: hiding it reads as "we have none", which is false. Do not
  "improve" this by filtering it out, and do not add a quick-consume shortcut.
- **Produced goods start In Process, and that is not a bug.** A lot the line just
  made has no Material Request behind it, so custody begins with Operations and a
  Material Return is what ends it. The visible effect is that new output does not
  appear as warehouse stock until it is returned — correct, and the reason
  Manufacturing cannot quietly assume the warehouse role.
- **The render suite was dead from Phase 0 to Phase 5** — `mrp/test/render.test.js`
  was committed but the `app.js` bundle it requires never was, so 284 assertions
  ran nowhere. `mrp/tools/mkapp.sh` rebuilds it and `npm test` runs it. It derives
  its export list from the test's own `A.<name>` references, so a renamed
  component fails the bundle loudly instead of testing nothing. **A committed test
  with an uncommitted build step is worse than no test** — it reads as coverage.
- **Batch time is clocked, not typed — and the clock is not the only guard.**
  The batch log used to pre-fill actual hours with the *planned* hours, so
  leaving the field alone made actual-vs-planned agree by construction; the
  variance report was measuring the form's default. A batch run now carries
  `startedAt`/`finishedAt` and elapsed time is **derived, never stored** — a
  stored duration and a stored pair of timestamps can disagree, and then nobody
  knows which is true. Times can still be typed, because the clock does get
  forgotten at the start of a run and left going over lunch, but
  `setBatchRunTimes` **requires a reason** and keeps the clocked times beside the
  correction. Do not "simplify" that by storing a duration, and do not make the
  reason optional — a system that cannot express a forgotten clock gets worked
  around rather than used.
- **Equipment hours and labour hours are different numbers.** A machine running
  two hours is two equipment-hours however many people watched it; two operators
  on that run is four labour-hours. `runHoursForBatch` derives both from one
  elapsed time and the run's operator count. Typing both by hand is exactly where
  that distinction used to get lost.
- **Product family totals never sum units, and never sum across units of
  measure.** Every format carries `unit: "ea"`, but an "ea" is a 50g sachet
  pack or a 500g pouch, so a summed unit count across formats is a number that
  means nothing — `familySalesRollup` returns units **per product only**, with
  no group total. Quantities roll up by **net content**, and `netByUnit` is a
  map keyed by unit rather than a single figure, because the moment a liquid
  line exists a "Form" roll-up would otherwise add litres to kilogrammes.
  Revenue is the only measure that adds up across everything, which is why it
  leads. Do not "helpfully" add a units column to the group rows.
- **Family selection is faceted, and the axis is why.** Tags on the same
  `dimension` widen a selection (Premium Reserve *or* Classic Gold); tags on
  different dimensions narrow it (Premium Reserve *in* foodservice). Plain OR
  returns half the catalogue for the second question and plain AND returns
  nothing for the first, which is why `dimension` is required on a family
  rather than optional. `mode: "any"|"all"` exists as an explicit override.
- **A product with no net content is a gap, not a zero.** `netContentOf`
  returns null, and the roll-up reports `productsWithoutNetContent` so a total
  with a hole in it says so. Zero would read as "we sold none", which is a
  different and much more dangerous claim than "we do not know".
- **A run cannot be committed to more than it makes, and this REVERSES an
  earlier decision.** Linking a sales order line to a run originally allocated
  the whole line even to a run too small to make it, on "show, don't block"
  grounds. That was wrong: the shortfall was invisible, so a run could be
  committed to more than it produced and nobody would find out until the goods
  failed to appear. A link now takes the run's remaining balance and no more,
  and hands the caller the `remainder` so it can offer another run or raise one
  for the balance. Do not reinstate the permissive version.
- **`line.scheduleId` is superseded — read `lineAllocations(line)`.** A line can
  be filled from several runs, and a single id cannot say how much came from
  which. The column survives only so existing data migrates (`normalizeData`
  turns a bare `scheduleId` into one allocation for the line's full requirement)
  and so the CSV round trip stays stable. Nothing in the app reads it. Adding a
  second reader would recreate exactly the dual-source-of-truth this avoids.
- **`releaseSalesOrderLine` raises a run for the UNALLOCATED balance only.**
  That is what makes "add remainder as a new run" safe. Raising the full line
  quantity again for a part-covered line would double the plant's commitment.
- **A cancelled order releases its capacity.** `runCommittedQty` skips cancelled
  orders, so a withdrawn order stops holding a run booked against nothing.
- **Ownership split, MRP vs warehouse:** the MRP owns the lot (produced quantity,
  cost, genealogy); the warehouse owns placement (pallet, slot, working quantity
  for picking). Where the two disagree the difference is **shown, not
  reconciled** — "over-placed" is a visible state, not a silent clamp. A real
  two-way quantity sync needs conflict rules nobody has specified.

### Next planned work

- **Phase 5 — material flow (step 1 of 5 built).** See
  `docs/PHASE5-MATERIAL-FLOW.md`. Gives WIP an owner: a 6-position To/From
  Process zone, Material Request / Material Return documents, an In Process
  custody flag, and an MRP-side material balance that reuses the existing waste
  streams. Three open decisions are listed at the end of that spec — FEFO vs
  named lot, what happens when all six positions are full, and whether produced
  goods must pass through To/From — **all three now resolved** in that spec.
  Step 1 (schema + transactions + 68 assertions) is done; the warehouse zone,
  API and both UIs remain.

### Functional gaps (known, not blocking)

- **Shipping/despatch is not unified** the way receiving now is — the reverse of
  Phase 4 remains for outbound.
- **Drag-to-place on the map**, and **multi-slot footprints** from
  `packagesPerSlot` (captured and displayed, but does not yet reserve positions).
- **Storage rules global vs per-BU** is still TBD in the scoping table.
- Purchase orders are **single-supplier**; grouping is per supplier by design.

### Technical debt

- **`@vercel/postgres@0.10.0` is deprecated** in favour of Neon's native SDK.
  Works today; migrate before it stops being patched.
- **The render suite (~400 assertions) is not in CI** — only the 1,020 logic
  assertions and the API/warehouse suites run. It is the suite that catches
  undefined names and components wired to props that do not exist.
- **`mrp/app.bundle.js` is a committed build artifact.** A Vercel build step
  should generate it instead, so source and bundle cannot drift.
- **Catalog payload is ~480 KB** for 762 lots. Fine now; if it grows the fix is
  server-side filtering/paging, not client-side trimming.

### Inherited MRP gaps (from the original `AUDIT.md`, still open)

- Process flow diagram is not legible (derivation sound, SVG layout is the problem).
- **Conversion cost is not priced** — labour and equipment hours are recorded and
  displayed but not costed, so every margin in the app is material-only.
- A despatch can draw on **only one lot**.
- `calendar_overrides` ships with no seed rows, so the feature is undemonstrated.
- Two regions are **reconstructions rather than original builds** and deserve a
  read before they become retained code: `processGraph` / `coverageSummary`, and
  `CONTINUOUS_CALENDAR` / `defaultCalendar` / `calendarFor`.


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
    one row per order with its lines, overdue dates called out, and an **Add to
    receiving queue** action.
    - *Corrected after review:* the first cut let an order be received straight
      from the catalog window, which **bypassed the warehouse's own receiving
      workflow** — staging, putaway, labels, damage capture, who signed for it,
      and the receiving-order record itself. An MRP order does not get its own
      receiving path. It becomes a **queued order file** like any parsed order,
      appears in the dropdown on **Receive Order**, and goes in through the
      normal flow. The MRP link rides along on the queue entry's items → the
      receiving row's dataset → the pallet content line, so the delivery is
      still reported back to the MRP. The two functions that served the old
      direct path were deleted rather than left unaccounted for.
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
- *Step 4 — receipts reach the MRP (done). Phase 4 complete.*
  - **The ledger lives with the writer.** A new `warehouseReceipts` entity in the
    MRP records every dock booking it has applied, keyed on `sourceLineId` (the
    warehouse pallet content line, stable for the life of that stock). The MRP
    creates the lot, so the MRP is what must remember it already did — the
    warehouse is never written to cross-module, and there is one source of truth
    for what is done.
  - `tx.applyWarehouseReceipts` applies each booking through
    `receiveAgainstOrder`, so a lot is created at the order's price and the order
    advances exactly as if entered in the MRP. **There is no second way for stock
    to come into existence.**
  - **Idempotent by construction:** a booking already in the ledger is skipped,
    not re-applied — safe to run twice, to retry after a failed save, or from two
    tabs. A booking repeated inside a single call also applies once. Failures
    (order cancelled, line gone, more than is owed) are returned with reasons
    rather than dropped, and one failure does not stop the rest of the queue.
  - `GET /api/pending-receipts?bu=` reports what the dock has booked minus what
    the ledger says is done. Deliberately **read-only**: applying creates stock,
    and that goes through the MRP's transaction, not an endpoint.
  - MRP purchasing tab shows a **dock panel** — what is waiting, one button to
    record it, and per-booking reasons for anything that could not be.
  - The warehouse reads `appliedReceiptIds` from `/api/catalog` rather than
    trusting its own pending flag, which can only ever be a local guess.
  - Tests: 43 new MRP assertions (1,020 logic total) plus 22 API and 6 warehouse.
    Proven end to end on real data: order raised with two container sizes →
    booked at the dock → recorded in the MRP (two lots at their own line prices,
    order Received) → **full re-sync applies nothing, creates no lot, order
    unchanged**.
- *Step 4* — the pending-receipt queue and its idempotency ledger (the careful
  part: a re-synced or edited receipt must not mint a second lot).
- **Phase 4 — Polish + handoff.** Address inherited MRP gaps (process-flow SVG,
  reconstructed regions, conversion-cost pricing, multi-lot shipments) by
  priority; hand the auth seam to the security developer.

## Phase 5 — Material flow between Warehouse and Operations (specced, not built)

The handshake between two separate entities. An MRP lot has `usedDate` and
`consumedDate` but **no location**, so between "picked from the rack" and
"consumed in a batch" material is physically real and organizationally nowhere.

Full spec: **`docs/PHASE5-MATERIAL-FLOW.md`**. Decisions taken:

- **In Process** = material received or produced that is **not under the direct
  supervision of the warehouse manager**. A custody statement, not a location —
  so it is a **viewable zone type with no positions**, never slotted.
- **One zone gets built: To/From Process, 6 positions** (`TP1`–`TP6`), modelled
  on Build Slot. The **only** place a Material Request or Return may populate —
  one door between the entities. **Transit, not holding**: the position frees the
  moment Operations marks the material received, so six throttles concurrent
  handovers, not concurrent jobs. Reuses the receiving framework.
- **Material Request** (Warehouse → Operations) and **Material Return**
  (Operations → Warehouse). **Transfer Order is reserved** for movement between
  warehouses, a later feature — do not conflate.
- Returns carry a **`returnType`**: `leftover` (back to an existing lot and
  pallet) or `output` (produced goods, creating a new lot). Leftovers display the
  **original position** as a hint so material goes straight back where it came
  from — a hint, not a reservation.
- **In Process is a stored flag** set by the transactions, not hand-ticked, and
  cleared only as an **exception with a recorded reason** (the `amendFrozenRun`
  shape). It shows on issued raw lots, and on intermediates and finished goods
  from production until a Return is placed.
- **The material balance lives in the MRP**, not the warehouse:
  `issued − (consumed + returned + waste) = discrepancy`. Consumption
  (`lot_sources.qty`) and waste (`wasteAllocations` → waste streams) are
  **already recorded**; only issued and returned are new. This also gives
  `wasteEvents()` — flagged in the original audit as built-but-unsurfaced — its
  first consumer.

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
