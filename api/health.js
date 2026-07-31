// Health check — confirms the serverless functions run, the database is
// reachable, and the schema seeded. Hit /api/health after deploying to verify
// the backend is wired before using the app.
//
//   GET /api/health
//   ok:  { ok: true,  db: 'connected', businessUnits: [{ id, name }, ...] }
//   err: { ok: false, db: 'error', error: '<message>' }   (HTTP 500)
//
// A 500 with db:'error' almost always means POSTGRES_URL is missing — add the
// Neon Postgres integration in Vercel Storage, which sets it automatically.

'use strict';

const db = require('./_db');

module.exports = async function handler(req, res) {
  try {
    await db.ensureSchema();
    const units = await db.listUnits();
    return res.status(200).json({
      ok: true,
      db: 'connected',
      businessUnits: units.map((u) => ({ id: u.id, name: u.name })),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      db: 'error',
      error: String((err && err.message) || err),
    });
  }
};
