import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Boxes, Package, Layers, Factory, Calendar, TrendingUp,
  Plus, Trash2, Pencil, X, Search,
  AlertTriangle, ShoppingCart, LayoutDashboard, Wrench, Activity,
  Users, RefreshCw, DollarSign, Truck, Beaker, Recycle,
  ChevronDown, ChevronRight, Download, Upload, ClipboardList
} from "lucide-react";

/* ---------------------------------------------------------------
   Utilities
----------------------------------------------------------------*/
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ---------------------------------------------------------------
   Lot attachments (scanned paper forms, etc.) - window.storage only
   accepts text/JSON and caps each key at 5MB, and the entire rest of
   this app's data already lives under one storage key. So a file's
   base64 content is never embedded in a lot or in the main data blob
   at all - it gets its own dedicated key, and the lot just carries a
   lightweight { key, fileName, fileType, fileSize } reference to it.
----------------------------------------------------------------*/
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // leaves headroom under the 5MB/key limit after base64 inflation

async function uploadAttachment(file) {
  if (!file) throw new Error("No file selected.");
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error("File is " + Math.round(file.size / 1024 / 1024 * 10) / 10 + "MB — attachments are limited to " + Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024) + "MB. Rescan at a lower resolution or compress the file and try again.");
  }
  if (typeof window === "undefined" || !window.storage || typeof window.storage.set !== "function") {
    throw new Error("Attachment storage isn't available right now.");
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsDataURL(file);
  });
  const key = "lot_attachment:" + uid();
  const result = await window.storage.set(key, dataUrl, false);
  if (!result) throw new Error("Upload failed — storage did not confirm the save.");
  return { key, fileName: file.name, fileType: file.type, fileSize: file.size };
}

async function openAttachment(attachment) {
  if (!attachment || !attachment.key) return;
  if (typeof window === "undefined" || !window.storage || typeof window.storage.get !== "function") {
    alert("Attachment storage isn't available right now.");
    return;
  }
  try {
    const res = await window.storage.get(attachment.key, false);
    if (!res || !res.value) { alert("Could not find this attachment — it may have been removed."); return; }
    const link = document.createElement("a");
    link.href = res.value;
    link.download = attachment.fileName || "attachment";
    link.target = "_blank";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (err) {
    alert("Could not load this attachment.");
  }
}

const todayStr = () => new Date().toISOString().slice(0, 10);
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysUntil = (dateStr) => {
  const a = new Date(todayStr() + "T00:00:00");
  const b = new Date(dateStr + "T00:00:00");
  return Math.round((b - a) / 86400000);
};
const daysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
// 5-digit Julian-style date code: 2-digit year + 3-digit day-of-year (Jan 1 = 001).
const julianDateCode = (dateStr) => {
  const d = new Date(dateStr + "T00:00:00");
  const year = d.getFullYear() % 100;
  const startOfYear = new Date(d.getFullYear(), 0, 0);
  const dayOfYear = Math.round((d - startOfYear) / 86400000);
  return String(year).padStart(2, "0") + String(dayOfYear).padStart(3, "0");
};
const fmtDate = (dateStr) => {
  if (!dateStr) return "—";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};
const fmtMoney = (n) => "$" + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const lotQty = (lots) => (lots || []).reduce((s, l) => s + (Number(l.qty) || 0), 0);
const sumHours = (list) => (list || []).reduce((s, x) => s + (Number(x.hours) || 0), 0);

const CERT_OPTIONS = ["Certified", "Pending review", "Not required", "Expired"];
const STATUS_OPTIONS = ["Planned", "In progress", "Complete", "Cancelled"];
const EQUIPMENT_STATUS_OPTIONS = ["In-Use", "Blocked"];
const MAINTENANCE_STATUS_OPTIONS = ["Scheduled", "Paused", "Cancelled"];
const MAINTENANCE_TYPES = ["Preventative maintenance", "Cleaning", "Calibration", "Other"];
const MAINTENANCE_RECURRENCE_OPTIONS = ["None", "Daily", "Weekly", "Monthly", "Quarterly", "Semi-annual", "Annual"];
const HAZARD_CLASS_OPTIONS = [
  "N/A",
  "Class 1 - Explosives",
  "Class 2.1 - Flammable Gas",
  "Class 2.2 - Non-Flammable Gas",
  "Class 2.3 - Poison Gas",
  "Class 3 - Flammable Liquid",
  "Class 4.1 - Flammable Solid",
  "Class 4.2 - Spontaneously Combustible",
  "Class 4.3 - Dangerous When Wet",
  "Class 5.1 - Oxidizer",
  "Class 5.2 - Organic Peroxide",
  "Class 6.1 - Poison (Toxic)",
  "Class 6.2 - Infectious Substance",
  "Class 7 - Radioactive",
  "Class 8 - Corrosive",
  "Class 9 - Miscellaneous Hazardous Material"
];

/* ---------------------------------------------------------------
   Composition helpers - flat, component-based breakdowns
   ({ id, componentId, percentage, costWeight }) usable on any
   catalog item. `percentage` is the physical/volumetric share of
   the whole; `costWeight` is an independent share of the item's
   cost, since a cheap diluent can be a large physical share but
   contribute little or nothing to cost. Not recursive and not
   wired into the MRP netting engine - a parallel, informational
   cost/allocation basis.
----------------------------------------------------------------*/
function compositionTotalPct(composition) {
  return (composition || []).reduce((s, c) => s + (Number(c.percentage) || 0), 0);
}

function compositionCostWeightTotal(composition) {
  return (composition || []).reduce((s, c) => s + (Number(effectiveCostWeight(c)) || 0), 0);
}

// Falls back to the physical percentage for composition lines saved
// before cost weighting existed, so old data keeps behaving the way it
// always did until someone explicitly sets a cost weight.
function effectiveCostWeight(c) {
  return (c.costWeight !== undefined && c.costWeight !== null && c.costWeight !== "") ? c.costWeight : c.percentage;
}

// At most one line can have percentageBalance set, and independently at
// most one (possibly the same) line can have costWeightBalance set. Each
// flagged line's value is recomputed from scratch as 100% minus every
// other line's current value for that same field, so it stays correct as
// siblings change - never a stale snapshot. The two fields are balanced
// independently since a component can be a large physical share while
// carrying none of the cost, or vice versa.
function recomputeCompositionBalance(composition) {
  let result = composition;
  const physLine = result.find(c => c.percentageBalance);
  if (physLine) {
    const sum = result.filter(c => c.id !== physLine.id).reduce((s, c) => s + (Number(c.percentage) || 0), 0);
    result = result.map(c => c.id === physLine.id ? { ...c, percentage: Math.round((100 - sum) * 100) / 100 } : c);
  }
  const costLine = result.find(c => c.costWeightBalance);
  if (costLine) {
    const sum = result.filter(c => c.id !== costLine.id).reduce((s, c) => s + (Number(effectiveCostWeight(c)) || 0), 0);
    result = result.map(c => c.id === costLine.id ? { ...c, costWeight: Math.round((100 - sum) * 100) / 100 } : c);
  }
  return result;
}

// Cost allocation (Cost %, separate from Physical %) is only supported on
// raw materials. On intermediate products and finished goods it created
// real conflicts: those items can also get their composition rolled up
// automatically from a process recipe, which weights each input by its
// own dollar contribution to the batch - a second, independent notion of
// "cost share" that doesn't have to reconcile with a manually-typed
// Cost % on the same item. Stripping costWeight here (and clearing any
// cost-balance flag) forces Cost % to always mirror Physical % for these
// two types, so there's only one cost-allocation concept in play, ever.
function stripCostAllocation(composition) {
  return (composition || []).map(c => ({ ...c, costWeight: null, costWeightBalance: false }));
}

function computeCompositionCost(data, composition) {
  return (composition || []).reduce((sum, c) => {
    return sum + (componentUnitCost(data, getComponent(data, c.componentId)) * ((Number(effectiveCostWeight(c)) || 0) / 100));
  }, 0);
}

// The composition actually used anywhere composition is consulted. For a
// raw material, or for an intermediate/finished item with auto-calculate
// off, that's just whatever was entered by hand. With auto-calculate on,
// it's derived from the producing process's recipe instead: each input
// line's own effective composition, weighted by that line's *cost*
// contribution (qty x that input's own resolved unit cost) rather than
// raw quantity, since a recipe mixes incompatible units (frames, cells,
// meters of tube) that have no meaningful shared "% by volume" - cost is
// the one common denominator every input already has. `path` guards
// against a genuine circular recipe without penalizing an input that's
// reused in multiple branches.
function computeEffectiveComposition(data, itemType, itemId, path) {
  path = path || new Set();
  if (itemType === "raw") {
    const raw = getRaw(data, itemId);
    return raw ? (raw.composition || []) : [];
  }
  const key = itemType + ":" + itemId;
  if (path.has(key)) return [];
  const nextPath = new Set(path);
  nextPath.add(key);

  const item = getCatalogItem(data, itemType, itemId);
  if (!item) return [];
  if (!item.autoComposition) return item.composition || [];

  const process = findProcessForOutput(data, itemType, itemId);
  if (!process) return [];

  const totals = {};
  let totalCost = 0;
  (process.inputs || []).forEach(line => {
    const lineCost = computeItemUnitCost(data, line.itemType, line.itemId) * (Number(line.qty) || 0);
    if (lineCost <= 0) return;
    totalCost += lineCost;
    computeEffectiveComposition(data, line.itemType, line.itemId, nextPath).forEach(c => {
      if (!totals[c.componentId]) totals[c.componentId] = { pct: 0, cw: 0 };
      totals[c.componentId].pct += ((Number(c.percentage) || 0) / 100) * lineCost;
      totals[c.componentId].cw += ((Number(effectiveCostWeight(c)) || 0) / 100) * lineCost;
    });
  });
  if (totalCost === 0) return [];
  return Object.entries(totals).map(([componentId, t]) => ({
    id: componentId,
    componentId,
    percentage: Math.round((t.pct / totalCost) * 10000) / 100,
    costWeight: Math.round((t.cw / totalCost) * 10000) / 100
  }));
}

// How much of each fundamental component is represented in an item's
// current on-hand stock (by physical percentage), and how much of the
// stock's total value is attributed to it (by cost weight).
function computeCompositionBalances(item, itemType, data) {
  const totalStock = lotQty(item.lots);
  const totalValue = totalStock * computeItemUnitCost(data, itemType, item.id);
  const composition = computeEffectiveComposition(data, itemType, item.id);
  return (composition || []).map(c => {
    const comp = getComponent(data, c.componentId);
    if (!comp) return null;
    return {
      component: comp,
      qty: totalStock * ((Number(c.percentage) || 0) / 100),
      value: totalValue * ((Number(effectiveCostWeight(c)) || 0) / 100)
    };
  }).filter(Boolean);
}

// Per-batch mass balance: everything consumed must show up either in what
// was produced or as waste. For each component, sums (consumed qty x that
// item's effective composition %) across everything consumed, does the
// same for everything actually produced this batch, and whatever's left
// on the input side that isn't accounted for on the output side is waste.
// Negative balances (more out than in - composition rounding, etc.) are
// clamped to zero rather than reported as "negative waste".
function computeBatchComponentWaste(data, consumed, produced) {
  const sumByComponent = (list) => {
    const totals = {};
    (list || []).forEach(({ itemType, itemId, qty }) => {
      const q = Number(qty) || 0;
      if (q <= 0) return;
      computeEffectiveComposition(data, itemType, itemId).forEach(c => {
        totals[c.componentId] = (totals[c.componentId] || 0) + q * ((Number(c.percentage) || 0) / 100);
      });
    });
    return totals;
  };
  const inTotals = sumByComponent(consumed);
  const outTotals = sumByComponent(produced);
  const ids = new Set([...Object.keys(inTotals), ...Object.keys(outTotals)]);
  return [...ids].map(componentId => ({
    componentId,
    inQty: inTotals[componentId] || 0,
    outQty: outTotals[componentId] || 0,
    wasteQty: Math.max(0, (inTotals[componentId] || 0) - (outTotals[componentId] || 0))
  })).filter(w => w.wasteQty > 0.0001);
}

/* ---------------------------------------------------------------
   QC calibration - a per-component linear formula (concentration%
   = slope x measuredValue + intercept) letting a quick bench
   measurement (refractive index, Brix, conductivity, whatever
   correlates) stand in for a direct concentration reading. Lives on
   the Component since the correlation is a property of the
   substance, not any one item. Purely a per-lot QC record - not fed
   back into the structural Composition used for cost/waste.
----------------------------------------------------------------*/
function computeQcConcentration(component, measuredValue) {
  const cal = (component && component.qcCalibration) || {};
  const slope = Number(cal.slope) || 0;
  const intercept = Number(cal.intercept) || 0;
  return Math.round((slope * (Number(measuredValue) || 0) + intercept) * 100) / 100;
}

// The components worth offering a QC check against for a given lot -
// whatever that item's (effective) composition already references.
function qcComponentCandidates(data, composition) {
  return (composition || []).map(c => getComponent(data, c.componentId)).filter(Boolean);
}

// A component in "balance" mode isn't measured at all - its concentration
// is just whatever's left after everything else on the same lot adds up
// to 100%. Recomputed from scratch every time any sibling check changes,
// so it never goes stale. Only one component per lot can be "balance" at
// once (a second would be circular); callers are responsible for clearing
// any other balance flag before calling this.
function recomputeBalanceEntry(checks) {
  const balanceEntry = checks.find(q => q.mode === "balance");
  if (!balanceEntry) return checks;
  const sum = checks.filter(q => q.componentId !== balanceEntry.componentId).reduce((s, q) => s + (Number(q.concentration) || 0), 0);
  const balanced = Math.round((100 - sum) * 100) / 100;
  return checks.map(q => q.componentId === balanceEntry.componentId ? { ...q, concentration: balanced } : q);
}

// Uses a public QR-image service the same way the app already pulls its
// fonts from Google - needs network access at render/print time to
// actually load, not something bundled in the file.
function qrCodeUrl(text) {
  return "https://api.qrserver.com/v1/create-qr-code/?size=200x200&margin=0&data=" + encodeURIComponent(text);
}

// What goes on a label's composition line: the item's standard
// composition, except any component that was actually QC-checked on
// this specific lot (manual, calculated, or balance - never a
// leftover, unconfirmed "estimated" one) uses that real reading
// instead, since it's more accurate than the theoretical recipe value.
function labelComposition(data, itemType, itemId, qcChecks) {
  const standard = computeEffectiveComposition(data, itemType, itemId);
  return standard.map(c => {
    const comp = getComponent(data, c.componentId);
    if (!comp) return null;
    const check = (qcChecks || []).find(q => q.componentId === c.componentId && q.mode !== "estimated");
    const pct = check ? check.concentration : c.percentage;
    return { name: comp.name, percentage: pct };
  }).filter(Boolean);
}


/* ===============================================================
   DATA LAYER

   Everything that reads or writes persisted records goes through
   this section. Nothing below it should touch `data.<collection>`
   or `d.<collection>` directly.

   The intent is extraction: each SCHEMA entry is a future SQL
   table, each `children` entry is a future child table with a FK
   back to its parent, and each `refs` entry is a future foreign
   key. `repo.*` calls are the future DAO methods and `tx.*` calls
   are the future SQL transactions. Swapping the in-memory object
   for a real database should mean reimplementing this section
   only - no call site above or below it needs to change.
=============================================================== */

/* Column types, written as a compact string so the whole schema stays
   readable at a glance:
     str            free text
     num            number  - CSV import must coerce, CSV is all text
     bool           true/false
     date           ISO yyyy-mm-dd
     ref:<entity>   foreign key into another table
     enum:a|b|c     constrained value
   A trailing "!" marks the column as required on import.

   `pk` is the primary key. `naturalKey` is the human-meaningful column
   that a spreadsheet will actually carry - historical data arrives with
   SKUs and equipment codes, never with generated ids - so import
   resolves references through the natural key and mints ids itself.
   `embeds` are 1:1 sub-objects, flattened to prefixed CSV columns
   (qcCalibration.slope -> qcCalibration_slope) rather than their own file. */

/* Lots are polymorphic in this model and always have been: the code
   addresses them as (itemType, itemId) everywhere, and a lot's own
   `sources[].groupKey` is literally "raw:<id>". So lots are ONE table
   with an owner discriminator, not four parallel ones - otherwise the
   four sub-tables below would each need to exist four times over, and
   lot_sources.lotId could not be a real foreign key. Composition is
   polymorphic for the same reason. */
const LOT_CHILDREN = {
  sources: {
    // `lotId` here is the SOURCE lot that was drawn down, so the FK back
    // to the lot that consumed it needs a distinct name.
    table: "lot_sources", fk: "parentLotId", pk: "id",
    columns: { id: "str", groupKey: "str!", lotId: "str!", qty: "num" },
    packedRefs: { groupKey: { typeColumn: "sourceType", keyColumn: "sourceKey" } },
    lotRefs: { lotId: { companion: "sourceLotNumber" } }
  },
  actualEquipment: {
    table: "lot_actual_equipment", fk: "lotId", pk: "id",
    columns: { id: "str", equipmentId: "ref:equipment!", hours: "num" }
  },
  actualLabor: {
    table: "lot_actual_labor", fk: "lotId", pk: "id",
    columns: { id: "str", operatorName: "str", hours: "num" }
  },
  qcChecks: {
    table: "lot_qc_checks", fk: "lotId", pk: "id",
    columns: {
      id: "str", componentId: "ref:components!",
      mode: "enum:calculated|manual|estimated|balance",
      measuredValue: "num", concentration: "num"
    }
  }
};

const LOT_EMBEDS = {
  attachment: { columns: { key: "str", fileName: "str", fileType: "str", fileSize: "num" } },
  disposition: {
    columns: {
      reason: "str", disposeImmediately: "bool", accumulateAsWaste: "bool",
      note: "str", date: "date"
    }
  }
};

/* Owner discriminator shared by the polymorphic child tables (lots,
   composition and packagings). The type values are exactly the itemType
   tags already used throughout. */
const OWNER = {
  typeColumn: "ownerType",
  idColumn: "ownerId",
  types: {
    raw: "rawMaterials", intermediate: "intermediateProducts",
    finished: "finishedGoods", waste: "wasteStreams"
  }
};

const LOTS_TABLE = {
  table: "lots", pk: "id", naturalKey: "lotNumber", polymorphic: OWNER,
  columns: {
    id: "str", lotNumber: "str!", date: "date", qty: "num", notes: "str",
    usedDate: "date", consumedDate: "date",
    // What this lot actually cost, per unit. On a purchased lot it is the
    // price paid for that delivery; on a produced lot it is rolled up from
    // the lots that fed it. Held on the lot so a later supplier increase
    // cannot retroactively reprice stock that was already bought.
    unitCost: "num",
    // qty is what REMAINS. Unit cost needs what was MADE, so the produced
    // quantity is recorded once and never drawn down.
    producedQty: "num",
    // Which run of which process created this lot. Both blank on a
    // purchased lot.
    batchId: "str", processId: "ref:processes",
    // Warehouse cataloging (Phase 3) — all optional and additive; the existing
    // `date` is retained. expirationDate is computed from productionDate + the
    // owning item's shelfLifeDays but stays editable. packagingId points at one
    // of that item's packagings by id (a local id, not a cross-entity ref).
    packagingId: "str", expirationDate: "date",
    productionDate: "date", arrivalDate: "date",
    origin: "str", mfg: "str", orderRef: "str", containerCount: "num"
  },
  embeds: LOT_EMBEDS,
  children: LOT_CHILDREN
};

/* Packaging variants for a catalog item. Each is a distinct storable SKU — the
   warehouse treats "SSB 1 gal" and "SSB 2.5 gal" as different stock units — with
   its own footprint. Shares the OWNER discriminator with lots and composition,
   so it is one table addressed by all four catalog entities. A lot records which
   packaging it is via lot.packagingId. */
const PACKAGINGS_TABLE = {
  table: "packagings", pk: "id", naturalKey: "sku", polymorphic: OWNER,
  columns: {
    id: "str", sku: "str!", packageType: "str!", size: "str!",
    unitsPerPackage: "num", packagesPerSlot: "num", isDefault: "bool"
  }
};

const COMPOSITION_TABLE = {
  table: "composition", pk: "id", polymorphic: OWNER,
  columns: { id: "str", componentId: "ref:components!", percentage: "num", costWeight: "num" }
};

const SCHEMA = {
  components: {
    table: "components",
    label: "Component",
    pk: "id",
    naturalKey: "name",
    columns: {
      id: "str", name: "str!", unit: "str", rawMaterialId: "ref:rawMaterials", notes: "str"
    },
    embeds: {
      qcCalibration: {
        columns: {
          enabled: "bool", measurementLabel: "str", measurementUnit: "str",
          slope: "num", intercept: "num"
        }
      }
    },
    children: {}
  },

  rawMaterials: {
    table: "raw_materials",
    label: "Raw material",
    pk: "id",
    naturalKey: "sku",
    columns: {
      id: "str", name: "str!", sku: "str!", supplier: "str", unitCost: "num", unit: "str",
      certStatus: "str", leadTimeDays: "num", moq: "num", reorderPoint: "num",
      onOrder: "num", notes: "str",
      // Physical cataloging (warehouse). hazardClass added for parity with the
      // other catalog entities; shelfLifeDays drives computed lot expiry;
      // physicallyStored flags items that actually occupy a warehouse slot.
      hazardClass: "str", shelfLifeDays: "num", physicallyStored: "bool"
    },
    embeds: {},
    children: {
      lots: LOTS_TABLE,
      composition: COMPOSITION_TABLE,
      packagings: PACKAGINGS_TABLE
    }
  },

  intermediateProducts: {
    table: "intermediate_products",
    label: "Intermediate product",
    pk: "id",
    naturalKey: "sku",
    columns: {
      id: "str", name: "str!", sku: "str!", unit: "str", notes: "str",
      autoComposition: "bool", hazardClass: "str",
      shelfLifeDays: "num", physicallyStored: "bool"
    },
    embeds: {},
    children: {
      lots: LOTS_TABLE,
      composition: COMPOSITION_TABLE,
      packagings: PACKAGINGS_TABLE
    }
  },

  finishedGoods: {
    table: "finished_goods",
    label: "Finished good",
    pk: "id",
    naturalKey: "sku",
    columns: {
      id: "str", name: "str!", sku: "str!", unit: "str", notes: "str",
      autoComposition: "bool", hazardClass: "str",
      shelfLifeDays: "num", physicallyStored: "bool"
    },
    embeds: {},
    children: {
      lots: LOTS_TABLE,
      composition: COMPOSITION_TABLE,
      packagings: PACKAGINGS_TABLE
    }
  },

  processes: {
    table: "processes",
    label: "Process",
    pk: "id",
    naturalKey: "sku",
    columns: {
      id: "str", name: "str!", sku: "str", productionTimeHours: "num", notes: "str"
    },
    embeds: {},
    children: {
      inputs: {
        table: "process_inputs", fk: "processId", pk: "id",
        columns: {
          id: "str", itemType: "enum:raw|intermediate|finished!",
          itemId: "str!", qty: "num"
        },
        polyRefs: { itemId: { typeColumn: "itemType", companion: "itemKey" } }
      },
      equipment: {
        table: "process_equipment", fk: "processId", pk: "id",
        columns: { id: "str", equipmentId: "ref:equipment!", status: "str" }
      },
      outputs: {
        table: "process_outputs", fk: "processId", pk: "id",
        columns: {
          id: "str", itemType: "enum:intermediate|finished!", itemId: "str!",
          qtyPerBatch: "num", costOverride: "num"
        },
        polyRefs: { itemId: { typeColumn: "itemType", companion: "itemKey" } }
      }
    }
  },

  equipment: {
    table: "equipment",
    label: "Equipment",
    pk: "id",
    naturalKey: "code",
    columns: {
      id: "str", name: "str!", code: "str!", units: "num", notes: "str",
      calendarId: "ref:operatingCalendars"
    },
    embeds: {},
    children: {}
  },

  maintenance: {
    table: "maintenance",
    label: "Maintenance",
    pk: "id",
    columns: {
      id: "str", equipmentId: "ref:equipment!", title: "str", type: "str",
      startDate: "date", durationHours: "num", recurrence: "str",
      recurUntil: "date", status: "str", notes: "str"
    },
    embeds: {},
    children: {}
  },

  customers: {
    table: "customers",
    label: "Customer",
    pk: "id",
    naturalKey: "code",
    columns: { id: "str", name: "str!", code: "str!", notes: "str" },
    embeds: {},
    children: {
      addresses: {
        table: "customer_addresses", fk: "customerId", pk: "id",
        columns: {
          id: "str", label: "str", line1: "str", line2: "str", city: "str",
          region: "str", postalCode: "str", country: "str"
        }
      },
      priceList: {
        table: "customer_price_list", fk: "customerId", pk: "id",
        columns: { id: "str", finishedGoodId: "ref:finishedGoods!", basePrice: "num" },
        children: {
          tiers: {
            table: "customer_price_tiers", fk: "priceListId", pk: "id",
            columns: { id: "str", minQty: "num", price: "num" },
            // A price-list row has no natural key of its own, so a tier
            // identifies its parent by customer + finished good instead.
            parentLocator: {
              rootEntity: "customers", rootCompanion: "customerCode",
              childKey: "priceList", matchColumn: "finishedGoodId",
              matchEntity: "finishedGoods", matchCompanion: "finishedGoodSku"
            }
          }
        }
      }
    }
  },

  schedule: {
    table: "production_schedule",
    label: "Production run",
    pk: "id",
    columns: {
      id: "str", productType: "enum:intermediate|finished!", productId: "str!",
      qty: "num", dueDate: "date", status: "str", notes: "str",
      customerId: "ref:customers", completedDate: "date", createdDate: "date",
      // Baseline: what was committed to at the moment of freezing. Written
      // once and never moved again, which is the whole point - a plan you can
      // edit after the fact is a plan you cannot measure against.
      frozen: "bool", frozenDate: "date",
      baselineQty: "num", baselineDueDate: "date",
      // Standard cost captured the day the run was fulfilled. Expected-versus-
      // actual is only meaningful if the expected side stops moving; without
      // this, a supplier price rise silently rewrites last quarter's variance.
      standardCostAtFulfillment: "num"
    },
    polyRefs: { productId: { typeColumn: "productType", companion: "productKey" } },
    embeds: {},
    /* Refuses any change to a committed figure on a frozen run. The only way
       past this is tx.amendFrozenRun, which records the reason first - so the
       audit trail is structural rather than a matter of remembering to log. */
    guard: (existing, next) => {
      if (!existing || !existing.frozen) return null;
      const locked = ["qty", "dueDate", "productId", "productType"];
      const val = (o, k) => String(o[k] === undefined || o[k] === null ? "" : o[k]);
      const changed = locked.filter(k => val(next, k) !== val(existing, k));
      if (!changed.length) return null;
      return "This run is frozen. Changing " + changed.join(", ") +
        " has to go through a recorded amendment.";
    },
    children: {
      fulfillmentLots: {
        table: "schedule_fulfillment_lots", fk: "scheduleId", pk: "id",
        columns: { id: "str", lotId: "str!", qty: "num" },
        lotRefs: { lotId: { companion: "lotNumber" } }
      },
      // Append-only. Nothing in the app edits or deletes a revision.
      revisions: {
        table: "schedule_revisions", fk: "scheduleId", pk: "id",
        columns: {
          id: "str", at: "date!", field: "str!", fromValue: "str", toValue: "str",
          reason: "str!", author: "str"
        }
      }
    }
  },

  purchaseOrders: {
    table: "purchase_orders",
    label: "Purchase order",
    pk: "id",
    naturalKey: "reference",
    columns: {
      id: "str", reference: "str!", rawMaterialId: "ref:rawMaterials!",
      supplier: "str", orderDate: "date!", qty: "num!", unitCost: "num",
      expectedDate: "date!",
      status: "enum:Draft|Ordered|Part received|Received|Cancelled!",
      notes: "str",
      // What was ordered physically: which container/size, and how many of
      // them. `qty` stays the authoritative figure in the material's own unit
      // so nothing downstream has to convert; containerCount is what the
      // warehouse counts off the truck. Both optional so orders predating this
      // keep working.
      packagingId: "str", containerCount: "num"
    },
    embeds: {},
    children: {
      // Deliveries land in instalments more often than not, so receipts are
      // their own rows rather than a single date on the order. Each one
      // points at the stock lot it created.
      receipts: {
        table: "purchase_receipts", fk: "purchaseOrderId", pk: "id",
        columns: { id: "str", date: "date!", qty: "num!", lotId: "str", notes: "str" },
        lotRefs: { lotId: { companion: "lotNumber" } }
      }
    }
  },

  salesOrders: {
    table: "sales_orders",
    label: "Sales order",
    pk: "id",
    naturalKey: "reference",
    columns: {
      id: "str", reference: "str!", customerId: "ref:customers!", addressId: "str",
      salesRep: "str", orderDate: "date!", requestedDate: "date",
      status: "enum:Draft|Submitted|Reviewed|Released|Cancelled!",
      notes: "str"
    },
    embeds: {},
    children: {
      /* One line per product asked for. `listPrice` is the agreed price from
         the customer's price list at that quantity; `discountPct` is what the
         rep gave away against it. Keeping both means the concession is
         visible rather than buried in a net figure.

         The review decision lives on the line, not the order, because a
         customer routinely orders four things and the plant can only commit
         to three of them. */
      lines: {
        table: "sales_order_lines", fk: "salesOrderId", pk: "id",
        columns: {
          id: "str", finishedGoodId: "ref:finishedGoods!", qty: "num!",
          listPrice: "num", discountPct: "num", discountReason: "str",
          requestedDate: "date",
          reviewDecision: "enum:Pending|Accept|Reject|Adjust!",
          approvedQty: "num", approvedDate: "date", reviewNote: "str",
          // the production run raised from this line, once released
          scheduleId: "str"
        }
      }
    }
  },

  fulfilmentCancellations: {
    table: "fulfilment_cancellations",
    label: "Cancellation",
    pk: "id",
    columns: {
      id: "str", scheduleId: "str!", lotId: "str", finishedGoodId: "ref:finishedGoods!",
      customerId: "ref:customers", qty: "num!",
      reason: "str!", reasonNote: "str",
      // What physically happens to the goods. Returning them is the default;
      // the consume options write the disposition onto the lot so the stock
      // record and the cancellation agree without anyone doing it twice.
      disposition: "str",
      cancelledBy: "str!", cancelledDate: "date!",
      // Value captured at the moment of cancellation. Recomputing it later
      // would drift with prices and lot costs, and the whole point of the
      // record is what was given up on the day.
      salesValue: "num", cogs: "num",
      notes: "str"
    },
    embeds: {}, children: {}
  },

  productionTargets: {
    table: "production_targets",
    label: "Production target",
    pk: "id",
    columns: {
      id: "str",
      periodType: "enum:week|month|year!",
      periodKey: "str!",
      productType: "enum:intermediate|finished",
      productId: "str",
      targetQty: "num!",
      notes: "str"
    },
    polyRefs: { productId: { typeColumn: "productType", companion: "productKey" } },
    embeds: {},
    children: {}
  },

  wasteStreams: {
    table: "waste_streams",
    label: "Waste stream",
    pk: "id",
    naturalKey: "sku",
    columns: {
      id: "str", name: "str!", sku: "str", unit: "str", notes: "str",
      componentId: "ref:components", accumulate: "bool", hazardClass: "str",
      shelfLifeDays: "num", physicallyStored: "bool"
    },
    embeds: {},
    children: { lots: LOTS_TABLE, packagings: PACKAGINGS_TABLE }
  },

  operatingCalendars: {
    table: "operating_calendars",
    label: "Operating calendar",
    pk: "id",
    naturalKey: "name",
    // Hours the facility actually runs, per weekday. A zero means shut.
    // Held as seven flat columns rather than a nested object so the row
    // maps to one SQL row and one readable CSV line.
    columns: {
      id: "str", name: "str!", isDefault: "bool",
      hoursMon: "num", hoursTue: "num", hoursWed: "num", hoursThu: "num",
      hoursFri: "num", hoursSat: "num", hoursSun: "num", notes: "str"
    },
    embeds: {},
    children: {
      closures: {
        table: "calendar_closures", fk: "calendarId", pk: "id",
        columns: { id: "str", startDate: "date!", endDate: "date", reason: "str" }
      },
      // A temporary pattern that replaces the weekly one for a date
      // range - a fortnight of 24/5 before dropping back, say.
      overrides: {
        table: "calendar_overrides", fk: "calendarId", pk: "id",
        columns: {
          id: "str", startDate: "date!", endDate: "date!", label: "str",
          hoursMon: "num", hoursTue: "num", hoursWed: "num", hoursThu: "num",
          hoursFri: "num", hoursSat: "num", hoursSun: "num"
        }
      }
    }
  },

  shipments: {
    table: "shipments",
    label: "Shipment",
    pk: "id",
    columns: {
      id: "str", finishedGoodId: "ref:finishedGoods!", lotId: "str", qty: "num",
      customerId: "ref:customers", addressId: "str", shipDate: "date",
      reference: "str", notes: "str",
      // Despatch paperwork. Without these a shipment cannot be matched to
      // anything the customer or the haulier holds, which is where most
      // "we never received it" arguments actually get settled.
      customerPO: "str", bol: "str", carrier: "str", trackingRef: "str",
      // The run this despatch satisfies, so shipped can be reconciled against
      // completed rather than the two being separate histories.
      scheduleId: "str"
    },
    lotRefs: { lotId: { companion: "lotNumber" } },
    embeds: {},
    children: {}
  }
};

/* ---------------------------------------------------------------
   Schema introspection - used by import/export and by the tests
   that keep this file honest against the real data.
----------------------------------------------------------------*/
const parseColType = (spec) => {
  const required = spec.endsWith("!");
  const body = required ? spec.slice(0, -1) : spec;
  if (body.startsWith("ref:")) return { kind: "ref", ref: body.slice(4), required };
  if (body.startsWith("enum:")) return { kind: "enum", values: body.slice(5).split("|"), required };
  return { kind: body, required };
};

/* Every table in the model, roots and nested alike, flattened to a
   list. This is the table set a full CSV export has to cover. */
function allTables(node, name, parentTable, out, seen) {
  out = out || []; seen = seen || new Set();
  if (!node) {
    Object.entries(SCHEMA).forEach(([k, v]) => allTables(v, k, null, out, seen));
    return out;
  }
  // A polymorphic table is reached from several parents but is one table.
  if (seen.has(node.table)) return out;
  seen.add(node.table);
  out.push({
    key: name, table: node.table, pk: node.pk || "id", fk: node.fk || null,
    parentTable, naturalKey: node.naturalKey || null,
    polymorphic: node.polymorphic || null,
    polyRefs: node.polyRefs || {}, packedRefs: node.packedRefs || {},
    lotRefs: node.lotRefs || {}, parentLocator: node.parentLocator || null,
    columns: node.columns || {}, embeds: node.embeds || {}
  });
  Object.entries(node.children || {}).forEach(([k, v]) => allTables(v, k, node.table, out, seen));
  return out;
}

/* Column headers a CSV for this table should carry, with embedded
   1:1 objects flattened to prefixed columns and the parent FK first. */
/* Every row in every table needs a stable primary key - without one,
   an exported row cannot be matched back to its source on re-import,
   and edits degrade into delete-and-recreate. Process inputs shipped
   without ids, so this walks the whole model schema-first and mints
   any that are missing, on both the seed and migration paths. */
function backfillRowIds(db) {
  const walkRows = (rows, def) => {
    if (!Array.isArray(rows)) return;
    const pk = def.pk || "id";
    rows.forEach(row => {
      if (!row || typeof row !== "object") return;
      if (!row[pk]) row[pk] = uid();
      Object.entries(def.children || {}).forEach(([key, childDef]) => walkRows(row[key], childDef));
    });
  };
  Object.entries(SCHEMA).forEach(([entity, def]) => walkRows(db[entity], def));
  return db;
}

const ENTITIES = Object.keys(SCHEMA);

/* Catalog entities share a lot/composition shape and are addressed by a
   short itemType tag ("raw" | "intermediate" | "finished") throughout the
   process and batch-logging code. This is the one place that mapping lives. */
const ITEM_TYPE_ENTITY = {
  raw: "rawMaterials",
  intermediate: "intermediateProducts",
  finished: "finishedGoods",
  waste: "wasteStreams"
};
const entityForItemType = (itemType) => ITEM_TYPE_ENTITY[itemType] || "intermediateProducts";

/* ===============================================================
   CSV CODEC

   Export and import are driven by ONE definition of each file's
   layout - csvPlan() below. Neither side hardcodes a column list,
   so the two cannot drift apart, and adding a column to SCHEMA
   updates both at once.

   Every reference is written twice: the internal id, and a
   human-readable companion beside it (equipmentId / equipmentCode,
   ownerId / ownerKey, itemId / itemKey). Import prefers the id and
   falls back to the companion, which means the same file format
   serves a lossless machine round-trip AND a spreadsheet where
   someone fills in SKUs and leaves every id column blank.

   Other conventions, all chosen so a round-trip loses nothing:
     - RFC 4180 quoting; a field is quoted only when it must be
     - booleans as true/false, never 1/0
     - null and undefined both write empty, not "null"
     - numbers unformatted: no separators, no currency
     - embedded 1:1 objects flattened to prefix_column
=============================================================== */

const CSV_EOL = "\r\n";

function csvEscape(value) {
  const s = (value === null || value === undefined) ? "" : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function serializeCell(value, spec) {
  if (value === null || value === undefined) return "";
  const t = parseColType(spec || "str");
  if (t.kind === "bool") return value ? "true" : "false";
  if (t.kind === "num") return value === "" ? "" : String(value);
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function deserializeCell(text, spec) {
  const t = parseColType(spec || "str");
  const s = text === undefined || text === null ? "" : String(text).trim();
  if (s === "") return t.kind === "num" ? "" : "";
  if (t.kind === "bool") return /^(true|yes|y|1)$/i.test(s);
  if (t.kind === "num") {
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : s;
  }
  return String(text);
}

/* Which human column stands in for each simple id reference. */
const REF_COMPANION = {
  rawMaterialId: { entity: "rawMaterials", column: "rawMaterialSku" },
  componentId: { entity: "components", column: "componentName" },
  equipmentId: { entity: "equipment", column: "equipmentCode" },
  customerId: { entity: "customers", column: "customerCode" },
  finishedGoodId: { entity: "finishedGoods", column: "finishedGoodSku" },
  processId: { entity: "processes", column: "processSku" },
  calendarId: { entity: "operatingCalendars", column: "calendarName" }
};

/* Parent foreign keys that have a meaningful human companion. Price
   lists and schedule rows have no natural key of their own, so their
   children stay id-linked; they are not bulk-import targets. */
const FK_COMPANION = {
  processId: { entity: "processes", column: "processSku" },
  customerId: { entity: "customers", column: "customerCode" },
  lotId: { lot: true, column: "parentLotNumber" },
  parentLotId: { lot: true, column: "parentLotNumber" },
  // Closures and temporary periods hang off a named calendar, so they can
  // be authored in a spreadsheet without knowing any internal ids.
  calendarId: { entity: "operatingCalendars", column: "calendarName" },
  salesOrderId: { entity: "salesOrders", column: "salesOrderRef" },
  // Receipts hang off an order that has a reference, so a delivery can be
  // logged from a spreadsheet without knowing any internal id.
  purchaseOrderId: { entity: "purchaseOrders", column: "purchaseOrderRef" }
};

const ENTITY_ITEM_TYPE = Object.fromEntries(
  Object.entries(ITEM_TYPE_ENTITY).map(([t, e]) => [e, t])
);

/* The ordered column plan for one table. Each entry says what the
   column is, which is all export and import need to agree. */
function csvPlan(t) {
  const plan = [];
  const add = (name, kind, extra) => plan.push({ name, kind, ...(extra || {}) });

  if (t.polymorphic) {
    add(t.polymorphic.typeColumn, "ownerType");
    add(t.polymorphic.idColumn, "ownerId");
    add("ownerKey", "ownerKey");
  } else if (t.fk) {
    add(t.fk, "fk");
    const c = FK_COMPANION[t.fk];
    if (c) add(c.column, "fkKey", c);
    if (t.parentLocator) {
      add(t.parentLocator.rootCompanion, "locatorRoot");
      add(t.parentLocator.matchCompanion, "locatorMatch");
    }
  }

  Object.entries(t.columns).forEach(([col, spec]) => {
    add(col, "col", { spec, col });
    const packed = (t.packedRefs || {})[col];
    if (packed) {
      add(packed.typeColumn, "packedType", { from: col });
      add(packed.keyColumn, "packedKey", { from: col });
    }
    const poly = (t.polyRefs || {})[col];
    if (poly) add(poly.companion, "polyKey", { from: col, typeColumn: poly.typeColumn });
    const lotRef = (t.lotRefs || {})[col];
    if (lotRef) add(lotRef.companion, "lotKey", { from: col });
    const simple = REF_COMPANION[col];
    if (simple && !poly && !lotRef) add(simple.column, "refKey", { from: col, entity: simple.entity });
  });

  Object.entries(t.embeds || {}).forEach(([prefix, def]) => {
    Object.entries(def.columns).forEach(([c, spec]) =>
      add(prefix + "_" + c, "embed", { prefix, col: c, spec }));
  });

  return plan;
}

function csvColumns(tableDef) {
  return csvPlan(tableDef).map(p => p.name);
}

/* ---------------------------------------------------------------
   Lookup indexes - natural key to id, in both directions. Built
   once per export or import so neither is quadratic on a large
   history.
----------------------------------------------------------------*/
function buildIndex(db) {
  const byId = {};        // entity -> id -> row
  const byKey = {};       // entity -> naturalKey value -> row
  ENTITIES.forEach(e => {
    byId[e] = {}; byKey[e] = {};
    const nk = SCHEMA[e].naturalKey;
    (db[e] || []).forEach(r => {
      byId[e][r.id] = r;
      if (nk && r[nk] !== undefined && r[nk] !== "") byKey[e][String(r[nk])] = r;
    });
  });

  // every lot in the model, by id and by lot number
  const lotById = {}, lotByNumber = {};
  Object.entries(ITEM_TYPE_ENTITY).forEach(([itemType, entity]) => {
    (db[entity] || []).forEach(item => (item.lots || []).forEach(lot => {
      const rec = { lot, item, itemType, entity };
      lotById[lot.id] = rec;
      if (lot.lotNumber) {
        if (lotByNumber[lot.lotNumber]) lotByNumber[lot.lotNumber].ambiguous = true;
        else lotByNumber[lot.lotNumber] = rec;
      }
    }));
  });

  return {
    byId, byKey, lotById, lotByNumber,
    keyOf: (entity, id) => {
      const nk = SCHEMA[entity] && SCHEMA[entity].naturalKey;
      const row = byId[entity] && byId[entity][id];
      return (nk && row) ? row[nk] : "";
    },
    keyOfItem: (itemType, id) => {
      const entity = ITEM_TYPE_ENTITY[itemType];
      if (!entity) return "";
      const nk = SCHEMA[entity].naturalKey;
      const row = byId[entity] && byId[entity][id];
      return (nk && row) ? row[nk] : "";
    },
    lotNumberOf: (id) => (lotById[id] ? lotById[id].lot.lotNumber : "")
  };
}

/* ---------------------------------------------------------------
   EXPORT
----------------------------------------------------------------*/
function collectRows(db, idx) {
  const byTable = {};
  const push = (table, row) => { (byTable[table] = byTable[table] || []).push(row); };

  const emit = (t, row, ctx) => {
    const out = {};
    csvPlan(t).forEach(p => {
      switch (p.kind) {
        case "ownerType": out[p.name] = ctx.ownerType; break;
        case "ownerId":   out[p.name] = ctx.ownerId; break;
        case "ownerKey":  out[p.name] = idx.keyOfItem(ctx.ownerType, ctx.ownerId); break;
        case "fk":        out[p.name] = ctx.parentPk; break;
        case "fkKey":
          out[p.name] = p.lot ? idx.lotNumberOf(ctx.parentPk) : idx.keyOf(p.entity, ctx.parentPk);
          break;
        case "locatorRoot": {
          const nk = SCHEMA[t.parentLocator.rootEntity].naturalKey;
          out[p.name] = ctx.rootRow ? ctx.rootRow[nk] : "";
          break;
        }
        case "locatorMatch":
          out[p.name] = ctx.parentRow
            ? idx.keyOf(t.parentLocator.matchEntity, ctx.parentRow[t.parentLocator.matchColumn])
            : "";
          break;
        case "col":       out[p.name] = row[p.col]; break;
        case "embed":     out[p.name] = (row[p.prefix] || {})[p.col]; break;
        case "refKey":    out[p.name] = idx.keyOf(p.entity, row[p.from]); break;
        case "lotKey":    out[p.name] = idx.lotNumberOf(row[p.from]); break;
        case "polyKey":   out[p.name] = idx.keyOfItem(row[p.typeColumn], row[p.from]); break;
        case "packedType": {
          const v = String(row[p.from] || ""); const i = v.indexOf(":");
          out[p.name] = i < 0 ? "" : v.slice(0, i);
          break;
        }
        case "packedKey": {
          const v = String(row[p.from] || ""); const i = v.indexOf(":");
          out[p.name] = i < 0 ? "" : idx.keyOfItem(v.slice(0, i), v.slice(i + 1));
          break;
        }
        default: out[p.name] = "";
      }
    });
    return out;
  };

  const walk = (def, rows, ctx) => {
    if (!Array.isArray(rows)) return;
    rows.forEach(row => {
      if (!row || typeof row !== "object") return;
      push(def.table, emit(def, row, ctx));
      const pk = row[def.pk || "id"];
      Object.entries(def.children || {}).forEach(([key, cd]) =>
        walk(cd, row[key], { ownerType: ctx.ownerType, ownerId: ctx.ownerId,
                             parentPk: pk, rootRow: ctx.rootRow, parentRow: row }));
    });
  };

  Object.entries(SCHEMA).forEach(([entity, def]) => {
    const ownerType = ENTITY_ITEM_TYPE[entity] || entity;
    (db[entity] || []).forEach(row => {
      push(def.table, emit(def, row, {}));
      const pk = row[def.pk || "id"];
      Object.entries(def.children || {}).forEach(([key, cd]) =>
        walk(cd, row[key], { ownerType, ownerId: pk, parentPk: pk, rootRow: row, parentRow: row }));
    });
  });

  return byTable;
}

function toCsv(plan, rows) {
  const lines = [plan.map(p => csvEscape(p.name)).join(",")];
  rows.forEach(r => lines.push(plan.map(p => csvEscape(serializeCell(r[p.name], p.spec))).join(",")));
  return lines.join(CSV_EOL) + CSV_EOL;
}

function exportCsvBundle(db, tables) {
  const idx = buildIndex(db);
  const rows = collectRows(db, idx);
  const wanted = tables ? new Set(tables) : null;
  return allTables()
    .filter(t => !wanted || wanted.has(t.table))
    .map(t => {
      const plan = csvPlan(t);
      const data = rows[t.table] || [];
      return {
        table: t.table, filename: t.table + ".csv",
        columns: plan.map(p => p.name), rowCount: data.length,
        csv: toCsv(plan, data)
      };
    });
}

/* ---------------------------------------------------------------
   IMPORT
----------------------------------------------------------------*/
function parseCsvText(text) {
  const rows = []; let row = [], cell = "", quoted = false;
  const src = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\r") { /* handled by \n */ }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) return { header: [], rows: [] };
  const header = rows.shift().map(h => h.trim());
  const out = rows
    .filter(r => r.some(v => String(v).trim() !== ""))
    .map(r => Object.fromEntries(header.map((h, i) => [h, r[i] === undefined ? "" : r[i]])));
  return { header, rows: out };
}

/* Tables ordered so a row's parents always exist by the time it loads. */
const IMPORT_ORDER = [
  // raw materials first: components carry a rawMaterialId, so the
  // materials must exist before a component can resolve against one.
  "raw_materials", "intermediate_products", "finished_goods",
  "components", "operating_calendars", "calendar_closures", "calendar_overrides",
  "equipment", "customers", "waste_streams", "processes",
  "composition", "packagings", "process_inputs", "process_equipment", "process_outputs",
  "maintenance", "production_targets", "purchase_orders",
  "sales_orders", "sales_order_lines", "fulfilment_cancellations",
  "production_schedule", "schedule_revisions",
  "lots", "lot_sources", "lot_actual_equipment", "lot_actual_labor", "lot_qc_checks",
  "purchase_receipts",
  "schedule_fulfillment_lots", "customer_addresses", "customer_price_list",
  "customer_price_tiers", "shipments"
];

const PROCESS_LOG_TABLES = ["lots", "lot_sources", "lot_actual_equipment", "lot_actual_labor", "lot_qc_checks"];

/* Import a set of CSV files into a copy of `db`.
   `files` is { "raw_materials.csv" | "raw_materials": csvText, ... }.
   Nothing is mutated in place: the caller gets a new object plus a
   report, and can choose not to apply it. */
function importCsvBundle(db, files, options) {
  const opts = options || {};
  const out = JSON.parse(JSON.stringify(db));
  const report = { tables: [], errors: [], warnings: [], inserted: 0, updated: 0, skipped: 0 };

  const norm = {};
  Object.entries(files || {}).forEach(([k, v]) => {
    norm[String(k).replace(/\.csv$/i, "").trim()] = v;
  });

  const tablesByName = {};
  allTables().forEach(t => { tablesByName[t.table] = t; });

  Object.keys(norm).forEach(name => {
    if (!tablesByName[name]) report.warnings.push("Ignored unknown file: " + name + ".csv");
  });

  let idx = buildIndex(out);
  const refresh = () => { idx = buildIndex(out); };

  const resolveEntity = (entity, id, key, where, errors) => {
    if (id && idx.byId[entity] && idx.byId[entity][id]) return idx.byId[entity][id];
    if (key && idx.byKey[entity] && idx.byKey[entity][String(key).trim()]) return idx.byKey[entity][String(key).trim()];
    if (id || key) errors.push(where + ": no " + (SCHEMA[entity].label || entity) + " matching " +
      (id ? "id " + id : (SCHEMA[entity].naturalKey || "key") + " “" + key + "”"));
    return null;
  };

  const resolveLot = (id, number, where, errors) => {
    if (id && idx.lotById[id]) return idx.lotById[id];
    if (number) {
      const hit = idx.lotByNumber[String(number).trim()];
      if (hit && hit.ambiguous) { errors.push(where + ": lot number “" + number + "” is not unique"); return null; }
      if (hit) return hit;
    }
    if (id || number) errors.push(where + ": no lot matching " + (id ? "id " + id : "number “" + number + "”"));
    return null;
  };

  /* Turn one CSV row into a record, resolving every reference. */
  const buildRecord = (t, raw, where, errors) => {
    const rec = {};
    const plan = csvPlan(t);
    let ownerType = null, ownerId = null, parentPk = null;

    plan.forEach(p => {
      const cell = raw[p.name];
      switch (p.kind) {
        case "ownerType": ownerType = String(cell || "").trim(); break;
        case "ownerId":   ownerId = String(cell || "").trim(); break;
        case "fk":        parentPk = String(cell || "").trim(); break;
        case "col":       rec[p.col] = deserializeCell(cell, p.spec); break;
        case "embed": {
          const v = deserializeCell(cell, p.spec);
          if (v !== "" && v !== undefined) {
            rec[p.prefix] = rec[p.prefix] || {};
            rec[p.prefix][p.col] = v;
          }
          break;
        }
        default: break;
      }
    });

    // second pass: companions fill in whatever the id columns left blank
    plan.forEach(p => {
      const cell = String(raw[p.name] || "").trim();
      if (p.kind === "refKey") {
        if (!rec[p.from] && cell) {
          const hit = resolveEntity(p.entity, "", cell, where, errors);
          if (hit) rec[p.from] = hit.id;
        }
      } else if (p.kind === "lotKey") {
        if (!rec[p.from] && cell) {
          const hit = resolveLot("", cell, where, errors);
          if (hit) rec[p.from] = hit.lot.id;
        }
      } else if (p.kind === "polyKey") {
        if (!rec[p.from] && cell) {
          const entity = ITEM_TYPE_ENTITY[rec[p.typeColumn]];
          if (!entity) errors.push(where + ": unknown " + p.typeColumn + " “" + rec[p.typeColumn] + "”");
          else {
            const hit = resolveEntity(entity, "", cell, where, errors);
            if (hit) rec[p.from] = hit.id;
          }
        }
      } else if (p.kind === "packedKey") {
        const typeCell = String(raw[(t.packedRefs[p.from] || {}).typeColumn] || "").trim();
        if (!rec[p.from] && cell && typeCell) {
          const entity = ITEM_TYPE_ENTITY[typeCell];
          if (!entity) errors.push(where + ": unknown source type “" + typeCell + "”");
          else {
            const hit = resolveEntity(entity, "", cell, where, errors);
            if (hit) rec[p.from] = typeCell + ":" + hit.id;
          }
        }
      }
    });

    return { rec, ownerType, ownerId, parentPk };
  };

  IMPORT_ORDER.forEach(tableName => {
    const text = norm[tableName];
    if (text === undefined) return;
    const t = tablesByName[tableName];
    if (!t) return;

    const stat = { table: tableName, inserted: 0, updated: 0, skipped: 0, errors: [] };
    const parsed = parseCsvText(text);

    const expected = csvColumns(t);
    const unknown = parsed.header.filter(h => h && !expected.includes(h));
    if (unknown.length) stat.errors.push("Unrecognised column(s): " + unknown.join(", "));

    const isRoot = !t.parentTable;
    const entity = isRoot ? ENTITIES.find(e => SCHEMA[e].table === tableName) : null;

    parsed.rows.forEach((raw, i) => {
      const where = tableName + ".csv row " + (i + 2);
      const errors = [];
      const { rec, ownerType, ownerId, parentPk } = buildRecord(t, raw, where, errors);

      // required columns
      Object.entries(t.columns).forEach(([c, spec]) => {
        if (parseColType(spec).required && (rec[c] === "" || rec[c] === undefined)) {
          errors.push(where + ": " + c + " is required");
        }
      });
      // enums
      Object.entries(t.columns).forEach(([c, spec]) => {
        const pt = parseColType(spec);
        if (pt.kind === "enum" && rec[c] && !pt.values.includes(rec[c])) {
          errors.push(where + ": " + c + " “" + rec[c] + "” is not one of " + pt.values.join(", "));
        }
      });

      if (errors.length) { stat.errors.push(...errors); stat.skipped++; return; }

      if (isRoot) {
        const nk = SCHEMA[entity].naturalKey;
        const existing = (rec.id && idx.byId[entity][rec.id]) ||
          (nk && rec[nk] ? idx.byKey[entity][String(rec[nk])] : null);
        if (existing) {
          Object.assign(existing, rec, { id: existing.id });
          stat.updated++;
        } else {
          const created = repo.create(out, entity, rec);
          Object.entries(SCHEMA[entity].children || {}).forEach(([k]) => {
            if (!Array.isArray(created[k])) created[k] = [];
          });
          stat.inserted++;
        }
      } else {
        // find the array this child belongs to
        let container = null, childKey = null;
        if (t.polymorphic) {
          const ent = ITEM_TYPE_ENTITY[ownerType];
          const ownerKeyCell = String(raw.ownerKey || "").trim();
          const owner = ent ? resolveEntity(ent, ownerId, ownerKeyCell, where, errors) : null;
          if (!ent) errors.push(where + ": unknown ownerType “" + ownerType + "”");
          if (owner) {
            childKey = Object.entries(SCHEMA[ent].children || {})
              .find(([, cd]) => cd.table === tableName);
            childKey = childKey ? childKey[0] : null;
            container = owner;
          }
        } else if (FK_COMPANION[t.fk] && FK_COMPANION[t.fk].lot) {
          const hit = resolveLot(parentPk, raw[FK_COMPANION[t.fk].column], where, errors);
          if (hit) {
            container = hit.lot;
            childKey = Object.entries(LOT_CHILDREN).find(([, cd]) => cd.table === tableName);
            childKey = childKey ? childKey[0] : null;
          }
        } else {
          // ordinary parent: search every entity for the owning table
          let parentEntity = null, key = null;
          ENTITIES.forEach(e => {
            Object.entries(SCHEMA[e].children || {}).forEach(([k, cd]) => {
              if (cd.table === tableName) { parentEntity = e; key = k; }
              Object.entries(cd.children || {}).forEach(([k2, cd2]) => {
                if (cd2.table === tableName) { parentEntity = e; key = k + ">" + k2; }
              });
            });
          });
          if (parentEntity && key && key.indexOf(">") < 0) {
            const comp = FK_COMPANION[t.fk];
            const owner = resolveEntity(parentEntity, parentPk,
              comp ? raw[comp.column] : "", where, errors);
            if (owner) { container = owner; childKey = key; }
          } else if (parentEntity && key) {
            const [k1, k2] = key.split(">");
            if (parentPk) {
              (out[parentEntity] || []).forEach(p => (p[k1] || []).forEach(mid => {
                if (mid.id === parentPk) { container = mid; childKey = k2; }
              }));
            }
            if (!container && t.parentLocator) {
              const L = t.parentLocator;
              const root = resolveEntity(L.rootEntity, "", raw[L.rootCompanion], where, errors);
              const match = root ? resolveEntity(L.matchEntity, "", raw[L.matchCompanion], where, errors) : null;
              if (root && match) {
                const mid = (root[L.childKey] || []).find(m => m[L.matchColumn] === match.id);
                if (mid) { container = mid; childKey = k2; }
                else errors.push(where + ": " + (SCHEMA[L.rootEntity].label) + " “" +
                  raw[L.rootCompanion] + "” has no entry for " + raw[L.matchCompanion]);
              }
            }
            if (!container && !errors.length) errors.push(where + ": could not locate the parent row");
          }
        }

        if (errors.length || !container || !childKey) {
          if (!errors.length) errors.push(where + ": could not locate the parent row");
          stat.errors.push(...errors); stat.skipped++; return;
        }
        if (!Array.isArray(container[childKey])) container[childKey] = [];
        const arr = container[childKey];
        const existing = rec.id ? arr.find(r => r.id === rec.id) : null;
        if (existing) { Object.assign(existing, rec, { id: existing.id }); stat.updated++; }
        else { arr.push({ ...rec, id: rec.id || uid() }); stat.inserted++; }
      }
    });

    refresh();
    report.tables.push(stat);
    report.inserted += stat.inserted;
    report.updated += stat.updated;
    report.skipped += stat.skipped;
    stat.errors.forEach(e => report.errors.push(e));
  });

  backfillRowIds(out);
  return { data: out, report };
}

/* ---------------------------------------------------------------
   Bundle manifest and zip container
----------------------------------------------------------------*/
function bundleManifest(bundle) {
  const byName = {};
  bundle.forEach(b => { byName[b.table] = b; });
  const lines = [
    "MRP console - CSV export",
    "Generated: " + new Date().toISOString(),
    "",
    "One file per table. Load in the order below so references resolve.",
    "",
    "Every reference appears twice: the internal id, and a readable",
    "companion beside it (equipmentId / equipmentCode, ownerId / ownerKey).",
    "On import the id wins when present; otherwise the companion is looked",
    "up. To load new data from a spreadsheet, leave every id column blank",
    "and fill in the companion columns only - ids will be generated.",
    "",
    "Tables with ownerType/ownerId are shared by several parents;",
    "ownerType is one of raw, intermediate, finished, waste.",
    "",
    "Conventions: booleans are true/false, empty means null, numbers are",
    "unformatted, dates are ISO yyyy-mm-dd, and embedded objects appear as",
    "prefix_column (for example qcCalibration_slope).",
    ""
  ];
  IMPORT_ORDER.forEach((t, i) => {
    const b = byName[t];
    if (!b) return;
    lines.push(String(i + 1).padStart(2, " ") + ". " + b.filename + "  (" + b.rowCount + " rows)");
    lines.push("      " + b.columns.join(", "));
  });
  return lines.join("\n") + "\n";
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* Store-only (uncompressed) zip. Two dozen separate downloads is not
   a usable export and there is no archiver in the page, so this
   writes a short, entirely standard archive any tool will open. */
function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const u16 = (n) => [n & 0xFF, (n >>> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;

  files.forEach(f => {
    const nameBytes = enc.encode(f.name);
    const dataBytes = enc.encode(f.content);
    const crc = crc32(dataBytes);
    const local = [].concat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
      u32(crc), u32(dataBytes.length), u32(dataBytes.length),
      u16(nameBytes.length), u16(0)
    );
    chunks.push(new Uint8Array(local), nameBytes, dataBytes);
    central.push({
      name: nameBytes,
      header: [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(dosTime), u16(dosDate),
        u32(crc), u32(dataBytes.length), u32(dataBytes.length),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)
      )
    });
    offset += local.length + nameBytes.length + dataBytes.length;
  });

  const centralStart = offset;
  let centralSize = 0;
  central.forEach(c => {
    chunks.push(new Uint8Array(c.header), c.name);
    centralSize += c.header.length + c.name.length;
  });
  chunks.push(new Uint8Array([].concat(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(centralSize), u32(centralStart), u16(0)
  )));

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  chunks.forEach(c => { out.set(c, p); p += c.length; });
  return out;
}

function csvExportZip(db, tables) {
  const bundle = exportCsvBundle(db, tables);
  const files = bundle.map(b => ({ name: b.filename, content: b.csv }));
  files.push({ name: "README.txt", content: bundleManifest(bundle) });
  return { bytes: zipStore(files), bundle };
}


/* ---------------------------------------------------------------
   repo - record access. `db` is the whole data object; in the
   extracted app it becomes a connection/transaction handle.
----------------------------------------------------------------*/
const repo = {
  list(db, entity) {
    return (db && Array.isArray(db[entity])) ? db[entity] : [];
  },

  find(db, entity, id) {
    if (!id) return null;
    return repo.list(db, entity).find(r => r.id === id) || null;
  },

  create(db, entity, record) {
    const row = { ...record, id: record.id || uid() };
    if (!Array.isArray(db[entity])) db[entity] = [];
    db[entity].push(row);
    return row;
  },

  /* Insert or replace by id - the single write path behind every
     "Add / Edit <entity>" modal. */
  upsert(db, entity, id, record) {
    if (!Array.isArray(db[entity])) db[entity] = [];
    const idx = id ? db[entity].findIndex(r => r.id === id) : -1;
    if (idx >= 0) {
      // An entity may refuse a write outright - see SCHEMA.schedule.guard.
      // Throwing rather than returning false is deliberate: a caller that
      // ignores the result must not silently succeed in breaking the rule.
      const guard = SCHEMA[entity] && SCHEMA[entity].guard;
      if (guard) {
        const refusal = guard(db[entity][idx], record);
        if (refusal) throw new Error(refusal);
      }
      const row = { ...record, id };
      db[entity][idx] = row;
      return row;
    }
    return repo.create(db, entity, record);
  },

  patch(db, entity, id, changes) {
    const row = repo.find(db, entity, id);
    if (row) Object.assign(row, changes);
    return row;
  },

  remove(db, entity, id) {
    if (!Array.isArray(db[entity])) return;
    db[entity] = db[entity].filter(r => r.id !== id);
  },

  /* --- lots: the child table hanging off every catalog entity --- */
  lots(db, entity, itemId) {
    const item = repo.find(db, entity, itemId);
    return (item && Array.isArray(item.lots)) ? item.lots : [];
  },

  findLot(db, entity, itemId, lotId) {
    return repo.lots(db, entity, itemId).find(l => l.id === lotId) || null;
  },

  addLot(db, entity, itemId, lot) {
    const item = repo.find(db, entity, itemId);
    if (!item) return null;
    if (!Array.isArray(item.lots)) item.lots = [];
    const row = {
      id: lot.id || uid(), lotNumber: "", date: todayStr(), qty: 0, notes: "",
      unitCost: "", producedQty: "", batchId: "", processId: "",
      sources: [], actualEquipment: [], actualLabor: [], qcChecks: [], ...lot
    };
    item.lots.push(row);
    return row;
  },

  patchLot(db, entity, itemId, lotId, changes) {
    const lot = repo.findLot(db, entity, itemId, lotId);
    if (lot) Object.assign(lot, changes);
    return lot;
  },

  /* Catalog entities addressed by itemType tag rather than entity name. */
  findItem(db, itemType, itemId) {
    return repo.find(db, entityForItemType(itemType), itemId);
  },

  findItemLot(db, itemType, itemId, lotId) {
    return repo.findLot(db, entityForItemType(itemType), itemId, lotId);
  },

  patchItemLot(db, itemType, itemId, lotId, changes) {
    return repo.patchLot(db, entityForItemType(itemType), itemId, lotId, changes);
  }
};

/* ---------------------------------------------------------------
   tx - writes that span more than one entity. Each of these becomes
   a single SQL transaction on extraction, so they are kept whole and
   named rather than inlined into the components that trigger them.
   Every one takes the db handle first and returns a plain result;
   none of them know anything about React.
----------------------------------------------------------------*/
const tx = {
  /* Goods-in: one new lot against an existing raw material. */
  receiveRawLot(db, { rawMaterialId, lotNumber, date, qty, notes, unitCost }) {
    const material = repo.find(db, "rawMaterials", rawMaterialId);
    // Default to the list price so a delivery is never costed at zero, but
    // record it on the lot either way - that is what makes the figure
    // historical rather than a live lookup.
    const price = (unitCost === "" || unitCost === undefined || unitCost === null)
      ? (material ? Number(material.unitCost) || 0 : 0)
      : Number(unitCost) || 0;
    return repo.addLot(db, "rawMaterials", rawMaterialId, {
      lotNumber, date, qty, notes, producedQty: qty, unitCost: price,
      sources: [], actualEquipment: [], actualLabor: []
    });
  },

  /* Ship: deduct from the source lot and write the shipment row. */
  shipFinishedGoods(db, shipment) {
    const lot = repo.findLot(db, "finishedGoods", shipment.finishedGoodId, shipment.lotId);
    if (lot) lot.qty = Math.max(0, (Number(lot.qty) || 0) - Number(shipment.qty));
    /* Tie the despatch to the run whose lot it drew on, so shipped can be
       reconciled against completed without guessing later. */
    const record = { ...shipment };
    if (!record.scheduleId && record.lotId) {
      const run = (db.schedule || []).find(s =>
        (s.fulfillmentLots || []).some(fl => fl.lotId === record.lotId));
      if (run) record.scheduleId = run.id;
    }
    return repo.create(db, "shipments", record);
  },

  /* Log a production batch: create output lots, draw down the source
     lots that fed them, and accrue any computed waste. Returns the
     created lots so the caller can offer labels for them. */
  logProductionBatch(db, { processId, date, notes, sources, outputs, actualEquipment, actualLabor, wasteAllocations }) {
    const created = [];
    const proc = repo.find(db, "processes", processId);
    if (!proc) return created;
    // One identity for the whole run, so its outputs can be read back as a
    // single batch record rather than as unrelated lots.
    const batchId = uid();

    (outputs || []).forEach(entry => {
      if (!(entry.qty > 0)) return;
      const outLine = (proc.outputs || []).find(o => o.id === entry.outputId);
      if (!outLine) return;
      const entity = entityForItemType(outLine.itemType);
      const target = repo.find(db, entity, outLine.itemId);
      if (!target) return;
      const qcChecks = (entry.qcChecks || []).filter(q => q.mode !== "estimated");
      const lot = repo.addLot(db, entity, outLine.itemId, {
        lotNumber: entry.lotNumber, date, qty: entry.qty, notes,
        sources, actualEquipment, actualLabor, qcChecks,
        // producedQty is fixed at creation; qty gets drawn down later and
        // can no longer say what the run actually made.
        producedQty: entry.qty,
        batchId, processId
      });
      created.push({
        lotId: lot.id, itemType: outLine.itemType, itemId: outLine.itemId,
        lotNumber: entry.lotNumber, qty: entry.qty, unit: target.unit, date, qcChecks
      });
    });

    (sources || []).forEach(s => {
      const qty = Number(s.qty) || 0;
      if (qty <= 0 || !s.lotId) return;
      const sep = s.groupKey.indexOf(":");
      const itemType = s.groupKey.slice(0, sep);
      const itemId = s.groupKey.slice(sep + 1);
      const lot = repo.findItemLot(db, itemType, itemId, s.lotId);
      if (!lot) return;
      lot.qty = Math.max(0, (Number(lot.qty) || 0) - qty);
      if (!lot.usedDate) lot.usedDate = date;
      if (lot.qty <= 0 && !lot.consumedDate) lot.consumedDate = date;
    });

    (wasteAllocations || []).forEach(w => {
      const ws = getWasteStreamForComponent(db, w.componentId);
      if (!ws || !ws.accumulate) return;
      repo.addLot(db, "wasteStreams", ws.id, {
        lotNumber: "", date, qty: Math.round(w.wasteQty * 100) / 100,
        producedQty: Math.round(w.wasteQty * 100) / 100,
        notes: "Auto-computed from a batch of " + proc.name,
        sources: [], actualEquipment: [], actualLabor: [],
        batchId, processId
      });
    });

    return created;
  },

  /* Consume/write off a lot: apply the disposition, optionally accrue
     the remaining quantity to waste streams, and optionally flag every
     downstream lot that drew from this one for cost review. */
  consumeLot(db, { itemType, itemId, lotId, lotPatch, accumulateAsWaste, flagDaughterLots, flagNote }) {
    const targetLot = repo.findItemLot(db, itemType, itemId, lotId);
    if (!targetLot) return null;
    const remainingQty = Number(targetLot.qty) || 0;

    if (accumulateAsWaste && remainingQty > 0) {
      computeEffectiveComposition(db, itemType, itemId).forEach(c => {
        const wasteQty = remainingQty * ((Number(c.percentage) || 0) / 100);
        if (wasteQty <= 0) return;
        const ws = getWasteStreamForComponent(db, c.componentId);
        if (!ws || !ws.accumulate) return;
        repo.addLot(db, "wasteStreams", ws.id, {
          lotNumber: "", date: todayStr(), qty: Math.round(wasteQty * 100) / 100,
          notes: "Auto-logged from consuming lot " + (targetLot.lotNumber || targetLot.id) +
            " (" + ((lotPatch && lotPatch.disposition && lotPatch.disposition.reason) || "") + ")",
          sources: [], actualEquipment: [], actualLabor: []
        });
      });
    }

    Object.assign(targetLot, lotPatch);

    if (flagDaughterLots) {
      const groupKey = itemType + ":" + itemId;
      [...repo.list(db, "intermediateProducts"), ...repo.list(db, "finishedGoods")].forEach(dsItem => {
        (dsItem.lots || []).forEach(dsLot => {
          if ((dsLot.sources || []).some(s => s.groupKey === groupKey && s.lotId === lotId)) {
            dsLot.notes = (dsLot.notes ? dsLot.notes + " — " : "") + flagNote;
          }
        });
      });
    }
    return targetLot;
  },

  /* Freeze a run: capture what was committed to, so that what actually
     happens can be measured against it. Idempotent - freezing twice does
     not move a baseline that has already been set. */
  freezeRun(db, { scheduleId, date }) {
    const entry = repo.find(db, "schedule", scheduleId);
    if (!entry) return null;
    if (entry.frozen) return entry;
    entry.frozen = true;
    entry.frozenDate = date || todayStr();
    entry.baselineQty = Number(entry.qty) || 0;
    entry.baselineDueDate = entry.dueDate || "";
    return entry;
  },

  /* The only sanctioned way to change a frozen run. Writes the revision
     record FIRST, then applies the change, so a failure part-way cannot
     leave an unexplained edit behind. A reason is not optional. */
  amendFrozenRun(db, { scheduleId, changes, reason, author, date }) {
    const entry = repo.find(db, "schedule", scheduleId);
    if (!entry) return { ok: false, error: "That run no longer exists." };
    if (!entry.frozen) return { ok: false, error: "That run is not frozen; edit it normally." };
    const why = String(reason || "").trim();
    if (!why) return { ok: false, error: "A reason is required to amend a frozen run." };

    const val = (v) => String(v === undefined || v === null ? "" : v);
    const applied = [];
    if (!Array.isArray(entry.revisions)) entry.revisions = [];

    Object.entries(changes || {}).forEach(([field, next]) => {
      if (val(entry[field]) === val(next)) return;
      entry.revisions.push({
        id: uid(), at: date || todayStr(), field,
        fromValue: val(entry[field]), toValue: val(next),
        reason: why, author: String(author || "").trim()
      });
      applied.push(field);
    });

    if (!applied.length) return { ok: true, changed: [], entry };
    applied.forEach(field => { entry[field] = changes[field]; });
    return { ok: true, changed: applied, entry };
  },

  /* Receive against a purchase order: create the stock lot at the price the
     order was placed at, and record the instalment against the order. Both
     or neither - a lot with no receipt row would silently detach stock from
     the order that paid for it. */
  receiveAgainstOrder(db, { purchaseOrderId, date, qty, lotNumber, notes, unitCost }) {
    const po = repo.find(db, "purchaseOrders", purchaseOrderId);
    if (!po) return { ok: false, error: "That purchase order no longer exists." };
    const amount = Number(qty) || 0;
    if (amount <= 0) return { ok: false, error: "Received quantity must be greater than zero." };

    const price = (unitCost === "" || unitCost === undefined || unitCost === null)
      ? (Number(po.unitCost) || 0)
      : Number(unitCost) || 0;

    const lot = repo.addLot(db, "rawMaterials", po.rawMaterialId, {
      lotNumber: lotNumber || po.reference, date: date || todayStr(),
      qty: amount, producedQty: amount, unitCost: price,
      notes: notes || ("Received against " + po.reference),
      sources: [], actualEquipment: [], actualLabor: []
    });
    if (!lot) return { ok: false, error: "The material on that order no longer exists." };

    if (!Array.isArray(po.receipts)) po.receipts = [];
    po.receipts.push({
      id: uid(), date: date || todayStr(), qty: amount,
      lotId: lot.id, notes: notes || ""
    });
    po.status = poDerivedStatus(po);
    return { ok: true, lot, po };
  },

  /* Raise purchase orders from reviewed suggestions.

     The order is the record the warehouse receives against, so it is
     written once, deliberately, with a unique reference - references are
     minted inside the loop against the growing database so a batch of
     suggestions accepted together cannot collide with each other.

     Raised as Draft: a suggestion that has been accepted is not yet an
     order that has been placed with a supplier. */
  raisePurchaseOrders(db, rows) {
    const created = [];
    (rows || []).forEach(row => {
      const raw = getRaw(db, row.rawMaterialId);
      if (!raw) return;
      const qty = Number(row.qty) || 0;
      if (qty <= 0) return;
      const po = repo.create(db, "purchaseOrders", {
        reference: row.reference || nextPoReference(db),
        rawMaterialId: row.rawMaterialId,
        supplier: row.supplier || raw.supplier || "",
        orderDate: row.orderDate || todayStr(),
        expectedDate: row.expectedDate || todayStr(),
        qty,
        unitCost: Number(row.unitCost) || 0,
        packagingId: row.packagingId || "",
        containerCount: Number(row.containerCount) || 0,
        status: "Draft",
        notes: row.notes || "Raised from reorder forecast",
        receipts: []
      });
      created.push(po);
    });
    return { ok: true, created };
  },

  /* Place a drafted order with the supplier.

     Draft is deliberately sticky - poDerivedStatus will not infer its way
     out of it, because a draft is a decision rather than a state to be
     guessed at. So there has to be an explicit step that says this order
     was actually placed, and it is that step which makes the order
     receivable. Without it a delivery could be booked against an order
     nobody ever sent. */
  placePurchaseOrder(db, { purchaseOrderId, orderDate, expectedDate }) {
    const po = repo.find(db, "purchaseOrders", purchaseOrderId);
    if (!po) return { ok: false, error: "That purchase order no longer exists." };
    if (po.status === "Cancelled") return { ok: false, error: "A cancelled order cannot be placed." };
    if (po.status !== "Draft") return { ok: false, error: "Only a draft order can be placed." };
    if (orderDate) po.orderDate = orderDate;
    if (expectedDate) po.expectedDate = expectedDate;
    po.status = "Ordered";
    return { ok: true, po };
  },

  /* Orders the warehouse may receive against: placed, not yet complete.
     A draft has not been sent to anyone and a cancelled order should not
     be accepting stock, so neither is receivable. */
  receivablePurchaseOrders(db) {
    return (db.purchaseOrders || []).filter(po =>
      (po.status === "Ordered" || po.status === "Part received") && poOutstanding(po) > 0);
  },

  /* Record a review decision on a sales order line. Accepting or adjusting
     does not itself raise a run - that is releaseSalesOrderLine - so a
     decision can be revisited before anything hits the schedule. */
  reviewSalesOrderLine(db, { salesOrderId, lineId, decision, approvedQty, approvedDate, note }) {
    const order = repo.find(db, "salesOrders", salesOrderId);
    if (!order) return { ok: false, error: "That sales order no longer exists." };
    const line = (order.lines || []).find(l => l.id === lineId);
    if (!line) return { ok: false, error: "That line no longer exists." };
    if (SO_DECISIONS.indexOf(decision) < 0) return { ok: false, error: "Unknown decision." };
    if (line.scheduleId) {
      return { ok: false, error: "That line has already been released to production." };
    }

    line.reviewDecision = decision;
    line.reviewNote = note === undefined ? (line.reviewNote || "") : note;

    if (decision === "Adjust") {
      const qty = Number(approvedQty);
      if (!(qty > 0)) return { ok: false, error: "An adjusted line needs a quantity." };
      line.approvedQty = qty;
      line.approvedDate = approvedDate || line.requestedDate || order.requestedDate || todayStr();
    } else if (decision === "Accept") {
      line.approvedQty = Number(line.qty) || 0;
      line.approvedDate = line.requestedDate || order.requestedDate || todayStr();
    } else {
      line.approvedQty = 0;
      line.approvedDate = "";
    }

    const pending = (order.lines || []).filter(l => (l.reviewDecision || "Pending") === "Pending");
    if (!pending.length && order.status === "Submitted") order.status = "Reviewed";
    return { ok: true, line, order };
  },

  /* Raise a production run from an accepted or adjusted line. The run carries
     the approved quantity and date, not what was asked for, so the schedule
     reflects what the plant committed to rather than what was requested. */
  releaseSalesOrderLine(db, { salesOrderId, lineId, date }) {
    const order = repo.find(db, "salesOrders", salesOrderId);
    if (!order) return { ok: false, error: "That sales order no longer exists." };
    const line = (order.lines || []).find(l => l.id === lineId);
    if (!line) return { ok: false, error: "That line no longer exists." };
    if (line.scheduleId) return { ok: false, error: "Already released." };

    const decision = line.reviewDecision || "Pending";
    if (decision !== "Accept" && decision !== "Adjust") {
      return { ok: false, error: "Only accepted or adjusted lines can be released." };
    }
    const qty = decision === "Adjust" ? Number(line.approvedQty) || 0 : Number(line.qty) || 0;
    if (!(qty > 0)) return { ok: false, error: "Nothing to make on that line." };

    const dueDate = line.approvedDate || line.requestedDate || order.requestedDate || todayStr();
    const run = repo.create(db, "schedule", {
      productType: "finished", productId: line.finishedGoodId,
      qty, dueDate, status: "Planned",
      notes: "Released from " + order.reference +
        (decision === "Adjust" ? " (adjusted from " + fmtNum(Number(line.qty) || 0) + ")" : ""),
      customerId: order.customerId,
      completedDate: "", createdDate: date || todayStr(),
      frozen: false, frozenDate: "", baselineQty: "", baselineDueDate: "",
      standardCostAtFulfillment: "",
      fulfillmentLots: [], revisions: []
    });

    line.scheduleId = run.id;

    const unreleased = (order.lines || []).filter(l => {
      const dec = l.reviewDecision || "Pending";
      return (dec === "Accept" || dec === "Adjust") && !l.scheduleId;
    });
    if (!unreleased.length) order.status = "Released";
    return { ok: true, run, line, order };
  },

  /* Cancel part or all of a run's held allocation. The goods stay in the lot
     and become available to anything else; only the earmark is released.
     Value is captured now, not derived later, because the record is about
     what was given up on the day. A reason and a name are not optional. */
  cancelFulfilment(db, { scheduleId, lotId, qty, reason, reasonNote, cancelledBy, date, notes, disposition }) {
    const entry = repo.find(db, "schedule", scheduleId);
    if (!entry) return { ok: false, error: "That run no longer exists." };
    const fl = (entry.fulfillmentLots || []).find(x => x.lotId === lotId);
    if (!fl) return { ok: false, error: "That lot is not allocated to this run." };

    const amount = Number(qty) || 0;
    if (amount <= 0) return { ok: false, error: "Cancel a quantity greater than zero." };
    if (!String(reason || "").trim()) return { ok: false, error: "A reason is required." };
    if (!String(cancelledBy || "").trim()) return { ok: false, error: "Record who is cancelling this." };

    // fl.qty already reflects earlier cancellations, so do not deduct them twice
    const shipped = shippedFromLot(db, lotId);
    const held = Math.max(0, (Number(fl.qty) || 0) - shipped);
    if (amount > held + 0.001) {
      return { ok: false, error: "Only " + fmtNum(held) + " is still held against this lot." };
    }

    const cost = lotCost(db, "finished", entry.productId, lotId, {});
    const customer = entry.customerId ? getCustomer(db, entry.customerId) : null;
    const priceLine = customer
      ? (customer.priceList || []).find(p => p.finishedGoodId === entry.productId)
      : null;
    const unitPrice = priceLine ? getEffectivePrice(priceLine, amount) : 0;

    const disp = CANCELLATION_DISPOSITIONS.find(x => x.key === (disposition || "return"));
    if (!disp) return { ok: false, error: "Unknown disposition." };

    const record = repo.create(db, "fulfilmentCancellations", {
      scheduleId, lotId, finishedGoodId: entry.productId,
      customerId: entry.customerId || "",
      qty: amount,
      reason: String(reason).trim(),
      reasonNote: reasonNote || "",
      cancelledBy: String(cancelledBy).trim(),
      cancelledDate: date || todayStr(),
      disposition: disp.key,
      salesValue: Math.round(unitPrice * amount * 100) / 100,
      cogs: Math.round(cost.unitCost * amount * 100) / 100,
      notes: notes || ""
    });

    /* Release the earmark. On a return that is all that happens - the goods
       are still on the rack, just no longer promised to this order. */
    fl.qty = Math.max(0, (Number(fl.qty) || 0) - amount);

    /* Any other disposition also takes the quantity out of stock and writes
       the reason onto the lot, so the inventory record and the cancellation
       cannot disagree and nobody has to consume it by hand afterwards. */
    if (disp.consumes) {
      const lot = repo.findLot(db, "finishedGoods", entry.productId, lotId);
      if (lot) {
        const taken = Math.min(amount, Number(lot.qty) || 0);
        lot.qty = Math.max(0, (Number(lot.qty) || 0) - amount);
        if (!lot.usedDate) lot.usedDate = record.cancelledDate;
        if (lot.qty <= 0.001) lot.consumedDate = record.cancelledDate;
        lot.disposition = {
          reason: disp.reason,
          disposeImmediately: !!(disp.waste && !disp.accumulate),
          accumulateAsWaste: !!disp.accumulate,
          note: "Cancelled from " + (entry.notes || "run") + " \u2014 " + String(reason).trim(),
          date: record.cancelledDate
        };
        lot.notes = (lot.notes ? lot.notes + " \u2014 " : "") +
          "[" + disp.reason + "] " + fmtNum(amount) + " cancelled by " + record.cancelledBy;

        /* Accrue to the waste streams the composition maps to, the same way a
           lot consumed through the inventory card would. */
        if (disp.accumulate && taken > 0) {
          computeEffectiveComposition(db, "finished", entry.productId).forEach(c => {
            const wasteQty = taken * ((Number(c.percentage) || 0) / 100);
            if (wasteQty <= 0) return;
            const ws = getWasteStreamForComponent(db, c.componentId);
            if (!ws || !ws.accumulate) return;
            repo.addLot(db, "wasteStreams", ws.id, {
              lotNumber: "", date: record.cancelledDate,
              qty: Math.round(wasteQty * 100) / 100,
              producedQty: Math.round(wasteQty * 100) / 100,
              notes: "From cancelled stock, lot " + (lot.lotNumber || lot.id),
              sources: [], actualEquipment: [], actualLabor: []
            });
          });
        }
      }
    }

    return { ok: true, cancellation: record, entry, disposition: disp.key };
  },

  /* Attach one uploaded file reference to a set of lots at once. */
  attachFileToLots(db, lots, attachment) {
    (lots || []).forEach(l => {
      repo.patchItemLot(db, l.itemType, l.itemId, l.lotId, { attachment });
    });
  }
};

/* ---------------------------------------------------------------
   Lookups - thin named wrappers over repo.find, kept because they
   read better at call sites than repo.find(d, "rawMaterials", id).
----------------------------------------------------------------*/
function getRaw(data, id) { return repo.find(data, "rawMaterials", id) || undefined; }
function getComponent(data, id) { return repo.find(data, "components", id) || undefined; }
function getIntermediateProduct(data, id) { return repo.find(data, "intermediateProducts", id) || undefined; }
function getFinished(data, id) { return repo.find(data, "finishedGoods", id) || undefined; }
function getEquipment(data, id) { return repo.find(data, "equipment", id) || undefined; }
function getCustomer(data, id) { return repo.find(data, "customers", id) || undefined; }
function getProcess(data, id) { return repo.find(data, "processes", id) || undefined; }

// Suggests the next batch lot number for a process on a given date, in
// the form PREFIX-YYDDD-NN: the process's own SKU as prefix, a 5-digit
// Julian-style date code, and a 2-digit counter that's the next unused
// sequence for that exact prefix+date, found by scanning every lot
// already recorded across intermediate products and finished goods.
// Self-healing rather than a stored counter - never gets out of sync
// with what's actually been logged, even across sessions.
function suggestBatchLotNumber(data, process, dateStr) {
  const prefix = ((process && process.sku) || "BATCH").toUpperCase().replace(/[^A-Z0-9]/g, "") || "BATCH";
  const base = prefix + "-" + julianDateCode(dateStr) + "-";
  let maxSeq = 0;
  [...data.intermediateProducts, ...data.finishedGoods].forEach(item => {
    (item.lots || []).forEach(lot => {
      if (lot.lotNumber && lot.lotNumber.startsWith(base)) {
        const num = parseInt(lot.lotNumber.slice(base.length), 10);
        if (!isNaN(num) && num > maxSeq) maxSeq = num;
      }
    });
  });
  return base + String(maxSeq + 1).padStart(2, "0");
}

function getWasteStream(data, id) { return repo.find(data, "wasteStreams", id) || undefined; }
function getWasteStreamForComponent(data, componentId) {
  return repo.list(data, "wasteStreams").find(w => w.componentId === componentId) || null;
}

// A component's cost always comes live from its linked raw material -
// there's no separately maintained cost on the component itself, so it
// can never drift out of sync with what's actually being paid for it.
// An unlinked component has no cost basis and contributes $0.
// A component's cost comes live from its linked raw material - but if
// that raw material has its own composition breakdown that includes this
// component (e.g. "Solid feedstock" is only 0.5% EX1 by mass, with 100%
// of the cost attributed to that 0.5%), the raw material's bulk unit
// cost has to be concentrated up to a true per-unit-of-pure-component
// cost: cost x (cost weight% / physical %). With no such breakdown (the
// common case - the raw material effectively *is* the component), the
// raw material's unit cost is used unadjusted, exactly as before.
function componentUnitCost(data, component) {
  if (!component || !component.rawMaterialId) return 0;
  const raw = getRaw(data, component.rawMaterialId);
  if (!raw) return 0;
  const compLine = (raw.composition || []).find(c => c.componentId === component.id);
  const physicalPct = compLine ? Number(compLine.percentage) || 0 : 0;
  if (compLine && physicalPct > 0) {
    const costPct = Number(effectiveCostWeight(compLine)) || 0;
    return raw.unitCost * (costPct / physicalPct);
  }
  return raw.unitCost;
}

function getCatalogItem(data, itemType, itemId) {
  if (itemType === "raw") return getRaw(data, itemId);
  if (itemType === "intermediate") return getIntermediateProduct(data, itemId);
  if (itemType === "finished") return getFinished(data, itemId);
  // Waste streams carry lots exactly like the others, and costing has to be
  // able to resolve them or every by-product reads as an unresolvable item.
  if (itemType === "waste") return getWasteStream(data, itemId);
  return null;
}

// The process that produces a given catalog item as an output. If more than
// one process is defined to produce the same item, the first one wins.
function findProcessForOutput(data, itemType, itemId) {
  return data.processes.find(p => (p.outputs || []).some(o => o.itemType === itemType && o.itemId === itemId)) || null;
}

function allCatalogOptions(data, includeRaw) {
  const opts = [];
  if (includeRaw) data.rawMaterials.forEach(r => opts.push({ itemType: "raw", itemId: r.id, label: r.name + " (raw)" }));
  data.intermediateProducts.forEach(i => opts.push({ itemType: "intermediate", itemId: i.id, label: i.name + " (intermediate)" }));
  data.finishedGoods.forEach(f => opts.push({ itemType: "finished", itemId: f.id, label: f.name + " (finished)" }));
  return opts;
}

/* ---------------------------------------------------------------
   Costing - unified, recursive through Processes. When no process
   produces an item, falls back to a composition-weighted estimate
   if the item has composition data, instead of defaulting to zero.
----------------------------------------------------------------*/
function computeItemUnitCost(data, itemType, itemId, path) {
  path = path || new Set();
  if (itemType === "raw") {
    const raw = getRaw(data, itemId);
    return raw ? raw.unitCost : 0;
  }
  const key = itemType + ":" + itemId;
  if (path.has(key)) return 0;
  const nextPath = new Set(path);
  nextPath.add(key);

  const process = findProcessForOutput(data, itemType, itemId);
  if (!process) {
    const item = getCatalogItem(data, itemType, itemId);
    if (item && item.composition && item.composition.length > 0) {
      return computeCompositionCost(data, item.composition);
    }
    return 0;
  }
  const outputLine = (process.outputs || []).find(o => o.itemType === itemType && o.itemId === itemId);
  if (outputLine && outputLine.costOverride !== undefined && outputLine.costOverride !== null && outputLine.costOverride !== "") {
    const n = parseFloat(outputLine.costOverride);
    if (!isNaN(n)) return n;
  }
  const batchCost = (process.inputs || []).reduce((sum, line) => sum + computeItemUnitCost(data, line.itemType, line.itemId, nextPath) * line.qty, 0);
  const totalUnits = (process.outputs || []).reduce((s, o) => s + (Number(o.qtyPerBatch) || 0), 0);
  return totalUnits > 0 ? batchCost / totalUnits : 0;
}

function computeProcessBatchCost(data, process) {
  return (process.inputs || []).reduce((sum, line) => sum + computeItemUnitCost(data, line.itemType, line.itemId) * line.qty, 0);
}

function getEffectivePrice(priceLine, qty) {
  if (!priceLine) return null;
  let price = Number(priceLine.basePrice) || 0;
  [...(priceLine.tiers || [])].sort((a, b) => a.minQty - b.minQty).forEach(t => {
    if (qty >= t.minQty) price = Number(t.price) || 0;
  });
  return price;
}

function priceLineMarginInfo(data, priceLine) {
  const unitCost = computeItemUnitCost(data, "finished", priceLine.finishedGoodId);
  const points = [
    { label: "Base", qty: 1, price: Number(priceLine.basePrice) || 0 },
    ...(priceLine.tiers || []).map(t => ({ label: fmtNum(t.minQty) + "+", qty: t.minQty, price: Number(t.price) || 0 }))
  ];
  const withMargin = points.map(p => ({
    ...p,
    margin: p.price - unitCost,
    marginPct: p.price > 0 ? ((p.price - unitCost) / p.price) * 100 : -999
  }));
  const minMarginPct = withMargin.length ? Math.min(...withMargin.map(p => p.marginPct)) : -999;
  return { unitCost, points: withMargin, minMarginPct };
}

/* ---------------------------------------------------------------
   Equipment utilization + maintenance helpers
----------------------------------------------------------------*/
function computeEquipmentUsageMap(data, horizonDays) {
  const active = data.schedule.filter(s =>
    (s.status === "Planned" || s.status === "In progress") && daysUntil(s.dueDate) <= horizonDays
  );
  const byEquipment = new Map();
  const addWindow = (equipmentId, w) => {
    const list = byEquipment.get(equipmentId) || [];
    list.push(w);
    byEquipment.set(equipmentId, list);
  };
  active.forEach(entry => {
    const { equipmentUsage } = computeTimeline(data, entry);
    (equipmentUsage || []).forEach(u => {
      addWindow(u.equipmentId, { start: u.start, end: u.end, status: u.status, label: productName(data, entry) + " → " + u.processName });
    });
  });

  const horizonStart = todayStr();
  const horizonEnd = addDays(horizonStart, horizonDays);
  (data.maintenance || []).forEach(m => {
    const occs = expandMaintenanceWindows(m, horizonStart, horizonEnd);
    occs.forEach(w => {
      addWindow(m.equipmentId, { start: w.start, end: w.end, status: "Maintenance", label: m.title || m.type });
    });
  });

  return byEquipment;
}

function detectConflicts(windows, units) {
  if (!windows || windows.length === 0) return { conflict: false, days: 0 };
  const counts = new Map();
  windows.forEach(w => {
    let d = w.start;
    let guard = 0;
    while (d <= w.end && guard < 400) {
      counts.set(d, (counts.get(d) || 0) + 1);
      d = addDays(d, 1);
      guard++;
    }
  });
  const conflictDays = [...counts.values()].filter(c => c > (units || 1)).length;
  return { conflict: conflictDays > 0, days: conflictDays };
}

function expandMaintenanceWindows(entry, horizonStart, horizonEnd) {
  const windows = [];
  if (!entry || entry.status !== "Scheduled") return windows;
  const step = entry.recurrence === "Daily" ? 1
    : entry.recurrence === "Weekly" ? 7
    : entry.recurrence === "Monthly" ? 30
    : entry.recurrence === "Quarterly" ? 91
    : entry.recurrence === "Semi-annual" ? 182
    : entry.recurrence === "Annual" ? 365
    : null;
  const limit = entry.recurUntil || horizonEnd;
  let occStart = entry.startDate;
  let guard = 0;
  while (occStart <= horizonEnd && occStart <= limit && guard < 500) {
    const durationHours = Number(entry.durationHours) || 24;
    const occEnd = addDays(occStart, Math.max(0, Math.ceil(durationHours / 24) - 1));
    if (occEnd >= horizonStart) windows.push({ start: occStart, end: occEnd });
    if (!step) break;
    occStart = addDays(occStart, step);
    guard++;
  }
  return windows;
}

/* ---------------------------------------------------------------
   Seed data
----------------------------------------------------------------*/
/* Bumped whenever the sample dataset changes shape or subject. Stored
   alongside the data so a console still holding an older sample can say
   so, rather than the new one being invisible forever behind whatever is
   already in storage. */
const SEED_VERSION = "coffee-2026-07";

// Phase 3 — warehouse cataloging seed. Decorates each catalog item with a
// default packaging (a distinct storable SKU), a shelf life, and stamps each of
// its lots with that packaging, a production date and a computed expiry (plus an
// arrival date and origin where the source is known). Run as one pass at the end
// of seedData so the large item/lot construction above stays untouched. Every
// value is deterministic (no now()), so the seed stays reproducible.
const SEED_SHELF_LIFE = { raw: 365, intermediate: 180, finished: 540, waste: 90 };
function seedWarehouseCatalog(cols) {
  const addDays = (iso, n) => {
    if (!iso || !n) return "";
    const d = new Date(iso + "T00:00:00Z");
    if (isNaN(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() + Number(n));
    return d.toISOString().slice(0, 10);
  };
  const skuSuffix = (size) => size.replace(/[^0-9a-zA-Z]+/g, "").toUpperCase();
  // [packageType, size, unitsPerPackage, packagesPerSlot]. unitsPerPackage is
  // how many of the item's OWN unit fit in one container, so ordering by the
  // container conserves units: containers x unitsPerPackage = quantity. A
  // placeholder of 1 here would have a 55 gal drum holding one kilogram, and
  // every purchase order raised off it would read as nonsense.
  const packsFor = (type, unit) => {
    if (type === "intermediate") return [["tote", "1000 kg", 1000, 1]];
    if (type === "waste") return [["barrel", "200 kg", 200, 1]];
    if (type === "finished") return [["case", "case of 12", 12, 40], ["case", "case of 24", 24, 24]];
    // Raw materials are bought in whatever their own unit is measured in.
    if (unit === "kg") return [["sack", "60 kg", 60, 12]];
    if (unit === "L") return [["drum", "200 L", 200, 4]];
    return [["case", "case of 1000", 1000, 20]];
  };
  const plan = [
    ["raw", cols.rawMaterials],
    ["intermediate", cols.intermediateProducts],
    ["finished", cols.finishedGoods],
    ["waste", cols.wasteStreams]
  ];
  plan.forEach(([type, list]) => {
    (list || []).forEach((item) => {
      if (item.shelfLifeDays == null) item.shelfLifeDays = SEED_SHELF_LIFE[type];
      if (item.physicallyStored == null) item.physicallyStored = true;
      if (!Array.isArray(item.packagings) || !item.packagings.length) {
        item.packagings = packsFor(type, item.unit).map(([packageType, size, unitsPerPackage, packagesPerSlot], i) => ({
          id: uid(),
          sku: item.sku + "-" + skuSuffix(size),
          packageType, size, unitsPerPackage, packagesPerSlot,
          isDefault: i === 0
        }));
      }
      const def = item.packagings[0];
      (item.lots || []).forEach((lot) => {
        if (!lot.packagingId) lot.packagingId = def.id;
        if (!lot.productionDate) lot.productionDate = lot.date || "";
        if (!lot.expirationDate && lot.productionDate) {
          lot.expirationDate = addDays(lot.productionDate, item.shelfLifeDays);
        }
        if (!lot.arrivalDate && type === "raw") lot.arrivalDate = lot.date || "";
        if (!lot.origin) lot.origin = item.supplier || (type === "raw" ? "Supplier" : "Evoia Plant");
      });
    });
  });
}

function seedData() {
  /* ===============================================================
     Seed: instant coffee facility

     Green coffee in, soluble powder out, through sorting, roasting,
     grinding, extraction, concentration, spray drying and packing.
     Three blends across four pack formats.

     The production history is GENERATED rather than typed, so the
     lot chain actually hangs together: every powder lot names the
     concentrate it came from, which names the extract, and so on
     back to a specific green coffee delivery. Hand-written history
     tends to be shallow and internally inconsistent, which is the
     opposite of a stress test.

     The generator is deterministic - same data every load - so the
     tests can assert on it and two people see the same numbers.
  =============================================================== */

  // Small deterministic PRNG. Seeded once, never reseeded.
  let _s = 0x6d2b79f5 ^ 20260301;
  const rnd = () => {
    _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
    let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const vary = (base, pct) => Math.round(base * (1 + (rnd() - 0.5) * 2 * pct) * 100) / 100;
  const iso = (dt) => dt.toISOString().slice(0, 10);
  const day = (from, n) => iso(new Date(Date.parse(from + "T00:00:00Z") + n * 86400000));
  const isWeekday = (d) => {
    const w = new Date(d + "T00:00:00Z").getUTCDay();
    return w >= 1 && w <= 5;
  };

  /* --- components: what the lab actually measures ---------------- */
  const comp = (over) => ({
    id: uid(), name: "", unit: "%", rawMaterialId: "", notes: "",
    qcCalibration: { enabled: false, measurementLabel: "", measurementUnit: "", slope: 1, intercept: 0 },
    ...over
  });
  const cSolubles = comp({
    name: "Soluble solids", notes: "Extractable coffee solids. Drives yield through the whole plant.",
    qcCalibration: { enabled: true, measurementLabel: "Refractometer Brix", measurementUnit: "\u00b0Bx", slope: 0.98, intercept: 0.4 }
  });
  const cCaffeine = comp({
    name: "Caffeine", notes: "Specification item on every finished blend.",
    qcCalibration: { enabled: true, measurementLabel: "UV absorbance", measurementUnit: "AU", slope: 12.5, intercept: 0.05 }
  });
  const cMoisture = comp({
    name: "Moisture", notes: "Above 5% in powder and it cakes in the jar.",
    qcCalibration: { enabled: true, measurementLabel: "Halogen moisture balance", measurementUnit: "%", slope: 1, intercept: 0 }
  });
  const cOils = comp({ name: "Coffee oils", notes: "Aroma carrier. Largely lost to the spent grounds." });
  const cFibre = comp({ name: "Insoluble fibre", notes: "Cellulose and cell wall. Leaves as spent grounds." });
  const cAcids = comp({ name: "Chlorogenic acids", notes: "Roast-degraded. Tracks perceived acidity." });
  const cAsh = comp({ name: "Ash", notes: "Mineral residue." });
  const cGlass = comp({ name: "Glass", unit: "%", notes: "Jar body. Recyclable stream." });
  const cLaminate = comp({ name: "Laminate film", unit: "%", notes: "Sachet and pouch web. Not recyclable." });
  const cBoard = comp({ name: "Cartonboard", unit: "%", notes: "Cases and sachet outers." });
  const components = [cSolubles, cCaffeine, cMoisture, cOils, cFibre, cAcids, cAsh, cGlass, cLaminate, cBoard];

  /* --- raw materials --------------------------------------------- */
  const rm = (over) => ({
    id: uid(), name: "", sku: "", supplier: "", unitCost: 0, unit: "kg",
    certStatus: "Not required", leadTimeDays: 30, moq: 1000, reorderPoint: 2000,
    onOrder: 0, notes: "", composition: [], lots: [], ...over
  });
  const cmp = (c, pct, w) => ({ id: uid(), componentId: c.id, percentage: pct, costWeight: w === undefined ? pct : w });

  const greenBrazil = rm({
    name: "Green coffee \u2014 Brazil Santos 17/18", sku: "GC-BR-SANTOS", supplier: "Comexim Trading",
    unitCost: 4.85, certStatus: "Certificate on file", leadTimeDays: 45, moq: 18000, reorderPoint: 24000,
    notes: "Workhorse arabica. Nutty, low acid, forgiving on the roast.",
    composition: [cmp(cSolubles, 28), cmp(cFibre, 46), cmp(cMoisture, 11),
                  cmp(cOils, 8), cmp(cAcids, 5), cmp(cCaffeine, 1.2), cmp(cAsh, 0.8)]
  });
  const greenColombia = rm({
    name: "Green coffee \u2014 Colombia Excelso", sku: "GC-CO-EXCELSO", supplier: "Racafe S.A.",
    unitCost: 6.20, certStatus: "Certificate on file", leadTimeDays: 50, moq: 18000, reorderPoint: 18000,
    notes: "Bright and aromatic. Carries the premium blend.",
    composition: [cmp(cSolubles, 27), cmp(cFibre, 45), cmp(cMoisture, 11.5),
                  cmp(cOils, 8.5), cmp(cAcids, 6), cmp(cCaffeine, 1.3), cmp(cAsh, 0.7)]
  });
  const greenRobusta = rm({
    name: "Green coffee \u2014 Vietnam Robusta G2", sku: "GC-VN-ROB-G2", supplier: "Intimex Group",
    unitCost: 3.15, certStatus: "Certificate on file", leadTimeDays: 40, moq: 24000, reorderPoint: 30000,
    notes: "High soluble yield and double the caffeine. Body and crema in the cup.",
    composition: [cmp(cSolubles, 34), cmp(cFibre, 43), cmp(cMoisture, 10.5),
                  cmp(cOils, 6), cmp(cAcids, 4.2), cmp(cCaffeine, 2.4), cmp(cAsh, 0.9)]
  });
  const greenEthiopia = rm({
    name: "Green coffee \u2014 Ethiopia Sidamo G4", sku: "GC-ET-SIDAMO", supplier: "Moplaco Trading",
    unitCost: 7.40, certStatus: "Certificate on file", leadTimeDays: 55, moq: 9000, reorderPoint: 9000,
    notes: "Floral top notes. Small inclusion, large effect.",
    composition: [cmp(cSolubles, 26), cmp(cFibre, 46), cmp(cMoisture, 11),
                  cmp(cOils, 9), cmp(cAcids, 6.4), cmp(cCaffeine, 1.1), cmp(cAsh, 0.5)]
  });

  const jar100 = rm({ name: "Glass jar 100g with lid", sku: "PK-JAR-100", supplier: "Verallia UK",
    unitCost: 0.21, unit: "ea", leadTimeDays: 21, moq: 20000, reorderPoint: 40000,
    notes: "Amber glass, 63mm neck. Lid supplied fitted.", composition: [cmp(cGlass, 100)] });
  const jar200 = rm({ name: "Glass jar 200g with lid", sku: "PK-JAR-200", supplier: "Verallia UK",
    unitCost: 0.29, unit: "ea", leadTimeDays: 21, moq: 15000, reorderPoint: 30000,
    notes: "Amber glass, 70mm neck.", composition: [cmp(cGlass, 100)] });
  const sachetFilm = rm({ name: "Sachet laminate web 120mm", sku: "PK-FILM-SACH", supplier: "Amcor Flexibles",
    unitCost: 0.011, unit: "ea", leadTimeDays: 28, moq: 500000, reorderPoint: 400000,
    notes: "PET/ALU/PE. One unit is one sachet's worth of web.", composition: [cmp(cLaminate, 100)] });
  const pouch500 = rm({ name: "Foodservice pouch 500g", sku: "PK-POUCH-500", supplier: "Amcor Flexibles",
    unitCost: 0.34, unit: "ea", leadTimeDays: 28, moq: 10000, reorderPoint: 12000,
    notes: "Gusseted, degassing valve.", composition: [cmp(cLaminate, 100)] });
  const carton25 = rm({ name: "Sachet outer carton, 25 count", sku: "PK-CTN-25", supplier: "DS Smith",
    unitCost: 0.16, unit: "ea", leadTimeDays: 14, moq: 20000, reorderPoint: 25000,
    composition: [cmp(cBoard, 100)] });
  const caseBox = rm({ name: "Shipping case, corrugated", sku: "PK-CASE", supplier: "DS Smith",
    unitCost: 0.42, unit: "ea", leadTimeDays: 14, moq: 10000, reorderPoint: 15000,
    composition: [cmp(cBoard, 100)] });
  const labels = rm({ name: "Pressure-sensitive label roll", sku: "PK-LABEL", supplier: "Reflex Labels",
    unitCost: 0.035, unit: "ea", leadTimeDays: 14, moq: 50000, reorderPoint: 60000 });
  const nitrogen = rm({ name: "Nitrogen, food grade", sku: "GAS-N2", supplier: "BOC Industrial",
    unitCost: 1.85, unit: "m3", leadTimeDays: 5, moq: 200, reorderPoint: 300,
    notes: "Headspace flush. Keeps oxidation off the powder." });

  const rawMaterials = [greenBrazil, greenColombia, greenRobusta, greenEthiopia,
    jar100, jar200, sachetFilm, pouch500, carton25, caseBox, labels, nitrogen];

  /* --- equipment -------------------------------------------------- */
  const eq = (over) => ({ id: uid(), name: "", code: "", units: 1, notes: "", calendarId: "", ...over });
  const eSorter = eq({ name: "Optical + density sorter", code: "SORT-1", units: 1,
    notes: "Colour camera and gravity table in series. Rejects to the defect bin." });
  const eRoaster1 = eq({ name: "Fluid-bed roaster 1", code: "ROAST-1", units: 1, notes: "600 kg/h nominal." });
  const eRoaster2 = eq({ name: "Fluid-bed roaster 2", code: "ROAST-2", units: 1, notes: "600 kg/h. Installed 2024." });
  const eGrinder = eq({ name: "Roller grinder", code: "GRIND-1", units: 2,
    notes: "Two identical stands. Coarse setting for extraction." });
  const eExtract = eq({ name: "Percolation battery", code: "EXTR-1", units: 1,
    notes: "Six columns, counter-current. The plant bottleneck." });
  const eEvap = eq({ name: "Falling-film evaporator", code: "EVAP-1", units: 1,
    notes: "Three effects. 12% to 45% solids." });
  const eDryer = eq({ name: "Spray dryer", code: "DRY-1", units: 1,
    notes: "Co-current, 18m tower. The other bottleneck." });
  const eJarLine = eq({ name: "Jar filling line", code: "PACK-JAR", units: 1, notes: "Handles both jar sizes." });
  const eSachetLine = eq({ name: "Sachet stickpack line", code: "PACK-SACH", units: 2, notes: "Two lanes." });
  const ePouchLine = eq({ name: "Bulk pouch line", code: "PACK-POUCH", units: 1 });
  const eCasePack = eq({ name: "Case packer and palletiser", code: "CASE-1", units: 1 });
  const equipment = [eSorter, eRoaster1, eRoaster2, eGrinder, eExtract, eEvap, eDryer,
    eJarLine, eSachetLine, ePouchLine, eCasePack];

  /* --- operating calendars ---------------------------------------- */
  const calMain = {
    id: uid(), name: "Plant hours", isDefault: true,
    hoursMon: 16, hoursTue: 16, hoursWed: 16, hoursThu: 16, hoursFri: 16,
    hoursSat: 8, hoursSun: 0,
    notes: "Two shifts weekdays, one on Saturday.",
    closures: [
      { id: uid(), startDate: "2026-08-24", endDate: "2026-08-24", reason: "Summer bank holiday" },
      { id: uid(), startDate: "2026-12-24", endDate: "2027-01-01", reason: "Christmas shutdown" }
    ],
    overrides: []
  };
  const calDryer = {
    id: uid(), name: "Dryer \u2014 continuous", isDefault: false,
    hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 24, hoursSun: 12,
    notes: "The tower is expensive to start and stop, so it runs through.",
    closures: [{ id: uid(), startDate: "2026-09-14", endDate: "2026-09-18", reason: "Annual tower inspection" }],
    overrides: []
  };
  eDryer.calendarId = calDryer.id;
  eEvap.calendarId = calDryer.id;
  const operatingCalendars = [calMain, calDryer];

  /* --- intermediate products -------------------------------------- */
  const ip = (over) => ({
    id: uid(), name: "", sku: "", unit: "kg", notes: "", composition: [],
    autoComposition: true, hazardClass: "Not classified", lots: [], ...over
  });
  const sortedBR = ip({ name: "Sorted green \u2014 Brazil", sku: "IP-SORT-BR" });
  const sortedCO = ip({ name: "Sorted green \u2014 Colombia", sku: "IP-SORT-CO" });
  const sortedVN = ip({ name: "Sorted green \u2014 Robusta", sku: "IP-SORT-VN" });
  const sortedET = ip({ name: "Sorted green \u2014 Ethiopia", sku: "IP-SORT-ET" });
  const roastedClassic = ip({ name: "Roasted blend \u2014 Classic", sku: "IP-ROAST-CLS", notes: "Medium roast, 60/40 Brazil/Robusta." });
  const roastedRich = ip({ name: "Roasted blend \u2014 Rich", sku: "IP-ROAST-RCH", notes: "Dark roast, Robusta-forward." });
  const roastedPremium = ip({ name: "Roasted blend \u2014 Premium", sku: "IP-ROAST-PRM", notes: "Light-medium. Colombia with an Ethiopia top note." });
  const groundClassic = ip({ name: "Ground coffee \u2014 Classic", sku: "IP-GRIND-CLS" });
  const groundRich = ip({ name: "Ground coffee \u2014 Rich", sku: "IP-GRIND-RCH" });
  const groundPremium = ip({ name: "Ground coffee \u2014 Premium", sku: "IP-GRIND-PRM" });
  const extractClassic = ip({ name: "Extract 12% \u2014 Classic", sku: "IP-EXT-CLS", unit: "L" });
  const extractRich = ip({ name: "Extract 12% \u2014 Rich", sku: "IP-EXT-RCH", unit: "L" });
  const extractPremium = ip({ name: "Extract 12% \u2014 Premium", sku: "IP-EXT-PRM", unit: "L" });
  const concClassic = ip({ name: "Concentrate 45% \u2014 Classic", sku: "IP-CONC-CLS", unit: "L" });
  const concRich = ip({ name: "Concentrate 45% \u2014 Rich", sku: "IP-CONC-RCH", unit: "L" });
  const concPremium = ip({ name: "Concentrate 45% \u2014 Premium", sku: "IP-CONC-PRM", unit: "L" });
  const powderClassic = ip({ name: "Instant powder \u2014 Classic", sku: "IP-PWD-CLS", notes: "Agglomerated, 3.5% moisture spec." });
  const powderRich = ip({ name: "Instant powder \u2014 Rich", sku: "IP-PWD-RCH" });
  const powderPremium = ip({ name: "Instant powder \u2014 Premium", sku: "IP-PWD-PRM" });

  const intermediateProducts = [sortedBR, sortedCO, sortedVN, sortedET,
    roastedClassic, roastedRich, roastedPremium,
    groundClassic, groundRich, groundPremium,
    extractClassic, extractRich, extractPremium,
    concClassic, concRich, concPremium,
    powderClassic, powderRich, powderPremium];

  /* --- finished goods: 3 blends x 4 formats ------------------------ */
  const fg = (over) => ({
    id: uid(), name: "", sku: "", unit: "ea", notes: "", composition: [],
    autoComposition: true, hazardClass: "Not classified", lots: [], ...over
  });
  const BLENDS = [
    { key: "CLS", label: "Classic Gold", powder: powderClassic, ground: groundClassic,
      roast: roastedClassic, extract: extractClassic, conc: concClassic },
    { key: "RCH", label: "Rich Roast", powder: powderRich, ground: groundRich,
      roast: roastedRich, extract: extractRich, conc: concRich },
    { key: "PRM", label: "Premium Reserve", powder: powderPremium, ground: groundPremium,
      roast: roastedPremium, extract: extractPremium, conc: concPremium }
  ];
  const FORMATS = [
    { key: "J100", label: "100g jar", grams: 100, price: 3.10 },
    { key: "J200", label: "200g jar", grams: 200, price: 5.40 },
    { key: "S25", label: "25 x 2g sachets", grams: 50, price: 2.85 },
    { key: "P500", label: "500g foodservice pouch", grams: 500, price: 9.75 }
  ];
  const finishedGoods = [];
  BLENDS.forEach(b => FORMATS.forEach(fmt => {
    finishedGoods.push(fg({
      name: b.label + " \u2014 " + fmt.label,
      sku: "FG-" + b.key + "-" + fmt.key,
      notes: fmt.grams + "g net. " + b.label + " blend.",
      _blend: b, _format: fmt
    }));
  }));

  /* --- waste streams ---------------------------------------------- */
  const ws = (over) => ({
    id: uid(), name: "", sku: "", unit: "kg", notes: "", componentId: "",
    accumulate: true, hazardClass: "Not classified", lots: [], ...over
  });
  const wReject = ws({ name: "Sorter rejects", sku: "WS-REJECT", componentId: cFibre.id,
    notes: "Defect beans and stones. Sold on as animal feed." });
  const wChaff = ws({ name: "Roaster chaff", sku: "WS-CHAFF", componentId: cFibre.id,
    notes: "Silverskin. Collected in the cyclone." });
  const wGrounds = ws({ name: "Spent coffee grounds", sku: "WS-GROUNDS", componentId: cFibre.id,
    notes: "The big one by mass. Goes to anaerobic digestion." });
  const wCondensate = ws({ name: "Evaporator condensate", sku: "WS-COND", unit: "L", componentId: cMoisture.id,
    notes: "Aroma-stripped water. To trade effluent." });
  const wFines = ws({ name: "Dryer fines", sku: "WS-FINES", componentId: cSolubles.id,
    notes: "Cyclone catch. Partly reworked into the next batch." });
  const wasteStreams = [wReject, wChaff, wGrounds, wCondensate, wFines];

  /* --- processes --------------------------------------------------- */
  const pIn = (type, item, qty) => ({ id: uid(), itemType: type, itemId: item.id, qty });
  const pOut = (type, item, per) => ({ id: uid(), itemType: type, itemId: item.id, qtyPerBatch: per, costOverride: "" });
  const pEq = (e) => ({ id: uid(), equipmentId: e.id, status: "Required" });
  const proc = (over) => ({ id: uid(), name: "", sku: "", productionTimeHours: 4, notes: "",
    inputs: [], equipment: [], outputs: [], ...over });

  const processes = [];

  // 1. Sorting, one per origin
  [[greenBrazil, sortedBR, "BR"], [greenColombia, sortedCO, "CO"],
   [greenRobusta, sortedVN, "VN"], [greenEthiopia, sortedET, "ET"]].forEach(([raw, out, tag]) => {
    processes.push(proc({
      name: "Sort green coffee \u2014 " + tag, sku: "PR-SORT-" + tag, productionTimeHours: 3,
      notes: "Optical and density sort. About 3% comes out as rejects.",
      inputs: [pIn("raw", raw, 1000)], equipment: [pEq(eSorter)],
      outputs: [pOut("intermediate", out, 970)]
    }));
  });

  // 2. Roasting, one per blend, consuming sorted origins
  processes.push(proc({
    name: "Roast \u2014 Classic blend", sku: "PR-ROAST-CLS", productionTimeHours: 5,
    notes: "60% Brazil, 40% Robusta. Medium roast, 14% roast loss.",
    inputs: [pIn("intermediate", sortedBR, 600), pIn("intermediate", sortedVN, 400)],
    equipment: [pEq(eRoaster1)],
    outputs: [pOut("intermediate", roastedClassic, 860)]
  }));
  processes.push(proc({
    name: "Roast \u2014 Rich blend", sku: "PR-ROAST-RCH", productionTimeHours: 5,
    notes: "30% Brazil, 70% Robusta. Dark roast, 16% loss.",
    inputs: [pIn("intermediate", sortedBR, 300), pIn("intermediate", sortedVN, 700)],
    equipment: [pEq(eRoaster2)],
    outputs: [pOut("intermediate", roastedRich, 840)]
  }));
  processes.push(proc({
    name: "Roast \u2014 Premium blend", sku: "PR-ROAST-PRM", productionTimeHours: 5,
    notes: "70% Colombia, 15% Ethiopia, 15% Brazil. Light-medium, 13% loss.",
    inputs: [pIn("intermediate", sortedCO, 700), pIn("intermediate", sortedET, 150),
             pIn("intermediate", sortedBR, 150)],
    equipment: [pEq(eRoaster1)],
    outputs: [pOut("intermediate", roastedPremium, 870)]
  }));

  // 3. Grinding
  BLENDS.forEach(b => {
    processes.push(proc({
      name: "Grind \u2014 " + b.label, sku: "PR-GRIND-" + b.key, productionTimeHours: 2,
      notes: "Coarse grind for percolation. Minimal loss.",
      inputs: [pIn("intermediate", b.roast, 1000)], equipment: [pEq(eGrinder)],
      outputs: [pOut("intermediate", b.ground, 995)]
    }));
  });

  // 4. Extraction
  BLENDS.forEach(b => {
    processes.push(proc({
      name: "Extract \u2014 " + b.label, sku: "PR-EXTR-" + b.key, productionTimeHours: 8,
      notes: "Counter-current percolation to 12% solids. Spent grounds leave wet.",
      inputs: [pIn("intermediate", b.ground, 1000)], equipment: [pEq(eExtract)],
      outputs: [pOut("intermediate", b.extract, 2400)]
    }));
  });

  // 5. Concentration
  BLENDS.forEach(b => {
    processes.push(proc({
      name: "Concentrate \u2014 " + b.label, sku: "PR-CONC-" + b.key, productionTimeHours: 6,
      notes: "12% to 45% solids. Roughly three quarters leaves as condensate.",
      inputs: [pIn("intermediate", b.extract, 2400)], equipment: [pEq(eEvap)],
      outputs: [pOut("intermediate", b.conc, 640)]
    }));
  });

  // 6. Spray drying
  BLENDS.forEach(b => {
    processes.push(proc({
      name: "Spray dry \u2014 " + b.label, sku: "PR-DRY-" + b.key, productionTimeHours: 10,
      notes: "Tower drying and agglomeration to 3.5% moisture.",
      inputs: [pIn("intermediate", b.conc, 640)], equipment: [pEq(eDryer)],
      outputs: [pOut("intermediate", b.powder, 288)]
    }));
  });

  // 7. Packing, one process per blend and format
  finishedGoods.forEach(item => {
    const b = item._blend, fmt = item._format;
    const unitsPerBatch = fmt.key === "S25" ? 4000 : fmt.key === "P500" ? 1200 : fmt.key === "J200" ? 3000 : 6000;
    const powderKg = Math.round(unitsPerBatch * fmt.grams / 1000);
    const inputs = [pIn("intermediate", b.powder, powderKg)];
    let line = eJarLine;
    if (fmt.key === "J100") { inputs.push(pIn("raw", jar100, unitsPerBatch), pIn("raw", labels, unitsPerBatch)); }
    if (fmt.key === "J200") { inputs.push(pIn("raw", jar200, unitsPerBatch), pIn("raw", labels, unitsPerBatch)); }
    if (fmt.key === "S25") {
      line = eSachetLine;
      inputs.push(pIn("raw", sachetFilm, unitsPerBatch * 25), pIn("raw", carton25, unitsPerBatch));
    }
    if (fmt.key === "P500") { line = ePouchLine; inputs.push(pIn("raw", pouch500, unitsPerBatch)); }
    inputs.push(pIn("raw", caseBox, Math.ceil(unitsPerBatch / 12)));
    inputs.push(pIn("raw", nitrogen, Math.round(unitsPerBatch / 400)));
    processes.push(proc({
      name: "Pack \u2014 " + item.name, sku: "PR-PACK-" + b.key + "-" + fmt.key,
      productionTimeHours: fmt.key === "S25" ? 7 : 5,
      notes: "Fill, flush with nitrogen, seal, case pack.",
      inputs, equipment: [pEq(line), pEq(eCasePack)],
      outputs: [pOut("finished", item, unitsPerBatch)]
    }));
  });

  /* --- customers ---------------------------------------------------- */
  const addr = (over) => ({ id: uid(), label: "Delivery", line1: "", line2: "", city: "",
    region: "", postalCode: "", country: "United Kingdom", ...over });
  const priceOf = (item, mult) => ({
    id: uid(), finishedGoodId: item.id,
    basePrice: Math.round(item._format.price * mult * 100) / 100,
    tiers: [
      { id: uid(), minQty: 5000, price: Math.round(item._format.price * mult * 0.95 * 100) / 100 },
      { id: uid(), minQty: 20000, price: Math.round(item._format.price * mult * 0.89 * 100) / 100 }
    ]
  });
  const custRetail = {
    id: uid(), name: "Northgate Supermarkets", code: "CUST-NGS",
    notes: "Own-label and branded. Weekly call-off against a rolling forecast.",
    addresses: [addr({ label: "Bardon RDC", line1: "Interlink Way West", city: "Coalville",
      region: "Leicestershire", postalCode: "LE67 1LE" })],
    priceList: finishedGoods.filter(x => x._format.key !== "P500").map(x => priceOf(x, 1))
  };
  const custFoodservice = {
    id: uid(), name: "Meridian Foodservice", code: "CUST-MFS",
    notes: "Bulk pouches and sachets for hotels and contract catering.",
    addresses: [addr({ label: "Avonmouth depot", line1: "Kings Weston Lane", city: "Bristol",
      region: "Avon", postalCode: "BS11 8AZ" })],
    priceList: finishedGoods.filter(x => x._format.key === "P500" || x._format.key === "S25")
      .map(x => priceOf(x, 0.92))
  };
  const custExport = {
    id: uid(), name: "Lindqvist Import AB", code: "CUST-LIA",
    notes: "Nordic distributor. Jars only, export cartons.",
    addresses: [addr({ label: "Gothenburg", line1: "Ringögatan 12", city: "G\u00f6teborg",
      region: "V\u00e4stra G\u00f6taland", postalCode: "417 07", country: "Sweden" })],
    priceList: finishedGoods.filter(x => x._format.key === "J100" || x._format.key === "J200")
      .map(x => priceOf(x, 1.08))
  };
  const custPrivate = {
    id: uid(), name: "Halewood Private Label", code: "CUST-HPL",
    notes: "Contract packing for a discounter. Classic blend only.",
    addresses: [addr({ label: "Knowsley", line1: "Ashcroft Road", city: "Liverpool",
      region: "Merseyside", postalCode: "L33 7TX" })],
    priceList: finishedGoods.filter(x => x._blend.key === "CLS").map(x => priceOf(x, 0.86))
  };
  const customers = [custRetail, custFoodservice, custExport, custPrivate];

  /* --- maintenance -------------------------------------------------- */
  const maintenance = [
    { id: uid(), equipmentId: eDryer.id, title: "Tower wash-down and nozzle service", type: "Preventive",
      startDate: "2026-08-10", durationHours: 16, recurrence: "Monthly", recurUntil: "2027-06-30",
      status: "Scheduled", notes: "Dryer is down for the full shift." },
    { id: uid(), equipmentId: eExtract.id, title: "Column seal replacement", type: "Preventive",
      startDate: "2026-08-19", durationHours: 12, recurrence: "Quarterly", recurUntil: "2027-08-31",
      status: "Scheduled", notes: "" },
    { id: uid(), equipmentId: eRoaster1.id, title: "Burner calibration", type: "Preventive",
      startDate: "2026-09-02", durationHours: 6, recurrence: "Quarterly", recurUntil: "2027-09-30",
      status: "Scheduled", notes: "" },
    { id: uid(), equipmentId: eEvap.id, title: "Effect descale", type: "Preventive",
      startDate: "2026-09-21", durationHours: 20, recurrence: "None", recurUntil: "",
      status: "Scheduled", notes: "Scale build-up on the third effect." },
    { id: uid(), equipmentId: eSachetLine.id, title: "Sealing jaw replacement", type: "Corrective",
      startDate: "2026-08-05", durationHours: 4, recurrence: "None", recurUntil: "",
      status: "Scheduled", notes: "Lane 2 has been running seal defects." }
  ];

  /* ===============================================================
     Production history, March to late July.

     Each pass walks the chain in order so the sources always exist
     before something consumes them.
  =============================================================== */
  const HISTORY_START = "2026-03-02";
  const HISTORY_END = "2026-07-24";
  const OPERATORS = ["R. Achebe", "M. Silva", "K. Dunn", "J. Novak", "P. Osei", "L. Haugen"];
  const CARRIERS = ["Wincanton", "DHL Supply Chain", "XPO Logistics", "Gregory Distribution",
                    "Culina Group", "Maritime Transport"];

  const lotSeq = {};
  const lotNo = (prefix, dateStr) => {
    const ym = dateStr.slice(2, 4) + dateStr.slice(5, 7);
    const key = prefix + ym;
    lotSeq[key] = (lotSeq[key] || 0) + 1;
    return prefix + "-" + ym + "-" + String(lotSeq[key]).padStart(3, "0");
  };
  const mkLot = (item, prefix, dateStr, qty, extra) => {
    const made = Math.round(qty * 100) / 100;
    const lot = {
      id: uid(), lotNumber: lotNo(prefix, dateStr), date: dateStr,
      qty: made, producedQty: made, notes: "",
      unitCost: "", batchId: "", processId: "",
      sources: [], actualEquipment: [], actualLabor: [], qcChecks: [],
      usedDate: "", consumedDate: "", ...(extra || {})
    };
    item.lots.push(lot);
    return lot;
  };

  /* Purchased price at a given date. Green coffee drifts with the market and
     two origins take a real step up mid-period, which is the case lot-level
     costing exists to show: batches made before the increase must keep their
     original cost. */
  const PRICE_MOVES = {
    "GC-BR-SANTOS": [["2026-03-02", 4.55], ["2026-05-18", 5.35], ["2026-07-06", 5.60]],
    "GC-CO-EXCELSO": [["2026-03-02", 5.95], ["2026-06-01", 6.20]],
    "GC-VN-ROB-G2": [["2026-03-02", 2.80], ["2026-04-27", 3.15], ["2026-06-15", 3.85]],
    "GC-ET-SIDAMO": [["2026-03-02", 7.10], ["2026-06-22", 7.75]]
  };
  const priceAt = (material, dateStr) => {
    const moves = PRICE_MOVES[material.sku];
    if (!moves) return vary(material.unitCost, 0.02);
    let price = moves[0][1];
    moves.forEach(([from, p]) => { if (dateStr >= from) price = p; });
    return Math.round(price * (1 + (rnd() - 0.5) * 0.02) * 10000) / 10000;
  };
  const src = (itemType, item, lot, qty) => ({
    id: uid(), groupKey: itemType + ":" + item.id, lotId: lot.id, qty: Math.round(qty * 100) / 100
  });
  const useEq = (e, hours) => ({ id: uid(), equipmentId: e.id, hours: Math.round(hours * 10) / 10 });
  const useLabour = (hours) => ({ id: uid(), operatorName: pick(OPERATORS), hours: Math.round(hours * 10) / 10 });
  const qc = (c, value, mode) => ({
    id: uid(), componentId: c.id, mode: mode || "manual",
    measuredValue: Math.round(value * 100) / 100, concentration: Math.round(value * 100) / 100
  });
  const draw = (lot, qty) => {
    lot.qty = Math.round((lot.qty - qty) * 100) / 100;
    if (!lot.usedDate) lot.usedDate = "";
    if (lot.qty <= 0.01) { lot.qty = 0; }
    return qty;
  };

  /* Every delivery in the history came from an order, so the orders are
     generated alongside the lots rather than bolted on: same reference on
     both, receipt pointing at the lot it created. Some run late, a couple
     arrive in two instalments, and a few are still outstanding - otherwise
     the delivery-performance view has nothing to show. */
  const purchaseOrders = [];
  let poSeq = 4100;
  const mkOrder = (raw, orderDate, qty, expectedDate, over) => {
    const po = {
      id: uid(), reference: "PO-" + (++poSeq),
      rawMaterialId: raw.id, supplier: raw.supplier,
      orderDate, qty: Math.round(qty * 100) / 100,
      unitCost: priceAt(raw, orderDate),
      expectedDate, status: "Ordered", notes: "", receipts: [],
      ...(over || {})
    };
    purchaseOrders.push(po);
    return po;
  };
  const receiveOrder = (po, lot, qty, date) => {
    po.receipts.push({ id: uid(), date, qty: Math.round(qty * 100) / 100, lotId: lot.id, notes: "" });
    po.status = poReceivedQty(po) + 0.001 < po.qty ? "Part received" : "Received";
  };

  // Goods-in: a green coffee delivery every three weeks or so.
  const greenDeliveries = [];
  [[greenBrazil, "GCBR", 24000, 21], [greenColombia, "GCCO", 18000, 28],
   [greenRobusta, "GCVN", 30000, 21], [greenEthiopia, "GCET", 9000, 42]].forEach(([raw, tag, size, every]) => {
    let d = HISTORY_START;
    let guard = 0;
    while (d <= HISTORY_END && guard < 40) {
      const qty = vary(size, 0.06);
      const lot = mkLot(raw, tag, d, qty, {
        unitCost: priceAt(raw, d),
        notes: "Container discharged and sampled on arrival."
      });
      // Ordered a lead time ahead; some land late against the promise.
      const ordered = day(d, -(raw.leadTimeDays || 30));
      const slip = rnd() < 0.28 ? Math.ceil(rnd() * 9) : 0;
      const po = mkOrder(raw, ordered, qty, day(d, -slip),
        slip > 0 ? { notes: "Vessel delayed at transhipment." } : undefined);
      receiveOrder(po, lot, qty, d);
      greenDeliveries.push({ raw, lot, po });
      d = day(d, every);
      guard++;
    }
  });
  // Packaging deliveries: fewer, larger
  [[jar100, "PKJ1", 120000, 35], [jar200, "PKJ2", 80000, 42],
   [sachetFilm, "PKFL", 3000000, 49], [pouch500, "PKPO", 40000, 49],
   [carton25, "PKCT", 100000, 42], [caseBox, "PKCS", 60000, 35],
   [labels, "PKLB", 250000, 42], [nitrogen, "GASN", 900, 28]].forEach(([raw, tag, size, every]) => {
    let d = HISTORY_START;
    let guard = 0;
    while (d <= HISTORY_END && guard < 40) {
      const pkQty = vary(size, 0.05);
      const pkLot = mkLot(raw, tag, d, pkQty, { unitCost: priceAt(raw, d) });
      const pkPo = mkOrder(raw, day(d, -(raw.leadTimeDays || 21)), pkQty, d);
      receiveOrder(pkPo, pkLot, pkQty, d);
      d = day(d, every);
      guard++;
    }
  });

  const takeFrom = (raw, qty, onDate) => {
    // draw from the oldest lot with stock, FIFO, splitting across lots
    const used = [];
    let need = qty;
    for (const lot of raw.lots) {
      if (need <= 0) break;
      if (lot.date > onDate || lot.qty <= 0) continue;
      const take = Math.min(lot.qty, need);
      draw(lot, take);
      if (!lot.usedDate) lot.usedDate = onDate;
      if (lot.qty === 0) lot.consumedDate = onDate;
      used.push({ lot, qty: take });
      need -= take;
    }
    return used;
  };

  /* One production campaign: sort -> roast -> grind -> extract ->
     concentrate -> dry, for one blend on one date. */
  /* `stopAfter` leaves the campaign parked at that stage, which is what
     produces genuine work in progress: sorted green waiting on a roaster,
     extract waiting on the evaporator. Without it every intermediate is
     consumed the moment it is made and current stock traces to nothing. */
  const CHAIN = ["sort", "roast", "grind", "extract", "conc", "dry"];
  const runCampaign = (b, startDate, scale, stopAfter) => {
    const stopAt = stopAfter ? CHAIN.indexOf(stopAfter) : CHAIN.length - 1;
    const sortDate = startDate;
    const roastDate = day(startDate, 1);
    const grindDate = day(startDate, 2);
    const extrDate = day(startDate, 2);
    const concDate = day(startDate, 3);
    const dryDate = day(startDate, 4);

    const recipe = b.key === "CLS" ? [[greenBrazil, sortedBR, 0.60], [greenRobusta, sortedVN, 0.40]]
      : b.key === "RCH" ? [[greenBrazil, sortedBR, 0.30], [greenRobusta, sortedVN, 0.70]]
      : [[greenColombia, sortedCO, 0.70], [greenEthiopia, sortedET, 0.15], [greenBrazil, sortedBR, 0.15]];

    const greenTotal = 1000 * scale;
    const sortedLots = [];

    recipe.forEach(([raw, sortedItem, share]) => {
      const wantGreen = greenTotal * share;
      const drawn = takeFrom(raw, wantGreen, sortDate);
      if (!drawn.length) return;
      const gotGreen = drawn.reduce((s, x) => s + x.qty, 0);
      const yieldPct = vary(0.97, 0.01);
      const outQty = gotGreen * yieldPct;
      const sortBatch = uid();
      const sortProc = processes.find(pp => (pp.outputs || []).some(o => o.itemId === sortedItem.id));
      const lot = mkLot(sortedItem, "SRT", sortDate, outQty, {
        batchId: sortBatch, processId: sortProc ? sortProc.id : "",
        sources: drawn.map(x => src("raw", raw, x.lot, x.qty)),
        actualEquipment: [useEq(eSorter, vary(3, 0.2) * scale)],
        actualLabor: [useLabour(vary(3, 0.2) * scale)],
        notes: "Sorted for " + b.label + " campaign."
      });
      sortedLots.push({ item: sortedItem, lot, qty: outQty });
      // rejects
      mkLot(wReject, "REJ", sortDate, gotGreen * (1 - yieldPct), {
        batchId: sortBatch, processId: sortProc ? sortProc.id : "",
        notes: "Sorter rejects from " + lot.lotNumber
      });
    });
    if (!sortedLots.length) return null;
    if (stopAt < 1) return null;

    // roast
    const roastLoss = b.key === "RCH" ? 0.16 : b.key === "PRM" ? 0.13 : 0.14;
    const sortedTotal = sortedLots.reduce((s, x) => s + x.qty, 0);
    const roastQty = sortedTotal * (1 - vary(roastLoss, 0.08));
    const roaster = b.key === "RCH" ? eRoaster2 : eRoaster1;
    const roastBatch = uid();
    const roastProc = processes.find(pp => pp.sku === "PR-ROAST-" + b.key);
    const roastLot = mkLot(b.roast, "RST", roastDate, roastQty, {
      batchId: roastBatch, processId: roastProc ? roastProc.id : "",
      sources: sortedLots.map(x => {
        draw(x.lot, x.qty);
        x.lot.usedDate = roastDate; x.lot.consumedDate = roastDate;
        return src("intermediate", x.item, x.lot, x.qty);
      }),
      actualEquipment: [useEq(roaster, vary(5, 0.15) * scale)],
      actualLabor: [useLabour(vary(5, 0.15) * scale)],
      qcChecks: [qc(cMoisture, vary(2.2, 0.15))],
      notes: b.label + " roast profile."
    });
    mkLot(wChaff, "CHF", roastDate, sortedTotal * 0.012, {
      batchId: roastBatch, processId: roastProc ? roastProc.id : "",
      notes: "Cyclone chaff from " + roastLot.lotNumber });

    if (stopAt < 2) return null;

    // grind
    const grindQty = roastQty * vary(0.995, 0.003);
    const grindBatch = uid();
    const grindProc = processes.find(pp => pp.sku === "PR-GRIND-" + b.key);
    const grindLot = mkLot(b.ground, "GRD", grindDate, grindQty, {
      batchId: grindBatch, processId: grindProc ? grindProc.id : "",
      sources: [(function () { draw(roastLot, roastQty); roastLot.usedDate = grindDate; roastLot.consumedDate = grindDate; return src("intermediate", b.roast, roastLot, roastQty); })()],
      actualEquipment: [useEq(eGrinder, vary(2, 0.2) * scale)],
      actualLabor: [useLabour(vary(2, 0.2) * scale)]
    });

    if (stopAt < 3) return null;

    // extract
    const extractQty = grindQty * vary(2.4, 0.05);
    const solubles = vary(b.key === "RCH" ? 12.6 : 12.0, 0.05);
    const extrBatch = uid();
    const extrProc = processes.find(pp => pp.sku === "PR-EXTR-" + b.key);
    const extrLot = mkLot(b.extract, "EXT", extrDate, extractQty, {
      batchId: extrBatch, processId: extrProc ? extrProc.id : "",
      sources: [(function () { draw(grindLot, grindQty); grindLot.usedDate = extrDate; grindLot.consumedDate = extrDate; return src("intermediate", b.ground, grindLot, grindQty); })()],
      actualEquipment: [useEq(eExtract, vary(8, 0.12) * scale)],
      actualLabor: [useLabour(vary(4, 0.2) * scale)],
      qcChecks: [qc(cSolubles, solubles, "calculated")]
    });
    mkLot(wGrounds, "SPG", extrDate, grindQty * vary(1.85, 0.06), {
      batchId: extrBatch, processId: extrProc ? extrProc.id : "",
      notes: "Wet spent grounds from " + extrLot.lotNumber
    });

    if (stopAt < 4) return null;

    // concentrate
    const concQty = extractQty * vary(0.267, 0.04);
    const concBatch = uid();
    const concProc = processes.find(pp => pp.sku === "PR-CONC-" + b.key);
    const concLot = mkLot(b.conc, "CNC", concDate, concQty, {
      batchId: concBatch, processId: concProc ? concProc.id : "",
      sources: [(function () { draw(extrLot, extractQty); extrLot.usedDate = concDate; extrLot.consumedDate = concDate; return src("intermediate", b.extract, extrLot, extractQty); })()],
      actualEquipment: [useEq(eEvap, vary(6, 0.15) * scale)],
      actualLabor: [useLabour(vary(3, 0.2) * scale)],
      qcChecks: [qc(cSolubles, vary(45, 0.03), "calculated")]
    });
    mkLot(wCondensate, "CND", concDate, extractQty - concQty, {
      batchId: concBatch, processId: concProc ? concProc.id : "",
      notes: "Condensate from " + concLot.lotNumber
    });

    if (stopAt < 5) return null;

    // dry
    const powderQty = concQty * vary(0.45, 0.04);
    const moisture = vary(3.4, 0.12);
    const caffeine = b.key === "RCH" ? vary(3.9, 0.06) : b.key === "PRM" ? vary(2.6, 0.06) : vary(3.1, 0.06);
    const dryBatch = uid();
    const dryProc = processes.find(pp => pp.sku === "PR-DRY-" + b.key);
    const dryLot = mkLot(b.powder, "PWD", dryDate, powderQty, {
      batchId: dryBatch, processId: dryProc ? dryProc.id : "",
      sources: [(function () { draw(concLot, concQty); concLot.usedDate = dryDate; concLot.consumedDate = dryDate; return src("intermediate", b.conc, concLot, concQty); })()],
      actualEquipment: [useEq(eDryer, vary(10, 0.12) * scale)],
      actualLabor: [useLabour(vary(5, 0.2) * scale)],
      qcChecks: [qc(cMoisture, moisture), qc(cCaffeine, caffeine),
                 qc(cSolubles, vary(96.2, 0.01), "calculated")],
      notes: moisture > 3.9 ? "Moisture at the top of spec \u2014 tower outlet trimmed for the next run." : ""
    });
    mkLot(wFines, "FIN", dryDate, powderQty * vary(0.035, 0.25), {
      batchId: dryBatch, processId: dryProc ? dryProc.id : "",
      notes: "Cyclone fines from " + dryLot.lotNumber
    });

    return { powderItem: b.powder, powderLot: dryLot, date: dryDate };
  };

  // Run campaigns on a rota, roughly nine a month across the three blends
  const powderStock = [];
  {
    let d = HISTORY_START;
    let i = 0;
    let guard = 0;
    while (d <= HISTORY_END && guard < 200) {
      if (isWeekday(d)) {
        const b = BLENDS[i % 3];
        // Green tonnage per campaign. One tonne yields roughly 300 kg of
        // powder, and a single jar batch needs 600 kg, so these have to be
        // plant-scale or the pack lines starve.
        const scale = b.key === "CLS" ? 7 : b.key === "RCH" ? 5 : 3.5;
        const res = runCampaign(b, d, scale);
        if (res) powderStock.push(res);
        i++;
      }
      d = day(d, 3);
      guard++;
    }
  }

  /* Work in progress: recent campaigns parked at each stage of the chain,
     so the stock on hand today has a batch record behind it rather than
     appearing from nowhere. Runs right up to the present, staggered across
     blends and stages. */
  {
    let wd = day(HISTORY_END, -44);
    let wi = 0;
    let guard = 0;
    while (wd <= todayStr() && guard < 80) {
      if (isWeekday(wd)) {
        // Blend cycles fastest and stage slowest, so all eighteen
        // blend-and-stage pairs get covered rather than the same few
        // repeating - three and six share a factor.
        const b = BLENDS[wi % 3];
        const stage = CHAIN[Math.floor(wi / 3) % CHAIN.length];
        const scale = b.key === "CLS" ? 3.5 : b.key === "RCH" ? 2.5 : 1.8;
        const res = runCampaign(b, wd, scale, stage);
        if (res) powderStock.push(res);
        wi++;
      }
      wd = day(wd, 2);
    }
  }

  // Packing runs, drawing on whatever powder is in stock
  const packedLots = [];
  finishedGoods.forEach((item, fgIndex) => {
    const b = item._blend, fmt = item._format;
    const unitsPerBatch = fmt.key === "S25" ? 4000 : fmt.key === "P500" ? 1200 : fmt.key === "J200" ? 3000 : 6000;
    const line = fmt.key === "S25" ? eSachetLine : fmt.key === "P500" ? ePouchLine : eJarLine;
    let d = day(HISTORY_START, 8 + (fgIndex % 7));
    let guard = 0;
    while (d <= HISTORY_END && guard < 40) {
      if (isWeekday(d)) {
        const units = Math.round(vary(unitsPerBatch, 0.12));
        const needKg = units * fmt.grams / 1000;
        // find powder of this blend with stock, oldest first
        const avail = powderStock.filter(p => p.powderItem === b.powder && p.date <= d && p.powderLot.qty > 0);
        let got = 0;
        const sources = [];
        for (const p of avail) {
          if (got >= needKg) break;
          const take = Math.min(p.powderLot.qty, needKg - got);
          draw(p.powderLot, take);
          if (!p.powderLot.usedDate) p.powderLot.usedDate = d;
          if (p.powderLot.qty === 0) p.powderLot.consumedDate = d;
          sources.push(src("intermediate", b.powder, p.powderLot, take));
          got += take;
        }
        if (got > needKg * 0.6) {
          const madeUnits = Math.round(units * (got / needKg));
          // packaging draw
          const packRaw = fmt.key === "J100" ? jar100 : fmt.key === "J200" ? jar200
            : fmt.key === "S25" ? sachetFilm : pouch500;
          const packQty = fmt.key === "S25" ? madeUnits * 25 : madeUnits;
          takeFrom(packRaw, packQty, d).forEach(x => sources.push(src("raw", packRaw, x.lot, x.qty)));
          takeFrom(caseBox, Math.ceil(madeUnits / 12), d).forEach(x => sources.push(src("raw", caseBox, x.lot, x.qty)));
          if (fmt.key === "J100" || fmt.key === "J200") {
            takeFrom(labels, madeUnits, d).forEach(x => sources.push(src("raw", labels, x.lot, x.qty)));
          }
          if (fmt.key === "S25") {
            takeFrom(carton25, madeUnits, d).forEach(x => sources.push(src("raw", carton25, x.lot, x.qty)));
          }
          takeFrom(nitrogen, Math.max(1, Math.round(madeUnits / 400)), d)
            .forEach(x => sources.push(src("raw", nitrogen, x.lot, x.qty)));

          const packProc = processes.find(pp => pp.sku === "PR-PACK-" + b.key + "-" + fmt.key);
          const lot = mkLot(item, "PK" + fmt.key.slice(0, 2), d, madeUnits, {
            batchId: uid(), processId: packProc ? packProc.id : "",
            sources,
            actualEquipment: [useEq(line, vary(fmt.key === "S25" ? 7 : 5, 0.15)),
                              useEq(eCasePack, vary(2, 0.2))],
            actualLabor: [useLabour(vary(fmt.key === "S25" ? 7 : 5, 0.15)),
                          useLabour(vary(4, 0.25))],
            qcChecks: [qc(cMoisture, vary(3.5, 0.1))]
          });
          packedLots.push({ item, lot, date: d, run: null });
        }
      }
      d = day(d, 11);
      guard++;
    }
  });

  /* --- schedule: completed history plus an open forward book -------- */
  const schedule = [];
  /* A run raised against a customer who has no price for that product can
     never be invoiced. Pick only from customers who actually buy it, the
     same constraint the shipment form applies. */
  const buyersOf = (item) => customers.filter(c =>
    (c.priceList || []).some(p => p.finishedGoodId === item.id));
  const pickBuyer = (item) => {
    const eligible = buyersOf(item);
    return eligible.length ? eligible[Math.floor(rnd() * eligible.length)] : null;
  };
  const mkRun = (item, qty, dueDate, status, over) => {
    const entry = {
      id: uid(), productType: "finished", productId: item.id, qty,
      dueDate, status, notes: "", customerId: "",
      completedDate: "", createdDate: "", frozen: false, frozenDate: "",
      baselineQty: "", baselineDueDate: "", fulfillmentLots: [], revisions: [],
      ...(over || {})
    };
    schedule.push(entry);
    return entry;
  };

  // completed runs, tied to the lots that actually fulfilled them
  packedLots.forEach((p, i) => {
    if (i % 2 !== 0) return;
    const created = day(p.date, -21);
    const due = day(p.date, rnd() < 0.7 ? 0 : (rnd() < 0.5 ? -2 : 3));
    /* Standard cost as it stood on the day of fulfilment. Deliberately a few
       percent off the actual, and drawn from the prices ruling then, so the
       expected-versus-actual comparison has something real in it. */
    const entry = mkRun(p.item, p.lot.qty, due, "Complete", {
      createdDate: created, completedDate: p.date,
      customerId: (pickBuyer(p.item) || {}).id || "",
      frozen: true, frozenDate: day(created, 3),
      baselineQty: p.lot.qty, baselineDueDate: due,
      standardCostAtFulfillment: 0,
      fulfillmentLots: [{ id: uid(), lotId: p.lot.id, qty: p.lot.qty }]
    });
    p.run = entry;
    // a handful were amended after freezing, with a reason on record
    if (i % 14 === 0) {
      const original = Math.round(p.lot.qty * 1.15);
      entry.baselineQty = original;
      entry.revisions.push({
        id: uid(), at: day(created, 9), field: "qty",
        fromValue: String(original), toValue: String(p.lot.qty),
        reason: pick(["Customer reduced the call-off",
                      "Powder shortfall after a dryer trip",
                      "Jar delivery slipped, short-packed to protect the date"]),
        author: pick(["S. Whitfield", "A. Boateng", "D. Kaur"])
      });
    }
  });

  /* Bulk powder is campaign-scheduled in its own right, not just derived
     from finished-goods demand, so it carries schedule entries too. Without
     them the intermediate scope has an actual bar and no line to compare it
     against, which reads as unlimited overproduction. */
  powderStock.forEach((p, i) => {
    if (i % 3 !== 0) return;
    const created = day(p.date, -14);
    const qty = Math.round(p.powderLot.producedQty);
    if (qty <= 0) return;
    schedule.push({
      id: uid(), productType: "intermediate", productId: p.powderItem.id,
      qty, dueDate: p.date, status: "Complete", notes: "Bulk powder campaign",
      customerId: "", completedDate: p.date, createdDate: created,
      frozen: true, frozenDate: day(created, 2),
      baselineQty: qty, baselineDueDate: p.date,
      fulfillmentLots: [{ id: uid(), lotId: p.powderLot.id, qty }],
      revisions: []
    });
  });

  // open forward book
  const today = todayStr();
  finishedGoods.forEach((item, i) => {
    const qty = item._format.key === "S25" ? 4200 : item._format.key === "P500" ? 1400
      : item._format.key === "J200" ? 3200 : 6400;
    mkRun(item, Math.round(vary(qty, 0.15)), day(today, 6 + i * 4),
      i < 3 ? "In progress" : "Planned", {
        createdDate: day(today, -20 + i),
        customerId: (pickBuyer(item) || {}).id || "",
        frozen: i < 6,
        frozenDate: i < 6 ? day(today, -14 + i) : "",
        baselineQty: i < 6 ? Math.round(vary(qty, 0.15)) : "",
        baselineDueDate: i < 6 ? day(today, 6 + i * 4) : "",
        standardCostAtFulfillment: ""
      });
  });

  /* --- shipments ----------------------------------------------------- */
  const shipments = [];
  packedLots.forEach((p, i) => {
    if (i % 3 !== 0) return;
    // Despatch only against lots that actually fulfilled a run - a shipment
    // with no run behind it cannot be reconciled and is a data defect, not a
    // realistic case to seed.
    if (!p.run) return;
    const eligible = customers.filter(c => (c.priceList || []).some(pl => pl.finishedGoodId === p.item.id));
    if (!eligible.length) return;
    const cust = eligible[i % eligible.length];
    const qty = Math.round(p.lot.qty * (0.4 + rnd() * 0.5));
    if (qty <= 0) return;
    const shipDate = day(p.date, 2 + Math.floor(rnd() * 6));
    shipments.push({
      id: uid(), finishedGoodId: p.item.id, lotId: p.lot.id, qty,
      customerId: cust.id, addressId: cust.addresses[0].id,
      shipDate,
      // Despatch paperwork, and the link back to the run this satisfies
      scheduleId: p.run ? p.run.id : "",
      reference: "SO-" + (41000 + i),
      customerPO: "PO/" + cust.code.replace("CUST-", "") + "/" + (9200 + i),
      bol: "BOL-" + shipDate.replace(/-/g, "").slice(2) + "-" + String(100 + i),
      carrier: pick(CARRIERS),
      trackingRef: "TRK" + (7700000 + i * 137),
      notes: rnd() < 0.25 ? pick([
        "Pallet 2 of 2 short-shipped, balance to follow.",
        "Customer requested tail-lift delivery.",
        "Temperature-controlled trailer specified.",
        "Delivered against a standing weekly call-off."
      ]) : ""
    });
  });

  /* Open orders ahead of today, so the forecast has expected deliveries to
     plot and a couple already past their promised date to chase. */
  [[greenBrazil, 24000, 12], [greenColombia, 18000, 26], [greenRobusta, 30000, 5],
   [greenEthiopia, 9000, 40], [jar100, 120000, 18], [sachetFilm, 3000000, 33],
   [caseBox, 60000, -4], [labels, 250000, -9]].forEach(([raw, size, inDays]) => {
    const expected = day(todayStr(), inDays);
    const po = mkOrder(raw, day(expected, -(raw.leadTimeDays || 30)), vary(size, 0.05), expected,
      inDays < 0 ? { notes: "Chased with the supplier \u2014 no revised date yet." } : undefined);
    // one arrives in two instalments, the first already landed
    if (raw === greenRobusta) {
      const part = po.qty * 0.4;
      const partLot = mkLot(raw, "GCVN", day(todayStr(), -3), part, { unitCost: po.unitCost,
        notes: "First instalment against " + po.reference });
      receiveOrder(po, partLot, part, day(todayStr(), -3));
    }
  });

  /* --- sales orders ---------------------------------------------------
     Seeded across every review state, because the decision is the point of
     the sheet: some untouched, some worked through, some already released
     into the schedule, and a few carrying concessions worth questioning. */
  const REPS = ["A. Fenwick", "D. Marchetti", "S. Okonkwo", "H. Lindqvist", "T. Bramall"];
  const DISCOUNT_REASONS = ["Volume commitment for the quarter", "Matched a competitor quote",
    "Goodwill after the March short-shipment", "Launch support on a new listing",
    "Agreed at the account review"];
  const salesOrders = [];
  let soSeq = 8600;
  for (let i = 0; i < 14; i++) {
    const cust = customers[i % customers.length];
    const catalogue = finishedGoods.filter(function (fgItem) {
      return (cust.priceList || []).some(function (pl) { return pl.finishedGoodId === fgItem.id; });
    });
    if (!catalogue.length) continue;

    const orderDate = day(todayStr(), -60 + i * 5);
    const requested = day(orderDate, 21 + Math.floor(rnd() * 25));
    const lineCount = 1 + Math.floor(rnd() * 3);
    const lines = [];

    for (let k = 0; k < lineCount; k++) {
      const item = catalogue[(i + k) % catalogue.length];
      if (lines.some(function (l) { return l.finishedGoodId === item.id; })) continue;
      const base = item.sku.indexOf("S25") >= 0 ? 3800
        : item.sku.indexOf("P500") >= 0 ? 1300
        : item.sku.indexOf("J200") >= 0 ? 2900 : 5600;
      const qty = Math.round(vary(base, 0.25));
      const priceLine = (cust.priceList || []).find(function (pl) { return pl.finishedGoodId === item.id; });
      const listPrice = priceLine ? getEffectivePrice(priceLine, qty) : 0;

      // most lines go out at list; a minority carry a rep concession
      const roll = rnd();
      const discountPct = roll < 0.55 ? 0
        : roll < 0.85 ? Math.round(rnd() * 4 * 10) / 10
        : Math.round((5 + rnd() * 9) * 10) / 10;

      lines.push({
        id: uid(), finishedGoodId: item.id, qty,
        listPrice: Math.round(listPrice * 10000) / 10000,
        discountPct,
        discountReason: discountPct === 0 ? "" : pick(DISCOUNT_REASONS),
        requestedDate: requested,
        reviewDecision: "Pending", approvedQty: 0, approvedDate: "",
        reviewNote: "", scheduleId: ""
      });
    }
    if (!lines.length) continue;

    salesOrders.push({
      id: uid(), reference: "SO-" + (++soSeq),
      customerId: cust.id,
      addressId: (cust.addresses[0] || {}).id || "",
      salesRep: REPS[i % REPS.length],
      orderDate, requestedDate: requested,
      status: "Submitted",
      notes: "",
      lines
    });
  }

  /* Work the review through on the older orders so the sheet shows every
     state at once, and release what was agreed into the schedule. */
  salesOrders.forEach(function (so, i) {
    if (i >= 9) return;
    so.lines.forEach(function (line) {
      const roll = rnd();
      if (roll < 0.12) {
        line.reviewDecision = "Reject";
        line.reviewNote = "No capacity in the window requested.";
      } else if (roll < 0.40) {
        line.reviewDecision = "Adjust";
        line.approvedQty = Math.max(1, Math.round(line.qty * (0.55 + rnd() * 0.3)));
        line.approvedDate = day(line.requestedDate, 4 + Math.floor(rnd() * 12));
        line.reviewNote = pick(["Trimmed to fit the dryer window.",
          "Split across two runs; this is the first.", "Pushed out a week, powder not ready."]);
      } else {
        line.reviewDecision = "Accept";
        line.approvedQty = line.qty;
        line.approvedDate = line.requestedDate;
      }
    });
    so.status = "Reviewed";

    if (i < 6) {
      so.lines.forEach(function (line) {
        if (line.reviewDecision !== "Accept" && line.reviewDecision !== "Adjust") return;
        const q = line.reviewDecision === "Adjust" ? line.approvedQty : line.qty;
        if (!(q > 0)) return;
        const run = {
          id: uid(), productType: "finished", productId: line.finishedGoodId, qty: q,
          dueDate: line.approvedDate || line.requestedDate,
          status: "Planned",
          notes: "Released from " + so.reference +
            (line.reviewDecision === "Adjust" ? " (adjusted from " + line.qty + ")" : ""),
          customerId: so.customerId, completedDate: "",
          createdDate: so.orderDate, frozen: false, frozenDate: "",
          baselineQty: "", baselineDueDate: "", standardCostAtFulfillment: "",
          fulfillmentLots: [], revisions: []
        };
        schedule.push(run);
        line.scheduleId = run.id;
      });
      so.status = "Released";
    }
  });

  /* A handful of cancellations, so the record view has something in it and
     the held figures reflect real releases back to unassigned stock. */
  const fulfilmentCancellations = [];
  {
    const CANCELLERS = ["J. Ferreira", "M. Whitcombe", "A. Duong"];
    const REASONS_SEED = ["Customer cancelled the order", "Customer deferred delivery indefinitely",
      "Reallocated to another customer", "Shelf life too short to ship", "Commercial dispute"];
    const completedRuns = schedule.filter(function (s) {
      return s.status === "Complete" && s.productType === "finished"
        && (s.fulfillmentLots || []).length;
    });
    completedRuns.forEach(function (entry, i) {
      if (i % 7 !== 3) return;
      const fl = entry.fulfillmentLots[0];
      if (!fl) return;
      const shippedQ = shipments.filter(function (s) { return s.lotId === fl.lotId; })
        .reduce(function (a, s) { return a + (Number(s.qty) || 0); }, 0);
      const held = Math.max(0, (Number(fl.qty) || 0) - shippedQ);
      if (held < 10) return;
      const amount = Math.round(held * (i % 3 === 0 ? 1 : 0.35 + rnd() * 0.3));
      if (amount <= 0) return;
      const cust = customers.find(function (c) { return c.id === entry.customerId; });
      const pl = cust && (cust.priceList || []).find(function (p) {
        return p.finishedGoodId === entry.productId; });
      fulfilmentCancellations.push({
        id: uid(), scheduleId: entry.id, lotId: fl.lotId,
        finishedGoodId: entry.productId, customerId: entry.customerId || "",
        qty: amount,
        reason: pick(REASONS_SEED),
        reasonNote: pick(["Confirmed by the account manager in writing.",
          "Agreed at the weekly commercial review.", ""]),
        cancelledBy: pick(CANCELLERS),
        cancelledDate: day(entry.completedDate, 5 + Math.floor(rnd() * 20)),
        salesValue: pl ? Math.round(getEffectivePrice(pl, amount) * amount * 100) / 100 : 0,
        cogs: 0,
        notes: ""
      });
      fl.qty = Math.max(0, (Number(fl.qty) || 0) - amount);
    });
  }

  /* --- production targets -------------------------------------------- */
  const productionTargets = [];
  ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09"].forEach((k, i) => {
    productionTargets.push({
      id: uid(), periodType: "month", periodKey: k, productType: "", productId: "",
      targetQty: 62000 + i * 2500, notes: i > 4 ? "Autumn build" : ""
    });
  });

  // strip the helper fields used only during construction
  finishedGoods.forEach(x => {
    delete x._blend; delete x._format;
  });

  /* Standard cost at fulfilment, set once the whole model exists so it can be
     derived from the real rolled-up cost. A standard is an estimate made in
     advance, so it sits a few percent either side of what the run actually
     cost - which is the variance the comparison is there to show. */
  {
    const assembled = { rawMaterials, intermediateProducts, finishedGoods, processes,
      schedule, equipment, maintenance, customers, components, wasteStreams,
      shipments, operatingCalendars, productionTargets, purchaseOrders, salesOrders,
      fulfilmentCancellations };
    const cache = {};
    schedule.forEach(entry => {
      if (entry.status !== "Complete" || entry.productType !== "finished") return;
      const lots = (entry.fulfillmentLots || []).filter(fl => fl.lotId);
      if (!lots.length) return;
      let value = 0, qty = 0;
      lots.forEach(fl => {
        const c = lotCost(assembled, "finished", entry.productId, fl.lotId, cache);
        value += c.unitCost * (Number(fl.qty) || 0);
        qty += Number(fl.qty) || 0;
      });
      const actual = qty > 0 ? value / qty : 0;
      entry.standardCostAtFulfillment = Math.round(actual * (1 + (rnd() - 0.45) * 0.16) * 10000) / 10000;
    });
  }

  seedWarehouseCatalog({ rawMaterials, intermediateProducts, finishedGoods, wasteStreams });

  return backfillRowIds({
    seedVersion: SEED_VERSION,
    rawMaterials, intermediateProducts, finishedGoods, processes,
    schedule: schedule.map(normalizeScheduleEntry),
    equipment, maintenance, customers, components, wasteStreams, shipments,
    operatingCalendars, productionTargets, purchaseOrders, salesOrders,
    fulfilmentCancellations
  });
}

/* ---------------------------------------------------------------
   Migration: reshape whatever was loaded from storage into the
   current data model, whatever generation it came from.
----------------------------------------------------------------*/
function ensureLots(item) {
  if (item && Array.isArray(item.lots)) return item;
  const qty = (item && typeof item.stock === "number") ? item.stock : 0;
  const lots = qty > 0 ? [{
    id: uid(), lotNumber: "LEGACY", date: todayStr(), qty,
    notes: "Migrated from pre-lot-tracking stock total", sources: [], actualEquipment: [], actualLabor: []
  }] : [];
  return { ...(item || {}), lots };
}

function migrateHours(obj, hoursKey, daysKey, fallbackHours) {
  if (obj && typeof obj[hoursKey] === "number") return obj[hoursKey];
  if (obj && typeof obj[daysKey] === "number") return obj[daysKey] * 24;
  return fallbackHours;
}

// Backfills missing composition and autoComposition fields. Any leftover
// attributeDefs / lot.attributes fields from the retired attributes
// feature are simply left in place unread - harmless dead data, not
// worth stripping out.
// Backfills missing composition and autoComposition fields. Any leftover
// attributeDefs / lot.attributes fields from the retired attributes
// feature are simply left in place unread - harmless dead data, not
// worth stripping out. stripCostWeight is true for intermediate products
// and finished goods, so any cost allocation saved on them before this
// restriction existed gets cleaned up on load, not just hidden in the UI.
function migrateItem(itemIn, stripCostWeight) {
  const composition = Array.isArray(itemIn.composition) ? itemIn.composition : [];
  return {
    ...itemIn,
    composition: stripCostWeight ? stripCostAllocation(composition) : composition,
    autoComposition: !!itemIn.autoComposition,
    hazardClass: itemIn.hazardClass || "N/A"
  };
}

function migrateWasteStream(w) {
  const withLots = ensureLots(w);
  return {
    id: withLots.id, name: withLots.name || "", sku: withLots.sku || "", unit: withLots.unit || "ea", notes: withLots.notes || "",
    componentId: withLots.componentId || "", accumulate: !!withLots.accumulate,
    hazardClass: withLots.hazardClass || "N/A",
    lots: withLots.lots
  };
}

// Older saved composition entries pointed directly at a raw material
// ({ rawMaterialId, percentage }). This promotes each distinct referenced
// raw material into a proper Component (deduping by name against whatever
// components already exist) and rewrites every composition entry across
// all three catalogs to the new { componentId, percentage } shape.
function migrateCompositionToComponents(rawMaterials, intermediateProducts, finishedGoods, existingComponents) {
  const components = Array.isArray(existingComponents) ? [...existingComponents] : [];
  const findOrCreateComponent = (raw) => {
    let c = components.find(x => x.name.toLowerCase() === raw.name.toLowerCase());
    if (!c) {
      c = { id: uid(), name: raw.name, unit: raw.unit || "ea", rawMaterialId: raw.id, notes: "" };
      components.push(c);
    }
    return c;
  };
  const migrateArray = (items) => items.map(item => {
    const comp = Array.isArray(item.composition) ? item.composition : [];
    const needsMigration = comp.some(c => c && c.rawMaterialId && !c.componentId);
    if (!needsMigration) return { ...item, composition: comp };
    const newComp = comp.map(c => {
      if (c.componentId) return c;
      if (!c.rawMaterialId) return null;
      const raw = rawMaterials.find(r => r.id === c.rawMaterialId);
      if (!raw) return null;
      const component = findOrCreateComponent(raw);
      return { id: c.id || uid(), componentId: component.id, percentage: c.percentage };
    }).filter(Boolean);
    return { ...item, composition: newComp };
  });
  return {
    rawMaterials: migrateArray(rawMaterials),
    intermediateProducts: migrateArray(intermediateProducts),
    finishedGoods: migrateArray(finishedGoods),
    components: migrateComponentCostBasis(components, rawMaterials)
  };
}

// Components used to carry their own manually-entered unitCost. That
// field is gone now - cost always comes live from a linked raw material
// instead. For anything saved under the old shape, try to auto-link by
// matching name against an existing raw material; otherwise it's left
// unlinked (and so contributes $0 to composition costing until someone
// links it by hand from the Components tab).
function migrateComponentCostBasis(components, rawMaterials) {
  return (components || []).map(c => {
    let base = c;
    if (base.rawMaterialId === undefined) {
      const match = rawMaterials.find(r => r.name.toLowerCase() === c.name.toLowerCase());
      base = { id: c.id, name: c.name, unit: c.unit, rawMaterialId: match ? match.id : "", notes: c.notes || "" };
    }
    return {
      ...base,
      qcCalibration: base.qcCalibration || { enabled: false, measurementLabel: "", measurementUnit: "", slope: 1, intercept: 0 }
    };
  });
}

/* Migration only: a database saved before operating calendars existed
   was planned as if the plant ran continuously. Preserve that rather
   than re-planning committed work behind the user's back - they can
   set real hours whenever they choose. */
/* Despatch paperwork and the run link postdate the original shipment record. */
function normalizeShipments(list) {
  return (Array.isArray(list) ? list : []).map(s => ({
    customerPO: "", bol: "", carrier: "", trackingRef: "", scheduleId: "", ...s
  }));
}

/* Sales orders postdate the original model. */
function normalizeSalesOrders(list) {
  return (Array.isArray(list) ? list : []).map(so => ({
    ...so,
    status: so.status || "Draft",
    lines: (Array.isArray(so.lines) ? so.lines : []).map(l => ({
      id: l.id || uid(), finishedGoodId: l.finishedGoodId || "",
      qty: Number(l.qty) || 0,
      listPrice: Number(l.listPrice) || 0,
      discountPct: Number(l.discountPct) || 0,
      discountReason: l.discountReason || "",
      requestedDate: l.requestedDate || "",
      reviewDecision: l.reviewDecision || "Pending",
      approvedQty: Number(l.approvedQty) || 0,
      approvedDate: l.approvedDate || "",
      reviewNote: l.reviewNote || "",
      scheduleId: l.scheduleId || ""
    }))
  }));
}

/* Orders loaded from a database that predates them. */
function normalizePurchaseOrders(list) {
  return (Array.isArray(list) ? list : []).map(po => ({
    ...po,
    qty: Number(po.qty) || 0,
    unitCost: Number(po.unitCost) || 0,
    status: po.status || "Ordered",
    receipts: (Array.isArray(po.receipts) ? po.receipts : []).map(r => ({
      id: r.id || uid(), date: r.date || "", qty: Number(r.qty) || 0,
      lotId: r.lotId || "", notes: r.notes || ""
    }))
  }));
}

/* Equipment saved before machines could follow their own hours has no
   calendarId. Absent means "use the facility default", which is the
   behaviour those records already had. */
function normalizeEquipment(list) {
  return (Array.isArray(list) ? list : []).map(e => ({ ...e, calendarId: e.calendarId || "" }));
}

/* A run loaded from storage may predate freezing, baselines or the revision
   log. Absent means never frozen, which is the safe reading - it leaves the
   run editable rather than locking history nobody committed to. */
function normalizeScheduleEntry(s) {
  return {
    ...s,
    customerId: s.customerId || "",
    completedDate: s.completedDate || "",
    createdDate: s.createdDate || "",
    frozen: s.frozen === true,
    frozenDate: s.frozenDate || "",
    baselineQty: s.baselineQty === undefined || s.baselineQty === "" ? "" : Number(s.baselineQty),
    baselineDueDate: s.baselineDueDate || "",
    fulfillmentLots: Array.isArray(s.fulfillmentLots) ? s.fulfillmentLots : [],
    revisions: Array.isArray(s.revisions) ? s.revisions : []
  };
}

function ensureOperatingCalendars(list) {
  const hrs = (v) => clamp(Number(v) || 0, 0, 24);
  const rows = (Array.isArray(list) ? list : []).map(c => ({
    id: c.id || uid(),
    name: c.name || "Facility hours",
    isDefault: c.isDefault === true,
    hoursMon: hrs(c.hoursMon), hoursTue: hrs(c.hoursTue), hoursWed: hrs(c.hoursWed),
    hoursThu: hrs(c.hoursThu), hoursFri: hrs(c.hoursFri),
    hoursSat: hrs(c.hoursSat), hoursSun: hrs(c.hoursSun),
    notes: c.notes || "",
    closures: (Array.isArray(c.closures) ? c.closures : []).map(w => ({
      id: w.id || uid(), startDate: w.startDate || "",
      endDate: w.endDate || "", reason: w.reason || ""
    })),
    overrides: (Array.isArray(c.overrides) ? c.overrides : []).map(o => ({
      id: o.id || uid(), startDate: o.startDate || "",
      endDate: o.endDate || o.startDate || "", label: o.label || "",
      hoursMon: hrs(o.hoursMon), hoursTue: hrs(o.hoursTue), hoursWed: hrs(o.hoursWed),
      hoursThu: hrs(o.hoursThu), hoursFri: hrs(o.hoursFri),
      hoursSat: hrs(o.hoursSat), hoursSun: hrs(o.hoursSun)
    }))
  }));
  if (!rows.length) {
    rows.push({
      id: uid(), name: "Continuous (24/7)", isDefault: true,
      hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24,
      hoursFri: 24, hoursSat: 24, hoursSun: 24,
      notes: "Carried over from before operating hours were configurable.",
      closures: [], overrides: []
    });
  }
  if (!rows.some(r => r.isDefault)) rows[0].isDefault = true;
  return rows;
}

function normalizeData(raw) {
  if (!raw || typeof raw !== "object") return seedData();

  // Already current shape - just backfill any missing arrays defensively.
  if (Array.isArray(raw.intermediateProducts) && Array.isArray(raw.processes)) {
    const rawMaterials0 = (Array.isArray(raw.rawMaterials) ? raw.rawMaterials : []).map(r => migrateItem(ensureLots(r), false));
    const intermediateProducts0 = (Array.isArray(raw.intermediateProducts) ? raw.intermediateProducts : []).map(i => migrateItem({ unit: "ea", notes: "", ...ensureLots(i) }, true));
    const finishedGoods0 = (Array.isArray(raw.finishedGoods) ? raw.finishedGoods : []).map(f => migrateItem({ unit: "ea", notes: "", ...ensureLots(f) }, true));
    const migrated = migrateCompositionToComponents(rawMaterials0, intermediateProducts0, finishedGoods0, raw.components);
    return backfillRowIds({
      rawMaterials: migrated.rawMaterials,
      intermediateProducts: migrated.intermediateProducts,
      finishedGoods: migrated.finishedGoods,
      components: migrated.components,
      processes: (Array.isArray(raw.processes) ? raw.processes : []).map(p => ({
        ...p,
        productionTimeHours: migrateHours(p, "productionTimeHours", "productionTimeDays", 24),
        inputs: (Array.isArray(p.inputs) ? p.inputs : []).map(l => ({ id: l.id || uid(), itemType: l.itemType || "raw", itemId: l.itemId, qty: l.qty })),
        equipment: Array.isArray(p.equipment) ? p.equipment : [],
        outputs: Array.isArray(p.outputs) ? p.outputs : []
      })),
      schedule: (Array.isArray(raw.schedule) ? raw.schedule : []).map(normalizeScheduleEntry),
      productionTargets: Array.isArray(raw.productionTargets) ? raw.productionTargets : [],
      equipment: normalizeEquipment(raw.equipment),
      maintenance: (Array.isArray(raw.maintenance) ? raw.maintenance : []).map(m => ({ ...m, durationHours: migrateHours(m, "durationHours", "durationDays", 24) })),
      customers: Array.isArray(raw.customers) ? raw.customers : [],
      wasteStreams: (Array.isArray(raw.wasteStreams) ? raw.wasteStreams : []).map(w => migrateWasteStream(w)),
      shipments: normalizeShipments(raw.shipments),
      purchaseOrders: normalizePurchaseOrders(raw.purchaseOrders),
      salesOrders: normalizeSalesOrders(raw.salesOrders),
      fulfilmentCancellations: Array.isArray(raw.fulfilmentCancellations) ? raw.fulfilmentCancellations : [],
      operatingCalendars: ensureOperatingCalendars(raw.operatingCalendars),
      seedVersion: raw.seedVersion || ""
    });
  }

  // Older shape: processes were called "intermediates" and carried their
  // outputs (with lots) inline; finished goods carried their own BOM,
  // equipment and lots directly. Reusing the same ids when promoting an
  // old output / finished good into a catalog entry means schedule
  // entries and customer price lists need no remapping at all.
  const rawMaterials = (Array.isArray(raw.rawMaterials) ? raw.rawMaterials : []).map(r => migrateItem(ensureLots(r), false));
  const intermediateProducts = [];
  const processes = [];

  const oldProcesses = Array.isArray(raw.intermediates) ? raw.intermediates : [];
  oldProcesses.forEach(pRaw => {
    let p = (pRaw && Array.isArray(pRaw.outputs) && Array.isArray(pRaw.inputs)) ? pRaw : {
      id: (pRaw && pRaw.id) || uid(),
      name: (pRaw && pRaw.name) || "Untitled process",
      sku: (pRaw && pRaw.sku) || "",
      productionTimeHours: migrateHours(pRaw, "productionTimeHours", "productionTimeDays", 24),
      notes: (pRaw && pRaw.notes) || "",
      inputs: (pRaw && Array.isArray(pRaw.bom)) ? pRaw.bom : ((pRaw && Array.isArray(pRaw.inputs)) ? pRaw.inputs : []),
      equipment: (pRaw && Array.isArray(pRaw.equipment)) ? pRaw.equipment : [],
      outputs: (pRaw && Array.isArray(pRaw.outputs) && pRaw.outputs.length > 0) ? pRaw.outputs : [{
        id: (pRaw && pRaw.id) || uid(), name: (pRaw && pRaw.name) || "Output", sku: (pRaw && pRaw.sku) || "",
        qtyPerBatch: 1, unit: "ea", stock: (pRaw && pRaw.stock) || 0
      }]
    };
    const productionTimeHours = migrateHours(p, "productionTimeHours", "productionTimeDays", 24);
    const inputs = (Array.isArray(p.inputs) ? p.inputs : []).map(l => ({ itemType: l.itemType || "raw", itemId: l.itemId, qty: l.qty }));
    const equipment = Array.isArray(p.equipment) ? p.equipment : [];
    const outputs = (Array.isArray(p.outputs) ? p.outputs : []).map(o => {
      const withLots = migrateItem(ensureLots(o), true);
      intermediateProducts.push({ id: o.id, name: o.name || "Untitled output", sku: o.sku || "", unit: o.unit || "ea", notes: "", composition: withLots.composition, lots: withLots.lots });
      return { id: uid(), itemType: "intermediate", itemId: o.id, qtyPerBatch: o.qtyPerBatch || 1, costOverride: o.costOverride || "" };
    });
    processes.push({ id: p.id, name: p.name, sku: p.sku, productionTimeHours, notes: p.notes || "", inputs, equipment, outputs });
  });

  const finishedGoods = [];
  const oldFinishedGoods = Array.isArray(raw.finishedGoods) ? raw.finishedGoods : [];
  oldFinishedGoods.forEach(fRaw => {
    if (!Array.isArray(fRaw.bom)) {
      finishedGoods.push(migrateItem({ unit: "ea", notes: "", ...ensureLots(fRaw) }, true));
      return;
    }
    const f = migrateItem(ensureLots(fRaw), true);
    const productionTimeHours = migrateHours(f, "productionTimeHours", "productionTimeDays", 24);
    finishedGoods.push({ id: f.id, name: f.name, sku: f.sku, unit: "ea", notes: f.notes || "", composition: f.composition, lots: f.lots });
    if (f.bom.length > 0) {
      const inputs = f.bom.map(line => ({ itemType: line.itemType === "raw" ? "raw" : "intermediate", itemId: line.itemId, qty: line.qty }));
      processes.push({
        id: uid(), name: "Final assembly — " + f.name, sku: f.sku ? f.sku + "-ASSY" : "",
        productionTimeHours, notes: "Migrated from previous finished-good bill of materials",
        inputs, equipment: Array.isArray(f.equipment) ? f.equipment : [],
        outputs: [{ id: uid(), itemType: "finished", itemId: f.id, qtyPerBatch: 1, costOverride: "" }]
      });
    }
  });

  const schedule = (Array.isArray(raw.schedule) ? raw.schedule : []).map(normalizeScheduleEntry);
  const productionTargets = Array.isArray(raw.productionTargets) ? raw.productionTargets : [];
  const equipment = normalizeEquipment(raw.equipment);
  const maintenance = (Array.isArray(raw.maintenance) ? raw.maintenance : []).map(m => ({ ...m, durationHours: migrateHours(m, "durationHours", "durationDays", 24) }));
  const customers = Array.isArray(raw.customers) ? raw.customers : [];
  const wasteStreams = (Array.isArray(raw.wasteStreams) ? raw.wasteStreams : []).map(w => migrateWasteStream(w));
  const shipments = normalizeShipments(raw.shipments);

  const migrated = migrateCompositionToComponents(rawMaterials, intermediateProducts, finishedGoods, raw.components);
  return backfillRowIds({ rawMaterials: migrated.rawMaterials, intermediateProducts: migrated.intermediateProducts, finishedGoods: migrated.finishedGoods, components: migrated.components, wasteStreams, processes, schedule, equipment, maintenance, customers, shipments, productionTargets, purchaseOrders: normalizePurchaseOrders(raw.purchaseOrders), salesOrders: normalizeSalesOrders(raw.salesOrders), fulfilmentCancellations: Array.isArray(raw.fulfilmentCancellations) ? raw.fulfilmentCancellations : [], operatingCalendars: ensureOperatingCalendars(raw.operatingCalendars), seedVersion: raw.seedVersion || "" });
}

/* ---------------------------------------------------------------
   MRP engine - recursive so it can walk a chain of processes of
   any depth (multi-stage production, or a finished good used as
   an input to a repackaging process). Composition is deliberately
   NOT part of this engine - it's a separate, informational basis.
----------------------------------------------------------------*/
function explodeToRaw(data, itemType, itemId, qty, path) {
  path = path || new Set();
  const totals = new Map();
  const add = (rid, q) => totals.set(rid, (totals.get(rid) || 0) + q);
  if (itemType === "raw") { add(itemId, qty); return totals; }

  const key = itemType + ":" + itemId;
  if (path.has(key)) return totals;
  const nextPath = new Set(path);
  nextPath.add(key);

  const process = findProcessForOutput(data, itemType, itemId);
  if (!process) return totals;
  const outputLine = (process.outputs || []).find(o => o.itemType === itemType && o.itemId === itemId);
  const batches = outputLine && outputLine.qtyPerBatch > 0 ? qty / outputLine.qtyPerBatch : 0;
  (process.inputs || []).forEach(line => {
    const sub = explodeToRaw(data, line.itemType, line.itemId, line.qty * batches, nextPath);
    sub.forEach((q, rid) => add(rid, q));
  });
  return totals;
}

function computeTimelineFor(data, itemType, itemId, qty, dueDate, path) {
  path = path || new Set();
  const segments = [], orderDates = [], equipmentUsage = [];
  if (itemType === "raw") {
    const raw = getRaw(data, itemId);
    if (raw) orderDates.push({ rawId: raw.id, neededBy: dueDate, orderBy: addDays(dueDate, -raw.leadTimeDays) });
    return { segments, orderDates, equipmentUsage };
  }
  const key = itemType + ":" + itemId;
  if (path.has(key)) return { segments, orderDates, equipmentUsage };
  const nextPath = new Set(path);
  nextPath.add(key);

  const process = findProcessForOutput(data, itemType, itemId);
  if (!process) return { segments, orderDates, equipmentUsage };
  const outputLine = (process.outputs || []).find(o => o.itemType === itemType && o.itemId === itemId);
  const batches = outputLine && outputLine.qtyPerBatch > 0 ? qty / outputLine.qtyPerBatch : 0;
  const start = addDays(dueDate, -Math.ceil(process.productionTimeHours / 24));
  const item = getCatalogItem(data, itemType, itemId);

  segments.push({ label: process.name + " → " + (item ? item.name : "item"), start, end: dueDate, kind: itemType });
  (process.equipment || []).forEach(eq => equipmentUsage.push({ equipmentId: eq.equipmentId, status: eq.status, start, end: dueDate, processName: process.name }));

  (process.inputs || []).forEach(line => {
    const sub = computeTimelineFor(data, line.itemType, line.itemId, line.qty * batches, start, nextPath);
    segments.push(...sub.segments);
    orderDates.push(...sub.orderDates);
    equipmentUsage.push(...sub.equipmentUsage);
  });

  return { segments, orderDates, equipmentUsage };
}

function computeTimeline(data, entry) {
  const result = computeTimelineFor(data, entry.productType, entry.productId, entry.qty, entry.dueDate);
  const earliestOrderBy = result.orderDates.length
    ? result.orderDates.reduce((min, o) => (o.orderBy < min ? o.orderBy : min), result.orderDates[0].orderBy)
    : null;
  return { segments: result.segments, orderDates: result.orderDates, earliestOrderBy, equipmentUsage: result.equipmentUsage };
}


/* ===============================================================
   TIME SERIES

   Everything historical in the app funnels through here: a flat
   list of dated events, bucketed into weeks, months or years over
   an explicit range.

   Two decisions worth stating, because they are easy to get wrong
   and hard to notice afterwards:

   1. Empty buckets are emitted, not skipped. A month with no
      production must appear as a zero, otherwise the axis silently
      compresses and a gap reads as continuity.
   2. All arithmetic is UTC. Dates are stored as plain yyyy-mm-dd
      with no zone; parsing them locally shifts them by a day for
      anyone west of Greenwich and quietly moves rows between
      buckets at month boundaries.
=============================================================== */

const parseISODate = (s) => {
  const parts = String(s || "").split("-");
  const y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
};

const fmtISODate = (dt) => dt.toISOString().slice(0, 10);

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* ISO-8601 week: weeks start Monday and belong to the year holding
   their Thursday, so the first days of January can land in the
   previous year's final week. */
function isoWeekParts(dt) {
  const t = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const dayIdx = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayIdx + 3);
  const isoYear = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Idx = (jan4.getUTCDay() + 6) % 7;
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4 - jan4Idx + 3));
  const week = 1 + Math.round((t - firstThursday) / (7 * 86400000));
  return { isoYear, week };
}

function mondayOf(dt) {
  const t = new Date(dt.getTime());
  const dayIdx = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayIdx);
  return t;
}

const GRANULARITIES = [
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
  { key: "year", label: "Annual" }
];

function bucketKeyOf(dateStr, granularity) {
  const dt = parseISODate(dateStr);
  if (!dt) return null;
  if (granularity === "year") return String(dt.getUTCFullYear());
  if (granularity === "month") return dt.getUTCFullYear() + "-" + String(dt.getUTCMonth() + 1).padStart(2, "0");
  const { isoYear, week } = isoWeekParts(dt);
  return isoYear + "-W" + String(week).padStart(2, "0");
}

function bucketLabelOf(key, granularity) {
  if (granularity === "year") return key;
  if (granularity === "month") {
    const [y, m] = key.split("-");
    return MONTH_NAMES[Number(m) - 1] + " " + String(y).slice(2);
  }
  const start = bucketStartOf(key, "week");
  return start ? start.getUTCDate() + " " + MONTH_NAMES[start.getUTCMonth()] : key;
}

function bucketStartOf(key, granularity) {
  if (granularity === "year") return new Date(Date.UTC(Number(key), 0, 1));
  if (granularity === "month") {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, 1));
  }
  const [y, w] = key.split("-W").map(Number);
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const jan4Idx = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = new Date(Date.UTC(y, 0, 4 - jan4Idx));
  return new Date(week1Monday.getTime() + (w - 1) * 7 * 86400000);
}

/* Every bucket between two dates inclusive, gaps included. */
function enumerateBuckets(from, to, granularity) {
  const start = parseISODate(from), end = parseISODate(to);
  if (!start || !end || start > end) return [];
  const keys = [];
  const guard = 4000;
  if (granularity === "year") {
    for (let y = start.getUTCFullYear(); y <= end.getUTCFullYear() && keys.length < guard; y++) keys.push(String(y));
    return keys;
  }
  if (granularity === "month") {
    let y = start.getUTCFullYear(), m = start.getUTCMonth();
    while (keys.length < guard) {
      const cur = new Date(Date.UTC(y, m, 1));
      if (cur > end) break;
      keys.push(y + "-" + String(m + 1).padStart(2, "0"));
      m++; if (m > 11) { m = 0; y++; }
    }
    return keys;
  }
  let cursor = mondayOf(start);
  while (cursor <= end && keys.length < guard) {
    keys.push(bucketKeyOf(fmtISODate(cursor), "week"));
    cursor = new Date(cursor.getTime() + 7 * 86400000);
  }
  return keys;
}

/* Fold dated events into buckets. `events` are { date, series, value }. */
function bucketEvents(events, range, seriesKeys) {
  const keys = enumerateBuckets(range.from, range.to, range.granularity);
  const blank = () => Object.fromEntries(seriesKeys.map(k => [k, 0]));
  const index = {};
  keys.forEach(k => { index[k] = blank(); });

  (events || []).forEach(e => {
    if (!e || !e.date) return;
    if (e.date < range.from || e.date > range.to) return;
    const k = bucketKeyOf(e.date, range.granularity);
    if (!index[k]) return;
    if (index[k][e.series] === undefined) return;
    index[k][e.series] += Number(e.value) || 0;
  });

  return keys.map(k => ({
    key: k,
    label: bucketLabelOf(k, range.granularity),
    total: seriesKeys.reduce((s, sk) => s + index[k][sk], 0),
    ...index[k]
  }));
}

/* ---------------------------------------------------------------
   Event extractors - each returns dated facts, nothing bucketed.
----------------------------------------------------------------*/

/* Output: a lot coming into existence is one unit of production. */
function productionEvents(data) {
  const out = [];
  [["intermediate", "intermediateProducts"], ["finished", "finishedGoods"]].forEach(([series, entity]) => {
    (data[entity] || []).forEach(item => (item.lots || []).forEach(lot => {
      // producedQty, not qty. `qty` is what REMAINS, so charting it makes
      // everything consumed downstream disappear from history - which on a
      // plant that consumes most of its own output means the chart shows a
      // fraction of what was actually made.
      if (lot.date) out.push({
        date: lot.date, series, value: lotProducedQty(lot),
        itemId: item.id, lotId: lot.id, batchId: lot.batchId || ""
      });
    }));
  });
  return out;
}

/* Goods-in: raw material lots as received. */
function receiptEvents(data) {
  const out = [];
  (data.rawMaterials || []).forEach(item => (item.lots || []).forEach(lot => {
    // Quantity received, not quantity left - same reasoning as above.
    if (lot.date) out.push({ date: lot.date, series: "raw", value: lotProducedQty(lot), itemId: item.id });
  }));
  return out;
}

/* Consumption is recorded on the daughter lot, not the parent: a
   lot's `sources` say what it drew and when. The parent's own qty
   only records what is left, so it cannot date the draw-down. */
function consumptionEvents(data) {
  const out = [];
  ["intermediateProducts", "finishedGoods"].forEach(entity => {
    (data[entity] || []).forEach(item => (item.lots || []).forEach(lot => {
      (lot.sources || []).forEach(s => {
        const sep = String(s.groupKey || "").indexOf(":");
        const itemType = sep < 0 ? "raw" : String(s.groupKey).slice(0, sep);
        if (lot.date) out.push({ date: lot.date, series: itemType, value: Number(s.qty) || 0 });
      });
    }));
  });
  return out;
}

function wasteEvents(data) {
  const out = [];
  (data.wasteStreams || []).forEach(ws => (ws.lots || []).forEach(lot => {
    if (lot.date) out.push({ date: lot.date, series: "waste", value: lotProducedQty(lot), itemId: ws.id });
  }));
  return out;
}

/* Batch-level history: one event per logged run, so the Overview can show
   how many batches were completed as well as how much came out of them. */
function batchEvents(data, records) {
  const recs = records || batchRecords(data);
  return recs.filter(r => r.date).map(r => ({
    date: r.date, series: "batches", value: 1,
    batchId: r.batchId, processId: r.processId,
    outputCost: r.outputCost, equipmentHours: r.equipmentHours
  }));
}

/* Sales. Revenue is recognised on shipment, which is the only sales
   event the model dates. Price comes from the customer's price list
   at the shipped quantity; a shipment with no priced line contributes
   units but no revenue, and is counted separately so the gap is
   visible rather than silently deflating the total. */
function shipmentEvents(data, cache) {
  const costCache = cache || {};
  const out = [];
  (data.shipments || []).forEach(sh => {
    if (!sh.shipDate) return;
    const qty = Number(sh.qty) || 0;
    const customer = sh.customerId ? getCustomer(data, sh.customerId) : null;
    const priceLine = customer
      ? (customer.priceList || []).find(p => p.finishedGoodId === sh.finishedGoodId)
      : null;
    const unitPrice = priceLine ? getEffectivePrice(priceLine, qty) : null;

    /* A shipment names the exact lot it drew from, so its cost is knowable
       rather than estimated. Standard cost - which reprices history every
       time a supplier moves - is only a fallback for a shipment with no lot
       reference, and is flagged when used. */
    let unitCost, costBasis;
    if (sh.lotId) {
      const c = lotCost(data, "finished", sh.finishedGoodId, sh.lotId, costCache);
      unitCost = c.unitCost;
      costBasis = c.basis;
    } else {
      unitCost = computeItemUnitCost(data, "finished", sh.finishedGoodId);
      costBasis = "standardCost";
    }

    out.push({
      shipment: sh, id: sh.id,
      date: sh.shipDate, qty, unitPrice, unitCost, costBasis,
      costEstimated: costBasis === "standardCost" || costBasis === "listPrice",
      revenue: unitPrice != null ? unitPrice * qty : 0,
      cogs: (unitCost || 0) * qty,
      margin: unitPrice != null ? (unitPrice - (unitCost || 0)) * qty : null,
      priced: unitPrice != null,
      lotId: sh.lotId || "",
      customerId: sh.customerId, finishedGoodId: sh.finishedGoodId
    });
  });
  return out;
}

/* Shipment lines, resolved for display. This is the same data the revenue
   chart aggregates, so a total taken from here and a bar on the chart are
   guaranteed to agree - which they did not when the table was built from
   schedule entries instead. */
function shipmentLines(data, range) {
  const cache = {};
  return shipmentEvents(data, cache)
    .filter(e => !range || (e.date >= range.from && e.date <= range.to))
    .map(e => {
      const fg = getFinished(data, e.finishedGoodId);
      const customer = e.customerId ? getCustomer(data, e.customerId) : null;
      const lot = fg && e.lotId ? (fg.lots || []).find(l => l.id === e.lotId) : null;
      /* Expected cost is the standard fixed on the day the run was fulfilled.
         Showing it beside the actual is what makes the line readable - the
         variance is the story, not either figure on its own. */
      const run = e.shipment.scheduleId
        ? (data.schedule || []).find(s => s.id === e.shipment.scheduleId)
        : (data.schedule || []).find(s =>
            (s.fulfillmentLots || []).some(fl => fl.lotId === e.lotId));
      const exp = run ? expectedUnitCost(data, run) : null;
      return {
        ...e,
        expectedUnitCost: exp ? exp.unitCost : null,
        expectedIsFrozen: exp ? exp.frozen : false,
        expectedCogs: exp ? exp.unitCost * e.qty : null,
        costVariance: exp ? (e.unitCost - exp.unitCost) * e.qty : null,
        productName: fg ? fg.name : "(deleted product)",
        unit: fg ? fg.unit : "",
        customerName: customer ? customer.name : "",
        lotNumber: lot ? lot.lotNumber : "",
        reference: e.shipment.reference || "",
        marginPct: (e.priced && e.revenue) ? (e.margin / e.revenue) * 100 : null
      };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/* Actual output attributed to a run. The fulfilment lots are what was really
   made against it; the run's own qty is only ever what was asked for. */
function fulfilledQtyOf(entry) {
  return (entry.fulfillmentLots || []).reduce((s, fl) => s + (Number(fl.qty) || 0), 0);
}

/* Scheduled against actual, one pair per run.

   "Scheduled" is the BASELINE for a frozen run and the current figure for one
   that was never frozen - and the distinction is flagged, because an unfrozen
   run's plan may have been edited to match whatever happened, which makes any
   adherence number computed from it meaningless. */
function planVsActualEvents(data) {
  return (data.schedule || [])
    .filter(s => s.status !== "Cancelled")
    .map(entry => {
      const measurable = entry.frozen === true;
      const plannedQty = measurable && entry.baselineQty !== "" && entry.baselineQty !== undefined
        ? Number(entry.baselineQty) || 0
        : Number(entry.qty) || 0;
      const plannedDate = (measurable && entry.baselineDueDate) || entry.dueDate || "";
      const actualQty = fulfilledQtyOf(entry);
      const actualDate = entry.completedDate || "";
      return {
        entry, measurable,
        plannedQty, plannedDate,
        actualQty, actualDate,
        complete: entry.status === "Complete",
        qtyVariance: actualQty - plannedQty,
        daysLate: (actualDate && plannedDate) ? daysBetweenISO(plannedDate, actualDate) : null,
        amended: (entry.revisions || []).length
      };
    });
}

/* Targets resolved onto the same buckets the charts already use. A target
   with no product applies to everything in that period. */
function targetForBucket(data, bucketKey, granularity, productId) {
  const rows = (data.productionTargets || []).filter(t =>
    t.periodType === granularity && t.periodKey === bucketKey);
  if (!rows.length) return null;
  const scoped = productId
    ? rows.filter(t => t.productId === productId)
    : rows.filter(t => !t.productId);
  const use = scoped.length ? scoped : (productId ? [] : rows);
  if (!use.length) return null;
  return use.reduce((s, t) => s + (Number(t.targetQty) || 0), 0);
}

/* Attach a target to each row of an already-bucketed series. */
function withTargets(rows, data, granularity, productId) {
  return rows.map(r => {
    const t = targetForBucket(data, r.key, granularity, productId);
    return { ...r, target: t === null ? "" : t,
             overTarget: t !== null && r.total > t,
             attainment: t ? Math.round((r.total / t) * 100) : null };
  });
}

/* What a customer is set up to buy, and at what price. Pulled out of the
   shipment form so the rule can be asserted directly rather than by reading
   rendered markup - this is the constraint that stops a shipment being
   recorded against a combination that can never be invoiced. */
function sellableToCustomer(data, customerId, allowUnpriced) {
  const all = data.finishedGoods || [];
  const customer = customerId ? getCustomer(data, customerId) : null;
  if (!customer) return { customer: null, priced: new Set(), offered: all, unpricedCount: 0 };
  const priced = new Set((customer.priceList || []).map(p => p.finishedGoodId));
  const offered = allowUnpriced ? all : all.filter(item => priced.has(item.id));
  return { customer, priced, offered, unpricedCount: all.length - priced.size };
}

/* The price a specific line would attract, or null when there is no agreed
   price. Null is the signal the form turns into a warning. */
function shipmentUnitPrice(data, customerId, finishedGoodId, qty) {
  const customer = customerId ? getCustomer(data, customerId) : null;
  if (!customer || !finishedGoodId) return null;
  const line = (customer.priceList || []).find(p => p.finishedGoodId === finishedGoodId);
  return line ? getEffectivePrice(line, Number(qty) || 0) : null;
}

/* Completed production orders, dated by when they were completed. */
function orderCompletionEvents(data) {
  return (data.schedule || [])
    .filter(s => s.status === "Complete" && s.completedDate)
    .map(s => ({ date: s.completedDate, series: "orders", value: 1, qty: Number(s.qty) || 0, entry: s }));
}

/* ---------------------------------------------------------------
   Range presets
----------------------------------------------------------------*/
function shiftISO(dateStr, days) {
  const dt = parseISODate(dateStr);
  if (!dt) return dateStr;
  return fmtISODate(new Date(dt.getTime() + days * 86400000));
}

const RANGE_PRESETS = [
  { key: "13w", label: "Last 13 weeks", granularity: "week", days: 91 },
  { key: "26w", label: "Last 26 weeks", granularity: "week", days: 182 },
  { key: "12m", label: "Last 12 months", granularity: "month", days: 365 },
  { key: "24m", label: "Last 24 months", granularity: "month", days: 730 },
  { key: "ytd", label: "Year to date", granularity: "month", ytd: true },
  { key: "all", label: "All time", granularity: "month", all: true },
  { key: "custom", label: "Custom…", granularity: null }
];

/* The full span of dated activity in the model, used by "All time"
   and to keep a custom range inside data that actually exists. */
function dataDateSpan(data) {
  const dates = [];
  const add = (d) => { if (d) dates.push(d); };
  ["rawMaterials", "intermediateProducts", "finishedGoods", "wasteStreams"].forEach(e =>
    (data[e] || []).forEach(i => (i.lots || []).forEach(l => { add(l.date); add(l.usedDate); add(l.consumedDate); })));
  (data.shipments || []).forEach(s => add(s.shipDate));
  (data.schedule || []).forEach(s => { add(s.dueDate); add(s.completedDate); });
  (data.maintenance || []).forEach(m => add(m.startDate));
  if (!dates.length) return { from: todayStr(), to: todayStr() };
  dates.sort();
  return { from: dates[0], to: dates[dates.length - 1] };
}

function resolvePreset(preset, data) {
  const today = todayStr();
  const p = RANGE_PRESETS.find(x => x.key === preset) || RANGE_PRESETS[0];
  if (p.all) {
    const span = dataDateSpan(data);
    return { from: span.from, to: today > span.to ? today : span.to, granularity: p.granularity };
  }
  if (p.ytd) {
    return { from: today.slice(0, 4) + "-01-01", to: today, granularity: p.granularity };
  }
  return { from: shiftISO(today, -p.days), to: today, granularity: p.granularity };
}


function productName(data, entry) {
  const item = entry.productType === "intermediate" ? getIntermediateProduct(data, entry.productId) : getFinished(data, entry.productId);
  return item ? item.name : "(deleted item)";
}



/* ===============================================================
   LOT-LEVEL COSTING

   computeItemUnitCost above answers "what would this item cost to
   make today", from the supplier's current price list. Useful for
   quoting, wrong for history: raise a green coffee price and every
   batch made last March silently reprices.

   What follows answers a different question - "what did THIS lot
   actually cost" - by carrying the price paid on each purchased lot
   forward along the traceability links that already exist. A lot's
   cost comes from the specific lots that fed it, at the prices those
   lots were bought at, however long ago.

   Two things make this work:

     producedQty  `qty` is what remains after draws, so it cannot
                  divide a total cost. The quantity made is recorded
                  separately and never decremented.
     sources      already record which lot was drawn and how much,
                  which is exactly the cost allocation.

   Material cost only. Conversion cost - labour, energy, equipment
   time - is recorded on the lot but not yet priced; see
   lotConversionHours below for the hours that are available.
=============================================================== */

/* Quantity a lot was made at, falling back to what is left when the
   figure predates this field. Never zero, so it cannot divide by it. */
function lotProducedQty(lot) {
  const made = Number(lot && lot.producedQty);
  if (Number.isFinite(made) && made > 0) return made;
  const remaining = Number(lot && lot.qty);
  return Number.isFinite(remaining) && remaining > 0 ? remaining : 0;
}

/* Cost per unit of one specific lot.

   Purchased lots use their own recorded price, falling back to the
   material's list price only when the lot has none - which is flagged
   in the result so the UI can say so rather than quietly implying the
   figure is historical.

   `cache` is required for anything larger than a toy dataset: a deep
   genealogy re-walks the same upstream lots many times over. */
function lotCost(data, itemType, itemId, lotId, cache, path) {
  cache = cache || {};
  const ck = itemType + ":" + itemId + ":" + lotId;
  if (cache[ck]) return cache[ck];

  path = path || new Set();
  if (path.has(ck)) {
    // A genealogy loop should not be possible, but recursing forever
    // on bad data is worse than reporting zero.
    return { unitCost: 0, totalCost: 0, basis: "cycle", estimated: true, sources: [] };
  }

  const item = getCatalogItem(data, itemType, itemId);
  const lot = item && (item.lots || []).find(l => l.id === lotId);
  if (!lot) {
    const miss = { unitCost: 0, totalCost: 0, basis: "missing", estimated: true, sources: [] };
    cache[ck] = miss;
    return miss;
  }

  const made = lotProducedQty(lot);

  /* Purchased material: the price on the lot is the fact. */
  if (itemType === "raw") {
    const own = Number(lot.unitCost);
    const hasOwn = Number.isFinite(own) && own > 0;
    const fallback = Number(item.unitCost) || 0;
    const unitCost = hasOwn ? own : fallback;
    const res = {
      unitCost, totalCost: unitCost * made, basis: hasOwn ? "purchased" : "listPrice",
      estimated: !hasOwn, sources: []
    };
    cache[ck] = res;
    return res;
  }

  /* Produced material: roll up the lots that fed it. */
  const nextPath = new Set(path);
  nextPath.add(ck);

  const contributions = [];
  let inputTotal = 0;
  let anyEstimated = false;

  (lot.sources || []).forEach(s => {
    const sep = String(s.groupKey || "").indexOf(":");
    if (sep < 0) return;
    const srcType = String(s.groupKey).slice(0, sep);
    const srcId = String(s.groupKey).slice(sep + 1);
    const qty = Number(s.qty) || 0;
    if (qty <= 0 || !s.lotId) return;

    const up = lotCost(data, srcType, srcId, s.lotId, cache, nextPath);
    const cost = up.unitCost * qty;
    inputTotal += cost;
    if (up.estimated) anyEstimated = true;

    const srcItem = getCatalogItem(data, srcType, srcId);
    const srcLot = srcItem && (srcItem.lots || []).find(l => l.id === s.lotId);
    contributions.push({
      itemType: srcType, itemId: srcId, lotId: s.lotId,
      itemName: srcItem ? srcItem.name : "(deleted item)",
      lotNumber: srcLot ? srcLot.lotNumber : "",
      qty, unit: srcItem ? srcItem.unit : "",
      unitCost: up.unitCost, cost,
      estimated: up.estimated
    });
  });

  /* A by-product carries no material cost by design - the whole input value
     lands on the saleable output. That is a costing decision, not a missing
     figure, so it must not raise the estimate flag or every batch that makes
     waste would look uncosted. */
  if (itemType === "waste" && !contributions.length) {
    const res = { unitCost: 0, totalCost: 0, basis: "byProduct", estimated: false, sources: [] };
    cache[ck] = res;
    return res;
  }

  /* Nothing upstream recorded: fall back to the standard cost so the
     figure is not misleadingly zero, and say that is what happened. */
  if (!contributions.length) {
    const std = computeItemUnitCost(data, itemType, itemId);
    const res = {
      unitCost: std, totalCost: std * made, basis: "standardCost",
      estimated: true, sources: []
    };
    cache[ck] = res;
    return res;
  }

  const unitCost = made > 0 ? inputTotal / made : 0;
  const res = {
    unitCost: Math.round(unitCost * 10000) / 10000,
    totalCost: Math.round(inputTotal * 100) / 100,
    basis: "rolledUp", estimated: anyEstimated, sources: contributions,
    producedQty: made
  };
  cache[ck] = res;
  return res;
}

/* Hours recorded against a lot, which is what a conversion rate would
   eventually be applied to. Surfaced now so the gap is visible. */
function lotConversionHours(lot) {
  return {
    equipment: (lot && lot.actualEquipment || []).reduce((s, a) => s + (Number(a.hours) || 0), 0),
    labour: (lot && lot.actualLabor || []).reduce((s, a) => s + (Number(a.hours) || 0), 0)
  };
}

/* Weighted average actual cost across the lots of an item that still
   hold stock - the figure to compare against the standard cost. */
function itemActualUnitCost(data, itemType, itemId, cache) {
  const item = getCatalogItem(data, itemType, itemId);
  if (!item) return null;
  let qty = 0, value = 0, estimated = false;
  (item.lots || []).forEach(lot => {
    const remaining = Number(lot.qty) || 0;
    if (remaining <= 0) return;
    const c = lotCost(data, itemType, itemId, lot.id, cache);
    qty += remaining;
    value += c.unitCost * remaining;
    if (c.estimated) estimated = true;
  });
  if (qty <= 0) return null;
  return {
    unitCost: Math.round((value / qty) * 10000) / 10000,
    stockQty: qty, stockValue: Math.round(value * 100) / 100, estimated
  };
}

/* ===============================================================
   PROCESS BATCH RECORDS

   A batch is one execution of one process. It has always existed in
   the data - the lots it produced share a date, a source list and an
   equipment record - but it had no identity, so there was no way to
   look at "the run" rather than at each output lot separately.

   Lots now carry batchId and processId, stamped when the batch is
   logged. This assembles them back into the record of the run.
=============================================================== */
const LOT_BEARING_ENTITIES = ["rawMaterials", "intermediateProducts", "finishedGoods", "wasteStreams"];

function allLotsWithOwner(data) {
  const out = [];
  LOT_BEARING_ENTITIES.forEach(entity => {
    const itemType = ENTITY_ITEM_TYPE[entity] || entity;
    (data[entity] || []).forEach(item => (item.lots || []).forEach(lot => {
      out.push({ lot, item, itemType, entity });
    }));
  });
  return out;
}

/* One record per logged batch, newest first. Lots with no batchId are
   either purchased or predate batch identity, and are not batches. */
function batchRecords(data, options) {
  const opts = options || {};
  const cache = {};
  const groups = {};

  allLotsWithOwner(data).forEach(({ lot, item, itemType }) => {
    if (!lot.batchId) return;
    if (!groups[lot.batchId]) {
      groups[lot.batchId] = {
        batchId: lot.batchId, processId: lot.processId || "",
        date: lot.date || "", outputs: [], notes: lot.notes || ""
      };
    }
    const g = groups[lot.batchId];
    if (lot.date && (!g.date || lot.date < g.date)) g.date = lot.date;
    const cost = lotCost(data, itemType, item.id, lot.id, cache);
    g.outputs.push({
      itemType, itemId: item.id, itemName: item.name, unit: item.unit,
      lotId: lot.id, lotNumber: lot.lotNumber,
      producedQty: lotProducedQty(lot), remainingQty: Number(lot.qty) || 0,
      unitCost: cost.unitCost, totalCost: cost.totalCost,
      estimated: cost.estimated, basis: cost.basis,
      qcChecks: lot.qcChecks || [], lot
    });
  });

  return Object.values(groups).map(g => {
    const proc = g.processId ? getProcess(data, g.processId) : null;
    // Inputs, equipment and labour are recorded identically on every
    // output of a batch, so read them from the first one rather than
    // summing duplicates.
    const lead = g.outputs[0] ? g.outputs[0].lot : null;
    const hours = lotConversionHours(lead);
    const inputs = [];
    (lead && lead.sources || []).forEach(s => {
      const sep = String(s.groupKey || "").indexOf(":");
      if (sep < 0) return;
      const t = String(s.groupKey).slice(0, sep), i = String(s.groupKey).slice(sep + 1);
      const srcItem = getCatalogItem(data, t, i);
      const srcLot = srcItem && (srcItem.lots || []).find(l => l.id === s.lotId);
      const c = s.lotId ? lotCost(data, t, i, s.lotId, cache) : { unitCost: 0, estimated: true };
      inputs.push({
        itemType: t, itemId: i, itemName: srcItem ? srcItem.name : "(deleted item)",
        unit: srcItem ? srcItem.unit : "", lotNumber: srcLot ? srcLot.lotNumber : "",
        qty: Number(s.qty) || 0, unitCost: c.unitCost,
        cost: c.unitCost * (Number(s.qty) || 0), estimated: c.estimated
      });
    });

    const inputCost = inputs.reduce((s, x) => s + x.cost, 0);
    const outputCost = g.outputs.reduce((s, x) => s + x.totalCost, 0);

    return {
      batchId: g.batchId,
      date: g.date,
      processId: g.processId,
      process: proc,
      processName: proc ? proc.name : "(process deleted)",
      processSku: proc ? proc.sku : "",
      outputs: g.outputs,
      inputs,
      inputCost: Math.round(inputCost * 100) / 100,
      outputCost: Math.round(outputCost * 100) / 100,
      equipment: (lead && lead.actualEquipment || []).map(a => ({
        equipmentId: a.equipmentId, hours: Number(a.hours) || 0,
        eq: getEquipment(data, a.equipmentId)
      })),
      labour: (lead && lead.actualLabor || []).map(a => ({
        operatorName: a.operatorName, hours: Number(a.hours) || 0
      })),
      equipmentHours: hours.equipment,
      labourHours: hours.labour,
      qcChecks: g.outputs.reduce((s, o) => s + (o.qcChecks || []).length, 0),
      estimated: g.outputs.some(o => o.estimated),
      notes: g.notes
    };
  })
  .filter(b => !opts.processId || b.processId === opts.processId)
  .filter(b => !opts.from || (b.date >= opts.from && b.date <= (opts.to || "9999-12-31")))
  .sort((a, b) => String(b.date).localeCompare(String(a.date)) ||
                  String(b.batchId).localeCompare(String(a.batchId)));
}


/* ===============================================================
   PURCHASE ORDERS

   Before this, a raw material carried a single `onOrder` number with
   no date attached, so the forecast knew a quantity was coming but
   not when - which is the half of the question that matters when
   deciding whether to expedite.

   An order now records when it was placed, how much, what it cost,
   when it is expected, and every instalment actually received. The
   gap between expected and actual is what the delivery history is
   for; the gap between expected and required is what the forecast
   calendar is for.
=============================================================== */

function poReceivedQty(po) {
  return (po.receipts || []).reduce((s, r) => s + (Number(r.qty) || 0), 0);
}

function poOutstanding(po) {
  if (po.status === "Cancelled") return 0;
  return Math.max(0, (Number(po.qty) || 0) - poReceivedQty(po));
}

/* Last instalment date, which is when the order actually completed. */
function poActualDate(po) {
  const dates = (po.receipts || []).map(r => r.date).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : "";
}

/* Status is stored so it can be set deliberately - a cancelled order is a
   decision, not an inference - but it is reconciled against the receipts
   so it cannot drift out of step with them. */
function poDerivedStatus(po) {
  if (po.status === "Cancelled" || po.status === "Draft") return po.status;
  const received = poReceivedQty(po);
  const ordered = Number(po.qty) || 0;
  if (received <= 0) return "Ordered";
  if (received + 0.001 < ordered) return "Part received";
  return "Received";
}

/* Days late against the expected date. Null while nothing has arrived. */
function poDaysLate(po) {
  const actual = poActualDate(po);
  if (!actual || !po.expectedDate) return null;
  return daysBetweenISO(po.expectedDate, actual);
}

/* Quantity on order for a material, from the orders themselves rather than
   a hand-maintained figure. Falls back to the stored `onOrder` only when a
   material has no orders at all, so databases that predate this keep working. */
function openOrderQty(data, rawMaterialId) {
  const orders = (data.purchaseOrders || []).filter(po => po.rawMaterialId === rawMaterialId);
  if (!orders.length) {
    const raw = getRaw(data, rawMaterialId);
    return raw ? Number(raw.onOrder) || 0 : 0;
  }
  return orders.reduce((s, po) => s + poOutstanding(po), 0);
}

/* ---------------------------------------------------------------
   Ordering by the container, and what a purchase order is worth.

   A purchase order is the record both systems agree on: the MRP raises
   it, the warehouse receives against it. So it has to carry what each
   side needs - the material and its cost for the MRP, the container and
   how many of them for the dock.

   `qty` stays authoritative and is always in the material's own unit;
   containerCount is derived from it through the packaging rather than
   held independently, so the two can never drift apart. Units are
   conserved: containers x units-per-container = qty.
----------------------------------------------------------------*/

/* Units in one container. Absent or nonsensical values fall back to 1,
   which makes a container equal one unit rather than zero - a bad
   packaging record should not silently make an order worth nothing. */
function unitsPerContainer(packaging) {
  const n = Number(packaging && packaging.unitsPerPackage);
  return n > 0 ? n : 1;
}

/* The packaging a purchase order was raised against, or the material's
   default when the order predates packaging. Null when neither exists. */
function poPackaging(data, po) {
  const raw = getRaw(data, po && po.rawMaterialId);
  const list = (raw && raw.packagings) || [];
  if (!list.length) return null;
  return (po && po.packagingId && list.find(p => p.id === po.packagingId))
    || list.find(p => p.isDefault) || list[0] || null;
}

/* How a container reads on a dock sheet: "60 kg sack", but just
   "case of 1000" when the size already names the container. */
function packagingLabel(packaging) {
  if (!packaging) return "";
  const size = String(packaging.size || "").trim();
  const type = String(packaging.packageType || "").trim();
  if (!type) return size;
  if (!size) return type;
  return size.toLowerCase().includes(type.toLowerCase()) ? size : size + " " + type;
}

function qtyFromContainers(packaging, containerCount) {
  return (Number(containerCount) || 0) * unitsPerContainer(packaging);
}

/* Containers needed to hold a quantity. Rounded up, because a part
   container is still a container that has to be ordered and stored. */
function containersFromQty(packaging, qty) {
  const per = unitsPerContainer(packaging);
  return Math.ceil(((Number(qty) || 0) / per) - 0.000001) || 0;
}

/* What the order is worth. Held nowhere - always derived from quantity
   and unit cost, so it cannot disagree with them. */
function poTotalCost(po) {
  return (Number(po && po.qty) || 0) * (Number(po && po.unitCost) || 0);
}

/* "10 x 55 gal drum" - how the order reads on a dock sheet. */
function poContainerSummary(data, po) {
  const pkg = poPackaging(data, po);
  if (!pkg) return "";
  const count = (po && po.containerCount != null && po.containerCount !== "")
    ? Number(po.containerCount) : containersFromQty(pkg, po && po.qty);
  return count + " × " + packagingLabel(pkg);
}

/* Stock physically on hand for a material, from its lots. */
function rawStockOnHand(raw) {
  return ((raw && raw.lots) || []).reduce((s, l) => s + (Number(l.qty) || 0), 0);
}

/* ---------------------------------------------------------------
   Forecast -> suggested orders.

   Reorder point and minimum order quantity are already held per
   material; this is what they were for. A material is short when what
   is on hand plus what is already on order will not cover its reorder
   point. The shortfall is then rounded up to whole containers and to
   the minimum order quantity, so a suggestion is something that can
   actually be placed rather than an arbitrary number.

   Deliberately a suggestion, not an automatic order: it returns rows to
   review, and nothing is written until they are accepted.
----------------------------------------------------------------*/
function suggestPurchaseOrders(data, options) {
  const opts = options || {};
  const materials = (data && data.rawMaterials) || [];
  const rows = [];
  materials.forEach(raw => {
    const reorderPoint = Number(raw.reorderPoint) || 0;
    if (reorderPoint <= 0) return;
    const onHand = rawStockOnHand(raw);
    const onOrder = openOrderQty(data, raw.id);
    const available = onHand + onOrder;
    if (available >= reorderPoint) return;

    const pkg = (raw.packagings || []).find(p => p.isDefault) || (raw.packagings || [])[0] || null;
    const shortfall = reorderPoint - available;
    const moq = Number(raw.moq) || 0;
    const target = Math.max(shortfall, moq);
    const containerCount = pkg ? containersFromQty(pkg, target) : 0;
    // Ordering by the container can only ever round up, never below the
    // shortfall that triggered the suggestion.
    const qty = pkg ? qtyFromContainers(pkg, containerCount) : target;

    rows.push({
      rawMaterialId: raw.id,
      name: raw.name,
      sku: raw.sku,
      supplier: raw.supplier || "",
      unit: raw.unit || "",
      onHand, onOrder, available, reorderPoint, shortfall, moq,
      packagingId: pkg ? pkg.id : "",
      packagingSku: pkg ? pkg.sku : "",
      packagingLabel: packagingLabel(pkg),
      containerCount, qty,
      unitCost: Number(raw.unitCost) || 0,
      totalCost: qty * (Number(raw.unitCost) || 0),
      leadTimeDays: Number(raw.leadTimeDays) || 0,
      expectedDate: shiftISO(opts.today || todayStr(), Number(raw.leadTimeDays) || 0),
      uncataloged: !pkg
    });
  });
  return rows.sort((a, b) => (b.shortfall / (b.reorderPoint || 1)) - (a.shortfall / (a.reorderPoint || 1)));
}

/* References have to be unique - they are the order's natural key and
   what the warehouse quotes when receiving. Minted from the highest
   existing number so a reference is never reused. */
function nextPoReference(data, prefix) {
  const p = prefix || "PO-";
  let max = 0;
  ((data && data.purchaseOrders) || []).forEach(po => {
    const m = String(po.reference || "").match(/(\d+)\s*$/);
    if (m) max = Math.max(max, Number(m[1]) || 0);
  });
  return p + String(max + 1).padStart(4, "0");
}

/* One row per order, with everything derived resolved, newest first. */
function purchaseOrderRecords(data, options) {
  const opts = options || {};
  return (data.purchaseOrders || []).map(po => {
    const raw = getRaw(data, po.rawMaterialId);
    const received = poReceivedQty(po);
    const status = poDerivedStatus(po);
    const actualDate = poActualDate(po);
    const daysLate = poDaysLate(po);
    return {
      po, raw,
      reference: po.reference,
      materialName: raw ? raw.name : "(deleted material)",
      materialSku: raw ? raw.sku : "",
      unit: raw ? raw.unit : "",
      supplier: po.supplier || (raw ? raw.supplier : ""),
      orderDate: po.orderDate,
      expectedDate: po.expectedDate,
      actualDate,
      qty: Number(po.qty) || 0,
      receivedQty: received,
      outstanding: poOutstanding(po),
      unitCost: Number(po.unitCost) || 0,
      value: (Number(po.unitCost) || 0) * (Number(po.qty) || 0),
      status,
      open: status === "Ordered" || status === "Part received",
      late: daysLate !== null && daysLate > 0,
      daysLate,
      // An open order whose expected date has already passed is the one to
      // chase; it is not "late" yet because nothing has arrived to judge.
      overdue: (status === "Ordered" || status === "Part received") &&
               !!po.expectedDate && po.expectedDate < todayStr(),
      receipts: (po.receipts || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)))
    };
  })
  .filter(r => !opts.rawMaterialId || r.po.rawMaterialId === opts.rawMaterialId)
  .filter(r => !opts.from || (
    (r.orderDate >= opts.from && r.orderDate <= (opts.to || "9999-12-31")) ||
    (r.expectedDate >= opts.from && r.expectedDate <= (opts.to || "9999-12-31")) ||
    (r.actualDate && r.actualDate >= opts.from && r.actualDate <= (opts.to || "9999-12-31"))
  ))
  .sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate)));
}

/* ---------------------------------------------------------------
   Procurement events, for the forecast chart
----------------------------------------------------------------*/

/* Quantity placed on order, dated by the order date. */
function purchaseOrderedEvents(data, rawMaterialId) {
  return (data.purchaseOrders || [])
    .filter(po => po.status !== "Cancelled")
    .filter(po => !rawMaterialId || po.rawMaterialId === rawMaterialId)
    .filter(po => po.orderDate)
    .map(po => ({ date: po.orderDate, series: "ordered", value: Number(po.qty) || 0,
                  rawMaterialId: po.rawMaterialId, poId: po.id }));
}

/* Quantity expected to arrive, dated by the expected date. Outstanding only -
   what has already landed belongs in the received series, not both. */
function purchaseExpectedEvents(data, rawMaterialId) {
  return (data.purchaseOrders || [])
    .filter(po => po.status !== "Cancelled")
    .filter(po => !rawMaterialId || po.rawMaterialId === rawMaterialId)
    .filter(po => po.expectedDate && poOutstanding(po) > 0)
    .map(po => ({ date: po.expectedDate, series: "expected", value: poOutstanding(po),
                  rawMaterialId: po.rawMaterialId, poId: po.id }));
}

/* Quantity actually received, dated by each instalment. */
function purchaseReceivedEvents(data, rawMaterialId) {
  const out = [];
  (data.purchaseOrders || []).forEach(po => {
    if (rawMaterialId && po.rawMaterialId !== rawMaterialId) return;
    (po.receipts || []).forEach(r => {
      if (!r.date) return;
      out.push({ date: r.date, series: "received", value: Number(r.qty) || 0,
                 rawMaterialId: po.rawMaterialId, poId: po.id, lotId: r.lotId });
    });
  });
  return out;
}





/* ===============================================================
   PROCESS FLOW

   The flow is not something to draw by hand and keep in step - it is
   already implied by the processes. Every process names what it
   consumes and what it produces, so the graph is derived, and it
   cannot drift from the recipes the way a maintained diagram would.

   Nodes are materials; edges are processes. Layering is a longest-
   path assignment, which puts a stage to the right of everything
   feeding it even when the chain is uneven - grinding and packing
   are not the same depth, and forcing them into one column would
   misrepresent the plant.
=============================================================== */

function flowNodeKey(itemType, itemId) { return itemType + ":" + itemId; }

function materialFlowGraph(data) {
  const nodes = {};
  const edges = [];

  const addNode = (itemType, itemId) => {
    const key = flowNodeKey(itemType, itemId);
    if (nodes[key]) return nodes[key];
    const item = getCatalogItem(data, itemType, itemId);
    nodes[key] = {
      key, itemType, itemId,
      name: item ? item.name : "(deleted item)",
      sku: item ? (item.sku || "") : "",
      unit: item ? item.unit : "",
      stock: item ? lotQty(item.lots) : 0,
      lotCount: item ? (item.lots || []).filter(l => (Number(l.qty) || 0) > 0).length : 0,
      inbound: [], outbound: [], layer: 0, missing: !item
    };
    return nodes[key];
  };

  (data.processes || []).forEach(proc => {
    const ins = (proc.inputs || []).filter(i => i.itemId);
    const outs = (proc.outputs || []).filter(o => o.itemId);
    ins.forEach(i => addNode(i.itemType, i.itemId));
    outs.forEach(o => addNode(o.itemType, o.itemId));

    outs.forEach(o => {
      const target = addNode(o.itemType, o.itemId);
      if (!ins.length) {
        edges.push({ processId: proc.id, processName: proc.name, from: null, to: target.key, qty: 0 });
        if (target.inbound.indexOf(proc.id) < 0) target.inbound.push(proc.id);
        return;
      }
      ins.forEach(i => {
        const source = addNode(i.itemType, i.itemId);
        edges.push({
          processId: proc.id, processName: proc.name, processSku: proc.sku || "",
          from: source.key, to: target.key,
          qty: Number(i.qty) || 0, perBatch: Number(o.qtyPerBatch) || 0,
          hours: Number(proc.productionTimeHours) || 0,
          equipmentCount: (proc.equipment || []).length
        });
        if (source.outbound.indexOf(proc.id) < 0) source.outbound.push(proc.id);
        if (target.inbound.indexOf(proc.id) < 0) target.inbound.push(proc.id);
      });
    });
  });

  const nodeList = Object.values(nodes);
  const bySource = {};
  edges.forEach(e => { if (e.from) (bySource[e.from] = bySource[e.from] || []).push(e); });

  let changed = true, guard = 0;
  while (changed && guard < nodeList.length + 5) {
    changed = false; guard++;
    nodeList.forEach(n => {
      (bySource[n.key] || []).forEach(e => {
        const target = nodes[e.to];
        if (target && target.layer < n.layer + 1) { target.layer = n.layer + 1; changed = true; }
      });
    });
  }
  const cyclic = changed;

  const maxLayer = nodeList.reduce((m, n) => (n.layer > m ? n.layer : m), 0);
  return {
    nodes, nodeList, edges, maxLayer, cyclic,
    sources: nodeList.filter(n => n.inbound.length === 0),
    sinks: nodeList.filter(n => n.outbound.length === 0)
  };
}

/* Layers as columns, each ordered raw, intermediate, finished, waste. */
function materialFlowColumns(graph) {
  const order = { raw: 0, intermediate: 1, finished: 2, waste: 3 };
  const cols = [];
  for (let i = 0; i <= graph.maxLayer; i++) {
    const members = graph.nodeList.filter(n => n.layer === i)
      .sort((a, b) => ((order[a.itemType] || 0) - (order[b.itemType] || 0)) ||
                      String(a.name).localeCompare(String(b.name)));
    if (members.length) cols.push({ layer: i, nodes: members });
  }
  return cols;
}

/* ---------------------------------------------------------------
   Stock-aware requirement planning

   explodeToRaw answers "what raw material does this need starting
   from nothing". That is the wrong question when there is already
   powder in the warehouse: the honest answer is usually "one packing
   run", not a campaign from green coffee.

   This walks the same tree but stops wherever stock on hand covers
   the requirement, and reports which stages were skipped - so a
   planner can see a finished good is one step away, not six.
----------------------------------------------------------------*/
function stockAwarePlan(data, itemType, itemId, qty, options) {
  const opts = options || {};
  const reserved = opts.reserved || {};
  const steps = [];
  const shortages = [];

  const visit = (t, id, need, depth, path) => {
    if (depth > 12) return;
    const key = flowNodeKey(t, id);
    if (path.has(key)) return;

    const item = getCatalogItem(data, t, id);
    const onHand = item ? lotQty(item.lots) : 0;
    const alreadyUsed = reserved[key] || 0;
    const available = Math.max(0, onHand - alreadyUsed);
    const fromStock = Math.min(available, need);
    const toMake = Math.max(0, need - fromStock);

    reserved[key] = alreadyUsed + fromStock;

    const proc = t === "raw" ? null : findProcessForOutput(data, t, id);

    steps.push({
      key, itemType: t, itemId: id, depth,
      name: item ? item.name : "(deleted item)",
      sku: item ? (item.sku || "") : "",
      unit: item ? item.unit : "",
      required: need, onHand, available, fromStock, toMake,
      covered: toMake <= 0.0001,
      process: proc,
      processName: proc ? proc.name : "",
      mustPurchase: t === "raw" && toMake > 0.0001
    });

    if (toMake <= 0.0001) return;

    if (t === "raw") {
      shortages.push({ itemType: t, itemId: id, name: item ? item.name : "",
                       qty: toMake, unit: item ? item.unit : "" });
      return;
    }
    if (!proc) {
      shortages.push({ itemType: t, itemId: id, name: item ? item.name : "",
                       qty: toMake, unit: item ? item.unit : "", noProcess: true });
      return;
    }

    const outLine = (proc.outputs || []).find(o => o.itemType === t && o.itemId === id);
    const perBatch = outLine && Number(outLine.qtyPerBatch) > 0 ? Number(outLine.qtyPerBatch) : 0;
    const batches = perBatch > 0 ? Math.ceil(toMake / perBatch) : 1;

    const nextPath = new Set(path); nextPath.add(key);
    (proc.inputs || []).forEach(line => {
      if (!line.itemId) return;
      visit(line.itemType, line.itemId, (Number(line.qty) || 0) * batches, depth + 1, nextPath);
    });
  };

  visit(itemType, itemId, Number(qty) || 0, 0, new Set());

  const toMakeSteps = steps.filter(s => s.toMake > 0.0001 && s.itemType !== "raw");
  const coveredSteps = steps.filter(s => s.covered && s.depth > 0);

  return {
    steps, shortages,
    stagesToRun: toMakeSteps.length,
    stagesCovered: coveredSteps.length,
    startsAt: toMakeSteps.length ? toMakeSteps[toMakeSteps.length - 1] : null,
    fullyCovered: toMakeSteps.length === 0,
    purchaseNeeded: steps.filter(s => s.mustPurchase)
  };
}

/* The flow tab was written against these names; they are thin wrappers over
   the graph and plan above rather than a second implementation. */
function processGraph(data) {
  const g = materialFlowGraph(data);
  // The tab lays the diagram out by column, so hand it the layers directly.
  return { ...g, layers: materialFlowColumns(g).map(c => c.nodes) };
}

/* Coverage in the shape the flow tab consumes: one row per material with the
   action the planner would take, and the headline counts. */
function coverageSummary(data, itemType, itemId, qty) {
  const plan = stockAwarePlan(data, itemType, itemId, qty);
  const rows = plan.steps.map(s => ({
    key: s.key, itemType: s.itemType, itemId: s.itemId, name: s.name,
    unit: s.unit, depth: s.depth,
    required: s.required, onHand: s.onHand, fromStock: s.fromStock,
    shortfall: s.toMake,
    // What a planner would actually do about this material.
    action: s.covered ? "fromStock"
      : s.mustPurchase ? "purchase"
      : s.process ? "make" : "blocked",
    processName: s.processName
  }));
  return {
    rows,
    target: rows[0] || null,
    fromStock: rows.filter(r => r.action === "fromStock").length,
    toMake: rows.filter(r => r.action === "make").length,
    toPurchase: rows.filter(r => r.action === "purchase").length,
    blocked: rows.filter(r => r.action === "blocked").length,
    alreadyCovered: plan.fullyCovered,
    startsAt: plan.startsAt,
    plan
  };
}

/* ===============================================================
   HELD FINISHED GOODS

   Stock made against a run, still allocated to it, not yet shipped.
   Shipped quantity is subtracted, so what remains is the exposure:
   cash spent making it, and revenue that will not be recognised
   until it moves.

   Cancelling an allocation does not destroy stock. The goods stay in
   the lot; they simply stop being earmarked for that order and become
   available to anything else. That distinction matters - a cancelled
   order is a commercial event, not a stock write-off.
=============================================================== */

/* What becomes of the goods once the order is cancelled. Returning them is
   the common case and touches nothing but the earmark; every other option
   consumes the quantity out of the lot and writes the reason onto it, so the
   stock record does not have to be corrected separately afterwards. */
const CANCELLATION_DISPOSITIONS = [
  { key: "return", label: "Return to unassigned inventory",
    consumes: false, waste: false,
    hint: "Goods stay on the rack and become available to any other order." },
  { key: "damaged", label: "Consume \u2014 mark as damaged",
    consumes: true, waste: false, reason: "Damaged",
    hint: "Removed from stock and recorded against the lot as damaged." },
  { key: "expired", label: "Consume \u2014 mark as expired",
    consumes: true, waste: false, reason: "Expired",
    hint: "Removed from stock and recorded against the lot as out of date." },
  { key: "lost", label: "Consume \u2014 mark as lost",
    consumes: true, waste: false, reason: "Lost",
    hint: "Removed from stock and recorded against the lot as unaccounted for." },
  { key: "waste-dispose", label: "Generate waste \u2014 dispose",
    consumes: true, waste: true, accumulate: false, reason: "Disposed",
    hint: "Consumed and disposed of immediately. No waste stream is accrued." },
  { key: "waste-accumulate", label: "Generate waste \u2014 accumulate",
    consumes: true, waste: true, accumulate: true, reason: "Sent to waste",
    hint: "Consumed and accrued to the waste streams its composition maps to." }
];

const CANCELLATION_REASONS = [
  "Customer cancelled the order",
  "Customer deferred delivery indefinitely",
  "Failed QC / quality hold",
  "Shelf life too short to ship",
  "Damaged in storage",
  "Reallocated to another customer",
  "Order superseded by a revised order",
  "Commercial dispute",
  "Duplicate or erroneous run"
];

/* Quantity already cancelled out of a run's allocation. */
function cancelledFromRun(data, scheduleId, lotId) {
  return (data.fulfilmentCancellations || [])
    .filter(c => c.scheduleId === scheduleId && (!lotId || c.lotId === lotId))
    .reduce((s, c) => s + (Number(c.qty) || 0), 0);
}

/* One row per completed run with stock still held against it. Runs entirely
   shipped or entirely cancelled drop out - the list is exposure, not history. */
function heldFinishedGoods(data, options) {
  const opts = options || {};
  const cache = {};

  return (data.schedule || [])
    .filter(s => s.productType === "finished")
    .filter(s => s.status === "Complete" && (s.fulfillmentLots || []).length > 0)
    .map(entry => {
      const fg = getFinished(data, entry.productId);
      const customer = entry.customerId ? getCustomer(data, entry.customerId) : null;

      const lots = (entry.fulfillmentLots || []).map(fl => {
        const lot = fg ? (fg.lots || []).find(l => l.id === fl.lotId) : null;
        /* fl.qty IS the live allocation - cancelling reduces it directly - so
           the cancellation records must not be subtracted again. They are
           read only to show what has already been released. */
        const allocated = Number(fl.qty) || 0;
        const shipped = shippedFromLot(data, fl.lotId);
        const cancelled = cancelledFromRun(data, entry.id, fl.lotId);
        const held = Math.max(0, allocated - shipped);
        const cost = fl.lotId
          ? lotCost(data, "finished", entry.productId, fl.lotId, cache)
          : { unitCost: 0, estimated: true, basis: "missing" };
        return {
          lotId: fl.lotId,
          lotNumber: lot ? lot.lotNumber : "(lot missing)",
          lotDate: lot ? lot.date : "",
          batchId: lot ? lot.batchId : "",
          processId: lot ? lot.processId : "",
          allocated, shipped, cancelled, held,
          lotStock: lot ? Number(lot.qty) || 0 : 0,
          unitCost: cost.unitCost,
          estimated: cost.estimated,
          cogs: cost.unitCost * held
        };
      });

      const heldQty = lots.reduce((s, l) => s + l.held, 0);
      const cogs = lots.reduce((s, l) => s + l.cogs, 0);

      const priceLine = customer
        ? (customer.priceList || []).find(p => p.finishedGoodId === entry.productId)
        : null;
      const unitPrice = priceLine ? getEffectivePrice(priceLine, heldQty || 1) : null;

      const dueDate = entry.baselineDueDate || entry.dueDate || "";
      const ageDays = entry.completedDate ? daysBetweenISO(entry.completedDate, todayStr()) : 0;
      const overdueDays = dueDate ? daysBetweenISO(dueDate, todayStr()) : 0;

      return {
        entry, fg, customer, lots,
        productName: fg ? fg.name : "(deleted product)",
        unit: fg ? fg.unit : "",
        customerName: customer ? customer.name : "",
        completedDate: entry.completedDate || "",
        dueDate,
        allocatedQty: lots.reduce((s, l) => s + l.allocated, 0),
        shippedQty: lots.reduce((s, l) => s + l.shipped, 0),
        cancelledQty: lots.reduce((s, l) => s + l.cancelled, 0),
        heldQty,
        cogs,
        unitPrice,
        salesValue: unitPrice != null ? unitPrice * heldQty : null,
        priced: unitPrice != null,
        marginAtRisk: unitPrice != null ? unitPrice * heldQty - cogs : null,
        estimated: lots.some(l => l.estimated && l.held > 0),
        ageDays,
        // Past its promised date and still sitting here is the row to act on.
        overdue: overdueDays > 0,
        overdueDays: overdueDays > 0 ? overdueDays : 0
      };
    })
    .filter(r => r.heldQty > 0.001)
    .filter(r => !opts.customerId || r.entry.customerId === opts.customerId)
    .sort((a, b) => (b.overdueDays - a.overdueDays) || (b.cogs - a.cogs));
}

function heldSummary(data, options) {
  const rows = heldFinishedGoods(data, options);
  return {
    rows,
    runs: rows.length,
    heldQty: rows.reduce((s, r) => s + r.heldQty, 0),
    cogs: rows.reduce((s, r) => s + r.cogs, 0),
    salesValue: rows.reduce((s, r) => s + (r.salesValue || 0), 0),
    overdue: rows.filter(r => r.overdue),
    overdueCogs: rows.filter(r => r.overdue).reduce((s, r) => s + r.cogs, 0),
    unpriced: rows.filter(r => !r.priced).length,
    oldestDays: rows.reduce((m, r) => (r.ageDays > m ? r.ageDays : m), 0)
  };
}

/* Cancellation records, resolved for display. Append-only: nothing in the
   app edits or removes one. */
function cancellationRecords(data, options) {
  const opts = options || {};
  return (data.fulfilmentCancellations || []).map(c => {
    const fg = getFinished(data, c.finishedGoodId);
    const customer = c.customerId ? getCustomer(data, c.customerId) : null;
    const run = (data.schedule || []).find(s => s.id === c.scheduleId);
    const lot = fg && c.lotId ? (fg.lots || []).find(l => l.id === c.lotId) : null;
    return {
      cancellation: c, fg, customer, run, lot,
      productName: fg ? fg.name : "(deleted product)",
      unit: fg ? fg.unit : "",
      customerName: customer ? customer.name : "",
      lotNumber: lot ? lot.lotNumber : "",
      qty: Number(c.qty) || 0,
      salesValue: Number(c.salesValue) || 0,
      cogs: Number(c.cogs) || 0,
      marginForgone: (Number(c.salesValue) || 0) - (Number(c.cogs) || 0),
      reason: c.reason || "",
      reasonNote: c.reasonNote || "",
      cancelledBy: c.cancelledBy || "",
      cancelledDate: c.cancelledDate || "",
      disposition: c.disposition || "return",
      dispositionLabel: (CANCELLATION_DISPOSITIONS.find(x => x.key === (c.disposition || "return"))
        || CANCELLATION_DISPOSITIONS[0]).label
    };
  })
  .filter(r => !opts.scheduleId || r.cancellation.scheduleId === opts.scheduleId)
  .sort((a, b) => String(b.cancelledDate).localeCompare(String(a.cancelledDate)));
}

/* ===============================================================
   SALES ORDERS

   What the customer asked for, at what price, with whatever the rep
   gave away — and then a decision, line by line, about whether the
   plant will actually commit to it.

   Two things kept deliberately separate:

     listPrice     the agreed price from the customer's price list at
                   that quantity. A fact about the account.
     discountPct   what the rep conceded against it. A decision by a
                   person, which needs to stay visible rather than
                   being folded into a net figure nobody can question.

   The review is per line, not per order, because a customer routinely
   asks for four things and the plant can commit to three.
=============================================================== */

const SO_DECISIONS = ["Pending", "Accept", "Reject", "Adjust"];

/* The agreed price for a line, before any concession. */
function soListPrice(data, customerId, finishedGoodId, qty) {
  const p = shipmentUnitPrice(data, customerId, finishedGoodId, qty);
  return p === null ? null : p;
}

/* A line resolved: agreed price, concession, what it actually earns, and
   what the review decided. */
function salesOrderLineDetail(data, order, line) {
  const fg = getFinished(data, line.finishedGoodId);
  const qty = Number(line.qty) || 0;

  /* The stored list price is what was quoted at the time. If it is absent -
     a line entered before pricing existed, or a product with no agreed price
     - fall back to the current price list and say so. */
  const stored = Number(line.listPrice);
  const current = soListPrice(data, order.customerId, line.finishedGoodId, qty);
  const hasStored = Number.isFinite(stored) && stored > 0;
  const listPrice = hasStored ? stored : (current === null ? null : current);

  const discountPct = Math.max(0, Math.min(100, Number(line.discountPct) || 0));
  const netPrice = listPrice === null ? null : listPrice * (1 - discountPct / 100);

  const decision = line.reviewDecision || "Pending";
  const approvedQty = decision === "Adjust"
    ? (Number(line.approvedQty) || 0)
    : decision === "Accept" ? qty : 0;
  const approvedDate = decision === "Adjust"
    ? (line.approvedDate || line.requestedDate || order.requestedDate || "")
    : (line.requestedDate || order.requestedDate || "");

  const unitCost = computeItemUnitCost(data, "finished", line.finishedGoodId) || 0;

  return {
    line, order, fg,
    productName: fg ? fg.name : "(deleted product)",
    unit: fg ? fg.unit : "",
    qty,
    listPrice, listPriceIsCurrent: !hasStored,
    unpriced: listPrice === null,
    discountPct,
    // The reason is the whole point of recording the concession separately -
    // it was being dropped here, so the UI could never show it.
    discountReason: line.discountReason || "",
    discountValue: listPrice === null ? 0 : listPrice * (discountPct / 100) * qty,
    netPrice,
    lineValue: netPrice === null ? null : netPrice * qty,
    decision,
    approvedQty,
    approvedDate,
    adjusted: decision === "Adjust" && (approvedQty !== qty ||
      (line.approvedDate && line.approvedDate !== (line.requestedDate || order.requestedDate))),
    released: !!line.scheduleId,
    scheduleId: line.scheduleId || "",
    unitCost,
    // Margin at the conceded price, which is the number worth arguing about.
    marginPerUnit: netPrice === null ? null : netPrice - unitCost,
    marginPct: (netPrice && netPrice > 0) ? ((netPrice - unitCost) / netPrice) * 100 : null,
    // A concession that takes the line below cost should not be quiet about it.
    belowCost: netPrice !== null && netPrice < unitCost
  };
}

/* One record per order, with its lines resolved and the review state rolled up. */
function salesOrderRecords(data, options) {
  const opts = options || {};
  return (data.salesOrders || []).map(order => {
    const customer = getCustomer(data, order.customerId);
    const address = customer && order.addressId
      ? (customer.addresses || []).find(a => a.id === order.addressId) : null;
    const lines = (order.lines || []).map(l => salesOrderLineDetail(data, order, l));

    const pending = lines.filter(l => l.decision === "Pending").length;
    const accepted = lines.filter(l => l.decision === "Accept" || l.decision === "Adjust").length;
    const rejected = lines.filter(l => l.decision === "Reject").length;
    const released = lines.filter(l => l.released).length;

    return {
      order, customer, address, lines,
      reference: order.reference,
      customerName: customer ? customer.name : "(deleted customer)",
      addressLabel: address ? address.label : "",
      salesRep: order.salesRep || "",
      orderDate: order.orderDate,
      requestedDate: order.requestedDate,
      status: order.status || "Draft",
      lineCount: lines.length,
      pending, accepted, rejected, released,
      // Only lines the plant agreed to are worth anything.
      grossValue: lines.reduce((s, l) => s + ((l.listPrice || 0) * l.qty), 0),
      discountValue: lines.reduce((s, l) => s + l.discountValue, 0),
      netValue: lines.reduce((s, l) => s + (l.lineValue || 0), 0),
      committedValue: lines
        .filter(l => l.decision === "Accept" || l.decision === "Adjust")
        .reduce((s, l) => s + ((l.netPrice || 0) * l.approvedQty), 0),
      anyBelowCost: lines.some(l => l.belowCost),
      anyUnpriced: lines.some(l => l.unpriced),
      fullyReviewed: lines.length > 0 && pending === 0,
      fullyReleased: lines.length > 0 && released === accepted && accepted > 0
    };
  })
  .filter(r => !opts.customerId || r.order.customerId === opts.customerId)
  .filter(r => !opts.status || r.status === opts.status)
  .sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate)));
}

/* Average discount a rep has been giving, which is the reason to record the
   concession separately in the first place. */
function salesRepSummary(data) {
  const byRep = {};
  salesOrderRecords(data).forEach(r => {
    const rep = r.salesRep || "(unattributed)";
    if (!byRep[rep]) byRep[rep] = {
      rep, orders: 0, lines: 0, gross: 0, discount: 0, net: 0, belowCost: 0
    };
    const b = byRep[rep];
    b.orders++;
    b.lines += r.lineCount;
    b.gross += r.grossValue;
    b.discount += r.discountValue;
    b.net += r.netValue;
    b.belowCost += r.lines.filter(l => l.belowCost).length;
  });
  return Object.values(byRep)
    .map(b => ({ ...b, discountPct: b.gross > 0 ? (b.discount / b.gross) * 100 : 0 }))
    .sort((a, b) => b.discountPct - a.discountPct);
}

/* ===============================================================
   SHIPMENT RECONCILIATION AND TRACE

   Production and despatch were two separate histories. A run records
   which lots fulfilled it; a shipment records which lot went out.
   Nothing joined them, so "we completed 5,447 and shipped 2,732"
   was not a question the console could answer.

   These functions close that: what was fulfilled, what has left,
   what is still sitting in the warehouse, and where a shipment came
   from all the way back to the green coffee.
=============================================================== */

/* How much of a given lot has been shipped, across all despatches. */
function shippedFromLot(data, lotId) {
  if (!lotId) return 0;
  return (data.shipments || [])
    .filter(s => s.lotId === lotId)
    .reduce((sum, s) => sum + (Number(s.qty) || 0), 0);
}

/* Expected cost for a run: the standard cost as it stood when the run was
   fulfilled, not as it stands today. Falls back to today's standard only
   when the run predates the field, and says which it used. */
function expectedUnitCost(data, entry) {
  const frozen = Number(entry && entry.standardCostAtFulfillment);
  if (Number.isFinite(frozen) && frozen > 0) return { unitCost: frozen, frozen: true };
  return { unitCost: computeItemUnitCost(data, "finished", entry.productId), frozen: false };
}

/* One row per completed, fulfilled run: what it cost against what it was
   expected to cost, and how much of it has actually left the building. */
function fulfilmentReconciliation(data, options) {
  const opts = options || {};
  const cache = {};

  return (data.schedule || [])
    // Bulk intermediate campaigns are completed and fulfilled too, but they
    // are never despatched, so including them would report a permanent and
    // meaningless shortfall against shipments.
    .filter(s => s.productType === "finished")
    .filter(s => s.status === "Complete" && (s.fulfillmentLots || []).length > 0)
    .filter(s => !opts.from || (s.completedDate >= opts.from && s.completedDate <= (opts.to || "9999-12-31")))
    .map(entry => {
      const fg = getFinished(data, entry.productId);
      const customer = entry.customerId ? getCustomer(data, entry.customerId) : null;

      const lots = (entry.fulfillmentLots || []).map(fl => {
        const lot = fg ? (fg.lots || []).find(l => l.id === fl.lotId) : null;
        const cost = fl.lotId
          ? lotCost(data, "finished", entry.productId, fl.lotId, cache)
          : { unitCost: 0, estimated: true, basis: "missing" };
        const shipped = shippedFromLot(data, fl.lotId);
        return {
          lotId: fl.lotId,
          lotNumber: lot ? lot.lotNumber : "(lot missing)",
          lotDate: lot ? lot.date : "",
          batchId: lot ? lot.batchId : "",
          fulfilledQty: Number(fl.qty) || 0,
          producedQty: lot ? lotProducedQty(lot) : 0,
          remainingQty: lot ? Number(lot.qty) || 0 : 0,
          shippedQty: shipped,
          unitCost: cost.unitCost,
          costBasis: cost.basis,
          estimated: cost.estimated
        };
      });

      const fulfilledQty = lots.reduce((s, l) => s + l.fulfilledQty, 0);
      const shippedQty = lots.reduce((s, l) => s + l.shippedQty, 0);
      const actualCost = lots.reduce((s, l) => s + l.unitCost * l.fulfilledQty, 0);
      const actualUnit = fulfilledQty > 0 ? actualCost / fulfilledQty : 0;

      const expected = expectedUnitCost(data, entry);
      const expectedCost = expected.unitCost * fulfilledQty;

      const priceLine = customer
        ? (customer.priceList || []).find(p => p.finishedGoodId === entry.productId)
        : null;
      const unitPrice = priceLine ? getEffectivePrice(priceLine, fulfilledQty) : null;

      /* Shipping more than was fulfilled means a despatch drew on a lot from
         another run - not wrong, but worth seeing, because the two runs'
         costs are then mixed in one customer's margin. */
      const variance = actualCost - expectedCost;
      return {
        entry, fg, customer,
        productName: fg ? fg.name : "(deleted product)",
        unit: fg ? fg.unit : "",
        customerName: customer ? customer.name : "",
        completedDate: entry.completedDate || "",
        dueDate: entry.baselineDueDate || entry.dueDate || "",
        orderedQty: Number(entry.baselineQty) || Number(entry.qty) || 0,
        fulfilledQty, shippedQty,
        unshippedQty: Math.max(0, fulfilledQty - shippedQty),
        overShipped: shippedQty > fulfilledQty + 0.001,
        fullyShipped: shippedQty >= fulfilledQty - 0.001,
        partShipped: shippedQty > 0.001 && shippedQty < fulfilledQty - 0.001,
        notShipped: shippedQty <= 0.001,
        lots,
        actualUnitCost: actualUnit,
        actualCost,
        expectedUnitCost: expected.unitCost,
        expectedCost,
        expectedIsFrozen: expected.frozen,
        costVariance: variance,
        costVariancePct: expectedCost > 0 ? (variance / expectedCost) * 100 : null,
        unitPrice,
        revenue: unitPrice != null ? unitPrice * fulfilledQty : null,
        priced: unitPrice != null
      };
    })
    .sort((a, b) => String(b.completedDate).localeCompare(String(a.completedDate)));
}

/* Everything behind one despatch: the paperwork, the lot, the batch that
   made it, and the material that fed the batch. This is what the row on the
   revenue tab opens into. */
function shipmentTrace(data, shipmentId) {
  const sh = (data.shipments || []).find(s => s.id === shipmentId);
  if (!sh) return null;
  const cache = {};

  const fg = getFinished(data, sh.finishedGoodId);
  const customer = sh.customerId ? getCustomer(data, sh.customerId) : null;
  const address = customer && sh.addressId
    ? (customer.addresses || []).find(a => a.id === sh.addressId) : null;
  const lot = fg && sh.lotId ? (fg.lots || []).find(l => l.id === sh.lotId) : null;

  const qty = Number(sh.qty) || 0;
  const priceLine = customer
    ? (customer.priceList || []).find(p => p.finishedGoodId === sh.finishedGoodId)
    : null;
  const unitPrice = priceLine ? getEffectivePrice(priceLine, qty) : null;

  const cost = sh.lotId
    ? lotCost(data, "finished", sh.finishedGoodId, sh.lotId, cache)
    : { unitCost: computeItemUnitCost(data, "finished", sh.finishedGoodId),
        basis: "standardCost", estimated: true, sources: [] };

  // the run this despatch satisfies, by explicit link or by the lot it drew
  let run = sh.scheduleId ? (data.schedule || []).find(s => s.id === sh.scheduleId) : null;
  if (!run && sh.lotId) {
    run = (data.schedule || []).find(s =>
      (s.fulfillmentLots || []).some(fl => fl.lotId === sh.lotId));
  }
  const expected = run ? expectedUnitCost(data, run) : null;

  // the batch that produced the lot, and what fed it
  const batch = lot && lot.batchId
    ? batchRecords(data).find(b => b.batchId === lot.batchId) : null;

  return {
    shipment: sh, fg, customer, address, lot, run, batch,
    productName: fg ? fg.name : "(deleted product)",
    unit: fg ? fg.unit : "",
    customerName: customer ? customer.name : "",
    qty, unitPrice,
    revenue: unitPrice != null ? unitPrice * qty : null,
    priced: unitPrice != null,
    unitCost: cost.unitCost,
    cogs: cost.unitCost * qty,
    costBasis: cost.basis,
    costEstimated: cost.estimated,
    // where the cost came from, one level up
    costSources: cost.sources || [],
    expectedUnitCost: expected ? expected.unitCost : null,
    expectedIsFrozen: expected ? expected.frozen : false,
    costVariance: expected ? (cost.unitCost - expected.unitCost) * qty : null,
    margin: unitPrice != null ? (unitPrice - cost.unitCost) * qty : null,
    lotRemaining: lot ? Number(lot.qty) || 0 : 0,
    lotProduced: lot ? lotProducedQty(lot) : 0,
    lotShippedTotal: shippedFromLot(data, sh.lotId)
  };
}

/* ---------------------------------------------------------------
   Operating calendars

   A stage no longer occupies "ceil(hours / 24)" days. It occupies
   as many WORKING days as it takes to accumulate its hours at the
   rate the facility actually runs. An 8-hour day turns a 40-hour
   job into a working week, and a closed day extends the elapsed
   span without consuming any capacity - the machine simply isn't
   available, it isn't busy.

   Machines may follow their own calendar (a second shift on the
   press, say). Where a stage needs several machines it can only
   run when they are ALL open, so the hours available to it are the
   minimum across them, and zero if any one of them is shut.
----------------------------------------------------------------*/

const WEEKDAY_KEYS = ["hoursSun", "hoursMon", "hoursTue", "hoursWed", "hoursThu", "hoursFri", "hoursSat"];
const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/* Legacy data has no calendar. Rather than silently re-planning every existing
   order, absent configuration means round-the-clock, which is exactly what the
   scheduler assumed before calendars existed. */
const CONTINUOUS_CALENDAR = {
  id: "", name: "Continuous (24/7)", isDefault: true,
  hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24,
  hoursFri: 24, hoursSat: 24, hoursSun: 24, closures: [], overrides: []
};

function defaultCalendar(data) {
  const list = (data && data.operatingCalendars) || [];
  return list.find(c => c.isDefault) || list[0] || CONTINUOUS_CALENDAR;
}

/* A machine may follow its own pattern; absent an override it follows the
   facility default. */
function calendarFor(data, equipmentId) {
  if (!equipmentId) return defaultCalendar(data);
  const eq = getEquipment(data, equipmentId);
  if (eq && eq.calendarId) {
    const own = repo.find(data, "operatingCalendars", eq.calendarId);
    if (own) return own;
  }
  return defaultCalendar(data);
}

/* A temporary pattern covering this date, if any. Where two overlap
   the later one in the list wins, so the most recently added change
   takes effect - which is what someone adding one expects. */
function activeOverride(cal, dateStr) {
  const list = (cal && cal.overrides) || [];
  let hit = null;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!o.startDate) continue;
    const end = o.endDate && o.endDate >= o.startDate ? o.endDate : o.startDate;
    if (dateStr >= o.startDate && dateStr <= end) hit = o;
  }
  return hit;
}

/* What this calendar offers on a date, and why. Resolution order is
   deliberate: a closure beats a temporary pattern, which beats the
   weekly base. Running a surge does not reopen the plant on a public
   holiday - that has to be a decision, not a side effect. */
function resolveHours(cal, dateStr) {
  const dt = parseISODate(dateStr);
  if (!dt || !cal) return { hours: 0, source: "none", label: "" };

  const closure = ((cal.closures) || []).find(c => {
    if (!c.startDate) return false;
    const end = c.endDate && c.endDate >= c.startDate ? c.endDate : c.startDate;
    return dateStr >= c.startDate && dateStr <= end;
  });
  if (closure) return { hours: 0, source: "closure", label: closure.reason || "Closed" };

  const key = WEEKDAY_KEYS[dt.getUTCDay()];
  const ov = activeOverride(cal, dateStr);
  if (ov) {
    const h = Number(ov[key]);
    return {
      hours: Number.isFinite(h) && h > 0 ? h : 0,
      source: "override",
      label: ov.label || "Temporary hours"
    };
  }

  const h = Number(cal[key]);
  return { hours: Number.isFinite(h) && h > 0 ? h : 0, source: "base", label: cal.name || "" };
}

function calendarHoursOn(cal, dateStr) {
  return resolveHours(cal, dateStr).hours;
}

/* Hours a stage can actually use, given every machine it needs. */
function stageHoursOn(data, equipmentIds, dateStr) {
  if (!equipmentIds || !equipmentIds.length) {
    return calendarHoursOn(defaultCalendar(data), dateStr);
  }
  let min = Infinity;
  for (let i = 0; i < equipmentIds.length; i++) {
    const h = calendarHoursOn(calendarFor(data, equipmentIds[i]), dateStr);
    if (h <= 0) return 0;
    if (h < min) min = h;
  }
  return min === Infinity ? 0 : min;
}

/* Walk forward from `start` until the stage's hours are covered.
   Returns the working days it consumes - closed days are stepped
   over, not occupied. Null when nothing is open within the search. */
function stageWorkingDays(data, equipmentIds, start, hours, searchDays) {
  const need = Number(hours) > 0 ? Number(hours) : 0;
  const days = [];
  const dayHours = [];
  let remaining = need;
  let d = start;
  const limit = searchDays || 1460;

  for (let guard = 0; guard <= limit; guard++) {
    const available = stageHoursOn(data, equipmentIds, d);
    if (available > 0) {
      days.push(d);
      // The last day is usually partial: a 12-hour job on an 8-hour
      // calendar works 8 then 4, not 8 then 8.
      dayHours.push(need === 0 ? 0 : Math.min(available, remaining));
      remaining -= available;
      if (need === 0 || remaining <= 0) return { days, dayHours, end: d };
    }
    d = addDays(d, 1);
  }
  return null;
}

/* Is a calendar capable of any work at all? A configuration of all
   zeros would otherwise send the placement loop to its guard. */
function calendarIsWorkable(cal) {
  const baseOpen = WEEKDAY_KEYS.some(k => (Number(cal && cal[k]) || 0) > 0);
  if (baseOpen) return true;
  // A base of all zeros is still workable if a temporary pattern opens
  // some days - a plant that only runs during scheduled campaigns.
  return ((cal && cal.overrides) || []).some(o =>
    WEEKDAY_KEYS.some(k => (Number(o[k]) || 0) > 0));
}

function weeklyHours(cal) {
  return WEEKDAY_KEYS.reduce((s, k) => s + (Number(cal && cal[k]) || 0), 0);
}


/* ===============================================================
   FIFO FINITE-CAPACITY SCHEDULER

   The existing timeline works backwards: every order is assumed to
   finish exactly on its due date, and `detectConflicts` then reports
   where that would double-book a machine. It flags the clash but
   never resolves it, so two orders needing the same press on the
   same day both still claim it.

   This plans forwards instead. Orders are taken in arrival order -
   first in, first out - and each one is given the earliest slot on
   which every machine it needs actually has a free unit. Capacity is
   consumed as it goes, so an order placed second is pushed out by the
   first rather than silently overlapping it. The resulting finish
   date is therefore a real commitment, and comparing it against the
   due date is what surfaces a late order early.

   Deliberate modelling choices, stated because they are assumptions
   rather than facts about your plant:

   1. Time is day-granular, matching the rest of the app. A stage
      occupies whole days on every machine it needs.
   2. Stage duration scales with batch count - a run of ten batches
      takes ten times as long as one. The existing due-date view does
      NOT do this (it uses the raw process time regardless of
      quantity), so the two views will differ for multi-batch orders.
      This one is the more honest of the two.
   3. A stage consumes one unit of each machine it needs. Equipment
      with `units: 3` can therefore run three stages at once.
   4. Maintenance consumes one unit for its window, matching how
      `detectConflicts` already treats it.
   5. Raw material lead times are NOT a constraint here; they remain
      the separate procurement signal they already were.
=============================================================== */

/* Stages for one order, deepest dependency first. Sub-assemblies
   appear before the process that consumes them, so a simple forward
   pass over the list respects the dependency order. */
function buildStageGraph(data, itemType, itemId, qty, path, out, scaleByBatch) {
  path = path || new Set();
  out = out || [];
  scaleByBatch = scaleByBatch === true;
  if (itemType === "raw") return { stageIndex: null, stages: out };

  const key = itemType + ":" + itemId;
  if (path.has(key)) return { stageIndex: null, stages: out };

  const proc = findProcessForOutput(data, itemType, itemId);
  if (!proc) return { stageIndex: null, stages: out };

  const nextPath = new Set(path);
  nextPath.add(key);

  const outLine = (proc.outputs || []).find(o => o.itemType === itemType && o.itemId === itemId);
  const perBatch = outLine && Number(outLine.qtyPerBatch) > 0 ? Number(outLine.qtyPerBatch) : 0;
  const batches = perBatch > 0 ? Math.max(1, Math.ceil((Number(qty) || 0) / perBatch)) : 1;

  const deps = [];
  (proc.inputs || []).forEach(line => {
    const sub = buildStageGraph(data, line.itemType, line.itemId,
      (Number(line.qty) || 0) * batches, nextPath, out, scaleByBatch);
    if (sub.stageIndex !== null && deps.indexOf(sub.stageIndex) < 0) deps.push(sub.stageIndex);
  });

  // Whether a run of N batches takes N times as long is a real question
  // about the plant, not something the data settles - so it is a choice
  // the planner makes, not one buried in here.
  const hours = (Number(proc.productionTimeHours) || 0) * (scaleByBatch ? batches : 1);
  // How many days that is depends on the operating calendar, so it is
  // resolved at placement time rather than baked in here.
  const item = getCatalogItem(data, itemType, itemId);
  out.push({
    processId: proc.id,
    processName: proc.name,
    itemType, itemId,
    itemName: item ? item.name : "(deleted item)",
    qty: Number(qty) || 0,
    batches,
    hours,
    equipment: (proc.equipment || []).map(e => e.equipmentId).filter(Boolean),
    deps
  });
  return { stageIndex: out.length - 1, stages: out };
}

/* A day-by-day tally of how many units of each machine are spoken
   for. Maintenance is loaded first so it cannot be scheduled over. */
function buildCapacity(data, fromDate, horizonDays) {
  const units = {};
  (data.equipment || []).forEach(e => { units[e.id] = Math.max(1, Number(e.units) || 1); });

  const used = {};
  const take = (equipmentId, date) => {
    if (!used[equipmentId]) used[equipmentId] = {};
    used[equipmentId][date] = (used[equipmentId][date] || 0) + 1;
  };

  const horizonEnd = addDays(fromDate, horizonDays);
  (data.maintenance || []).forEach(m => {
    expandMaintenanceWindows(m, fromDate, horizonEnd).forEach(w => {
      let d = w.start, guard = 0;
      while (d <= w.end && guard < 400) { take(m.equipmentId, d); d = addDays(d, 1); guard++; }
    });
  });

  return { units, used, take };
}

function capacityFree(cap, equipmentIds, workingDays) {
  for (let i = 0; i < workingDays.length; i++) {
    const d = workingDays[i];
    for (let j = 0; j < equipmentIds.length; j++) {
      const e = equipmentIds[j];
      const limit = cap.units[e] === undefined ? 1 : cap.units[e];
      const inUse = (cap.used[e] && cap.used[e][d]) || 0;
      if (inUse >= limit) return false;
    }
  }
  return true;
}

function capacityReserve(cap, equipmentIds, workingDays) {
  workingDays.forEach(d => equipmentIds.forEach(e => cap.take(e, d)));
}

/* The earliest start where the stage both fits the operating calendar
   and finds a free unit on every machine, for every day it works. */
function earliestSlot(data, cap, equipmentIds, notBefore, hours, searchDays) {
  let d = notBefore;
  for (let guard = 0; guard <= searchDays; guard++) {
    const span = stageWorkingDays(data, equipmentIds, d, hours, searchDays);
    if (!span) return null;
    if (!equipmentIds.length || capacityFree(cap, equipmentIds, span.days)) {
      return { start: span.days[0], end: span.end, workingDays: span.days, dayHours: span.dayHours };
    }
    d = addDays(d, 1);
  }
  return null;
}

/* Arrival order. `createdDate` is stamped when a run is scheduled;
   rows that predate the field sort first, by their existing position,
   which preserves the order they were originally entered in. */
function fifoOrder(data) {
  return (data.schedule || [])
    .map((entry, index) => ({ entry, index }))
    .filter(x => x.entry.status === "Planned" || x.entry.status === "In progress")
    .sort((a, b) => {
      const ca = a.entry.createdDate || "";
      const cb = b.entry.createdDate || "";
      if (ca !== cb) return ca < cb ? -1 : 1;
      return a.index - b.index;
    })
    .map(x => x.entry);
}

/* Plan every open order. Returns one row per order plus a per-machine
   day-by-day load, which is what the calendar and lane views draw. */
function planScheduleFIFO(data, options) {
  const opts = options || {};
  const startDate = opts.from || todayStr();
  const horizonDays = opts.horizonDays || 730;
  // Default matches how the rest of the app already reads
  // productionTimeHours: time for the run, not per batch. The planner can
  // switch this on to see what the plant looks like if it does scale.
  const scaleByBatch = opts.scaleByBatch === true;

  const cap = buildCapacity(data, startDate, horizonDays);
  const orders = fifoOrder(data);
  const rows = [];

  // If nothing is ever open, say so once rather than reporting every
  // order as mysteriously unplaceable.
  const facility = defaultCalendar(data);
  const anyOpen = calendarIsWorkable(facility) ||
    (data.operatingCalendars || []).some(calendarIsWorkable);
  if (!anyOpen) {
    return {
      from: startDate, rows: orders.map(entry => ({
        entry, stages: [], start: null, end: null, dueDate: entry.dueDate,
        lateDays: 0, late: false, unplaceable: true,
        reason: "The operating calendar has no open hours on any day"
      })),
      load: {}, units: cap.units, scaleByBatch,
      calendar: facility, noOpenHours: true,
      lateCount: 0, unplaceableCount: orders.length, worstLateDays: 0
    };
  }

  orders.forEach((entry, position) => {
    const stages = [];
    buildStageGraph(data, entry.productType, entry.productId, Number(entry.qty) || 0, null, stages, scaleByBatch);

    if (!stages.length) {
      rows.push({
        entry, position, stages: [], start: null, end: null,
        dueDate: entry.dueDate, lateDays: 0, late: false,
        unplaceable: true,
        reason: "No process produces " + productName(data, entry)
      });
      return;
    }

    const endByIndex = {};
    const placed = [];
    let blocked = null;

    stages.forEach((stage, i) => {
      let notBefore = startDate;
      stage.deps.forEach(di => {
        const depEnd = endByIndex[di];
        if (depEnd) {
          const after = addDays(depEnd, 1);
          if (after > notBefore) notBefore = after;
        }
      });

      const slot = earliestSlot(data, cap, stage.equipment, notBefore, stage.hours, horizonDays);
      if (slot === null) {
        blocked = stage;
        return;
      }
      capacityReserve(cap, stage.equipment, slot.workingDays);
      endByIndex[i] = slot.end;
      placed.push({
        ...stage, start: slot.start, end: slot.end,
        workingDays: slot.workingDays, dayHours: slot.dayHours,
        days: slot.workingDays.length
      });
    });

    if (blocked) {
      rows.push({
        entry, position, stages: placed, start: null, end: null,
        dueDate: entry.dueDate, lateDays: 0, late: false,
        unplaceable: true,
        reason: "No free capacity within " + horizonDays + " days for " + blocked.processName
      });
      return;
    }

    const start = placed.reduce((m, s) => (!m || s.start < m ? s.start : m), null);
    const end = placed.reduce((m, s) => (!m || s.end > m ? s.end : m), null);
    const lateDays = (end && entry.dueDate) ? daysBetweenISO(entry.dueDate, end) : 0;

    rows.push({
      entry, position, stages: placed, start, end,
      dueDate: entry.dueDate,
      lateDays: lateDays > 0 ? lateDays : 0,
      late: lateDays > 0,
      unplaceable: false, reason: null
    });
  });

  /* Per-machine load, for the equipment lanes. */
  const load = {};
  rows.forEach(row => row.stages.forEach(stage => {
    stage.equipment.forEach(eqId => {
      if (!load[eqId]) load[eqId] = [];
      load[eqId].push({
        start: stage.start, end: stage.end,
        workingDays: stage.workingDays, dayHours: stage.dayHours,
        label: productName(data, row.entry) + " — " + stage.processName,
        entryId: row.entry.id, kind: "production", late: row.late
      });
    });
  }));

  const horizonEnd = addDays(startDate, horizonDays);
  (data.maintenance || []).forEach(m => {
    expandMaintenanceWindows(m, startDate, horizonEnd).forEach(w => {
      if (!load[m.equipmentId]) load[m.equipmentId] = [];
      load[m.equipmentId].push({
        start: w.start, end: w.end,
        label: m.title || m.type || "Maintenance",
        entryId: null, kind: "maintenance", late: false
      });
    });
  });

  return {
    from: startDate,
    rows,
    load,
    units: cap.units,
    scaleByBatch,
    calendar: facility,
    noOpenHours: false,
    lateCount: rows.filter(r => r.late).length,
    unplaceableCount: rows.filter(r => r.unplaceable).length,
    worstLateDays: rows.reduce((m, r) => (r.lateDays > m ? r.lateDays : m), 0)
  };
}

/* Whole days from `a` to `b`, negative when b precedes a. */
function daysBetweenISO(a, b) {
  const da = parseISODate(a), db = parseISODate(b);
  if (!da || !db) return 0;
  return Math.round((db - da) / 86400000);
}


/* ---------------------------------------------------------------
   Equipment utilisation

   Three quantities, and keeping them distinct is the whole point:

     ACTUAL     hours a machine really ran, from the equipment lines
                recorded against each batch. History only.
     COMMITTED  hours the capacity plan has already promised to that
                machine. Forecast only - it is what the FIFO planner
                reserved, not a guess.
     AVAILABLE  hours the machine could run, from its operating
                calendar multiplied by its unit count. This is the
                denominator, and it is the number that answers "do we
                extend hours or buy another machine".

   Actual and committed never overlap: a day is either in the past
   (recorded) or ahead of the plan start (committed).
----------------------------------------------------------------*/

/* Hours a machine could run on one date: its calendar, times units. */
function equipmentHoursOn(data, eqItem, dateStr) {
  const cal = calendarFor(data, eqItem.id);
  const units = Math.max(1, Number(eqItem.units) || 1);
  return calendarHoursOn(cal, dateStr) * units;
}

/* Capacity events, one per machine per open day. Emitted as a series so
   they bucket through exactly the same path as everything else. */
function equipmentAvailableEvents(data, from, to, equipmentId) {
  const out = [];
  const list = (data.equipment || []).filter(e => !equipmentId || e.id === equipmentId);
  if (!list.length) return out;
  let d = from;
  let guard = 0;
  while (d <= to && guard < 4000) {
    list.forEach(eqItem => {
      const h = equipmentHoursOn(data, eqItem, d);
      if (h > 0) out.push({ date: d, series: "available", value: h, equipmentId: eqItem.id });
    });
    d = addDays(d, 1);
    guard++;
  }
  return out;
}

/* Hours actually worked, from the equipment lines on each lot. */
function equipmentActualEvents(data, equipmentId) {
  const out = [];
  ["rawMaterials", "intermediateProducts", "finishedGoods", "wasteStreams"].forEach(entity => {
    (data[entity] || []).forEach(item => (item.lots || []).forEach(lot => {
      if (!lot.date) return;
      (lot.actualEquipment || []).forEach(a => {
        if (!a.equipmentId) return;
        if (equipmentId && a.equipmentId !== equipmentId) return;
        const h = Number(a.hours) || 0;
        if (h > 0) out.push({ date: lot.date, series: "actual", value: h, equipmentId: a.equipmentId });
      });
    }));
  });
  return out;
}

/* Hours the capacity plan has reserved, day by day. */
function equipmentCommittedEvents(plan, equipmentId) {
  const out = [];
  (plan.rows || []).forEach(row => (row.stages || []).forEach(stage => {
    (stage.equipment || []).forEach(eqId => {
      if (equipmentId && eqId !== equipmentId) return;
      (stage.workingDays || []).forEach((d, i) => {
        const h = (stage.dayHours && stage.dayHours[i]) || 0;
        if (h > 0) out.push({ date: d, series: "committed", value: h, equipmentId: eqId });
      });
    });
  }));
  return out;
}

/* Maintenance consumes the machine too, so it belongs in the same picture
   rather than quietly inflating apparent spare capacity. */
function equipmentMaintenanceEvents(data, from, to, equipmentId) {
  const out = [];
  (data.maintenance || []).forEach(m => {
    if (equipmentId && m.equipmentId !== equipmentId) return;
    const eqItem = getEquipment(data, m.equipmentId);
    if (!eqItem) return;
    expandMaintenanceWindows(m, from, to).forEach(w => {
      datesInRange(w.start, w.end).forEach(d => {
        const h = equipmentHoursOn(data, eqItem, d);
        // One unit's worth of the day, not the whole machine.
        const perUnit = h / Math.max(1, Number(eqItem.units) || 1);
        if (perUnit > 0) out.push({ date: d, series: "maintenance", value: perUnit, equipmentId: m.equipmentId });
      });
    });
  });
  return out;
}

/* Everything a utilisation chart needs, bucketed and with capacity
   attached as the reference line. */
function utilizationSeries(data, plan, range, equipmentId, maxUtilization) {
  // The practical ceiling is below the theoretical one: changeovers, setup
  // and variability mean planning to 100% is planning to be late. The line
  // sits at whatever fraction the planner considers deliverable.
  const limitPct = Number(maxUtilization) > 0 ? Number(maxUtilization) : 100;
  const events = []
    .concat(equipmentActualEvents(data, equipmentId))
    .concat(equipmentCommittedEvents(plan, equipmentId))
    .concat(equipmentMaintenanceEvents(data, range.from, range.to, equipmentId));

  const rows = bucketEvents(events, range, ["actual", "committed", "maintenance"]);

  const cap = bucketEvents(
    equipmentAvailableEvents(data, range.from, range.to, equipmentId),
    range, ["available"]);
  const capByKey = {};
  cap.forEach(r => { capByKey[r.key] = r.available; });

  return rows.map(r => {
    const available = capByKey[r.key] || 0;
    const used = r.actual + r.committed + r.maintenance;
    const limit = available > 0 ? Math.round(available * (limitPct / 100)) : 0;
    return {
      ...r,
      available, limit,
      // "target" is the hard capacity ceiling; "limit" is the planning one.
      target: available > 0 ? available : "",
      utilization: available > 0 ? Math.round((used / available) * 100) : null,
      overCapacity: available > 0 && used > available,
      overLimit: limit > 0 && used > limit
    };
  });
}

/* Per-machine roll-up over the same range, for the table underneath.
   Sorted worst-first so the machine to act on is at the top. */
function utilizationByEquipment(data, plan, range, maxUtilization) {
  return (data.equipment || []).map(eqItem => {
    const rows = utilizationSeries(data, plan, range, eqItem.id, maxUtilization);
    const used = rows.reduce((s, r) => s + r.actual + r.committed + r.maintenance, 0);
    const available = rows.reduce((s, r) => s + r.available, 0);
    return {
      eq: eqItem,
      used, available,
      actual: rows.reduce((s, r) => s + r.actual, 0),
      committed: rows.reduce((s, r) => s + r.committed, 0),
      maintenance: rows.reduce((s, r) => s + r.maintenance, 0),
      utilization: available > 0 ? Math.round((used / available) * 100) : null,
      overPeriods: rows.filter(r => r.overCapacity).length,
      overLimitPeriods: rows.filter(r => r.overLimit).length,
      calendar: calendarFor(data, eqItem.id)
    };
  }).sort((a, b) => (b.utilization === null ? -1 : b.utilization) - (a.utilization === null ? -1 : a.utilization));
}

/* ---------------------------------------------------------------
   Calendar grid helpers
----------------------------------------------------------------*/

/* Six weeks of dates covering the given month, Monday-first, so the
   grid never changes height as the user pages through months. */
function calendarGrid(monthKey) {
  const [y, m] = String(monthKey).split("-").map(Number);
  const first = new Date(Date.UTC(y, (m || 1) - 1, 1));
  const startIdx = (first.getUTCDay() + 6) % 7;
  const gridStart = new Date(first.getTime() - startIdx * 86400000);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart.getTime() + i * 86400000);
    cells.push({
      date: fmtISODate(d),
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === (m || 1) - 1
    });
  }
  return cells;
}

function shiftMonth(monthKey, delta) {
  const [y, m] = String(monthKey).split("-").map(Number);
  const d = new Date(Date.UTC(y, (m || 1) - 1 + delta, 1));
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

function monthLabel(monthKey) {
  const [y, m] = String(monthKey).split("-").map(Number);
  return MONTH_NAMES[(m || 1) - 1] + " " + y;
}

/* Every date a window covers, capped so a malformed range cannot
   spin. Used to paint multi-day stages across calendar cells. */
function datesInRange(start, end, cap) {
  const out = [];
  if (!start || !end || end < start) return out;
  let d = start;
  const limit = cap || 400;
  while (d <= end && out.length < limit) { out.push(d); d = addDays(d, 1); }
  return out;
}


/* ---------------------------------------------------------------
   Small shared UI atoms
----------------------------------------------------------------*/
function Badge({ tone, children }) {
  tone = tone || "neutral";
  const tones = {
    neutral: { bg: "#E7E9E4", fg: "#3C4038" },
    good: { bg: "#DCEBE1", fg: "#1F5B3E" },
    warn: { bg: "#F6E6C8", fg: "#7A5205" },
    bad: { bg: "#F3DBD6", fg: "#8A2E20" },
    info: { bg: "#DCE6EA", fg: "#1F5566" }
  };
  const t = tones[tone] || tones.neutral;
  return (
    <span style={{
      background: t.bg, color: t.fg, fontSize: 11.5, fontWeight: 600,
      padding: "2px 8px", borderRadius: 999, letterSpacing: 0.2, whiteSpace: "nowrap",
      fontFamily: "'IBM Plex Mono', monospace", textTransform: "uppercase"
    }}>{children}</span>
  );
}

function varianceBadge(actualHours, plannedHours) {
  if (!plannedHours) return null;
  const diffPct = Math.round(((actualHours - plannedHours) / plannedHours) * 100);
  if (Math.abs(diffPct) <= 10) return <Badge tone="good">{(diffPct >= 0 ? "+" : "") + diffPct + "% vs plan"}</Badge>;
  if (diffPct > 10) return <Badge tone="bad">+{diffPct}% vs plan</Badge>;
  return <Badge tone="warn">{diffPct}% vs plan</Badge>;
}

function CompositionBadges({ composition, data }) {
  if (!composition || composition.length === 0) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 5 }}>
      {composition.map((c, i) => {
        const comp = getComponent(data, c.componentId);
        if (!comp) return null;
        return (
          <span key={i} className="mono" style={{ fontSize: 10.5, background: "#F3EEDD", color: "#6B4E1F", padding: "2px 7px", borderRadius: 999 }}>
            {comp.name}: {fmtNum(c.percentage)}%
          </span>
        );
      })}
    </div>
  );
}

function IconBtn({ onClick, title, children, danger, disabled }) {
  return (
    <button onClick={onClick} title={title} disabled={disabled} style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 28, height: 28, borderRadius: 6, border: "1px solid #D7DAD3",
      background: "#fff", color: danger ? "#A32D2D" : "#3C4038", cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.35 : 1
    }}>{children}</button>
  );
}

function Btn({ onClick, children, variant, style, type }) {
  variant = variant || "primary";
  type = type || "button";
  const base = {
    display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 600,
    padding: "8px 14px", borderRadius: 7, cursor: "pointer", border: "1px solid transparent",
    fontFamily: "'IBM Plex Sans', sans-serif"
  };
  const variants = {
    primary: { background: "#1F6F78", color: "#fff" },
    secondary: { background: "#fff", color: "#20262B", border: "1px solid #D7DAD3" },
    ghost: { background: "transparent", color: "#5B6470" },
    danger: { background: "#fff", color: "#A32D2D", border: "1px solid #E3B9B2" }
  };
  return <button type={type} onClick={onClick} style={{ ...base, ...variants[variant], ...style }}>{children}</button>;
}

function Field({ label, children, hint, span }) {
  return (
    <div style={{ gridColumn: span ? "span " + span : undefined }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#5B6470", marginBottom: 4 }}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: "#8A9099", marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

const inputStyle = {
  width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #D7DAD3",
  fontSize: 13.5, fontFamily: "'IBM Plex Sans', sans-serif", color: "#20262B", background: "#fff", boxSizing: "border-box"
};


/* ---------------------------------------------------------------
   Historical chart UI

   Charts are hand-drawn SVG rather than a charting dependency. The
   file currently has none beyond React and lucide, and it is headed
   for extraction into a real repository, so adding one is a decision
   worth making deliberately rather than in passing. What is here is
   modest - stacked bars, an optional line overlay, gridlines and a
   hover readout - and can be swapped for a library later without
   touching the series builders, which is where the real logic lives.
----------------------------------------------------------------*/

const SERIES_COLORS = ["#1F6F78", "#5FA8A0", "#2E7D5B", "#C08A3E", "#8C6BA8", "#A32D2D"];

function useTimeRange(data, initialPreset) {
  const [preset, setPreset] = useState(initialPreset || "13w");
  const [granularity, setGranularity] = useState(null);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const range = useMemo(() => {
    if (preset === "custom") {
      const span = dataDateSpan(data);
      const from = customFrom || span.from;
      const to = customTo || todayStr();
      return { from, to, granularity: granularity || "month" };
    }
    const r = resolvePreset(preset, data);
    return { from: r.from, to: r.to, granularity: granularity || r.granularity };
  }, [preset, granularity, customFrom, customTo, data]);

  return { preset, setPreset, granularity, setGranularity,
           customFrom, setCustomFrom, customTo, setCustomTo, range };
}

function TimeRangeControls({ state }) {
  const seg = (active) => ({
    padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer",
    background: active ? "#1F6F78" : "#fff",
    color: active ? "#fff" : "#5B6470",
    border: "1px solid " + (active ? "#1F6F78" : "#D7DAD3"),
    borderRadius: 6
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <div style={{ display: "flex", gap: 4 }}>
        {GRANULARITIES.map(g => (
          <div key={g.key}
            role="button" tabIndex={0}
            onClick={() => state.setGranularity(g.key)}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); state.setGranularity(g.key); } }}
            style={seg(state.range.granularity === g.key)}>
            {g.label}
          </div>
        ))}
      </div>

      <select
        value={state.preset}
        onChange={e => state.setPreset(e.target.value)}
        style={{ ...inputStyle, width: 168 }}
      >
        {RANGE_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
      </select>

      {state.preset === "custom" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="date" value={state.customFrom || state.range.from}
            onChange={e => state.setCustomFrom(e.target.value)}
            style={{ ...inputStyle, width: 148 }} />
          <span style={{ color: "#7A8079", fontSize: 12 }}>to</span>
          <input type="date" value={state.customTo || state.range.to}
            onChange={e => state.setCustomTo(e.target.value)}
            style={{ ...inputStyle, width: 148 }} />
        </div>
      )}
    </div>
  );
}

function niceCeiling(v) {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * mag;
}

function TimeChart({ rows, series, height, formatValue, showLine, emptyMessage,
                    targetKey, targetIsCeiling, limitKey, limitLabel, limitColor,
                    barLabelKey, barLabelSuffix, onBucketClick, focusKey }) {
  const [hover, setHover] = useState(null);
  const H = height || 210;
  const padL = 56, padR = 12, padT = 10, padB = 34;
  const W = 860;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const fmt = formatValue || ((v) => String(Math.round(v * 100) / 100));
  const maxTotal = Math.max(0, ...rows.map(r => series.reduce((s, sd) => s + (r[sd.key] || 0), 0)));
  // A target above every bar still has to be visible, so it takes part in
  // the scale rather than being clipped at the top of the plot.
  const maxTarget = targetKey
    ? Math.max(0, ...rows.map(r => Number(r[targetKey]) || 0))
    : 0;
  const maxLimit = limitKey
    ? Math.max(0, ...rows.map(r => Number(r[limitKey]) || 0))
    : 0;
  // Bar labels sit above the bars, so leave headroom or they clip.
  const headroom = barLabelKey ? 1.12 : 1;
  const yMax = niceCeiling(Math.max(maxTotal, maxTarget, maxLimit) * headroom);
  const hasData = maxTotal > 0;

  const bandW = rows.length ? plotW / rows.length : plotW;
  const barW = Math.max(2, Math.min(46, bandW * 0.62));
  const yOf = (v) => padT + plotH - (v / yMax) * plotH;

  // thin x labels so they never collide
  const maxLabels = Math.floor(plotW / 58);
  const labelStep = Math.max(1, Math.ceil(rows.length / Math.max(1, maxLabels)));

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => yMax * f);

  const linePoints = showLine && rows.length
    ? rows.map((r, i) => {
        const total = series.reduce((s, sd) => s + (r[sd.key] || 0), 0);
        return (padL + i * bandW + bandW / 2) + "," + yOf(total);
      }).join(" ")
    : null;

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={"0 0 " + W + " " + H} style={{ width: "100%", height: H, display: "block" }}
           onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={yOf(t)} y2={yOf(t)}
                  stroke={i === 0 ? "#C9CEC6" : "#EDEFEA"} strokeWidth="1" />
            <text x={padL - 8} y={yOf(t) + 4} textAnchor="end"
                  fontSize="10.5" fill="#7A8079" fontFamily="'IBM Plex Sans', sans-serif">
              {fmt(t)}
            </text>
          </g>
        ))}

        {hasData && rows.map((r, i) => {
          const x = padL + i * bandW + (bandW - barW) / 2;
          let acc = 0;
          return (
            <g key={r.key}
               onMouseEnter={() => setHover(i)}
               onClick={onBucketClick ? () => onBucketClick(r) : undefined}
               style={{ cursor: onBucketClick ? "pointer" : "default" }}>
              {/* The whole band is the target, not just the bar - a period
                  with nothing in it still needs to be selectable to see that
                  it is genuinely empty. */}
              <rect x={padL + i * bandW} y={padT} width={bandW} height={plotH}
                    fill={focusKey === r.key ? "#1F6F781F"
                          : hover === i ? "#1F6F780D" : "transparent"}
                    stroke={focusKey === r.key ? "#1F6F78" : "none"}
                    strokeWidth="1" />
              {series.map((sd, si) => {
                const v = r[sd.key] || 0;
                if (v <= 0) return null;
                const h = (v / yMax) * plotH;
                acc += h;
                return (
                  <rect key={sd.key} x={x} y={padT + plotH - acc} width={barW} height={h}
                        fill={sd.color || SERIES_COLORS[si % SERIES_COLORS.length]}
                        rx="1.5" />
                );
              })}
            </g>
          );
        })}

        {linePoints && hasData && (
          <polyline points={linePoints} fill="none" stroke="#20262B" strokeWidth="1.6"
                    strokeLinejoin="round" opacity="0.55" />
        )}

        {targetKey && hasData && rows.map((r, i) => {
          const t = Number(r[targetKey]);
          if (!(t > 0)) return null;
          const x = padL + i * bandW + (bandW - barW) / 2;
          const total = series.reduce((s, sd) => s + (r[sd.key] || 0), 0);
          const good = targetIsCeiling ? total <= t : total >= t;
          /* Stays a per-period marker rather than a continuous line: its
             colour carries whether THAT period met its target, which a
             single connected line could not show. Cased in white so it
             reads where it crosses a bar. */
          return (
            <g key={"t" + r.key}>
              <line x1={x - 5} x2={x + barW + 5} y1={yOf(t)} y2={yOf(t)}
                    stroke="#fff" strokeWidth="5.5" strokeLinecap="round" opacity="0.75" />
              <line x1={x - 5} x2={x + barW + 5} y1={yOf(t)} y2={yOf(t)}
                    stroke={good ? "#2E7D5B" : "#A32D2D"} strokeWidth="2.6"
                    strokeDasharray="5 2.5" strokeLinecap="round" />
            </g>
          );
        })}

        {/* The reference series is drawn as a connected step across the whole
            band rather than a stub over each bar: a level that carries from
            one period to the next is far easier to read, and short segments
            floating above tall bars were getting lost. Laid down twice - a
            pale casing first, the line over it - so it stays legible where
            it crosses a bar. */}
        {limitKey && hasData && (() => {
          const segments = [];
          let cur = [];
          rows.forEach((r, i) => {
            const v = Number(r[limitKey]);
            const x0 = padL + i * bandW;
            const x1 = x0 + bandW;
            if (v > 0) {
              const y = yOf(v);
              if (!cur.length) cur.push("M" + x0 + "," + y);
              else cur.push("L" + x0 + "," + y);
              cur.push("L" + x1 + "," + y);
            } else if (cur.length) {
              segments.push(cur.join(" "));
              cur = [];
            }
          });
          if (cur.length) segments.push(cur.join(" "));
          if (!segments.length) return null;
          const colour = limitColor || "#8C6B45";
          return (
            <g>
              {segments.map((dPath, k) => (
                <path key={"limc" + k} d={dPath} fill="none" stroke="#fff"
                      strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" opacity="0.75" />
              ))}
              {segments.map((dPath, k) => (
                <path key={"lim" + k} d={dPath} fill="none" stroke={colour}
                      strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round"
                      strokeDasharray="7 4" />
              ))}
              {rows.map((r, i) => {
                const v = Number(r[limitKey]);
                if (!(v > 0)) return null;
                return (
                  <circle key={"limd" + r.key}
                    cx={padL + i * bandW + bandW / 2} cy={yOf(v)} r="2.6"
                    fill={colour} stroke="#fff" strokeWidth="1.2" />
                );
              })}
            </g>
          );
        })()}

        {barLabelKey && hasData && rows.map((r, i) => {
          const v = r[barLabelKey];
          if (v === null || v === undefined || v === "") return null;
          const total = series.reduce((s, sd) => s + (r[sd.key] || 0), 0);
          if (!(total > 0)) return null;
          const t = Number(r[targetKey]);
          const lim = Number(r[limitKey]);
          const tone = (t > 0 && total > t) ? "#A32D2D"
            : (lim > 0 && total > lim) ? "#8C6B45" : "#5B6470";
          return (
            <text key={"bl" + r.key}
              x={padL + i * bandW + bandW / 2}
              y={Math.max(padT + 9, yOf(total) - 5)}
              textAnchor="middle" fontSize="10.5" fontWeight="700" fill={tone}
              fontFamily="'IBM Plex Sans', sans-serif">
              {v}{barLabelSuffix || ""}
            </text>
          );
        })}

        {rows.map((r, i) => (i % labelStep === 0 ? (
          <text key={r.key} x={padL + i * bandW + bandW / 2} y={H - 12}
                textAnchor="middle" fontSize="10.5" fill="#7A8079"
                fontFamily="'IBM Plex Sans', sans-serif">
            {r.label}
          </text>
        ) : null))}

        {!hasData && (
          <text x={W / 2} y={padT + plotH / 2} textAnchor="middle" fontSize="13" fill="#9AA09A"
                fontFamily="'IBM Plex Sans', sans-serif">
            {emptyMessage || "No activity in this period"}
          </text>
        )}
      </svg>

      {hover !== null && rows[hover] && hasData && (
        <div style={{
          position: "absolute", top: 4, right: 4, background: "#20262B", color: "#fff",
          padding: "8px 11px", borderRadius: 7, fontSize: 11.5, pointerEvents: "none",
          minWidth: 150
        }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{rows[hover].label}</div>
          {series.map((sd, si) => (
            <div key={sd.key} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <span style={{ color: "#C4C9C2" }}>
                <span style={{
                  display: "inline-block", width: 8, height: 8, borderRadius: 2, marginRight: 6,
                  background: sd.color || SERIES_COLORS[si % SERIES_COLORS.length]
                }} />
                {sd.label}
              </span>
              <span>{fmt(rows[hover][sd.key] || 0)}</span>
            </div>
          ))}
          {series.length > 1 && (
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12,
                          marginTop: 4, paddingTop: 4, borderTop: "1px solid #3A4147", fontWeight: 700 }}>
              <span>Total</span>
              <span>{fmt(series.reduce((s, sd) => s + (rows[hover][sd.key] || 0), 0))}</span>
            </div>
          )}
          {limitKey && Number(rows[hover][limitKey]) > 0 && (() => {
            const lim = Number(rows[hover][limitKey]);
            const actual = series.reduce((s, sd) => s + (rows[hover][sd.key] || 0), 0);
            return (
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 4,
                            color: actual > lim ? "#E8C49A" : "#C4C9C2" }}>
                <span>{limitLabel || "Planning limit"}</span>
                <span>{fmt(lim)}</span>
              </div>
            );
          })()}
          {targetKey && Number(rows[hover][targetKey]) > 0 && (() => {
            const t = Number(rows[hover][targetKey]);
            const actual = series.reduce((s, sd) => s + (rows[hover][sd.key] || 0), 0);
            const pct = Math.round((actual / t) * 100);
            return (
              <div style={{ marginTop: 4, paddingTop: 4, borderTop: "1px solid #3A4147" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <span style={{ color: "#C4C9C2" }}>{targetIsCeiling ? "Available" : "Target"}</span>
                  <span>{fmt(t)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12,
                              color: (targetIsCeiling ? actual <= t : actual >= t) ? "#8FE0C6" : "#E8A9A1",
                              fontWeight: 700 }}>
                  <span>{targetIsCeiling
                    ? (actual > t ? "Over capacity" : "Within capacity")
                    : (actual >= t ? "Met" : "Short")}</span>
                  <span>{pct}%</span>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}

function ChartLegend({ series, references }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
      {series.map((sd, i) => (
        <div key={sd.key} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#5B6470" }}>
          <span style={{
            display: "inline-block", width: 10, height: 10, borderRadius: 2,
            background: sd.color || SERIES_COLORS[i % SERIES_COLORS.length]
          }} />
          {sd.label}
        </div>
      ))}
      {/* Reference lines are not bars and must not look like one in the key,
          or they read as another quantity to be added in. */}
      {(references || []).map(ref => (
        <div key={ref.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#5B6470" }}>
          <svg width="20" height="10" style={{ display: "block" }}>
            <line x1="0" y1="5" x2="20" y2="5" stroke={ref.color} strokeWidth="2.4"
                  strokeDasharray={ref.dash || "7 4"} strokeLinecap="round" />
          </svg>
          {ref.label}
        </div>
      ))}
    </div>
  );
}

function ChartCard({ title, subtitle, series, rows, height, formatValue, showLine, emptyMessage,
                    action, targetKey, targetIsCeiling, limitKey, limitLabel, limitColor,
                    barLabelKey, barLabelSuffix, footer, onBucketClick, focusKey }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12, color: "#7A8079", marginTop: 2 }}>{subtitle}</div>}
        </div>
        {action}
      </div>
      <TimeChart rows={rows} series={series} height={height} formatValue={formatValue}
                 showLine={showLine} emptyMessage={emptyMessage}
                 targetKey={targetKey} targetIsCeiling={targetIsCeiling}
                 limitKey={limitKey} limitLabel={limitLabel} limitColor={limitColor}
                 barLabelKey={barLabelKey} barLabelSuffix={barLabelSuffix}
                 onBucketClick={onBucketClick} focusKey={focusKey} />
      <ChartLegend series={series} references={[
        ...(targetKey ? [{ label: targetIsCeiling ? "Available capacity" : "Target",
                           color: "#2E7D5B", dash: "5 2.5" }] : []),
        ...(limitKey ? [{ label: limitLabel || "Limit",
                          color: limitColor || "#8C6B45", dash: "7 4" }] : [])
      ]} />
      {footer}
    </div>
  );
}


function Modal({ title, onClose, children, wide }) {
  return (
    <div style={{
      position: "absolute", inset: 0, background: "rgba(20,24,20,0.45)",
      display: "flex", alignItems: "flex-start", justifyContent: "center",
      padding: "5vh 16px", zIndex: 50, overflowY: "auto"
    }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{
        background: "#fff", borderRadius: 10, width: wide ? 820 : 520, maxWidth: "100%",
        boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden"
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid #E7E9E4" }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{title}</div>
          <IconBtn onClick={onClose} title="Close"><X size={16} /></IconBtn>
        </div>
        <div style={{ padding: 18, maxHeight: "78vh", overflowY: "auto" }}>{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Composition editor - flat component breakdown by physical
   percentage AND an independent cost-weight percentage, available
   on any catalog item. Physical percentage drives balances; cost
   weight (defaulting to match percentage until set) drives the
   cost fallback and value allocation - a cheap diluent can be a
   large physical share while carrying little or none of the cost.
----------------------------------------------------------------*/
function CompositionEditor({ composition, onChange, componentOptions, data, showCostWeight = true }) {
  const addLine = () => {
    if (componentOptions.length === 0) return;
    onChange(recomputeCompositionBalance([...composition, { id: uid(), componentId: componentOptions[0].id, percentage: 0, costWeight: null }]));
  };
  const updateLine = (idx, patch) => onChange(recomputeCompositionBalance(composition.map((c, i) => i === idx ? { ...c, ...patch } : c)));
  const removeLine = (idx) => onChange(recomputeCompositionBalance(composition.filter((_, i) => i !== idx)));
  const toggleBalance = (idx, field) => {
    const flagKey = field === "percentage" ? "percentageBalance" : "costWeightBalance";
    const turningOn = !composition[idx][flagKey];
    const updated = composition.map((c, i) => {
      if (i === idx) return { ...c, [flagKey]: turningOn };
      if (turningOn && c[flagKey]) return { ...c, [flagKey]: false };
      return c;
    });
    onChange(recomputeCompositionBalance(updated));
  };
  const total = compositionTotalPct(composition);
  const costTotal = compositionCostWeightTotal(composition);
  const estCost = composition.reduce((sum, c) => {
    return sum + (componentUnitCost(data, getComponent(data, c.componentId)) * ((Number(effectiveCostWeight(c)) || 0) / 100));
  }, 0);
  const balBtnStyle = (active) => ({ fontSize: 10, padding: "0 6px", borderRadius: 6, border: "1px solid #D7DAD3", background: active ? "#1F6F78" : "#fff", color: active ? "#fff" : "#8A9099", cursor: "pointer", flexShrink: 0 });
  const gridCols = showCostWeight ? "1.4fr 1.1fr 1.1fr 28px" : "1.6fr 1.1fr 28px";

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>Composition</div>
        <Btn variant="secondary" onClick={addLine}><Plus size={13} />Add component</Btn>
      </div>
      <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
        {showCostWeight
          ? "Break this item into fundamental components. Physical % is the volumetric/mass share (drives the stock balance below). Cost % is an independent share of the item's cost — a cheap diluent can be most of the volume while carrying none of the cost. Leave Cost % blank to just mirror Physical %, or use Bal to make either field automatically absorb whatever's left to reach 100%."
          : "Break this item into fundamental components by physical share. Cost allocation isn't separately adjustable here — it always mirrors Physical %, since this item's cost is either driven by its process recipe or, without one, by this same physical breakdown. Use Bal to make a component automatically absorb whatever's left to reach 100%."}
      </div>
      {composition.length === 0 && <div style={{ fontSize: 12, color: "#8A9099", marginBottom: 8 }}>No composition defined.</div>}
      {composition.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 8, marginBottom: 4 }}>
          <div />
          <div style={{ fontSize: 10.5, color: "#8A9099", textTransform: "uppercase", letterSpacing: 0.3 }}>Physical %</div>
          {showCostWeight && <div style={{ fontSize: 10.5, color: "#8A9099", textTransform: "uppercase", letterSpacing: 0.3 }}>Cost %</div>}
          <div />
        </div>
      )}
      {composition.map((c, idx) => (
        <div key={c.id} style={{ display: "grid", gridTemplateColumns: gridCols, gap: 8, marginBottom: 8 }}>
          <select style={inputStyle} value={c.componentId} onChange={e => updateLine(idx, { componentId: e.target.value })}>
            {componentOptions.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <div style={{ display: "flex", gap: 4 }}>
            <input type="number" step="0.1" style={{ ...inputStyle, opacity: c.percentageBalance ? 0.6 : 1 }} disabled={!!c.percentageBalance}
              value={c.percentage} onChange={e => updateLine(idx, { percentage: parseFloat(e.target.value) || 0 })} placeholder="%" />
            <button type="button" onClick={() => toggleBalance(idx, "percentage")} style={balBtnStyle(!!c.percentageBalance)} title="Balance to 100%">Bal</button>
          </div>
          {showCostWeight && (
            <div style={{ display: "flex", gap: 4 }}>
              <input type="number" step="0.1" style={{ ...inputStyle, opacity: c.costWeightBalance ? 0.6 : 1 }} disabled={!!c.costWeightBalance}
                value={c.costWeightBalance ? c.costWeight : (c.costWeight === null || c.costWeight === undefined ? "" : c.costWeight)}
                onChange={e => updateLine(idx, { costWeight: e.target.value === "" ? null : (parseFloat(e.target.value) || 0) })}
                placeholder={"= " + fmtNum(c.percentage) + "%"} />
              <button type="button" onClick={() => toggleBalance(idx, "costWeight")} style={balBtnStyle(!!c.costWeightBalance)} title="Balance to 100%">Bal</button>
            </div>
          )}
          <IconBtn onClick={() => removeLine(idx)} title="Remove" danger><Trash2 size={13} /></IconBtn>
        </div>
      ))}
      {composition.length > 0 && (
        <div style={{ fontSize: 11.5, color: "#8A9099", display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <span>Physical total: <Badge tone={Math.abs(total - 100) <= 1 ? "good" : "warn"}>{fmtNum(total)}%</Badge></span>
          {showCostWeight && <span>Cost total: <Badge tone={Math.abs(costTotal - 100) <= 1 ? "good" : "warn"}>{fmtNum(costTotal)}%</Badge></span>}
          <span>Est. cost from composition: <span className="mono" style={{ fontWeight: 600 }}>{fmtMoney(estCost)}</span></span>
        </div>
      )}
      {componentOptions.length === 0 && <div style={{ fontSize: 12, color: "#B87510" }}>Add components on the Components tab first so you have something to choose from.</div>}
    </div>
  );
}

// Read-only view of the auto-calculated composition for an item whose
// autoComposition checkbox is on - rolled up from its process recipe,
// cost-weighted (see computeEffectiveComposition for the rationale).
function ComputedCompositionView({ itemType, itemId, data }) {
  const process = itemId ? findProcessForOutput(data, itemType, itemId) : null;
  if (!process) {
    return (
      <div style={{ fontSize: 12, color: "#B87510" }}>
        {itemId ? "No process produces this item yet, so there's nothing to calculate from." : "Save this item first, then link a process to it, before composition can be calculated."} Uncheck to enter composition by hand instead.
      </div>
    );
  }
  const composition = computeEffectiveComposition(data, itemType, itemId);
  const total = compositionTotalPct(composition);
  if (composition.length === 0) {
    return <div style={{ fontSize: 12, color: "#8A9099" }}>None of "{process.name}"'s inputs (or their own composition) trace back to a component yet.</div>;
  }
  return (
    <div>
      {composition.map(c => {
        const comp = getComponent(data, c.componentId);
        if (!comp) return null;
        return (
          <div key={c.componentId} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "5px 0", borderBottom: "1px dashed #EEF0EA" }}>
            <span>{comp.name}</span>
            <span className="mono">{fmtNum(c.percentage)}% · cost {fmtNum(c.costWeight)}%</span>
          </div>
        );
      })}
      <div style={{ fontSize: 11, color: "#8A9099", marginTop: 8 }}>
        Total {fmtNum(total)}% — rolled up from "{process.name}", cost-weighted across its inputs. Inputs with no composition of their own (or $0 cost) aren't represented, so this may not reach 100%.
      </div>
    </div>
  );
}

const filterInputStyle = { fontSize: 11.5, padding: "4px 6px", border: "1px solid #D7DAD3", borderRadius: 5, width: "100%", fontFamily: "'IBM Plex Sans', sans-serif" };

// Shared sortable/filterable lots table - used both in the compact
// LotsEditor (inside the catalog edit forms) and the Inventory card's
// "Available lots" view, so the two behave identically. Defaults to
// newest-first by date. Fully consumed (qty <= 0) lots get an inline tag
// next to their quantity, and can be filtered out via the header.
function LotsTable({ lots, unit, onRowClick, showRemove, onRemove, dateLabel, onConsume }) {
  dateLabel = dateLabel || "Date";
  const [sortKey, setSortKey] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [lotFilter, setLotFilter] = useState("");
  const [consumedFilter, setConsumedFilter] = useState("all");
  const [fileFilter, setFileFilter] = useState("all");

  const toggleSort = (key) => {
    if (sortKey === key) { setSortDir(d => d === "asc" ? "desc" : "asc"); return; }
    setSortKey(key);
    setSortDir(key === "lotNumber" ? "asc" : "desc");
  };
  const sortIcon = (key) => sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";
  const th = (key, label) => <th style={{ cursor: "pointer", userSelect: "none" }} onClick={() => toggleSort(key)}>{label}{sortIcon(key)}</th>;

  const filtered = lots.filter(lot => {
    if (lotFilter && !(lot.lotNumber || "").toLowerCase().includes(lotFilter.toLowerCase())) return false;
    const isConsumed = (Number(lot.qty) || 0) <= 0;
    if (consumedFilter === "consumed" && !isConsumed) return false;
    if (consumedFilter === "active" && isConsumed) return false;
    if (fileFilter === "yes" && !lot.attachment) return false;
    if (fileFilter === "no" && lot.attachment) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    let av, bv;
    if (sortKey === "lotNumber") { av = (a.lotNumber || "").toLowerCase(); bv = (b.lotNumber || "").toLowerCase(); }
    else if (sortKey === "qty") { av = Number(a.qty) || 0; bv = Number(b.qty) || 0; }
    else if (sortKey === "usedDate") { av = a.usedDate || ""; bv = b.usedDate || ""; }
    else if (sortKey === "consumedDate") { av = a.consumedDate || ""; bv = b.consumedDate || ""; }
    else { av = a.date || ""; bv = b.date || ""; }
    if (av < bv) return sortDir === "asc" ? -1 : 1;
    if (av > bv) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  return (
    <div style={{ border: "1px solid #E7E9E4", borderRadius: 8, overflow: "hidden" }}>
      <table className="mrp-table">
        <thead>
          <tr>
            {th("lotNumber", "Lot #")}
            {th("date", dateLabel)}
            {th("qty", "Qty")}
            {th("usedDate", "Used")}
            {th("consumedDate", "Consumed")}
            <th>File</th>
            <th></th>
          </tr>
          <tr>
            <th style={{ padding: "4px 8px" }}><input value={lotFilter} onChange={e => setLotFilter(e.target.value)} placeholder="Filter…" style={filterInputStyle} /></th>
            <th></th>
            <th style={{ padding: "4px 8px" }}>
              <select value={consumedFilter} onChange={e => setConsumedFilter(e.target.value)} style={filterInputStyle}>
                <option value="all">All</option>
                <option value="active">Active</option>
                <option value="consumed">Consumed</option>
              </select>
            </th>
            <th></th>
            <th></th>
            <th style={{ padding: "4px 8px" }}>
              <select value={fileFilter} onChange={e => setFileFilter(e.target.value)} style={filterInputStyle}>
                <option value="all">All</option>
                <option value="yes">Has file</option>
                <option value="no">No file</option>
              </select>
            </th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(lot => {
            const isConsumed = (Number(lot.qty) || 0) <= 0;
            return (
              <tr key={lot.id} style={{ cursor: "pointer" }} onClick={() => onRowClick(lot.id)}>
                <td className="mono">{lot.lotNumber || "—"}</td>
                <td className="mono">{fmtDate(lot.date)}</td>
                <td className="mono">{fmtNum(lot.qty)} {unit} {isConsumed && <Badge tone="neutral">Consumed</Badge>}</td>
                <td className="mono">{lot.usedDate ? fmtDate(lot.usedDate) : "—"}</td>
                <td className="mono">{lot.consumedDate ? fmtDate(lot.consumedDate) : "—"}</td>
                <td>{lot.attachment ? <Badge tone="good">Yes</Badge> : "—"}</td>
                <td onClick={e => e.stopPropagation()}>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    {onConsume && <IconBtn onClick={() => onConsume(lot.id)} title="Consume lot (loss, damage, expiry, etc.)"><AlertTriangle size={13} /></IconBtn>}
                    <IconBtn onClick={() => onRowClick(lot.id)} title="View / edit lot"><Pencil size={13} /></IconBtn>
                    {showRemove && <IconBtn onClick={() => onRemove(lot.id)} title="Remove lot" danger><Trash2 size={13} /></IconBtn>}
                  </div>
                </td>
              </tr>
            );
          })}
          {sorted.length === 0 && <tr><td colSpan={8} style={{ textAlign: "center", color: "#8A9099", padding: 20 }}>{lots.length === 0 ? "No lots recorded yet." : "No lots match the current filters."}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------------------------------------------------------
   Lots editor (admin, direct catalog editing) - lot number, date,
   quantity, and notes only.
----------------------------------------------------------------*/
function LotsEditor({ lots, onChange, packagings, shelfLifeDays, unit, dateLabel, qcComponents, data, itemType, itemId, update }) {
  dateLabel = dateLabel || "Date";
  const [detailLotId, setDetailLotId] = useState(null);
  const [consumeLotId, setConsumeLotId] = useState(null);
  const defaultPackagingId = (Array.isArray(packagings) && (packagings.find(p => p.isDefault) || packagings[0]) || {}).id || "";
  const addLot = () => onChange([...lots, { id: uid(), lotNumber: "", date: todayStr(), qty: 0,
    producedQty: "", unitCost: "", batchId: "", processId: "",
    notes: "", sources: [], actualEquipment: [], actualLabor: [], qcChecks: [], usedDate: "", consumedDate: "",
    packagingId: defaultPackagingId, expirationDate: "", productionDate: "", arrivalDate: "",
    origin: "", mfg: "", orderRef: "", containerCount: "" }]);
  const updateLotById = (lotId, patch) => onChange(lots.map(l => l.id === lotId ? { ...l, ...patch } : l));
  const removeLotById = (lotId) => onChange(lots.filter(l => l.id !== lotId));
  const detailLot = detailLotId ? lots.find(l => l.id === detailLotId) : null;
  const consumeLot = consumeLotId ? lots.find(l => l.id === consumeLotId) : null;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 12.5, color: "#8A9099" }}>{lots.length} lot{lots.length === 1 ? "" : "s"} · {fmtNum(lotQty(lots))} {unit} total</div>
        <Btn variant="secondary" onClick={addLot}><Plus size={13} />Add lot</Btn>
      </div>
      {!itemId && lots.length > 0 && <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 6 }}>Save this item once before lots can be individually consumed (loss, damage, etc.) here.</div>}
      <LotsTable lots={lots} unit={unit} dateLabel={dateLabel} onRowClick={setDetailLotId} showRemove={true} onRemove={removeLotById} onConsume={itemId ? setConsumeLotId : undefined} />
      {detailLot && (
        <LotDetailModal
          data={data} itemType={itemType} itemId={itemId}
          lot={detailLot} unit={unit} dateLabel={dateLabel} qcComponents={qcComponents}
          packagings={packagings} shelfLifeDays={shelfLifeDays}
          onSave={(patch) => { updateLotById(detailLotId, patch); setDetailLotId(null); }}
          onClose={() => setDetailLotId(null)}
        />
      )}
      {consumeLot && (
        <ConsumeLotModal data={data} itemType={itemType} itemId={itemId} lot={consumeLot} update={update} onClose={() => setConsumeLotId(null)} onLocalSync={(patch) => updateLotById(consumeLotId, patch)} />
      )}
    </div>
  );
}

// Full detail view for a single lot, reached by clicking its row in the
// compact table above: everything that used to be crammed inline (notes,
// attachment, QC checks) plus received/used/consumed date tracking and a
// basic bidirectional traceability view - backward from this lot's own
// `sources`, forward from findLotsConsumingLot. A first foundation for
// the fuller traceability module planned down the line, not the whole
// thing. Operates on a local draft; nothing is applied until Save, which
// hands the patch back up to the parent LotsEditor's own draft - matching
// how the surrounding catalog modals already stage changes until their
// own Save button is clicked.
function LotDetailModal({ data, itemType, itemId, lot, unit, dateLabel, qcComponents, packagings, shelfLifeDays, onSave, onClose }) {
  const [f, setF] = useState(structuredClone(lot));
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const pkgList = Array.isArray(packagings) ? packagings : [];
  const addLotDays = (iso, n) => {
    if (!iso || !n) return "";
    const d = new Date(iso + "T00:00:00Z");
    if (isNaN(d.getTime())) return "";
    d.setUTCDate(d.getUTCDate() + Number(n));
    return d.toISOString().slice(0, 10);
  };
  const [uploadStatus, setUploadStatus] = useState("idle");
  const [uploadError, setUploadError] = useState("");

  const handleAttachment = async (file) => {
    if (!file) return;
    setUploadStatus("uploading");
    setUploadError("");
    try {
      const uploaded = await uploadAttachment(file);
      set("attachment", uploaded);
      setUploadStatus("done");
    } catch (err) {
      setUploadStatus("error");
      setUploadError(err.message || "Upload failed.");
    }
  };

  const setQcCheck = (componentId, patch) => {
    let existing = [...(f.qcChecks || [])];
    const cidx = existing.findIndex(q => q.componentId === componentId);
    const current = cidx >= 0 ? existing[cidx] : { id: uid(), componentId, mode: "manual", measuredValue: "", concentration: "" };
    const merged = { ...current, ...patch };
    if (merged.mode === "balance") {
      existing = existing.map(q => (q.componentId !== componentId && q.mode === "balance") ? { ...q, mode: "manual" } : q);
    }
    const idxAfter = existing.findIndex(q => q.componentId === componentId);
    if (idxAfter >= 0) existing[idxAfter] = merged;
    else existing.push(merged);
    existing = recomputeBalanceEntry(existing);
    set("qcChecks", existing);
  };

  const sourcedFrom = (f.sources || []).map(s => {
    const sep = s.groupKey.indexOf(":");
    const srcType = s.groupKey.slice(0, sep);
    const srcId = s.groupKey.slice(sep + 1);
    const srcItem = getCatalogItem(data, srcType, srcId);
    const srcLot = srcItem ? (srcItem.lots || []).find(l => l.id === s.lotId) : null;
    return { name: srcItem ? srcItem.name : "(deleted item)", lotNumber: srcLot ? srcLot.lotNumber : "—", qty: s.qty, unit: srcItem ? srcItem.unit : "" };
  });
  const usedIn = itemId ? findLotsConsumingLot(data, itemType, itemId, lot.id) : [];

  return (
    <Modal title="Lot detail" onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 12 }}>
        <Field label="Lot / batch number"><input style={inputStyle} value={f.lotNumber} onChange={e => set("lotNumber", e.target.value)} /></Field>
        <Field label={dateLabel}><input type="date" style={inputStyle} value={f.date} onChange={e => set("date", e.target.value)} /></Field>
        <Field label={"Qty (" + unit + ")"}><input type="number" step="0.01" style={inputStyle} value={f.qty} onChange={e => set("qty", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Used date" hint="Auto-set the first time this lot is drawn on in a batch"><input type="date" style={inputStyle} value={f.usedDate || ""} onChange={e => set("usedDate", e.target.value)} /></Field>
        <Field label="Consumed date" hint="Auto-set once this lot's quantity reaches zero"><input type="date" style={inputStyle} value={f.consumedDate || ""} onChange={e => set("consumedDate", e.target.value)} /></Field>
      </div>
      <Field label="Notes" span={2}><input style={inputStyle} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Supplier ref, QC observations…" /></Field>

      <div style={{ borderTop: "1px solid #EEF0EA", marginTop: 14, paddingTop: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Warehouse / physical</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Packaging" hint="Which storable SKU / container this lot is">
            <select style={inputStyle} value={f.packagingId || ""} onChange={e => set("packagingId", e.target.value)}>
              <option value="">—</option>
              {pkgList.map(p => <option key={p.id} value={p.id}>{[p.sku, p.size, p.packageType].filter(Boolean).join(" · ")}</option>)}
            </select>
          </Field>
          <Field label="Production date">
            <input type="date" style={inputStyle} value={f.productionDate || ""} onChange={e => {
              const productionDate = e.target.value;
              setF(prev => {
                const next = { ...prev, productionDate };
                if (productionDate && !prev.expirationDate && shelfLifeDays) next.expirationDate = addLotDays(productionDate, shelfLifeDays);
                return next;
              });
            }} />
          </Field>
          <Field label="Arrival date"><input type="date" style={inputStyle} value={f.arrivalDate || ""} onChange={e => set("arrivalDate", e.target.value)} /></Field>
          <Field label="Expiration date" hint={shelfLifeDays ? "Production date + " + shelfLifeDays + " day shelf life" : "Enter or compute from production date"}>
            <div style={{ display: "flex", gap: 6 }}>
              <input type="date" style={inputStyle} value={f.expirationDate || ""} onChange={e => set("expirationDate", e.target.value)} />
              {shelfLifeDays && f.productionDate && (
                <button type="button" onClick={() => set("expirationDate", addLotDays(f.productionDate, shelfLifeDays))}
                  style={{ fontSize: 11, padding: "0 8px", borderRadius: 6, border: "1px solid #D7DAD3", background: "#fff", color: "#5B6470", cursor: "pointer", whiteSpace: "nowrap" }}>Auto</button>
              )}
            </div>
          </Field>
          <Field label="Origin / source"><input style={inputStyle} value={f.origin || ""} onChange={e => set("origin", e.target.value)} placeholder="Supplier or plant" /></Field>
          <Field label="Manufacturer"><input style={inputStyle} value={f.mfg || ""} onChange={e => set("mfg", e.target.value)} placeholder="e.g. LV, EV" /></Field>
          <Field label="Order ref"><input style={inputStyle} value={f.orderRef || ""} onChange={e => set("orderRef", e.target.value)} placeholder="PO / SO number" /></Field>
          <Field label="Container count" hint="How many containers in this lot"><input type="number" style={inputStyle} value={f.containerCount ?? ""} onChange={e => set("containerCount", e.target.value === "" ? "" : (parseFloat(e.target.value) || 0))} /></Field>
        </div>
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", marginTop: 14, paddingTop: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Attachment</div>
        {f.attachment ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Badge tone="good">Attached</Badge>
            <button type="button" onClick={() => openAttachment(f.attachment)} style={{ background: "none", border: "none", color: "#1F6F78", textDecoration: "underline", cursor: "pointer", fontSize: 12.5, padding: 0 }}>{f.attachment.fileName}</button>
            <button type="button" onClick={() => set("attachment", null)} style={{ background: "none", border: "none", color: "#A32D2D", cursor: "pointer", fontSize: 11.5, padding: 0 }}>Remove</button>
          </div>
        ) : (
          <>
            <input type="file" accept="image/*,.pdf" disabled={uploadStatus === "uploading"} onChange={e => handleAttachment(e.target.files && e.target.files[0])} style={{ fontSize: 12.5 }} />
            {uploadStatus === "uploading" && <div style={{ fontSize: 11.5, color: "#8A9099", marginTop: 4 }}>Uploading…</div>}
            {uploadStatus === "error" && <div style={{ fontSize: 11.5, color: "#8A2E20", marginTop: 4 }}>{uploadError}</div>}
          </>
        )}
      </div>

      {qcComponents && qcComponents.length > 0 && (
        <div style={{ borderTop: "1px solid #EEF0EA", marginTop: 14, paddingTop: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>QC concentration checks</div>
          {qcComponents.map(comp => {
            const check = (f.qcChecks || []).find(q => q.componentId === comp.id) || { mode: "manual", measuredValue: "", concentration: "" };
            const canCalc = comp.qcCalibration && comp.qcCalibration.enabled;
            const toggleStyle = (active) => ({ fontSize: 10.5, padding: "2px 7px", borderRadius: 999, border: "1px solid #D7DAD3", background: active ? "#1F6F78" : "#fff", color: active ? "#fff" : "#5B6470", cursor: "pointer" });
            return (
              <div key={comp.id} style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: "#5B6470" }}>{comp.name}</span>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button type="button" onClick={() => setQcCheck(comp.id, { mode: "manual" })} style={toggleStyle(check.mode === "manual" || !check.mode)}>Manual</button>
                    {canCalc && <button type="button" onClick={() => setQcCheck(comp.id, { mode: "calculated" })} style={toggleStyle(check.mode === "calculated")}>Calculated</button>}
                    <button type="button" onClick={() => setQcCheck(comp.id, { mode: "balance" })} style={toggleStyle(check.mode === "balance")}>Balance</button>
                  </div>
                </div>
                {check.mode === "balance" ? (
                  <div className="mono" style={{ display: "flex", alignItems: "center", padding: "0 10px", height: 34, borderRadius: 6, background: "#F2F3EE", color: "#3C4038", fontWeight: 600, fontSize: 13.5 }}>
                    Balance: {fmtNum(check.concentration)}%
                  </div>
                ) : check.mode === "calculated" && canCalc ? (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <input type="number" step="any" style={inputStyle} value={check.measuredValue} onChange={e => {
                      const measuredValue = e.target.value;
                      setQcCheck(comp.id, { measuredValue, concentration: computeQcConcentration(comp, measuredValue), mode: "calculated" });
                    }} placeholder={(comp.qcCalibration.measurementLabel || "Measured value") + (comp.qcCalibration.measurementUnit ? " (" + comp.qcCalibration.measurementUnit + ")" : "")} />
                    <div className="mono" style={{ display: "flex", alignItems: "center", padding: "0 10px", borderRadius: 6, background: "#F2F3EE", color: "#3C4038", fontWeight: 600, fontSize: 13.5 }}>
                      {check.measuredValue !== "" ? "= " + fmtNum(check.concentration) + "%" : "—"}
                    </div>
                  </div>
                ) : (
                  <input type="number" step="any" style={inputStyle} value={check.concentration} onChange={e => setQcCheck(comp.id, { concentration: e.target.value, mode: "manual" })} placeholder="Concentration %" />
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ borderTop: "1px solid #EEF0EA", marginTop: 14, paddingTop: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Traceability</div>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Sourced from (backward)</div>
        {sourcedFrom.length === 0 && <div style={{ fontSize: 12, color: "#8A9099", marginBottom: 10 }}>No source lots recorded for this lot.</div>}
        {sourcedFrom.map((s, i) => (
          <div key={i} style={{ fontSize: 12.5, padding: "3px 0" }}>{s.name} — Lot {s.lotNumber} · {fmtNum(s.qty)} {s.unit}</div>
        ))}
        <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.3, marginTop: 12, marginBottom: 4 }}>Used in (forward)</div>
        {usedIn.length === 0 && <div style={{ fontSize: 12, color: "#8A9099" }}>Not yet consumed by anything downstream.</div>}
        {usedIn.map((u, i) => (
          <div key={i} style={{ fontSize: 12.5, padding: "3px 0" }}>{u.itemName} <Badge tone={u.itemType === "finished" ? "good" : "info"}>{u.itemType}</Badge> — Lot {u.lotNumber} · {fmtNum(u.qty)} {u.unit}</div>
        ))}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={() => onSave(f)}>Save changes</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Main App
----------------------------------------------------------------*/
/* ---------------------------------------------------------------
   Sidebar navigation model

   Admin nav is grouped into collapsible sections. Each group's
   `items` are the tab keys rendered inside it; the keys themselves
   are unchanged from V1, so every existing `setTab(...)` call and
   every `{tab === "..." && ...}` render guard still works.
----------------------------------------------------------------*/
const ADMIN_NAV_GROUPS = [
  {
    key: "grpDashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    items: [
      { key: "dashboard", label: "Overview", icon: LayoutDashboard },
      { key: "schedule", label: "Production schedule", icon: Calendar },
      // Equipment sits with the schedule rather than with Processes: its
      // units and operating hours are what the capacity plan is built from.
      { key: "equipment", label: "Equipment", icon: Wrench },
      { key: "forecast", label: "MRP forecast", icon: TrendingUp },
      { key: "utilization", label: "Equipment utilization", icon: Activity }
    ]
  },
  {
    key: "grpProcesses",
    label: "Processes",
    icon: Factory,
    items: [
      { key: "processes", label: "Processes", icon: Factory },
      { key: "flow", label: "Process flow", icon: Layers },
      { key: "batches", label: "Batch records", icon: ClipboardList },
      { key: "maintenance", label: "Maintenance", icon: RefreshCw }
    ]
  },
  {
    key: "grpMaterials",
    label: "Materials",
    icon: Package,
    items: [
      { key: "components", label: "Components", icon: Beaker },
      { key: "materials", label: "Raw materials", icon: Package },
      { key: "intermediateProducts", label: "Intermediate products", icon: Layers },
      { key: "finished", label: "Finished goods", icon: Boxes },
      { key: "wasteStreams", label: "Waste streams", icon: Recycle }
    ]
  },
  {
    key: "grpSales",
    label: "Sales",
    icon: DollarSign,
    items: [
      { key: "salesOrders", label: "Sales orders", icon: ClipboardList },
      { key: "customers", label: "Customers", icon: Users },
      { key: "revenue", label: "Revenue", icon: DollarSign },
      { key: "shipments", label: "Shipments", icon: Truck }
    ]
  }
];

/* Operator nav stays flat - only seven entries, and operators benefit
   from every destination being visible without a click. */
const OPERATOR_NAV = [
  { key: "schedule", label: "Production schedule", icon: Calendar },
  { key: "receiving", label: "Raw material receiving", icon: Package },
  { key: "opprocesses", label: "Processes", icon: Factory },
  { key: "opintermediates", label: "Intermediate products", icon: Layers },
  { key: "opfinished", label: "Finished goods", icon: Boxes },
  { key: "opwaste", label: "Waste streams", icon: Recycle },
  { key: "opshipments", label: "Finished goods shipment", icon: Truck }
];

const groupKeyForTab = (tabKey) => {
  const g = ADMIN_NAV_GROUPS.find(grp => grp.items.some(i => i.key === tabKey));
  return g ? g.key : null;
};

/* Single source of truth for a destination's name. PageHeader resolves
   its heading through this, so renaming a nav entry renames the page
   heading with it and the two cannot drift apart. */
const navLabelForTab = (tabKey) => {
  for (const grp of ADMIN_NAV_GROUPS) {
    const hit = grp.items.find(i => i.key === tabKey);
    if (hit) return hit.label;
  }
  const op = OPERATOR_NAV.find(i => i.key === tabKey);
  return op ? op.label : "";
};

/* Shared look for the two sidebar actions below the nav. */
const sidebarActionStyle = {
  display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
  borderRadius: 7, cursor: "pointer", fontSize: 12, fontWeight: 600,
  color: "#C4C9C2", border: "1px solid #333A40", background: "transparent"
};

function NavRow({ item, active, nested, onClick }) {
  const Icon = item.icon;
  const activate = () => onClick(item.key);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={active ? "page" : undefined}
      onClick={activate}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); } }}
      style={{
        display: "flex", alignItems: "center", gap: 9,
        padding: nested ? "7px 10px" : "9px 12px",
        borderRadius: 7, cursor: "pointer", marginBottom: 2,
        fontSize: nested ? 12.5 : 13, fontWeight: active ? 600 : 500,
        background: active ? "#2E7D5B22" : "transparent",
        color: active ? "#8FE0C6" : "#C4C9C2"
      }}
    >
      <Icon size={nested ? 14 : 15} />
      {item.label}
    </div>
  );
}

function NavGroup({ group, tab, open, onToggle, onSelect }) {
  const GroupIcon = group.icon;
  const holdsActive = group.items.some(i => i.key === tab);
  return (
    <div style={{ marginBottom: 4 }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => onToggle(group.key)}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(group.key); } }}
        style={{
          display: "flex", alignItems: "center", gap: 9, padding: "8px 10px",
          borderRadius: 7, cursor: "pointer",
          fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase",
          color: holdsActive ? "#8FE0C6" : "#8B929A",
          background: holdsActive && !open ? "#2E7D5B18" : "transparent"
        }}
      >
        <GroupIcon size={14} />
        <span style={{ flex: 1 }}>{group.label}</span>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      </div>
      {open && (
        <div style={{ marginTop: 2, marginLeft: 11, paddingLeft: 8, borderLeft: "1px solid #333A40" }}>
          {group.items.map(item => (
            <NavRow key={item.key} item={item} active={tab === item.key} nested onClick={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

/* Confirmation for replacing the whole console with the sample factory.
   A named component rather than inline JSX so it can be rendered in a test
   on its own - this dialog was silently missing once already, and asserting
   that a string exists in the source is not the same as rendering it. */
function LoadSampleModal({ onCancel, onConfirm }) {
  return (
    <Modal title="Load sample data" onClose={onCancel}>
      <div style={{ fontSize: 13.5, color: "#3C4340", marginBottom: 12 }}>
        This replaces <b>everything</b> currently in the console with the built-in
        sample factory &mdash; an instant coffee plant with roughly five months of
        production history, a full lot genealogy, frozen production plans and
        shipment records.
      </div>
      <div style={{ padding: "10px 12px", marginBottom: 16, borderRadius: 7, fontSize: 12.5,
                    background: "#FCF4F3", border: "1px solid #E3B9B2", color: "#8C332B" }}>
        Anything you have entered will be lost. If you want to keep it, cancel and
        use <b>Export all data (CSV)</b> first.
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="secondary" onClick={onCancel}>Cancel</Btn>
        <Btn onClick={onConfirm}>Replace everything</Btn>
      </div>
    </Modal>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [view, setView] = useState("admin");
  const [tab, setTab] = useState("dashboard");
  const [modal, setModal] = useState(null);
  const [search, setSearch] = useState("");
  const [horizon, setHorizon] = useState(60);
  const [saveState, setSaveState] = useState("idle");
  const [openGroups, setOpenGroups] = useState(() => ({ grpDashboard: true }));
  const [exportState, setExportState] = useState("idle");
  const [resetOpen, setResetOpen] = useState(false);
  const [sampleDismissed, setSampleDismissed] = useState(false);
  const [importReport, setImportReport] = useState(null);
  const initialized = useRef(false);

  useEffect(() => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      setData(val);
      initialized.current = true;
    };
    const timeoutId = setTimeout(() => finish(seedData()), 4000);
    (async () => {
      try {
        if (typeof window === "undefined" || !window.storage || typeof window.storage.get !== "function") {
          clearTimeout(timeoutId);
          finish(seedData());
          return;
        }
        const res = await window.storage.get("mrp_console_data", false);
        clearTimeout(timeoutId);
        if (res && res.value) {
          finish(normalizeData(JSON.parse(res.value)));
        } else {
          finish(seedData());
        }
      } catch (e) {
        clearTimeout(timeoutId);
        finish(seedData());
      }
    })();
    return () => clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!initialized.current || !data) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      try {
        if (typeof window === "undefined" || !window.storage || typeof window.storage.set !== "function") {
          setSaveState("error");
          return;
        }
        await window.storage.set("mrp_console_data", JSON.stringify(data), false);
        setSaveState("saved");
      } catch (e) {
        setSaveState("error");
      }
    }, 400);
    return () => clearTimeout(t);
  }, [data]);

  // Keep the group holding the active tab expanded, so jumps triggered
  // from outside the sidebar (dashboard cards, view switches) stay visible.
  useEffect(() => {
    if (view !== "admin") return;
    const g = groupKeyForTab(tab);
    if (!g) return;
    setOpenGroups(prev => (prev[g] ? prev : { ...prev, [g]: true }));
  }, [tab, view]);

  if (!data) {
    return (
      <div style={{ padding: 60, textAlign: "center", color: "#5B6470", fontFamily: "'IBM Plex Sans', sans-serif" }}>
        Loading inventory data…
      </div>
    );
  }

  const update = (fn) => setData(prev => {
    const next = structuredClone(prev);
    fn(next);
    return next;
  });

  const removeRaw = (id) => update(d => repo.remove(d, "rawMaterials", id));
  const removeIntermediateProduct = (id) => update(d => repo.remove(d, "intermediateProducts", id));
  const removeFinished = (id) => update(d => repo.remove(d, "finishedGoods", id));
  const removeProcess = (id) => update(d => repo.remove(d, "processes", id));
  const removeSchedule = (id) => update(d => repo.remove(d, "schedule", id));
  const removeEquipment = (id) => update(d => repo.remove(d, "equipment", id));
  const removeComponent = (id) => update(d => repo.remove(d, "components", id));
  const removeWasteStream = (id) => update(d => repo.remove(d, "wasteStreams", id));
  const removeMaintenance = (id) => update(d => repo.remove(d, "maintenance", id));
  const removeCustomer = (id) => update(d => repo.remove(d, "customers", id));
  const removeShipment = (id) => update(d => repo.remove(d, "shipments", id));

  const switchView = (v) => {
    setView(v);
    setTab(v === "admin" ? "dashboard" : "schedule");
    setModal(null);
  };

  const toggleGroup = (key) => setOpenGroups(prev => ({ ...prev, [key]: !prev[key] }));

  /* Build the whole CSV bundle and hand it to the browser as one zip.
     Everything happens in memory; nothing leaves the page. */
  const downloadCsvExport = () => {
    setExportState("working");
    try {
      const { bytes } = csvExportZip(data);
      const blob = new Blob([bytes], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mrp-export-" + todayStr() + ".zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportState("done");
    } catch (err) {
      console.error("CSV export failed", err);
      setExportState("error");
    }
  };

  /* Import is deliberately two-step: read the files, show what would
     happen, and only write once the person accepts. A bad spreadsheet
     should never silently overwrite a production history. */
  const onImportFiles = async (fileList) => {
    const files = {};
    for (const file of Array.from(fileList || [])) {
      files[file.name.replace(/\.csv$/i, "")] = await file.text();
    }
    if (!Object.keys(files).length) return;
    try {
      const result = importCsvBundle(data, files);
      setImportReport(result);
    } catch (err) {
      console.error("CSV import failed", err);
      setImportReport({ data: null, report: { tables: [], errors: [String(err && err.message || err)], warnings: [], inserted: 0, updated: 0, skipped: 0 } });
    }
  };

  /* Replace everything with the sample dataset. Destructive by design and
     never automatic - a console holding real work must not lose it because
     a newer sample shipped. */
  const loadSampleData = () => {
    setData(seedData());
    setResetOpen(false);
    setSampleDismissed(true);
  };

  const applyImport = () => {
    if (importReport && importReport.data) setData(importReport.data);
    setImportReport(null);
  };

  return (
    <div style={{
      fontFamily: "'IBM Plex Sans', sans-serif", background: "#F2F3EE", minHeight: 600,
      display: "flex", position: "relative", borderRadius: 12, overflow: "hidden",
      border: "1px solid #DCDFD6"
    }}>
      <style>{"@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap'); * { box-sizing: border-box; } table.mrp-table { width: 100%; border-collapse: collapse; font-size: 13px; } table.mrp-table th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: #7A8079; padding: 8px 10px; border-bottom: 1px solid #DCDFD6; font-weight: 600; } table.mrp-table td { padding: 9px 10px; border-bottom: 1px solid #EAEBE6; vertical-align: middle; } table.mrp-table tbody tr:hover { background: #FAFAF7; } .mono { font-family: 'IBM Plex Mono', monospace; } ::-webkit-scrollbar { width: 8px; height: 8px; } ::-webkit-scrollbar-thumb { background: #C7CBC0; border-radius: 4px; } .print-only { display: none; } @media print { @page { size: 4in 2in; margin: 0; } body * { visibility: hidden; } .print-only, .print-only * { visibility: visible; } .print-only { display: block !important; position: fixed; top: 0; left: 0; } }"}</style>

      <div style={{ width: 226, background: "#20262B", color: "#DEE1DA", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <div style={{ padding: "20px 18px 14px", borderBottom: "1px solid #333A40" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Factory size={20} color="#5FBFB0" />
            <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: 0.3 }}>FOUNDRY</span>
          </div>
          <div style={{ fontSize: 11, color: "#8B929A", marginTop: 2, letterSpacing: 0.3 }}>MRP CONSOLE</div>
        </div>
        <div style={{ padding: 12, borderBottom: "1px solid #333A40" }}>
          <div style={{ display: "flex", background: "#161B1F", borderRadius: 8, padding: 3 }}>
            {["admin", "operator"].map(v => (
              <div key={v} onClick={() => switchView(v)} style={{
                flex: 1, textAlign: "center", padding: "6px 0", borderRadius: 6, cursor: "pointer",
                fontSize: 12, fontWeight: 600, textTransform: "capitalize",
                background: view === v ? "#1F6F78" : "transparent",
                color: view === v ? "#fff" : "#8B929A"
              }}>{v}</div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: "#6B7178", marginTop: 6, lineHeight: 1.4 }}>
            View switch only — not access control. Anyone can toggle back to Admin.
          </div>
        </div>
        <div style={{ padding: 10, flex: 1, overflowY: "auto" }}>
          {view === "admin"
            ? ADMIN_NAV_GROUPS.map(group => (
                <NavGroup
                  key={group.key}
                  group={group}
                  tab={tab}
                  open={!!openGroups[group.key]}
                  onToggle={toggleGroup}
                  onSelect={setTab}
                />
              ))
            : OPERATOR_NAV.map(item => (
                <NavRow key={item.key} item={item} active={tab === item.key} onClick={setTab} />
              ))}
        </div>
        <div style={{ padding: 14, borderTop: "1px solid #333A40" }}>
          {view === "admin" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
              <div
                role="button" tabIndex={0} onClick={downloadCsvExport}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); downloadCsvExport(); } }}
                style={sidebarActionStyle}
              >
                <Download size={14} />
                {exportState === "working" ? "Preparing…" : "Export all data (CSV)"}
              </div>
              <div
                role="button" tabIndex={0} onClick={() => setResetOpen(true)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setResetOpen(true); } }}
                style={sidebarActionStyle}
                title="Replace everything with the built-in sample factory">
                <RefreshCw size={14} />
                Load sample data
              </div>
              <label style={{ ...sidebarActionStyle, cursor: "pointer" }}>
                <Upload size={14} />
                Import CSV…
                <input type="file" accept=".csv" multiple
                  onChange={e => { onImportFiles(e.target.files); e.target.value = ""; }}
                  style={{ display: "none" }} />
              </label>
            </div>
          )}
          <div style={{ fontSize: 11, color: "#767D85" }}>
            {saveState === "saving" && "Saving…"}
            {saveState === "saved" && "All changes saved"}
            {saveState === "error" && "Save failed — retrying"}
            {exportState === "done" && " — export downloaded"}
            {exportState === "error" && " — export failed"}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, padding: "22px 26px", overflowY: "auto", maxHeight: 780 }}>
        {view === "admin" && !sampleDismissed && data.seedVersion !== SEED_VERSION && (
          <div style={{
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
            padding: "10px 14px", marginBottom: 16, borderRadius: 8, fontSize: 13,
            background: "#F4F6F9", border: "1px solid #DCE1E8", color: "#3C4340"
          }}>
            <span>
              A newer sample dataset is available &mdash; an instant coffee plant with
              five months of production history. Your current data came from storage
              and is untouched.
            </span>
            <div style={{ flex: 1 }} />
            <Btn variant="secondary" onClick={() => setResetOpen(true)}
                 style={{ padding: "4px 10px", fontSize: 12 }}>Load it</Btn>
            <Btn variant="ghost" onClick={() => setSampleDismissed(true)}
                 style={{ padding: "4px 10px", fontSize: 12 }}>Dismiss</Btn>
          </div>
        )}
        {tab === "dashboard" && view === "admin" && <Dashboard data={data} setTab={setTab}
            onEditTargets={() => setModal({ type: "productionTargets", id: null })} />}
        {tab === "components" && view === "admin" && (
          <ComponentsTab data={data} search={search} setSearch={setSearch}
            onAdd={() => setModal({ type: "component", id: null })}
            onEdit={(id) => setModal({ type: "component", id })}
            onDelete={removeComponent} />
        )}
        {tab === "materials" && view === "admin" && (
          <RawMaterialsTab data={data} search={search} setSearch={setSearch}
            onAdd={() => setModal({ type: "raw", id: null })}
            onEdit={(id) => setModal({ type: "raw", id })}
            onDelete={removeRaw}
            onInventory={(id) => setModal({ type: "inventoryCard", itemType: "raw", id })} />
        )}
        {tab === "processes" && view === "admin" && (
          <ProcessesTab data={data} search={search} setSearch={setSearch}
            onAdd={() => setModal({ type: "process", id: null })}
            onEdit={(id) => setModal({ type: "process", id })}
            onDelete={removeProcess}
            onLogBatch={(processId) => setModal({ type: "batchlog", kind: null, id: processId })} />
        )}
        {tab === "intermediateProducts" && view === "admin" && (
          <IntermediateProductsTab data={data} search={search} setSearch={setSearch}
            onAdd={() => setModal({ type: "intermediateProduct", id: null })}
            onEdit={(id) => setModal({ type: "intermediateProduct", id })}
            onDelete={removeIntermediateProduct}
            onInventory={(id) => setModal({ type: "inventoryCard", itemType: "intermediate", id })} />
        )}
        {tab === "finished" && view === "admin" && (
          <FinishedGoodsTab data={data} search={search} setSearch={setSearch}
            onAdd={() => setModal({ type: "finished", id: null })}
            onEdit={(id) => setModal({ type: "finished", id })}
            onDelete={removeFinished}
            onInventory={(id) => setModal({ type: "inventoryCard", itemType: "finished", id })} />
        )}
        {tab === "wasteStreams" && view === "admin" && (
          <WasteStreamsTab data={data} search={search} setSearch={setSearch} readOnly={false}
            onAdd={() => setModal({ type: "wasteStream", id: null })}
            onEdit={(id) => setModal({ type: "wasteStream", id })}
            onDelete={removeWasteStream} />
        )}
        {tab === "equipment" && (
          <EquipmentTab data={data} search={search} setSearch={setSearch}
            onAdd={() => setModal({ type: "equipment", id: null })}
            onEdit={(id) => setModal({ type: "equipment", id })}
            onDelete={removeEquipment} />
        )}
        {tab === "flow" && view === "admin" && (
          <ProcessFlowTab data={data}
            onOpenProcess={(id) => setModal({ type: "process", id })} />
        )}
        {tab === "batches" && view === "admin" && <BatchRecordsTab data={data} />}
        {tab === "maintenance" && (
          <MaintenanceTab data={data}
            onAdd={() => setModal({ type: "maintenance", id: null })}
            onEdit={(id) => setModal({ type: "maintenance", id })}
            onDelete={removeMaintenance} />
        )}
        {tab === "salesOrders" && view === "admin" && (
          <SalesOrdersTab data={data}
            onOpenOrder={(id) => setModal({ type: "salesOrder", id })} />
        )}
        {tab === "customers" && (
          <CustomersTab data={data} search={search} setSearch={setSearch}
            onAdd={() => setModal({ type: "customer", id: null })}
            onEdit={(id) => setModal({ type: "customer", id })}
            onDelete={removeCustomer} />
        )}
        {tab === "schedule" && (
          <ScheduleTab data={data} readOnly={view === "operator"}
            onAdd={() => setModal({ type: "schedule", id: null })}
            onEdit={(id) => setModal({ type: "schedule", id })}
            onDelete={removeSchedule}
            onEditHours={() => setModal({ type: "operatingHours", id: null })}
            onFreeze={(id) => update(d => tx.freezeRun(d, { scheduleId: id, date: todayStr() }))}
            onAmend={(id) => setModal({ type: "amendRun", id })}
            onOpenBatch={(batchId) => setModal({ type: "batchRecord", id: batchId })} />
        )}
        {tab === "forecast" && <ForecastTab data={data} horizon={horizon} setHorizon={setHorizon}
          onOpenOrder={(id) => setModal({ type: "purchaseOrder", id })} />}
        {tab === "utilization" && <UtilizationTab data={data} horizon={horizon} setHorizon={setHorizon} />}
        {tab === "revenue" && <RevenueTab data={data} horizon={horizon} setHorizon={setHorizon}
          onOpenShipment={(id) => setModal({ type: "shipmentTrace", id })}
          onOpenBatch={(id) => setModal({ type: "batchRecord", id })}
          onCancelHeld={(id) => setModal({ type: "cancelHeld", id })}
          onOpenCancellation={(id) => setModal({ type: "cancellationRecord", id })} />}
        {tab === "shipments" && view === "admin" && (
          <ShipmentsTab data={data} onAdd={() => setModal({ type: "shipment", id: null })} onDelete={removeShipment} />
        )}

        {tab === "receiving" && view === "operator" && (
          <OperatorReceivingTab data={data} search={search} setSearch={setSearch}
            onReceive={(rawId) => setModal({ type: "receive", id: rawId })} />
        )}
        {tab === "opprocesses" && view === "operator" && (
          <OperatorProcessesTab data={data} search={search} setSearch={setSearch}
            onLogBatch={(processId) => setModal({ type: "batchlog", kind: null, id: processId })} />
        )}
        {tab === "opintermediates" && view === "operator" && (
          <OperatorCatalogTab data={data} search={search} setSearch={setSearch} itemType="intermediate"
            tabKey="opintermediates" subtitle="Current stock, produced via the Processes tab" />
        )}
        {tab === "opfinished" && view === "operator" && (
          <OperatorCatalogTab data={data} search={search} setSearch={setSearch} itemType="finished"
            tabKey="opfinished" subtitle="Current stock, produced via the Processes tab" />
        )}
        {tab === "opwaste" && view === "operator" && (
          <WasteStreamsTab data={data} search={search} setSearch={setSearch} readOnly={true} tabKey="opwaste" />
        )}
        {tab === "opshipments" && view === "operator" && (
          <ShipmentsTab data={data} onAdd={() => setModal({ type: "shipment", id: null })} tabKey="opshipments" />
        )}
      </div>

      {importReport && (
        <Modal title="Review import" onClose={() => setImportReport(null)} wide>
          <div style={{ fontSize: 13, color: "#3C4340", marginBottom: 14 }}>
            {importReport.data
              ? "Nothing has been written yet. Review the summary below, then apply."
              : "The import could not be read."}
          </div>
          <div style={{ display: "flex", gap: 20, marginBottom: 16, fontSize: 13 }}>
            <div><b>{importReport.report.inserted}</b> to insert</div>
            <div><b>{importReport.report.updated}</b> to update</div>
            <div style={{ color: importReport.report.skipped ? "#A32D2D" : "#3C4340" }}>
              <b>{importReport.report.skipped}</b> skipped
            </div>
          </div>

          {importReport.report.tables.length > 0 && (
            <div style={{ maxHeight: 210, overflowY: "auto", marginBottom: 14,
                          border: "1px solid #E7E9E4", borderRadius: 7 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <tbody>
                  {importReport.report.tables.map(t => (
                    <tr key={t.table} style={{ borderBottom: "1px solid #F0F2EE" }}>
                      <td style={{ padding: "6px 10px", fontWeight: 600 }}>{t.table}.csv</td>
                      <td style={{ padding: "6px 10px" }}>{t.inserted} new</td>
                      <td style={{ padding: "6px 10px" }}>{t.updated} updated</td>
                      <td style={{ padding: "6px 10px", color: t.skipped ? "#A32D2D" : "#7A8079" }}>
                        {t.skipped} skipped
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {importReport.report.errors.length > 0 && (
            <div style={{ maxHeight: 190, overflowY: "auto", marginBottom: 14, padding: 10,
                          background: "#FCF4F3", border: "1px solid #E3B9B2", borderRadius: 7,
                          fontSize: 12, color: "#8C332B" }}>
              {importReport.report.errors.slice(0, 60).map((e, i) => (
                <div key={i} style={{ marginBottom: 3 }}>{e}</div>
              ))}
              {importReport.report.errors.length > 60 && (
                <div style={{ marginTop: 6, fontStyle: "italic" }}>
                  and {importReport.report.errors.length - 60} more…
                </div>
              )}
            </div>
          )}

          {importReport.report.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 12, color: "#7A8079", marginBottom: 4 }}>{w}</div>
          ))}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Btn variant="secondary" onClick={() => setImportReport(null)}>Cancel</Btn>
            <Btn onClick={applyImport}>
              Apply {importReport.report.inserted + importReport.report.updated} change(s)
            </Btn>
          </div>
        </Modal>
      )}

      {resetOpen && (
        <LoadSampleModal onCancel={() => setResetOpen(false)} onConfirm={loadSampleData} />
      )}

      {modal && modal.type === "cancelHeld" && (() => {
        const row = heldFinishedGoods(data).find(r => r.entry.id === modal.id);
        return row ? <CancelHeldModal data={data} row={row}
          onClose={() => setModal(null)} update={update} /> : null;
      })()}

      {modal && modal.type === "cancellationRecord" && (() => {
        const rec = cancellationRecords(data).find(c => c.cancellation.id === modal.id);
        return rec ? <CancellationRecordModal record={rec} onClose={() => setModal(null)} /> : null;
      })()}

      {modal && modal.type === "salesOrder" && (
        <SalesOrderModal data={data} orderId={modal.id}
          onClose={() => setModal(null)} update={update} />
      )}

      {modal && modal.type === "shipmentTrace" && (
        <ShipmentTraceModal data={data} shipmentId={modal.id}
          onClose={() => setModal(null)} update={update} />
      )}

      {modal && modal.type === "purchaseOrder" && (() => {
        const rec = purchaseOrderRecords(data).find(r => r.po.id === modal.id);
        return rec ? <PurchaseOrderModal record={rec} onClose={() => setModal(null)} /> : null;
      })()}

      {modal && modal.type === "batchRecord" && (() => {
        const rec = batchRecords(data).find(b => b.batchId === modal.id);
        return rec ? <BatchRecordModal record={rec} onClose={() => setModal(null)} /> : null;
      })()}

      {modal && modal.type === "productionTargets" && (
        <ProductionTargetsModal data={data} onClose={() => setModal(null)} update={update} />
      )}

      {modal && modal.type === "amendRun" && (() => {
        const entry = repo.find(data, "schedule", modal.id);
        return entry ? (
          <AmendRunModal data={data} entry={entry} onClose={() => setModal(null)} update={update} />
        ) : null;
      })()}

      {modal && modal.type === "operatingHours" && (
        <OperatingHoursModal data={data} onClose={() => setModal(null)} update={update} />
      )}

      {modal && modal.type === "raw" && (
        <RawMaterialModal data={data} id={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "inventoryCard" && (
        <InventoryCardModal data={data} itemType={modal.itemType} itemId={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "component" && (
        <ComponentModal data={data} id={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "wasteStream" && (
        <WasteStreamModal data={data} id={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "process" && (
        <ProcessModal data={data} id={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "intermediateProduct" && (
        <IntermediateProductModal data={data} id={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "equipment" && (
        <EquipmentModal data={data} id={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "maintenance" && (
        <MaintenanceModal data={data} id={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "finished" && (
        <FinishedGoodModal data={data} id={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "customer" && (
        <CustomerModal data={data} id={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "schedule" && (
        <ScheduleModal data={data} id={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "shipment" && (
        <ShipmentModal data={data} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "receive" && (
        <ReceivingModal data={data} presetRawId={modal.id} onClose={() => setModal(null)} update={update} />
      )}
      {modal && modal.type === "batchlog" && (
        <BatchLogModal data={data} kind={modal.kind} processId={modal.id} onClose={() => setModal(null)} update={update} />
      )}
    </div>
  );
}

const CONSUME_REASONS = ["Lost", "Damaged/Contaminated", "Expired", "Empty Prior to Log"];

// Write-off/disposition for a lot that's leaving inventory for a reason
// other than normal production consumption or shipment. Always persists
// directly via update() rather than through a staged draft, since it has
// real side effects beyond the lot itself: "Accumulate as waste" pushes a
// waste lot to any linked waste stream for every component in this
// item's composition (split the same way batch-log waste is), and
// "Empty Prior to Log" can flag every downstream lot that consumed from
// this one, since their allocated cost may need reassessment now that
// the source turns out to have never really had the material.
function ConsumeLotModal({ data, itemType, itemId, lot, onClose, update, onLocalSync }) {
  const item = getCatalogItem(data, itemType, itemId);
  const unit = item ? item.unit : "";
  const [reason, setReason] = useState(CONSUME_REASONS[0]);
  const [disposeImmediately, setDisposeImmediately] = useState(false);
  const [accumulateAsWaste, setAccumulateAsWaste] = useState(false);
  const [applyCostFlag, setApplyCostFlag] = useState(false);
  const [note, setNote] = useState("");
  const isEmptyPriorToLog = reason === "Empty Prior to Log";
  const daughterLots = isEmptyPriorToLog ? findLotsConsumingLot(data, itemType, itemId, lot.id) : [];

  useEffect(() => {
    if (reason === "Empty Prior to Log") {
      setNote("Lot recorded with " + fmtNum(lot.qty) + " " + unit + " but found empty prior to log entry. Quantity discrepancy: " + fmtNum(lot.qty) + " " + unit + ".");
    } else {
      setNote("");
    }
  }, [reason]);

  const confirm = () => {
    // Computed once so the live-persisted lot and the caller's local
    // draft (if it has one - see LotsEditor) end up with exactly the
    // same result, rather than the draft silently reverting this on its
    // own next save.
    const lotPatch = {
      disposition: { reason, disposeImmediately, accumulateAsWaste, note, date: todayStr() },
      notes: (lot.notes ? lot.notes + " — " : "") + "[" + reason + "] " + note,
      qty: 0,
      consumedDate: lot.consumedDate || todayStr()
    };
    const flagNote = "Cost review flagged: upstream lot " + (lot.lotNumber || lot.id) + " of " + (item ? item.name : "") + " was found empty prior to log; this lot's allocated cost may need reassessment.";
    update(d => tx.consumeLot(d, {
      itemType, itemId, lotId: lot.id, lotPatch, accumulateAsWaste,
      flagDaughterLots: isEmptyPriorToLog && applyCostFlag, flagNote
    }));
    if (onLocalSync) onLocalSync(lotPatch);
    onClose();
  };

  return (
    <Modal title="Consume lot" onClose={onClose}>
      <div style={{ fontSize: 13, marginBottom: 14 }}>
        <span style={{ fontWeight: 700 }}>{item ? item.name : "(deleted item)"}</span> — Lot {lot.lotNumber || lot.id} · <span className="mono">{fmtNum(lot.qty)} {unit}</span> currently on hand
      </div>

      <Field label="Reason">
        <select style={inputStyle} value={reason} onChange={e => setReason(e.target.value)}>
          {CONSUME_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </Field>

      {isEmptyPriorToLog && (
        <div style={{ background: "#FEF6E4", border: "1px solid #E8C674", borderRadius: 8, padding: "10px 12px", marginTop: 10 }}>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "#7A5205", marginBottom: 4 }}>Quantity discrepancy detected</div>
          <div style={{ fontSize: 12, color: "#7A5205", marginBottom: daughterLots.length ? 8 : 0 }}>
            This lot shows {fmtNum(lot.qty)} {unit} on hand, but is being marked as having been empty before it was ever logged — a discrepancy of {fmtNum(lot.qty)} {unit}.
          </div>
          {daughterLots.length > 0 && (
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={applyCostFlag} onChange={e => setApplyCostFlag(e.target.checked)} style={{ marginTop: 2 }} />
              <span style={{ fontSize: 12, color: "#7A5205" }}>Apply remaining cost across all daughter items — flags {daughterLots.length} downstream lot{daughterLots.length === 1 ? "" : "s"} that consumed from this one for cost review</span>
            </label>
          )}
        </div>
      )}

      <Field label="Note" span={2}><textarea style={{ ...inputStyle, minHeight: 60, resize: "vertical", marginTop: 10 }} value={note} onChange={e => setNote(e.target.value)} placeholder="Additional detail…" /></Field>

      <div style={{ borderTop: "1px solid #EEF0EA", marginTop: 14, paddingTop: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={disposeImmediately} onChange={e => setDisposeImmediately(e.target.checked)} />
          <span style={{ fontSize: 13 }}>Dispose immediately</span>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <input type="checkbox" checked={accumulateAsWaste} onChange={e => setAccumulateAsWaste(e.target.checked)} />
          <span style={{ fontSize: 13 }}>Accumulate as waste</span>
        </label>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginTop: 6 }}>
          Accumulating logs this lot's remaining quantity to any linked, accumulating waste stream, split across components the same way batch-log waste is. Independent checkboxes — check either, both, or neither.
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={confirm}>Confirm consumption</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Dashboard
----------------------------------------------------------------*/
function Dashboard({ data, setTab, onEditTargets }) {
  const tr = useTimeRange(data, "13w");
  /* Defaults to the whole plant: that is what "how did we do" means, and it
     is the scope a site-wide target is set against. Narrower scopes are one
     click away and are unit-consistent; this one is not, which the subtitle
     says. */
  /* Finished goods is the only scope that is both unit-consistent and free of
     double counting, so it is the honest default. Everything else is one
     click away and says what it is measuring. */
  const [prodScope, setProdScope] = useState("finished");
  const [showScheduled, setShowScheduled] = useState(true);

  /* What the output chart is counting. Mixing kilogrammes of powder with
     counts of jars in one bar is the same class of error as stacking
     scheduled on top of actual, so the scope is explicit and the default is
     a single unit family rather than everything at once. */
  const scopeOptions = useMemo(() => {
    const opts = [
      { key: "finished", label: "All finished goods", kind: "group" },
      { key: "intermediate", label: "Intermediate throughput (all stages)", kind: "group" },
      { key: "all", label: "Everything (mixed units, all stages)", kind: "group" }
    ];
    (data.finishedGoods || []).forEach(f =>
      opts.push({ key: "finished:" + f.id, label: f.name, kind: "item",
                  itemType: "finished", itemId: f.id, unit: f.unit }));
    (data.intermediateProducts || []).forEach(x =>
      opts.push({ key: "intermediate:" + x.id, label: x.name, kind: "item",
                  itemType: "intermediate", itemId: x.id, unit: x.unit }));
    return opts;
  }, [data]);
  const scope = scopeOptions.find(o => o.key === prodScope) || scopeOptions[0];

  /* Which items the current scope covers, and how many of them are actually
     scheduled. Drawing a scheduled line across a scope that is only partly
     scheduled reads as enormous overproduction when the truth is simply that
     the rest was never on a schedule. */
  const scheduleCoverage = useMemo(() => {
    const ids = scope.kind === "item" ? [scope.itemId]
      : scope.key === "finished" ? (data.finishedGoods || []).map(f => f.id)
      : scope.key === "intermediate" ? (data.intermediateProducts || []).map(i => i.id)
      : (data.finishedGoods || []).map(f => f.id)
          .concat((data.intermediateProducts || []).map(i => i.id));
    const scheduled = new Set((data.schedule || [])
      .filter(s => s.status !== "Cancelled").map(s => s.productId));
    const covered = ids.filter(id => scheduled.has(id));
    return { total: ids.length, covered: covered.length,
             partial: covered.length > 0 && covered.length < ids.length,
             none: covered.length === 0 };
  }, [data, scope]);

  /* Summing every intermediate double-counts the same material: a tonne of
     green becomes sorted, then roasted, then ground, then extract, and each
     stage is counted again. A per-stage figure is meaningful; the sum is not. */
  const multiStage = scope.kind === "group" &&
    (scope.key === "intermediate" || scope.key === "all");

  const scheduleUsable = !scheduleCoverage.none && !multiStage;

  const batches = useMemo(() => batchRecords(data), [data]);
  const batchRows = useMemo(
    () => bucketEvents(batchEvents(data, batches), tr.range, ["batches"]),
    [data, batches, tr.range]);

  /* Actual output, filtered to whatever the scope is. */
  const prodSeries = useMemo(() => {
    if (scope.kind === "item") {
      return [{ key: "actual", label: "Produced", color: "#1F6F78" }];
    }
    if (scope.key === "finished") return [{ key: "finished", label: "Finished goods", color: "#1F6F78" }];
    if (scope.key === "intermediate") return [{ key: "intermediate", label: "Intermediate products", color: "#5FA8A0" }];
    return [
      { key: "intermediate", label: "Intermediate products", color: "#5FA8A0" },
      { key: "finished", label: "Finished goods", color: "#1F6F78" }
    ];
  }, [scope]);

  const prodRows = useMemo(() => {
    let events = productionEvents(data);
    if (scope.kind === "item") {
      events = events.filter(e => e.itemId === scope.itemId).map(e => ({ ...e, series: "actual" }));
    } else if (scope.key !== "all") {
      events = events.filter(e => e.series === scope.key);
    }
    const keys = prodSeries.map(s => s.key);
    let rows = bucketEvents(events, tr.range, keys);

    /* Targets apply to the whole site or to a named product, so they only
       belong on the chart when the scope matches what the target covers. */
    /* A site-wide target means finished output - that is the number a plant
       commits to. It is deliberately NOT drawn against the multi-stage scopes,
       where the bar counts the same material several times and attainment
       would look far better than it is. */
    if (scope.kind === "item") {
      rows = withTargets(rows, data, tr.range.granularity, scope.itemId);
    } else if (scope.key === "finished") {
      rows = withTargets(rows, data, tr.range.granularity);
    } else {
      rows = rows.map(r => ({ ...r, target: "", overTarget: false, attainment: null }));
    }

    const byKey = {};
    batchRows.forEach(r => { byKey[r.key] = r.batches; });
    return rows.map(r => ({ ...r, batchCount: byKey[r.key] || 0 }));
  }, [data, tr.range, scope, prodSeries, batchRows]);

  /* Scheduled quantity, dated by the committed due date. This is a SEPARATE
     measure of the same thing, not another category of output - so it is
     drawn as a reference line. Stacking it on the bar would report
     scheduled-plus-actual as a total, which is meaningless. */
  const pva = useMemo(() => planVsActualEvents(data), [data]);
  const scheduledByBucket = useMemo(() => {
    const relevant = pva.filter(r => {
      if (scope.kind === "item") return r.entry.productId === scope.itemId;
      if (scope.key === "all") return true;
      return r.entry.productType === scope.key;
    });
    const rows = bucketEvents(
      relevant.filter(r => r.plannedDate)
        .map(r => ({ date: r.plannedDate, series: "scheduled", value: r.plannedQty })),
      tr.range, ["scheduled"]);
    const map = {};
    rows.forEach(r => { map[r.key] = r.scheduled; });
    return map;
  }, [pva, tr.range, scope]);

  const prodRowsWithSchedule = useMemo(
    () => prodRows.map(r => ({ ...r, scheduled: scheduledByBucket[r.key] || 0 })),
    [prodRows, scheduledByBucket]);

  /* Completion performance. Only runs with a frozen baseline are counted: an
     unfrozen due date may have been edited to match what happened, which would
     make adherence look perfect for the wrong reason. */
  const completionSeries = [
    { key: "onTime", label: "On or before due date", color: "#2E7D5B" },
    { key: "late", label: "After due date", color: "#A32D2D" }
  ];
  const completions = useMemo(() => orderCompletionEvents(data).map(e => {
    // A run without a frozen baseline cannot be judged: its due date may have
    // been edited after the fact to match what happened.
    const measurable = e.entry.frozen === true && !!e.entry.baselineDueDate;
    const due = e.entry.baselineDueDate || e.entry.dueDate || "";
    return { ...e, measurable, late: measurable && !!due && e.date > due };
  }), [data]);
  const completionRows = useMemo(() => bucketEvents(
    completions.filter(e => e.measurable)
      .map(e => ({ date: e.date, series: e.late ? "late" : "onTime", value: 1 })),
    tr.range, ["onTime", "late"]), [completions, tr.range]);
  const completionOnTime = completionRows.reduce((s, r) => s + r.onTime, 0);
  const completionTotal = completionOnTime + completionRows.reduce((s, r) => s + r.late, 0);
  const completionUnmeasurable = completions.filter(e =>
    !e.measurable && e.date >= tr.range.from && e.date <= tr.range.to).length;

  const batchesInRange = batchRows.reduce((s, r) => s + r.batches, 0);
  const materialInRange = useMemo(() => batches
    .filter(b => b.date >= tr.range.from && b.date <= tr.range.to)
    .reduce((s, b) => s + b.outputCost, 0), [batches, tr.range]);

  const inRange = pva.filter(r =>
    (r.plannedDate >= tr.range.from && r.plannedDate <= tr.range.to) ||
    (r.actualDate && r.actualDate >= tr.range.from && r.actualDate <= tr.range.to));
  const unmeasurable = inRange.filter(r => !r.measurable).length;
  const amended = inRange.filter(r => r.amended > 0).length;
  const anyScheduled = Object.values(scheduledByBucket).some(v => v > 0);

  const flowSeries = [
    { key: "raw", label: "Raw material received", color: "#5FA8A0" },
    { key: "consumed", label: "Raw material consumed", color: "#C08A3E" }
  ];
  const flowRows = useMemo(() => bucketEvents(
    receiptEvents(data).concat(
      consumptionEvents(data).filter(e => e.series === "raw").map(e => ({ ...e, series: "consumed" }))
    ), tr.range, ["raw", "consumed"]), [data, tr.range]);

  const lowStock = data.rawMaterials.filter(r => lotQty(r.lots) <= r.reorderPoint);
  const certIssues = data.rawMaterials.filter(r => r.certStatus === "Expired" || r.certStatus === "Pending review");
  const active = data.schedule.filter(s => s.status === "Planned" || s.status === "In progress");

  const gross = new Map();
  let earliestOverdue = null;
  active.forEach(entry => {
    const totals = explodeToRaw(data, entry.productType, entry.productId, entry.qty);
    totals.forEach((qty, rawId) => gross.set(rawId, (gross.get(rawId) || 0) + qty));
    const { earliestOrderBy } = computeTimeline(data, entry);
    if (earliestOrderBy && daysUntil(earliestOrderBy) < 0) {
      if (!earliestOverdue || earliestOrderBy < earliestOverdue) earliestOverdue = earliestOrderBy;
    }
  });
  let shortageCount = 0;
  gross.forEach((qty, rawId) => {
    const raw = getRaw(data, rawId);
    if (raw && (qty - lotQty(raw.lots) - raw.onOrder) > 0) shortageCount++;
  });

  const totalInvValue = data.rawMaterials.reduce((s, r) => s + lotQty(r.lots) * r.unitCost, 0);

  const equipmentUsageMap = computeEquipmentUsageMap(data, 60);
  let equipmentConflicts = 0;
  data.equipment.forEach(eq => {
    const { conflict } = detectConflicts(equipmentUsageMap.get(eq.id) || [], eq.units || 1);
    if (conflict) equipmentConflicts++;
  });

  let pricingAtRisk = 0;
  data.customers.forEach(c => {
    c.priceList.forEach(p => {
      const fg = getFinished(data, p.finishedGoodId);
      if (!fg) return;
      const info = priceLineMarginInfo(data, p);
      if (info.minMarginPct < 20) pricingAtRisk++;
    });
  });

  const cards = [
    { label: "Raw materials tracked", value: data.rawMaterials.length, icon: Package, tone: "info" },
    { label: "Below reorder point", value: lowStock.length, icon: AlertTriangle, tone: lowStock.length ? "warn" : "good" },
    { label: "Active production runs", value: active.length, icon: Factory, tone: "info" },
    { label: "Materials short vs schedule", value: shortageCount, icon: ShoppingCart, tone: shortageCount ? "bad" : "good" },
    { label: "Equipment conflicts (60d)", value: equipmentConflicts, icon: Wrench, tone: equipmentConflicts ? "bad" : "good" },
    { label: "Pricing at risk", value: pricingAtRisk, icon: DollarSign, tone: pricingAtRisk ? "bad" : "good" }
  ];

  return (
    <div>
      <PageHeader tabKey="dashboard" subtitle="Live snapshot of inventory health and production readiness" />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 22 }}>
        {cards.map((c, i) => {
          const Icon = c.icon;
          const toneColor = { good: "#1F5B3E", warn: "#7A5205", bad: "#8A2E20", info: "#1F5566" }[c.tone];
          return (
            <div key={i} style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, color: toneColor }}>
                <Icon size={16} />
                <span style={{ fontSize: 12, fontWeight: 600, color: "#5B6470" }}>{c.label}</span>
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", color: "#20262B" }}>{c.value}</div>
            </div>
          );
        })}
      </div>

      {earliestOverdue && (
        <div style={{ background: "#F3DBD6", border: "1px solid #E3B9B2", borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, color: "#8A2E20", fontSize: 13.5 }}>
          <AlertTriangle size={17} />
          Some purchase orders needed to hit the current schedule are already past their order-by date. Open <a onClick={() => setTab("forecast")} style={{ color: "#8A2E20", fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}>MRP forecast</a> to see which materials.
        </div>
      )}

      {equipmentConflicts > 0 && (
        <div style={{ background: "#F6E6C8", border: "1px solid #E8CFA0", borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 10, color: "#7A5205", fontSize: 13.5 }}>
          <Wrench size={17} />
          {equipmentConflicts} piece{equipmentConflicts === 1 ? "" : "s"} of equipment {equipmentConflicts === 1 ? "has" : "have"} overlapping demand (including maintenance) in the next 60 days. Open <a onClick={() => setTab("utilization")} style={{ color: "#7A5205", fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}>Equipment utilization</a> to see the conflicting runs.
        </div>
      )}

      {pricingAtRisk > 0 && (
        <div style={{ background: "#F3DBD6", border: "1px solid #E3B9B2", borderRadius: 10, padding: "12px 16px", marginBottom: 20, display: "flex", alignItems: "center", gap: 10, color: "#8A2E20", fontSize: 13.5 }}>
          <DollarSign size={17} />
          {pricingAtRisk} customer price point{pricingAtRisk === 1 ? "" : "s"} {pricingAtRisk === 1 ? "is" : "are"} close to or below modeled COGS. Open <a onClick={() => setTab("customers")} style={{ color: "#8A2E20", fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}>Customers</a> to review.
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
        <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Materials below reorder point</div>
          {lowStock.length === 0 && <div style={{ fontSize: 13, color: "#7A8079" }}>Everything is stocked above its reorder point.</div>}
          {lowStock.slice(0, 6).map(r => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #EEF0EA" }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "#8A9099" }}>{r.sku} · lead time {r.leadTimeDays}d</div>
              </div>
              <Badge tone="warn">{fmtNum(lotQty(r.lots))} / {fmtNum(r.reorderPoint)} {r.unit}</Badge>
            </div>
          ))}
        </div>

        <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Certification flags</div>
          {certIssues.length === 0 && <div style={{ fontSize: 13, color: "#7A8079" }}>No open certification issues.</div>}
          {certIssues.map(r => (
            <div key={r.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "7px 0", borderBottom: "1px solid #EEF0EA" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</div>
              <Badge tone={r.certStatus === "Expired" ? "bad" : "warn"}>{r.certStatus}</Badge>
            </div>
          ))}
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #EEF0EA" }}>
            <div style={{ fontSize: 12, color: "#5B6470", fontWeight: 600, marginBottom: 4 }}>Raw material inventory value on hand</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace" }}>{fmtMoney(totalInvValue)}</div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                    marginTop: 24, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>History</div>
        <TimeRangeControls state={tr} />
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4 }}>
          {[["finished", "Finished goods"], ["intermediate", "Intermediate products"], ["all", "Everything"]]
            .map(([k, label]) => (
              <div key={k} role="button" tabIndex={0}
                onClick={() => setProdScope(k)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setProdScope(k); } }}
                style={{
                  padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer", borderRadius: 6,
                  background: prodScope === k ? "#1F6F78" : "#fff",
                  color: prodScope === k ? "#fff" : "#5B6470",
                  border: "1px solid " + (prodScope === k ? "#1F6F78" : "#D7DAD3")
                }}>
                {label}
              </div>
            ))}
        </div>
        <select style={{ ...inputStyle, width: 232 }}
          value={scope.kind === "item" ? prodScope : ""}
          onChange={e => { if (e.target.value) setProdScope(e.target.value); }}>
          <option value="">A single product\u2026</option>
          <optgroup label="Finished goods">
            {scopeOptions.filter(o => o.kind === "item" && o.itemType === "finished").map(o =>
              <option key={o.key} value={o.key}>{o.label}</option>)}
          </optgroup>
          <optgroup label="Intermediate products">
            {scopeOptions.filter(o => o.kind === "item" && o.itemType === "intermediate").map(o =>
              <option key={o.key} value={o.key}>{o.label}</option>)}
          </optgroup>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12,
                        color: scheduleUsable ? "#5B6470" : "#A6ACA5",
                        cursor: scheduleUsable ? "pointer" : "not-allowed" }}
               title={scheduleUsable
                 ? "Draws the scheduled quantity as a line across each period. A separate measure of the same output, so it is never added to the bar."
                 : "Not available for this selection \u2014 see the note under the chart."}>
          <input type="checkbox" checked={showScheduled && scheduleUsable}
            disabled={!scheduleUsable}
            onChange={e => setShowScheduled(e.target.checked)} />
          Show scheduled output
        </label>
      </div>

      <ChartCard
        title={"Production output \u2014 " + scope.label}
        subtitle={"Quantity produced, by the date each lot was made. The figure above each bar is the number of batches run."
          + (multiStage ? " Counts material at every stage it passes through." : "")}
        rows={showScheduled && scheduleUsable ? prodRowsWithSchedule : prodRows}
        series={prodSeries} showLine targetKey="target"
        limitKey={showScheduled && scheduleUsable ? "scheduled" : undefined}
        limitLabel="Scheduled" limitColor="#55636F"
        barLabelKey="batchCount" barLabelSuffix=" runs"
        emptyMessage="Nothing was produced in this period"
        action={<Btn variant="secondary" onClick={onEditTargets}
                     style={{ padding: "5px 10px", fontSize: 12 }}>Set targets</Btn>}
        footer={
          <div style={{ fontSize: 12, color: "#7A8079", marginTop: 8 }}>
            <b>{batchesInRange}</b> batch record(s) in this range, {fmtMoney(materialInRange)} of
            material through them.{" "}
            {prodRows.some(r => r.target !== "")
              ? prodRows.filter(r => r.target !== "" && r.overTarget).length + " of " +
                prodRows.filter(r => r.target !== "").length + " period(s) with a target met it. "
              : multiStage
                ? "Targets are not drawn against a multi-stage total \u2014 attainment would look "
                  + "better than it is. Switch to \u201cFinished goods\u201d or a single product. "
                : "No target set for this selection \u2014 use \u201cSet targets\u201d to add one. "}
            {multiStage && (
              <span style={{ color: "#8C6B45" }}>
                {scope.key === "intermediate"
                  ? "This total counts the same coffee at every stage \u2014 sorted, then roasted, then ground, then extracted \u2014 so it is throughput across the chain, not tonnes made. "
                  : "This total adds kilogrammes and unit counts together, and counts intermediates at every stage they pass through. "}
                A scheduled comparison would be meaningless against it, so the line is unavailable here.
                Pick <b>Finished goods</b> or a single product for a figure you can hold a schedule against.{" "}
              </span>
            )}
            {!multiStage && scheduleCoverage.none && (
              <span style={{ color: "#8C6B45" }}>
                Nothing in this selection is scheduled, so there is no line to compare against.{" "}
              </span>
            )}
            {!multiStage && scheduleCoverage.partial && showScheduled && (
              <span style={{ color: "#8C6B45" }}>
                Only {scheduleCoverage.covered} of {scheduleCoverage.total} products here are
                scheduled, so the line covers part of the bar.{" "}
              </span>
            )}
            {showScheduled && scheduleUsable && !anyScheduled &&
              "No scheduled quantity falls in this date range. "}
            {showScheduled && scheduleUsable && anyScheduled && unmeasurable > 0 && (
              <span style={{ color: "#A32D2D" }}>
                {unmeasurable} run(s) here were never frozen, so their scheduled figure may have
                been edited after the fact and adherence cannot be trusted.{" "}
              </span>
            )}
            {showScheduled && scheduleUsable && anyScheduled && amended > 0 &&
              amended + " frozen run(s) carry recorded amendments."}
          </div>
        } />

      <ChartCard
        title="Completions against due date"
        subtitle="Runs completed in each period, split by whether they made their committed date. Only frozen runs are counted \u2014 an unfrozen due date may have been moved to match."
        rows={completionRows} series={completionSeries}
        emptyMessage="No runs were completed in this period"
        footer={
          <div style={{ fontSize: 12, color: "#7A8079", marginTop: 8 }}>
            {completionTotal > 0
              ? Math.round((completionOnTime / completionTotal) * 100) + "% of " +
                completionTotal + " completed run(s) hit their date."
              : "No completed runs in this range."}
            {completionUnmeasurable > 0 &&
              " " + completionUnmeasurable + " completion(s) excluded as the run was never frozen."}
          </div>
        } />
      <ChartCard
        title="Raw material flow"
        subtitle="Received against consumed — consumption is dated from the batch that drew it"
        rows={flowRows} series={flowSeries}
        emptyMessage="No raw material movement in this period" />
    </div>
  );
}

function PageHeader({ tabKey, title, subtitle, action }) {
  // `title` is an intentional override for components reused under more
  // than one nav entry; otherwise the heading comes from the nav model.
  const heading = title || navLabelForTab(tabKey);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18 }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#20262B" }}>{heading}</div>
        {subtitle && <div style={{ fontSize: 13, color: "#7A8079", marginTop: 2 }}>{subtitle}</div>}
      </div>
      {action}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }) {
  return (
    <div style={{ position: "relative", width: 240 }}>
      <Search size={14} style={{ position: "absolute", left: 9, top: 10, color: "#9BA19A" }} />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder || "Search…"}
        style={{ ...inputStyle, paddingLeft: 30 }} />
    </div>
  );
}

/* ---------------------------------------------------------------
   Raw Materials Tab (admin)
----------------------------------------------------------------*/
function RawMaterialsTab({ data, search, setSearch, onAdd, onEdit, onDelete, onInventory }) {
  const rows = data.rawMaterials.filter(r =>
    !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.sku.toLowerCase().includes(search.toLowerCase()) || r.supplier.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div>
      <PageHeader tabKey="materials" subtitle="Supplier, cost, certification, lead-time and lot-level detail for every input material"
        action={<div style={{ display: "flex", gap: 10 }}><SearchBox value={search} onChange={setSearch} placeholder="Search materials…" /><Btn onClick={onAdd}><Plus size={15} />Add material</Btn></div>} />
      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, overflow: "hidden" }}>
        <table className="mrp-table">
          <thead>
            <tr>
              <th>Material</th><th>Supplier</th><th>Unit cost</th><th>Certification</th><th>Lead time</th><th>Stock (lots)</th><th>Reorder pt</th><th>On order</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const stock = lotQty(r.lots);
              const low = stock <= r.reorderPoint;
              return (
                <tr key={r.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: "#8A9099" }}>{r.sku}</div>
                    <CompositionBadges composition={r.composition} data={data} />
                  </td>
                  <td>{r.supplier || "—"}</td>
                  <td className="mono">{fmtMoney(r.unitCost)}/{r.unit}</td>
                  <td><Badge tone={r.certStatus === "Certified" ? "good" : r.certStatus === "Expired" ? "bad" : r.certStatus === "Pending review" ? "warn" : "neutral"}>{r.certStatus}</Badge></td>
                  <td className="mono">{r.leadTimeDays}d</td>
                  <td className="mono">{fmtNum(stock)} {r.unit} <span style={{ color: "#A6ABA2" }}>({(r.lots || []).length})</span></td>
                  <td className="mono">{fmtNum(r.reorderPoint)}</td>
                  <td className="mono">{fmtNum(r.onOrder)}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      {low && <span title="Below reorder point" style={{ color: "#B87510", display: "flex", alignItems: "center" }}><AlertTriangle size={15} /></span>}
                      <IconBtn onClick={() => onInventory(r.id)} title="Inventory card"><Boxes size={13} /></IconBtn>
                      <IconBtn onClick={() => onEdit(r.id)} title="Edit"><Pencil size={13} /></IconBtn>
                      <IconBtn onClick={() => onDelete(r.id)} title="Delete" danger><Trash2 size={13} /></IconBtn>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={9} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>No raw materials match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Warehouse cataloging (Phase 3) — the storage attributes and
   packaging variants that make a catalog item physically slottable.
   Shared by all four catalog modals.
----------------------------------------------------------------*/
const PACKAGE_TYPES = ["drum", "tote", "barrel", "jug", "pail", "sack", "bag", "box", "case", "pallet", "each"];

// Editor for an item's packaging variants. Each is a distinct storable SKU the
// warehouse slots and counts (a 1 gal jug and a 2.5 gal jug are different stock
// units); packagesPerSlot is its footprint. A lot points at one via packagingId.
function PackagingsEditor({ packagings, onChange, itemSku }) {
  const list = Array.isArray(packagings) ? packagings : [];
  const patch = (i, k, v) => onChange(list.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const add = () => onChange([...list, {
    id: uid(),
    sku: itemSku ? itemSku + "-" + (list.length + 1) : "",
    packageType: "drum", size: "", unitsPerPackage: 1, packagesPerSlot: 1,
    isDefault: list.length === 0
  }]);
  const remove = (i) => {
    const next = list.filter((_, j) => j !== i);
    if (next.length && !next.some(p => p.isDefault)) next[0] = { ...next[0], isDefault: true };
    onChange(next);
  };
  const setDefault = (i) => onChange(list.map((p, j) => ({ ...p, isDefault: j === i })));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>Packaging / storable SKUs</div>
        <Btn variant="secondary" onClick={add}><Plus size={14} />Add packaging</Btn>
      </div>
      <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
        Each packaging is a distinct stock unit the warehouse slots and counts
        (for example a 1 gal jug versus a 2.5 gal jug). Packages per slot is its footprint.
      </div>
      {list.length === 0 && (
        <div style={{ fontSize: 12, color: "#B87510", marginBottom: 8 }}>
          No packaging defined yet. The warehouse cannot catalog this item until at least one is added.
        </div>
      )}
      {list.map((p, i) => (
        <div key={p.id || i} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 0.9fr 0.9fr auto auto", gap: 8, alignItems: "end", marginBottom: 8 }}>
          <Field label="SKU"><input style={inputStyle} value={p.sku || ""} onChange={e => patch(i, "sku", e.target.value)} placeholder="SSB-1GAL" /></Field>
          <Field label="Container">
            <select style={inputStyle} value={p.packageType || "drum"} onChange={e => patch(i, "packageType", e.target.value)}>
              {PACKAGE_TYPES.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          <Field label="Size"><input style={inputStyle} value={p.size || ""} onChange={e => patch(i, "size", e.target.value)} placeholder="1 gal" /></Field>
          <Field label="Units/pkg"><input type="number" style={inputStyle} value={p.unitsPerPackage ?? 1} onChange={e => patch(i, "unitsPerPackage", parseFloat(e.target.value) || 0)} /></Field>
          <Field label="Pkgs/slot"><input type="number" style={inputStyle} value={p.packagesPerSlot ?? 1} onChange={e => patch(i, "packagesPerSlot", parseFloat(e.target.value) || 0)} /></Field>
          <Field label="Default"><input type="radio" checked={!!p.isDefault} onChange={() => setDefault(i)} style={{ height: 20 }} /></Field>
          <IconBtn title="Remove packaging" onClick={() => remove(i)}><Trash2 size={14} /></IconBtn>
        </div>
      ))}
    </div>
  );
}

// The "Warehouse cataloging" section dropped into each catalog modal: storage
// attributes plus the packaging editor. showHazard is true only for raw
// materials, whose top grid does not already carry a hazard select.
function CatalogWarehouseSection({ f, set, showHazard }) {
  return (
    <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14, marginBottom: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Warehouse cataloging</div>
      <div style={{ display: "grid", gridTemplateColumns: showHazard ? "1fr 1fr 1fr" : "1fr 1fr", gap: 12, marginBottom: 14 }}>
        <Field label="Shelf life (days)" hint="Sets each lot's expiry: production date plus shelf life">
          <input type="number" style={inputStyle} value={f.shelfLifeDays ?? ""} onChange={e => set("shelfLifeDays", e.target.value === "" ? null : (parseInt(e.target.value) || 0))} placeholder="e.g. 365" />
        </Field>
        <Field label="Physically stored" hint="Whether this item occupies a warehouse slot">
          <label style={{ display: "flex", alignItems: "center", gap: 8, height: 38, cursor: "pointer" }}>
            <input type="checkbox" checked={f.physicallyStored !== false} onChange={e => set("physicallyStored", e.target.checked)} />
            <span style={{ fontSize: 12.5, color: "#51635a" }}>Slot this item</span>
          </label>
        </Field>
        {showHazard && (
          <Field label="Hazard classification">
            <select style={inputStyle} value={f.hazardClass || "N/A"} onChange={e => set("hazardClass", e.target.value)}>
              {HAZARD_CLASS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
        )}
      </div>
      <PackagingsEditor packagings={f.packagings} onChange={(p) => set("packagings", p)} itemSku={f.sku} />
    </div>
  );
}

function RawMaterialModal({ data, id, onClose, update }) {
  const existing = id ? getRaw(data, id) : null;
  const [f, setF] = useState(existing ? structuredClone(existing) : {
    name: "", sku: "", supplier: "", unitCost: 0, unit: "ea", certStatus: "Not required",
    leadTimeDays: 7, moq: 1, reorderPoint: 0, onOrder: 0, notes: "", composition: [], lots: [],
    hazardClass: "N/A", shelfLifeDays: null, physicallyStored: true, packagings: []
  });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const save = () => {
    if (!f.name.trim()) return;
    update(d => repo.upsert(d, "rawMaterials", existing ? id : null, { ...f }));
    onClose();
  };

  return (
    <Modal title={existing ? "Edit raw material" : "Add raw material"} onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <Field label="Material name" span={2}><input style={inputStyle} value={f.name} onChange={e => set("name", e.target.value)} placeholder="e.g. 6061 aluminum tube stock" /></Field>
        <Field label="SKU / part number"><input style={inputStyle} value={f.sku} onChange={e => set("sku", e.target.value)} placeholder="RM-0001" /></Field>
        <Field label="Supplier"><input style={inputStyle} value={f.supplier} onChange={e => set("supplier", e.target.value)} placeholder="Supplier name" /></Field>
        <Field label="Unit cost (USD)" hint="Purchase price — authoritative even if composition is defined below"><input type="number" step="0.01" style={inputStyle} value={f.unitCost} onChange={e => set("unitCost", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Unit of measure"><input style={inputStyle} value={f.unit} onChange={e => set("unit", e.target.value)} placeholder="ea, kg, m, set…" /></Field>
        <Field label="Certification status">
          <select style={inputStyle} value={f.certStatus} onChange={e => set("certStatus", e.target.value)}>
            {CERT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Lead time (days)"><input type="number" style={inputStyle} value={f.leadTimeDays} onChange={e => set("leadTimeDays", parseInt(e.target.value) || 0)} /></Field>
        <Field label="Minimum order quantity"><input type="number" style={inputStyle} value={f.moq} onChange={e => set("moq", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Reorder point"><input type="number" style={inputStyle} value={f.reorderPoint} onChange={e => set("reorderPoint", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Quantity currently on order"><input type="number" style={inputStyle} value={f.onOrder} onChange={e => set("onOrder", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Notes" span={2}><textarea style={{ ...inputStyle, minHeight: 50, resize: "vertical" }} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Certifications on file, handling notes, alternate suppliers…" /></Field>
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14, marginBottom: 16 }}>
        <CompositionEditor composition={f.composition} onChange={(c) => set("composition", c)} componentOptions={data.components} data={data} />
      </div>

      <CatalogWarehouseSection f={f} set={set} showHazard={true} />

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Lots on hand</div>
        <LotsEditor lots={f.lots} onChange={(lots) => set("lots", lots)} packagings={f.packagings} shelfLifeDays={f.shelfLifeDays} unit={f.unit}dateLabel="Received" qcComponents={qcComponentCandidates(data, f.composition)} data={data} itemType="raw" itemId={id} update={update} />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>{existing ? "Save changes" : "Add material"}</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Intermediate Products (catalog)
----------------------------------------------------------------*/
function ProducedItemsTable({ rows, data, itemType, onEdit, onDelete, onInventory, emptyMessage, unitLabel }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, overflow: "hidden" }}>
      <table className="mrp-table">
        <thead>
          <tr><th>{unitLabel}</th><th>Produced by</th><th>Unit cost</th><th>Hazard</th><th>Stock (lots)</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map(item => {
            const stock = lotQty(item.lots);
            const unitCost = computeItemUnitCost(data, itemType, item.id);
            const producer = findProcessForOutput(data, itemType, item.id);
            const composition = computeEffectiveComposition(data, itemType, item.id);
            return (
              <tr key={item.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{item.name}</div>
                  <div className="mono" style={{ fontSize: 11, color: "#8A9099" }}>{item.sku}</div>
                  <CompositionBadges composition={composition} data={data} />
                </td>
                <td>{producer ? producer.name : <span style={{ color: "#B87510" }}>None</span>}</td>
                <td className="mono">{fmtMoney(unitCost)}/{item.unit}</td>
                <td><Badge tone={item.hazardClass && item.hazardClass !== "N/A" ? "bad" : "neutral"}>{item.hazardClass || "N/A"}</Badge></td>
                <td className="mono">{fmtNum(stock)} {item.unit} <span style={{ color: "#A6ABA2" }}>({(item.lots || []).length})</span></td>
                <td>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <IconBtn onClick={() => onInventory(item.id)} title="Inventory card"><Boxes size={13} /></IconBtn>
                    <IconBtn onClick={() => onEdit(item.id)} title="Edit"><Pencil size={13} /></IconBtn>
                    <IconBtn onClick={() => onDelete(item.id)} title="Delete" danger><Trash2 size={13} /></IconBtn>
                  </div>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>{emptyMessage}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function IntermediateProductsTab({ data, search, setSearch, onAdd, onEdit, onDelete, onInventory }) {
  const rows = data.intermediateProducts.filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()) || i.sku.toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <PageHeader tabKey="intermediateProducts" subtitle="Sub-assembly catalog and stock — recipes live on the Processes tab"
        action={<div style={{ display: "flex", gap: 10 }}><SearchBox value={search} onChange={setSearch} placeholder="Search intermediate products…" /><Btn onClick={onAdd}><Plus size={15} />Add intermediate product</Btn></div>} />
      <ProducedItemsTable rows={rows} data={data} itemType="intermediate" onEdit={onEdit} onDelete={onDelete} onInventory={onInventory} emptyMessage="No intermediate products yet." unitLabel="Sub-assembly" />
    </div>
  );
}

// Read-only inventory detail view for a raw material, intermediate
// product, or finished good - reached via the "Inventory" button on any
// of their tables, without needing to open the edit form.
function InventoryCardModal({ data, itemType, itemId, onClose, update }) {
  const item = getCatalogItem(data, itemType, itemId);
  const [detailLotId, setDetailLotId] = useState(null);
  const [consumeLotId, setConsumeLotId] = useState(null);
  if (!item) return null;
  const stock = lotQty(item.lots);
  const unitCost = computeItemUnitCost(data, itemType, item.id);
  /* Standard cost answers "what would this cost to make today". Actual is the
     weighted cost of the lots genuinely on the shelf, at the prices those lots
     were bought at - the figure to value stock by, and the one that does not
     move when a supplier raises a price. */
  const actual = itemActualUnitCost(data, itemType, item.id);
  const producer = itemType !== "raw" ? findProcessForOutput(data, itemType, item.id) : null;
  const composition = computeEffectiveComposition(data, itemType, item.id);
  const balances = computeCompositionBalances(item, itemType, data);
  const qcComponents = qcComponentCandidates(data, composition);
  const detailLot = detailLotId ? (item.lots || []).find(l => l.id === detailLotId) : null;
  const consumeLot = consumeLotId ? (item.lots || []).find(l => l.id === consumeLotId) : null;

  const saveLot = (patch) => {
    update(d => repo.patchItemLot(d, itemType, itemId, detailLotId, patch));
    setDetailLotId(null);
  };

  return (
    <Modal title="Inventory card" onClose={onClose} wide>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{item.name}</div>
          <div className="mono" style={{ fontSize: 12, color: "#8A9099", marginTop: 2 }}>{item.sku}</div>
        </div>
        {itemType !== "raw" && <Badge tone={item.hazardClass && item.hazardClass !== "N/A" ? "bad" : "neutral"}>{item.hazardClass || "N/A"}</Badge>}
        {itemType === "raw" && <Badge tone={item.certStatus === "Certified" ? "good" : item.certStatus === "Expired" ? "bad" : item.certStatus === "Pending review" ? "warn" : "neutral"}>{item.certStatus}</Badge>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 16 }}>
        <MiniStat label="Stock on hand" value={fmtNum(stock) + " " + item.unit} />
        <MiniStat label="Lots" value={(item.lots || []).length} />
        <MiniStat label="Standard unit cost" value={fmtMoney(unitCost)} />
        {actual && (
          <MiniStat label="Actual unit cost"
            value={fmtMoney(actual.unitCost) + (actual.estimated ? " est" : "")}
            tone={actual.unitCost > unitCost ? "bad" : "good"} />
        )}
        {actual && (
          <MiniStat label="Stock at actual cost" value={fmtMoney(actual.stockValue)} />
        )}
      </div>

      {itemType === "raw" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 16, fontSize: 12.5 }}>
          <div><span style={{ color: "#8A9099" }}>Supplier: </span>{item.supplier || "—"}</div>
          <div><span style={{ color: "#8A9099" }}>Lead time: </span>{item.leadTimeDays}d</div>
          <div><span style={{ color: "#8A9099" }}>MOQ: </span>{fmtNum(item.moq)}</div>
          <div><span style={{ color: "#8A9099" }}>Reorder point: </span>{fmtNum(item.reorderPoint)}</div>
          <div><span style={{ color: "#8A9099" }}>On order: </span>{fmtNum(item.onOrder)}</div>
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: producer ? "#5B6470" : "#B87510", marginBottom: 16 }}>
          {producer ? "Produced by: " + producer.name : "No process produces this item yet"}
        </div>
      )}

      {composition.length > 0 && (
        <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Composition</div>
          <CompositionBadges composition={composition} data={data} />
        </div>
      )}

      {balances.length > 0 && (
        <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Composition balance</div>
          {balances.map((b, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "3px 0" }}>
              <span>{b.component.name}</span>
              <span className="mono" style={{ color: "#5B6470" }}>{fmtNum(b.qty)} {b.component.unit}-equiv. · {fmtMoney(b.value)}</span>
            </div>
          ))}
        </div>
      )}

      {item.notes && <div style={{ fontSize: 12.5, color: "#7A8079", fontStyle: "italic", borderTop: "1px solid #EEF0EA", paddingTop: 12, marginBottom: 12 }}>{item.notes}</div>}

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Available lots</div>
        <LotsTable lots={item.lots || []} unit={item.unit} dateLabel={itemType === "raw" ? "Received" : "Recorded"} onRowClick={setDetailLotId} showRemove={false} onConsume={setConsumeLotId} />
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
      </div>

      {detailLot && (
        <LotDetailModal
          data={data} itemType={itemType} itemId={itemId}
          lot={detailLot} unit={item.unit} dateLabel={itemType === "raw" ? "Received" : "Recorded"} qcComponents={qcComponents}
          onSave={saveLot}
          onClose={() => setDetailLotId(null)}
        />
      )}
      {consumeLot && (
        <ConsumeLotModal data={data} itemType={itemType} itemId={itemId} lot={consumeLot} update={update} onClose={() => setConsumeLotId(null)} />
      )}
    </Modal>
  );
}

function IntermediateProductModal({ data, id, onClose, update }) {
  const existing = id ? getIntermediateProduct(data, id) : null;
  const [f, setF] = useState(existing ? structuredClone(existing) : { name: "", sku: "", unit: "ea", notes: "", composition: [], autoComposition: false, hazardClass: "N/A", lots: [], shelfLifeDays: null, physicallyStored: true, packagings: [] });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const save = () => {
    if (!f.name.trim()) return;
    const cleaned = { ...f, composition: stripCostAllocation(f.composition) };
    update(d => repo.upsert(d, "intermediateProducts", existing ? id : null, cleaned));
    onClose();
  };

  return (
    <Modal title={existing ? "Edit intermediate product" : "Add intermediate product"} onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <Field label="Name" span={2}><input style={inputStyle} value={f.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Standard frame, welded + coated" /></Field>
        <Field label="SKU"><input style={inputStyle} value={f.sku} onChange={e => set("sku", e.target.value)} placeholder="IM-0001" /></Field>
        <Field label="Unit of measure"><input style={inputStyle} value={f.unit} onChange={e => set("unit", e.target.value)} placeholder="ea, set, kg…" /></Field>
        <Field label="Hazard classification">
          <select style={inputStyle} value={f.hazardClass} onChange={e => set("hazardClass", e.target.value)}>
            {HAZARD_CLASS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Notes" span={2}><input style={inputStyle} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Notes" /></Field>
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14, marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={f.autoComposition} onChange={e => set("autoComposition", e.target.checked)} />
          <span style={{ fontWeight: 700, fontSize: 13 }}>Calculate composition automatically from the process recipe</span>
        </label>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          Rolls up the composition of everything this item's process consumes, weighted by each input's cost contribution. Uncheck to enter composition by hand instead.
        </div>
        {f.autoComposition
          ? <ComputedCompositionView itemType="intermediate" itemId={id} data={data} />
          : <CompositionEditor composition={f.composition} onChange={(c) => set("composition", c)} componentOptions={data.components} data={data} showCostWeight={false} />}
      </div>

      <CatalogWarehouseSection f={f} set={set} showHazard={false} />

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Lots on hand</div>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          For manual stock corrections. To log a real production batch with sourcing and actual time, use "Log batch" from the Processes tab instead.
        </div>
        <LotsEditor lots={f.lots} onChange={(lots) => set("lots", lots)} packagings={f.packagings} shelfLifeDays={f.shelfLifeDays} unit={f.unit}dateLabel="Recorded" qcComponents={qcComponentCandidates(data, f.autoComposition ? computeEffectiveComposition(data, "intermediate", id) : f.composition)} data={data} itemType="intermediate" itemId={id} update={update} />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>{existing ? "Save changes" : "Add intermediate product"}</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Finished Goods (catalog)
----------------------------------------------------------------*/
function FinishedGoodsTab({ data, search, setSearch, onAdd, onEdit, onDelete, onInventory }) {
  const rows = data.finishedGoods.filter(f => !search || f.name.toLowerCase().includes(search.toLowerCase()) || f.sku.toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <PageHeader tabKey="finished" subtitle="Sellable-item catalog and stock — recipes live on the Processes tab"
        action={<div style={{ display: "flex", gap: 10 }}><SearchBox value={search} onChange={setSearch} placeholder="Search finished goods…" /><Btn onClick={onAdd}><Plus size={15} />Add finished good</Btn></div>} />
      <ProducedItemsTable rows={rows} data={data} itemType="finished" onEdit={onEdit} onDelete={onDelete} onInventory={onInventory} emptyMessage="No finished goods yet." unitLabel="Product" />
    </div>
  );
}

function FinishedGoodModal({ data, id, onClose, update }) {
  const existing = id ? getFinished(data, id) : null;
  const [f, setF] = useState(existing ? structuredClone(existing) : { name: "", sku: "", unit: "ea", notes: "", composition: [], autoComposition: false, hazardClass: "N/A", lots: [], shelfLifeDays: null, physicallyStored: true, packagings: [] });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const save = () => {
    if (!f.name.trim()) return;
    const cleaned = { ...f, composition: stripCostAllocation(f.composition) };
    update(d => repo.upsert(d, "finishedGoods", existing ? id : null, cleaned));
    onClose();
  };

  return (
    <Modal title={existing ? "Edit finished good" : "Add finished good"} onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <Field label="Name" span={2}><input style={inputStyle} value={f.name} onChange={e => set("name", e.target.value)} placeholder="Product name" /></Field>
        <Field label="SKU"><input style={inputStyle} value={f.sku} onChange={e => set("sku", e.target.value)} placeholder="FG-0001" /></Field>
        <Field label="Unit of measure"><input style={inputStyle} value={f.unit} onChange={e => set("unit", e.target.value)} placeholder="ea, pallet, case…" /></Field>
        <Field label="Hazard classification">
          <select style={inputStyle} value={f.hazardClass} onChange={e => set("hazardClass", e.target.value)}>
            {HAZARD_CLASS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Notes" span={2}><input style={inputStyle} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Notes" /></Field>
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14, marginBottom: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={f.autoComposition} onChange={e => set("autoComposition", e.target.checked)} />
          <span style={{ fontWeight: 700, fontSize: 13 }}>Calculate composition automatically from the process recipe</span>
        </label>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          Rolls up the composition of everything this item's process consumes, weighted by each input's cost contribution. Uncheck to enter composition by hand instead.
        </div>
        {f.autoComposition
          ? <ComputedCompositionView itemType="finished" itemId={id} data={data} />
          : <CompositionEditor composition={f.composition} onChange={(c) => set("composition", c)} componentOptions={data.components} data={data} showCostWeight={false} />}
      </div>

      <CatalogWarehouseSection f={f} set={set} showHazard={false} />

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Lots on hand</div>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          For manual stock corrections. To log a real production or repackaging batch with sourcing and actual time, use "Log batch" from the Processes tab instead.
        </div>
        <LotsEditor lots={f.lots} onChange={(lots) => set("lots", lots)} packagings={f.packagings} shelfLifeDays={f.shelfLifeDays} unit={f.unit}dateLabel="Recorded" qcComponents={qcComponentCandidates(data, f.autoComposition ? computeEffectiveComposition(data, "finished", id) : f.composition)} data={data} itemType="finished" itemId={id} update={update} />
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>{existing ? "Save changes" : "Add finished good"}</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Processes (recipes: typed inputs -> equipment -> typed outputs)
----------------------------------------------------------------*/
function ProcessesTab({ data, search, setSearch, onAdd, onEdit, onDelete, onLogBatch }) {
  const rows = data.processes.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <PageHeader tabKey="processes" subtitle="Batch production recipes: raw materials, intermediate products or finished goods in; equipment time; intermediate products or finished goods out"
        action={<div style={{ display: "flex", gap: 10 }}><SearchBox value={search} onChange={setSearch} placeholder="Search processes…" /><Btn onClick={onAdd}><Plus size={15} />Add process</Btn></div>} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {rows.map(p => (
          <ProcessCard key={p.id} process={p} data={data} onEdit={() => onEdit(p.id)} onDelete={() => onDelete(p.id)} onLogBatch={() => onLogBatch(p.id)} />
        ))}
        {rows.length === 0 && <div style={{ color: "#8A9099", padding: 24 }}>No processes yet.</div>}
      </div>
    </div>
  );
}

function ProcessCard({ process, data, onEdit, onDelete, onLogBatch }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{process.name}</div>
          <div className="mono" style={{ fontSize: 11, color: "#8A9099", marginTop: 2 }}>{process.sku}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <Btn variant="secondary" onClick={onLogBatch} style={{ padding: "6px 10px", fontSize: 12 }}><Plus size={13} />Log batch</Btn>
          <IconBtn onClick={onEdit} title="Edit"><Pencil size={13} /></IconBtn>
          <IconBtn onClick={onDelete} title="Delete" danger><Trash2 size={13} /></IconBtn>
        </div>
      </div>

      <div style={{ margin: "10px 0", fontSize: 12 }}>
        <span style={{ color: "#8A9099" }}>Batch time: </span><span className="mono" style={{ fontWeight: 600 }}>{fmtNum(process.productionTimeHours)}h</span>
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 10, marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Inputs (per batch)</div>
        {process.inputs.map((line, idx) => {
          const item = getCatalogItem(data, line.itemType, line.itemId);
          if (!item) return null;
          return (
            <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                {line.itemType === "finished" ? <Boxes size={11} color="#1F6F78" /> : line.itemType === "intermediate" ? <Layers size={11} color="#1F6F78" /> : <Package size={11} color="#8A9099" />}
                {item.name}
              </span>
              <span className="mono" style={{ color: "#5B6470" }}>{fmtNum(line.qty)} {item.unit}</span>
            </div>
          );
        })}
        {process.inputs.length === 0 && <div style={{ fontSize: 12, color: "#8A9099" }}>No inputs added.</div>}
      </div>

      {(process.equipment || []).length > 0 && (
        <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Equipment used</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {process.equipment.map((eqLine, idx) => {
              const item = getEquipment(data, eqLine.equipmentId);
              if (!item) return null;
              return <Badge key={idx} tone={eqLine.status === "In-Use" ? "info" : "warn"}>{item.name} · {eqLine.status}</Badge>;
            })}
          </div>
        </div>
      )}

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
          Outputs {process.outputs.length > 1 ? "(" + process.outputs.length + " streams)" : ""}
        </div>
        {process.outputs.map((o, idx) => {
          const item = getCatalogItem(data, o.itemType, o.itemId);
          if (!item) return null;
          const unitCost = computeItemUnitCost(data, o.itemType, o.itemId);
          return (
            <div key={idx} style={{ padding: "6px 0", borderBottom: idx < process.outputs.length - 1 ? "1px dashed #EEF0EA" : "none" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                    {item.name} <Badge tone={o.itemType === "finished" ? "good" : "info"}>{o.itemType}</Badge>
                  </div>
                  <div className="mono" style={{ fontSize: 10.5, color: "#8A9099" }}>yields {fmtNum(o.qtyPerBatch)} {item.unit} / batch · est. {fmtMoney(unitCost)}/{item.unit}</div>
                </div>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{fmtNum(lotQty(item.lots))} {item.unit} on hand</span>
              </div>
            </div>
          );
        })}
        {process.outputs.length === 0 && <div style={{ fontSize: 12, color: "#B87510" }}>No outputs defined.</div>}
      </div>

      {process.notes && <div style={{ fontSize: 12, color: "#7A8079", marginTop: 10, fontStyle: "italic" }}>{process.notes}</div>}
    </div>
  );
}

function ProcessModal({ data, id, onClose, update }) {
  const existing = id ? getProcess(data, id) : null;
  const [f, setF] = useState(existing ? structuredClone(existing) : {
    name: "", sku: "", productionTimeHours: 24, notes: "", inputs: [], equipment: [], outputs: []
  });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const inputOptions = allCatalogOptions(data, true);

  const addInput = () => {
    if (inputOptions.length === 0) return;
    const first = inputOptions[0];
    setF(prev => ({ ...prev, inputs: [...prev.inputs, { itemType: first.itemType, itemId: first.itemId, qty: 1 }] }));
  };
  const updateInput = (idx, patch) => setF(prev => ({ ...prev, inputs: prev.inputs.map((l, i) => i === idx ? { ...l, ...patch } : l) }));
  const removeInput = (idx) => setF(prev => ({ ...prev, inputs: prev.inputs.filter((_, i) => i !== idx) }));

  const addEquipmentLine = () => {
    if (data.equipment.length === 0) return;
    setF(prev => ({ ...prev, equipment: [...prev.equipment, { id: uid(), equipmentId: data.equipment[0].id, status: "In-Use" }] }));
  };
  const updateEquipmentLine = (idx, patch) => setF(prev => ({ ...prev, equipment: prev.equipment.map((e, i) => i === idx ? { ...e, ...patch } : e) }));
  const removeEquipmentLine = (idx) => setF(prev => ({ ...prev, equipment: prev.equipment.filter((_, i) => i !== idx) }));

  const addOutput = () => {
    const list = data.intermediateProducts;
    setF(prev => ({ ...prev, outputs: [...prev.outputs, { id: uid(), itemType: "intermediate", itemId: list[0] ? list[0].id : "", qtyPerBatch: 1, costOverride: "" }] }));
  };
  const updateOutput = (idx, patch) => setF(prev => ({ ...prev, outputs: prev.outputs.map((o, i) => i === idx ? { ...o, ...patch } : o) }));
  const removeOutput = (idx) => setF(prev => ({ ...prev, outputs: prev.outputs.filter((_, i) => i !== idx) }));

  const canSave = f.name.trim() && f.outputs.length > 0 && f.outputs.every(o => o.itemId);
  const batchCost = computeProcessBatchCost(data, f);

  const save = () => {
    if (!canSave) return;
    update(d => repo.upsert(d, "processes", existing ? id : null, { ...f }));
    onClose();
  };

  return (
    <Modal title={(existing ? "Edit " : "Add ") + "process"} onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <Field label="Process name" span={2} hint="The production step or work center, e.g. 'Frame fabrication'">
          <input style={inputStyle} value={f.name} onChange={e => set("name", e.target.value)} placeholder="Process name" />
        </Field>
        <Field label="Process SKU / code"><input style={inputStyle} value={f.sku} onChange={e => set("sku", e.target.value)} placeholder="PR-0001" /></Field>
        <Field label="Batch production time (hours)" hint="Decimals ok, e.g. 6.5"><input type="number" step="0.1" style={inputStyle} value={f.productionTimeHours} onChange={e => set("productionTimeHours", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Notes" span={2}><input style={inputStyle} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Process notes" /></Field>
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Inputs (consumed per batch)</div>
          <Btn variant="secondary" onClick={addInput}><Plus size={14} />Add input</Btn>
        </div>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          Inputs can be raw materials, existing intermediate products, or existing finished goods — the last option is what enables repackaging or multi-unit bundling.
        </div>
        {f.inputs.length === 0 && <div style={{ fontSize: 12.5, color: "#8A9099", marginBottom: 8 }}>No inputs added yet.</div>}
        {f.inputs.map((line, idx) => (
          <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 90px 32px", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <select style={inputStyle} value={line.itemType + "|" + line.itemId} onChange={e => {
              const [itemType, itemId] = e.target.value.split("|");
              updateInput(idx, { itemType, itemId });
            }}>
              {inputOptions.map(o => <option key={o.itemType + "|" + o.itemId} value={o.itemType + "|" + o.itemId}>{o.label}</option>)}
            </select>
            <input type="number" step="0.01" style={inputStyle} value={line.qty} onChange={e => updateInput(idx, { qty: parseFloat(e.target.value) || 0 })} />
            <IconBtn onClick={() => removeInput(idx)} title="Remove" danger><Trash2 size={13} /></IconBtn>
          </div>
        ))}
        {inputOptions.length === 0 && <div style={{ fontSize: 12, color: "#B87510" }}>Add a raw material, intermediate product, or finished good first.</div>}
        {f.inputs.length > 0 && <div style={{ fontSize: 11.5, color: "#8A9099", marginTop: 4 }}>Batch input cost: <span className="mono" style={{ fontWeight: 600 }}>{fmtMoney(batchCost)}</span></div>}
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Equipment used</div>
          <Btn variant="secondary" onClick={addEquipmentLine}><Plus size={14} />Add equipment</Btn>
        </div>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          Mark equipment as in-use for this batch, or blocked if it can't be used for some other reason while this batch runs.
        </div>
        {f.equipment.length === 0 && <div style={{ fontSize: 12.5, color: "#8A9099", marginBottom: 8 }}>No equipment linked to this process yet.</div>}
        {f.equipment.map((eqLine, idx) => (
          <div key={eqLine.id} style={{ display: "grid", gridTemplateColumns: "1fr 130px 32px", gap: 8, marginBottom: 8, alignItems: "center" }}>
            <select style={inputStyle} value={eqLine.equipmentId || ""} onChange={e => updateEquipmentLine(idx, { equipmentId: e.target.value })}>
              {data.equipment.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <select style={inputStyle} value={eqLine.status} onChange={e => updateEquipmentLine(idx, { status: e.target.value })}>
              {EQUIPMENT_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o === "In-Use" ? "In-use" : "Blocked"}</option>)}
            </select>
            <IconBtn onClick={() => removeEquipmentLine(idx)} title="Remove" danger><Trash2 size={13} /></IconBtn>
          </div>
        ))}
        {data.equipment.length === 0 && <div style={{ fontSize: 12, color: "#B87510" }}>Add equipment first so you have something to select.</div>}
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Outputs produced per batch</div>
          <Btn variant="secondary" onClick={addOutput}><Plus size={14} />Add output</Btn>
        </div>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          Each output must point at an existing Intermediate Product or Finished Good — create the catalog entry first if it doesn't exist yet. Unless overridden, cost is the batch input cost split evenly per unit across all outputs.
        </div>
        {f.outputs.length === 0 && <div style={{ fontSize: 12.5, color: "#8A9099", marginBottom: 8 }}>No outputs added yet.</div>}
        {f.outputs.map((o, idx) => {
          const list = o.itemType === "finished" ? data.finishedGoods : data.intermediateProducts;
          const item = getCatalogItem(data, o.itemType, o.itemId);
          return (
            <div key={o.id} style={{ background: "#FAFBF8", border: "1px solid #E7E9E4", borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 32px", gap: 8, marginBottom: 8 }}>
                <select style={inputStyle} value={o.itemType} onChange={e => {
                  const newType = e.target.value;
                  const newList = newType === "finished" ? data.finishedGoods : data.intermediateProducts;
                  updateOutput(idx, { itemType: newType, itemId: newList[0] ? newList[0].id : "" });
                }}>
                  <option value="intermediate">Intermediate product</option>
                  <option value="finished">Finished good</option>
                </select>
                <select style={inputStyle} value={o.itemId} onChange={e => updateOutput(idx, { itemId: e.target.value })}>
                  {list.length === 0 && <option value="">No {o.itemType} items yet</option>}
                  {list.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <IconBtn onClick={() => removeOutput(idx)} title="Remove output" danger><Trash2 size={13} /></IconBtn>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Field label={"Qty produced / batch" + (item ? " (" + item.unit + ")" : "")}>
                  <input type="number" step="0.01" style={inputStyle} value={o.qtyPerBatch} onChange={e => updateOutput(idx, { qtyPerBatch: parseFloat(e.target.value) || 0 })} />
                </Field>
                <Field label="Cost override (optional)" hint={"Auto: " + fmtMoney(computeOutputAutoAllocation(data, f, o))}>
                  <input type="number" step="0.01" style={inputStyle} value={o.costOverride} onChange={e => updateOutput(idx, { costOverride: e.target.value })} placeholder="Leave blank to auto-allocate" />
                </Field>
              </div>
            </div>
          );
        })}
        {!canSave && <div style={{ fontSize: 12, color: "#B87510" }}>Give the process a name and at least one output, each pointing at an existing catalog item.</div>}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save} style={{ opacity: canSave ? 1 : 0.5 }}>{existing ? "Save changes" : "Add process"}</Btn>
      </div>
    </Modal>
  );
}

function computeOutputAutoAllocation(data, draftProcess, output) {
  const batchCost = (draftProcess.inputs || []).reduce((sum, line) => sum + computeItemUnitCost(data, line.itemType, line.itemId) * line.qty, 0);
  const totalUnits = (draftProcess.outputs || []).reduce((s, o) => s + (Number(o.qtyPerBatch) || 0), 0);
  return totalUnits > 0 ? batchCost / totalUnits : 0;
}

/* ---------------------------------------------------------------
   Customers (admin)
----------------------------------------------------------------*/

/* ---------------------------------------------------------------
   Sales order review

   The decision sits on each line: yes, no, or yes-but-different. An
   adjusted line takes a revised quantity and date BEFORE anything is
   raised, so the schedule records what the plant committed to rather
   than what was asked for.

   Releasing is a separate step from deciding, so a review can be
   revisited right up until a run exists.
----------------------------------------------------------------*/
function SalesOrderModal({ data, orderId, onClose, update }) {
  const rec = useMemo(
    () => salesOrderRecords(data).find(r => r.order.id === orderId),
    [data, orderId]);
  const [draft, setDraft] = useState({});
  const [error, setError] = useState("");

  if (!rec) return null;
  const money = (n) => fmtMoney(n || 0);

  const decide = (line, decision) => {
    setError("");
    if (decision === "Adjust") {
      // seed the adjustment with what was asked for, so the planner edits
      // a real number rather than an empty box
      setDraft(prev => ({ ...prev, [line.line.id]: {
        qty: prev[line.line.id] ? prev[line.line.id].qty : line.qty,
        date: prev[line.line.id] ? prev[line.line.id].date
          : (line.line.requestedDate || rec.requestedDate || todayStr()),
        note: line.line.reviewNote || ""
      }}));
    }
    let outcome = null;
    update(d => {
      const cur = draft[line.line.id] || {};
      outcome = tx.reviewSalesOrderLine(d, {
        salesOrderId: orderId, lineId: line.line.id, decision,
        approvedQty: decision === "Adjust" ? (cur.qty || line.qty) : undefined,
        approvedDate: decision === "Adjust" ? (cur.date || line.line.requestedDate) : undefined,
        note: cur.note
      });
    });
    if (outcome && !outcome.ok) setError(outcome.error);
  };

  const applyAdjust = (line) => {
    const cur = draft[line.line.id] || {};
    setError("");
    let outcome = null;
    update(d => {
      outcome = tx.reviewSalesOrderLine(d, {
        salesOrderId: orderId, lineId: line.line.id, decision: "Adjust",
        approvedQty: Number(cur.qty) || 0,
        approvedDate: cur.date || line.line.requestedDate,
        note: cur.note
      });
    });
    if (outcome && !outcome.ok) setError(outcome.error);
  };

  const release = (line) => {
    setError("");
    let outcome = null;
    update(d => {
      outcome = tx.releaseSalesOrderLine(d, { salesOrderId: orderId, lineId: line.line.id });
    });
    if (outcome && !outcome.ok) setError(outcome.error);
  };

  const releaseAll = () => {
    setError("");
    let failures = [];
    update(d => {
      rec.lines.forEach(l => {
        if (l.released) return;
        if (l.decision !== "Accept" && l.decision !== "Adjust") return;
        const out = tx.releaseSalesOrderLine(d, { salesOrderId: orderId, lineId: l.line.id });
        if (!out.ok) failures.push(out.error);
      });
    });
    if (failures.length) setError(failures[0]);
  };

  const seg = (active, tone) => ({
    padding: "3px 9px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", borderRadius: 5,
    background: active ? (tone || "#1F6F78") : "#fff",
    color: active ? "#fff" : "#5B6470",
    border: "1px solid " + (active ? (tone || "#1F6F78") : "#D7DAD3")
  });

  const readyToRelease = rec.lines.filter(l =>
    !l.released && (l.decision === "Accept" || l.decision === "Adjust")).length;

  return (
    <Modal title={"Sales order " + rec.reference} onClose={onClose} wide>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", fontSize: 13,
                    padding: "9px 12px", marginBottom: 14, borderRadius: 7,
                    background: "#F4F6F9", border: "1px solid #DCE1E8" }}>
        <div><b>{rec.customerName}</b></div>
        <div style={{ color: "#5B6470" }}>Rep: {rec.salesRep || "\u2014"}</div>
        <div style={{ color: "#5B6470" }}>Ordered {fmtDate(rec.orderDate)}</div>
        <div style={{ color: "#5B6470" }}>Requested {fmtDate(rec.requestedDate)}</div>
        <Badge tone={rec.status === "Released" ? "good" : rec.status === "Reviewed" ? "info" : "neutral"}>
          {rec.status}
        </Badge>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 16 }}>
        {[["Ship to", rec.addressLabel || "\u2014"],
          ["Gross value", money(rec.grossValue)],
          ["Discount given", money(rec.discountValue)],
          ["Net value", money(rec.netValue)]].map(([label, value]) => (
          <div key={label}>
            <div style={{ fontSize: 11, color: "#7A8079", fontWeight: 600 }}>{label}</div>
            <div style={{ fontSize: 13.5 }} className={label === "Ship to" ? "" : "mono"}>{value}</div>
          </div>
        ))}
      </div>

      {rec.anyBelowCost && (
        <div style={{ padding: "8px 12px", marginBottom: 12, borderRadius: 7, fontSize: 12.5,
                      background: "#FCF4F3", border: "1px solid #E3B9B2", color: "#8C332B" }}>
          One or more lines are discounted below what the product costs to make.
          Those are marked below.
        </div>
      )}
      {error && (
        <div style={{ padding: "8px 12px", marginBottom: 12, borderRadius: 7, fontSize: 12.5,
                      background: "#FCF4F3", border: "1px solid #E3B9B2", color: "#8C332B" }}>
          {error}
        </div>
      )}

      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
        Lines \u2014 add to the production schedule?
      </div>

      {rec.lines.map(l => {
        const cur = draft[l.line.id] || {};
        return (
          <div key={l.line.id} style={{
            border: "1px solid " + (l.belowCost ? "#E3B9B2" : "#E7E9E4"),
            borderRadius: 8, padding: 12, marginBottom: 10,
            background: l.released ? "#F7FAF8" : "#fff"
          }}>
            <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
              <div style={{ fontWeight: 700, fontSize: 13.5, flex: 1, minWidth: 180 }}>
                {l.productName}
              </div>
              <div className="mono" style={{ fontSize: 12.5 }}>
                {fmtNum(l.qty)} {l.unit}
              </div>
              <div className="mono" style={{ fontSize: 12.5, color: "#5B6470" }}>
                list {l.listPrice != null ? money(l.listPrice) : "\u2014"}
                {l.discountPct > 0 && (
                  <span style={{ color: "#8C6B45" }}>
                    {" \u2212"}{l.discountPct}% \u2192 <b>{money(l.netPrice)}</b>
                  </span>
                )}
              </div>
              <div className="mono" style={{ fontSize: 12.5, fontWeight: 700 }}>
                {l.lineValue != null ? money(l.lineValue) : "\u2014"}
              </div>
            </div>

            {(l.discountReason || l.belowCost || l.unpriced) && (
              <div style={{ fontSize: 11.5, marginTop: 4,
                            color: l.belowCost || l.unpriced ? "#A32D2D" : "#7A8079" }}>
                {l.unpriced && "No agreed price for this product on this account. "}
                {l.belowCost && "Discounted below the " + money(l.unitCost) + " it costs to make. "}
                {l.discountReason && !l.unpriced && ("Reason: " + l.discountReason)}
              </div>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
              {l.released ? (
                <>
                  <Badge tone="good">Released to production</Badge>
                  <span style={{ fontSize: 12, color: "#5B6470" }}>
                    {fmtNum(l.approvedQty)} {l.unit} due {fmtDate(l.approvedDate)}
                  </span>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 12, color: "#7A8079" }}>Add to schedule:</span>
                  <div role="button" tabIndex={0} onClick={() => decide(l, "Accept")}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); decide(l, "Accept"); } }}
                    style={seg(l.decision === "Accept", "#2E7D5B")}>Yes</div>
                  <div role="button" tabIndex={0} onClick={() => decide(l, "Reject")}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); decide(l, "Reject"); } }}
                    style={seg(l.decision === "Reject", "#A32D2D")}>No</div>
                  <div role="button" tabIndex={0} onClick={() => decide(l, "Adjust")}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); decide(l, "Adjust"); } }}
                    style={seg(l.decision === "Adjust", "#8C6B45")}>Adjust</div>
                  {(l.decision === "Accept" || l.decision === "Adjust") && (
                    <Btn variant="secondary" onClick={() => release(l)}
                         style={{ padding: "3px 10px", fontSize: 11.5 }}>
                      Release to schedule
                    </Btn>
                  )}
                </>
              )}
            </div>

            {!l.released && l.decision === "Adjust" && (
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginTop: 10,
                            flexWrap: "wrap", padding: "10px 12px", borderRadius: 7,
                            background: "#FBFAF6", border: "1px solid #E4DFD2" }}>
                <Field label={"Quantity (asked for " + fmtNum(l.qty) + ")"}>
                  <input type="number" style={{ ...inputStyle, width: 130 }}
                    value={cur.qty === undefined ? l.approvedQty || l.qty : cur.qty}
                    onChange={e => setDraft(prev => ({ ...prev, [l.line.id]: {
                      ...(prev[l.line.id] || {}), qty: parseFloat(e.target.value) || 0 } }))} />
                </Field>
                <Field label={"Ship date (asked for " + fmtDate(l.line.requestedDate || rec.requestedDate) + ")"}>
                  <input type="date" style={{ ...inputStyle, width: 158 }}
                    value={cur.date === undefined ? (l.approvedDate || l.line.requestedDate || "") : cur.date}
                    onChange={e => setDraft(prev => ({ ...prev, [l.line.id]: {
                      ...(prev[l.line.id] || {}), date: e.target.value } }))} />
                </Field>
                <Field label="Why">
                  <input style={{ ...inputStyle, width: 240 }}
                    value={cur.note === undefined ? (l.line.reviewNote || "") : cur.note}
                    onChange={e => setDraft(prev => ({ ...prev, [l.line.id]: {
                      ...(prev[l.line.id] || {}), note: e.target.value } }))}
                    placeholder="Reason for the change" />
                </Field>
                <Btn variant="secondary" onClick={() => applyAdjust(l)}
                     style={{ padding: "5px 11px", fontSize: 12 }}>Apply</Btn>
              </div>
            )}

            {!l.released && l.decision === "Reject" && l.line.reviewNote && (
              <div style={{ fontSize: 12, color: "#8C332B", marginTop: 6 }}>{l.line.reviewNote}</div>
            )}
          </div>
        );
      })}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                    marginTop: 16, gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "#7A8079" }}>
          {rec.pending > 0 && rec.pending + " line(s) still to decide. "}
          {readyToRelease > 0 && readyToRelease + " ready to release. "}
          {rec.rejected > 0 && rec.rejected + " rejected."}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {readyToRelease > 0 && (
            <Btn onClick={releaseAll}>Release {readyToRelease} line(s) to schedule</Btn>
          )}
          <Btn variant="secondary" onClick={onClose}>Close</Btn>
        </div>
      </div>
    </Modal>
  );
}

function SalesOrdersTab({ data, onOpenOrder }) {
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");

  const records = useMemo(() => salesOrderRecords(data, { status: statusFilter }), [data, statusFilter]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;
    return records.filter(r =>
      String(r.reference).toLowerCase().includes(q) ||
      String(r.customerName).toLowerCase().includes(q) ||
      String(r.salesRep).toLowerCase().includes(q) ||
      r.lines.some(l => String(l.productName).toLowerCase().includes(q)));
  }, [records, search]);

  const reps = useMemo(() => salesRepSummary(data), [data]);
  const awaiting = records.filter(r => r.pending > 0);
  const belowCost = records.filter(r => r.anyBelowCost);
  const seg = (active) => ({
    padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer", borderRadius: 6,
    background: active ? "#1F6F78" : "#fff", color: active ? "#fff" : "#5B6470",
    border: "1px solid " + (active ? "#1F6F78" : "#D7DAD3")
  });

  return (
    <div>
      <PageHeader tabKey="salesOrders"
        subtitle="What customers have asked for, what the rep conceded, and whether the plant will commit to it"
        action={<SearchBox value={search} onChange={setSearch} placeholder="Order, customer, rep\u2026" />} />

      <div style={{ display: "flex", gap: 4, marginBottom: 14, flexWrap: "wrap" }}>
        {[["", "All"], ["Submitted", "Awaiting review"], ["Reviewed", "Reviewed"],
          ["Released", "Released"], ["Cancelled", "Cancelled"]].map(([k, label]) => (
          <div key={k || "all"} role="button" tabIndex={0} onClick={() => setStatusFilter(k)}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setStatusFilter(k); } }}
            style={seg(statusFilter === k)}>{label}</div>
        ))}
      </div>

      <div style={{
        display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center",
        padding: "10px 14px", marginBottom: 14, borderRadius: 8, fontSize: 13,
        background: belowCost.length ? "#FCF4F3" : "#F1F6F2",
        border: "1px solid " + (belowCost.length ? "#E3B9B2" : "#CFE0D3")
      }}>
        <div><b>{records.length}</b> order(s)</div>
        {awaiting.length > 0
          ? <div style={{ color: "#8C6B45" }}><b>{awaiting.length}</b> awaiting a decision</div>
          : <div style={{ color: "#2E7D5B" }}>Every line has been reviewed.</div>}
        {belowCost.length > 0 && (
          <div style={{ color: "#A32D2D" }}>
            <b>{belowCost.length}</b> with a line discounted below cost
          </div>
        )}
        <div style={{ color: "#5B6470" }}>
          {fmtMoney(records.reduce((s, r) => s + r.discountValue, 0))} conceded of{" "}
          {fmtMoney(records.reduce((s, r) => s + r.grossValue, 0))} at list
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10,
                    overflow: "hidden", marginBottom: 16 }}>
        <table className="mrp-table">
          <thead>
            <tr>
              <th>Order</th><th>Customer</th><th>Rep</th><th>Ordered</th><th>Requested</th>
              <th>Lines</th><th>List value</th><th>Discount</th><th>Net</th><th>Review</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.order.id}
                  onClick={() => onOpenOrder && onOpenOrder(r.order.id)}
                  style={{ cursor: onOpenOrder ? "pointer" : "default" }}
                  title="Open to review the lines">
                <td className="mono">{r.reference}</td>
                <td>{r.customerName}</td>
                <td>{r.salesRep || "\u2014"}</td>
                <td className="mono">{fmtDate(r.orderDate)}</td>
                <td className="mono">{fmtDate(r.requestedDate)}</td>
                <td className="mono">{r.lineCount}</td>
                <td className="mono">{fmtMoney(r.grossValue)}</td>
                <td className="mono" style={{ color: r.discountValue > 0 ? "#8C6B45" : "#8A9099" }}>
                  {r.discountValue > 0 ? fmtMoney(r.discountValue) : "\u2014"}
                  {r.anyBelowCost && <span style={{ color: "#A32D2D" }}> \u26a0</span>}
                </td>
                <td className="mono" style={{ fontWeight: 700 }}>{fmtMoney(r.netValue)}</td>
                <td>
                  {r.pending > 0 && <Badge tone="warn">{r.pending} pending</Badge>}
                  {r.pending === 0 && r.released > 0 && r.fullyReleased && <Badge tone="good">Released</Badge>}
                  {r.pending === 0 && !r.fullyReleased && <Badge tone="info">Reviewed</Badge>}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={10} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>
                No sales orders match.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {reps.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>Discount by rep</div>
          <div style={{ fontSize: 12, color: "#7A8079", marginBottom: 10 }}>
            Concessions against list, which is why the discount is recorded separately
            rather than folded into a net price.
          </div>
          <table className="mrp-table">
            <thead>
              <tr><th>Rep</th><th>Orders</th><th>Lines</th><th>At list</th>
                  <th>Conceded</th><th>Average</th><th>Below cost</th></tr>
            </thead>
            <tbody>
              {reps.map(b => (
                <tr key={b.rep}>
                  <td>{b.rep}</td>
                  <td className="mono">{b.orders}</td>
                  <td className="mono">{b.lines}</td>
                  <td className="mono">{fmtMoney(b.gross)}</td>
                  <td className="mono">{fmtMoney(b.discount)}</td>
                  <td className="mono" style={{ fontWeight: 700,
                        color: b.discountPct > 6 ? "#A32D2D" : b.discountPct > 3 ? "#8C6B45" : "#1F5B3E" }}>
                    {b.discountPct.toFixed(1)}%
                  </td>
                  <td className="mono" style={{ color: b.belowCost ? "#A32D2D" : "#8A9099" }}>
                    {b.belowCost || "\u2014"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CustomersTab({ data, search, setSearch, onAdd, onEdit, onDelete }) {
  const rows = data.customers.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.code.toLowerCase().includes(search.toLowerCase()));
  const tr = useTimeRange(data, "12m");

  /* One series per customer, so the mix over time is visible rather
     than just the total. Unattributed shipments get their own band. */
  const custSeries = useMemo(() => data.customers.map((c, i) => ({
    key: c.id, label: c.name, color: SERIES_COLORS[i % SERIES_COLORS.length]
  })).concat([{ key: "_none", label: "No customer", color: "#B6BBB4" }]), [data.customers]);

  const custRows = useMemo(() => bucketEvents(
    shipmentEvents(data).map(e => ({
      date: e.date, series: e.customerId || "_none", value: e.revenue
    })), tr.range, custSeries.map(s => s.key)), [data, tr.range, custSeries]);

  return (
    <div>
      <PageHeader tabKey="customers" subtitle="Accounts, ship-to/bill-to addresses, and customer-specific pricing with volume discounts"
        action={<div style={{ display: "flex", gap: 10 }}><SearchBox value={search} onChange={setSearch} placeholder="Search customers…" /><Btn onClick={onAdd}><Plus size={15} />Add customer</Btn></div>} />

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <TimeRangeControls state={tr} />
      </div>
      <ChartCard
        title="Revenue by customer"
        subtitle="Shipped revenue attributed to each account, by ship date"
        rows={custRows} series={custSeries} formatValue={fmtMoney}
        emptyMessage="No shipments recorded in this period" />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {rows.map(c => (
          <CustomerCard key={c.id} customer={c} data={data} onEdit={() => onEdit(c.id)} onDelete={() => onDelete(c.id)} />
        ))}
        {rows.length === 0 && <div style={{ color: "#8A9099", padding: 24 }}>No customers yet.</div>}
      </div>
    </div>
  );
}

function CustomerCard({ customer, data, onEdit, onDelete }) {
  const priceLines = customer.priceList.map(p => {
    const fg = getFinished(data, p.finishedGoodId);
    if (!fg) return null;
    return { p, fg, info: priceLineMarginInfo(data, p) };
  }).filter(Boolean);
  const atRisk = priceLines.filter(x => x.info.minMarginPct < 20).length;

  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{customer.name}</div>
          <div className="mono" style={{ fontSize: 11, color: "#8A9099", marginTop: 2 }}>{customer.code}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <IconBtn onClick={onEdit} title="Edit"><Pencil size={13} /></IconBtn>
          <IconBtn onClick={onDelete} title="Delete" danger><Trash2 size={13} /></IconBtn>
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "10px 0", fontSize: 12, flexWrap: "wrap" }}>
        <span style={{ color: "#8A9099" }}>{customer.addresses.length} address{customer.addresses.length === 1 ? "" : "es"} · {priceLines.length} priced product{priceLines.length === 1 ? "" : "s"}</span>
        {atRisk > 0 && <Badge tone="bad">{atRisk} near/below cost</Badge>}
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Pricing</div>
        {priceLines.map(({ p, fg, info }, idx) => (
          <div key={idx} style={{ padding: "5px 0", borderBottom: idx < priceLines.length - 1 ? "1px dashed #EEF0EA" : "none" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12.5 }}>{fg.name}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="mono" style={{ fontSize: 12 }}>{fmtMoney(p.basePrice)}</span>
                <Badge tone={info.minMarginPct >= 20 ? "good" : info.minMarginPct >= 5 ? "warn" : "bad"}>{Math.round(info.minMarginPct)}% margin</Badge>
              </div>
            </div>
            {p.tiers.length > 0 && <div style={{ fontSize: 11, color: "#8A9099", marginTop: 2 }}>+{p.tiers.length} volume tier{p.tiers.length === 1 ? "" : "s"} · est. cost {fmtMoney(info.unitCost)}</div>}
          </div>
        ))}
        {priceLines.length === 0 && <div style={{ fontSize: 12, color: "#8A9099" }}>No products priced for this customer.</div>}
      </div>

      {customer.addresses.length > 0 && (
        <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Addresses</div>
          {customer.addresses.map((a, idx) => (
            <div key={idx} style={{ fontSize: 12, color: "#5B6470", padding: "3px 0" }}>
              <span style={{ fontWeight: 600 }}>{a.label}: </span>{a.city}{a.city && a.region ? ", " : ""}{a.region} {a.country}
            </div>
          ))}
        </div>
      )}

      {customer.notes && <div style={{ fontSize: 12, color: "#7A8079", marginTop: 10, fontStyle: "italic" }}>{customer.notes}</div>}
    </div>
  );
}

function CustomerModal({ data, id, onClose, update }) {
  const existing = id ? getCustomer(data, id) : null;
  const [f, setF] = useState(existing ? structuredClone(existing) : { name: "", code: "", notes: "", addresses: [], priceList: [] });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const addAddress = () => setF(prev => ({ ...prev, addresses: [...prev.addresses, { id: uid(), label: "", line1: "", line2: "", city: "", region: "", postalCode: "", country: "" }] }));
  const updateAddress = (idx, patch) => setF(prev => ({ ...prev, addresses: prev.addresses.map((a, i) => i === idx ? { ...a, ...patch } : a) }));
  const removeAddress = (idx) => setF(prev => ({ ...prev, addresses: prev.addresses.filter((_, i) => i !== idx) }));

  const addPriceLine = () => {
    if (data.finishedGoods.length === 0) return;
    setF(prev => ({ ...prev, priceList: [...prev.priceList, { id: uid(), finishedGoodId: data.finishedGoods[0].id, basePrice: 0, tiers: [] }] }));
  };
  const updatePriceLine = (idx, patch) => setF(prev => ({ ...prev, priceList: prev.priceList.map((p, i) => i === idx ? { ...p, ...patch } : p) }));
  const removePriceLine = (idx) => setF(prev => ({ ...prev, priceList: prev.priceList.filter((_, i) => i !== idx) }));

  const addTier = (pidx) => setF(prev => ({ ...prev, priceList: prev.priceList.map((p, i) => i === pidx ? { ...p, tiers: [...p.tiers, { id: uid(), minQty: 1, price: 0 }] } : p) }));
  const updateTier = (pidx, tidx, patch) => setF(prev => ({ ...prev, priceList: prev.priceList.map((p, i) => i === pidx ? { ...p, tiers: p.tiers.map((t, j) => j === tidx ? { ...t, ...patch } : t) } : p) }));
  const removeTier = (pidx, tidx) => setF(prev => ({ ...prev, priceList: prev.priceList.map((p, i) => i === pidx ? { ...p, tiers: p.tiers.filter((_, j) => j !== tidx) } : p) }));

  const save = () => {
    if (!f.name.trim()) return;
    update(d => repo.upsert(d, "customers", existing ? id : null, { ...f }));
    onClose();
  };

  return (
    <Modal title={(existing ? "Edit " : "Add ") + "customer"} onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <Field label="Customer name" span={2}><input style={inputStyle} value={f.name} onChange={e => set("name", e.target.value)} placeholder="Company name" /></Field>
        <Field label="Code"><input style={inputStyle} value={f.code} onChange={e => set("code", e.target.value)} placeholder="CUST-0001" /></Field>
        <Field label="Notes"><input style={inputStyle} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Payment terms, account notes…" /></Field>
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14, marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Addresses</div>
          <Btn variant="secondary" onClick={addAddress}><Plus size={14} />Add address</Btn>
        </div>
        {f.addresses.length === 0 && <div style={{ fontSize: 12.5, color: "#8A9099", marginBottom: 8 }}>No addresses added yet.</div>}
        {f.addresses.map((a, idx) => (
          <div key={a.id} style={{ background: "#FAFBF8", border: "1px solid #E7E9E4", borderRadius: 8, padding: 10, marginBottom: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 32px", gap: 8, marginBottom: 8 }}>
              <input style={inputStyle} value={a.label} onChange={e => updateAddress(idx, { label: e.target.value })} placeholder="Label (Billing, Warehouse…)" />
              <input style={inputStyle} value={a.line1} onChange={e => updateAddress(idx, { line1: e.target.value })} placeholder="Address line 1" />
              <IconBtn onClick={() => removeAddress(idx)} title="Remove" danger><Trash2 size={13} /></IconBtn>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
              <input style={inputStyle} value={a.line2} onChange={e => updateAddress(idx, { line2: e.target.value })} placeholder="Address line 2 (optional)" />
              <input style={inputStyle} value={a.city} onChange={e => updateAddress(idx, { city: e.target.value })} placeholder="City" />
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              <input style={inputStyle} value={a.region} onChange={e => updateAddress(idx, { region: e.target.value })} placeholder="State / region" />
              <input style={inputStyle} value={a.postalCode} onChange={e => updateAddress(idx, { postalCode: e.target.value })} placeholder="Postal code" />
              <input style={inputStyle} value={a.country} onChange={e => updateAddress(idx, { country: e.target.value })} placeholder="Country" />
            </div>
          </div>
        ))}
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Product pricing</div>
          <Btn variant="secondary" onClick={addPriceLine}><Plus size={14} />Add priced product</Btn>
        </div>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          Set a base price per finished good, then add volume tiers for order-quantity discounts. Margin is shown against the modeled unit cost so you can see how thin pricing gets at each tier.
        </div>
        {f.priceList.length === 0 && <div style={{ fontSize: 12.5, color: "#8A9099", marginBottom: 8 }}>No products priced yet.</div>}
        {f.priceList.map((p, pidx) => {
          const fg = getFinished(data, p.finishedGoodId);
          const info = fg ? priceLineMarginInfo(data, p) : null;
          return (
            <div key={p.id} style={{ background: "#FAFBF8", border: "1px solid #E7E9E4", borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 32px", gap: 8, marginBottom: 8 }}>
                <select style={inputStyle} value={p.finishedGoodId} onChange={e => updatePriceLine(pidx, { finishedGoodId: e.target.value })}>
                  {data.finishedGoods.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
                <input type="number" step="0.01" style={inputStyle} value={p.basePrice} onChange={e => updatePriceLine(pidx, { basePrice: parseFloat(e.target.value) || 0 })} placeholder="Base price" />
                <IconBtn onClick={() => removePriceLine(pidx)} title="Remove" danger><Trash2 size={13} /></IconBtn>
              </div>
              {info && (
                <div style={{ fontSize: 11.5, color: "#5B6470", marginBottom: 8 }}>
                  Est. unit cost <span className="mono" style={{ fontWeight: 600 }}>{fmtMoney(info.unitCost)}</span> · base margin <Badge tone={info.points[0].marginPct >= 20 ? "good" : info.points[0].marginPct >= 5 ? "warn" : "bad"}>{Math.round(info.points[0].marginPct)}%</Badge>
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.3 }}>Volume tiers</div>
                <Btn variant="ghost" onClick={() => addTier(pidx)} style={{ padding: "4px 8px", fontSize: 12 }}><Plus size={12} />Add tier</Btn>
              </div>
              {p.tiers.length === 0 && <div style={{ fontSize: 11.5, color: "#A6ABA2" }}>No volume discounts set.</div>}
              {p.tiers.map((t, tidx) => {
                const tierMargin = info ? info.points.find(pt => pt.qty === t.minQty) : null;
                return (
                  <div key={t.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 28px", gap: 6, marginBottom: 6, alignItems: "center" }}>
                    <input type="number" style={inputStyle} value={t.minQty} onChange={e => updateTier(pidx, tidx, { minQty: parseInt(e.target.value) || 0 })} placeholder="Min qty" />
                    <input type="number" step="0.01" style={inputStyle} value={t.price} onChange={e => updateTier(pidx, tidx, { price: parseFloat(e.target.value) || 0 })} placeholder="Tier price" />
                    {tierMargin && <Badge tone={tierMargin.marginPct >= 20 ? "good" : tierMargin.marginPct >= 5 ? "warn" : "bad"}>{Math.round(tierMargin.marginPct)}%</Badge>}
                    <IconBtn onClick={() => removeTier(pidx, tidx)} title="Remove" danger><Trash2 size={12} /></IconBtn>
                  </div>
                );
              })}
            </div>
          );
        })}
        {data.finishedGoods.length === 0 && <div style={{ fontSize: 12, color: "#B87510" }}>Add a finished good first so you have something to price.</div>}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>{existing ? "Save changes" : "Add customer"}</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Equipment (admin, used by both views)
----------------------------------------------------------------*/
function EquipmentTab({ data, search, setSearch, onAdd, onEdit, onDelete }) {
  const rows = data.equipment.filter(e =>
    !search || e.name.toLowerCase().includes(search.toLowerCase()) || e.code.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div>
      <PageHeader tabKey="equipment" subtitle="Machines and work centers used across your processes"
        action={<div style={{ display: "flex", gap: 10 }}><SearchBox value={search} onChange={setSearch} placeholder="Search equipment…" /><Btn onClick={onAdd}><Plus size={15} />Add equipment</Btn></div>} />
      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, overflow: "hidden" }}>
        <table className="mrp-table">
          <thead>
            <tr><th>Equipment</th><th>Units available</th><th>Notes</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(e => (
              <tr key={e.id}>
                <td>
                  <div style={{ fontWeight: 600 }}>{e.name}</div>
                  <div className="mono" style={{ fontSize: 11, color: "#8A9099" }}>{e.code}</div>
                </td>
                <td className="mono">{fmtNum(e.units)}</td>
                <td style={{ fontSize: 12.5, color: "#7A8079" }}>{e.notes || "—"}</td>
                <td>
                  <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                    <IconBtn onClick={() => onEdit(e.id)} title="Edit"><Pencil size={13} /></IconBtn>
                    <IconBtn onClick={() => onDelete(e.id)} title="Delete" danger><Trash2 size={13} /></IconBtn>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={4} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>No equipment added yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EquipmentModal({ data, id, onClose, update }) {
  const facilityCal = defaultCalendar(data);
  const existing = id ? getEquipment(data, id) : null;
  const [f, setF] = useState(() => existing
    ? { calendarId: "", ...existing }
    : { name: "", code: "", units: 1, notes: "", calendarId: "" });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const save = () => {
    if (!f.name.trim()) return;
    update(d => repo.upsert(d, "equipment", existing ? id : null, { ...f }));
    onClose();
  };

  return (
    <Modal title={existing ? "Edit equipment" : "Add equipment"} onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Equipment name" span={2}><input style={inputStyle} value={f.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Welding jig 1" /></Field>
        <Field label="Code / tag"><input style={inputStyle} value={f.code} onChange={e => set("code", e.target.value)} placeholder="EQ-0001" /></Field>
        <Field label="Units available" hint="How many identical/interchangeable units exist"><input type="number" style={inputStyle} value={f.units} onChange={e => set("units", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Operating hours" span={2}
          hint={"Leave on the facility default unless this machine runs a different pattern. "
                + "A job needing several machines only runs when they are all open."}>
          <select style={inputStyle} value={f.calendarId || ""}
            onChange={e => set("calendarId", e.target.value)}>
            <option value="">
              Facility default{facilityCal ? " (" + facilityCal.name + ", " + weeklyHours(facilityCal) + "h/week)" : ""}
            </option>
            {(data.operatingCalendars || []).filter(c => !c.isDefault).map(c => (
              <option key={c.id} value={c.id}>{c.name} ({weeklyHours(c)}h/week)</option>
            ))}
          </select>
        </Field>
        <Field label="Notes" span={2}><textarea style={{ ...inputStyle, minHeight: 50, resize: "vertical" }} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Location, shift restrictions, shared-use notes…" /></Field>
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>{existing ? "Save changes" : "Add equipment"}</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Components - the fundamental substances/constituents that raw
   materials, intermediate products, and finished goods can each be
   broken down into via Composition. Deliberately flat: no lots, no
   sub-composition, no attributes - just a name, unit, and an
   optional link to the raw material that carries its real cost, so
   there's never a separately maintained cost to drift out of sync.
----------------------------------------------------------------*/
function ComponentsTab({ data, search, setSearch, onAdd, onEdit, onDelete }) {
  const rows = data.components.filter(c => !search || c.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <PageHeader tabKey="components" subtitle="Fundamental constituents used to build a Composition on any raw material, intermediate product, or finished good"
        action={<div style={{ display: "flex", gap: 10 }}><SearchBox value={search} onChange={setSearch} placeholder="Search components…" /><Btn onClick={onAdd}><Plus size={15} />Add component</Btn></div>} />
      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, overflow: "hidden" }}>
        <table className="mrp-table">
          <thead>
            <tr><th>Component</th><th>Unit</th><th>Linked raw material</th><th>Unit cost</th><th>Notes</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map(c => {
              const raw = c.rawMaterialId ? getRaw(data, c.rawMaterialId) : null;
              return (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.name}</td>
                  <td className="mono">{c.unit}</td>
                  <td>{raw ? raw.name : <span style={{ color: "#B87510" }}>Not linked</span>}</td>
                  <td className="mono">{fmtMoney(componentUnitCost(data, c))}</td>
                  <td style={{ fontSize: 12.5, color: "#7A8079" }}>{c.notes || "—"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <IconBtn onClick={() => onEdit(c.id)} title="Edit"><Pencil size={13} /></IconBtn>
                      <IconBtn onClick={() => onDelete(c.id)} title="Delete" danger><Trash2 size={13} /></IconBtn>
                    </div>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={6} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>No components added yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ComponentModal({ data, id, onClose, update }) {
  const existing = id ? getComponent(data, id) : null;
  const [f, setF] = useState(existing ? structuredClone(existing) : {
    name: "", unit: "ea", rawMaterialId: "", notes: "",
    qcCalibration: { enabled: false, measurementLabel: "", measurementUnit: "", slope: 1, intercept: 0 }
  });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const setCal = (k, v) => setF(prev => ({ ...prev, qcCalibration: { ...(prev.qcCalibration || {}), [k]: v } }));
  const linkedRaw = f.rawMaterialId ? getRaw(data, f.rawMaterialId) : null;
  const rawCompLine = linkedRaw ? (linkedRaw.composition || []).find(c => c.componentId === f.id) : null;
  const effectiveCost = componentUnitCost(data, f);
  const cal = f.qcCalibration || { enabled: false, measurementLabel: "", measurementUnit: "", slope: 1, intercept: 0 };

  const save = () => {
    if (!f.name.trim()) return;
    update(d => repo.upsert(d, "components", existing ? id : null, { ...f }));
    onClose();
  };

  return (
    <Modal title={existing ? "Edit component" : "Add component"} onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <Field label="Component name" span={2}><input style={inputStyle} value={f.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Isopropyl alcohol" /></Field>
        <Field label="Unit of measure"><input style={inputStyle} value={f.unit} onChange={e => set("unit", e.target.value)} placeholder="L, kg, %…" /></Field>
        <Field label="Linked raw material" hint={
          !linkedRaw
            ? "No cost basis until linked — contributes $0 to any composition cost estimate"
            : (rawCompLine
              ? "Cost: " + fmtMoney(effectiveCost) + "/" + f.unit + " — concentrated from " + linkedRaw.name + "'s " + fmtMoney(linkedRaw.unitCost) + "/" + linkedRaw.unit + " bulk price, since it's only " + fmtNum(rawCompLine.percentage) + "% of that material by mass with " + fmtNum(effectiveCostWeight(rawCompLine)) + "% of its cost attributed here"
              : "Cost: " + fmtMoney(linkedRaw.unitCost) + "/" + linkedRaw.unit + " — used as-is (add this component to " + linkedRaw.name + "'s own Composition if it's only a fraction of that material)")
        }>
          <select style={inputStyle} value={f.rawMaterialId} onChange={e => set("rawMaterialId", e.target.value)}>
            <option value="">Not linked</option>
            {data.rawMaterials.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Notes" span={2}><textarea style={{ ...inputStyle, minHeight: 50, resize: "vertical" }} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="What this represents…" /></Field>
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, cursor: "pointer" }}>
          <input type="checkbox" checked={cal.enabled} onChange={e => setCal("enabled", e.target.checked)} />
          <span style={{ fontWeight: 700, fontSize: 13 }}>Enable quick QC calibration</span>
        </label>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          Lets a fast bench measurement (refractive index, Brix, conductivity, whatever correlates) stand in for a direct concentration reading. Linear fit: concentration% = slope × measured value + intercept. Whoever logs a lot can still choose manual entry instead, at any time.
        </div>
        {cal.enabled && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
              <Field label="What's measured"><input style={inputStyle} value={cal.measurementLabel} onChange={e => setCal("measurementLabel", e.target.value)} placeholder="e.g. Refractive index" /></Field>
              <Field label="Measurement unit"><input style={inputStyle} value={cal.measurementUnit} onChange={e => setCal("measurementUnit", e.target.value)} placeholder="e.g. nD, °Brix, mS/cm" /></Field>
              <Field label="Slope"><input type="number" step="any" style={inputStyle} value={cal.slope} onChange={e => setCal("slope", parseFloat(e.target.value) || 0)} /></Field>
              <Field label="Intercept"><input type="number" step="any" style={inputStyle} value={cal.intercept} onChange={e => setCal("intercept", parseFloat(e.target.value) || 0)} /></Field>
            </div>
            <div style={{ fontSize: 11.5, color: "#8A9099" }}>
              At a reading of 0 {cal.measurementUnit || "units"}, concentration = <span className="mono" style={{ fontWeight: 600 }}>{fmtNum(cal.intercept)}%</span>. Each 1 {cal.measurementUnit || "unit"} increase changes concentration by <span className="mono" style={{ fontWeight: 600 }}>{fmtNum(cal.slope)}%</span>. Recalibrate against certified standards periodically — this is a linear approximation across whatever range you fit it to.
            </div>
          </>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>{existing ? "Save changes" : "Add component"}</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Waste Streams - catalog of tracked waste, one component per
   stream. Quantities are computed automatically per batch (see
   BatchLogModal's mass-balance section) rather than typed in here;
   this catalog just defines what a waste stream is and how it's
   handled (accumulated as inventory or not, hazard classification).
----------------------------------------------------------------*/
function WasteStreamsTab({ data, search, setSearch, onAdd, onEdit, onDelete, readOnly, tabKey = "wasteStreams" }) {
  const rows = data.wasteStreams.filter(w => !search || w.name.toLowerCase().includes(search.toLowerCase()) || w.sku.toLowerCase().includes(search.toLowerCase()));
  const tr = useTimeRange(data, "13w");
  const [wasteScope, setWasteScope] = useState("");

  /* Waste is generated, not counted at a point in time, so it belongs on the
     same bucketed history as production rather than only as a stock figure. */
  const wasteSeries = [{ key: "waste", label: "Waste generated", color: "#C08A3E" }];
  const wasteRows = useMemo(() => bucketEvents(
    wasteEvents(data).filter(e => !wasteScope || e.itemId === wasteScope),
    tr.range, ["waste"]), [data, tr.range, wasteScope]);
  const wasteTotal = wasteRows.reduce((s, r) => s + r.waste, 0);
  const scoped = wasteScope ? (data.wasteStreams || []).find(w => w.id === wasteScope) : null;

  return (
    <div>
      <PageHeader tabKey={tabKey} subtitle="Computed automatically at batch-log time from the component mass balance: what went in, minus what came out as product, is waste"
        action={<div style={{ display: "flex", gap: 10 }}>
          <SearchBox value={search} onChange={setSearch} placeholder="Search waste streams…" />
          {!readOnly && <Btn onClick={onAdd}><Plus size={15} />Add waste stream</Btn>}
        </div>} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <TimeRangeControls state={tr} />
        <select style={{ ...inputStyle, width: 220 }} value={wasteScope}
          onChange={e => setWasteScope(e.target.value)}>
          <option value="">All waste streams</option>
          {(data.wasteStreams || []).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </div>

      <ChartCard
        title={"Waste generated" + (scoped ? " \u2014 " + scoped.name : "")}
        subtitle="By the date the waste lot was raised. Units are mixed where several streams are shown together."
        rows={wasteRows} series={wasteSeries} showLine
        emptyMessage="No waste recorded in this period"
        footer={
          <div style={{ fontSize: 12, color: "#7A8079", marginTop: 8 }}>
            {fmtNum(Math.round(wasteTotal))} recorded across this range.
            {" "}Accrued automatically from the component mass balance when a batch is logged.
          </div>
        } />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {rows.map(w => <WasteStreamCard key={w.id} item={w} data={data} readOnly={readOnly} onEdit={onEdit ? () => onEdit(w.id) : undefined} onDelete={onDelete ? () => onDelete(w.id) : undefined} />)}
        {rows.length === 0 && <div style={{ color: "#8A9099", padding: 24 }}>No waste streams defined yet{readOnly ? "" : " — add one and link it to a component to start capturing batch waste automatically"}.</div>}
      </div>
    </div>
  );
}

function WasteStreamCard({ item, data, readOnly, onEdit, onDelete }) {
  const component = item.componentId ? getComponent(data, item.componentId) : null;
  const stock = lotQty(item.lots);
  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{item.name}</div>
          <div className="mono" style={{ fontSize: 11, color: "#8A9099", marginTop: 2 }}>{item.sku}</div>
        </div>
        {!readOnly && (
          <div style={{ display: "flex", gap: 6 }}>
            <IconBtn onClick={onEdit} title="Edit"><Pencil size={13} /></IconBtn>
            <IconBtn onClick={onDelete} title="Delete" danger><Trash2 size={13} /></IconBtn>
          </div>
        )}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
        <Badge tone={item.accumulate ? "info" : "neutral"}>{item.accumulate ? "Accumulated" : "Not accumulated"}</Badge>
        <Badge tone={item.hazardClass && item.hazardClass !== "N/A" ? "bad" : "neutral"}>{item.hazardClass || "N/A"}</Badge>
      </div>
      <div style={{ fontSize: 12, color: component ? "#5B6470" : "#B87510", marginBottom: 8 }}>
        {component ? "Tracks: " + component.name : "No component linked yet — batch waste for this stream won't be captured"}
      </div>
      {item.accumulate ? (
        <div style={{ fontSize: 12 }}>
          <span style={{ color: "#8A9099" }}>Accumulated: </span>
          <span className="mono" style={{ fontWeight: 600 }}>{fmtNum(stock)} {item.unit}</span>
          <span style={{ color: "#A6ABA2" }}> ({(item.lots || []).length} lot{(item.lots || []).length === 1 ? "" : "s"})</span>
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: "#8A9099" }}>Reported at batch-log time only, not tracked as inventory.</div>
      )}
      {item.notes && <div style={{ fontSize: 12, color: "#7A8079", marginTop: 10, fontStyle: "italic" }}>{item.notes}</div>}
    </div>
  );
}

function WasteStreamModal({ data, id, onClose, update }) {
  const existing = id ? getWasteStream(data, id) : null;
  const [f, setF] = useState(existing ? structuredClone(existing) : { name: "", sku: "", unit: "ea", notes: "", componentId: "", accumulate: false, hazardClass: "N/A", lots: [], shelfLifeDays: null, physicallyStored: true, packagings: [] });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const save = () => {
    if (!f.name.trim()) return;
    update(d => repo.upsert(d, "wasteStreams", existing ? id : null, { ...f }));
    onClose();
  };

  return (
    <Modal title={existing ? "Edit waste stream" : "Add waste stream"} onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <Field label="Name" span={2}><input style={inputStyle} value={f.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Solvent evaporation loss" /></Field>
        <Field label="SKU"><input style={inputStyle} value={f.sku} onChange={e => set("sku", e.target.value)} placeholder="WS-0001" /></Field>
        <Field label="Unit of measure"><input style={inputStyle} value={f.unit} onChange={e => set("unit", e.target.value)} placeholder="L, kg…" /></Field>
        <Field label="Component tracked" span={2} hint="Batches that consume more of this component than ends up in the finished output will auto-log waste here">
          <select style={inputStyle} value={f.componentId} onChange={e => set("componentId", e.target.value)}>
            <option value="">Not linked</option>
            {data.components.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Hazard classification">
          <select style={inputStyle} value={f.hazardClass} onChange={e => set("hazardClass", e.target.value)}>
            {HAZARD_CLASS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Accumulate" hint="On: batch-computed waste is saved as a lot here, building up trackable inventory. Off: waste is still shown when logging a batch, just not saved.">
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={f.accumulate} onChange={e => set("accumulate", e.target.checked)} />
            <span style={{ fontSize: 13 }}>Accumulate as inventory</span>
          </label>
        </Field>
        <Field label="Notes" span={2}><textarea style={{ ...inputStyle, minHeight: 50, resize: "vertical" }} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Disposal method, handling requirements…" /></Field>
      </div>

      <CatalogWarehouseSection f={f} set={set} showHazard={false} />

      {f.accumulate && (
        <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Lots accumulated</div>
          <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
            Normally populated automatically when a batch is logged against a process that consumes this component. Editable here for manual corrections.
          </div>
          <LotsEditor lots={f.lots} onChange={(lots) => set("lots", lots)} packagings={f.packagings} shelfLifeDays={f.shelfLifeDays} unit={f.unit}dateLabel="Generated" />
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>{existing ? "Save changes" : "Add waste stream"}</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Maintenance (admin, used by both views)
----------------------------------------------------------------*/
function MaintenanceTab({ data, onAdd, onEdit, onDelete }) {
  const sorted = [...data.maintenance].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const previewEnd = addDays(todayStr(), 90);
  return (
    <div>
      <PageHeader tabKey="maintenance" subtitle="Preventative maintenance and cleaning schedules, counted against equipment availability"
        action={<Btn onClick={onAdd}><Plus size={15} />Schedule maintenance</Btn>} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {sorted.map(entry => {
          const eqItem = getEquipment(data, entry.equipmentId);
          const occs = expandMaintenanceWindows(entry, todayStr(), previewEnd).map(w => ({ ...w, status: "Maintenance", label: entry.title || entry.type }));
          return (
            <div key={entry.id} style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <RefreshCw size={14} color="#1F6F78" />
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{entry.title || entry.type}</span>
                    <Badge tone="neutral">{entry.type}</Badge>
                    <Badge tone={entry.status === "Scheduled" ? "info" : entry.status === "Paused" ? "warn" : "neutral"}>{entry.status}</Badge>
                  </div>
                  <div style={{ fontSize: 12, color: "#7A8079", marginTop: 4 }}>
                    {eqItem ? eqItem.name : "(equipment removed)"} · {entry.recurrence === "None"
                      ? ("One-time · " + fmtDate(entry.startDate))
                      : (entry.recurrence + ", from " + fmtDate(entry.startDate) + (entry.recurUntil ? (" through " + fmtDate(entry.recurUntil)) : " (ongoing)"))}
                  </div>
                  {entry.notes && <div style={{ fontSize: 12, color: "#8A9099", marginTop: 4, fontStyle: "italic" }}>{entry.notes}</div>}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <IconBtn onClick={() => onEdit(entry.id)} title="Edit"><Pencil size={13} /></IconBtn>
                  <IconBtn onClick={() => onDelete(entry.id)} title="Delete" danger><Trash2 size={13} /></IconBtn>
                </div>
              </div>
              {entry.status === "Scheduled" && occs.length > 0 && (
                <div style={{ marginTop: 12 }}><EquipmentUsageBars windows={occs} horizonDays={90} /></div>
              )}
              {entry.status === "Scheduled" && occs.length === 0 && <div style={{ fontSize: 12, color: "#8A9099", marginTop: 8 }}>No occurrences in the next 90 days.</div>}
            </div>
          );
        })}
        {sorted.length === 0 && <div style={{ color: "#8A9099", padding: 24 }}>No maintenance scheduled yet.</div>}
      </div>
    </div>
  );
}

function MaintenanceModal({ data, id, onClose, update }) {
  const existing = id ? data.maintenance.find(m => m.id === id) : null;
  const [f, setF] = useState(existing || {
    equipmentId: data.equipment[0] ? data.equipment[0].id : "",
    title: "", type: "Preventative maintenance", startDate: todayStr(), durationHours: 1,
    recurrence: "None", recurUntil: "", status: "Scheduled", notes: ""
  });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const save = () => {
    if (!f.equipmentId) return;
    update(d => repo.upsert(d, "maintenance", existing ? id : null, { ...f }));
    onClose();
  };

  return (
    <Modal title={existing ? "Edit maintenance" : "Schedule maintenance"} onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Equipment" span={2}>
          <select style={inputStyle} value={f.equipmentId} onChange={e => set("equipmentId", e.target.value)}>
            {data.equipment.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        <Field label="Title" span={2}><input style={inputStyle} value={f.title} onChange={e => set("title", e.target.value)} placeholder="e.g. Filter service" /></Field>
        <Field label="Type">
          <select style={inputStyle} value={f.type} onChange={e => set("type", e.target.value)}>
            {MAINTENANCE_TYPES.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select style={inputStyle} value={f.status} onChange={e => set("status", e.target.value)}>
            {MAINTENANCE_STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Start date"><input type="date" style={inputStyle} value={f.startDate} onChange={e => set("startDate", e.target.value)} /></Field>
        <Field label="Duration (hours)" hint="Decimals ok, e.g. 1.5"><input type="number" step="0.1" style={inputStyle} value={f.durationHours} onChange={e => set("durationHours", parseFloat(e.target.value) || 0)} /></Field>
        <Field label="Recurrence">
          <select style={inputStyle} value={f.recurrence} onChange={e => set("recurrence", e.target.value)}>
            {MAINTENANCE_RECURRENCE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        {f.recurrence !== "None" && (
          <Field label="Repeat until (optional)" hint={
            f.recurrence === "Monthly" ? "Leave blank to repeat indefinitely. Approximated as every 30 days."
            : f.recurrence === "Quarterly" ? "Leave blank to repeat indefinitely. Approximated as every 91 days."
            : f.recurrence === "Semi-annual" ? "Leave blank to repeat indefinitely. Approximated as every 182 days."
            : f.recurrence === "Annual" ? "Leave blank to repeat indefinitely. Approximated as every 365 days."
            : "Leave blank to repeat indefinitely within any forecast horizon"
          }>
            <input type="date" style={inputStyle} value={f.recurUntil} onChange={e => set("recurUntil", e.target.value)} />
          </Field>
        )}
        <Field label="Notes" span={2}><input style={inputStyle} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Parts, vendor, checklist reference…" /></Field>
      </div>
      {data.equipment.length === 0 && <div style={{ fontSize: 12, color: "#B87510", marginTop: 10 }}>Add equipment first before scheduling maintenance.</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save} style={{ opacity: data.equipment.length === 0 ? 0.5 : 1 }}>{existing ? "Save changes" : "Schedule maintenance"}</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Production Schedule Tab (shared - readOnly for operator view)
----------------------------------------------------------------*/

/* ---------------------------------------------------------------
   Production calendar

   Two ways of looking at the same orders:

   "Due dates" plots each order on the day it is promised. That is
   the commitment, and it is what the list view has always shown.

   "Capacity plan" plots where the work actually lands once orders
   are taken in arrival order and each is given the first slot where
   its machines are genuinely free. The gap between the two is the
   thing worth seeing - an order sitting well past its due-date
   marker is one the plant cannot currently deliver.
----------------------------------------------------------------*/

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function CalendarChip({ tone, children, title, onClick }) {
  const tones = {
    due: { bg: "#E8F0F1", fg: "#1F6F78", bd: "#BBD4D7" },
    ontime: { bg: "#E7F1EA", fg: "#2E7D5B", bd: "#BFDCCB" },
    late: { bg: "#FBECEA", fg: "#A32D2D", bd: "#E8C4BE" },
    maint: { bg: "#F3F1E9", fg: "#7A6B45", bd: "#DED8C4" },
    hours: { bg: "#EFEAF4", fg: "#5F4C7A", bd: "#D5CBE2" },
    done: { bg: "#EDF2F5", fg: "#2C5468", bd: "#C8D8E0" },
    // `late` is already defined above and serves the overdue case here too
    order: { bg: "#E8F0F1", fg: "#1F6F78", bd: "#BBD4D7" },
    expected: { bg: "#EFEAF4", fg: "#5F4C7A", bd: "#D5CBE2" }
  };
  const t = tones[tone] || tones.due;
  return (
    <div
      title={title}
      onClick={onClick}
      style={{
        background: t.bg, color: t.fg, border: "1px solid " + t.bd,
        borderRadius: 4, padding: "2px 5px", fontSize: 10.5, fontWeight: 600,
        marginBottom: 2, cursor: onClick ? "pointer" : "default",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"
      }}
    >
      {children}
    </div>
  );
}


/* ---------------------------------------------------------------
   Operating hours editor

   Two things live here: how many hours the plant runs on each day
   of the week, and the dates it is shut regardless. Both feed the
   capacity plan directly, so the summary at the bottom shows what
   the change means before it is saved.
----------------------------------------------------------------*/

const HOUR_PRESETS = [
  { label: "Single shift, Mon-Fri", hours: 8, days: [1, 2, 3, 4, 5] },
  { label: "Two shifts, Mon-Fri", hours: 16, days: [1, 2, 3, 4, 5] },
  { label: "Single shift, 6 days", hours: 8, days: [1, 2, 3, 4, 5, 6] },
  { label: "24/5", hours: 24, days: [1, 2, 3, 4, 5] },
  { label: "Continuous (24/7)", hours: 24, days: [0, 1, 2, 3, 4, 5, 6] }
];

/* A compact seven-day hour grid, shared by the base pattern and by
   each temporary block so the two read identically. */
function WeekHoursGrid({ value, onChange, compact }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: compact ? 5 : 8 }}>
      {WEEKDAY_KEYS.map((key, idx) => {
        const open = (Number(value[key]) || 0) > 0;
        return (
          <div key={key}>
            <div style={{ fontSize: compact ? 10 : 11, fontWeight: 700, color: "#5B6470", marginBottom: 3 }}>
              {WEEKDAY_LABELS[idx].slice(0, 3)}
            </div>
            <input
              type="number" min="0" max="24" step="0.5"
              value={value[key] === undefined ? 0 : value[key]}
              onChange={e => onChange(key, clamp(Number(e.target.value) || 0, 0, 24))}
              style={{
                ...inputStyle, width: "100%", textAlign: "center",
                padding: compact ? "5px 4px" : inputStyle.padding,
                fontSize: compact ? 12 : inputStyle.fontSize,
                background: open ? "#fff" : "#F4F6F2",
                color: open ? "#20262B" : "#9AA09A"
              }}
            />
          </div>
        );
      })}
    </div>
  );
}


/* ---------------------------------------------------------------
   Production targets

   A target belongs to a period at a chosen granularity, so a monthly
   target and a weekly one can coexist without either being derived
   from the other. Leaving the product blank sets a site-wide target
   for that period; naming a product sets one just for it.
----------------------------------------------------------------*/
function ProductionTargetsModal({ data, onClose, update }) {
  const [rows, setRows] = useState(() => (data.productionTargets || []).map(t => ({ ...t })));
  const [granularity, setGranularity] = useState("month");

  const productOptions = useMemo(() => [
    ...(data.intermediateProducts || []).map(i => ({ id: i.id, type: "intermediate", name: i.name })),
    ...(data.finishedGoods || []).map(f => ({ id: f.id, type: "finished", name: f.name }))
  ], [data]);

  const addRow = () => setRows(prev => [...prev, {
    id: uid(), periodType: granularity,
    periodKey: bucketKeyOf(todayStr(), granularity),
    productType: "", productId: "", targetQty: 0, notes: ""
  }]);
  const setRow = (idx, patch) => setRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r));
  const removeRow = (idx) => setRows(prev => prev.filter((_, i) => i !== idx));

  /* Periods to choose from, either side of today so both a look back and a
     commitment ahead are one click away. */
  const periodOptions = useMemo(() => {
    const anchor = todayStr();
    const keys = [];
    for (let i = -6; i <= 12; i++) {
      const d = granularity === "year" ? shiftISO(anchor, i * 365)
        : granularity === "month" ? shiftISO(anchor, i * 30)
        : shiftISO(anchor, i * 7);
      const k = bucketKeyOf(d, granularity);
      if (k && keys.indexOf(k) < 0) keys.push(k);
    }
    return keys.sort();
  }, [granularity]);

  const visible = rows.filter(r => r.periodType === granularity);

  const save = () => {
    const clean = rows.filter(r => r.periodKey && Number(r.targetQty) > 0);
    update(d => { d.productionTargets = clean.map(r => ({ ...r, targetQty: Number(r.targetQty) || 0 })); });
    onClose();
  };

  return (
    <Modal title="Production targets" onClose={onClose} wide>
      <div style={{ fontSize: 13, color: "#5B6470", marginBottom: 14 }}>
        Targets are drawn on the production chart as a dashed line for the period
        they cover — green where the period met it, red where it fell short.
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 4 }}>
          {GRANULARITIES.map(g => (
            <div key={g.key} role="button" tabIndex={0}
              onClick={() => setGranularity(g.key)}
              onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setGranularity(g.key); } }}
              style={{
                padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer",
                borderRadius: 6,
                background: granularity === g.key ? "#1F6F78" : "#fff",
                color: granularity === g.key ? "#fff" : "#5B6470",
                border: "1px solid " + (granularity === g.key ? "#1F6F78" : "#D7DAD3")
              }}>
              {g.label}
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <Btn variant="secondary" onClick={addRow} style={{ padding: "5px 10px", fontSize: 12 }}>
          <Plus size={13} />Add target
        </Btn>
      </div>

      {visible.length === 0 && (
        <div style={{ fontSize: 12.5, color: "#9AA09A", marginBottom: 14 }}>
          No {granularity === "year" ? "annual" : granularity + "ly"} targets set.
        </div>
      )}

      {visible.map((r) => {
        const idx = rows.indexOf(r);
        return (
          <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 7 }}>
            <select style={{ ...inputStyle, width: 132 }} value={r.periodKey}
              onChange={e => setRow(idx, { periodKey: e.target.value })}>
              {periodOptions.indexOf(r.periodKey) < 0 && <option value={r.periodKey}>{r.periodKey}</option>}
              {periodOptions.map(k => (
                <option key={k} value={k}>{bucketLabelOf(k, granularity)}</option>
              ))}
            </select>

            <select style={{ ...inputStyle, flex: 1 }} value={r.productId}
              onChange={e => {
                const opt = productOptions.find(o => o.id === e.target.value);
                setRow(idx, { productId: e.target.value, productType: opt ? opt.type : "" });
              }}>
              <option value="">All products (site total)</option>
              {productOptions.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>

            <input type="number" min="0" step="1" style={{ ...inputStyle, width: 108 }}
              value={r.targetQty}
              onChange={e => setRow(idx, { targetQty: e.target.value })}
              placeholder="Qty" />

            <input style={{ ...inputStyle, width: 168 }} value={r.notes || ""}
              onChange={e => setRow(idx, { notes: e.target.value })} placeholder="Note" />

            <IconBtn onClick={() => removeRow(idx)} title="Remove" danger>
              <Trash2 size={14} />
            </IconBtn>
          </div>
        );
      })}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>Save targets</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Amending a frozen run

   A frozen run cannot be edited through the ordinary form at all -
   repo.upsert refuses it. This is the only way through, and it wants
   a reason before it will do anything.
----------------------------------------------------------------*/
function AmendRunModal({ data, entry, onClose, update }) {
  const [qty, setQty] = useState(entry.qty);
  const [dueDate, setDueDate] = useState(entry.dueDate);
  const [reason, setReason] = useState("");
  const [author, setAuthor] = useState("");
  const [error, setError] = useState("");

  const changed = [];
  if (String(qty) !== String(entry.qty)) changed.push("quantity");
  if (String(dueDate) !== String(entry.dueDate)) changed.push("due date");

  const apply = () => {
    if (!changed.length) { setError("Nothing has been changed."); return; }
    if (!reason.trim()) { setError("A reason is required."); return; }
    let outcome = null;
    update(d => {
      outcome = tx.amendFrozenRun(d, {
        scheduleId: entry.id,
        changes: { qty: Number(qty) || 0, dueDate },
        reason, author, date: todayStr()
      });
    });
    if (outcome && !outcome.ok) { setError(outcome.error); return; }
    onClose();
  };

  const revisions = entry.revisions || [];

  return (
    <Modal title="Amend a frozen run" onClose={onClose} wide>
      <div style={{ padding: "10px 14px", marginBottom: 16, borderRadius: 8, fontSize: 13,
                    background: "#F3F1E9", border: "1px solid #DED8C4", color: "#6B5E3C" }}>
        <b>{productName(data, entry)}</b> was frozen on {fmtDate(entry.frozenDate)} at{" "}
        <b>{fmtNum(entry.baselineQty)}</b> due <b>{fmtDate(entry.baselineDueDate)}</b>.
        That baseline does not change — it is what performance is measured against.
        This records a deviation from it.
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }}>
        <Field label="Quantity" hint={"Committed: " + fmtNum(entry.baselineQty)}>
          <input type="number" min="0" style={inputStyle} value={qty}
            onChange={e => { setQty(e.target.value); setError(""); }} />
        </Field>
        <Field label="Due date" hint={"Committed: " + fmtDate(entry.baselineDueDate)}>
          <input type="date" style={inputStyle} value={dueDate}
            onChange={e => { setDueDate(e.target.value); setError(""); }} />
        </Field>
        <Field label="Reason" span={2} hint="Recorded permanently against this run">
          <input style={inputStyle} value={reason}
            onChange={e => { setReason(e.target.value); setError(""); }}
            placeholder="e.g. Customer reduced the order; material shortfall agreed with planning" />
        </Field>
        <Field label="Recorded by" span={2}>
          <input style={inputStyle} value={author}
            onChange={e => setAuthor(e.target.value)} placeholder="Your name or initials" />
        </Field>
      </div>

      {error && (
        <div style={{ padding: "8px 12px", marginBottom: 12, borderRadius: 7, fontSize: 12.5,
                      background: "#FCF4F3", border: "1px solid #E3B9B2", color: "#8C332B" }}>
          {error}
        </div>
      )}

      {revisions.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
            Change history ({revisions.length})
          </div>
          <div style={{ maxHeight: 170, overflowY: "auto", border: "1px solid #E7E9E4", borderRadius: 7 }}>
            {revisions.map(rev => (
              <div key={rev.id} style={{ padding: "7px 10px", borderBottom: "1px solid #F0F2EE", fontSize: 12 }}>
                <div>
                  <b>{rev.field === "qty" ? "Quantity" : rev.field === "dueDate" ? "Due date" : rev.field}</b>
                  {" "}{rev.fromValue || "\u2014"} \u2192 {rev.toValue || "\u2014"}
                  <span style={{ color: "#7A8079" }}> on {fmtDate(rev.at)}{rev.author ? " by " + rev.author : ""}</span>
                </div>
                <div style={{ color: "#5B6470", marginTop: 1 }}>{rev.reason}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={apply}>Record amendment</Btn>
      </div>
    </Modal>
  );
}



/* ---------------------------------------------------------------
   Operating hours

   The facility has a default calendar that everything follows unless
   told otherwise. Additional calendars exist so a machine on a second
   shift, or a bay that only runs weekends, can be scheduled honestly
   rather than being averaged into the site pattern. A machine picks
   one on its own record; the scheduler then gives a stage the hours
   its LEAST available machine offers.
----------------------------------------------------------------*/
function OperatingHoursModal({ data, onClose, update }) {
  const [cals, setCals] = useState(() => {
    const rows = (data.operatingCalendars || []).map(c => ({
      ...c,
      closures: (c.closures || []).map(x => ({ ...x })),
      overrides: (c.overrides || []).map(x => ({ ...x }))
    }));
    return rows.length ? rows : [{ ...CONTINUOUS_CALENDAR, id: uid() }];
  });
  const [selectedId, setSelectedId] = useState(() => {
    const rows = data.operatingCalendars || [];
    const def = rows.find(c => c.isDefault) || rows[0];
    return def ? def.id : null;
  });

  const idx = Math.max(0, cals.findIndex(c => c.id === selectedId));
  const f = cals[idx] || cals[0];

  const patch = (changes) => setCals(prev => prev.map((c, i) => i === idx ? { ...c, ...changes } : c));
  const setHours = (key, raw) => patch({ [key]: clamp(Number(raw) || 0, 0, 24) });
  const applyPreset = (p) => {
    const next = {};
    WEEKDAY_KEYS.forEach((k, di) => { next[k] = p.days.includes(di) ? p.hours : 0; });
    patch(next);
  };

  /* Which machines follow this calendar, and whether it is the fallback
     for everything that has not chosen one. */
  const usedBy = (data.equipment || []).filter(e => e.calendarId === f.id);
  const inherit = f.isDefault
    ? (data.equipment || []).filter(e => !e.calendarId)
    : [];

  const addCalendar = () => {
    const created = {
      id: uid(), name: "New shift pattern", isDefault: false,
      hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8,
      hoursSat: 0, hoursSun: 0, notes: "", closures: [], overrides: []
    };
    setCals(prev => [...prev, created]);
    setSelectedId(created.id);
  };

  /* Removing a calendar must not leave equipment pointing at nothing, so
     anything using it falls back to the default. The default itself cannot
     be removed while others exist - promote a different one first. */
  const removeCalendar = () => {
    if (cals.length < 2) return;
    if (f.isDefault) return;
    const goneId = f.id;
    setCals(prev => prev.filter(c => c.id !== goneId));
    setSelectedId((cals.find(c => c.isDefault) || cals[0]).id);
  };

  const makeDefault = () => setCals(prev => prev.map(c => ({ ...c, isDefault: c.id === f.id })));

  const addClosure = () => patch({
    closures: [...f.closures, { id: uid(), startDate: todayStr(), endDate: "", reason: "" }]
  });
  const updateClosure = (i, p) => patch({ closures: f.closures.map((c, j) => j === i ? { ...c, ...p } : c) });
  const removeClosure = (i) => patch({ closures: f.closures.filter((_, j) => j !== i) });

  const addOverride = () => patch({
    overrides: [...f.overrides, {
      id: uid(), startDate: todayStr(), endDate: addDays(todayStr(), 13), label: "",
      hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 0, hoursSun: 0
    }]
  });
  const updateOverride = (i, p) => patch({ overrides: f.overrides.map((o, j) => j === i ? { ...o, ...p } : o) });
  const removeOverride = (i) => patch({ overrides: f.overrides.filter((_, j) => j !== i) });
  const applyOverridePreset = (i, p) => patch({
    overrides: f.overrides.map((o, j) => {
      if (j !== i) return o;
      const next = { ...o };
      WEEKDAY_KEYS.forEach((k, di) => { next[k] = p.days.includes(di) ? p.hours : 0; });
      return next;
    })
  });

  const total = weeklyHours(f);
  const workable = calendarIsWorkable(f);
  const allWorkable = cals.every(calendarIsWorkable);

  const preview = useMemo(() => {
    if (!allWorkable) return null;
    try { return planScheduleFIFO({ ...data, operatingCalendars: cals }); } catch (err) { return null; }
  }, [data, cals, allWorkable]);
  const current = useMemo(() => {
    try { return planScheduleFIFO(data); } catch (err) { return null; }
  }, [data]);

  const save = () => {
    if (!allWorkable) return;
    const rows = cals.map(c => ({ ...c }));
    if (!rows.some(c => c.isDefault)) rows[0].isDefault = true;
    const liveIds = rows.map(c => c.id);
    update(d => {
      d.operatingCalendars = rows;
      // Clear any machine pointing at a calendar that no longer exists.
      (d.equipment || []).forEach(e => {
        if (e.calendarId && liveIds.indexOf(e.calendarId) < 0) e.calendarId = "";
      });
    });
    onClose();
  };

  return (
    <Modal title="Operating hours" onClose={onClose} wide>
      <div style={{ fontSize: 13, color: "#5B6470", marginBottom: 14 }}>
        How long the plant actually runs. The capacity plan spreads a job's hours
        across open days only — a 40-hour job takes a working week at 8 hours a
        day, not two days.
      </div>

      {/* calendar selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <select style={{ ...inputStyle, width: 232 }} value={f.id}
          onChange={e => setSelectedId(e.target.value)}>
          {cals.map(c => (
            <option key={c.id} value={c.id}>
              {c.name || "(unnamed)"}{c.isDefault ? "  — facility default" : ""}
            </option>
          ))}
        </select>
        <Btn variant="secondary" onClick={addCalendar} style={{ padding: "5px 10px", fontSize: 12 }}>
          <Plus size={13} />Add pattern
        </Btn>
        {!f.isDefault && cals.length > 1 && (
          <Btn variant="secondary" onClick={makeDefault} style={{ padding: "5px 10px", fontSize: 12 }}>
            Make default
          </Btn>
        )}
        {!f.isDefault && cals.length > 1 && (
          <IconBtn onClick={removeCalendar} title="Remove this pattern" danger>
            <Trash2 size={14} />
          </IconBtn>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
        <Field label="Pattern name">
          <input style={inputStyle} value={f.name || ""}
            onChange={e => patch({ name: e.target.value })}
            placeholder="e.g. Two shifts, Weekend crew" />
        </Field>
        <Field label="Notes">
          <input style={inputStyle} value={f.notes || ""}
            onChange={e => patch({ notes: e.target.value })} placeholder="Optional" />
        </Field>
      </div>

      <div style={{
        padding: "8px 12px", marginBottom: 14, borderRadius: 7, fontSize: 12.5,
        background: f.isDefault ? "#F1F6F2" : "#F4F6F9",
        border: "1px solid " + (f.isDefault ? "#CFE0D3" : "#DCE1E8"), color: "#5B6470"
      }}>
        {f.isDefault
          ? <>This is the <b>facility default</b>. {inherit.length} machine(s) follow it because they
             have not chosen their own{usedBy.length ? ", and " + usedBy.length + " point at it explicitly" : ""}.</>
          : usedBy.length
            ? <>Followed by <b>{usedBy.map(e => e.code || e.name).join(", ")}</b>.</>
            : <>No machine follows this pattern yet — assign it on an equipment record
               (Dashboard → Equipment → edit → Operating hours).</>}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {HOUR_PRESETS.map(p => (
          <Btn key={p.label} variant="secondary" onClick={() => applyPreset(p)}
               style={{ padding: "5px 10px", fontSize: 12 }}>
            {p.label}
          </Btn>
        ))}
      </div>

      <div style={{ marginBottom: 6 }}>
        <WeekHoursGrid value={f} onChange={(k, v) => setHours(k, v)} />
      </div>
      <div style={{ fontSize: 12, color: total > 0 ? "#5B6470" : "#A32D2D", marginBottom: 18 }}>
        {total > 0
          ? total + " hours a week across " + WEEKDAY_KEYS.filter(k => (Number(f[k]) || 0) > 0).length + " open day(s)"
          : "Every day is set to zero — nothing can be scheduled on this pattern until at least one day is open."}
      </div>

      {/* temporary changes */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>Temporary changes</div>
        <Btn variant="secondary" onClick={addOverride} style={{ padding: "5px 10px", fontSize: 12 }}>
          <Plus size={13} />Add a period
        </Btn>
      </div>
      <div style={{ fontSize: 12, color: "#7A8079", marginBottom: 10 }}>
        A different pattern for a fixed stretch — two weeks of 24/5 before dropping
        back. Outside these dates the weekly pattern above applies. Closures still
        win: a surge does not reopen the plant on a holiday.
      </div>
      {f.overrides.length === 0 && (
        <div style={{ fontSize: 12.5, color: "#9AA09A", marginBottom: 16 }}>
          No temporary changes — the weekly pattern applies throughout.
        </div>
      )}
      {f.overrides.map((o, i) => {
        const invalid = o.startDate && o.endDate && o.endDate < o.startDate;
        return (
          <div key={o.id} style={{
            border: "1px solid " + (invalid ? "#E3B9B2" : "#E7E9E4"),
            borderRadius: 8, padding: 12, marginBottom: 10, background: "#FBFCFA"
          }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <input type="date" value={o.startDate || ""}
                onChange={e => updateOverride(i, { startDate: e.target.value })}
                style={{ ...inputStyle, width: 148 }} />
              <span style={{ fontSize: 12, color: "#7A8079" }}>to</span>
              <input type="date" value={o.endDate || ""}
                onChange={e => updateOverride(i, { endDate: e.target.value })}
                style={{ ...inputStyle, width: 148 }} />
              <input placeholder="What is this for?" value={o.label || ""}
                onChange={e => updateOverride(i, { label: e.target.value })}
                style={{ ...inputStyle, flex: 1 }} />
              <IconBtn onClick={() => removeOverride(i)} title="Remove" danger>
                <Trash2 size={14} />
              </IconBtn>
            </div>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
              {HOUR_PRESETS.map(p => (
                <Btn key={p.label} variant="ghost" onClick={() => applyOverridePreset(i, p)}
                     style={{ padding: "3px 8px", fontSize: 11, border: "1px solid #D7DAD3" }}>
                  {p.label}
                </Btn>
              ))}
            </div>
            <WeekHoursGrid compact value={o} onChange={(k, v) => updateOverride(i, { [k]: v })} />
            <div style={{ fontSize: 11.5, color: invalid ? "#A32D2D" : "#7A8079", marginTop: 6 }}>
              {invalid
                ? "The end date is before the start date — this period will apply to the start date only."
                : weeklyHours(o) + " hours a week during this period, against " + total + " normally."}
            </div>
          </div>
        );
      })}
      {f.overrides.length > 1 && (
        <div style={{ fontSize: 11.5, color: "#9AA09A", marginBottom: 16 }}>
          Where two periods overlap, the lower one in this list takes effect.
        </div>
      )}

      {/* closures */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                    marginBottom: 8, marginTop: 18 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>Closures</div>
        <Btn variant="secondary" onClick={addClosure} style={{ padding: "5px 10px", fontSize: 12 }}>
          <Plus size={13} />Add closure
        </Btn>
      </div>
      <div style={{ fontSize: 12, color: "#7A8079", marginBottom: 8 }}>
        Shutdowns, holidays, anything that closes the plant on a date the weekly
        pattern would otherwise treat as open.
      </div>
      {f.closures.length === 0 && (
        <div style={{ fontSize: 12.5, color: "#9AA09A", marginBottom: 14 }}>No closures recorded.</div>
      )}
      {f.closures.map((c, i) => (
        <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
          <input type="date" value={c.startDate || ""}
            onChange={e => updateClosure(i, { startDate: e.target.value })}
            style={{ ...inputStyle, width: 150 }} />
          <span style={{ fontSize: 12, color: "#7A8079" }}>to</span>
          <input type="date" value={c.endDate || ""}
            onChange={e => updateClosure(i, { endDate: e.target.value })}
            style={{ ...inputStyle, width: 150 }} />
          <input placeholder="Reason" value={c.reason || ""}
            onChange={e => updateClosure(i, { reason: e.target.value })}
            style={{ ...inputStyle, flex: 1 }} />
          <IconBtn onClick={() => removeClosure(i)} title="Remove" danger>
            <Trash2 size={14} />
          </IconBtn>
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: "#9AA09A", marginTop: 4, marginBottom: 18 }}>
        Leave the second date blank for a single day.
      </div>

      {preview && current && (
        <div style={{
          padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 6,
          background: preview.lateCount > current.lateCount ? "#FCF4F3" : "#F1F6F2",
          border: "1px solid " + (preview.lateCount > current.lateCount ? "#E3B9B2" : "#CFE0D3")
        }}>
          <b>With these hours:</b> {preview.lateCount} of {preview.rows.length} open order(s) would
          finish after their due date
          {preview.worstLateDays > 0 && ", worst by " + preview.worstLateDays + " days"}.
          {current.lateCount !== preview.lateCount && (
            <span style={{ color: "#7A8079" }}> Currently {current.lateCount}.</span>
          )}
        </div>
      )}
      {!allWorkable && (
        <div style={{ padding: "8px 12px", marginBottom: 8, borderRadius: 7, fontSize: 12.5,
                      background: "#FCF4F3", border: "1px solid #E3B9B2", color: "#8C332B" }}>
          One or more patterns have no open hours at all. Open at least one day on each before saving.
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save} style={allWorkable ? undefined : { opacity: 0.5 }}>Save hours</Btn>
      </div>
    </Modal>
  );
}


function ProductionCalendar({ data, plan, mode, month, setMonth, onOpenEntry, onOpenBatch }) {
  const cells = useMemo(() => calendarGrid(month), [month]);
  const today = todayStr();

  /* Only assembled for the historic view - batchRecords walks every lot in
     the model and there is no reason to pay for that while looking at a
     forward plan. */
  const monthBatches = useMemo(() => {
    if (mode !== "actual") return [];
    const first = month + "-01";
    const cellDates = calendarGrid(month).map(c => c.date);
    return batchRecords(data, {
      from: cellDates[0], to: cellDates[cellDates.length - 1]
    });
  }, [data, mode, month]);

  /* date -> chips, built once per render rather than per cell. */
  const byDate = useMemo(() => {
    const map = {};
    const push = (date, chip) => { (map[date] = map[date] || []).push(chip); };

    if (mode === "actual") {
      monthBatches.forEach(b => {
        const out = b.outputs.filter(o => o.itemType !== "waste");
        const lead = out[0] || b.outputs[0];
        push(b.date, {
          tone: "done",
          label: (lead ? lead.lotNumber + " \u00b7 " : "") + b.processName,
          title: b.processName + "\n" +
            b.outputs.map(o => o.lotNumber + "  " + fmtNum(o.producedQty) + " " + o.unit).join("\n") +
            "\nMaterial " + fmtMoney(b.outputCost) +
            "\n" + fmtNum(b.equipmentHours) + "h equipment, " + fmtNum(b.labourHours) + "h labour",
          batchId: b.batchId
        });
      });
      return map;
    }

    if (mode === "due") {
      (data.schedule || []).forEach(entry => {
        if (entry.status === "Cancelled") return;
        push(entry.dueDate, {
          tone: entry.status === "Complete" ? "ontime" : "due",
          label: productName(data, entry) + " × " + entry.qty,
          title: entry.status + " — due " + fmtDate(entry.dueDate),
          entryId: entry.id
        });
      });
    } else {
      plan.rows.forEach(row => {
        row.stages.forEach(stage => {
          datesInRange(stage.start, stage.end).forEach((d, i) => {
            push(d, {
              tone: row.late ? "late" : "ontime",
              label: (i === 0 ? "" : "… ") + stage.processName,
              title: productName(data, row.entry) + " — " + stage.processName +
                "\n" + fmtDate(stage.start) + " to " + fmtDate(stage.end) +
                "\nDue " + fmtDate(row.dueDate) +
                (row.late ? "\nLATE by " + row.lateDays + " day(s)" : ""),
              entryId: row.entry.id
            });
          });
        });
        // the promise itself, so the gap is visible in the same view
        push(row.dueDate, {
          tone: row.late ? "late" : "due",
          label: "◆ due: " + productName(data, row.entry),
          title: "Due date for " + productName(data, row.entry),
          entryId: row.entry.id
        });
      });
      // Days where the plant is not on its normal pattern, so a surge or
      // a shutdown is visible in the same place the work is.
      const cal = plan.calendar || defaultCalendar(data);
      calendarGrid(month).forEach(cell => {
        const r = resolveHours(cal, cell.date);
        if (r.source === "override") {
          push(cell.date, {
            tone: "hours",
            label: "\u25d1 " + r.hours + "h" + (r.label ? " \u00b7 " + r.label : ""),
            title: (r.label || "Temporary hours") + "\n" + r.hours + " hours available, against the usual pattern",
            entryId: null
          });
        } else if (r.source === "closure") {
          push(cell.date, {
            tone: "maint",
            label: "\u2716 " + (r.label || "Closed"),
            title: "Plant closed \u2014 " + (r.label || ""),
            entryId: null
          });
        }
      });

      Object.entries(plan.load).forEach(([eqId, windows]) => {
        windows.filter(w => w.kind === "maintenance").forEach(w => {
          datesInRange(w.start, w.end).forEach(d => {
            const eq = getEquipment(data, eqId);
            push(d, {
              tone: "maint",
              label: "⚙ " + (eq ? eq.code : "equipment"),
              title: w.label + " — " + (eq ? eq.name : eqId),
              entryId: null
            });
          });
        });
      });
    }
    return map;
  }, [data, plan, mode, month, monthBatches]);

  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "10px 14px", borderBottom: "1px solid #EEF0EA" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Btn variant="secondary" onClick={() => setMonth(shiftMonth(month, -1))}
               style={{ padding: "5px 9px" }}>‹</Btn>
          <div style={{ fontWeight: 700, fontSize: 14, minWidth: 96, textAlign: "center" }}>
            {monthLabel(month)}
          </div>
          <Btn variant="secondary" onClick={() => setMonth(shiftMonth(month, 1))}
               style={{ padding: "5px 9px" }}>›</Btn>
          <Btn variant="ghost" onClick={() => setMonth(today.slice(0, 7))}
               style={{ padding: "5px 9px", fontSize: 12 }}>Today</Btn>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
        {WEEKDAYS.map(d => (
          <div key={d} style={{
            padding: "6px 8px", fontSize: 11, fontWeight: 700, color: "#7A8079",
            borderBottom: "1px solid #EEF0EA", textAlign: "center"
          }}>{d}</div>
        ))}
        {cells.map(cell => {
          const chips = byDate[cell.date] || [];
          const isToday = cell.date === today;
          return (
            <div key={cell.date} style={{
              minHeight: 92, padding: 5,
              borderRight: "1px solid #F1F3EF", borderBottom: "1px solid #F1F3EF",
              background: !cell.inMonth ? "#FAFBF9" : isToday ? "#F2F8F7" : "#fff",
              opacity: cell.inMonth ? 1 : 0.55
            }}>
              <div style={{
                fontSize: 11, fontWeight: isToday ? 800 : 600,
                color: isToday ? "#1F6F78" : "#7A8079", marginBottom: 3
              }}>
                {cell.day}
              </div>
              {chips.slice(0, 4).map((c, i) => (
                <CalendarChip key={i} tone={c.tone} title={c.title}
                  onClick={
                    c.batchId && onOpenBatch ? () => onOpenBatch(c.batchId)
                      : c.entryId && onOpenEntry ? () => onOpenEntry(c.entryId)
                      : undefined
                  }>
                  {c.label}
                </CalendarChip>
              ))}
              {chips.length > 4 && (
                <div style={{ fontSize: 10, color: "#9AA09A", paddingLeft: 2 }}>
                  +{chips.length - 4} more
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* One row per machine across the visible month, so an overloaded
   machine reads as a solid band rather than a number in a table. */
function EquipmentLanes({ data, plan, month }) {
  const cells = useMemo(() => calendarGrid(month).filter(c => c.inMonth), [month]);
  const today = todayStr();
  const equipment = data.equipment || [];
  if (!equipment.length) return null;

  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 14, marginTop: 14 }}>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>Equipment load</div>
      <div style={{ fontSize: 12, color: "#7A8079", marginBottom: 10 }}>
        Units committed each day against each machine's capacity. Solid means full.
      </div>
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 620 }}>
          {equipment.map(eq => {
            const windows = plan.load[eq.id] || [];
            const capacity = Math.max(1, Number(eq.units) || 1);
            return (
              <div key={eq.id} style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
                <div style={{ width: 118, flexShrink: 0, fontSize: 11.5, fontWeight: 600,
                              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                     title={eq.name + " — " + capacity + " unit(s)"}>
                  {eq.code || eq.name}
                  <span style={{ color: "#9AA09A", fontWeight: 500 }}> ×{capacity}</span>
                </div>
                <div style={{ display: "flex", gap: 1, flex: 1 }}>
                  {cells.map(cell => {
                    const onDay = windows.filter(w => cell.date >= w.start && cell.date <= w.end);
                    const used = onDay.length;
                    const maint = onDay.some(w => w.kind === "maintenance");
                    const late = onDay.some(w => w.late);
                    const ratio = Math.min(1, used / capacity);
                    const bg = used === 0 ? "#F4F6F2"
                      : maint ? "#D8CFB4"
                      : late ? "#D98C82"
                      : ratio >= 1 ? "#1F6F78"
                      : ratio >= 0.5 ? "#5FA8A0" : "#A9CFC9";
                    return (
                      <div key={cell.date}
                        title={cell.date + " — " + used + "/" + capacity + " unit(s)" +
                          (onDay.length ? "\n" + onDay.map(w => w.label).join("\n") : "")}
                        style={{
                          flex: 1, height: 17, background: bg, borderRadius: 2,
                          outline: cell.date === today ? "1.5px solid #20262B" : "none",
                          outlineOffset: -1.5
                        }} />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: "flex", gap: 14, marginTop: 10, fontSize: 11, color: "#5B6470", flexWrap: "wrap" }}>
        {[["#F4F6F2", "Idle"], ["#A9CFC9", "Light"], ["#5FA8A0", "Busy"],
          ["#1F6F78", "At capacity"], ["#D98C82", "Carrying a late order"], ["#D8CFB4", "Maintenance"]]
          .map(([c, l]) => (
            <div key={l} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 11, height: 11, background: c, borderRadius: 2, display: "inline-block" }} />
              {l}
            </div>
          ))}
      </div>
    </div>
  );
}


function ScheduleTab({ data, onAdd, onEdit, onDelete, readOnly, onEditHours, onFreeze, onAmend, onOpenBatch }) {
  const sorted = [...data.schedule].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const [layout, setLayout] = useState("calendar");
  const [calMode, setCalMode] = useState("plan");
  const [scaleByBatch, setScaleByBatch] = useState(false);
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));

  const plan = useMemo(
    () => planScheduleFIFO(data, { scaleByBatch }),
    [data, scaleByBatch]);

  const monthBatchCount = useMemo(() => {
    if (calMode !== "actual") return 0;
    const cells = calendarGrid(month);
    return batchRecords(data, { from: cells[0].date, to: cells[cells.length - 1].date }).length;
  }, [data, calMode, month]);

  const seg = (active) => ({
    padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer",
    background: active ? "#1F6F78" : "#fff", color: active ? "#fff" : "#5B6470",
    border: "1px solid " + (active ? "#1F6F78" : "#D7DAD3"), borderRadius: 6
  });

  return (
    <div>
      <PageHeader tabKey="schedule" subtitle={readOnly ? "View-only — changes are made by planning/admin" : "Planned and in-progress runs that drive the material, equipment and revenue forecasts"}
        action={!readOnly && <Btn onClick={onAdd}><Plus size={15} />Schedule a run</Btn>} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4 }}>
          <div role="button" tabIndex={0} onClick={() => setLayout("calendar")}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLayout("calendar"); } }}
            style={seg(layout === "calendar")}>Calendar</div>
          <div role="button" tabIndex={0} onClick={() => setLayout("list")}
            onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLayout("list"); } }}
            style={seg(layout === "list")}>List</div>
        </div>

        {layout === "calendar" && (
          <>
            <div style={{ display: "flex", gap: 4 }}>
              <div role="button" tabIndex={0} onClick={() => setCalMode("plan")}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCalMode("plan"); } }}
                style={seg(calMode === "plan")} title="Where the work lands once machine capacity is respected">
                Capacity plan (FIFO)
              </div>
              <div role="button" tabIndex={0} onClick={() => setCalMode("due")}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCalMode("due"); } }}
                style={seg(calMode === "due")} title="Each order plotted on the date it was promised">
                Due dates
              </div>
              <div role="button" tabIndex={0} onClick={() => setCalMode("actual")}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCalMode("actual"); } }}
                style={seg(calMode === "actual")} title="Batches that were actually run, on the day they were run">
                Completed
              </div>
            </div>
            {calMode === "actual" && (
              <span style={{ fontSize: 12, color: "#7A8079" }}>
                Historic record — what was run, not what is planned.
              </span>
            )}
            {calMode === "plan" && !readOnly && (
              <Btn variant="secondary" onClick={onEditHours}
                   style={{ padding: "5px 11px", fontSize: 12 }}>
                Operating hours: {weeklyHours(plan.calendar || defaultCalendar(data))}h/week
              </Btn>
            )}
            {calMode === "plan" && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#5B6470", cursor: "pointer" }}
                title="If a run of ten batches takes ten times as long as one, turn this on. Off means process time covers the whole run regardless of quantity, which is how the rest of the app reads it.">
                <input type="checkbox" checked={scaleByBatch}
                  onChange={e => setScaleByBatch(e.target.checked)} />
                Run time scales with batch count
              </label>
            )}
          </>
        )}
      </div>

      {layout === "calendar" && calMode === "actual" && (
        <div style={{
          display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center",
          padding: "10px 14px", marginBottom: 12, borderRadius: 8, fontSize: 13,
          background: "#EDF2F5", border: "1px solid #C8D8E0"
        }}>
          <div><b>{monthBatchCount}</b> batch record(s) this month</div>
          <div style={{ color: "#5B6470" }}>
            Click any run to open its full record.
          </div>
        </div>
      )}

      {layout === "calendar" && calMode === "plan" && (
        <div style={{
          display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center",
          padding: "10px 14px", marginBottom: 12, borderRadius: 8, fontSize: 13,
          background: (plan.lateCount || plan.unplaceableCount) ? "#FCF4F3" : "#F1F6F2",
          border: "1px solid " + ((plan.lateCount || plan.unplaceableCount) ? "#E3B9B2" : "#CFE0D3")
        }}>
          <div><b>{plan.rows.length}</b> open order(s)</div>
          <div style={{ color: "#5B6470" }}>
            {(plan.calendar && plan.calendar.name) || "Facility hours"} —
            {" " + weeklyHours(plan.calendar || defaultCalendar(data))}h/week
          </div>
          <div style={{ color: plan.lateCount ? "#A32D2D" : "#3C4340" }}>
            <b>{plan.lateCount}</b> finish after the due date
            {plan.worstLateDays > 0 && " (worst " + plan.worstLateDays + " days)"}
          </div>
          {plan.unplaceableCount > 0 && (
            <div style={{ color: "#A32D2D" }}>
              <b>{plan.unplaceableCount}</b> cannot be placed at all
            </div>
          )}
          {!plan.lateCount && !plan.unplaceableCount && (
            <div style={{ color: "#2E7D5B" }}>Every order fits within its due date.</div>
          )}
        </div>
      )}

      {layout === "calendar" && (
        <>
          <ProductionCalendar data={data} plan={plan} mode={calMode}
            month={month} setMonth={setMonth}
            onOpenEntry={readOnly ? null : onEdit}
            onOpenBatch={onOpenBatch} />
          {calMode === "plan" && <EquipmentLanes data={data} plan={plan} month={month} />}

          {calMode === "plan" && plan.rows.some(r => r.unplaceable) && (
            <div style={{ marginTop: 14, padding: 14, background: "#fff",
                          border: "1px solid #E3B9B2", borderRadius: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8, color: "#A32D2D" }}>
                Could not be placed
              </div>
              {plan.rows.filter(r => r.unplaceable).map(r => (
                <div key={r.entry.id} style={{ fontSize: 12.5, color: "#5B6470", marginBottom: 4 }}>
                  <b>{productName(data, r.entry)}</b> × {r.entry.qty} — {r.reason}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {layout === "list" && (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {sorted.map(entry => {
          const { segments, earliestOrderBy } = computeTimeline(data, entry);
          const overdue = earliestOrderBy && daysUntil(earliestOrderBy) < 0 && entry.status !== "Complete" && entry.status !== "Cancelled";
          const dueSoon = daysUntil(entry.dueDate) <= 7 && daysUntil(entry.dueDate) >= 0;
          const customer = entry.customerId ? getCustomer(data, entry.customerId) : null;
          const priceLine = customer && entry.productType === "finished" ? customer.priceList.find(p => p.finishedGoodId === entry.productId) : null;
          const unitPrice = priceLine ? getEffectivePrice(priceLine, entry.qty) : null;
          return (
            <div key={entry.id} style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {entry.productType === "finished" ? <Boxes size={14} color="#1F6F78" /> : <Layers size={14} color="#1F6F78" />}
                    <span style={{ fontWeight: 700, fontSize: 14 }}>{productName(data, entry)}</span>
                    <Badge tone={entry.status === "Complete" ? "good" : entry.status === "Cancelled" ? "neutral" : entry.status === "In progress" ? "info" : "neutral"}>{entry.status}</Badge>
                    {overdue && <Badge tone="bad">Order overdue</Badge>}
                    {!overdue && dueSoon && <Badge tone="warn">Due soon</Badge>}
                    {customer && <Badge tone="neutral">{customer.name}</Badge>}
                    {entry.frozen && <Badge tone="info">Frozen {fmtDate(entry.frozenDate)}</Badge>}
                    {(entry.revisions || []).length > 0 &&
                      <Badge tone="warn">{entry.revisions.length} amendment(s)</Badge>}
                  </div>
                  <div style={{ fontSize: 12, color: "#7A8079", marginTop: 4 }}>
                    Quantity <span className="mono">{fmtNum(entry.qty)}</span> · due <span className="mono">{fmtDate(entry.dueDate)}</span>
                    {earliestOrderBy && <span> · order raw materials by <span className="mono" style={{ fontWeight: 700, color: overdue ? "#8A2E20" : "#20262B" }}>{fmtDate(earliestOrderBy)}</span></span>}
                    {unitPrice != null && <span> · est. revenue <span className="mono" style={{ fontWeight: 700 }}>{fmtMoney(unitPrice * entry.qty)}</span></span>}
                  </div>
                  {entry.frozen && (String(entry.baselineQty) !== String(entry.qty) ||
                                    String(entry.baselineDueDate) !== String(entry.dueDate)) && (
                    <div style={{ fontSize: 12, color: "#8C6B45", marginTop: 3 }}>
                      Committed to <span className="mono">{fmtNum(entry.baselineQty)}</span> due{" "}
                      <span className="mono">{fmtDate(entry.baselineDueDate)}</span> — measured against that, not the figures above.
                    </div>
                  )}
                  {entry.notes && <div style={{ fontSize: 12, color: "#8A9099", marginTop: 4, fontStyle: "italic" }}>{entry.notes}</div>}
                </div>
                {!readOnly && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {!entry.frozen && onFreeze && entry.status !== "Cancelled" && (
                      <Btn variant="secondary" onClick={() => onFreeze(entry.id)}
                           style={{ padding: "4px 9px", fontSize: 11.5 }}>
                        Freeze plan
                      </Btn>
                    )}
                    {entry.frozen && onAmend && (
                      <Btn variant="secondary" onClick={() => onAmend(entry.id)}
                           style={{ padding: "4px 9px", fontSize: 11.5 }}>
                        Amend
                      </Btn>
                    )}
                    <IconBtn onClick={() => onEdit(entry.id)} title={entry.frozen ? "Edit notes, status and fulfilment" : "Edit"}><Pencil size={13} /></IconBtn>
                    <IconBtn onClick={() => onDelete(entry.id)} title="Delete" danger><Trash2 size={13} /></IconBtn>
                  </div>
                )}
              </div>
              <Timeline segments={segments} due={entry.dueDate} orderBy={earliestOrderBy} />
            </div>
          );
        })}
        {sorted.length === 0 && <div style={{ color: "#8A9099", padding: 24 }}>No production runs scheduled yet.</div>}
      </div>
      )}
    </div>
  );
}

function Timeline({ segments, due, orderBy }) {
  if (segments.length === 0) return null;
  const allDates = [...segments.map(s => s.start), ...segments.map(s => s.end), due];
  if (orderBy) allDates.push(orderBy);
  const min = allDates.reduce((a, b) => a < b ? a : b);
  const max = allDates.reduce((a, b) => a > b ? a : b);
  const span = Math.max(1, daysBetween(min, max));
  const pct = (d) => clamp((daysBetween(min, d) / span) * 100, 0, 100);
  const todayPct = pct(todayStr());

  return (
    <div style={{ marginTop: 14, position: "relative" }}>
      <div style={{ position: "relative", height: 22, background: "#EEF0EA", borderRadius: 5 }}>
        {orderBy && (
          <div title={"Order raw materials: " + fmtDate(orderBy)} style={{
            position: "absolute", left: pct(orderBy) + "%",
            width: Math.max(1.5, pct(segments[0].start) - pct(orderBy)) + "%",
            top: 0, bottom: 0, background: "#C9CFC0", borderRadius: 4
          }} />
        )}
        {segments.map((s, i) => (
          <div key={i} title={s.label + ": " + fmtDate(s.start) + " → " + fmtDate(s.end)} style={{
            position: "absolute", left: pct(s.start) + "%", width: Math.max(1.5, pct(s.end) - pct(s.start)) + "%",
            top: 0, bottom: 0, background: s.kind === "finished" ? "#1F6F78" : "#5FBFB0", borderRadius: 4
          }} />
        ))}
        <div title={"Today: " + fmtDate(todayStr())} style={{ position: "absolute", left: todayPct + "%", top: -3, bottom: -3, width: 2, background: "#B87510" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "#8A9099", marginTop: 4 }}>
        <span>{orderBy ? fmtDate(orderBy) : fmtDate(min)}</span>
        <span>Due {fmtDate(due)}</span>
      </div>
    </div>
  );
}

/* Does this customer have an agreed price for this product? Used to clear a
   customer that stops being valid when the product on a run is changed. */
function prevCustomerBuys(data, customerId, productId) {
  if (!customerId || !productId) return false;
  const c = getCustomer(data, customerId);
  return !!(c && (c.priceList || []).some(p => p.finishedGoodId === productId));
}

function ScheduleModal({ data, id, onClose, update }) {
  const existing = id ? data.schedule.find(s => s.id === id) : null;
  const allProducts = [
    ...data.finishedGoods.map(f => ({ id: f.id, type: "finished", label: f.name })),
    ...data.intermediateProducts.map(i => ({ id: i.id, type: "intermediate", label: i.name }))
  ];
  const [f, setF] = useState(existing ? structuredClone(existing) : {
    productType: allProducts[0] ? allProducts[0].type : "finished",
    productId: allProducts[0] ? allProducts[0].id : "",
    qty: 1, dueDate: addDays(todayStr(), 14), status: "Planned", notes: "", customerId: "",
    completedDate: "", createdDate: "", frozen: false, frozenDate: "",
    baselineQty: "", baselineDueDate: "", fulfillmentLots: [], revisions: []
  });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));
  const locked = !!(existing && existing.frozen);

  const applicableCustomers = data.customers.filter(c => c.priceList.some(p => p.finishedGoodId === f.productId));
  const product = f.productType === "finished" ? getFinished(data, f.productId) : getIntermediateProduct(data, f.productId);
  const productLots = product ? (product.lots || []).filter(l => (Number(l.qty) || 0) > 0) : [];
  const productUnit = product ? product.unit : "";

  const addFulfillmentLot = () => {
    if (productLots.length === 0) return;
    setF(prev => ({ ...prev, fulfillmentLots: [...prev.fulfillmentLots, { id: uid(), lotId: productLots[0].id, qty: 1 }] }));
  };
  const updateFulfillmentLot = (idx, patch) => setF(prev => ({ ...prev, fulfillmentLots: prev.fulfillmentLots.map((fl, i) => i === idx ? { ...fl, ...patch } : fl) }));
  const removeFulfillmentLot = (idx) => setF(prev => ({ ...prev, fulfillmentLots: prev.fulfillmentLots.filter((_, i) => i !== idx) }));

  const fulfilledQty = f.fulfillmentLots.reduce((s, fl) => s + (Number(fl.qty) || 0), 0);
  const completionBlocked = f.status === "Complete" && fulfilledQty < (Number(f.qty) || 0);
  const canSave = !!f.productId && !completionBlocked;

  const save = () => {
    if (!canSave) return;
    // Stamp the completion date the first time a run is marked Complete,
    // and clear it if the run is reopened - dueDate is a plan date and
    // cannot stand in for when the work actually finished.
    const record = { ...f };
    // A frozen run's committed figures are not editable here at all - the
    // guard in repo.upsert would refuse the write. Preserve them, and let the
    // amendment flow be the only way they move.
    if (existing && existing.frozen) {
      record.qty = existing.qty;
      record.dueDate = existing.dueDate;
      record.productId = existing.productId;
      record.productType = existing.productType;
      record.frozen = true;
      record.frozenDate = existing.frozenDate;
      record.baselineQty = existing.baselineQty;
      record.baselineDueDate = existing.baselineDueDate;
      record.revisions = existing.revisions || [];
    }
    // Arrival order drives FIFO planning, so stamp it once and never move it.
    if (!record.createdDate) record.createdDate = todayStr();
    if (record.status === "Complete") {
      if (!record.completedDate) record.completedDate = todayStr();
      // Capture the standard cost once, on completion. Expected-versus-actual
      // is only a real comparison if the expected side stops moving.
      if (!(Number(record.standardCostAtFulfillment) > 0)) {
        record.standardCostAtFulfillment =
          computeItemUnitCost(data, "finished", record.productId) || 0;
      }
    } else {
      record.completedDate = "";
      record.standardCostAtFulfillment = "";
    }
    update(d => repo.upsert(d, "schedule", existing ? id : null, record));
    onClose();
  };

  return (
    <Modal title={existing ? "Edit production run" : "Schedule a production run"} onClose={onClose} wide>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Product" span={2}>
          <select style={inputStyle} value={f.productId} onChange={e => {
            const chosen = allProducts.find(p => p.id === e.target.value);
            // A customer chosen for the previous product may have no price for
            // the new one. Leaving it selected creates a run that can never be
            // invoiced, so it is cleared rather than silently kept.
            const stillBuys = prevCustomerBuys(data, f.customerId, e.target.value);
            setF(prev => ({ ...prev, productId: e.target.value,
              productType: chosen ? chosen.type : prev.productType,
              customerId: stillBuys ? prev.customerId : "",
              fulfillmentLots: [] }));
          }}>
            {allProducts.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </Field>
        {locked && (
          <div style={{ gridColumn: "span 2", padding: "8px 12px", borderRadius: 7, fontSize: 12.5,
                        background: "#F3F1E9", border: "1px solid #DED8C4", color: "#6B5E3C" }}>
            This run was frozen on {fmtDate(existing.frozenDate)}, committing to{" "}
            <b>{fmtNum(existing.baselineQty)}</b> due <b>{fmtDate(existing.baselineDueDate)}</b>.
            Notes, status and fulfilment stay editable here; the committed figures need a
            recorded amendment.
          </div>
        )}
        <Field label="Quantity" hint={locked ? "Frozen \u2014 use Amend to change this" : undefined}>
          <input type="number" style={{ ...inputStyle, background: locked ? "#F4F6F2" : "#fff", color: locked ? "#7A8079" : "#20262B" }}
            value={f.qty} disabled={locked}
            onChange={e => set("qty", parseFloat(e.target.value) || 0)} />
        </Field>
        <Field label="Due date" hint={locked ? "Frozen \u2014 use Amend to change this" : undefined}>
          <input type="date" style={{ ...inputStyle, background: locked ? "#F4F6F2" : "#fff", color: locked ? "#7A8079" : "#20262B" }}
            value={f.dueDate} disabled={locked}
            onChange={e => set("dueDate", e.target.value)} />
        </Field>
        <Field label="Status" hint={completionBlocked ? undefined : "Complete requires enough fulfillment lots assigned below to cover the quantity"}>
          <select style={inputStyle} value={f.status} onChange={e => set("status", e.target.value)}>
            {STATUS_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        {f.productType === "finished" && (
          <Field label="Customer (optional)"
            hint={applicableCustomers.length
              ? "Only customers with an agreed price for this product"
              : "No customer has a price for this product \u2014 add one on the customer record"}>
            <select style={inputStyle} value={f.customerId || ""} onChange={e => set("customerId", e.target.value)}>
              <option value="">No customer assigned</option>
              {applicableCustomers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              {f.customerId && !applicableCustomers.some(c => c.id === f.customerId) && (
                <option value={f.customerId}>
                  {(getCustomer(data, f.customerId) || {}).name} \u2014 no price for this product
                </option>
              )}
            </select>
          </Field>
        )}
        <Field label="Notes" span={2}><input style={inputStyle} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Order reference, customer…" /></Field>
      </div>
      {allProducts.length === 0 && <div style={{ fontSize: 12, color: "#B87510", marginTop: 10 }}>Add an intermediate product or finished good before scheduling production.</div>}

      {f.productId && (
        <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 14, marginTop: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Fulfillment lots</div>
            <Btn variant="secondary" onClick={addFulfillmentLot}><Plus size={13} />Add lot</Btn>
          </div>
          <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
            Link the actual lot(s) that fulfill this order — tracked for actual revenue/COGS reporting, and required before this can be marked Complete. Doesn't deduct from lot quantities; that still only happens at shipment.
          </div>
          {f.fulfillmentLots.length === 0 && <div style={{ fontSize: 12, color: "#8A9099", marginBottom: 8 }}>No lots assigned yet.</div>}
          {f.fulfillmentLots.map((fl, idx) => (
            <div key={fl.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 28px", gap: 8, marginBottom: 8 }}>
              <select style={inputStyle} value={fl.lotId} onChange={e => updateFulfillmentLot(idx, { lotId: e.target.value })}>
                {productLots.length === 0 && <option value="">No lots with stock available</option>}
                {productLots.map(l => <option key={l.id} value={l.id}>{(l.lotNumber || "Lot") + " · " + fmtNum(l.qty) + " " + productUnit + " available"}</option>)}
              </select>
              <input type="number" step="0.01" style={inputStyle} value={fl.qty} onChange={e => updateFulfillmentLot(idx, { qty: parseFloat(e.target.value) || 0 })} />
              <IconBtn onClick={() => removeFulfillmentLot(idx)} title="Remove" danger><Trash2 size={13} /></IconBtn>
            </div>
          ))}
          <div style={{ fontSize: 12, color: "#5B6470", marginTop: 4 }}>
            Assigned: <span className="mono" style={{ fontWeight: 600 }}>{fmtNum(fulfilledQty)}</span> of <span className="mono" style={{ fontWeight: 600 }}>{fmtNum(f.qty)}</span> {productUnit}
          </div>
        </div>
      )}

      {completionBlocked && (
        <div style={{ background: "#F3DBD6", border: "1px solid #D97066", borderRadius: 8, padding: "10px 12px", marginTop: 14, fontSize: 12.5, color: "#8A2E20", fontWeight: 600 }}>
          This order needs {fmtNum((Number(f.qty) || 0) - fulfilledQty)} {productUnit} more assigned above before it can be marked Complete ({fmtNum(fulfilledQty)} of {fmtNum(f.qty)} assigned).
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save} style={{ opacity: canSave ? 1 : 0.5 }}>{existing ? "Save changes" : "Add to schedule"}</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   MRP Forecast Tab
----------------------------------------------------------------*/

/* ---------------------------------------------------------------
   Purchase order record

   Reached by clicking an order anywhere it appears, the same way a
   batch record opens from the production calendar.
----------------------------------------------------------------*/
function PurchaseOrderModal({ record, onClose }) {
  const r = record;
  const money = (n) => fmtMoney(n || 0);
  const tone = r.status === "Received" ? "good"
    : r.status === "Cancelled" ? "neutral"
    : r.overdue ? "bad" : "info";

  return (
    <Modal title={"Purchase order " + r.reference} onClose={onClose} wide>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", fontSize: 13,
                    padding: "9px 12px", marginBottom: 14, borderRadius: 7,
                    background: r.overdue ? "#FCF4F3" : "#F4F6F9",
                    border: "1px solid " + (r.overdue ? "#E3B9B2" : "#DCE1E8") }}>
        <div><b>{r.materialName}</b></div>
        <Badge tone={tone}>{r.status}</Badge>
        {r.overdue && <span style={{ color: "#A32D2D" }}>Past its expected date</span>}
        {r.late && <span style={{ color: "#8C6B45" }}>Delivered {r.daysLate} day(s) late</span>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 16 }}>
        {[["Ordered", fmtDate(r.orderDate)],
          ["Expected", fmtDate(r.expectedDate)],
          ["Actual", r.actualDate ? fmtDate(r.actualDate) : "\u2014"],
          ["Quantity", fmtNum(r.qty) + " " + r.unit],
          ["Received", fmtNum(r.receivedQty) + " " + r.unit],
          ["Outstanding", fmtNum(r.outstanding) + " " + r.unit]].map(([label, value]) => (
          <div key={label}>
            <div style={{ fontSize: 11, color: "#7A8079", fontWeight: 600 }}>{label}</div>
            <div className="mono" style={{ fontSize: 13.5 }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 20, fontSize: 13, marginBottom: 16 }}>
        <div><span style={{ color: "#7A8079" }}>Supplier </span><b>{r.supplier || "\u2014"}</b></div>
        <div><span style={{ color: "#7A8079" }}>Unit cost </span>
          <b className="mono">{money(r.unitCost)}</b></div>
        <div><span style={{ color: "#7A8079" }}>Order value </span>
          <b className="mono">{money(r.value)}</b></div>
      </div>

      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
        Deliveries ({r.receipts.length})
      </div>
      {r.receipts.length === 0 && (
        <div style={{ fontSize: 12.5, color: "#9AA09A" }}>Nothing received yet.</div>
      )}
      {r.receipts.map(rc => (
        <div key={rc.id} style={{ display: "flex", justifyContent: "space-between", gap: 10,
                                  fontSize: 12.5, marginBottom: 3 }}>
          <span className="mono">{fmtDate(rc.date)}</span>
          <span className="mono" style={{ color: "#5B6470" }}>
            {fmtNum(rc.qty)} {r.unit}
            {rc.lotId && r.raw && (() => {
              const lot = (r.raw.lots || []).find(l => l.id === rc.lotId);
              return lot ? <span style={{ color: "#7A8079" }}> \u2192 lot {lot.lotNumber}</span> : null;
            })()}
          </span>
        </div>
      ))}

      {r.po.notes && (
        <div style={{ fontSize: 12, color: "#8A9099", marginTop: 12, fontStyle: "italic" }}>
          {r.po.notes}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------
   Procurement calendar

   Three things share the grid, and keeping them distinct is the
   point: what was ordered, what is promised, and what actually
   turned up. An order promised after the material is needed is the
   one worth chasing, so it is coloured differently from one that is
   simply still in transit.
----------------------------------------------------------------*/
function ProcurementCalendar({ data, month, setMonth, mode, rawFilter, onOpenOrder }) {
  const cells = useMemo(() => calendarGrid(month), [month]);
  const today = todayStr();

  const byDate = useMemo(() => {
    const map = {};
    const push = (date, chip) => { if (date) (map[date] = map[date] || []).push(chip); };
    const first = cells[0].date, last = cells[cells.length - 1].date;

    purchaseOrderRecords(data, { rawMaterialId: rawFilter }).forEach(r => {
      const within = (d) => d && d >= first && d <= last;

      if ((mode === "all" || mode === "ordered") && within(r.orderDate)) {
        push(r.orderDate, {
          tone: "order",
          label: "\u2197 " + r.reference + " \u00b7 " + r.materialSku,
          title: "Ordered " + fmtNum(r.qty) + " " + r.unit + " of " + r.materialName +
            "\nExpected " + fmtDate(r.expectedDate),
          poId: r.po.id
        });
      }

      if ((mode === "all" || mode === "expected") && r.outstanding > 0 && within(r.expectedDate)) {
        push(r.expectedDate, {
          tone: r.overdue ? "late" : "expected",
          label: (r.overdue ? "\u26a0 " : "\u2193 ") + fmtNum(r.outstanding) + " " + r.unit +
            " \u00b7 " + r.materialSku,
          title: (r.overdue ? "OVERDUE \u2014 " : "Expected \u2014 ") + r.reference +
            "\n" + fmtNum(r.outstanding) + " " + r.unit + " of " + r.materialName +
            "\nOrdered " + fmtDate(r.orderDate),
          poId: r.po.id
        });
      }

      if (mode === "all" || mode === "received") {
        r.receipts.forEach(rc => {
          if (!within(rc.date)) return;
          push(rc.date, {
            tone: "done",
            label: "\u2713 " + fmtNum(rc.qty) + " " + r.unit + " \u00b7 " + r.materialSku,
            title: "Delivered \u2014 " + r.reference +
              "\n" + fmtNum(rc.qty) + " " + r.unit + " of " + r.materialName +
              (r.daysLate !== null && r.daysLate > 0 ? "\n" + r.daysLate + " day(s) late" : ""),
            poId: r.po.id
          });
        });
      }
    });
    return map;
  }, [data, cells, mode, rawFilter]);

  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8,
                    padding: "10px 14px", borderBottom: "1px solid #EEF0EA" }}>
        <Btn variant="secondary" onClick={() => setMonth(shiftMonth(month, -1))}
             style={{ padding: "5px 9px" }}>‹</Btn>
        <div style={{ fontWeight: 700, fontSize: 14, minWidth: 96, textAlign: "center" }}>
          {monthLabel(month)}
        </div>
        <Btn variant="secondary" onClick={() => setMonth(shiftMonth(month, 1))}
             style={{ padding: "5px 9px" }}>›</Btn>
        <Btn variant="ghost" onClick={() => setMonth(today.slice(0, 7))}
             style={{ padding: "5px 9px", fontSize: 12 }}>Today</Btn>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)" }}>
        {WEEKDAYS.map(d => (
          <div key={d} style={{ padding: "6px 8px", fontSize: 11, fontWeight: 700,
                                color: "#7A8079", borderBottom: "1px solid #EEF0EA", textAlign: "center" }}>{d}</div>
        ))}
        {cells.map(cell => {
          const chips = byDate[cell.date] || [];
          const isToday = cell.date === today;
          return (
            <div key={cell.date} style={{
              minHeight: 88, padding: 5,
              borderRight: "1px solid #F1F3EF", borderBottom: "1px solid #F1F3EF",
              background: !cell.inMonth ? "#FAFBF9" : isToday ? "#F2F8F7" : "#fff",
              opacity: cell.inMonth ? 1 : 0.55
            }}>
              <div style={{ fontSize: 11, fontWeight: isToday ? 800 : 600,
                            color: isToday ? "#1F6F78" : "#7A8079", marginBottom: 3 }}>
                {cell.day}
              </div>
              {chips.slice(0, 4).map((c, i) => (
                <CalendarChip key={i} tone={c.tone} title={c.title}
                  onClick={c.poId && onOpenOrder ? () => onOpenOrder(c.poId) : undefined}>
                  {c.label}
                </CalendarChip>
              ))}
              {chips.length > 4 && (
                <div style={{ fontSize: 10, color: "#9AA09A", paddingLeft: 2 }}>
                  +{chips.length - 4} more
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 14, padding: "9px 14px", flexWrap: "wrap",
                    fontSize: 11.5, color: "#5B6470", borderTop: "1px solid #EEF0EA" }}>
        {[["order", "Ordered"], ["expected", "Expected"], ["late", "Overdue"], ["done", "Delivered"]]
          .map(([t, label]) => (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 11, height: 11, borderRadius: 2, display: "inline-block",
                background: t === "order" ? "#E8F0F1" : t === "expected" ? "#EFEAF4"
                  : t === "late" ? "#FBECEA" : "#EDF2F5",
                border: "1px solid " + (t === "order" ? "#BBD4D7" : t === "expected" ? "#D5CBE2"
                  : t === "late" ? "#E8C4BE" : "#C8D8E0") }} />
              {label}
            </div>
          ))}
      </div>
    </div>
  );
}

function ForecastTab({ data, horizon, setHorizon, onOpenOrder }) {
  const [layout, setLayout] = useState("requirements");
  const [calMode, setCalMode] = useState("all");
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));
  const [rawFilter, setRawFilter] = useState("");
  const tr = useTimeRange(data, "12m");

  const poRecords = useMemo(() => purchaseOrderRecords(data), [data]);
  const openOrders = poRecords.filter(r => r.open);
  const overdueOrders = poRecords.filter(r => r.overdue);

  /* Ordered, expected and received are three different questions about the
     same orders, so they are separate series rather than one stacked total.
     Received is the bar - what actually happened - and expected is drawn as
     a line, the same convention the production chart uses. */
  const procSeries = [{ key: "received", label: "Delivered", color: "#1F6F78" }];
  const procRows = useMemo(() => {
    const rows = bucketEvents(
      purchaseReceivedEvents(data, rawFilter), tr.range, ["received"]);
    const exp = bucketEvents(purchaseExpectedEvents(data, rawFilter), tr.range, ["expected"]);
    const ord = bucketEvents(purchaseOrderedEvents(data, rawFilter), tr.range, ["ordered"]);
    const byKey = {}, ordByKey = {};
    exp.forEach(r => { byKey[r.key] = r.expected; });
    ord.forEach(r => { ordByKey[r.key] = r.ordered; });
    return rows.map(r => ({ ...r, expected: byKey[r.key] || 0, orderedQty: ordByKey[r.key] || 0 }));
  }, [data, tr.range, rawFilter]);

  const onTime = poRecords.filter(r => r.actualDate && !r.late).length;
  const delivered = poRecords.filter(r => r.actualDate).length;

  const active = data.schedule.filter(s => s.status === "Planned" || s.status === "In progress")
    .filter(s => daysUntil(s.dueDate) <= horizon);

  const rows = useMemo(() => {
    const gross = new Map();
    active.forEach(entry => {
      const totals = explodeToRaw(data, entry.productType, entry.productId, entry.qty);
      const { orderDates } = computeTimeline(data, entry);
      totals.forEach((qty, rawId) => {
        const rec = gross.get(rawId) || { qty: 0, earliestOrderBy: null, uses: [] };
        rec.qty += qty;
        rec.uses.push({ name: productName(data, entry), qty, due: entry.dueDate });
        const forThis = orderDates.filter(o => o.rawId === rawId);
        forThis.forEach(o => {
          if (!rec.earliestOrderBy || o.orderBy < rec.earliestOrderBy) rec.earliestOrderBy = o.orderBy;
        });
        gross.set(rawId, rec);
      });
    });
    return [...gross.entries()].map(([rawId, rec]) => {
      const raw = getRaw(data, rawId);
      if (!raw) return null;
      const stock = lotQty(raw.lots);
      // On-order comes from the orders themselves now, so it carries dates and
      // cannot drift from reality the way a hand-kept figure does.
      const onOrder = openOrderQty(data, raw.id);
      const net = rec.qty - stock - onOrder;
      const orders = purchaseOrderRecords(data, { rawMaterialId: raw.id }).filter(o => o.open);
      const nextArrival = orders.map(o => o.expectedDate).filter(Boolean).sort()[0] || "";
      return { raw, stock, onOrder, gross: rec.qty, net,
               earliestOrderBy: rec.earliestOrderBy, uses: rec.uses,
               openOrders: orders, nextArrival,
               // An arrival promised after the material is needed is the
               // shortage the forecast is really warning about.
               arrivesLate: !!(nextArrival && rec.earliestOrderBy && nextArrival > rec.earliestOrderBy) };
    }).filter(Boolean).sort((a, b) => (b.net > 0) - (a.net > 0) || (a.earliestOrderBy || "9999").localeCompare(b.earliestOrderBy || "9999"));
  }, [data, horizon]);

  const shortages = rows.filter(r => r.net > 0);

  const seg = (active) => ({
    padding: "5px 11px", fontSize: 12, fontWeight: 600, cursor: "pointer", borderRadius: 6,
    background: active ? "#1F6F78" : "#fff", color: active ? "#fff" : "#5B6470",
    border: "1px solid " + (active ? "#1F6F78" : "#D7DAD3")
  });

  return (
    <div>
      <PageHeader tabKey="forecast" subtitle="Raw material requirements exploded from your scheduled production, against stock on hand and what is on order"
        action={layout === "requirements" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ color: "#5B6470" }}>Horizon</span>
            <select style={{ ...inputStyle, width: 130 }} value={horizon} onChange={e => setHorizon(parseInt(e.target.value))}>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
            </select>
          </div>
        ) : null} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4 }}>
          {[["requirements", "Requirements"], ["calendar", "Delivery calendar"], ["history", "Delivery history"]]
            .map(([k, label]) => (
              <div key={k} role="button" tabIndex={0} onClick={() => setLayout(k)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setLayout(k); } }}
                style={seg(layout === k)}>{label}</div>
            ))}
        </div>
        {layout !== "requirements" && (
          <select style={{ ...inputStyle, width: 232 }} value={rawFilter}
            onChange={e => setRawFilter(e.target.value)}>
            <option value="">All materials</option>
            {(data.rawMaterials || []).map(r =>
              <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        )}
        {layout === "calendar" && (
          <div style={{ display: "flex", gap: 4 }}>
            {[["all", "Everything"], ["ordered", "Placed"], ["expected", "Expected"], ["received", "Delivered"]]
              .map(([k, label]) => (
                <div key={k} role="button" tabIndex={0} onClick={() => setCalMode(k)}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCalMode(k); } }}
                  style={seg(calMode === k)}>{label}</div>
              ))}
          </div>
        )}
        {layout === "history" && <TimeRangeControls state={tr} />}
      </div>

      <div style={{
        display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center",
        padding: "10px 14px", marginBottom: 14, borderRadius: 8, fontSize: 13,
        background: overdueOrders.length ? "#FCF4F3" : "#F1F6F2",
        border: "1px solid " + (overdueOrders.length ? "#E3B9B2" : "#CFE0D3")
      }}>
        <div><b>{openOrders.length}</b> open order(s)</div>
        {overdueOrders.length > 0
          ? <div style={{ color: "#A32D2D" }}>
              <b>{overdueOrders.length}</b> past their expected date
            </div>
          : <div style={{ color: "#2E7D5B" }}>Nothing overdue.</div>}
        {delivered > 0 && (
          <div style={{ color: "#5B6470" }}>
            {Math.round((onTime / delivered) * 100)}% of {delivered} deliveries arrived on time
          </div>
        )}
      </div>

      {layout === "calendar" && (
        <ProcurementCalendar data={data} month={month} setMonth={setMonth}
          mode={calMode} rawFilter={rawFilter} onOpenOrder={onOpenOrder} />
      )}

      {layout === "history" && (
        <ChartCard
          title={"Deliveries" + (rawFilter ? " \u2014 " + (getRaw(data, rawFilter) || {}).name : "")}
          subtitle="Quantity actually delivered, by the date it arrived. The line is what is still expected, on its promised date."
          rows={procRows} series={procSeries}
          limitKey="expected" limitLabel="Still expected" limitColor="#5F4C7A"
          emptyMessage="No deliveries in this period"
          footer={
            <div style={{ fontSize: 12, color: "#7A8079", marginTop: 8 }}>
              {delivered} order(s) delivered, {poRecords.filter(r => r.late).length} of them late.
              {" "}Expected quantities are outstanding balances only, so an order already
              received does not appear twice.
            </div>
          } />
      )}

      {layout !== "requirements" && openOrders.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10,
                      padding: 14, marginTop: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Open orders</div>
          {openOrders
            .filter(r => !rawFilter || r.po.rawMaterialId === rawFilter)
            .sort((a, b) => String(a.expectedDate).localeCompare(String(b.expectedDate)))
            .map(r => (
              <div key={r.po.id}
                role="button" tabIndex={0}
                onClick={() => onOpenOrder && onOpenOrder(r.po.id)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenOrder && onOpenOrder(r.po.id); } }}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 4px",
                         borderBottom: "1px solid #F0F2EE", cursor: "pointer", fontSize: 12.5 }}>
                <span className="mono" style={{ minWidth: 74 }}>{r.reference}</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis",
                               whiteSpace: "nowrap" }}>{r.materialName}</span>
                <span className="mono" style={{ color: "#5B6470" }}>
                  {fmtNum(r.outstanding)} {r.unit}
                </span>
                <span className="mono" style={{ minWidth: 92, textAlign: "right",
                        color: r.overdue ? "#A32D2D" : "#5B6470" }}>
                  {fmtDate(r.expectedDate)}
                </span>
                {r.overdue && <Badge tone="bad">Overdue</Badge>}
              </div>
            ))}
        </div>
      )}

      {layout === "requirements" && (
      <>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 18 }}>
        <MiniStat label="Production runs in window" value={active.length} />
        <MiniStat label="Materials with a shortfall" value={shortages.length} tone={shortages.length ? "bad" : "good"} />
        <MiniStat label="Total purchase value needed" value={fmtMoney(shortages.reduce((s, r) => s + r.net * r.raw.unitCost, 0))} />
      </div>

      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, overflow: "hidden" }}>
        <table className="mrp-table">
          <thead>
            <tr>
              <th>Raw material</th><th>Gross requirement</th><th>On hand</th><th>On order</th><th>Next arrival</th><th>Net to purchase</th><th>Order by</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const overdue = r.earliestOrderBy && daysUntil(r.earliestOrderBy) < 0 && r.net > 0;
              const soon = r.earliestOrderBy && daysUntil(r.earliestOrderBy) >= 0 && daysUntil(r.earliestOrderBy) <= 7 && r.net > 0;
              return (
                <tr key={r.raw.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{r.raw.name}</div>
                    <div className="mono" style={{ fontSize: 11, color: "#8A9099" }}>{r.raw.sku} · {r.raw.supplier}</div>
                  </td>
                  <td className="mono">{fmtNum(r.gross)} {r.raw.unit}</td>
                  <td className="mono">{fmtNum(r.stock)}</td>
                  <td className="mono">
                    {fmtNum(r.onOrder)}
                    {r.openOrders.length > 0 && (
                      <div style={{ fontSize: 10.5, color: "#8A9099" }}>
                        {r.openOrders.length} order(s)
                      </div>
                    )}
                  </td>
                  <td className="mono">
                    {r.nextArrival ? (
                      <span
                        role={onOpenOrder ? "button" : undefined}
                        tabIndex={onOpenOrder ? 0 : undefined}
                        onClick={onOpenOrder && r.openOrders[0]
                          ? () => onOpenOrder(r.openOrders[0].po.id) : undefined}
                        onKeyDown={e => {
                          if (!onOpenOrder || !r.openOrders[0]) return;
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenOrder(r.openOrders[0].po.id); }
                        }}
                        style={{
                          cursor: onOpenOrder ? "pointer" : "default",
                          // An arrival promised after the material is needed is
                          // the real shortage, even when the quantity covers it.
                          color: r.arrivesLate ? "#A32D2D" : "#3C4340",
                          fontWeight: r.arrivesLate ? 700 : 400
                        }}
                        title={r.arrivesLate
                          ? "Arrives after this material is needed"
                          : "Open the purchase order"}
                      >
                        {fmtDate(r.nextArrival)}
                      </span>
                    ) : "\u2014"}
                  </td>
                  <td className="mono" style={{ fontWeight: 700, color: r.net > 0 ? "#8A2E20" : "#1F5B3E" }}>{r.net > 0 ? fmtNum(r.net) : 0} {r.net > 0 ? r.raw.unit : ""}</td>
                  <td className="mono">{r.earliestOrderBy ? fmtDate(r.earliestOrderBy) : "—"}</td>
                  <td>
                    {r.net <= 0 && <Badge tone="good">Covered</Badge>}
                    {r.net > 0 && overdue && <Badge tone="bad">Order now</Badge>}
                    {r.net > 0 && soon && <Badge tone="warn">Order this week</Badge>}
                    {r.net <= 0 && r.arrivesLate && <Badge tone="warn">Arrives late</Badge>}
                    {r.net > 0 && !overdue && !soon && <Badge tone="info">Plan ahead</Badge>}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={8} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>No scheduled production within this horizon.</td></tr>}
          </tbody>
        </table>
      </div>
      </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Equipment Utilization Tab
----------------------------------------------------------------*/
function EquipmentUsageBars({ windows, horizonDays }) {
  const viewStart = todayStr();
  const viewEnd = addDays(viewStart, horizonDays);
  const span = Math.max(1, daysBetween(viewStart, viewEnd));
  const pct = (d) => clamp((daysBetween(viewStart, d) / span) * 100, 0, 100);
  const sorted = [...windows].sort((a, b) => a.start.localeCompare(b.start));
  return (
    <div>
      {sorted.map((w, idx) => (
        <div key={idx} style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "#5B6470", marginBottom: 3 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {w.label}
              <Badge tone={w.status === "In-Use" ? "info" : w.status === "Blocked" ? "warn" : "bad"}>{w.status}</Badge>
            </span>
            <span className="mono">{fmtDate(w.start)} – {fmtDate(w.end)}</span>
          </div>
          <div style={{ position: "relative", height: 10, background: "#EEF0EA", borderRadius: 4 }}>
            <div style={{
              position: "absolute", left: pct(w.start) + "%", width: Math.max(1.5, pct(w.end) - pct(w.start)) + "%",
              top: 0, bottom: 0, borderRadius: 4,
              background: w.status === "In-Use" ? "#5FBFB0" : w.status === "Blocked" ? "#EFC77A" : "#D97066"
            }} />
          </div>
        </div>
      ))}
    </div>
  );
}


/* ---------------------------------------------------------------
   Batch records

   The lot tables answer "what stock do I have". This answers "what
   runs did we do" - one row per execution of a process, with what
   went in, what came out, the hours booked against it, and what the
   material cost worked out at.

   Input and output cost should always balance: every penny of input
   lands on the outputs. Where a batch produced a by-product as well
   as good material, the by-product carries no material cost, so the
   whole input value lands on the saleable output. That is a choice,
   and it is stated in the footer rather than left implicit.
----------------------------------------------------------------*/
/* The full record of one run, opened from the calendar. The same content the
   Batch records tab shows when a row is expanded, in a dialog so it can be
   reached from wherever the run appears. */
function BatchRecordModal({ record, onClose }) {
  const money = (n) => fmtMoney(n || 0);
  const r = record;
  return (
    <Modal title={"Batch record \u2014 " + r.processName} onClose={onClose} wide>
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 13,
                    padding: "9px 12px", marginBottom: 14, borderRadius: 7,
                    background: "#EDF2F5", border: "1px solid #C8D8E0" }}>
        <div><b>{fmtDate(r.date)}</b></div>
        <div style={{ color: "#5B6470" }}>{money(r.outputCost)} of material</div>
        <div style={{ color: "#5B6470" }}>
          {fmtNum(r.equipmentHours)}h equipment \u00b7 {fmtNum(r.labourHours)}h labour
        </div>
        {r.qcChecks > 0 && <div style={{ color: "#5B6470" }}>{r.qcChecks} QC check(s)</div>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Consumed</div>
          {r.inputs.length === 0 && <div style={{ fontSize: 12, color: "#9AA09A" }}>No inputs recorded.</div>}
          {r.inputs.map((i, k) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10,
                                  fontSize: 12, marginBottom: 3 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {i.itemName}
                {i.lotNumber && <span className="mono" style={{ color: "#7A8079" }}> {i.lotNumber}</span>}
              </span>
              <span className="mono" style={{ whiteSpace: "nowrap", color: "#5B6470" }}>
                {fmtNum(i.qty)} {i.unit} @ {money(i.unitCost)}
              </span>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Produced</div>
          {r.outputs.map((o, k) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10,
                                  fontSize: 12, marginBottom: 3 }}>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {o.itemName}
                <span className="mono" style={{ color: "#7A8079" }}> {o.lotNumber}</span>
                {o.itemType === "waste" && <span style={{ color: "#9AA09A" }}> (by-product)</span>}
              </span>
              <span className="mono" style={{ whiteSpace: "nowrap", color: "#5B6470" }}>
                {fmtNum(o.producedQty)} {o.unit}
                {o.remainingQty > 0 && <span style={{ color: "#2E7D5B" }}> \u00b7 {fmtNum(o.remainingQty)} left</span>}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 14 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Equipment</div>
          {r.equipment.length === 0 && <div style={{ fontSize: 12, color: "#9AA09A" }}>None recorded.</div>}
          {r.equipment.map((e, k) => (
            <div key={k} style={{ fontSize: 12 }}>
              {e.eq ? (e.eq.code || e.eq.name) : "(deleted)"}
              <span className="mono" style={{ color: "#5B6470" }}> {fmtNum(e.hours)}h</span>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Labour</div>
          {r.labour.length === 0 && <div style={{ fontSize: 12, color: "#9AA09A" }}>None recorded.</div>}
          {r.labour.map((l, k) => (
            <div key={k} style={{ fontSize: 12 }}>
              {l.operatorName || "(unnamed)"}
              <span className="mono" style={{ color: "#5B6470" }}> {fmtNum(l.hours)}h</span>
            </div>
          ))}
        </div>
      </div>

      {r.notes && (
        <div style={{ fontSize: 12, color: "#8A9099", marginTop: 12, fontStyle: "italic" }}>{r.notes}</div>
      )}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
      </div>
    </Modal>
  );
}


/* ---------------------------------------------------------------
   Process flow

   Drawn from the process definitions, so it cannot drift from them.
   Stock is shown on every node, which is what turns a diagram into
   a planning tool: the question before raising a run is always
   whether the stage below already has enough.
----------------------------------------------------------------*/
function ProcessFlowTab({ data, onOpenProcess }) {
  const graph = useMemo(() => processGraph(data), [data]);
  const [targetKey, setTargetKey] = useState("");
  const [targetQty, setTargetQty] = useState(1000);

  const targets = useMemo(() => [
    ...(data.finishedGoods || []).map(f => ({ key: "finished:" + f.id, name: f.name, group: "Finished goods" })),
    ...(data.intermediateProducts || []).map(i => ({ key: "intermediate:" + i.id, name: i.name, group: "Intermediate products" }))
  ], [data]);

  const coverage = useMemo(() => {
    if (!targetKey) return null;
    const sep = targetKey.indexOf(":");
    return coverageSummary(data, targetKey.slice(0, sep), targetKey.slice(sep + 1), Number(targetQty) || 0);
  }, [data, targetKey, targetQty]);

  /* Which nodes the current plan touches, so the diagram can dim everything
     that has nothing to do with the question being asked. */
  const inPlan = useMemo(() => {
    if (!coverage) return null;
    const map = {};
    coverage.rows.forEach(r => { map[r.key] = r; });
    return map;
  }, [coverage]);

  const COL_W = 178, ROW_H = 62, PAD_X = 14, PAD_Y = 18;
  const height = PAD_Y * 2 + Math.max(1, ...graph.layers.map(L => L.length)) * ROW_H;
  const width = PAD_X * 2 + Math.max(1, graph.layers.length) * COL_W;

  const pos = {};
  graph.layers.forEach((layer, d) => layer.forEach((n, i) => {
    pos[n.key] = { x: PAD_X + d * COL_W, y: PAD_Y + i * ROW_H };
  }));

  const NODE_W = 150, NODE_H = 44;
  const toneOf = (n) => {
    if (inPlan) {
      const r = inPlan[n.key];
      if (!r) return { fill: "#F7F8F6", stroke: "#E2E4DD", text: "#B4B9B2", dim: true };
      if (r.action === "use-stock") return { fill: "#EAF3EC", stroke: "#9EC7AC", text: "#1F5B3E" };
      if (r.action === "purchase") return { fill: "#EFEAF4", stroke: "#C0B2D4", text: "#5F4C7A" };
      if (r.action === "blocked") return { fill: "#FBECEA", stroke: "#D9A29A", text: "#A32D2D" };
      return { fill: "#FCF3E6", stroke: "#D9BE8C", text: "#8C6B45" };
    }
    if (n.itemType === "raw") return { fill: "#EFF3F6", stroke: "#C3CDD6", text: "#3C4C58" };
    if (n.itemType === "finished") return { fill: "#E8F0F1", stroke: "#9FC4C8", text: "#1F6F78" };
    return { fill: "#F4F6F2", stroke: "#CBD4C6", text: "#4A5A48" };
  };

  return (
    <div>
      <PageHeader tabKey="flow"
        subtitle="Read from the process definitions \u2014 every arrow is a process, every box an item with its stock on hand" />

      <div style={{ display: "flex", alignItems: "flex-end", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <Field label="Plan for">
          <select style={{ ...inputStyle, width: 260 }} value={targetKey}
            onChange={e => setTargetKey(e.target.value)}>
            <option value="">Show the whole flow</option>
            <optgroup label="Finished goods">
              {targets.filter(t => t.group === "Finished goods").map(t =>
                <option key={t.key} value={t.key}>{t.name}</option>)}
            </optgroup>
            <optgroup label="Intermediate products">
              {targets.filter(t => t.group === "Intermediate products").map(t =>
                <option key={t.key} value={t.key}>{t.name}</option>)}
            </optgroup>
          </select>
        </Field>
        {targetKey && (
          <Field label="Quantity">
            <input type="number" style={{ ...inputStyle, width: 130 }} value={targetQty}
              onChange={e => setTargetQty(parseFloat(e.target.value) || 0)} />
          </Field>
        )}
        {targetKey && (
          <Btn variant="secondary" onClick={() => setTargetKey("")}
               style={{ padding: "6px 12px", fontSize: 12 }}>Clear</Btn>
        )}
      </div>

      {coverage && (
        <div style={{
          display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center",
          padding: "10px 14px", marginBottom: 14, borderRadius: 8, fontSize: 13,
          background: coverage.alreadyCovered ? "#F1F6F2"
            : coverage.blocked.length ? "#FCF4F3" : "#FBFAF6",
          border: "1px solid " + (coverage.alreadyCovered ? "#CFE0D3"
            : coverage.blocked.length ? "#E3B9B2" : "#E4DFD2")
        }}>
          {coverage.alreadyCovered ? (
            <div style={{ color: "#1F5B3E" }}>
              <b>Stock already covers this.</b> No run is needed \u2014 there is
              {" "}{fmtNum(coverage.target.onHand)} {coverage.target.unit} on hand.
            </div>
          ) : (
            <>
              <div><b>{coverage.toMake.length}</b> stage(s) to make</div>
              <div style={{ color: "#1F5B3E" }}>
                <b>{coverage.fromStock.length}</b> covered by existing stock
              </div>
              {coverage.toPurchase.length > 0 && (
                <div style={{ color: "#5F4C7A" }}>
                  <b>{coverage.toPurchase.length}</b> to purchase
                </div>
              )}
              {coverage.blocked.length > 0 && (
                <div style={{ color: "#A32D2D" }}>
                  <b>{coverage.blocked.length}</b> with no process defined
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10,
                    padding: 12, overflowX: "auto", marginBottom: 14 }}>
        <svg viewBox={"0 0 " + width + " " + height}
             style={{ width: "100%", minWidth: Math.min(width, 1100), height }}>
          {/* edges first so nodes sit on top */}
          {graph.edges.map((e, i) => {
            if (!e.from || !pos[e.from] || !pos[e.to]) return null;
            const a = pos[e.from], b = pos[e.to];
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
            const x2 = b.x, y2 = b.y + NODE_H / 2;
            const mid = (x1 + x2) / 2;
            const lit = !inPlan || (inPlan[e.from] && inPlan[e.to]);
            return (
              <path key={i}
                d={"M" + x1 + "," + y1 + " C" + mid + "," + y1 + " " + mid + "," + y2 + " " + x2 + "," + y2}
                fill="none" stroke={lit ? "#B4BDB2" : "#EDEFEA"}
                strokeWidth={lit ? 1.3 : 1} />
            );
          })}

          {graph.layers.map((layer, d) => layer.map(n => {
            const p = pos[n.key];
            const t = toneOf(n);
            const r = inPlan ? inPlan[n.key] : null;
            return (
              <g key={n.key} transform={"translate(" + p.x + "," + p.y + ")"}>
                <rect width={NODE_W} height={NODE_H} rx="6"
                      fill={t.fill} stroke={t.stroke} strokeWidth="1.2" />
                <text x="8" y="17" fontSize="10.5" fontWeight="700" fill={t.text}
                      fontFamily="'IBM Plex Sans', sans-serif">
                  {String(n.sku || n.name).slice(0, 20)}
                </text>
                <text x="8" y="30" fontSize="9.5" fill={t.dim ? "#C2C7C0" : "#7A8079"}
                      fontFamily="'IBM Plex Sans', sans-serif">
                  {String(n.name).slice(0, 24)}
                </text>
                <text x="8" y="40" fontSize="9.5" fill={t.dim ? "#C2C7C0" : "#5B6470"}
                      fontFamily="'IBM Plex Mono', monospace">
                  {fmtNum(Math.round(n.stock))} {n.unit} in stock
                </text>
                {r && r.action === "make" && (
                  <text x={NODE_W - 8} y="17" textAnchor="end" fontSize="9.5"
                        fontWeight="700" fill="#8C6B45"
                        fontFamily="'IBM Plex Mono', monospace">
                    make {fmtNum(Math.round(r.shortfall))}
                  </text>
                )}
                {r && r.action === "use-stock" && (
                  <text x={NODE_W - 8} y="17" textAnchor="end" fontSize="9.5"
                        fontWeight="700" fill="#1F5B3E"
                        fontFamily="'IBM Plex Sans', sans-serif">
                    covered
                  </text>
                )}
                {r && r.action === "purchase" && (
                  <text x={NODE_W - 8} y="17" textAnchor="end" fontSize="9.5"
                        fontWeight="700" fill="#5F4C7A"
                        fontFamily="'IBM Plex Mono', monospace">
                    buy {fmtNum(Math.round(r.shortfall))}
                  </text>
                )}
              </g>
            );
          }))}
        </svg>
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5,
                    color: "#5B6470", marginBottom: 16 }}>
        {(inPlan
          ? [["#EAF3EC", "Covered by stock"], ["#FCF3E6", "Needs making"],
             ["#EFEAF4", "Needs buying"], ["#FBECEA", "No process defined"],
             ["#F7F8F6", "Not in this plan"]]
          : [["#EFF3F6", "Purchased"], ["#F4F6F2", "Intermediate"], ["#E8F0F1", "Finished"]]
        ).map(([c, label]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 11, height: 11, borderRadius: 2, background: c,
                           border: "1px solid #D7DAD3", display: "inline-block" }} />
            {label}
          </div>
        ))}
      </div>

      {coverage && !coverage.alreadyCovered && (
        <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10,
                      overflow: "hidden" }}>
          <div style={{ padding: "11px 14px", borderBottom: "1px solid #EEF0EA" }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>What this would take</div>
            <div style={{ fontSize: 12, color: "#7A8079", marginTop: 2 }}>
              The walk stops wherever stock already covers the requirement, so only
              genuinely missing stages appear as work.
            </div>
          </div>
          <table className="mrp-table">
            <thead>
              <tr><th>Stage</th><th>Item</th><th>Required</th><th>On hand</th>
                  <th>Short</th><th>Action</th><th>Process</th></tr>
            </thead>
            <tbody>
              {coverage.rows.map((r, i) => (
                <tr key={r.key + i}>
                  <td className="mono" style={{ color: "#8A9099" }}>{r.depth}</td>
                  <td style={{ paddingLeft: 8 + r.depth * 12 }}>{r.name}</td>
                  <td className="mono">{fmtNum(Math.round(r.required))} {r.unit}</td>
                  <td className="mono">{fmtNum(Math.round(r.onHand))}</td>
                  <td className="mono" style={{ fontWeight: 700,
                        color: r.shortfall > 0 ? "#8C6B45" : "#1F5B3E" }}>
                    {r.shortfall > 0 ? fmtNum(Math.round(r.shortfall)) : "\u2014"}
                  </td>
                  <td>
                    {r.action === "use-stock" && <Badge tone="good">Use stock</Badge>}
                    {r.action === "make" && <Badge tone="warn">Make</Badge>}
                    {r.action === "purchase" && <Badge tone="info">Purchase</Badge>}
                    {r.action === "blocked" && <Badge tone="bad">No process</Badge>}
                  </td>
                  <td style={{ fontSize: 12, color: "#5B6470" }}>
                    {r.process ? (
                      <span
                        role={onOpenProcess ? "button" : undefined}
                        tabIndex={onOpenProcess ? 0 : undefined}
                        onClick={onOpenProcess ? () => onOpenProcess(r.process.id) : undefined}
                        onKeyDown={e => {
                          if (!onOpenProcess) return;
                          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenProcess(r.process.id); }
                        }}
                        style={{ cursor: onOpenProcess ? "pointer" : "default",
                                 color: onOpenProcess ? "#1F6F78" : "#5B6470",
                                 textDecoration: onOpenProcess ? "underline" : "none" }}>
                        {r.processName}
                      </span>
                    ) : r.processName}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {graph.cyclic && (
        <div style={{ padding: "9px 12px", marginTop: 14, borderRadius: 7, fontSize: 12.5,
                      background: "#FCF4F3", border: "1px solid #E3B9B2", color: "#8C332B" }}>
          The process definitions contain a loop \u2014 something is defined as an input
          to a process that eventually produces it. Depths are approximate until that
          is resolved.
        </div>
      )}
    </div>
  );
}

function BatchRecordsTab({ data }) {
  const tr = useTimeRange(data, "13w");
  const [procFilter, setProcFilter] = useState("");
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState(null);

  const records = useMemo(
    () => batchRecords(data, { from: tr.range.from, to: tr.range.to, processId: procFilter }),
    [data, tr.range, procFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;
    return records.filter(r =>
      String(r.processName).toLowerCase().includes(q) ||
      r.outputs.some(o => String(o.lotNumber).toLowerCase().includes(q) ||
                          String(o.itemName).toLowerCase().includes(q)) ||
      r.inputs.some(i => String(i.lotNumber).toLowerCase().includes(q)));
  }, [records, search]);

  const totalCost = filtered.reduce((s, r) => s + r.outputCost, 0);
  const totalEqHours = filtered.reduce((s, r) => s + r.equipmentHours, 0);
  const anyEstimated = filtered.some(r => r.estimated);

  const money = (n) => fmtMoney(n || 0);

  return (
    <div>
      <PageHeader tabKey="batches"
        subtitle="Every logged run of a process, with the lots consumed, the lots produced, hours booked, and the material cost that rolled up"
        action={<SearchBox value={search} onChange={setSearch} placeholder="Lot or process…" />} />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <TimeRangeControls state={tr} />
        <select style={{ ...inputStyle, width: 250 }} value={procFilter}
          onChange={e => setProcFilter(e.target.value)}>
          <option value="">All processes</option>
          {(data.processes || []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))
            .map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div style={{
        display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center",
        padding: "10px 14px", marginBottom: 14, borderRadius: 8, fontSize: 13,
        background: "#F1F6F2", border: "1px solid #CFE0D3"
      }}>
        <div><b>{filtered.length}</b> batch record(s)</div>
        <div style={{ color: "#5B6470" }}>{money(totalCost)} of material through them</div>
        <div style={{ color: "#5B6470" }}>{fmtNum(Math.round(totalEqHours))} equipment hours booked</div>
        {anyEstimated && (
          <div style={{ color: "#8C6B45" }}>
            Some costs are estimated — an upstream lot has no recorded price.
          </div>
        )}
      </div>

      {filtered.length === 0 && (
        <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10,
                      padding: 24, color: "#8A9099" }}>
          No batches logged in this period.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.slice(0, 200).map(r => {
          const open = openId === r.batchId;
          return (
            <div key={r.batchId} style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10 }}>
              <div
                role="button" tabIndex={0}
                onClick={() => setOpenId(open ? null : r.batchId)}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenId(open ? null : r.batchId); } }}
                style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", cursor: "pointer" }}
              >
                {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <div style={{ minWidth: 92, fontSize: 12.5, color: "#5B6470" }} className="mono">
                  {fmtDate(r.date)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, overflow: "hidden",
                                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.processName}
                  </div>
                  <div style={{ fontSize: 12, color: "#7A8079", overflow: "hidden",
                                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {r.outputs.map(o => o.lotNumber + " · " + fmtNum(o.producedQty) + " " + o.unit).join("   ")}
                  </div>
                </div>
                <div style={{ textAlign: "right", fontSize: 12.5 }}>
                  <div className="mono" style={{ fontWeight: 700 }}>{money(r.outputCost)}</div>
                  <div style={{ color: "#7A8079" }}>
                    {fmtNum(r.equipmentHours)}h equip · {fmtNum(r.labourHours)}h labour
                  </div>
                </div>
                {r.estimated && <Badge tone="warn">Estimated</Badge>}
              </div>

              {open && (
                <div style={{ borderTop: "1px solid #EEF0EA", padding: "12px 14px 14px 41px" }}>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>
                        Consumed
                      </div>
                      {r.inputs.length === 0 && (
                        <div style={{ fontSize: 12, color: "#9AA09A" }}>No inputs recorded.</div>
                      )}
                      {r.inputs.map((i, k) => (
                        <div key={k} style={{ display: "flex", justifyContent: "space-between",
                                              gap: 10, fontSize: 12, marginBottom: 3 }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {i.itemName}
                            {i.lotNumber && <span style={{ color: "#7A8079" }} className="mono"> {i.lotNumber}</span>}
                          </span>
                          <span className="mono" style={{ whiteSpace: "nowrap", color: "#5B6470" }}>
                            {fmtNum(i.qty)} {i.unit} @ {money(i.unitCost)} = <b>{money(i.cost)}</b>
                            {i.estimated && <span style={{ color: "#8C6B45" }}> est</span>}
                          </span>
                        </div>
                      ))}
                      <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #EEF0EA",
                                    display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 700 }}>
                        <span>Material in</span><span className="mono">{money(r.inputCost)}</span>
                      </div>
                    </div>

                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Produced</div>
                      {r.outputs.map((o, k) => (
                        <div key={k} style={{ display: "flex", justifyContent: "space-between",
                                              gap: 10, fontSize: 12, marginBottom: 3 }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {o.itemName}
                            <span style={{ color: "#7A8079" }} className="mono"> {o.lotNumber}</span>
                            {o.itemType === "waste" && <span style={{ color: "#9AA09A" }}> (by-product)</span>}
                          </span>
                          <span className="mono" style={{ whiteSpace: "nowrap", color: "#5B6470" }}>
                            {fmtNum(o.producedQty)} {o.unit} @ {money(o.unitCost)} = <b>{money(o.totalCost)}</b>
                          </span>
                        </div>
                      ))}
                      <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #EEF0EA",
                                    display: "flex", justifyContent: "space-between", fontSize: 12.5, fontWeight: 700 }}>
                        <span>Material out</span><span className="mono">{money(r.outputCost)}</span>
                      </div>
                      {Math.abs(r.inputCost - r.outputCost) > 0.5 && (
                        <div style={{ fontSize: 11.5, color: "#A32D2D", marginTop: 4 }}>
                          In and out differ by {money(Math.abs(r.inputCost - r.outputCost))} — check the
                          recorded quantities on this batch.
                        </div>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 14 }}>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Equipment</div>
                      {r.equipment.length === 0 && (
                        <div style={{ fontSize: 12, color: "#9AA09A" }}>None recorded.</div>
                      )}
                      {r.equipment.map((e, k) => (
                        <div key={k} style={{ fontSize: 12, marginBottom: 2 }}>
                          {e.eq ? (e.eq.code || e.eq.name) : "(deleted)"}
                          <span className="mono" style={{ color: "#5B6470" }}> {fmtNum(e.hours)}h</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 6 }}>Labour</div>
                      {r.labour.length === 0 && (
                        <div style={{ fontSize: 12, color: "#9AA09A" }}>None recorded.</div>
                      )}
                      {r.labour.map((l, k) => (
                        <div key={k} style={{ fontSize: 12, marginBottom: 2 }}>
                          {l.operatorName || "(unnamed)"}
                          <span className="mono" style={{ color: "#5B6470" }}> {fmtNum(l.hours)}h</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {r.qcChecks > 0 && (
                    <div style={{ fontSize: 12, color: "#5B6470", marginTop: 12 }}>
                      {r.qcChecks} QC check(s) recorded against this batch — see the lot detail for values.
                    </div>
                  )}
                  {r.notes && (
                    <div style={{ fontSize: 12, color: "#8A9099", marginTop: 8, fontStyle: "italic" }}>
                      {r.notes}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: "#9AA09A", marginTop: 10 }}>
                    Material cost only. Labour and equipment hours are recorded above but not
                    yet priced, so this is not a fully absorbed cost. By-products carry no
                    material cost, so the full input value lands on the saleable output.
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {filtered.length > 200 && (
        <div style={{ fontSize: 12, color: "#7A8079", marginTop: 10 }}>
          Showing the 200 most recent of {filtered.length}. Narrow the range or filter by process.
        </div>
      )}
    </div>
  );
}

function UtilizationTab({ data, horizon, setHorizon }) {
  const tr = useTimeRange(data, "12m");
  const [eqFilter, setEqFilter] = useState("");
  const [scaleByBatch, setScaleByBatch] = useState(false);
  const [maxUtil, setMaxUtil] = useState(85);

  const plan = useMemo(() => planScheduleFIFO(data, { scaleByBatch }), [data, scaleByBatch]);

  const series = [
    { key: "actual", label: "Actual (recorded)", color: "#1F6F78" },
    { key: "committed", label: "Committed (planned)", color: "#5FA8A0" },
    { key: "maintenance", label: "Maintenance", color: "#C08A3E" }
  ];

  const rows = useMemo(
    () => utilizationSeries(data, plan, tr.range, eqFilter, maxUtil),
    [data, plan, tr.range, eqFilter, maxUtil]);

  const byEq = useMemo(
    () => utilizationByEquipment(data, plan, tr.range, maxUtil),
    [data, plan, tr.range, maxUtil]);

  const totalUsed = rows.reduce((s, r) => s + r.actual + r.committed + r.maintenance, 0);
  const totalAvail = rows.reduce((s, r) => s + r.available, 0);
  const overall = totalAvail > 0 ? Math.round((totalUsed / totalAvail) * 100) : null;
  const overPeriods = rows.filter(r => r.overCapacity).length;
  const overLimitPeriods = rows.filter(r => r.overLimit).length;
  const selected = eqFilter ? getEquipment(data, eqFilter) : null;

  const hrs = (n) => fmtNum(Math.round(Number(n) || 0)) + "h";

  return (
    <div>
      <PageHeader tabKey="utilization"
        subtitle="Hours recorded and hours the capacity plan has committed, against the hours each machine can actually run" />

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <TimeRangeControls state={tr} />
        <select style={{ ...inputStyle, width: 210 }} value={eqFilter}
          onChange={e => setEqFilter(e.target.value)}>
          <option value="">All equipment</option>
          {(data.equipment || []).map(e => (
            <option key={e.id} value={e.id}>{e.code || e.name}</option>
          ))}
        </select>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#5B6470" }}
             title="The utilisation you are willing to plan to. Below 100% because changeovers, setup and variability eat the rest.">
          <span>Plan to max</span>
          <select style={{ ...inputStyle, width: 86 }} value={maxUtil}
            onChange={e => setMaxUtil(parseInt(e.target.value, 10))}>
            {[70, 75, 80, 85, 90, 95, 100].map(p => <option key={p} value={p}>{p}%</option>)}
          </select>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#5B6470", cursor: "pointer" }}
          title="Matches the same option on the production schedule. Off means process time covers the whole run regardless of quantity.">
          <input type="checkbox" checked={scaleByBatch}
            onChange={e => setScaleByBatch(e.target.checked)} />
          Run time scales with batch count
        </label>
      </div>

      <div style={{
        display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center",
        padding: "10px 14px", marginBottom: 14, borderRadius: 8, fontSize: 13,
        background: overPeriods ? "#FCF4F3" : "#F1F6F2",
        border: "1px solid " + (overPeriods ? "#E3B9B2" : "#CFE0D3")
      }}>
        <div><b>{overall === null ? "\u2014" : overall + "%"}</b> utilised overall</div>
        <div style={{ color: "#5B6470" }}>{hrs(totalUsed)} of {hrs(totalAvail)} available</div>
        {overPeriods > 0 && (
          <div style={{ color: "#A32D2D" }}>
            <b>{overPeriods}</b> period(s) exceed available hours{selected ? "" : " in aggregate"}
          </div>
        )}
        {overPeriods === 0 && overLimitPeriods > 0 && (
          <div style={{ color: "#8C6B45" }}>
            <b>{overLimitPeriods}</b> period(s) above the {maxUtil}% planning limit — deliverable,
            but with no slack for a breakdown or a rush order.
          </div>
        )}
        {overPeriods === 0 && overLimitPeriods === 0 && (
          <div style={{ color: "#2E7D5B" }}>Every period sits inside the {maxUtil}% planning limit.</div>
        )}
      </div>

      <ChartCard
        title={selected ? "Utilisation \u2014 " + (selected.code || selected.name) : "Utilisation \u2014 all equipment"}
        subtitle={"Solid dashes are the hours available from the operating calendar and unit count; the finer line is the "
          + maxUtil + "% planning limit. The figure above each bar is utilisation against available hours."}
        rows={rows} series={series} targetKey="target" targetIsCeiling
        limitKey="limit" limitLabel={maxUtil + "% planning limit"}
        barLabelKey="utilization" barLabelSuffix="%"
        formatValue={(v) => Math.round(v) + "h"}
        emptyMessage="No recorded or committed hours in this period"
        footer={
          <div style={{ fontSize: 12, color: "#7A8079", marginTop: 8 }}>
            Actual comes from the equipment lines on logged batches; committed comes
            from the capacity plan, so the two never cover the same day.
          </div>
        } />

      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>By machine</div>
        <div style={{ fontSize: 12, color: "#7A8079", marginBottom: 10 }}>
          Busiest first. Amber is above the {maxUtil}% planning limit; red is above what the
          machine can physically deliver. Either is a candidate for more hours or another unit.
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "#7A8079", borderBottom: "1px solid #E7E9E4" }}>
              <th style={{ padding: "6px 8px" }}>Machine</th>
              <th style={{ padding: "6px 8px" }}>Units</th>
              <th style={{ padding: "6px 8px" }}>Hours</th>
              <th style={{ padding: "6px 8px" }}>Actual</th>
              <th style={{ padding: "6px 8px" }}>Committed</th>
              <th style={{ padding: "6px 8px" }}>Maint.</th>
              <th style={{ padding: "6px 8px" }}>Available</th>
              <th style={{ padding: "6px 8px" }}>Utilised</th>
            </tr>
          </thead>
          <tbody>
            {byEq.map(r => {
              const u = r.utilization;
              const tone = u === null ? "#7A8079" : u >= 100 ? "#A32D2D" : u >= maxUtil ? "#8C6B45" : "#2E7D5B";
              return (
                <tr key={r.eq.id} style={{ borderBottom: "1px solid #F0F2EE" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 600 }}>
                    {r.eq.code || r.eq.name}
                    <span style={{ color: "#9AA09A", fontWeight: 500 }}> · {r.calendar.name}</span>
                  </td>
                  <td style={{ padding: "6px 8px" }}>{r.eq.units || 1}</td>
                  <td style={{ padding: "6px 8px" }} className="mono">{hrs(r.used)}</td>
                  <td style={{ padding: "6px 8px" }} className="mono">{hrs(r.actual)}</td>
                  <td style={{ padding: "6px 8px" }} className="mono">{hrs(r.committed)}</td>
                  <td style={{ padding: "6px 8px" }} className="mono">{hrs(r.maintenance)}</td>
                  <td style={{ padding: "6px 8px" }} className="mono">{hrs(r.available)}</td>
                  <td style={{ padding: "6px 8px", fontWeight: 700, color: tone }}>
                    {u === null ? "\u2014" : u + "%"}
                    {r.overPeriods > 0 && (
                      <span style={{ fontWeight: 500, color: "#A32D2D" }}>
                        {" "}({r.overPeriods} over capacity)
                      </span>
                    )}
                    {r.overPeriods === 0 && r.overLimitPeriods > 0 && (
                      <span style={{ fontWeight: 500, color: "#8C6B45" }}>
                        {" "}({r.overLimitPeriods} over limit)
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {byEq.length === 0 && (
          <div style={{ color: "#8A9099", padding: 18 }}>No equipment recorded yet.</div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Revenue Tab
----------------------------------------------------------------*/
function buildRevenueRow(data, entry, qtyBasis, cache) {
  const fg = getFinished(data, entry.productId);
  if (!fg) return null;
  const customer = entry.customerId ? getCustomer(data, entry.customerId) : null;
  const priceLine = customer ? customer.priceList.find(p => p.finishedGoodId === entry.productId) : null;
  const unitPrice = priceLine ? getEffectivePrice(priceLine, qtyBasis) : null;

  /* A run that has been fulfilled knows exactly which lots satisfied it, so
     its cost is a fact rather than a standard. Only a run with nothing made
     against it yet has to fall back to standard cost - and that is flagged,
     because a standard cost moves whenever a supplier price does. */
  const costCache = cache || {};
  const fulfilled = (entry.fulfillmentLots || []).filter(fl => fl.lotId && (Number(fl.qty) || 0) > 0);
  let unitCost, costBasis;
  if (fulfilled.length) {
    let value = 0, qty = 0;
    fulfilled.forEach(fl => {
      const c = lotCost(data, "finished", entry.productId, fl.lotId, costCache);
      value += c.unitCost * (Number(fl.qty) || 0);
      qty += Number(fl.qty) || 0;
    });
    unitCost = qty > 0 ? value / qty : 0;
    costBasis = "actual";
  } else {
    unitCost = computeItemUnitCost(data, "finished", fg.id);
    costBasis = "standard";
  }

  const revenue = unitPrice != null ? unitPrice * qtyBasis : null;
  const cogs = unitCost * qtyBasis;
  const margin = revenue != null ? revenue - cogs : null;
  const marginPct = revenue ? (margin / revenue) * 100 : null;
  return { entry, fg, customer, qtyBasis, unitPrice, unitCost, costBasis,
           revenue, cogs, margin, marginPct };
}


/* ---------------------------------------------------------------
   Shipment trace

   One despatch, opened out: the paperwork, the lot that went, the
   batch that made it, the material that fed the batch, and what it
   earned against what it cost.
----------------------------------------------------------------*/

/* ---------------------------------------------------------------
   Cancelling a held allocation

   Releases the earmark, not the stock. A reason and a name are
   required because a cancellation is a commercial decision someone
   made, and six months later the question is always who and why.
----------------------------------------------------------------*/
function CancelHeldModal({ data, row, onClose, update }) {
  const cancellable = (row.lots || []).filter(l => l.held > 0.001);
  const [lotId, setLotId] = useState(() => (cancellable[0] || {}).lotId || "");
  const [qty, setQty] = useState(() => (cancellable[0] || {}).held || 0);
  const [reason, setReason] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const [by, setBy] = useState("");
  const [disposition, setDisposition] = useState("return");
  const [error, setError] = useState("");

  const lot = cancellable.find(l => l.lotId === lotId) || cancellable[0];
  const amount = Number(qty) || 0;
  const partial = lot && amount > 0 && amount < lot.held - 0.001;

  const cogs = lot ? lot.unitCost * amount : 0;
  const sales = row.unitPrice != null ? row.unitPrice * amount : null;
  const disp = CANCELLATION_DISPOSITIONS.find(x => x.key === disposition)
    || CANCELLATION_DISPOSITIONS[0];

  const apply = () => {
    setError("");
    let out = null;
    update(d => {
      out = tx.cancelFulfilment(d, {
        scheduleId: row.entry.id, lotId, qty: amount,
        reason, reasonNote, cancelledBy: by, date: todayStr(), disposition
      });
    });
    if (out && !out.ok) { setError(out.error); return; }
    onClose();
  };

  return (
    <Modal title="Cancel held stock" onClose={onClose} wide>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", fontSize: 13,
                    padding: "9px 12px", marginBottom: 14, borderRadius: 7,
                    background: "#F4F6F9", border: "1px solid #DCE1E8" }}>
        <div><b>{row.productName}</b></div>
        <div style={{ color: "#5B6470" }}>{row.customerName || "No customer"}</div>
        <div style={{ color: "#5B6470" }}>
          {fmtNum(row.heldQty)} {row.unit} held since {fmtDate(row.completedDate)}
        </div>
      </div>

      <div style={{ padding: "9px 12px", marginBottom: 14, borderRadius: 7, fontSize: 12.5,
                    background: disp.consumes ? "#FBFAF6" : "#F1F6F2",
                    border: "1px solid " + (disp.consumes ? "#E4DFD2" : "#CFE0D3"),
                    color: "#3C4340" }}>
        {disp.hint}
        {disp.consumes && " The stock record is updated at the same time, so there is nothing to write off separately."}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Lot" span={2}>
          <select style={inputStyle} value={lotId}
            onChange={e => {
              setLotId(e.target.value);
              const l = cancellable.find(x => x.lotId === e.target.value);
              setQty(l ? l.held : 0);
            }}>
            {cancellable.map(l => (
              <option key={l.lotId} value={l.lotId}>
                {l.lotNumber} — {fmtNum(l.held)} {row.unit} held
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quantity to cancel"
          hint={lot ? "Up to " + fmtNum(lot.held) + " " + row.unit : ""}>
          <input type="number" step="0.01" style={inputStyle} value={qty}
            onChange={e => { setQty(parseFloat(e.target.value) || 0); setError(""); }} />
        </Field>
        <Field label="Cancelled by" hint="Recorded permanently against this cancellation">
          <input style={inputStyle} value={by}
            onChange={e => { setBy(e.target.value); setError(""); }}
            placeholder="Your name" />
        </Field>
        <Field label="What happens to the goods" span={2}>
          <select style={inputStyle} value={disposition}
            onChange={e => { setDisposition(e.target.value); setError(""); }}>
            {CANCELLATION_DISPOSITIONS.map(o =>
              <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="Reason" span={2}>
          <select style={inputStyle} value={reason}
            onChange={e => { setReason(e.target.value); setError(""); }}>
            <option value="">Choose a reason…</option>
            {CANCELLATION_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        <Field label="Detail" span={2}>
          <input style={inputStyle} value={reasonNote}
            onChange={e => setReasonNote(e.target.value)}
            placeholder="Who agreed it, reference, anything worth knowing later" />
        </Field>
      </div>

      {lot && amount > 0 && (
        <div style={{ padding: "10px 12px", marginTop: 14, borderRadius: 7, fontSize: 13,
                      background: "#FBFAF6", border: "1px solid #E4DFD2" }}>
          Cancelling <b>{fmtNum(amount)} {row.unit}</b>
          {partial ? " of " + fmtNum(lot.held) + " held" : " — the full held balance"}.
          {" "}{disp.consumes ? "Writes off" : "Releases"} <b className="mono">{fmtMoney(cogs)}</b> of stock at cost
          {sales != null && <> and forgoes <b className="mono">{fmtMoney(sales)}</b> of sales value</>}.
          {disp.consumes && (
            <div style={{ marginTop: 4, color: "#8C6B45" }}>
              The lot will be reduced by {fmtNum(amount)} {row.unit} and marked
              &ldquo;{disp.reason}&rdquo;{disp.accumulate && ", with waste accrued against its composition"}.
            </div>
          )}
        </div>
      )}

      {error && (
        <div style={{ padding: "8px 12px", marginTop: 12, borderRadius: 7, fontSize: 12.5,
                      background: "#FCF4F3", border: "1px solid #E3B9B2", color: "#8C332B" }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={apply}
             style={{ opacity: (reason && by.trim() && amount > 0) ? 1 : 0.5 }}>
          Record cancellation
        </Btn>
      </div>
    </Modal>
  );
}

/* One cancellation, opened from the record list. */
function CancellationRecordModal({ record, onClose }) {
  const r = record;
  return (
    <Modal title="Cancellation record" onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }}>
        {[["Product", r.productName], ["Customer", r.customerName || "—"],
          ["Lot", r.lotNumber || "—"], ["Quantity", fmtNum(r.qty) + " " + r.unit],
          ["Cancelled by", r.cancelledBy], ["Date", fmtDate(r.cancelledDate)],
          ["Cost released", fmtMoney(r.cogs)], ["Sales value forgone", fmtMoney(r.salesValue)],
          ["Disposition", r.dispositionLabel]]
          .map(([label, value]) => (
          <div key={label}>
            <div style={{ fontSize: 11, color: "#7A8079", fontWeight: 600 }}>{label}</div>
            <div style={{ fontSize: 13.5 }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ padding: "9px 12px", borderRadius: 7, fontSize: 13,
                    background: "#F4F6F9", border: "1px solid #DCE1E8", marginBottom: 12 }}>
        <b>{r.reason}</b>
        {r.reasonNote && <div style={{ color: "#5B6470", marginTop: 3 }}>{r.reasonNote}</div>}
      </div>
      <div style={{ fontSize: 12, color: "#7A8079" }}>
        Margin forgone <b className="mono">{fmtMoney(r.marginForgone)}</b>.
        {r.disposition === "return"
          ? " The stock itself was returned to unassigned inventory and remains available."
          : " The stock was consumed out of its lot at the same time, so no separate write-off was needed."}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
      </div>
    </Modal>
  );
}

function ShipmentTraceModal({ data, shipmentId, onClose, update }) {
  const t = useMemo(() => shipmentTrace(data, shipmentId), [data, shipmentId]);
  const [notes, setNotes] = useState(() => {
    const sh = (data.shipments || []).find(s => s.id === shipmentId);
    return sh ? (sh.notes || "") : "";
  });
  const [dirty, setDirty] = useState(false);

  if (!t) return null;
  const money = (n) => fmtMoney(n || 0);

  const saveNotes = () => {
    update(d => {
      const sh = (d.shipments || []).find(s => s.id === shipmentId);
      if (sh) sh.notes = notes;
    });
    setDirty(false);
  };

  const Row = ({ label, children }) => (
    <div>
      <div style={{ fontSize: 11, color: "#7A8079", fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13 }}>{children}</div>
    </div>
  );

  return (
    <Modal title={"Shipment \u2014 " + t.productName} onClose={onClose} wide>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center", fontSize: 13,
                    padding: "9px 12px", marginBottom: 14, borderRadius: 7,
                    background: t.priced ? "#F1F6F2" : "#FCF4F3",
                    border: "1px solid " + (t.priced ? "#CFE0D3" : "#E3B9B2") }}>
        <div><b>{fmtNum(t.qty)} {t.unit}</b></div>
        <div>{fmtDate(t.shipment.shipDate)}</div>
        <div>{t.customerName || <span style={{ color: "#9AA09A" }}>No customer</span>}</div>
        {t.priced
          ? <div>Revenue <b className="mono">{money(t.revenue)}</b></div>
          : <div style={{ color: "#8C332B" }}>No agreed price \u2014 contributes no revenue</div>}
      </div>

      {/* despatch paperwork */}
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Despatch</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14, marginBottom: 18 }}>
        <Row label="Ship date">{fmtDate(t.shipment.shipDate)}</Row>
        <Row label="Customer PO">
          <span className="mono">{t.shipment.customerPO || "\u2014"}</span>
        </Row>
        <Row label="Sales order">
          <span className="mono">{t.shipment.reference || "\u2014"}</span>
        </Row>
        <Row label="Bill of lading">
          <span className="mono">{t.shipment.bol || "\u2014"}</span>
        </Row>
        <Row label="Carrier">{t.shipment.carrier || "\u2014"}</Row>
        <Row label="Tracking">
          <span className="mono">{t.shipment.trackingRef || "\u2014"}</span>
        </Row>
        <Row label="Ship-to">
          {t.address ? (t.address.label + " \u2014 " + [t.address.city, t.address.country].filter(Boolean).join(", "))
                     : "\u2014"}
        </Row>
      </div>

      {/* value */}
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Value</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 6 }}>
        <Row label="Unit price">{t.unitPrice != null ? money(t.unitPrice) : "\u2014"}</Row>
        <Row label="Actual unit cost">
          <span className="mono">{money(t.unitCost)}</span>
          {t.costEstimated && <span style={{ color: "#8C6B45", fontSize: 11 }}> est</span>}
        </Row>
        <Row label="Revenue">
          <b className="mono">{t.priced ? money(t.revenue) : "\u2014"}</b>
        </Row>
        <Row label="Margin">
          <b className="mono" style={{ color: t.margin != null && t.margin < 0 ? "#A32D2D" : "#1F5B3E" }}>
            {t.margin != null ? money(t.margin) : "\u2014"}
          </b>
        </Row>
      </div>
      {t.expectedUnitCost != null && (
        <div style={{ fontSize: 12, color: "#5B6470", marginBottom: 18 }}>
          Expected <span className="mono">{money(t.expectedUnitCost)}</span> per {t.unit}
          {t.expectedIsFrozen
            ? " (standard cost as at fulfilment, fixed)"
            : " (today's standard cost \u2014 this run predates the fixed figure)"}
          {t.costVariance != null && (
            <span style={{ color: t.costVariance > 0 ? "#A32D2D" : "#1F5B3E" }}>
              {" \u2014 "}{t.costVariance > 0 ? "over" : "under"} by <b>{money(Math.abs(t.costVariance))}</b>
            </span>
          )}
        </div>
      )}

      {/* traceability */}
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Traceability</div>
      {t.lot ? (
        <div style={{ border: "1px solid #E7E9E4", borderRadius: 8, padding: 12, marginBottom: 8 }}>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5, marginBottom: 8 }}>
            <div>Lot <b className="mono">{t.lot.lotNumber}</b></div>
            <div style={{ color: "#5B6470" }}>Made {fmtDate(t.lot.date)}</div>
            <div style={{ color: "#5B6470" }}>
              {fmtNum(t.lotProduced)} produced \u00b7 {fmtNum(t.lotShippedTotal)} shipped \u00b7
              {" "}{fmtNum(t.lotRemaining)} left
            </div>
          </div>
          {t.batch ? (
            <div style={{ fontSize: 12.5 }}>
              <div style={{ marginBottom: 4 }}>
                Made by <b>{t.batch.processName}</b> on {fmtDate(t.batch.date)}
                {t.batch.equipmentHours > 0 &&
                  <span style={{ color: "#7A8079" }}> \u00b7 {fmtNum(t.batch.equipmentHours)}h equipment</span>}
              </div>
              <div style={{ color: "#5B6470", marginBottom: 3 }}>Consumed:</div>
              {t.batch.inputs.map((i, k) => (
                <div key={k} style={{ fontSize: 12, marginLeft: 10, marginBottom: 2 }}>
                  {i.itemName}
                  {i.lotNumber && <span className="mono" style={{ color: "#7A8079" }}> {i.lotNumber}</span>}
                  <span className="mono" style={{ color: "#5B6470" }}>
                    {" \u2014 "}{fmtNum(i.qty)} {i.unit} @ {money(i.unitCost)}
                  </span>
                </div>
              ))}
              {t.batch.inputs.length === 0 && (
                <div style={{ fontSize: 12, color: "#9AA09A", marginLeft: 10 }}>
                  No inputs recorded against that batch.
                </div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#9AA09A" }}>
              This lot has no batch record \u2014 it predates batch identity or was entered by hand.
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: "#A32D2D", marginBottom: 8 }}>
          This shipment names no lot, so it cannot be traced and its cost falls back
          to a standard.
        </div>
      )}

      {t.run ? (
        <div style={{ fontSize: 12.5, color: "#5B6470", marginBottom: 18 }}>
          Fulfils run due {fmtDate(t.run.baselineDueDate || t.run.dueDate)}
          {t.run.completedDate && ", completed " + fmtDate(t.run.completedDate)}
          {(t.run.revisions || []).length > 0 &&
            <span style={{ color: "#8C6B45" }}> \u00b7 {t.run.revisions.length} recorded amendment(s)</span>}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: "#8C6B45", marginBottom: 18 }}>
          Not linked to a production run \u2014 this despatch will not reconcile against
          completed output.
        </div>
      )}

      {/* notes */}
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Notes</div>
      <textarea
        style={{ ...inputStyle, width: "100%", minHeight: 62, resize: "vertical" }}
        value={notes}
        onChange={e => { setNotes(e.target.value); setDirty(true); }}
        placeholder="Delivery issues, short shipments, customer instructions\u2026" />

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <Btn variant="secondary" onClick={onClose}>Close</Btn>
        <Btn onClick={saveNotes} style={{ opacity: dirty ? 1 : 0.5 }}>Save notes</Btn>
      </div>
    </Modal>
  );
}

function RevenueRowsTable({ rows, emptyMessage }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, overflow: "hidden" }}>
      <table className="mrp-table">
        <thead>
          <tr>
            <th>Product</th><th>Customer</th><th>Qty</th><th>Unit price</th><th>Unit COGS</th><th>Revenue</th><th>Margin</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx}>
              <td>
                <div style={{ fontWeight: 600 }}>{r.fg.name}</div>
                <div className="mono" style={{ fontSize: 11, color: "#8A9099" }}>due {fmtDate(r.entry.dueDate)}</div>
              </td>
              <td>{r.customer ? r.customer.name : <span style={{ color: "#B87510" }}>Unassigned</span>}</td>
              <td className="mono">{fmtNum(r.qtyBasis)}</td>
              <td className="mono">{r.unitPrice != null ? fmtMoney(r.unitPrice) : "—"}</td>
              <td className="mono"
                  title={r.costBasis === "actual"
                    ? "Actual cost of the lots that fulfilled this run"
                    : "Standard cost \u2014 nothing has been made against this run yet"}>
                {fmtMoney(r.unitCost)}
                {r.costBasis === "standard" && <span style={{ color: "#8C6B45" }}> std</span>}
              </td>
              <td className="mono" style={{ fontWeight: 700 }}>{r.revenue != null ? fmtMoney(r.revenue) : "—"}</td>
              <td className="mono" style={{ fontWeight: 700, color: r.margin == null ? "#8A9099" : r.margin < 0 ? "#8A2E20" : "#1F5B3E" }}>
                {r.margin != null ? fmtMoney(r.margin) + " (" + Math.round(r.marginPct) + "%)" : "—"}
              </td>
              <td>
                {r.unitPrice == null && <Badge tone="warn">No price set</Badge>}
                {r.unitPrice != null && r.marginPct >= 20 && <Badge tone="good">Healthy margin</Badge>}
                {r.unitPrice != null && r.marginPct >= 5 && r.marginPct < 20 && <Badge tone="warn">Thin margin</Badge>}
                {r.unitPrice != null && r.marginPct < 5 && <Badge tone="bad">At/below cost</Badge>}
              </td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={8} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>{emptyMessage}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function RevenueTab({ data, horizon, setHorizon, onOpenShipment, onOpenBatch, onCancelHeld, onOpenCancellation }) {
  const tr = useTimeRange(data, "12m");
  const revSeries = [
    { key: "revenue", label: "Revenue", color: "#1F6F78" },
    { key: "cogs", label: "COGS", color: "#C08A3E" }
  ];
  const shipEvents = useMemo(() => shipmentEvents(data), [data]);
  const revRows = useMemo(() => bucketEvents(
    shipEvents.flatMap(e => [
      { date: e.date, series: "revenue", value: e.revenue },
      { date: e.date, series: "cogs", value: e.cogs }
    ]), tr.range, ["revenue", "cogs"]), [shipEvents, tr.range]);
  const unpricedCount = shipEvents.filter(e => !e.priced &&
    e.date >= tr.range.from && e.date <= tr.range.to).length;
  const [focusBucket, setFocusBucket] = useState(null);
  const held = useMemo(() => heldSummary(data), [data]);
  const cancellations = useMemo(() => cancellationRecords(data), [data]);
  const allShipLines = useMemo(() => shipmentLines(data, tr.range), [data, tr.range]);

  /* Clicking a bar narrows the table to that period, so the figure on the
     chart can be taken apart into the shipments that produced it. Without
     this the two agree in total but there is no way to see WHY, which is
     the question anyone actually has when a number looks wrong. */
  const shipLines = useMemo(() => {
    if (!focusBucket) return allShipLines;
    return allShipLines.filter(l => bucketKeyOf(l.date, tr.range.granularity) === focusBucket);
  }, [allShipLines, focusBucket, tr.range.granularity]);

  // a period that stops existing when the range or granularity changes
  useEffect(() => { setFocusBucket(null); }, [tr.range.from, tr.range.to, tr.range.granularity]);

  const expectedEntries = data.schedule.filter(s =>
    s.productType === "finished" && (s.status === "Planned" || s.status === "In progress") && daysUntil(s.dueDate) <= horizon
  );
  const actualEntries = data.schedule.filter(s => s.productType === "finished" && s.status === "Complete");

  const costCache = {};
  const expectedRows = expectedEntries.map(entry => buildRevenueRow(data, entry, entry.qty, costCache)).filter(Boolean);
  const actualRows = actualEntries.map(entry => {
    const fulfilledQty = (entry.fulfillmentLots || []).reduce((s, fl) => s + (Number(fl.qty) || 0), 0);
    return buildRevenueRow(data, entry, fulfilledQty, costCache);
  }).filter(Boolean);

  const expectedTotalRevenue = expectedRows.reduce((s, r) => s + (r.revenue || 0), 0);
  const expectedTotalCogs = expectedRows.reduce((s, r) => s + r.cogs, 0);
  const expectedTotalMargin = expectedTotalRevenue - expectedTotalCogs;
  const expectedUnpriced = expectedRows.filter(r => r.unitPrice == null).length;

  const actualTotalRevenue = actualRows.reduce((s, r) => s + (r.revenue || 0), 0);
  const actualTotalCogs = actualRows.reduce((s, r) => s + r.cogs, 0);
  const actualTotalMargin = actualTotalRevenue - actualTotalCogs;
  const actualUnpriced = actualRows.filter(r => r.unitPrice == null).length;

  return (
    <div>
      <PageHeader tabKey="revenue" subtitle="Revenue recognised on shipment, line by line, with the order book underneath"
        action={
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span style={{ color: "#5B6470" }}>Horizon</span>
            <select style={{ ...inputStyle, width: 130 }} value={horizon} onChange={e => setHorizon(parseInt(e.target.value))}>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
              <option value={180}>180 days</option>
            </select>
          </div>
        } />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>Historic — recognised on shipment</div>
        <TimeRangeControls state={tr} />
      </div>
      <ChartCard
        title="Revenue and cost of goods shipped"
        subtitle={"Dated by ship date, priced from the customer's price list at the shipped quantity" +
          (unpricedCount ? " — " + unpricedCount + " shipment(s) in this period have no priced line and contribute no revenue" : "")}
        rows={revRows} series={revSeries} formatValue={fmtMoney} showLine
        emptyMessage="No shipments recorded in this period"
        onBucketClick={(row) => setFocusBucket(prev => prev === row.key ? null : row.key)}
        focusKey={focusBucket}
        footer={
          <div style={{ fontSize: 12, color: "#7A8079", marginTop: 8 }}>
            {focusBucket
              ? "Showing only " + bucketLabelOf(focusBucket, tr.range.granularity) +
                " in the table below \u2014 click the period again to clear."
              : "Click any period to break it down into the shipments that made it up."}
          </div>
        } />

      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10,
                    overflow: "hidden", marginBottom: 6 }}>
        <div style={{ padding: "11px 14px", borderBottom: "1px solid #EEF0EA" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Shipment lines</div>
            {focusBucket && (
              <>
                <Badge tone="info">{bucketLabelOf(focusBucket, tr.range.granularity)}</Badge>
                <Btn variant="ghost" onClick={() => setFocusBucket(null)}
                     style={{ padding: "2px 8px", fontSize: 11.5 }}>
                  Show all {allShipLines.length}
                </Btn>
              </>
            )}
          </div>
          <div style={{ fontSize: 12, color: "#7A8079", marginTop: 2 }}>
            {focusBucket
              ? "The " + shipLines.length + " shipment(s) that make up that bar on the chart."
              : "Every shipment in the range above. These are the rows the chart aggregates, so the totals here and the bars there are the same figures."}
          </div>
        </div>
        <table className="mrp-table">
          <thead>
            <tr>
              <th>Date</th><th>Product</th><th>Lot</th><th>Customer</th><th>PO / BOL</th>
              <th>Carrier</th><th>Qty</th><th>Unit price</th><th>Unit cost</th>
              <th>Revenue</th><th>Margin</th>
            </tr>
          </thead>
          <tbody>
            {shipLines.map(l => (
              <tr key={l.id}
                  onClick={() => onOpenShipment && onOpenShipment(l.id)}
                  style={{ cursor: onOpenShipment ? "pointer" : "default" }}
                  title="Open the full trace for this despatch">
                <td className="mono">{fmtDate(l.date)}</td>
                <td>{l.productName}</td>
                <td className="mono" style={{ fontSize: 11, color: "#8A9099" }}>{l.lotNumber || "—"}</td>
                <td>{l.customerName || <span style={{ color: "#9AA09A" }}>No customer</span>}</td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {l.shipment.customerPO || "\u2014"}
                  <div style={{ color: "#8A9099" }}>{l.shipment.bol || ""}</div>
                </td>
                <td style={{ fontSize: 11.5 }}>{l.shipment.carrier || "\u2014"}</td>
                <td className="mono">{fmtNum(l.qty)} {l.unit}</td>
                <td className="mono">{l.unitPrice != null ? fmtMoney(l.unitPrice) : "—"}</td>
                <td className="mono" title={l.expectedIsFrozen
                  ? "Standard cost fixed on the day the run was fulfilled"
                  : "No fixed standard for this run \u2014 today's standard shown"}>
                  {l.expectedCogs != null ? fmtMoney(l.expectedCogs) : "\u2014"}
                  {l.expectedCogs != null && !l.expectedIsFrozen &&
                    <span style={{ color: "#8C6B45" }}> ~</span>}
                </td>
                <td className="mono" title={l.costEstimated ? "Standard cost \u2014 this shipment has no lot reference" : "Actual cost of the lot shipped"}>
                  {fmtMoney(l.cogs)}
                  {l.costEstimated && <span style={{ color: "#8C6B45" }}> est</span>}
                  {l.costVariance != null && Math.abs(l.costVariance) > 0.005 && (
                    <div style={{ fontSize: 10.5,
                          color: l.costVariance > 0 ? "#A32D2D" : "#1F5B3E" }}>
                      {l.costVariance > 0 ? "+" : ""}{fmtMoney(l.costVariance)}
                    </div>
                  )}
                </td>
                <td className="mono" style={{ fontWeight: 700 }}>
                  {l.priced ? fmtMoney(l.revenue)
                    : <span style={{ color: "#A32D2D" }}>no price</span>}
                </td>
                <td className="mono" style={{ color: l.margin != null && l.margin < 0 ? "#A32D2D" : "#1F5B3E" }}>
                  {l.margin != null ? fmtMoney(l.margin) : "—"}
                  {l.marginPct != null && (
                    <span style={{ color: "#8A9099", fontWeight: 400 }}> {l.marginPct.toFixed(0)}%</span>
                  )}
                </td>
              </tr>
            ))}
            {shipLines.length === 0 && (
              <tr><td colSpan={12} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>
                No shipments in this period.
              </td></tr>
            )}
          </tbody>
          {shipLines.length > 0 && (
            <tfoot>
              <tr style={{ borderTop: "2px solid #E2E4DD", fontWeight: 700 }}>
                <td colSpan={10} style={{ textAlign: "right" }}>Total</td>
                <td className="mono">{fmtMoney(shipLines.reduce((s, l) => s + l.revenue, 0))}</td>
                <td className="mono">{fmtMoney(shipLines.reduce((s, l) => s + (l.margin || 0), 0))}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div style={{ fontSize: 12, color: "#7A8079", marginBottom: 20 }}>
        Cost is the actual cost of the lot shipped, rolled up from the deliveries that
        made it — not a current standard cost, so a later supplier increase does not
        reprice a margin already earned.
      </div>

      {/* Held stock: made, still allocated, not yet shipped. */}
      <div style={{ fontWeight: 700, fontSize: 15, marginTop: 6, marginBottom: 4 }}>
        Held finished goods
      </div>
      <div style={{ fontSize: 12, color: "#7A8079", marginBottom: 12 }}>
        Stock made against a run and still allocated to it, with anything already shipped
        removed. This is money spent and revenue not yet earned.
      </div>

      <div style={{
        display: "flex", gap: 22, flexWrap: "wrap", alignItems: "center",
        padding: "11px 14px", marginBottom: 12, borderRadius: 8, fontSize: 13,
        background: held.overdue.length ? "#FCF4F3" : "#F1F6F2",
        border: "1px solid " + (held.overdue.length ? "#E3B9B2" : "#CFE0D3")
      }}>
        <div>
          <div style={{ fontSize: 11, color: "#7A8079", fontWeight: 600 }}>Cost of goods held</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{fmtMoney(held.cogs)}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "#7A8079", fontWeight: 600 }}>Total sales value</div>
          <div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{fmtMoney(held.salesValue)}</div>
        </div>
        <div style={{ color: "#5B6470" }}>
          {fmtNum(Math.round(held.heldQty))} units across <b>{held.runs}</b> run(s)
        </div>
        {held.overdue.length > 0 && (
          <div style={{ color: "#A32D2D" }}>
            <b>{held.overdue.length}</b> past their due date, {fmtMoney(held.overdueCogs)} at cost
          </div>
        )}
        {held.oldestDays > 0 && (
          <div style={{ color: "#5B6470" }}>oldest {held.oldestDays} days</div>
        )}
        {held.unpriced > 0 && (
          <div style={{ color: "#8C6B45" }}>{held.unpriced} with no agreed price</div>
        )}
      </div>

      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10,
                    overflow: "hidden", marginBottom: 16 }}>
        <table className="mrp-table">
          <thead>
            <tr>
              <th>Completed</th><th>Product</th><th>Customer</th><th>Lots held</th>
              <th>Held</th><th>COGS</th><th>Sales value</th><th>Age</th><th></th>
            </tr>
          </thead>
          <tbody>
            {held.rows.map(r => (
              <tr key={r.entry.id}>
                <td className="mono">{fmtDate(r.completedDate)}</td>
                <td>{r.productName}</td>
                <td>{r.customerName || <span style={{ color: "#9AA09A" }}>\u2014</span>}</td>
                <td style={{ fontSize: 11.5 }}>
                  {r.lots.filter(l => l.held > 0.001).map(l => (
                    <span key={l.lotId}
                      role={l.batchId ? "button" : undefined}
                      tabIndex={l.batchId ? 0 : undefined}
                      onClick={l.batchId && onOpenBatch ? () => onOpenBatch(l.batchId) : undefined}
                      onKeyDown={e => {
                        if (!l.batchId || !onOpenBatch) return;
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenBatch(l.batchId); }
                      }}
                      className="mono"
                      title={l.batchId ? "Open the batch record that made this lot" : "No batch record"}
                      style={{ display: "block", cursor: l.batchId ? "pointer" : "default",
                               color: l.batchId ? "#1F6F78" : "#8A9099",
                               textDecoration: l.batchId ? "underline" : "none" }}>
                      {l.lotNumber} \u00b7 {fmtNum(l.held)}
                    </span>
                  ))}
                </td>
                <td className="mono" style={{ fontWeight: 700 }}>{fmtNum(r.heldQty)} {r.unit}</td>
                <td className="mono">{fmtMoney(r.cogs)}</td>
                <td className="mono">
                  {r.priced ? fmtMoney(r.salesValue)
                    : <span style={{ color: "#A32D2D" }}>no price</span>}
                </td>
                <td className="mono" style={{ color: r.overdue ? "#A32D2D" : "#5B6470" }}>
                  {r.ageDays}d
                  {r.overdue && <div style={{ fontSize: 10.5 }}>{r.overdueDays}d late</div>}
                </td>
                <td>
                  <Btn variant="secondary" onClick={() => onCancelHeld && onCancelHeld(r.entry.id)}
                       style={{ padding: "3px 9px", fontSize: 11.5 }}>Cancel</Btn>
                </td>
              </tr>
            ))}
            {held.rows.length === 0 && (
              <tr><td colSpan={9} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>
                Nothing held \u2014 every completed run has shipped or been cancelled.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {cancellations.length > 0 && (
        <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10,
                      overflow: "hidden", marginBottom: 24 }}>
          <div style={{ padding: "11px 14px", borderBottom: "1px solid #EEF0EA" }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Cancellations</div>
            <div style={{ fontSize: 12, color: "#7A8079", marginTop: 2 }}>
              {cancellations.length} record(s), {fmtMoney(cancellations.reduce((s, c) => s + c.salesValue, 0))} of
              sales value released. The stock itself returned to unassigned inventory.
            </div>
          </div>
          <table className="mrp-table">
            <thead>
              <tr><th>Date</th><th>Product</th><th>Customer</th><th>Qty</th>
                  <th>Reason</th><th>By</th><th>Cost</th><th>Sales value</th></tr>
            </thead>
            <tbody>
              {cancellations.map(c => (
                <tr key={c.cancellation.id}
                    onClick={() => onOpenCancellation && onOpenCancellation(c.cancellation.id)}
                    style={{ cursor: onOpenCancellation ? "pointer" : "default" }}
                    title="Open the full record">
                  <td className="mono">{fmtDate(c.cancelledDate)}</td>
                  <td>{c.productName}</td>
                  <td>{c.customerName || "\u2014"}</td>
                  <td className="mono">{fmtNum(c.qty)} {c.unit}</td>
                  <td style={{ fontSize: 12 }}>
                    {c.reason}
                    <div style={{ fontSize: 10.5, color: "#8A9099" }}>{c.dispositionLabel}</div>
                  </td>
                  <td style={{ fontSize: 12 }}>{c.cancelledBy}</td>
                  <td className="mono">{fmtMoney(c.cogs)}</td>
                  <td className="mono">{fmtMoney(c.salesValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Everything below is a different measure and says so: it is revenue
          against PRODUCTION ORDERS, not against shipments. */}
      <div style={{ fontWeight: 700, fontSize: 15, marginTop: 6, marginBottom: 4 }}>
        Order book — revenue against production runs
      </div>
      <div style={{ fontSize: 12, color: "#7A8079", marginBottom: 12 }}>
        A different question from the shipment lines above: what the scheduled and
        completed runs are worth. It will not tie back to shipped revenue — not
        everything produced has shipped, and a shipment can draw on lots from several
        runs.
      </div>

      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Expected — planned &amp; in-progress, within horizon</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 14 }}>
        <MiniStat label="Expected revenue" value={fmtMoney(expectedTotalRevenue)} />
        <MiniStat label="Expected COGS" value={fmtMoney(expectedTotalCogs)} />
        <MiniStat label="Expected margin" value={fmtMoney(expectedTotalMargin)} tone={expectedTotalMargin < 0 ? "bad" : "good"} />
        <MiniStat label="Runs without a priced customer" value={expectedUnpriced} tone={expectedUnpriced ? "warn" : "good"} />
      </div>
      <div style={{ marginBottom: 28 }}>
        <RevenueRowsTable rows={expectedRows} emptyMessage="No finished-goods production scheduled within this horizon." />
      </div>

      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>Actual — completed &amp; fulfilled</div>
      <div style={{ fontSize: 12, color: "#7A8079", marginBottom: 10 }}>
        Uses the quantity actually assigned via each order's fulfillment lots, not the originally ordered quantity — not limited to the horizon above, since completed orders are historical.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 14 }}>
        <MiniStat label="Actual revenue" value={fmtMoney(actualTotalRevenue)} />
        <MiniStat label="Actual COGS" value={fmtMoney(actualTotalCogs)} />
        <MiniStat label="Actual margin" value={fmtMoney(actualTotalMargin)} tone={actualTotalMargin < 0 ? "bad" : "good"} />
        <MiniStat label="Completed without a priced customer" value={actualUnpriced} tone={actualUnpriced ? "warn" : "good"} />
      </div>
      <RevenueRowsTable rows={actualRows} emptyMessage="No finished-goods orders completed yet." />
    </div>
  );
}

/* ---------------------------------------------------------------
   Shipments (shared by admin and operator views)
----------------------------------------------------------------*/
function ShipmentsTab({ data, onAdd, onDelete, tabKey = "shipments" }) {
  const sorted = [...data.shipments].sort((a, b) => String(b.shipDate || "").localeCompare(String(a.shipDate || "")));
  const tr = useTimeRange(data, "13w");
  const unitSeries = [{ key: "units", label: "Units shipped", color: "#1F6F78" }];

  /* Shipments that carry quantity but no price. Until the product/customer
     selection was nested these could be created without noticing, and the
     revenue simply never appeared. Surfaced here so existing ones can be
     found and fixed rather than staying invisible. */
  const unpricedShipments = useMemo(() => shipmentEvents(data)
    .filter(e => e.customerId && !e.priced)
    .map(e => {
      const fgItem = getFinished(data, e.finishedGoodId);
      const cust = getCustomer(data, e.customerId);
      return { ...e, name: fgItem ? fgItem.name : "(deleted product)",
               customerName: cust ? cust.name : "(deleted customer)" };
    }), [data]);
  const unitRows = useMemo(() => bucketEvents(
    shipmentEvents(data).map(e => ({ date: e.date, series: "units", value: e.qty })),
    tr.range, ["units"]), [data, tr.range]);

  return (
    <div>
      <PageHeader tabKey={tabKey} subtitle="Finished-goods shipments to customers — shipping deducts from the source lot's quantity"
        action={<Btn onClick={onAdd}><Plus size={15} />Record shipment</Btn>} />

      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <TimeRangeControls state={tr} />
      </div>
      {unpricedShipments.length > 0 && (
        <div style={{ padding: "10px 14px", marginBottom: 14, borderRadius: 8, fontSize: 13,
                      background: "#FCF4F3", border: "1px solid #E3B9B2", color: "#8C332B" }}>
          <div style={{ marginBottom: 6 }}>
            <b>{unpricedShipments.length} shipment(s) have no agreed price</b> for the
            customer they went to, so they contribute nothing to revenue. Add the missing
            price line on the customer record to bring them into the figures.
          </div>
          {unpricedShipments.slice(0, 6).map((s, i) => (
            <div key={i} style={{ fontSize: 12, marginBottom: 2 }}>
              {fmtDate(s.date)} \u00b7 {fmtNum(s.qty)} \u00d7 {s.name} \u2192 {s.customerName}
            </div>
          ))}
          {unpricedShipments.length > 6 && (
            <div style={{ fontSize: 12, fontStyle: "italic", marginTop: 3 }}>
              and {unpricedShipments.length - 6} more\u2026
            </div>
          )}
        </div>
      )}

      <ChartCard
        title="Units shipped"
        subtitle="Finished-goods quantity leaving the site, by ship date"
        rows={unitRows} series={unitSeries}
        emptyMessage="No shipments recorded in this period" />
      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, overflow: "hidden" }}>
        <table className="mrp-table">
          <thead>
            <tr><th>Product</th><th>Lot</th><th>Qty</th><th>Customer</th><th>Ship date</th><th>Reference</th><th></th></tr>
          </thead>
          <tbody>
            {sorted.map(s => {
              const fg = getFinished(data, s.finishedGoodId);
              const customer = s.customerId ? getCustomer(data, s.customerId) : null;
              const lot = fg ? (fg.lots || []).find(l => l.id === s.lotId) : null;
              return (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{fg ? fg.name : "(deleted product)"}</td>
                  <td className="mono">{lot ? (lot.lotNumber || "Lot") : "—"}</td>
                  <td className="mono">{fmtNum(s.qty)}</td>
                  <td>{customer ? customer.name : "—"}</td>
                  <td className="mono">{fmtDate(s.shipDate)}</td>
                  <td className="mono" style={{ fontSize: 11.5, color: "#8A9099" }}>{s.reference || "—"}</td>
                  <td>
                    {onDelete && (
                      <div style={{ display: "flex", justifyContent: "flex-end" }}>
                        <IconBtn onClick={() => onDelete(s.id)} title="Remove log entry" danger><Trash2 size={13} /></IconBtn>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && <tr><td colSpan={8} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>No shipments recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {onDelete && <div style={{ fontSize: 11.5, color: "#8A9099", marginTop: 10 }}>Removing a log entry does not restore the shipped quantity — it only removes the record.</div>}
    </div>
  );
}

/* Shipment entry.

   Customer first, then product. The two used to be independent lists, so
   any of the customer-by-product combinations could be recorded - including
   the ones with no agreed price, which then produced a shipment that carried
   quantity but no revenue. Revenue simply went missing, silently.

   Now the product list is scoped to what the selected customer actually buys.
   Shipping something unpriced is still possible - samples and new lines are
   real - but it has to be chosen deliberately, and the price consequence is
   shown before the shipment is saved rather than discovered in a report. */
function ShipmentModal({ data, onClose, update }) {
  const [f, setF] = useState({
    finishedGoodId: "", lotId: "", qty: 1, shipDate: todayStr(),
    customerId: "", addressId: "", reference: "", notes: "",
    customerPO: "", bol: "", carrier: "", trackingRef: "", scheduleId: ""
  });
  const [allowUnpriced, setAllowUnpriced] = useState(false);
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const customer = f.customerId ? getCustomer(data, f.customerId) : null;

  /* What this customer is set up to buy. With no customer chosen the
     shipment is not a sale, so everything is offered. */
  const offer = useMemo(
    () => sellableToCustomer(data, f.customerId, allowUnpriced),
    [data, f.customerId, allowUnpriced]);
  const pricedIds = offer.priced;
  const sellable = offer.offered;

  const fg = getFinished(data, f.finishedGoodId);
  const availableLots = (fg ? fg.lots : []).filter(l => (Number(l.qty) || 0) > 0);
  const selectedLot = availableLots.find(l => l.id === f.lotId) || availableLots[0];

  const unitPrice = shipmentUnitPrice(data, f.customerId, f.finishedGoodId, f.qty);
  const unpriced = !!customer && !!f.finishedGoodId && unitPrice === null;

  /* Changing customer can strip the current product out of the list, so the
     selection is reconciled rather than left pointing at something no longer
     offered. */
  const onCustomerChange = (customerId) => {
    const next = customerId ? getCustomer(data, customerId) : null;
    const nextPriced = new Set((next && next.priceList || []).map(p => p.finishedGoodId));
    setF(prev => {
      const stillOffered = !next || allowUnpriced || nextPriced.has(prev.finishedGoodId);
      return {
        ...prev, customerId,
        addressId: "",
        finishedGoodId: stillOffered ? prev.finishedGoodId : "",
        lotId: stillOffered ? prev.lotId : ""
      };
    });
  };

  const onProductChange = (finishedGoodId) => {
    const targetFg = getFinished(data, finishedGoodId);
    const firstLot = targetFg ? (targetFg.lots || []).find(l => (Number(l.qty) || 0) > 0) : null;
    setF(prev => ({ ...prev, finishedGoodId, lotId: firstLot ? firstLot.id : "" }));
  };

  const overStock = selectedLot && Number(f.qty) > Number(selectedLot.qty);
  const canSave = f.finishedGoodId && f.lotId && Number(f.qty) > 0 && !overStock;

  const save = () => {
    if (!canSave) return;
    update(d => tx.shipFinishedGoods(d, { ...f, lotId: selectedLot ? selectedLot.id : f.lotId }));
    onClose();
  };

  return (
    <Modal title="Ship finished goods" onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Customer" span={2}
          hint="Chosen first, because it decides what can be priced">
          <select style={inputStyle} value={f.customerId}
            onChange={e => onCustomerChange(e.target.value)}>
            <option value="">No customer — internal or sample movement</option>
            {(data.customers || []).map(c => (
              <option key={c.id} value={c.id}>
                {c.name} ({(c.priceList || []).length} priced line{(c.priceList || []).length === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        </Field>

        <Field label="Finished good" span={2}
          hint={customer
            ? (allowUnpriced
                ? "Showing everything, including lines this customer has no price for"
                : "Showing only what " + customer.name + " has an agreed price for")
            : "No customer selected, so nothing is priced"}>
          <select style={inputStyle} value={f.finishedGoodId}
            onChange={e => onProductChange(e.target.value)}>
            <option value="">Select a product\u2026</option>
            {sellable.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}{customer && !pricedIds.has(item.id) ? "  \u2014 no agreed price" : ""}
              </option>
            ))}
          </select>
        </Field>

        {customer && (
          <div style={{ gridColumn: "span 2", marginTop: -4 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12,
                            color: "#5B6470", cursor: "pointer" }}>
              <input type="checkbox" checked={allowUnpriced}
                onChange={e => setAllowUnpriced(e.target.checked)} />
              Allow products this customer has no price for
            </label>
            {customer && sellable.length === 0 && !allowUnpriced && (
              <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 4 }}>
                {customer.name} has no priced lines at all. Add pricing on the customer
                record, or tick the box above to ship anyway.
              </div>
            )}
          </div>
        )}

        <Field label="Lot" span={2}
          hint={selectedLot ? "Available: " + fmtNum(selectedLot.qty) + " " + (fg ? fg.unit : "")
                            : "No lots with stock available"}>
          <select style={inputStyle} value={selectedLot ? selectedLot.id : ""}
            onChange={e => set("lotId", e.target.value)}>
            {availableLots.length === 0 && <option value="">No lots available</option>}
            {availableLots.map(l => (
              <option key={l.id} value={l.id}>
                {(l.lotNumber || "Lot") + " \u00b7 " + fmtNum(l.qty) + " available"}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Quantity to ship">
          <input type="number" step="0.01" style={inputStyle} value={f.qty}
            onChange={e => set("qty", parseFloat(e.target.value) || 0)} />
        </Field>
        <Field label="Ship date">
          <input type="date" style={inputStyle} value={f.shipDate}
            onChange={e => set("shipDate", e.target.value)} />
        </Field>

        {customer && customer.addresses.length > 0 && (
          <Field label="Ship-to address" span={2}>
            <select style={inputStyle} value={f.addressId} onChange={e => set("addressId", e.target.value)}>
              <option value="">Not specified</option>
              {customer.addresses.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </Field>
        )}
        <Field label="Sales order">
          <input style={inputStyle} value={f.reference}
            onChange={e => set("reference", e.target.value)} placeholder="Internal order reference" />
        </Field>
        <Field label="Customer PO">
          <input style={inputStyle} value={f.customerPO}
            onChange={e => set("customerPO", e.target.value)} placeholder="Their purchase order" />
        </Field>
        <Field label="Bill of lading">
          <input style={inputStyle} value={f.bol}
            onChange={e => set("bol", e.target.value)} placeholder="BOL number" />
        </Field>
        <Field label="Carrier">
          <input style={inputStyle} value={f.carrier}
            onChange={e => set("carrier", e.target.value)} placeholder="Haulier" />
        </Field>
        <Field label="Tracking reference">
          <input style={inputStyle} value={f.trackingRef}
            onChange={e => set("trackingRef", e.target.value)} placeholder="Consignment or tracking number" />
        </Field>
        <Field label="Notes" span={2}>
          <input style={inputStyle} value={f.notes}
            onChange={e => set("notes", e.target.value)} placeholder="Delivery instructions, short shipments\u2026" />
        </Field>
      </div>

      {/* The revenue consequence, stated before saving rather than found later */}
      {f.finishedGoodId && (
        <div style={{
          padding: "9px 12px", marginTop: 14, borderRadius: 7, fontSize: 13,
          background: unpriced ? "#FCF4F3" : unitPrice != null ? "#F1F6F2" : "#F4F6F9",
          border: "1px solid " + (unpriced ? "#E3B9B2" : unitPrice != null ? "#CFE0D3" : "#DCE1E8")
        }}>
          {unitPrice != null && (
            <span>
              <b className="mono">{fmtMoney(unitPrice)}</b> per {fg ? fg.unit : "unit"} at this
              quantity \u2014 line value <b className="mono">{fmtMoney(unitPrice * (Number(f.qty) || 0))}</b>.
            </span>
          )}
          {unpriced && (
            <span style={{ color: "#8C332B" }}>
              <b>{customer.name} has no agreed price for {fg ? fg.name : "this product"}.</b>{" "}
              This shipment will record the quantity but contribute nothing to revenue.
              Add a price line on the customer record if it should be invoiced.
            </span>
          )}
          {!customer && (
            <span style={{ color: "#5B6470" }}>
              No customer, so this is a stock movement rather than a sale and will not
              appear in revenue.
            </span>
          )}
        </div>
      )}

      {availableLots.length === 0 && f.finishedGoodId && (
        <div style={{ fontSize: 12, color: "#B87510", marginTop: 10 }}>
          This product has no lots with stock available to ship.
        </div>
      )}
      {overStock && (
        <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 10 }}>
          Only {fmtNum(selectedLot.qty)} available in this lot \u2014 reduce the quantity or
          split the shipment across lots.
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save} style={{ opacity: canSave ? 1 : 0.5 }}>Record shipment</Btn>
      </div>
    </Modal>
  );
}

function MiniStat({ label, value, tone }) {
  const toneColor = tone === "bad" ? "#8A2E20" : tone === "good" ? "#1F5B3E" : "#20262B";
  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 11.5, color: "#7A8079", fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 700, color: toneColor, fontFamily: "'IBM Plex Mono', monospace" }}>{value}</div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Batch logging - shared by Admin (from a Process card) and
   Operator. Picks a process, and every input/output/equipment line
   is pre-populated from the process definition, ready for lot
   assignment.
----------------------------------------------------------------*/
// Forward traceability for a given lot: every downstream lot (anywhere in
// intermediate products or finished goods) whose own "Consumed from"
// sources reference it. Backward traceability is already just the lot's
// own `sources` array - this is the missing complement, computed on
// demand rather than stored, so there's nothing to keep in sync.
function findLotsConsumingLot(data, itemType, itemId, lotId) {
  const groupKey = itemType + ":" + itemId;
  const results = [];
  const scan = (items, downstreamType) => {
    items.forEach(item => {
      (item.lots || []).forEach(lot => {
        (lot.sources || []).forEach(s => {
          if (s.groupKey === groupKey && s.lotId === lotId) {
            results.push({ itemType: downstreamType, itemName: item.name, lotNumber: lot.lotNumber, qty: s.qty, unit: item.unit, date: lot.date });
          }
        });
      });
    });
  };
  scan(data.intermediateProducts, "intermediate");
  scan(data.finishedGoods, "finished");
  return results;
}

function buildSourceGroups(data, process) {
  return (process.inputs || []).map(line => {
    const item = getCatalogItem(data, line.itemType, line.itemId);
    if (!item) return null;
    return {
      key: line.itemType + ":" + line.itemId,
      label: item.name + " (" + line.itemType + ")",
      plannedQty: line.qty,
      lots: (item.lots || []).map(l => ({
        id: l.id,
        qty: Number(l.qty) || 0,
        unit: item.unit,
        label: (l.lotNumber || "Lot") + " · " + fmtDate(l.date) + " · " + fmtNum(l.qty) + " " + item.unit
      }))
    };
  }).filter(Boolean);
}

// A single 4in x 2in label, min 10pt text throughout, QR in the lower
// right. Composition prefers real per-lot QC checks over the standard
// recipe composition (see labelComposition).
function PrintLabel({ data, itemType, itemId, lotNumber, qty, unit, date, qcChecks }) {
  const item = getCatalogItem(data, itemType, itemId);
  if (!item) return null;
  const composition = labelComposition(data, itemType, itemId, qcChecks);
  const compositionText = composition.map(c => c.name + " " + fmtNum(c.percentage) + "%").join(" · ");
  const qrText = item.name + " | Lot: " + (lotNumber || "") + " | Qty: " + fmtNum(qty) + " " + unit + " | " + fmtDate(date);
  return (
    <div style={{
      width: "4in", height: "2in", padding: "0.14in", boxSizing: "border-box",
      display: "flex", flexDirection: "column", justifyContent: "space-between",
      fontFamily: "'IBM Plex Sans', sans-serif", fontSize: "10pt", color: "#000", background: "#fff",
      border: "1px solid #000", pageBreakAfter: "always", overflow: "hidden"
    }}>
      <div>
        <div style={{ fontSize: "13pt", fontWeight: 700, lineHeight: 1.15 }}>{item.name}</div>
        <div style={{ fontSize: "10pt" }}>SKU: {item.sku || "—"}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "0.1in" }}>
        <div style={{ fontSize: "10pt", lineHeight: 1.35 }}>
          <div><b>Lot:</b> {lotNumber || "—"}</div>
          <div><b>Qty:</b> {fmtNum(qty)} {unit}</div>
          <div><b>Date:</b> {fmtDate(date)}</div>
          <div><b>Composition:</b> {compositionText || "—"}</div>
          <div><b>Hazard Class:</b> {item.hazardClass || "N/A"}</div>
        </div>
        <img src={qrCodeUrl(qrText)} alt="QR code" style={{ width: "0.9in", height: "0.9in", flexShrink: 0 }} />
      </div>
    </div>
  );
}

function BatchLogModal({ data, kind, processId, onClose, update }) {
  const process = getProcess(data, processId);
  const outputs = process ? (kind ? process.outputs.filter(o => o.itemType === kind) : process.outputs) : [];
  const sourceGroups = process ? buildSourceGroups(data, process) : [];
  const equipmentOptions = process ? (process.equipment || []).map(e => getEquipment(data, e.equipmentId)).filter(Boolean) : [];
  const plannedHours = process ? process.productionTimeHours : 0;

  const [f, setF] = useState(() => {
    const batchLotNumber = process ? suggestBatchLotNumber(data, process, todayStr()) : "";
    return {
      date: todayStr(),
      notes: "",
      outputs: outputs.map(o => {
        const composition = computeEffectiveComposition(data, o.itemType, o.itemId);
        return {
          outputId: o.id, lotNumber: batchLotNumber, qty: o.qtyPerBatch || 0,
          qcChecks: composition.map(c => ({ id: uid(), componentId: c.componentId, mode: "estimated", measuredValue: "", concentration: c.percentage }))
        };
      }),
      sources: sourceGroups.map(g => ({ id: uid(), groupKey: g.key, lotId: g.lots[0] ? g.lots[0].id : "", qty: g.plannedQty })),
      actualEquipment: (process ? process.equipment : []).map(eq => ({ id: uid(), equipmentId: eq.equipmentId, hours: plannedHours })),
      actualLabor: []
    };
  });
  const [printableLots, setPrintableLots] = useState(null);
  const [attachment, setAttachment] = useState(null);
  const [attachmentStatus, setAttachmentStatus] = useState("idle"); // idle | uploading | done | error
  const [attachmentError, setAttachmentError] = useState("");

  const handleAttachmentUpload = async (file) => {
    if (!file) return;
    setAttachmentStatus("uploading");
    setAttachmentError("");
    try {
      const uploaded = await uploadAttachment(file);
      setAttachment(uploaded);
      setAttachmentStatus("done");
      update(d => tx.attachFileToLots(d, printableLots, uploaded));
    } catch (err) {
      setAttachmentStatus("error");
      setAttachmentError(err.message || "Upload failed.");
    }
  };

  const setCommon = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const updateOutputEntry = (idx, patch) => setF(prev => ({ ...prev, outputs: prev.outputs.map((o, i) => i === idx ? { ...o, ...patch } : o) }));
  const setOutputQcCheck = (idx, componentId, patch) => {
    let existing = [...(f.outputs[idx].qcChecks || [])];
    const cidx = existing.findIndex(q => q.componentId === componentId);
    const current = cidx >= 0 ? existing[cidx] : { id: uid(), componentId, mode: "manual", measuredValue: "", concentration: "" };
    const merged = { ...current, ...patch };
    if (merged.mode === "balance") {
      existing = existing.map(q => (q.componentId !== componentId && q.mode === "balance") ? { ...q, mode: "manual" } : q);
    }
    const idxAfter = existing.findIndex(q => q.componentId === componentId);
    if (idxAfter >= 0) existing[idxAfter] = merged;
    else existing.push(merged);
    existing = recomputeBalanceEntry(existing);
    updateOutputEntry(idx, { qcChecks: existing });
  };

  const addSource = () => {
    if (sourceGroups.length === 0) return;
    const g = sourceGroups[0];
    const l0 = g.lots[0];
    setF(prev => ({ ...prev, sources: [...prev.sources, { id: uid(), groupKey: g.key, lotId: l0 ? l0.id : "", qty: 1 }] }));
  };
  const updateSource = (idx, patch) => setF(prev => ({ ...prev, sources: prev.sources.map((s, i) => i === idx ? { ...s, ...patch } : s) }));
  const removeSource = (idx) => setF(prev => ({ ...prev, sources: prev.sources.filter((_, i) => i !== idx) }));

  const addActualEquipment = () => {
    if (equipmentOptions.length === 0) return;
    setF(prev => ({ ...prev, actualEquipment: [...prev.actualEquipment, { id: uid(), equipmentId: equipmentOptions[0].id, hours: 0 }] }));
  };
  const updateActualEquipment = (idx, patch) => setF(prev => ({ ...prev, actualEquipment: prev.actualEquipment.map((e, i) => i === idx ? { ...e, ...patch } : e) }));
  const removeActualEquipment = (idx) => setF(prev => ({ ...prev, actualEquipment: prev.actualEquipment.filter((_, i) => i !== idx) }));

  const addActualLabor = () => setF(prev => ({ ...prev, actualLabor: [...prev.actualLabor, { id: uid(), operatorName: "", hours: 0 }] }));
  const updateActualLabor = (idx, patch) => setF(prev => ({ ...prev, actualLabor: prev.actualLabor.map((l, i) => i === idx ? { ...l, ...patch } : l) }));
  const removeActualLabor = (idx) => setF(prev => ({ ...prev, actualLabor: prev.actualLabor.filter((_, i) => i !== idx) }));

  const totalEquipmentHours = sumHours(f.actualEquipment);
  const totalLaborHours = sumHours(f.actualLabor);

  const overConsumedSourceIds = f.sources.filter(s => {
    const g = sourceGroups.find(g => g.key === s.groupKey);
    const lot = g ? g.lots.find(l => l.id === s.lotId) : null;
    return lot && (Number(s.qty) || 0) > lot.qty;
  }).map(s => s.id);

  const canSave = f.outputs.some(o => o.qty > 0) && overConsumedSourceIds.length === 0;

  const wastePreview = useMemo(() => {
    const consumed = f.sources.map(s => {
      const sep = s.groupKey.indexOf(":");
      return { itemType: s.groupKey.slice(0, sep), itemId: s.groupKey.slice(sep + 1), qty: s.qty };
    });
    const produced = f.outputs.map((entry, idx) => {
      const outLine = outputs[idx];
      if (!outLine) return null;
      return { itemType: outLine.itemType, itemId: outLine.itemId, qty: entry.qty };
    }).filter(Boolean);
    return computeBatchComponentWaste(data, consumed, produced);
  }, [f.sources, f.outputs, data, outputs]);

  const save = () => {
    if (!canSave) return;
    let created = [];
    update(d => {
      created = tx.logProductionBatch(d, {
        processId, date: f.date, notes: f.notes, sources: f.sources, outputs: f.outputs,
        actualEquipment: f.actualEquipment, actualLabor: f.actualLabor,
        wasteAllocations: wastePreview
      });
    });
    setPrintableLots(created);
  };

  if (!process) return null;

  return (
    <Modal title={printableLots ? "Batch logged" : "Log production batch"} onClose={onClose} wide>
      {printableLots ? (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, color: "#1F5B3E" }}>
            <Badge tone="good">Saved</Badge>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{process.name}</span>
          </div>
          {printableLots.length === 0 && <div style={{ fontSize: 13, color: "#8A9099", marginBottom: 14 }}>No output quantities were entered, so no lots were created — only any waste this batch generated was logged, if applicable.</div>}
          {printableLots.map((lot, i) => {
            const item = getCatalogItem(data, lot.itemType, lot.itemId);
            return (
              <div key={i} style={{ background: "#FAFBF8", border: "1px solid #E7E9E4", borderRadius: 8, padding: 10, marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{item ? item.name : "(deleted item)"}</div>
                  <div className="mono" style={{ fontSize: 11.5, color: "#8A9099" }}>Lot {lot.lotNumber || "—"} · {fmtNum(lot.qty)} {lot.unit}</div>
                </div>
              </div>
            );
          })}
          {printableLots.length > 0 && (
            <div style={{ fontSize: 11.5, color: "#8A9099", marginTop: 10, marginBottom: 14 }}>
              Printing produces one 4"×2" label per lot above — name, lot number, quantity, composition, and hazard class, with a scannable QR code. Depends on your browser/printer being set up for that label size.
            </div>
          )}
          {printableLots.length > 0 && (
            <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 12, marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Attach paper form</div>
              <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 8 }}>
                Scan or photograph the paper batch record and attach it here — it'll be linked to every lot logged above (max {Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB).
              </div>
              {attachmentStatus === "done" && attachment ? (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <Badge tone="good">Attached</Badge>
                  <button type="button" onClick={() => openAttachment(attachment)} style={{ background: "none", border: "none", color: "#1F6F78", textDecoration: "underline", cursor: "pointer", fontSize: 12.5, padding: 0 }}>{attachment.fileName}</button>
                </div>
              ) : (
                <input type="file" accept="image/*,.pdf" disabled={attachmentStatus === "uploading"}
                  onChange={e => handleAttachmentUpload(e.target.files && e.target.files[0])}
                  style={{ fontSize: 12.5 }} />
              )}
              {attachmentStatus === "uploading" && <div style={{ fontSize: 11.5, color: "#8A9099", marginTop: 6 }}>Uploading…</div>}
              {attachmentStatus === "error" && <div style={{ fontSize: 11.5, color: "#8A2E20", marginTop: 6 }}>{attachmentError}</div>}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <Btn variant="secondary" onClick={onClose}>Done</Btn>
            {printableLots.length > 0 && <Btn onClick={() => window.print()}>Print labels</Btn>}
          </div>
          <div className="print-only">
            {printableLots.map((lot, i) => <PrintLabel key={i} data={data} itemType={lot.itemType} itemId={lot.itemId} lotNumber={lot.lotNumber} qty={lot.qty} unit={lot.unit} date={lot.date} qcChecks={lot.qcChecks} />)}
          </div>
        </div>
      ) : (
      <>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{process.name}</div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 8, marginBottom: 14 }}>
        <Field label="Batch date"><input type="date" style={inputStyle} value={f.date} onChange={e => setCommon("date", e.target.value)} /></Field>
        <Field label="Batch notes"><input style={inputStyle} value={f.notes} onChange={e => setCommon("notes", e.target.value)} placeholder="QC observations, deviations…" /></Field>
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 12, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>Consumed from</div>
          <Btn variant="secondary" onClick={addSource}><Plus size={13} />Add source lot</Btn>
        </div>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          One row per defined input, pre-filled with the planned quantity — pick the actual lot used and adjust the quantity if it differed.
        </div>
        {f.sources.length === 0 && <div style={{ fontSize: 12, color: "#8A9099" }}>This process has no defined inputs to source from.</div>}
        {f.sources.map((s, idx) => {
          const g = sourceGroups.find(g => g.key === s.groupKey);
          const groupLots = g ? g.lots : [];
          const selectedLot = groupLots.find(l => l.id === s.lotId);
          const overConsumed = selectedLot && (Number(s.qty) || 0) > selectedLot.qty;
          return (
            <div key={s.id} style={{ marginBottom: 6 }}>
              <div style={{
                display: "grid", gridTemplateColumns: "1.3fr 1.3fr 0.7fr 28px", gap: 6,
                padding: overConsumed ? 6 : 0, borderRadius: 6,
                background: overConsumed ? "#F3DBD6" : "transparent",
                border: overConsumed ? "1px solid #D97066" : "none"
              }}>
                <select style={inputStyle} value={s.groupKey} onChange={e => {
                  const newGroup = sourceGroups.find(g => g.key === e.target.value);
                  updateSource(idx, { groupKey: e.target.value, lotId: newGroup && newGroup.lots[0] ? newGroup.lots[0].id : "" });
                }}>
                  {sourceGroups.map(g => <option key={g.key} value={g.key}>{g.label}</option>)}
                </select>
                <select style={inputStyle} value={s.lotId} onChange={e => updateSource(idx, { lotId: e.target.value })}>
                  {groupLots.length === 0 && <option value="">No lots available</option>}
                  {groupLots.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
                </select>
                <input type="number" step="0.01" style={{ ...inputStyle, borderColor: overConsumed ? "#D97066" : "#D7DAD3" }} value={s.qty} onChange={e => updateSource(idx, { qty: parseFloat(e.target.value) || 0 })} />
                <IconBtn onClick={() => removeSource(idx)} title="Remove" danger><Trash2 size={12} /></IconBtn>
              </div>
              {overConsumed && (
                <div style={{ fontSize: 11.5, color: "#8A2E20", marginTop: 3, fontWeight: 600 }}>
                  This batch needs {fmtNum(s.qty)} {selectedLot.unit}, but this lot only has {fmtNum(selectedLot.qty)} {selectedLot.unit} — add another source lot to cover the rest before logging.
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 12, marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Outputs produced</div>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          Pre-filled with the planned yield per batch — adjust quantities to what was actually produced, and leave at 0 to skip an output this run. Lot numbers default to this batch's auto-generated identifier; edit individually if outputs need to be distinguished.
        </div>
        {outputs.length === 0 && <div style={{ fontSize: 12, color: "#B87510" }}>This process has no {kind || ""} outputs to log against.</div>}
        {f.outputs.map((entry, idx) => {
          const outLine = outputs[idx];
          const item = outLine ? getCatalogItem(data, outLine.itemType, outLine.itemId) : null;
          const qcComponents = item ? qcComponentCandidates(data, computeEffectiveComposition(data, outLine.itemType, outLine.itemId)) : [];
          return (
            <div key={entry.outputId} style={{ background: "#FAFBF8", border: "1px solid #E7E9E4", borderRadius: 8, padding: 10, marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{item ? item.name : "(deleted item)"}</span>
                {outLine && <Badge tone={outLine.itemType === "finished" ? "good" : "info"}>{outLine.itemType}</Badge>}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <input style={inputStyle} value={entry.lotNumber} onChange={e => updateOutputEntry(idx, { lotNumber: e.target.value })} placeholder="Lot / batch number" />
                <input type="number" step="0.01" style={inputStyle} value={entry.qty} onChange={e => updateOutputEntry(idx, { qty: parseFloat(e.target.value) || 0 })} placeholder={"Qty" + (item ? " (" + item.unit + ")" : "")} />
              </div>
              {qcComponents.length > 0 && (
                <div style={{ borderTop: "1px dashed #E0E3DA", marginTop: 8, paddingTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 6 }}>QC concentration checks</div>
                  <div style={{ fontSize: 11, color: "#8A9099", marginBottom: 6 }}>Pre-filled from this item's standard composition as an estimate — not a real reading until you pick Manual, Calculated, or Balance.</div>
                  {qcComponents.map(comp => {
                    const check = (entry.qcChecks || []).find(q => q.componentId === comp.id) || { mode: "estimated", measuredValue: "", concentration: "" };
                    const canCalc = comp.qcCalibration && comp.qcCalibration.enabled;
                    const toggleStyle = (active) => ({ fontSize: 10.5, padding: "2px 7px", borderRadius: 999, border: "1px solid #D7DAD3", background: active ? "#1F6F78" : "#fff", color: active ? "#fff" : "#5B6470", cursor: "pointer" });
                    return (
                      <div key={comp.id} style={{ marginBottom: 8 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                          <span style={{ fontSize: 12, color: "#5B6470" }}>{comp.name}</span>
                          <div style={{ display: "flex", gap: 4 }}>
                            <button type="button" onClick={() => setOutputQcCheck(idx, comp.id, { mode: "manual" })} style={toggleStyle(check.mode === "manual")}>Manual</button>
                            {canCalc && <button type="button" onClick={() => setOutputQcCheck(idx, comp.id, { mode: "calculated" })} style={toggleStyle(check.mode === "calculated")}>Calculated</button>}
                            <button type="button" onClick={() => setOutputQcCheck(idx, comp.id, { mode: "balance" })} style={toggleStyle(check.mode === "balance")}>Balance</button>
                          </div>
                        </div>
                        {check.mode === "estimated" ? (
                          <div className="mono" style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 10px", height: 34, borderRadius: 6, background: "#F6E6C8", color: "#7A5205", fontWeight: 600, fontSize: 13.5 }}>
                            {fmtNum(check.concentration)}% <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontWeight: 500, fontSize: 11 }}>(estimate — not yet checked)</span>
                          </div>
                        ) : check.mode === "balance" ? (
                          <div className="mono" style={{ display: "flex", alignItems: "center", padding: "0 10px", height: 34, borderRadius: 6, background: "#F2F3EE", color: "#3C4038", fontWeight: 600, fontSize: 13.5 }}>
                            Balance: {fmtNum(check.concentration)}%
                          </div>
                        ) : check.mode === "calculated" && canCalc ? (
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                            <input type="number" step="any" style={inputStyle} value={check.measuredValue} onChange={e => {
                              const measuredValue = e.target.value;
                              setOutputQcCheck(idx, comp.id, { measuredValue, concentration: computeQcConcentration(comp, measuredValue), mode: "calculated" });
                            }} placeholder={(comp.qcCalibration.measurementLabel || "Measured value") + (comp.qcCalibration.measurementUnit ? " (" + comp.qcCalibration.measurementUnit + ")" : "")} />
                            <div className="mono" style={{ display: "flex", alignItems: "center", padding: "0 10px", borderRadius: 6, background: "#F2F3EE", color: "#3C4038", fontWeight: 600, fontSize: 13.5 }}>
                              {check.measuredValue !== "" ? "= " + fmtNum(check.concentration) + "%" : "—"}
                            </div>
                          </div>
                        ) : (
                          <input type="number" step="any" style={inputStyle} value={check.concentration} onChange={e => setOutputQcCheck(idx, comp.id, { concentration: e.target.value, mode: "manual" })} placeholder="Concentration %" />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Actual production time <span style={{ fontWeight: 500, color: "#8A9099" }}>(planned {fmtNum(plannedHours)}h)</span></div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0 4px" }}>
          <div style={{ fontSize: 12, color: "#5B6470" }}>Equipment hours</div>
          <Btn variant="ghost" onClick={addActualEquipment} style={{ padding: "4px 8px", fontSize: 12 }}><Plus size={12} />Add</Btn>
        </div>
        <div style={{ fontSize: 11, color: "#8A9099", marginBottom: 6 }}>One row per equipment on this process, pre-filled with the planned batch time — adjust to actual hours.</div>
        {equipmentOptions.length === 0 && <div style={{ fontSize: 11.5, color: "#B87510" }}>No equipment defined for this process yet.</div>}
        {f.actualEquipment.map((e, idx) => (
          <div key={e.id} style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 28px", gap: 6, marginBottom: 6 }}>
            <select style={inputStyle} value={e.equipmentId} onChange={ev => updateActualEquipment(idx, { equipmentId: ev.target.value })}>
              {equipmentOptions.map(opt => <option key={opt.id} value={opt.id}>{opt.name}</option>)}
            </select>
            <input type="number" step="0.1" style={inputStyle} value={e.hours} onChange={ev => updateActualEquipment(idx, { hours: parseFloat(ev.target.value) || 0 })} placeholder="Hours" />
            <IconBtn onClick={() => removeActualEquipment(idx)} title="Remove" danger><Trash2 size={12} /></IconBtn>
          </div>
        ))}
        {f.actualEquipment.length > 0 && (
          <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10, display: "flex", gap: 6, alignItems: "center" }}>
            Total: {fmtNum(totalEquipmentHours)}h {varianceBadge(totalEquipmentHours, plannedHours)}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "8px 0 4px" }}>
          <div style={{ fontSize: 12, color: "#5B6470" }}>Labor hours</div>
          <Btn variant="ghost" onClick={addActualLabor} style={{ padding: "4px 8px", fontSize: 12 }}><Plus size={12} />Add</Btn>
        </div>
        {f.actualLabor.map((l, idx) => (
          <div key={l.id} style={{ display: "grid", gridTemplateColumns: "1fr 0.6fr 28px", gap: 6, marginBottom: 6 }}>
            <input style={inputStyle} value={l.operatorName} onChange={e => updateActualLabor(idx, { operatorName: e.target.value })} placeholder="Operator name" />
            <input type="number" step="0.1" style={inputStyle} value={l.hours} onChange={e => updateActualLabor(idx, { hours: parseFloat(e.target.value) || 0 })} placeholder="Hours" />
            <IconBtn onClick={() => removeActualLabor(idx)} title="Remove" danger><Trash2 size={12} /></IconBtn>
          </div>
        ))}
        {f.actualLabor.length > 0 && (
          <div style={{ fontSize: 11.5, color: "#8A9099", display: "flex", gap: 6, alignItems: "center" }}>
            Total: {fmtNum(totalLaborHours)}h {varianceBadge(totalLaborHours, plannedHours)}
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Waste generated this batch</div>
        <div style={{ fontSize: 11.5, color: "#8A9099", marginBottom: 10 }}>
          Computed automatically: everything consumed above, minus what shows up in the outputs' own composition. Recalculates live as you adjust sources and output quantities.
        </div>
        {wastePreview.length === 0 && <div style={{ fontSize: 12, color: "#8A9099" }}>No waste detected from the current sources and output quantities.</div>}
        {wastePreview.map(w => {
          const comp = getComponent(data, w.componentId);
          const ws = getWasteStreamForComponent(data, w.componentId);
          return (
            <div key={w.componentId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5, padding: "5px 0", borderBottom: "1px dashed #EEF0EA" }}>
              <span>{comp ? comp.name : "(unknown component)"}</span>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono">{fmtNum(w.wasteQty)} {comp ? comp.unit : ""}</span>
                {ws
                  ? <Badge tone={ws.accumulate ? "good" : "neutral"}>{ws.accumulate ? "→ " + ws.name : ws.name + " (not accumulated)"}</Badge>
                  : <Badge tone="warn">No waste stream linked</Badge>}
              </span>
            </div>
          );
        })}
      </div>

      {overConsumedSourceIds.length > 0 && (
        <div style={{ background: "#F3DBD6", border: "1px solid #D97066", borderRadius: 8, padding: "10px 12px", marginBottom: 4, fontSize: 12.5, color: "#8A2E20", fontWeight: 600 }}>
          {overConsumedSourceIds.length} source lot{overConsumedSourceIds.length === 1 ? " is" : "s are"} over-consumed, highlighted above — add an additional lot for each to cover the shortfall before this batch can be logged.
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save} style={{ opacity: canSave ? 1 : 0.5 }}>Log batch</Btn>
      </div>
      </>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------------
   OPERATOR VIEW
----------------------------------------------------------------*/
function ReceivingModal({ data, presetRawId, onClose, update }) {
  const [f, setF] = useState({
    rawMaterialId: presetRawId || (data.rawMaterials[0] ? data.rawMaterials[0].id : ""),
    lotNumber: "", date: todayStr(), qty: 0, notes: "", unitCost: ""
  });
  const set = (k, v) => setF(prev => ({ ...prev, [k]: v }));

  const raw = getRaw(data, f.rawMaterialId);

  const save = () => {
    if (!f.rawMaterialId || !f.qty) return;
    update(d => tx.receiveRawLot(d, f));
    onClose();
  };

  return (
    <Modal title="Receive raw material lot" onClose={onClose}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Raw material" span={2}>
          <select style={inputStyle} value={f.rawMaterialId} onChange={e => set("rawMaterialId", e.target.value)}>
            {data.rawMaterials.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </Field>
        {raw && <div style={{ gridColumn: "span 2", fontSize: 11.5, color: "#8A9099" }}>{raw.supplier} · current stock {fmtNum(lotQty(raw.lots))} {raw.unit}</div>}
        <Field label="Lot / batch number"><input style={inputStyle} value={f.lotNumber} onChange={e => set("lotNumber", e.target.value)} placeholder="Supplier lot ref" /></Field>
        <Field label="Received date"><input type="date" style={inputStyle} value={f.date} onChange={e => set("date", e.target.value)} /></Field>
        <Field label={"Quantity received" + (raw ? " (" + raw.unit + ")" : "")}><input type="number" step="0.01" style={inputStyle} value={f.qty} onChange={e => set("qty", parseFloat(e.target.value) || 0)} /></Field>
        <Field label={"Unit cost paid" + (raw ? " (per " + raw.unit + ")" : "")}
          hint={raw ? "Blank uses the current list price of " + fmtMoney(raw.unitCost) + ". Recorded on the lot, so a later price rise will not reprice this delivery." : undefined}>
          <input type="number" step="0.0001" style={inputStyle}
            value={f.unitCost === undefined ? "" : f.unitCost}
            placeholder={raw ? String(raw.unitCost) : ""}
            onChange={e => set("unitCost", e.target.value === "" ? "" : parseFloat(e.target.value))} />
        </Field>
        <Field label="Notes" span={2}><input style={inputStyle} value={f.notes} onChange={e => set("notes", e.target.value)} placeholder="Condition on arrival, packing slip ref…" /></Field>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <Btn variant="secondary" onClick={onClose}>Cancel</Btn>
        <Btn onClick={save}>Log receipt</Btn>
      </div>
    </Modal>
  );
}

function OperatorReceivingTab({ data, search, setSearch, onReceive }) {
  const rows = data.rawMaterials.filter(r => !search || r.name.toLowerCase().includes(search.toLowerCase()) || r.sku.toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <PageHeader tabKey="receiving" subtitle="Log incoming lots against existing raw materials"
        action={<SearchBox value={search} onChange={setSearch} placeholder="Search materials…" />} />
      <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, overflow: "hidden" }}>
        <table className="mrp-table">
          <thead><tr><th>Material</th><th>Supplier</th><th>Current stock</th><th>Lead time</th><th></th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td><div style={{ fontWeight: 600 }}>{r.name}</div><div className="mono" style={{ fontSize: 11, color: "#8A9099" }}>{r.sku}</div></td>
                <td>{r.supplier || "—"}</td>
                <td className="mono">{fmtNum(lotQty(r.lots))} {r.unit}</td>
                <td className="mono">{r.leadTimeDays}d</td>
                <td><div style={{ display: "flex", justifyContent: "flex-end" }}><Btn variant="secondary" onClick={() => onReceive(r.id)} style={{ padding: "6px 10px", fontSize: 12.5 }}><Plus size={13} />Receive</Btn></div></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} style={{ textAlign: "center", color: "#8A9099", padding: 24 }}>No raw materials match.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OperatorProcessCard({ process, data, onLogBatch }) {
  const recentLots = process.outputs.flatMap(o => {
    const item = getCatalogItem(data, o.itemType, o.itemId);
    return item ? (item.lots || []).map(l => ({ ...l, outputName: item.name, outputUnit: item.unit })) : [];
  }).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);

  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{process.name}</div>
          <div className="mono" style={{ fontSize: 11, color: "#8A9099", marginTop: 2 }}>{process.sku} · planned {fmtNum(process.productionTimeHours)}h</div>
        </div>
        <Btn onClick={onLogBatch} style={{ padding: "7px 12px", fontSize: 12.5 }}><Plus size={14} />Log batch</Btn>
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 10, marginTop: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Inputs (reference)</div>
        {process.inputs.map((line, idx) => {
          const item = getCatalogItem(data, line.itemType, line.itemId);
          if (!item) return null;
          return <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0" }}><span>{item.name}</span><span className="mono" style={{ color: "#5B6470" }}>{fmtNum(line.qty)} {item.unit}</span></div>;
        })}
      </div>

      {(process.equipment || []).length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
          {process.equipment.map((eqLine, idx) => {
            const item = getEquipment(data, eqLine.equipmentId);
            return item ? <Badge key={idx} tone={eqLine.status === "In-Use" ? "info" : "warn"}>{item.name}</Badge> : null;
          })}
        </div>
      )}

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 10, marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>
          Outputs {process.outputs.length > 1 ? "(" + process.outputs.length + " streams)" : ""}
        </div>
        {process.outputs.map((o, idx) => {
          const item = getCatalogItem(data, o.itemType, o.itemId);
          if (!item) return null;
          return (
            <div key={idx} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>{item.name} <Badge tone={o.itemType === "finished" ? "good" : "info"}>{o.itemType}</Badge></span>
              <span className="mono" style={{ color: "#5B6470" }}>{fmtNum(lotQty(item.lots))} {item.unit} on hand</span>
            </div>
          );
        })}
      </div>

      <div style={{ borderTop: "1px solid #EEF0EA", paddingTop: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Recent batches</div>
        {recentLots.length === 0 && <div style={{ fontSize: 12, color: "#8A9099" }}>No batches logged yet.</div>}
        {recentLots.map((l, idx) => (
          <div key={idx} style={{ fontSize: 12, padding: "4px 0", borderBottom: idx < recentLots.length - 1 ? "1px dashed #EEF0EA" : "none" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{l.outputName} · {l.lotNumber || "Lot"}</span>
              <span className="mono">{fmtDate(l.date)} · {fmtNum(l.qty)} {l.outputUnit}</span>
            </div>
            {(sumHours(l.actualEquipment) > 0 || sumHours(l.actualLabor) > 0) && (
              <div style={{ marginTop: 2, display: "flex", gap: 6 }}>
                {sumHours(l.actualEquipment) > 0 && <span className="mono" style={{ fontSize: 10.5, color: "#8A9099" }}>eq {fmtNum(sumHours(l.actualEquipment))}h</span>}
                {sumHours(l.actualLabor) > 0 && <span className="mono" style={{ fontSize: 10.5, color: "#8A9099" }}>labor {fmtNum(sumHours(l.actualLabor))}h</span>}
              </div>
            )}
          </div>
        ))}
      </div>

      {process.notes && <div style={{ fontSize: 12, color: "#7A8079", marginTop: 10, fontStyle: "italic" }}>{process.notes}</div>}
    </div>
  );
}

function OperatorProcessesTab({ data, search, setSearch, onLogBatch }) {
  const rows = data.processes.filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.sku.toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <PageHeader tabKey="opprocesses" subtitle="Run a batch against an existing process — recipes (inputs, equipment, outputs) are managed by admin"
        action={<SearchBox value={search} onChange={setSearch} placeholder="Search processes…" />} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {rows.map(p => <OperatorProcessCard key={p.id} process={p} data={data} onLogBatch={() => onLogBatch(p.id)} />)}
        {rows.length === 0 && <div style={{ color: "#8A9099", padding: 24 }}>No processes defined yet — ask admin to set one up.</div>}
      </div>
    </div>
  );
}

function OperatorCatalogCard({ item, data, itemType }) {
  const stock = lotQty(item.lots);
  const producer = findProcessForOutput(data, itemType, item.id);
  const balances = computeCompositionBalances(item, itemType, data);
  return (
    <div style={{ background: "#fff", border: "1px solid #E2E4DD", borderRadius: 10, padding: 16 }}>
      <div style={{ fontWeight: 700, fontSize: 14.5 }}>{item.name}</div>
      <div className="mono" style={{ fontSize: 11, color: "#8A9099", marginTop: 2 }}>{item.sku}</div>
      <div style={{ margin: "10px 0", fontSize: 12 }}>
        <span style={{ color: "#8A9099" }}>Stock: </span><span className="mono" style={{ fontWeight: 600 }}>{fmtNum(stock)} {item.unit}</span> <span style={{ color: "#A6ABA2" }}>({(item.lots || []).length} lot{(item.lots || []).length === 1 ? "" : "s"})</span>
      </div>
      <div style={{ fontSize: 12, color: producer ? "#5B6470" : "#B87510", marginBottom: 8 }}>
        {producer ? "Produced by: " + producer.name : "No process produces this item yet"}
      </div>
      <CompositionBadges composition={computeEffectiveComposition(data, itemType, item.id)} data={data} />
      {balances.length > 0 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #EEF0EA" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#7A8079", textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 4 }}>Composition balance</div>
          {balances.map((b, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "2px 0" }}>
              <span>{b.component.name}</span>
              <span className="mono" style={{ color: "#5B6470" }}>{fmtNum(b.qty)} {b.component.unit}-equiv. · {fmtMoney(b.value)}</span>
            </div>
          ))}
        </div>
      )}
      {item.notes && <div style={{ fontSize: 12, color: "#7A8079", marginTop: 10, fontStyle: "italic" }}>{item.notes}</div>}
    </div>
  );
}

function OperatorCatalogTab({ data, search, setSearch, itemType, tabKey, subtitle }) {
  const items = itemType === "finished" ? data.finishedGoods : data.intermediateProducts;
  const rows = items.filter(i => !search || i.name.toLowerCase().includes(search.toLowerCase()) || i.sku.toLowerCase().includes(search.toLowerCase()));
  return (
    <div>
      <PageHeader tabKey={tabKey} subtitle={subtitle}
        action={<SearchBox value={search} onChange={setSearch} placeholder="Search…" />} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {rows.map(i => <OperatorCatalogCard key={i.id} item={i} data={data} itemType={itemType} />)}
        {rows.length === 0 && <div style={{ color: "#8A9099", padding: 24 }}>Nothing here yet.</div>}
      </div>
    </div>
  );
}
