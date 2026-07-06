const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`
};

async function getContact(jid) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/wa_contacts?jid=eq.${encodeURIComponent(jid)}&select=*`, { headers });
  const rows = await resp.json().catch(() => []);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function upsertContact(jid, fields) {
  await fetch(`${SUPABASE_URL}/rest/v1/wa_contacts`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ jid, last_seen_at: new Date().toISOString(), ...fields }])
  });
}

module.exports = { getContact, upsertContact };
