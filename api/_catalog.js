// Pure derivation of the shared inventory catalog from MRP data.
//
// The warehouse needs to know what storable SKUs exist and what physical stock
// is on hand. Rather than have it parse the MRP's internal shape, this module
// derives a stable contract the warehouse consumes; /api/catalog serves it.
// Keeping the derivation here (no database, no fetch) means it is unit-testable
// in node with nothing installed — see api/test/catalog.test.js.
//
// Contract:
//   skus[] — one row per packaging variant, i.e. per storable SKU. "SSB 1 gal"
//            and "SSB 2.5 gal" are two rows, which is how the warehouse counts.
//   lots[] — one row per physical lot, joined to its sku and aged against a
//            reference date.
// Both carry `physicallyStored` and `qty` so the consumer can filter; nothing is
// silently dropped.

'use strict';

// Which MRP collection maps to which itemType tag (the MRP's own vocabulary).
const ITEM_TYPES = [
  ['rawMaterials', 'raw'],
  ['intermediateProducts', 'intermediate'],
  ['finishedGoods', 'finished'],
  ['wasteStreams', 'waste'],
];

// Lots inside this window are flagged as approaching expiry.
const EXPIRING_SOON_DAYS = 90;

function parseDate(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  return isNaN(d.getTime()) ? null : d;
}

// Calendar month difference, truncated toward zero-crossing the way a person
// reads it: 2026-03-01 from 2026-01-15 is 1 month, not 1.5.
function monthsBetween(from, to) {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12
    + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / 86400000);
}

// Status of a lot relative to `ref`. Mirrors what the warehouse shows today:
// expired stock is called out, and stock about to expire is worth seeing before
// it does.
function expiryStatus(expirationDate, ref) {
  const exp = parseDate(expirationDate);
  if (!exp) return { status: 'unknown', monthsUntilExpiration: null, daysUntilExpiration: null };
  const days = daysBetween(ref, exp);
  const months = monthsBetween(ref, exp);
  const status = days < 0 ? 'expired' : (days <= EXPIRING_SOON_DAYS ? 'expiring' : 'ok');
  return { status, monthsUntilExpiration: months, daysUntilExpiration: days };
}

// Build the catalog from an MRP data object (the parsed mrp_console_data).
// `refDate` is injected so the result is deterministic and testable.
function deriveCatalog(mrpData, refDate) {
  const ref = (refDate instanceof Date && !isNaN(refDate.getTime()))
    ? new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate()))
    : new Date(Date.UTC(1970, 0, 1));
  const skus = [];
  const lots = [];
  const data = mrpData && typeof mrpData === 'object' ? mrpData : {};

  ITEM_TYPES.forEach(([collection, itemType]) => {
    const items = Array.isArray(data[collection]) ? data[collection] : [];
    items.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      const packagings = Array.isArray(item.packagings) ? item.packagings : [];
      const base = {
        itemId: item.id || '',
        itemType,
        itemName: item.name || '',
        itemSku: item.sku || '',
        unit: item.unit || '',
        hazardClass: item.hazardClass || '',
        shelfLifeDays: item.shelfLifeDays == null ? null : Number(item.shelfLifeDays),
        physicallyStored: item.physicallyStored !== false,
      };

      packagings.forEach((p) => {
        if (!p || typeof p !== 'object') return;
        skus.push({
          ...base,
          skuId: p.id || '',
          sku: p.sku || '',
          packageType: p.packageType || '',
          size: p.size || '',
          unitsPerPackage: p.unitsPerPackage == null ? null : Number(p.unitsPerPackage),
          packagesPerSlot: p.packagesPerSlot == null ? null : Number(p.packagesPerSlot),
          isDefault: !!p.isDefault,
        });
      });

      const byId = {};
      packagings.forEach((p) => { if (p && p.id) byId[p.id] = p; });
      const fallback = packagings.find((p) => p && p.isDefault) || packagings[0] || null;

      (Array.isArray(item.lots) ? item.lots : []).forEach((lot) => {
        if (!lot || typeof lot !== 'object') return;
        const pkg = (lot.packagingId && byId[lot.packagingId]) || fallback;
        lots.push({
          ...base,
          lotId: lot.id || '',
          lotNumber: lot.lotNumber || '',
          skuId: pkg ? (pkg.id || '') : '',
          sku: pkg ? (pkg.sku || '') : '',
          packageType: pkg ? (pkg.packageType || '') : '',
          size: pkg ? (pkg.size || '') : '',
          packagesPerSlot: pkg && pkg.packagesPerSlot != null ? Number(pkg.packagesPerSlot) : null,
          qty: Number(lot.qty) || 0,
          producedQty: Number(lot.producedQty) || 0,
          containerCount: lot.containerCount === '' || lot.containerCount == null ? null : Number(lot.containerCount),
          productionDate: lot.productionDate || '',
          arrivalDate: lot.arrivalDate || '',
          expirationDate: lot.expirationDate || '',
          // `date` is the MRP's original ambiguous field, kept for reference.
          recordedDate: lot.date || '',
          origin: lot.origin || '',
          mfg: lot.mfg || '',
          orderRef: lot.orderRef || '',
          ...expiryStatus(lot.expirationDate, ref),
        });
      });
    });
  });

  const inStock = lots.filter((l) => l.qty > 0);
  return {
    skus,
    lots,
    counts: {
      skus: skus.length,
      lots: lots.length,
      lotsInStock: inStock.length,
      expired: inStock.filter((l) => l.status === 'expired').length,
      expiring: inStock.filter((l) => l.status === 'expiring').length,
      uncataloged: countUncataloged(data),
    },
  };
}

// Items with no packaging defined cannot be slotted — the warehouse surfaces
// this so the gap is visible rather than silently absent from the catalog.
function countUncataloged(data) {
  let n = 0;
  ITEM_TYPES.forEach(([collection]) => {
    const items = Array.isArray(data[collection]) ? data[collection] : [];
    items.forEach((item) => {
      if (!item || typeof item !== 'object') return;
      if (item.physicallyStored === false) return;
      if (!Array.isArray(item.packagings) || item.packagings.length === 0) n += 1;
    });
  });
  return n;
}

// The MRP stores its whole dataset as a JSON string under this key in the
// module's key/value blob (see mrp/index.html's window.storage shim).
const MRP_DATA_KEY = 'mrp_console_data';

function extractMrpData(moduleState) {
  if (!moduleState || typeof moduleState !== 'object') return null;
  const raw = moduleState[MRP_DATA_KEY];
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

module.exports = {
  ITEM_TYPES,
  EXPIRING_SOON_DAYS,
  MRP_DATA_KEY,
  monthsBetween,
  expiryStatus,
  deriveCatalog,
  extractMrpData,
};
