# "Semi-finished goods" — assessment, and what I need before building it

**Status: not built. Deferred deliberately, with questions below.**

Requested in review: a material category for *"any otherwise finished product
awaiting final packaging and labelling"*, with the instruction to call it out
rather than build it if it needs significantly more input. It does — but not for
the reason it might look like.

## The finding: the capability already exists

Bulk product awaiting packaging is **an intermediate product**, and
"pack and label" is **a process** that consumes it and produces a finished good.
That is exactly the shape the MRP already models:

```
Intermediate: "Blend 12 — bulk"      →  Process: "Pack & label 1 gal"  →  Finished: "Blend 12, 1 gal"
   (has lots, cost, composition,          (inputs, equipment, batch          (sellable, priced,
    QC checks, warehouse placement)        time, SOP, run clock)              shipped)
```

Everything a semi-finished good needs — lots, expiry, cost roll-up, composition,
QC, warehouse placement, custody, material requests — an intermediate product
already has. **Nothing is missing except the word.**

So the real question is not "can we model it" but "what do you want that the
existing model does not give you", and there are two very different answers.

## Why the fifth item type is expensive

`itemType` is a **polymorphic discriminator**. Adding a fifth value is not a
column, it is a change to every place the four current values are enumerated:

| Where | What changes |
|---|---|
| `ITEM_TYPE_ENTITY` / `ENTITY_ITEM_TYPE` | new entity + new table `semi_finished_goods` |
| `SCHEMA` enums | `process_inputs`, `process_outputs`, `schedule`, `material_request_lines`, `material_return_lines`, `composition` — each hardcodes its allowed set |
| `IMPORT_ORDER` | new table, in the right position (**this has bitten us twice**) |
| `seedData` / `normalizeData` | new collection in the seed and **both** normalize branches |
| CSV codec | `polyRefs` companions, round-trip coverage |
| API | `ITEM_TYPE_COLLECTION` in `_catalog.js` and `_material-flow.js` |
| Warehouse | item-type mapping, catalog window, material flow window |
| Derived logic | costing, forecast, coverage, flow graph, held stock, custody gate, balance |

That is a day of careful work whose *entire* benefit, as far as I can tell, is a
different label on something already representable — and it permanently widens
the polymorphic surface that every future feature has to handle.

## The cheap alternative

If what is wanted is that these items are **visibly distinct from other
intermediates** — a filter, a heading, a badge — that is a **flag on the
intermediate product**, not a new type:

```
intermediateProducts.stage: "enum:intermediate|semiFinished"
```

One column, one enum, no new table, no `IMPORT_ORDER` risk, no change to any
polymorphic call site. Filterable in the catalog, badgeable on the row, and
reversible if it turns out to be the wrong cut. **I can do this in well under an
hour** — say the word.

## What I need to know to choose

1. **Can a semi-finished good be sold as-is?** If yes, it needs a price list and
   a sales-order line, which finished goods have and intermediates do not — and
   that is a genuine argument for a distinct type. If no, the flag is enough.
2. **Is it the same SKU as the finished good in a different state, or its own
   SKU?** Same SKU in two states is a materially different data model from two
   items joined by a process, and it is the one thing the current design cannot
   express.
3. **Does it need its own lot genealogy, or does the finished lot inherit from
   the bulk lot?** Today, packing creates a new lot with the bulk lot as a
   source — full traceability, two lot numbers. Is two lot numbers a problem?
4. **Does anything need to report on semi-finished stock separately** — a
   valuation line, a WIP figure, a regulatory return? A reporting requirement
   would justify the type where a labelling preference would not.
5. **Is "awaiting packaging" a state of the item or a state of the lot?** If a
   single item can be bulk *or* packed depending on the lot, that is a lot-level
   flag and neither of the options above is right.

My recommendation, absent those answers: **use intermediate products as they
are**, and add the `stage` flag if and when the distinction needs to be visible.
Revisit the fifth item type only if the answer to (1) or (4) is yes.
