const express = require('express');
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const { restoreAuthState, backupAuthState, saveGroupInfo, loadGroupInfo, AUTH_DIR } = require('./lib/authBackup');
const autoresponder = require('./lib/autoresponder');
const groupModeration = require('./lib/groupModeration');
const groupAdmin = require('./lib/groupAdmin');
const moderation = require('./lib/moderation');
const linkSafety = require('./lib/linkSafety');
const config = require('./lib/config');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.ADMIN_CHAT_ID || '8361316663';
const WHATSAPP_GROUP_LINK = process.env.WHATSAPP_GROUP_LINK || 'https://chat.whatsapp.com/KgIgMe13FNL7usRvDA8AQ6';
const PHONE_NUMBER = process.env.WHATSAPP_PHONE_NUMBER || '233599931348';
const BRIDGE_SECRET = process.env.WA_BRIDGE_SECRET;
const PORT = process.env.PORT || 3001;

let sock = null;
let groupJid = null;
let groupName = null;
let isWhatsAppReady = false;
let pairingCodeRequested = false;

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    whatsapp: isWhatsAppReady ? 'connected' : 'disconnected',
    group: groupName || groupJid || 'not_joined',
    uptime: process.uptime()
  });
});

// Internal API: called by neverhide-assistant to relay a message into the WhatsApp group
app.post('/send', async (req, res) => {
  if (BRIDGE_SECRET && req.get('x-bridge-secret') !== BRIDGE_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { message } = req.body || {};
  if (!message || !message.trim()) {
    return res.status(400).json({ ok: false, error: 'message required' });
  }
  if (!isWhatsAppReady || !groupJid) {
    return res.status(503).json({ ok: false, error: 'whatsapp not connected or group not joined yet' });
  }
  try {
    await sock.sendMessage(groupJid, { text: message });
    res.json({ ok: true, group: groupName || groupJid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Internal API: send a direct 1-on-1 WhatsApp message to any number (e.g. encouragement pings from Idea Arena)
function normalizeGhanaNumber(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  if (digits.startsWith('0') && digits.length === 10) return '233' + digits.slice(1);
  if (digits.startsWith('233')) return digits;
  if (digits.length === 9) return '233' + digits; // missing leading 0
  return digits; // already has some country code, or unknown format — pass through
}

app.post('/dm/send', async (req, res) => {
  if (BRIDGE_SECRET && req.get('x-bridge-secret') !== BRIDGE_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { number, message } = req.body || {};
  if (!number) return res.status(400).json({ ok: false, error: 'number required' });
  if (!message || !message.trim()) return res.status(400).json({ ok: false, error: 'message required' });
  if (!isWhatsAppReady) {
    return res.status(503).json({ ok: false, error: 'whatsapp not connected yet' });
  }
  const jid = groupAdmin.normalizeJid(normalizeGhanaNumber(number));
  if (!jid) return res.status(400).json({ ok: false, error: 'invalid number' });
  try {
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true, jid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/group/add', async (req, res) => {
  if (BRIDGE_SECRET && req.get('x-bridge-secret') !== BRIDGE_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { number } = req.body || {};
  if (!number) return res.status(400).json({ ok: false, error: 'number required' });
  if (!isWhatsAppReady || !groupJid) {
    return res.status(503).json({ ok: false, error: 'whatsapp not connected or group not joined yet' });
  }
  try {
    await groupAdmin.addParticipant(sock, groupJid, number);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/group/remove', async (req, res) => {
  if (BRIDGE_SECRET && req.get('x-bridge-secret') !== BRIDGE_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { number } = req.body || {};
  if (!number) return res.status(400).json({ ok: false, error: 'number required' });
  if (!isWhatsAppReady || !groupJid) {
    return res.status(503).json({ ok: false, error: 'whatsapp not connected or group not joined yet' });
  }
  try {
    await groupAdmin.removeParticipant(sock, groupJid, number);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/moderation/unblock', async (req, res) => {
  if (BRIDGE_SECRET && req.get('x-bridge-secret') !== BRIDGE_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { number, scope } = req.body || {};
  if (!number) return res.status(400).json({ ok: false, error: 'number required' });
  const jid = groupAdmin.normalizeJid(number);
  try {
    await moderation.resetOffense(jid, scope || 'dm');
    if (!scope || scope === 'dm') {
      try { await sock.updateBlockStatus(jid, 'unblock'); } catch (e) { /* may not have been blocked */ }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/settings/antilink', async (req, res) => {
  if (BRIDGE_SECRET && req.get('x-bridge-secret') !== BRIDGE_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ ok: false, error: 'enabled (boolean) required' });
  }
  const ok = await config.setAntilinkEnabled(enabled);
  res.json({ ok });
});

app.get('/settings/antilink', async (req, res) => {
  if (BRIDGE_SECRET && req.get('x-bridge-secret') !== BRIDGE_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const enabled = await config.getAntilinkEnabled();
  res.json({ ok: true, enabled });
});

app.listen(PORT, () => {
  console.log('Bridge server on port ' + PORT);
});

async function confirmGroup(attempt = 1) {
  const MAX_ATTEMPTS = 5;
  try {
    const inviteCode = WHATSAPP_GROUP_LINK.split('/').pop();
    const groupData = await sock.groupGetInviteInfo(inviteCode);
    try { await sock.groupAcceptInvite(inviteCode); } catch (e) {}

    const groups = await sock.groupFetchAllParticipating();
    const found = Object.values(groups).find(g => g.id === groupData.id || g.subject === groupData.subject);
    const newJid = found ? found.id : groupData.id;
    const newName = found ? found.subject : groupData.subject;
    const wasAlreadyKnown = !!groupJid;
    groupJid = newJid;
    groupName = newName;
    await saveGroupInfo(groupJid, groupName);

    if (!wasAlreadyKnown) {
      await sendTelegramMessage(
        '✅ WhatsApp Bridge Connected!\n\nGroup: ' + groupName + '\n\nUse /group &lt;message&gt; on the assistant bot to post into this group.'
      );
    }
  } catch (err) {
    console.error(`Group confirm attempt ${attempt} error:`, err.message);
    if (attempt < MAX_ATTEMPTS) {
      setTimeout(() => confirmGroup(attempt + 1), attempt * 5000);
    } else if (!groupJid) {
      // Only alarm the owner if we truly have no usable group JID (fresh install, cache also empty)
      await sendTelegramMessage('⚠️ WhatsApp connected, but could not confirm the group after several tries: ' + err.message);
    } else {
      console.log('Group confirm failed after retries, but using cached group info from Supabase — /group still works.');
    }
  }
}

async function connectWhatsApp() {
  await restoreAuthState();

  if (!groupJid) {
    const cached = await loadGroupInfo();
    if (cached) {
      groupJid = cached.groupJid;
      groupName = cached.groupName;
      console.log(`Restored cached group from Supabase: ${groupName}`);
    }
  }
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'warn' }),
    defaultQueryTimeoutMs: 60000,
    mobile: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await backupAuthState();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    console.log('Connection update:', connection || 'other');

    if (connection === 'connecting' && !sock.authState.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      setTimeout(async () => {
        try {
          console.log('Requesting pairing code...');
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log('PAIRING CODE:', code);
          await sendTelegramMessage(
            '📱 <b>WhatsApp Pairing Code</b>\n\n' +
            'Your code: <b>' + code + '</b>\n\n' +
            'Steps:\n' +
            '1. Open WhatsApp on your phone\n' +
            '2. Settings → Linked Devices\n' +
            '3. Tap "Link a Device"\n' +
            '4. Tap "Link with phone number instead"\n' +
            '5. Enter: <b>' + code + '</b>\n\n' +
            '⏰ Do it now, code expires quickly!'
          );
        } catch (e) {
          console.error('Pairing code error:', e.message);
          pairingCodeRequested = false;
        }
      }, 3000);
    }

    if (connection === 'open') {
      console.log('WhatsApp connected!');
      isWhatsAppReady = true;
      await backupAuthState();
      confirmGroup(); // don't block the connection handler on this — it retries internally
    }

    if (connection === 'close') {
      isWhatsAppReady = false;
      pairingCodeRequested = false;
      const shouldReconnect = (lastDisconnect && lastDisconnect.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      if (shouldReconnect) {
        console.log('Reconnecting...');
        setTimeout(connectWhatsApp, 2000);
      } else {
        console.log('Logged out — fresh pairing will be needed.');
        setTimeout(connectWhatsApp, 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
    if (type !== 'notify') return;
    for (const msg of msgs) {
      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;
      if (!msg.message) continue;
      try {
        if (jid.endsWith('@g.us')) {
          if (jid === groupJid && !msg.key.fromMe) {
            const handled = await groupModeration.handleGroupMessage(sock, groupJid, msg);
            if (!handled) {
              await linkSafety.checkAndReply(sock, groupJid, msg, 'the group', true);
            }
          }
          continue;
        }
        if (msg.key.fromMe) {
          autoresponder.handleOwnMessage(sock, jid, msg);
        } else {
          await linkSafety.checkAndReply(sock, jid, msg, null);
          await autoresponder.handleIncoming(sock, jid, msg);
        }
      } catch (e) {
        console.error('messages.upsert handler error:', e.message);
      }
    }
  });

  autoresponder.startSweep(sock);
}

async function sendTelegramMessage(text) {
  try {
    await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (err) { console.error('TG send error:', err.message); }
}

connectWhatsApp();
