// Pure valuation of stock on hand, and the snapshot row it becomes.
//
// A valuation computed from today's data can only ever answer "what is it
// worth now": lots get consumed, costs get recalculated, and last month's
// figure is unrecoverable the moment the data moves. So the number is written
// down once a day and the history is read from what was written, never
// rebuilt after the fact.
//
// Deliberately a simplified valuation compared with the MRP's own
// `inventoryValuation`, which walks lot genealogy through `lotCost`. That
// walk lives inside the single-file console and is not importable here.
// Rather than half-copy it and let the two drift, this values every lot at
// its own recorded `unitCost` and falls back to the item's standard cost,
// then reports how many lots took the fallback. `basis: "lotUnitCost"` says
// plainly which method produced the figure, so a snapshot can never be
// mistaken for the console's genealogy-traced number.

'use strict';

// Waste is valued but kept out of the total: a heap of spent grounds is not
// working capital in the way the other three are, and folding it in would
// flatter the figure.
const STOCK_CATEGORIES = [
  { key: 'raw', entity: 'rawMaterials' },
  { key: 'intermediate', entity: 'intermediateProducts' },
  { key: 'finished', entity: 'finishedGoods' },
];
const WASTE_CATEGORY = { key: 'waste', entity: 'wasteStreams' };

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function valueCategory(data, entity) {
  let value = 0, lots = 0, estimatedLots = 0;
  const list = Array.isArray(data[entity]) ? data[entity] : [];
  list.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const standard = Number(item.unitCost) || 0;
    (Array.isArray(item.lots) ? item.lots : []).forEach((lot) => {
      if (!lot) return;
      const qty = Number(lot.qty) || 0;
      if (!(qty > 0)) return;              // an empty lot is not stock
      const own = Number(lot.unitCost);
      const known = Number.isFinite(own) && own > 0;
      value += (known ? own : standard) * qty;
      lots += 1;
      if (!known) estimatedLots += 1;
    });
  });
  return { value: round2(value), lots, estimatedLots };
}

function valueInventory(mrpData) {
  const data = mrpData && typeof mrpData === 'object' ? mrpData : {};
  const byKey = {};
  STOCK_CATEGORIES.forEach((c) => { byKey[c.key] = valueCategory(data, c.entity); });
  byKey[WASTE_CATEGORY.key] = valueCategory(data, WASTE_CATEGORY.entity);

  const stock = STOCK_CATEGORIES.map((c) => byKey[c.key]);
  return {
    byKey,
    total: round2(stock.reduce((n, c) => n + c.value, 0)),
    totalLots: stock.reduce((n, c) => n + c.lots, 0),
    estimatedLots: stock.reduce((n, c) => n + c.estimatedLots, 0),
    basis: 'lotUnitCost',
  };
}

// The row a capture writes. Shaped to match the MRP's `inventorySnapshots`
// entity exactly, because the MRP reads these back and a mismatched key would
// simply come through as a blank column.
function snapshotRow(mrpData, { date, source, notes, capturedAt }) {
  const v = valueInventory(mrpData);
  return {
    date: String(date || '').slice(0, 10),
    capturedAt: capturedAt || new Date().toISOString(),
    source: source || 'cron',
    rawValue: v.byKey.raw.value,
    intermediateValue: v.byKey.intermediate.value,
    finishedValue: v.byKey.finished.value,
    wasteValue: v.byKey.waste.value,
    totalValue: v.total,
    rawLots: v.byKey.raw.lots,
    intermediateLots: v.byKey.intermediate.lots,
    finishedLots: v.byKey.finished.lots,
    estimatedLots: v.estimatedLots,
    notes: notes || '',
  };
}

/* Put the row into the state, replacing any row already holding that date.
   Keyed on the date rather than appended, so a cron retry, an overlapping run
   or somebody pressing the button after the job has fired cannot double-count
   a day. Returns the new list plus whether it replaced, so the caller can say
   which happened rather than guessing. */
function upsertSnapshot(existing, row) {
  const list = Array.isArray(existing) ? existing.slice() : [];
  const at = list.findIndex((r) => r && r.date === row.date);
  if (at >= 0) {
    list[at] = { ...list[at], ...row };
    return { list, replaced: true };
  }
  list.push({ id: 'snap-' + row.date, ...row });
  return { list, replaced: false };
}

module.exports = {
  STOCK_CATEGORIES,
  WASTE_CATEGORY,
  valueCategory,
  valueInventory,
  snapshotRow,
  upsertSnapshot,
};
