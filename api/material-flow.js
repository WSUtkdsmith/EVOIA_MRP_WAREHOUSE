// The warehouse's material-flow worklist for a Business Unit.
//
//   GET /api/material-flow?bu=<id>
//     -> { businessUnit, requests, returns, inProcess, positions, counts }
//
// What has been asked for and not yet picked, what is mid-handover in a To/From
// position, and what Operations is currently holding. Derived from the BU's MRP
// data so the warehouse never parses MRP documents.
//
// Read-only on purpose: staging, receiving and accepting all move custody, and
// those go through the MRP's own transactions so its enforcement stays
// authoritative. There is deliberately no endpoint here that moves material.
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

    const state = await db.getModuleState(bu, 'mrp');
    const mrpData = catalog.extractMrpData(state.data);

    return res.status(200).json({
      businessUnit: bu,
      updatedAt: state.updatedAt,
      hasMrpData: !!mrpData,
      ...flow.deriveMaterialFlow(mrpData),
    });
  } catch (err) {
    console.error('EVOIA /api/material-flow error:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
