// Pure derivation of the warehouse's material-flow worklist from MRP data.
//
// The warehouse needs three things from the MRP: what has been asked for that it
// has not yet picked, what is sitting in a To/From position mid-handover, and
// what Operations is currently holding. It should not have to parse the MRP's
// documents to work that out, so this derives a stable contract and
// /api/material-flow serves it.
//
// Read-only by design. Staging, receiving and accepting all create or move
// custody, and those go through the MRP's own transactions so its enforcement
// stays authoritative — exactly as with receipts.

'use strict';

const ITEM_TYPE_COLLECTION = {
  raw: 'rawMaterials',
  intermediate: 'intermediateProducts',
  finished: 'finishedGoods',
  waste: 'wasteStreams',
};

const TRANSIT_POSITIONS = ['TP1', 'TP2', 'TP3', 'TP4', 'TP5', 'TP6'];

function itemOf(data, itemType, itemId) {
  const collection = ITEM_TYPE_COLLECTION[itemType];
  const list = collection && Array.isArray(data[collection]) ? data[collection] : [];
  return list.find((i) => i && i.id === itemId) || null;
}

function lotOf(item, lotId) {
  return (item && Array.isArray(item.lots) ? item.lots : []).find((l) => l && l.id === lotId) || null;
}

function packagingOf(item, packagingId) {
  const list = (item && Array.isArray(item.packagings)) ? item.packagings : [];
  return (packagingId && list.find((p) => p && p.id === packagingId))
    || list.find((p) => p && p.isDefault) || list[0] || null;
}

// FEFO, mirrored from the MRP so the warehouse can show the suggestion without a
// second round trip. Earliest expiry first; an undated lot sorts LAST, because an
// unknown expiry is not an urgent one. Lots already out with Operations, or
// already promised to another staged line, are not offered.
function fefoCandidates(data, itemType, itemId) {
  const item = itemOf(data, itemType, itemId);
  const committed = {};
  (Array.isArray(data.materialRequests) ? data.materialRequests : []).forEach((r) => {
    (r && Array.isArray(r.lines) ? r.lines : []).forEach((l) => {
      if (l && l.lotId && l.lineStatus === 'Staged') committed[l.lotId] = true;
    });
  });
  return (item && Array.isArray(item.lots) ? item.lots : [])
    .filter((l) => l && (Number(l.qty) || 0) > 0 && !l.inProcess && !committed[l.id])
    .slice()
    .sort((a, b) => {
      const ax = a.expirationDate || '', bx = b.expirationDate || '';
      if (ax && bx) return ax.localeCompare(bx);
      if (ax) return -1;
      if (bx) return 1;
      return String(a.lotNumber || '').localeCompare(String(b.lotNumber || ''));
    })
    .map((l) => ({
      lotId: l.id,
      lotNumber: l.lotNumber || '',
      qty: Number(l.qty) || 0,
      expirationDate: l.expirationDate || '',
    }));
}

function lineBase(data, line) {
  const item = itemOf(data, line.itemType, line.itemId);
  const pkg = packagingOf(item, line.packagingId);
  return {
    lineId: line.id || '',
    itemType: line.itemType || '',
    itemId: line.itemId || '',
    itemName: item ? (item.name || '') : '(deleted item)',
    itemSku: item ? (item.sku || '') : '',
    unit: item ? (item.unit || '') : '',
    sku: pkg ? (pkg.sku || '') : '',
    size: pkg ? (pkg.size || '') : '',
    packageType: pkg ? (pkg.packageType || '') : '',
    containerCount: line.containerCount == null || line.containerCount === ''
      ? null : Number(line.containerCount),
    qty: Number(line.qty) || 0,
    lineStatus: line.lineStatus || 'Pending',
    position: line.position || '',
    notes: line.notes || '',
  };
}

