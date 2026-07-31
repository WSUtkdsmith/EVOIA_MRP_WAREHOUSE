# Phase 3 spec — cataloging MRP items in the Warehouse

What the MRP's four catalog entities are missing before their stock can be
physically cataloged and slotted in the Warehouse, and the modelling decisions
taken to close those gaps. This is the spec that drives the Phase 3 schema work;
no code has changed yet.

Verified against `mrp/mrp-console.jsx` (`SCHEMA`) and the warehouse data model
(`warehouse/index.html` state + `Original-Source-Inventory.csv`).

## Two levels

The warehouse needs data at two levels, and the MRP feeds both:

- **Catalog level** — how an item *type* is stored (packaging, footprint, rules).
  MRP: `rawMaterials`, `intermediateProducts`, `finishedGoods`, `wasteStreams`.
- **Physical-instance level** — each actual lot/pallet on the floor (batch,
  expiry, origin, location). MRP: the shared `lots` child table (`LOTS_TABLE`).

### What the MRP has today

| Entity | Catalog columns | Shared lot columns |
|---|---|---|
| rawMaterials | name, sku, supplier, unitCost, unit, certStatus, leadTimeDays, moq, reorderPoint, onOrder, notes | lotNumber, date, qty, producedQty, unitCost, usedDate, consumedDate, batchId, processId |
| intermediateProducts | name, sku, unit, notes, autoComposition, hazardClass | *(same lots table)* |
| finishedGoods | name, sku, unit, notes, autoComposition, hazardClass | *(same lots table)* |
| wasteStreams | name, sku, unit, notes, componentId, accumulate, hazardClass | *(same lots table)* |

## Gap 1 — Catalog-level (applies to all four unless noted)

| Missing field | Why the warehouse needs it | Notes |
|---|---|---|
| Package / container type | Stores containers (drum, tote, jug, barrel, sack, pallet); zone/slot type depends on it | Missing on all four |
| Package size | Warehouse SKU identity is item **+ size** | Missing on all four — part of *identity*, see Gap 3 |
| Storage capacity / footprint | Units per container, containers per slot → positions consumed | Warehouse `itemTypes.capacity` expects it; MRP has none |
| Shelf life | Compute expiry for new lots; enforce FEFO | Missing everywhere — see Gap 2 |
| Hazard class | Segregation rules | Present on intermediate/finished/waste; **missing on rawMaterials** |
| Stored vs transient flag | Some intermediates never sit in a rack | Missing everywhere |

Deferred to a later pass (the "full" set, not this phase): temperature/humidity
conditions, stackability / max-stack height, waste accumulation limits.

## Gap 2 — Lot-level (the `lots` table, shared by all four)

| Missing / weak field | Warehouse column | Status in MRP |
|---|---|---|
| Expiration date | `expiration` → `productStatus`, `monthsUntilExpiration`, FEFO | **Absent.** Biggest gap |
| Production date **and** arrival date, separate | `prodDate`, `arrivalDate` | MRP has one ambiguous `date` |
| Origin / source at the lot | `origin` | MRP `supplier` is catalog-level (raw only); produced lots carry none |
| Manufacturer / facility code | `mfg` (e.g. LV / EV) | Absent on the lot |
| Order reference | `ref` (PO / SO, e.g. "SO-1206") | Linked via batchId/processId/PO+SO but no readable ref on the lot |
| Container count / size for this receipt | how many drums/totes | Absent |

## Gap 3 — Identity

In the warehouse, **"SSB 1 gal" and "SSB 2.5 gal" are distinct SKUs** — same
product, different package. The MRP has one finished good "SSB" with one `unit`.
So package size is part of the physical SKU key, not just an attribute.

## Per-entity specifics

- **Raw materials** — closest fit (has supplier, lead time, reorder point).
  Gaps: `hazardClass` (others have it), packaging/size, shelf-life,
  storage capacity, stored flag. `supplier` is catalog-level; the warehouse
  wants **origin per lot** (a material can arrive from two suppliers).
- **Intermediate products** — often WIP in totes / Build Slots. Gaps: packaging/
  size, shelf-life/hold-time, capacity, and the **stored vs transient** flag.
