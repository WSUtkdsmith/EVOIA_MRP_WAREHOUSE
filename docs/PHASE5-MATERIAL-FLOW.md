# Phase 5 spec — material flow between Warehouse and Operations

The handshake between two separate entities. Warehouse holds and issues material;
Operations consumes it and produces goods. Today the boundary between them is
invisible: an MRP lot has `usedDate` and `consumedDate` but **no location**, so
between "picked from the rack" and "consumed in a batch" material is physically
real and organizationally nowhere. That window is where discrepancies breed.

This is a new system going in with new protocols, so the handshake is designed
now rather than patched later.

## The custody definition

> **In Process** = material that has been received or produced but is **not
> currently under the direct supervision of the warehouse manager**.

This is a statement about *who holds it*, not *where it is*. Material in a mixing
tank has no slot, no footprint and no stacking rule. The warehouse manager needs
to **see** it — to keep material balances and to plan for what is coming off the
line — but does not control it and cannot be asked to slot it.

Consequence for implementation: In Process is a **viewable fifth zone type with
no position constraints**. It is drawn on the map and reported in its own window;
it is never assigned coordinates or capacity. Do not "helpfully" give it slots.

## What gets built

### One zone: To/From Process — 6 positions

Modelled on Build Slot (`BS1`–`BS6`): a real staging area with finite positions,
`locationType: 'transit'`.

**It is the only place a Material Request or Material Return may populate.** One
door between the two entities. Six positions is a physical constraint, and a
physical constraint enforces process discipline better than any software rule —
the same lesson as routing MRP orders through Receive Order.

**It is transit, not holding.** A position is occupied only during handover:

```
Material Request raised (MRP)
  → warehouse picks, stages into TP1..TP6   [position occupied, flagged in MRP]
  → Operations marks received               [In Process flag set, position freed]
```

So six positions throttles *concurrent handovers*, not concurrent jobs. This
mirrors the receiving framework exactly and is the reason it can reuse it.

## The two documents

Named to convention so the next developer is not guessing. **Transfer Order is
deliberately reserved** for movement between warehouses, which is a later
feature and must not be conflated with these.

### Material Request — Warehouse → Operations

Raised in the MRP, acted on by the warehouse, reported back. Same shape as a
purchase order: header plus lines, each line naming the item, the lot (or FEFO
choice), the container and the quantity.

Lifecycle mirrors a PO exactly:

| State | Meaning |
|---|---|
| `Draft` | being written, not yet asked for |
| `Requested` | asked for; the warehouse can act |
| `Staged` | picked into a To/From position; **flagged in the MRP** |
| `Received` | Operations has it; **In Process flag set, position freed** |
| `Cancelled` | withdrawn |

### Material Return — Operations → Warehouse

The reverse. **Carries a `returnType`, because the two flavours behave
differently and the warehouse must be able to tell them apart before it walks
out to the floor:**

- **`leftover`** — drew 200 kg, used 150, returning 50. Goes back to an
  **existing** lot and pallet. The warehouse is expecting something it already
  knows.
- **`output`** — intermediates and finished goods, which came into existence in
  Operations' custody. Creates a **new** lot and pallet. The warehouse is
  expecting something new and must slot it.

**Leftover returns carry the original position.** When material is issued, the
pallet's location is recorded on the request line as `originLocation`. A leftover
return displays it so the material goes straight back where it came from instead
of being re-slotted somewhere else. It is a **hint, not a reservation** — the
position may legitimately have been filled while the material was out, so the
warehouse can override it; nothing is held empty waiting.

## The In Process flag

A **stored flag**, set by the transactions above rather than hand-ticked, so it
follows the documents and cannot be forgotten. It shows on:

- **raw material lots** issued against a Material Request and marked received;
- **intermediate and finished goods lots** from the moment they are produced
  until a Material Return is placed.

That second case is the asymmetry worth noticing: produced goods have no Request
— they are born in Operations' custody — so for them In Process is the *default*
state and the Return is what clears it.

### The exception

A flag can be wrong: material scrapped on the line and never coming back, a
correction, a mis-key. So the flag can be cleared **as an exception with a
recorded reason**, following the same shape the MRP already uses for
`amendFrozenRun` — the reason is captured first and the change is audited. There
is no silent tick-box.