// Which To/From positions are held, and by what. Both directions occupy the
// same six, because there is one door.
function transitOccupancy(data) {
  const held = {};
  (Array.isArray(data.materialRequests) ? data.materialRequests : []).forEach((r) => {
    (r && Array.isArray(r.lines) ? r.lines : []).forEach((l) => {
      if (l && l.lineStatus === 'Staged' && l.position) {
        held[l.position] = { direction: 'out', reference: r.reference || '', lineId: l.id };
      }
    });
  });
  (Array.isArray(data.materialReturns) ? data.materialReturns : []).forEach((r) => {
    (r && Array.isArray(r.lines) ? r.lines : []).forEach((l) => {
      if (l && l.lineStatus === 'Staged' && l.position) {
        held[l.position] = { direction: 'in', reference: r.reference || '', lineId: l.id };
      }
    });
  });
  return held;
}

function deriveMaterialFlow(mrpData) {
  const data = mrpData && typeof mrpData === 'object' ? mrpData : {};

  // Requests the warehouse can act on. Draft has not been asked for yet.
  const requests = [];
  (Array.isArray(data.materialRequests) ? data.materialRequests : []).forEach((r) => {
    if (!r || typeof r !== 'object') return;
    if (r.status === 'Draft' || r.status === 'Cancelled') return;
    const lines = (Array.isArray(r.lines) ? r.lines : [])
      .filter((l) => l && l.lineStatus !== 'Cancelled' && l.lineStatus !== 'Received')
      .map((l) => {
        const base = lineBase(data, l);
        // Only a line still to be picked needs a suggestion.
        const suggestions = base.lineStatus === 'Pending'
          ? fefoCandidates(data, l.itemType, l.itemId) : [];
        const item = itemOf(data, l.itemType, l.itemId);
        const staged = lotOf(item, l.lotId);
        return {
          ...base,
          originLocation: l.originLocation || '',
          fefoSuggestion: suggestions[0] || null,
          alternatives: suggestions.slice(1, 8),
          stagedLot: staged
            ? { lotId: staged.id, lotNumber: staged.lotNumber || '', expirationDate: staged.expirationDate || '' }
            : null,
          substituted: !!l.substituted,
          substitutionReason: l.substitutionReason || '',
        };
      });
    if (!lines.length) return;
    requests.push({
      requestId: r.id || '',
      reference: r.reference || '',
      requestedFor: r.requestedFor || '',
      requestedBy: r.requestedBy || '',
      requestedDate: r.requestedDate || '',
      neededDate: r.neededDate || '',
      status: r.status,
      notes: r.notes || '',
      lines,
    });
  });

  // Returns coming back, with the flavour the warehouse needs before it walks
  // out to the floor.
  const returns = [];
  (Array.isArray(data.materialReturns) ? data.materialReturns : []).forEach((r) => {
    if (!r || typeof r !== 'object') return;
    if (r.status === 'Draft' || r.status === 'Cancelled') return;
    const lines = (Array.isArray(r.lines) ? r.lines : [])
      .filter((l) => l && l.lineStatus !== 'Cancelled' && l.lineStatus !== 'Accepted')
      .map((l) => {
        const item = itemOf(data, l.itemType, l.itemId);
        const lot = lotOf(item, l.lotId);
        return {
          ...lineBase(data, l),
          lotId: l.lotId || '',
          lotNumber: (lot && lot.lotNumber) || l.lotNumber || '',
          expirationDate: (lot && lot.expirationDate) || '',
          // Where it came from, so a leftover goes straight back. A hint only:
          // the position may legitimately have been filled meanwhile.
          suggestedLocation: l.suggestedLocation || '',
        };
      });
    if (!lines.length) return;
    returns.push({
      returnId: r.id || '',
      reference: r.reference || '',
      returnType: r.returnType || '',
      returnedBy: r.returnedBy || '',
      returnedDate: r.returnedDate || '',
      status: r.status,
      notes: r.notes || '',
      lines,
    });
  });

  // What Operations is holding. Custody, so the warehouse can see it and plan.
  const inProcess = [];
  Object.keys(ITEM_TYPE_COLLECTION).forEach((itemType) => {
    const collection = ITEM_TYPE_COLLECTION[itemType];
    (Array.isArray(data[collection]) ? data[collection] : []).forEach((item) => {
      if (!item || typeof item !== 'object') return;
      (Array.isArray(item.lots) ? item.lots : []).forEach((lot) => {
        if (!lot || !lot.inProcess) return;
        inProcess.push({
          itemType,
          itemId: item.id || '',
          itemName: item.name || '',
          itemSku: item.sku || '',
          unit: item.unit || '',
          lotId: lot.id || '',
          lotNumber: lot.lotNumber || '',
          qty: Number(lot.qty) || 0,
          since: lot.inProcessSince || '',
          expirationDate: lot.expirationDate || '',
        });
      });
    });
  });
  inProcess.sort((a, b) => String(a.since).localeCompare(String(b.since)));

  const occupancy = transitOccupancy(data);
  const free = TRANSIT_POSITIONS.filter((p) => !occupancy[p]);
  const pendingLines = requests.reduce(
    (n, r) => n + r.lines.filter((l) => l.lineStatus === 'Pending').length, 0);

  return {
    requests,
    returns,
    inProcess,
    positions: TRANSIT_POSITIONS.map((p) => ({ position: p, held: occupancy[p] || null })),
    counts: {
      openRequests: requests.length,
      linesToPick: pendingLines,
      openReturns: returns.length,
      inProcess: inProcess.length,
      freePositions: free.length,
      // The door being full is the reason a pick is waiting, so say so plainly
      // rather than leaving the warehouse to infer it.
      doorFull: free.length === 0 && pendingLines > 0,
    },
  };
}

