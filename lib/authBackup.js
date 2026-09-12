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
    // order=updated_at.desc + LIMIT so that if legacy duplicate rows ever
    // existed, we ALWAYS restore the newest backup — never a stale one
    const rows = await sb('wa_bridge_auth?id=eq.1&select=data,updated_at&order=updated_at.desc&limit=1');
    if (!rows || !rows.length || !rows[0].data) {
      console.log('No saved WhatsApp session in Supabase — fresh pairing needed.');
      return false;
    }
    const files = rows[0].data;
    // NEVER restore an unregistered session — that is stale junk that
    // causes 401 Unauthorized loops; better to pair fresh
    let registered = false;
    try { registered = !!JSON.parse(Buffer.from(files['creds.json'], 'base64').toString('utf8')).registered; } catch (e) {}
    if (!registered) {
      console.log('Supabase backup exists but creds are UNREGISTERED (stale mid-pairing junk) — refusing to restore, will pair fresh.');
      return false;
    }
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(AUTH_DIR, name), Buffer.from(content, 'base64'));
    }
    console.log(`Restored ${Object.keys(files).length} session file(s) from Supabase (backup from ${rows[0].updated_at}).`);
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
    // READ-BACK VERIFY: if the upsert silently failed (e.g. missing PK
    // on id), the next restart would restore a stale session and die
    // with Unauthorized. We refuse to believe the backup worked until
    // Supabase hands back exactly what we saved.
    const back = await sb('wa_bridge_auth?id=eq.1&select=data,updated_at&order=updated_at.desc&limit=1');
    const okBack = back && back.length && back[0].data &&
                   Object.keys(back[0].data).length === Object.keys(files).length &&
                   back[0].data['creds.json'] === files['creds.json'];
    if (!okBack) {
      console.error('backupAuthState VERIFY FAILED — Supabase row does not match what we saved! Clearing to force a clean state.');
      await sb('wa_bridge_auth?id=eq.1', { method: 'DELETE', prefer: 'return=minimal' });
    } else {
      console.log(`backupAuthState verified: ${Object.keys(files).length} files persisted (${new Date().toISOString()})`);
    }
  } catch (e) {
    console.error('backupAuthState error:', e.message);
  }
}

// Wipes the local auth_state dir AND the Supabase-backed copy.
// Must be called when WhatsApp reports the device as logged out — otherwise
// every reconnect attempt just restores the same invalid session and loops forever
// instead of ever asking Baileys for a fresh pairing code.
async function clearAuthState() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    // Recreate the (now empty) directory — Baileys' useMultiFileAuthState
    // writes creds.json into AUTH_DIR without creating it first, so if the
    // folder itself is missing the very next connect attempt crashes with
    // ENOENT and takes the whole process down with it.
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    console.log('Cleared local auth_state directory.');
  } catch (e) {
    console.error('clearAuthState (local) error:', e.message);
  }
  try {
    await sb('wa_bridge_auth?id=eq.1', { method: 'DELETE', prefer: 'return=minimal' });
    console.log('Cleared Supabase-backed auth_state.');
  } catch (e) {
    console.error('clearAuthState (supabase) error:', e.message);
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

module.exports = { restoreAuthState, backupAuthState, clearAuthState, saveGroupInfo, loadGroupInfo, AUTH_DIR, _sbRaw: sb };