- **Finished goods** — map most directly to the real inventory (SSB/SOS
  1-gal/2.5-gal with expiration). Highest value: package size, expiration,
  order ref.
- **Waste streams** — `accumulate` maps to Barrel / Tote-Overflow accumulation.
  Gaps: container type (via packaging), hazard handling. (Accumulation limit and
  a distinct disposal class are deferred to the full set.)

## Decisions taken

1. **Size → distinct physical SKUs.** Each catalog item gets one or more
   **packagings**, each a storable SKU with its own capacity/footprint. A
   physical lot references which packaging it is.
2. **Expiration = shelf-life on the item, auto-computed per lot.** Add
   `shelfLifeDays` to each catalog item; a lot's `expirationDate` defaults to
   production date + shelf life and stays editable. Drives FEFO and the
   warehouse status logic.
3. **Storage rules — core set this phase:** package type, size, capacity/
   footprint, hazard class (added to raw materials too), and a stored/transient
   flag. Temperature/humidity, stackability and waste accumulation limits are
   deferred.
4. This spec is committed to guide implementation and hand off cleanly.

## Proposed schema delta (for implementation — not yet applied)

### New child table on each of the four entities: `packagings`

```
packagings: {
  table: "<entity>_packagings", fk: "<entity>Id", pk: "id",
  columns: {
    id: "str",
    sku: "str!",            // physical SKU, e.g. "SSB-1GAL"
    packageType: "str!",    // drum | tote | jug | barrel | sack | pallet | ...
    size: "str!",           // "1 gal", "2.5 gal", "55 gal", ...
    unitsPerPackage: "num", // units in one container
    packagesPerSlot: "num", // containers per warehouse position (footprint)
    isDefault: "bool"
  }
}
```

### New catalog columns

- All four items: `shelfLifeDays: "num"`, `physicallyStored: "bool"` (default true).
- `rawMaterials` only: add `hazardClass: "str"` (parity with the others).

### New / clarified lot columns (`LOTS_TABLE`)

- `packagingId: "ref:packagings"` — which packaging/size this lot is.
- `expirationDate: "date"` — computed from production date + `shelfLifeDays`, editable.
- `productionDate: "date"` and `arrivalDate: "date"` — replace the single
  ambiguous `date` (backfill `productionDate = date`; keep `date` during
  migration to avoid breaking existing logic/tests, then retire it).
- `origin: "str"`, `mfg: "str"`, `orderRef: "str"`, `containerCount: "num"`.

### Shared-spine mapping (MRP ⇄ warehouse)

| Warehouse | MRP source |
|---|---|
| item | entity `name` / `sku` |
| size | `packagings.size` |
| batch | `lot.lotNumber` |
| totalIn / stock | `lot.producedQty` / `lot.qty` |
| expiration, productStatus, monthsUntilExpiration | `lot.expirationDate` (derived status) |
| prodDate / arrivalDate | `lot.productionDate` / `lot.arrivalDate` |
| origin / mfg / ref | `lot.origin` / `lot.mfg` / `lot.orderRef` |
| physical location, zone, x/y, damage | warehouse-owned, on the **shared** map (Option A), keyed to the lot |

## Migration & test notes

- `LOTS_TABLE` is shared by all four entities and by the CSV codec, `repo`, `tx`
  and 12 logic suites. Splitting `date` and adding columns must go through the
  schema (single source of truth) so export/import/validation stay in sync, and
  the affected suites (`schema`, `data-layer`, `csv-codec`, `cost`) updated.
- New id columns need readable companions in the CSV codec (`packagingId` /
  `packagingSku`), per the existing lossless round-trip convention.
- Unit-of-measure strings differ between MRP (`unit`) and warehouse (`unit` per
  item type); normalize on a shared vocabulary when wiring the spine.

## Open items for later phases

- Full storage-conditions set (temp/humidity/stack), waste accumulation limits
  and disposal class.
- Attachments/large blobs (cert scans, damage photos) currently ride inside the
  state JSON; move to blob storage before real data volumes.
