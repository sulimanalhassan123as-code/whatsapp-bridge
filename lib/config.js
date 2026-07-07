const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const headers = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`
};

async function getWelcomeTemplate() {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/wa_config?id=eq.1&select=welcome_template`, { headers });
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows.length ? rows[0].welcome_template : null;
  } catch (e) {
    console.error('getWelcomeTemplate error:', e.message);
    return null;
  }
}



async function getAntilinkEnabled() {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/wa_config?id=eq.1&select=antilink_enabled`, { headers });
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows.length ? !!rows[0].antilink_enabled : false;
  } catch (e) {
    console.error('getAntilinkEnabled error:', e.message);
    return false;
  }
}

async function setAntilinkEnabled(enabled) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/wa_config?id=eq.1`, {
      method: 'PATCH',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({ antilink_enabled: enabled, updated_at: new Date().toISOString() })
    });
    return true;
  } catch (e) {
    console.error('setAntilinkEnabled error:', e.message);
    return false;
  }
}

module.exports = { getWelcomeTemplate, getAntilinkEnabled, setAntilinkEnabled };
