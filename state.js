// EVWB shared inventory database endpoint.
// Stores the entire app "state" object as one JSON row in Postgres (Neon,
// connected via the Vercel Storage integration). This keeps the live
// inventory data separate from the app code, so redeploying the app never
// touches real inventory data, and every location/device reads and writes
// the same shared record.
//
// GET  /api/state  -> { data: <state object or null>, updatedAt: <ISO string or null> }
// POST /api/state   body: { data: <state object> } -> { ok: true }
//
// Note: this endpoint has no authentication of its own. Access control for
// who can view/edit inventory is still enforced client-side in the app (same
// as before this change). Anyone with the deployment URL and this route path
// could technically read or write state directly. Flagged as a known
// limitation, not a new regression introduced by this change.

const { sql } = require('@vercel/postgres');

const ROW_ID = 'main';

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS app_state (
      id text PRIMARY KEY,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

module.exports = async function handler(req, res) {
  try {
    await ensureTable();

    if (req.method === 'GET') {
      const { rows } = await sql`SELECT data, updated_at FROM app_state WHERE id = ${ROW_ID}`;
      if (rows.length === 0) {
        return res.status(200).json({ data: null, updatedAt: null });
      }
      return res.status(200).json({ data: rows[0].data, updatedAt: rows[0].updated_at });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const data = body.data;
      if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'Missing or invalid "data" in request body' });
      }
      const json = JSON.stringify(data);
      await sql`
        INSERT INTO app_state (id, data, updated_at)
        VALUES (${ROW_ID}, ${json}::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
      `;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('EVWB /api/state error:', err);
    return res.status(500).json({ error: String((err && err.message) || err) });
  }
};
