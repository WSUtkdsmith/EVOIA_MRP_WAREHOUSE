// Per-Business-Unit, per-module state endpoint.
//
// Stores a module's app "state" object as one JSON row, scoped to a Business
// Unit, so the live inventory data stays separate from the app code (redeploying
// never touches data) and every device reads/writes the same shared record for
// that BU.
//
//   GET  /api/state?bu=<id>&module=<mrp|warehouse>
//        -> { data: <state object or null>, updatedAt: <ISO string or null> }
//   POST /api/state?bu=<id>&module=<mrp|warehouse>
//        body { data: <state object> } -> { ok: true }
//
// Back-compat: with no query params this resolves to the legacy target
// (Business Unit 2 "Liventia", warehouse module) so the pre-tenancy warehouse
// build keeps working until the app shell passes bu/module explicitly (Phase 2).
//
// Note: this endpoint has no authentication of its own. Access control for who
// may view/edit inventory is deferred to the downstream security developer and
// belongs at this API layer. Anyone with the deployment URL and this route could
// currently read or write state directly. Flagged as a known, intentional gap
// for the sanitized-data build — not a regression.

'use strict';

const db = require('./_db');
const T = require('./_tenancy');

module.exports = async function handler(req, res) {
  try {
    await db.ensureSchema();

    const bu = req.query.bu || T.LEGACY_DEFAULT_BU;
    const module = req.query.module || T.LEGACY_DEFAULT_MODULE;

    if (!T.validateModule(module)) {
      return res.status(400).json({ error: `Unknown module "${module}"` });
    }
    if (!(await db.unitExists(bu))) {
      return res.status(404).json({ error: `Unknown business unit "${bu}"` });
    }

    if (req.method === 'GET') {
      return res.status(200).json(await db.getModuleState(bu, module));
    }

    if (req.method === 'POST') {
      const data = (req.body || {}).data;
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'Missing or invalid "data" in request body' });
      }
      await db.setModuleState(bu, module, data);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('EVOIA /api/state error:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
