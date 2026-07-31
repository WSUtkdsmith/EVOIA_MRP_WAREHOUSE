# MRP Console — V4

Cut from `mrp-console_WORKING.jsx`, byte-identical, after a full gate:
**0 parse errors · 0 undefined names · 1,397 tests passing across 13 suites.**

14,430 lines · 16 entities · 34 tables · seed `coffee-2026-07`

V1 in the project remains untouched.

---

## Since V3

V3 covered the FIFO scheduler, operating hours, historical charts and the CSV
codec. V4 is largely about **money and traceability** — where cost actually
comes from, and being able to follow any figure back to the thing that caused
it.

### Costing
- **Lot-level cost.** Every purchased lot records the price paid; cost rolls
  forward along the traceability links to intermediates and finished goods. A
  supplier increase no longer reprices stock bought last March.
- **`producedQty`** on lots, because `qty` is what remains and cannot divide a
  total cost.
- **Frozen standard cost** captured when a run is fulfilled, so expected-versus-
  actual stops moving.
- **Inventory valuation** at actual cost alongside standard, on the inventory
  card.

### Traceability
- **Batch records** — one per process run, with inputs, outputs, hours and
  rolled-up cost. Reachable from the production calendar and from held stock.
- **Shipment trace** — despatch paperwork, the lot, the batch that made it, and
  the material that fed the batch, from any revenue line.
- **Process flow** — a graph derived from the processes themselves, with
  stock-aware planning that stops where existing WIP already covers a
  requirement.

### Commercial
- **Sales orders** with per-line review: yes, no, or adjust quantity and date
  before releasing to the schedule. List price and rep discount held separately.
- **Purchase orders** with expected against actual delivery, partial receipts,
  and delivery-performance history.
- **Held finished goods** — made, allocated, unshipped — with COGS and sales
  value, and cancellation with disposition (return, damaged, expired, lost,
  waste dispose/accumulate) that updates the stock record in the same action.

### Operations
- Production calendar gained a **Completed** view reading real batch records.
- Equipment utilisation against available hours, with a planning limit.
- Waste generated over time; completions against due date.

---

## Decisions worth knowing

**Batch scaling is off by default.** Whether ten batches take ten times as long
is a question about your plant, not something the data settles.

**Operating hours default differently for new and existing databases** — 8h
Mon–Fri fresh, 24/7 on migration, so upgrading does not re-plan committed work.

**Scheduled is drawn as a line, never stacked on actual.** They measure the same
output; adding them overstated it by 51%.

**Multi-stage totals do not carry targets or a scheduled line.** Summing every
intermediate counts the same material at each stage, so the total exceeds the
raw material that entered the plant.

**Cancelling releases the earmark, not the stock** — unless a consume
disposition is chosen, which updates the lot at the same time.

---

## Known gaps

- **Process flow diagram is not legible.** The derivation is sound (43
  materials, 80 links, 8 stages, no cycles); the SVG layout needs work.
- **`calendar_overrides` ships with no seed rows**, so temporary operating-hour
  periods are undemonstrated.
- **A shipment can draw on only one lot.** A despatch spanning two lots needs
  two records.
- **Conversion cost is not priced.** Labour and equipment hours are recorded and
  displayed but not costed, so margins are material-only.
- **List view timeline bars** still use `ceil(hours / 24)` and will disagree with
  the capacity plan under restricted hours.

---

## Two regions to read before this becomes retained code

Both test clean and render clean, but both are **reconstructions rather than
original builds**, after edits that half-applied during the session:

1. **`processGraph` / `coverageSummary`** — deleted by a de-duplication, rebuilt
   as wrappers over `materialFlowGraph` / `stockAwarePlan`. The flow tab depends
   on them.
2. **`CONTINUOUS_CALENDAR` / `defaultCalendar` / `calendarFor`** — removed when
   an adjacent deletion took too much, restored immediately. Short and
   straightforward, but not the originals.

The first is the one worth reading closely.

---

## Running the tests

```
./run-tests.sh
```

`mkcore.sh` extracts the pure-logic core from the JSX so the data layer, codec,
scheduler, calendar, costing and commercial logic can be exercised in node.
`render.test.js` transpiles the whole file and server-renders every tab — this
is what catches undefined names, JSX text bugs, and components wired to props
that do not exist.
