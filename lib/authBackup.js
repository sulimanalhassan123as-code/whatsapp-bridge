const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTH_DIR = path.join(__dirname, '..', 'auth_state');

async function sb(path_, opts = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path_}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=minimal'
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Supabase ${opts.method || 'GET'} ${path_} -> ${resp.status}: ${t}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

// Pulls the saved auth_state (if any) from Supabase and writes it to disk
// before Baileys tries to load it. Safe no-op if nothing saved yet.
async function restoreAuthState() {
  try {
    const rows = await sb('wa_bridge_auth?id=eq.1&select=data');
    if (!rows || !rows.length || !rows[0].data) {
      console.log('No saved WhatsApp session in Supabase — fresh pairing needed.');
      return false;
    }
    const files = rows[0].data;
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(AUTH_DIR, name), Buffer.from(content, 'base64'));
    }
    console.log(`Restored ${Object.keys(files).length} session file(s) from Supabase.`);
    return true;
  } catch (e) {
    console.error('restoreAuthState error:', e.message);
    return false;
  }
}

// Reads every file currently in auth_state and upserts it as a JSON blob.
async function backupAuthState() {
  try {
    if (!fs.existsSync(AUTH_DIR)) return;
    const names = fs.readdirSync(AUTH_DIR);
    const files = {};
    for (const name of names) {
      const full = path.join(AUTH_DIR, name);
      if (fs.statSync(full).isFile()) {
        files[name] = fs.readFileSync(full).toString('base64');
      }
    }
    await sb('wa_bridge_auth', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: { id: 1, data: files, updated_at: new Date().toISOString() }
    });
  } catch (e) {
    console.error('backupAuthState error:', e.message);
  }
}

async function loadGroupInfo() {
  try {
    const rows = await sb('wa_bridge_group?id=eq.1&select=group_jid,group_name');
    if (!rows || !rows.length || !rows[0].group_jid) return null;
    return { groupJid: rows[0].group_jid, groupName: rows[0].group_name };
  } catch (e) {
    console.error('loadGroupInfo error:', e.message);
    return null;
  }
}

async function saveGroupInfo(groupJid, groupName) {
  try {
    await sb('wa_bridge_group', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates',
      body: { id: 1, group_jid: groupJid, group_name: groupName, updated_at: new Date().toISOString() }
    });
  } catch (e) {
    console.error('saveGroupInfo error:', e.message);
  }
}

module.exports = { restoreAuthState, backupAuthState, saveGroupInfo, loadGroupInfo, AUTH_DIR };