## The material balance — MRP-side, reusing what exists

The warehouse is not concerned with the balance; it belongs in the MRP. All four
terms are, or will be, recorded:

```
issued − (consumed + returned + waste) = discrepancy      // expect 0
```

| Term | Source | Status |
|---|---|---|
| issued | Material Request, received quantity | **new** |
| consumed | `lot_sources.qty` per source lot, written by `logProductionBatch` | **exists** |
| returned | Material Return quantity | **new** |
| waste | waste-stream lots, routed by `wasteAllocations` → `getWasteStreamForComponent` | **exists** |

The waste stream module already does its half: `logProductionBatch` accepts
`wasteAllocations`, and streams with `accumulate` set collect them as real lots.

Two things fall out of this for free:

1. **`wasteEvents()` gets a consumer.** The original `AUDIT.md` flagged it as
   built and never surfaced — "worth wiring up rather than deleting". The balance
   is what wires it up.
2. **Discrepancy becomes visible for the first time.** Today an over-draw simply
   evaporates. A non-zero discrepancy is a real signal — investigate rather than
   reconcile silently, in keeping with the "show, do not reconcile" rule already
   used for over-placement.

## Schema delta (proposed, not yet applied)

### MRP — two new entities, both mirroring `purchaseOrders`

```
materialRequests
  id, reference!, requestedBy, requestedFor (process/run), status!,
  requestedDate!, neededDate, notes
  children:
    lines: id, itemType!, itemId!, lotId, packagingId, containerCount,
           qty!, originLocation, stagedAt, receivedQty, notes
    fulfilments: id, lineId, qty!, date!, palletId, notes    (ledger, like purchase_receipts)

materialReturns
  id, reference!, returnType: enum:leftover|output!, status!,
  returnedBy, returnedDate!, notes
  children:
    lines: id, itemType!, itemId!, lotId, packagingId, containerCount,
           qty!, suggestedLocation, notes
```

### MRP — lot columns

```
inProcess: "bool"
inProcessSince: "date"
inProcessClearedReason: "str"     // set only via the exception path
```

### Warehouse

- New `locationType: 'transit'` with `TP1`–`TP6`, alongside rack/stage/build/floor.
- New `locationType: 'inprocess'` — **viewable, no positions**; the map draws it
  as a region and the In Process window lists it.
- Pallet content lines gain `mrpRequestId` / `mrpRequestLineId` /
  `mrpReturnId` — the same linkage pattern as `mrpPoId` / `mrpPoLineId`.

### Registration traps (these have caught us twice)

- Every new child table **must** be added to `IMPORT_ORDER` or it will export
  correctly and import to nothing. Bit `packagings`, then `purchase_order_lines`.
- New top-level collections must be returned by `seedData()` **and** carried by
  both branches of `normalizeData`.

## Build order

1. **Schema delta + transactions** — `raiseMaterialRequest`, `stageRequestLine`,
   `receiveRequestLine`, `raiseMaterialReturn`, `applyMaterialReturn`, plus the
   In Process flag and its exception path. Tests first, as with Phase 4.
2. **Warehouse zone** — `TP1`–`TP6` on the map, In Process region, storage rules.
3. **API** — `/api/material-flow?bu=` exposing open requests and returns, the
   same read-only shape as `/api/pending-receipts`; application stays in the MRP.
4. **Warehouse UI** — requests to pick and stage, returns to put away, with the
   original-position hint on leftovers.
5. **MRP UI** — raise requests, the In Process window, and the balance report.

## Open decisions

1. **Does a Material Request name a specific lot, or a quantity the warehouse
   picks FEFO?** Naming a lot gives Operations control; FEFO gives the warehouse
   control and better rotation. Recommend **FEFO by default with an optional
   named lot**, since expiry data now exists to make FEFO real.
2. **What happens when all six positions are occupied?** A request presumably
   queues in `Requested` and the warehouse sees a "waiting for a position"
   state. Confirm that is wanted rather than blocking the raise.
3. **Do intermediates always pass through To/From**, or can a produced lot be
   returned straight to a rack? The six-position door says everything passes
   through; that is a discipline choice, not a technical one.
