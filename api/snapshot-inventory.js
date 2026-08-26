// Write down what the stock is worth, once a day, per business unit.
//
//   POST /api/snapshot-inventory            -> every business unit
//   POST /api/snapshot-inventory?bu=evoia   -> just that one
//   GET  /api/snapshot-inventory?bu=evoia   -> the snapshots already recorded
//
// Driven by the Vercel cron in vercel.json. The history exists because a
// valuation cannot be rebuilt afterwards: lots get consumed and costs get
// recalculated, so a figure not written down on the day is gone. Nothing here
// derives history — it only records the present.
//
// Idempotent on the date. Two runs on the same day replace rather than append,
// so a retry, an overlapping invocation or somebody pressing the dashboard
// button after the job has already fired cannot double-count.
//
// TIMEZONE: the cron fires on UTC, and the date stamped on the row is the UTC
// date. For a plant that is not on UTC, "11:59 pm local" is a different
// instant and possibly a different date — see the flag in
// docs/INTEGRATION-PLAN.md. Getting this wrong shifts a day's movement into
// the wrong bucket rather than losing it, but it is still wrong.
//
// No authentication yet — deferred to the downstream security developer. Note
// that this endpoint WRITES, unlike the other derived endpoints.

'use strict';

const db = require('./_db');
const T = require('./_tenancy');
const catalog = require('./_catalog');
const valuation = require('./_valuation');

const MRP_DATA_KEY = 'mrp_console_data';

/* The console stores its whole dataset under one key, and stores it either as
   an object or as a JSON string depending on how it was written. Both forms
   have to be preserved on the way back out: rewriting a string as an object
   would work here and then surprise whatever reads it next. */
async function captureOne(buId, { date, source, notes }) {
  const state = await db.getModuleState(buId, 'mrp');
  const envelope = state && state.data && typeof state.data === 'object' ? state.data : {};
  const mrpData = catalog.extractMrpData(envelope);
  if (!mrpData) {
    // No MRP data for this unit is not an error - a warehouse-only BU is a
    // legitimate configuration. There is simply nothing to value.
    return { businessUnit: buId, date: String(date).slice(0, 10), skipped: 'no MRP data' };
  }

  const row = valuation.snapshotRow(mrpData, { date, source, notes });
  const { list, replaced } = valuation.upsertSnapshot(mrpData.inventorySnapshots, row);
  const nextData = { ...mrpData, inventorySnapshots: list };
  const wasString = typeof envelope[MRP_DATA_KEY] === 'string';

  await db.setModuleState(buId, 'mrp', {
    ...envelope,
    [MRP_DATA_KEY]: wasString ? JSON.stringify(nextData) : nextData,
  });
  return { businessUnit: buId, date: row.date, replaced, totalValue: row.totalValue };
}

module.exports = async function handler(req, res) {
  try {
    await db.ensureSchema();

    if (req.method === 'GET') {
      const bu = req.query.bu || T.LEGACY_DEFAULT_BU;
      if (!(await db.unitExists(bu))) {
        return res.status(404).json({ error: `Unknown business unit "${bu}"` });
      }
      const state = await db.getModuleState(bu, 'mrp');
      // A warehouse-only BU has no MRP data at all, which is a legitimate
      // configuration rather than an error - it simply has nothing to report.
      const mrpData = catalog.extractMrpData(state && state.data) || {};
      const snapshots = Array.isArray(mrpData.inventorySnapshots) ? mrpData.inventorySnapshots : [];
      return res.status(200).json({
        businessUnit: bu,
        count: snapshots.length,
        snapshots: snapshots.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))),
      });
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Default to the UTC date the request arrived on. Overridable so a missed
    // night can be backfilled deliberately rather than by fiddling the clock.
    const date = String(req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    const source = req.query.source || 'cron';
    const one = req.query.bu;

    if (one) {
      if (!(await db.unitExists(one))) {
        return res.status(404).json({ error: `Unknown business unit "${one}"` });
      }
      return res.status(200).json({ date, captured: [await captureOne(one, { date, source })] });
    }

    // Every unit. One failing unit must not stop the rest — a snapshot missed
    // tonight cannot be recovered tomorrow, so partial success beats none.
    const units = await db.listUnits();
    const captured = [], failed = [];
    for (const u of units) {
      try { captured.push(await captureOne(u.id, { date, source })); }
      catch (e) { failed.push({ businessUnit: u.id, error: String(e && e.message || e) }); }
    }
    return res.status(failed.length && !captured.length ? 500 : 200).json({ date, captured, failed });
  } catch (err) {
    console.error('EVOIA /api/snapshot-inventory error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
};

module.exports.captureOne = captureOne;
