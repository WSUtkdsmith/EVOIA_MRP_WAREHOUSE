// Picks and put-aways the warehouse has done that the MRP has not recorded.
//
//   GET /api/pending-material-actions?bu=<id>
//     -> { businessUnit, pending: [...], applied: [...], counts: {...} }
//
// Read-only. Recording an action creates or moves custody, and that goes through
// the MRP's own tx.applyWarehouseMaterialActions so its enforcement stays
// authoritative — the same line held for dock receipts.
//
// No authentication yet — deferred to the downstream security developer.

'use strict';

const db = require('./_db');
const T = require('./_tenancy');
const catalog = require('./_catalog');
const flow = require('./_material-flow');

module.exports = async function handler(req, res) {
  try {
    await db.ensureSchema();
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    const bu = req.query.bu || T.LEGACY_DEFAULT_BU;
    if (!(await db.unitExists(bu))) {
      return res.status(404).json({ error: `Unknown business unit "${bu}"` });
    }
    const [warehouse, mrp] = await Promise.all([
      db.getModuleState(bu, 'warehouse'),
      db.getModuleState(bu, 'mrp'),
    ]);
    const mrpData = catalog.extractMrpData(mrp.data);
    return res.status(200).json({
      businessUnit: bu,
      ...flow.derivePendingMaterialActions(warehouse.data, mrpData),
    });
  } catch (err) {
    console.error('EVOIA /api/pending-material-actions error:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
