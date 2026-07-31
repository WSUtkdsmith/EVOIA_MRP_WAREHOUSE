// Shared / global state endpoint (BU-independent data).
//
// Under Option A the physical warehouse map — zones, racks, slots, floor
// geometry — is a single shared layout across all Business Units, while the
// pallets/inventory that sit in it are per-BU (stored via /api/state). This
// endpoint holds that shared, BU-independent data by key.
//
//   GET  /api/global?key=<key>   -> { data: <object or null>, updatedAt }
//   POST /api/global?key=<key>   body { data: <object> } -> { ok: true }
//
// The canonical key for the shared physical layout is "warehouse_layout". The
// warehouse front end is wired to read/write it in Phase 3 (unify the inventory
// spine on the shared map); the endpoint exists now so the storage seam is set.
//
// No authentication yet — deferred to the downstream security developer.

'use strict';

const db = require('./_db');

module.exports = async function handler(req, res) {
  try {
    await db.ensureSchema();

    const key = req.query.key;
    if (!key) return res.status(400).json({ error: 'Missing "key" query parameter' });

    if (req.method === 'GET') {
      return res.status(200).json(await db.getGlobal(key));
    }

    if (req.method === 'POST') {
      const data = (req.body || {}).data;
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'Missing or invalid "data" in request body' });
      }
      await db.setGlobal(key, data);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('EVOIA /api/global error:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
