# Pre-V4 audit

14,377 lines · 1,119 tests passing · 0 parse errors · 0 undefined names

Run against `mrp-console_WORKING.jsx` before cutting V4 and moving to git.

---

## Clean

| Check | Result |
|---|---|
| Duplicate function definitions | none |
| Duplicate top-level constants | none |
| Undefined names (transpiler) | none |
| SCHEMA entities vs data collections | 16 / 16, no orphans either way |
| Table name collisions | none across 34 tables |
| Export coverage | 34 of 34 tables |
| Nav destinations vs render guards | 24 / 24, all header-linked |
| Modal routes vs openers | 23 / 23, none dangling |
| Referential integrity (seed) | no broken references across 762 lots, 278 root rows |

Data tables have stayed segregated. Every collection has a schema, every schema
has a collection, and the only non-collection key is `seedVersion`, which is
deliberate metadata.

---

## Flagged for review

### 1. Five functions are unused by the application

Each appears exactly once in the source — its own definition — and is kept alive
only by a test. Two are superseded; three represent work that was built and never
surfaced.

| Function | Status | Note |
|---|---|---|
| `reconciliationSummary` | **superseded** | Replaced by `heldSummary` when the panel became Held Finished Goods. Safe to delete. |
| `isClosed` | **superseded** | Replaced by `resolveHours`, which resolves closure, override and base in one pass. Safe to delete. |
| `itemActualUnitCost` | **unsurfaced** | Weighted actual cost of stock on hand. This is inventory valuation at what was really paid, and nothing in the UI shows it. Worth wiring up rather than deleting. |
| `wasteEvents` | **unsurfaced** | Waste generated over time. The extractor works; no chart consumes it. |
| `orderCompletionEvents` | **unsurfaced** | Completions dated by actual completion. Would give on-time delivery performance. |

Recommendation: delete the two superseded, and either surface or delete the three
unsurfaced. Leaving them is how a codebase accumulates functions nobody can
account for.

### 2. `calendar_overrides` exports empty

The table is correct and round-trips, but the seed contains no temporary
operating-hour periods, so the feature has no data demonstrating it. Everything
else exports with rows.

### 3. The process flow diagram is not legible

Known and acknowledged. The graph derivation is sound — 43 materials, 80 process
links, 8 stages, no cycles — but the SVG layout needs work.

### 4. Two tables are surfaced only through helpers

`purchase_orders` and `fulfilment_cancellations` are never read as
`data.purchaseOrders` / `data.fulfilmentCancellations` in the UI region; they go
through `purchaseOrderRecords()` and `cancellationRecords()`. That is the right
pattern, not a defect — noted only so a future audit does not flag it as a gap.

---

## Process note

Four times this session an edit half-applied: a script asserted partway through
and exited after writing some changes but not others. Once this deleted two
pre-existing functions (`processGraph`, `coverageSummary`) that a tab depended
on; they were rebuilt as wrappers over the new flow logic and the tab renders,
but that region is a repair rather than a clean build and deserves a read before
it becomes retained code.
