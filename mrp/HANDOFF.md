# Handoff — continuing the MRP console in Claude Code

Everything needed to pick this up from a clean checkout. Written for someone (or
Claude Code) with no context on how it was built.

---

## 1. What this is

A single-file React application: **`mrp-console_V4.jsx`**, ~14,400 lines, no
build step and no framework beyond React. It runs as a Claude artifact, which is
why it is one file — that constraint shaped the architecture and is worth
knowing before deciding to split it up.

It models a manufacturing plant end to end: purchasing, goods-in, multi-stage
production with lot genealogy, finite-capacity scheduling against operating
calendars, despatch, sales orders, and costing at the level of the individual
lot.

The seed dataset is an instant coffee facility — 762 lots, five months of
generated history, 34 tables.

---

## 2. Repository layout

Suggested starting structure:

```
/
  mrp-console.jsx            <- rename mrp-console_V4.jsx to this
  CHANGELOG.md               <- from CHANGELOG-V4.md
  AUDIT.md                   <- from AUDIT-pre-V4.md, becomes an issue list
  tools/
    mkcore.sh
    run-tests.sh
  test/
    schema.test.mjs
    data-layer.test.mjs
    csv-codec.test.mjs
    timeseries.test.mjs
    scheduler.test.mjs
    calendar.test.mjs
    plan-freeze.test.mjs
    cost.test.mjs
    purchasing.test.mjs
    reconciliation.test.mjs
    sales-orders.test.mjs
    held-stock.test.mjs
    render.test.js
  test/rendertest/
    node_modules/lucide-react/index.js    <- the stub, see §4
  archive/
    mrp-console_V1.jsx ... V3.jsx
```

Keep V1–V3 in `archive/`. V1 is the original and was never modified; the others
are release snapshots. They are the only record of how the thing evolved.

---

## 3. Toolchain

```bash
npm install -g typescript          # tsc, used only as a syntax/name checker
npm install react react-dom        # render tests only
```

No bundler, no test framework. The suites are plain node scripts that print
`PASS` / `FAIL` and exit non-zero on failure. That was deliberate — it keeps the
gate runnable anywhere with node and nothing else.

---

## 4. How the tests work

This is the part that is not obvious and is worth reading before changing
anything.

### Pure-logic suites (`*.test.mjs`)

The file is one big JSX module, which node cannot import. `mkcore.sh` extracts
everything **above the first React component** into `/tmp/core.mjs` and appends
a named-export block:

```bash
./tools/mkcore.sh          # writes /tmp/core.mjs
node test/cost.test.mjs    # imports from /tmp/core.mjs
```

It finds the boundary by locating the comment banner immediately followed by
`Small shared UI atoms`. **If you move or reword that comment, mkcore silently
extracts the wrong range** and every suite fails to load. If suites start
failing with "Export 'x' is not defined", check that boundary first.

When you add a pure-logic function you want tested, add its name to the export
list at the bottom of `mkcore.sh`.

### Render suite (`render.test.js`)

Transpiles the whole file with `tsc --jsx react`, then server-renders every tab
and modal with `react-dom/server`. `lucide-react` is stubbed — every icon
becomes an empty `<span>` — so no real dependency is needed:

```js
// test/rendertest/node_modules/lucide-react/index.js
const React = require('react');
const icon = (name) => (props) => React.createElement('span', { 'data-icon': name });
module.exports = new Proxy({}, { get: (t, k) => k === '__esModule' ? true : icon(String(k)) });
```

To run it, append an export block to a copy of the source, transpile, then run:

```bash
cd test/rendertest
cp ../../mrp-console.jsx app.tsx
cat >> app.tsx <<'EOF'
export { Dashboard, RevenueTab, ScheduleTab, /* ...every component under test */ };
EOF
tsc app.tsx --jsx react --module commonjs --target es2020 \
    --skipLibCheck --allowJs --esModuleInterop --outDir .
node render.js
```

**This suite is the one that earns its keep.** A parse check passes on code that
throws the moment it renders. Over this project it caught: a component wired to
a prop that did not exist, a dialog that was never added to the render tree, a
column reading a field the data layer did not provide, and `\uXXXX` escapes
rendering as literal text. None of those were visible to `tsc`.

### Reading the output

`tsc` emits thousands of type-inference warnings on this file; they are noise.
Only two categories matter:

```bash
# real syntax errors
tsc --noEmit --jsx preserve --target es2020 --skipLibCheck file.tsx 2>&1 \
  | grep -cE 'error TS1[0-7][0-9]{2}'

# undefined names
tsc app.tsx ... 2>&1 | grep -cE 'error TS(2304|2552|2448|2451)'
```

Both should be `0`.

---

## 5. Architecture

### The two regions

Everything above `/* Small shared UI atoms */` is **pure logic** — no React, no
JSX, testable in node. Everything below is components. Keep new logic above the
line; it is the difference between a function that can be asserted on and one
that can only be eyeballed.

