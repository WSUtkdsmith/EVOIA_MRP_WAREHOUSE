// Business Unit management endpoint.
//
//   GET    /api/business-units            -> { units: [{ id, name, seq }, ...] }
//   POST   /api/business-units            body { name }        -> { unit }
//   PATCH  /api/business-units?id=<id>     body { name }        -> { ok: true }   (rename)
//   DELETE /api/business-units?id=<id>                          -> { ok: true }
//
// No authentication yet — deferred to the downstream security developer.

'use strict';

const db = require('./_db');
const T = require('./_tenancy');

module.exports = async function handler(req, res) {
  try {
    await db.ensureSchema();

    if (req.method === 'GET') {
      return res.status(200).json({ units: await db.listUnits() });
    }

    if (req.method === 'POST') {
      const v = T.validateBuName((req.body || {}).name);
      if (!v.ok) return res.status(400).json({ error: v.error });
      return res.status(201).json({ unit: await db.createUnit(v.value) });
    }

    if (req.method === 'PATCH') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Missing business unit id' });
      const v = T.validateBuName((req.body || {}).name);
      if (!v.ok) return res.status(400).json({ error: v.error });
      const ok = await db.renameUnit(id, v.value);
      return ok
        ? res.status(200).json({ ok: true })
        : res.status(404).json({ error: 'Business unit not found' });
    }

    if (req.method === 'DELETE') {
      const id = req.query.id;
      if (!id) return res.status(400).json({ error: 'Missing business unit id' });
      const r = await db.deleteUnit(id);
      return r.ok ? res.status(200).json({ ok: true }) : res.status(400).json({ error: r.error });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('EVOIA /api/business-units error:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
