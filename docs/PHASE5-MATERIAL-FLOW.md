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

1. ~~**Schema delta + transactions**~~ — **done.** `materialRequests` and
   `materialReturns` entities with line-level status, the `inProcess` /
   `inProcessSince` / `inProcessClearedReason` lot columns, and the seven
   transactions (`raiseMaterialRequest`, `stageRequestLine`, `receiveRequestLine`,
   `raiseMaterialReturn`, `stageReturnLine`, `acceptReturnLine`,
   `clearInProcess`) plus FEFO, the position ledger, the waiting queue, the
   In Process window and the balance. `mrp/test/material-flow.test.mjs` — 68
   assertions. Both return flavours clear custody through the same transaction;
   `returnType` drives what the *warehouse* does physically, which is why it
   lives on the document rather than branching the MRP write.

2. ~~**Warehouse zone**~~ — **done.** `TP1`–`TP6` drawn beside Build Slot as a
   six-position grid, each occupied position showing **OUT** or **IN** so the
   picker can see which way it is moving. In Process is drawn as a **flat region
   with no cells** — a count and a note, because there is nothing to slot.
   `locationType` gains `transit` and `inprocess`; `locParts` reports
   `isTransit`; `locationText` names both zones.
   **The discipline rule is enforced in code:** `canMoveToLocation` refuses a
   hand-driven move into a To/From position unless it comes from material flow
   (`opts.materialFlow`), so the door cannot quietly become six more storage
   slots. 12 warehouse assertions cover it, including that `IN_PROCESS_LOCS`
   does **not** exist.
3. ~~**API**~~ — **done.** `GET /api/material-flow?bu=` returns the warehouse's
   worklist: requests to pick (each pending line carrying its **FEFO suggestion
   and alternatives**, so the picker can substitute without a second round
   trip), returns to put away with their `returnType` and origin hint, what
   Operations is holding (oldest out first — what has been away longest is what
   to chase), the six positions with who holds each and which direction, and a
   `doorFull` flag so a blocked pick is stated rather than inferred.
   Read-only: staging, receiving and accepting all move custody and stay in the
   MRP's transactions. `api/test/material-flow.test.js` — 39 assertions.
4. ~~**Warehouse UI**~~ — **partly done.** A **Material Flow** window on the
   topbar with three views: **requests to pick** (FEFO shown per line, with a
   Pick action), **returns to put away** (production output called out as needing
   a new position, leftovers showing where they came from), and **held by
   Operations** (oldest out first). Picking preselects the FEFO lot, offers the
   alternatives, and **demands a reason if anything else is chosen**; it refuses
   a position that has just been taken, and stages the pallet into the door
   immediately, marked `pending` until the MRP records it.
   *Still to do:* the put-away action on returns, and the MRP-side applier that
   turns pending stagings into `tx.stageRequestLine` calls — until that lands the
   pick is real on the floor but not yet recorded in the MRP.
5. **MRP UI** — raise requests, the In Process window, and the balance report.

## Decisions — resolved

1. **The warehouse selects the lot.** A request asks for an item and a quantity,
   not a lot. When picking, the system **suggests FEFO** (earliest expiry first,
   undated last) and the **operator confirms or substitutes**. A substitution is
   recorded with its reason — a picker overriding FEFO is a signal worth keeping
   (blocked, damaged, quarantined, wrong side of the rack), not noise to discard.
2. **A request with no free position queues.** It stays `Requested` and is shown
   as **waiting for a position** rather than being refused at raise time — the
   need is real even when the door is full, and Operations should see the queue.
3. **Produced goods pass through To/From like everything else.** No straight-to-
   rack path for production output. The reason is organisational, not technical:
   **it stops Manufacturing quietly assuming the warehouse role.** Everything
   entering warehouse custody enters the same way and is signed for.

   Consequence to watch: To/From is now the single door for issues, leftover
   returns *and* all production output. Because a position frees on receipt or
   putaway rather than being held for the life of a job, six positions throttle
   handover time, not throughput — but if the floor ever backs up, position count
   is the dial to turn, not the rule to weaken.