### Data layer

- **`SCHEMA`** — 16 entities, 34 tables. Declares columns with types
  (`str`/`num`/`bool`/`date`/`ref:entity`/`enum:a|b|c`, `!` = required), natural
  keys, children, and polymorphic discriminators. It is the single source of
  truth: CSV export, import, and validation are all derived from it.
- **`repo`** — `list/find/create/upsert/patch/remove` plus lot operations. All
  writes go through it.
- **`tx`** — named transactions for anything touching several records:
  `logProductionBatch`, `shipFinishedGoods`, `receiveAgainstOrder`,
  `freezeRun`, `amendFrozenRun`, `cancelFulfilment`, `reviewSalesOrderLine`,
  `releaseSalesOrderLine`. These map to what would be SQL transactions.

**Enforcement lives in the data layer, not the UI.** `SCHEMA.schedule.guard`
refuses any change to a committed figure on a frozen run — `repo.upsert` throws.
The only way past it is `tx.amendFrozenRun`, which records the reason first. Put
a check in a modal and any other code path bypasses it.

### CSV codec

`csvPlan(tableDef)` drives both export and import from one column layout, so
they cannot drift. Every id column gets a readable companion beside it
(`equipmentId` / `equipmentCode`), so a bundle round-trips losslessly **and** can
be authored in a spreadsheet with every id column blank.

Three tables legitimately require ids on import — `schedule_revisions`,
`schedule_fulfillment_lots`, `fulfilment_cancellations`. They are machine-written
audit records keyed on a production run, and a run has no natural key.

---

## 6. Conventions worth keeping

**Comments explain *why*, not *what*.** The code says what it does. The comments
exist for the decisions someone would otherwise reverse — why scheduled is a
line and not a stacked series, why cancelling releases the earmark rather than
the stock, why standard cost is frozen at fulfilment.

**Tests assert intent, not markup.** Several early tests checked for exact SVG
dash patterns and broke on every restyle while proving nothing. Assert that two
reference lines are visually distinct, not that one is `"4 2"`.

**Invariants over examples.** The strongest tests here are properties: no day
ever exceeds equipment capacity; every bucket reconciles to its lines to the
penny; tripling supplier prices leaves historic COGS unmoved.

---

## 7. Gotchas

**`\uXXXX` in JSX text is not an escape.** Inside JSX text nodes and attribute
strings it renders literally. Use the actual character. This shipped broken in
V1–V2 (112 occurrences) before a render test caught it.

**`lot.qty` is what remains, `lot.producedQty` is what was made.** Charting `qty`
under-reported production by 78% because anything consumed downstream had been
drawn to zero. Any "how much did we make" figure uses `producedQty`.

**Seed data is deterministic.** `seedData()` uses a seeded PRNG, so values and
dates are identical every load — but **ids are freshly minted each call**. Do not
compare an id taken from one `seedData()` against another; match on SKU.

**Stored data shadows the seed.** The app loads from `window.storage` and only
falls back to `seedData()` when storage is empty. A new seed is invisible until
someone presses **Load sample data**. `SEED_VERSION` exists so a stale sample can
be detected and offered.

**Edits that half-apply.** Several times during this build a script asserted
partway through and exited after writing some changes but not others — once
deleting functions a tab depended on. If something is inexplicably missing,
check whether a multi-part edit only landed in part. Verify the file after
editing rather than trusting the tool reported success.

---

## 8. Where to start

The audit doc is effectively the issue backlog. In rough priority:

1. **Process flow diagram legibility.** The derivation is sound — 43 materials,
   80 links, 8 stages, no cycles. The SVG layout is the problem: overlapping
   edges, no routing, labels colliding. Worth a proper layered layout with edge
   routing, or a library.
2. **Read the two reconstructed regions** — `processGraph` / `coverageSummary`
   behind the flow tab, and `CONTINUOUS_CALENDAR` / `defaultCalendar` /
   `calendarFor`. Both were rebuilt after edits half-applied. They test and
   render clean, but they are not the originals.
3. **Conversion cost.** Labour and equipment hours are recorded and displayed
   but not priced, so every margin in the app is material-only.
   `lotConversionHours()` already exposes the hours; it needs a rate per machine
   and per operator.
4. **Multi-lot shipments.** A despatch can draw on only one lot today.
5. **Seed `calendar_overrides`** so temporary operating-hour periods ship
   demonstrated.
6. **Timeline bars in the schedule list view** still use `ceil(hours / 24)` and
   disagree with the capacity plan under restricted hours.

---

## 9. Versioning protocol

Carried over from how this was built, and worth keeping:

- Work in a working file, never directly on a release.
- Promote to a numbered version only deliberately, after the full gate passes.
- Verify the release is byte-identical to what was gated (`diff`), rather than
  assuming the copy worked.
- V1 is never modified.

Under git the first two are branches and tags, but the third still applies:
tag what you tested, not what you think you tested.
