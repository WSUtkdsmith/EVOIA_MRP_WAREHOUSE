// Shared inventory catalog for a Business Unit.
//
//   GET /api/catalog?bu=<id>
//     -> { businessUnit, skus: [...], lots: [...], counts: {...}, updatedAt }
//
// Derived from the BU's MRP data so the warehouse can catalog and slot real
// stock without parsing MRP internals. The derivation itself is pure and lives
// in api/_catalog.js; this handler only fetches and shapes the response.
//
// Returns an empty catalog (not an error) when the BU has no MRP data yet, so
// the warehouse can show "nothing to catalog" rather than fail.
//
// No authentication yet — deferred to the downstream security developer.

'use strict';

const db = require('./_db');
const T = require('./_tenancy');
const catalog = require('./_catalog');

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

    const state = await db.getModuleState(bu, 'mrp');
    const mrpData = catalog.extractMrpData(state.data);
    const derived = catalog.deriveCatalog(mrpData, new Date());

    return res.status(200).json({
      businessUnit: bu,
      updatedAt: state.updatedAt,
      hasMrpData: !!mrpData,
      ...derived,
    });
  } catch (err) {
    console.error('EVOIA /api/catalog error:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
