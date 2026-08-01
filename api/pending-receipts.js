// Deliveries booked at the dock that the MRP has not been told about yet.
//
//   GET /api/pending-receipts?bu=<id>
//     -> { businessUnit, pending: [...], applied: [...], counts: {...} }
//
// Read-only on purpose. Applying a booking creates stock, and that goes through
// the MRP's own `tx.applyWarehouseReceipts` so its enforcement, pricing and
// idempotency ledger stay authoritative — there is deliberately no endpoint
// here that writes a lot.
//
// No authentication yet — deferred to the downstream security developer.

'use strict';

const db = require('./_db');
const T = require('./_tenancy');
const catalog = require('./_catalog');
const receipts = require('./_receipts');

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
    const derived = receipts.derivePendingReceipts(warehouse.data, mrpData);

    return res.status(200).json({ businessUnit: bu, ...derived });
  } catch (err) {
    console.error('EVOIA /api/pending-receipts error:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