// Actions the warehouse has taken that the MRP has not recorded. The line's own
// status is the authority on what has landed: a request line past Pending has
// been staged, a return line at Accepted has been put away. So nothing needs a
// separate ledger — replaying is refused by the transaction, and reported here
// as already done.
function derivePendingMaterialActions(warehouseState, mrpData) {
  const wh = warehouseState && typeof warehouseState === 'object' ? warehouseState : {};
  const data = mrpData && typeof mrpData === 'object' ? mrpData : {};
  const pallets = Array.isArray(wh.pallets) ? wh.pallets : [];

  const requestLine = (requestId, lineId) => {
    const r = (Array.isArray(data.materialRequests) ? data.materialRequests : [])
      .find((x) => x && x.id === requestId);
    return r ? (Array.isArray(r.lines) ? r.lines : []).find((l) => l && l.id === lineId) : null;
  };
  const returnLine = (returnId, lineId) => {
    const r = (Array.isArray(data.materialReturns) ? data.materialReturns : [])
      .find((x) => x && x.id === returnId);
    return r ? (Array.isArray(r.lines) ? r.lines : []).find((l) => l && l.id === lineId) : null;
  };

  const pending = [], done = [];
  pallets.forEach((p) => {
    if (!p || typeof p !== 'object') return;
    if (p.mrpFlowAction === 'stage' && p.mrpRequestLineId) {
      const line = requestLine(p.mrpRequestId, p.mrpRequestLineId);
      const content = (Array.isArray(p.contents) ? p.contents : [])[0] || {};
      const action = {
        kind: 'stage', palletId: p.palletId || '',
        requestId: p.mrpRequestId || '', lineId: p.mrpRequestLineId || '',
        lotId: p.mrpStagedLotId || '', qty: Number(content.quantityOriginal) || 0,
        position: p.transitLocation || '', originLocation: p.mrpOriginLocation || '',
        substituted: !!p.mrpSubstituted, substitutionReason: p.mrpSubstitutionReason || '',
      };
      if (line && line.lineStatus !== 'Pending') done.push(action); else pending.push(action);
      return;
    }
    if (p.mrpFlowAction === 'accept' && p.mrpReturnLineId) {
      const line = returnLine(p.mrpReturnId, p.mrpReturnLineId);
      const action = {
        kind: 'accept', palletId: p.palletId || '',
        returnId: p.mrpReturnId || '', lineId: p.mrpReturnLineId || '',
        location: p.mrpPutawayLocation || '',
      };
      if (line && line.lineStatus === 'Accepted') done.push(action); else pending.push(action);
    }
  });

  return { pending, applied: done,
    counts: { pending: pending.length, applied: done.length, total: pending.length + done.length } };
}

module.exports = {
  derivePendingMaterialActions,
  ITEM_TYPE_COLLECTION,
  TRANSIT_POSITIONS,
  fefoCandidates,
  transitOccupancy,
  deriveMaterialFlow,
};
