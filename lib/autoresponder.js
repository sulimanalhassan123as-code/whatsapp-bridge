const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const groq = require('./groq');
const contacts = require('./contacts');
const config = require('./config');
const moderation = require('./moderation');

// ─────────────────────────────────────────────────────────────────────────────
// DM AUTO-REPLY LOGIC
// ─────────────────────────────────────────────────────────────────────────────
// Default: OFF — bot only notifies Sulley on Telegram when someone DMs.
// To enable for a specific contact: use /friend on <name> in the Telegram bot.
// That sets always_chat=true in wa_contacts table — ONLY those people get AI replies.
// This prevents WhatsApp from flagging the account for unsolicited bot messages.
// ─────────────────────────────────────────────────────────────────────────────

let _dmReplyEnabled = String(process.env.WA_DM_AUTORESPOND || 'false').toLowerCase() === 'true';

function setDmReply(enabled) {
  _dmReplyEnabled = !!enabled;
  console.log('[autoresponder] DM global auto-reply:', _dmReplyEnabled);
}

function isDmReplyEnabled() { return _dmReplyEnabled; }

// Simulate human typing delay
async function humanDelay(text) {
  const words = Math.max(1, (text || '').split(' ').length);
  const ms = Math.min(3500, Math.max(800, Math.round((words / 40) * 60000)));
  await new Promise(r => setTimeout(r, ms));
}

const MAX_HISTORY = 14;
const ALWAYS_CHAT_MAX = 40;

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

const chats = new Map();

function getState(jid) {
  if (!chats.has(jid)) {
    chats.set(jid, {
      name: null, lastIncomingAt: 0,
      history: [], historyLoaded: false
    });
  }
  return chats.get(jid);
}

function pushHistory(state, role, content, cap = MAX_HISTORY) {
  state.history.push({ role, content });
  if (state.history.length > cap) state.history = state.history.slice(-cap);
}

const { notifyOwner } = require('./telegramNotify');

const SYSTEM_PROMPT =
  "You are quietly covering Never Hide's (Sulley's) personal WhatsApp while he's away. " +
  "Reply naturally — warm, respectful, short (1-3 sentences), not corporate. " +
  "Do NOT reveal you are AI unless directly asked. " +
  "Do NOT make commitments, quote prices, or share personal info. " +
  "If they ask something specific, say Sulley will get back to them personally soon. " +
  "ALWAYS reply in the SAME language the person wrote in.";

async function generateReply(state) {
  return (await groq.chat([
    { role: 'system', content: SYSTEM_PROMPT },
    ...state.history
  ], { maxTokens: 300, temperature: 0.6 })).trim();
}

async function sendReply(sock, jid, text) {
  await humanDelay(text);
  try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {}
  await new Promise(r => setTimeout(r, 900));
  try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
  await sock.sendMessage(jid, { text });
}

async function handleIncoming(sock, jid, msg) {
  let text = extractText(msg);
  const hasImage = !!msg.message?.imageMessage;
  const hasAudio = !!msg.message?.audioMessage;
  if (!text && !hasImage && !hasAudio) return;

  // Transcribe voice notes
  if (!text && hasAudio) {
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      const t = await groq.transcribeAudio(buf, 'voice.ogg');
      if (t.text) text = t.text;
    } catch (e) { console.error('audio transcribe error:', e.message); }
  }

  const state = getState(jid);
  state.name = msg.pushName || state.name || jid.split('@')[0];
  state.lastIncomingAt = Date.now();

  // ── Moderation (always runs) ───────────────────────────────────────────────
  let flagged = null;
  if (text) {
    try { const r = await moderation.classifyText(text); if (r.flag) flagged = r; } catch (_) {}
  }
  if (!flagged && hasImage) {
    try {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      const r = await moderation.classifyImage(buf.toString('base64'), msg.message.imageMessage.mimetype || 'image/jpeg');
      if (r.flag) flagged = r;
    } catch (_) {}
  }

  if (flagged) {
    const count = await moderation.recordOffense(jid, 'dm', `${flagged.category}: ${flagged.reason || ''}`);
    if (count <= 1) {
      try { await sock.sendMessage(jid, { text: "Please keep this conversation respectful. Continued messages like this may lead to being blocked." }); } catch (_) {}
      await notifyOwner(`⚠️ Flagged DM from <b>${state.name}</b> (${jid.split('@')[0]}) — ${flagged.category}.\nReason: ${flagged.reason}`);
    } else {
      try { await sock.updateBlockStatus(jid, 'block'); } catch (_) {}
      await notifyOwner(`🚫 Blocked <b>${state.name}</b> after repeated violations.\nReason: ${flagged.reason}`);
    }
    return;
  }

  if (!text) return;

  // ── Look up contact in DB ─────────────────────────────────────────────────
  let contact = null;
  try { contact = await contacts.getContact(jid); } catch (_) {}

  const isFriend = contact?.always_chat === true;

  // ── Notify Sulley on Telegram for every DM ───────────────────────────────
  const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
  const friendTag = isFriend ? ' 🔁 <i>(friend — AI replying)</i>' : '';
  await notifyOwner(
    `💬 <b>Private WhatsApp DM</b>${friendTag}\n\n👤 <b>${state.name}</b> (${jid.split('@')[0]})\n\n"${preview}"`,
    true
  );

  // ── REPLY LOGIC ───────────────────────────────────────────────────────────
  // Only reply if:
  //   1. Contact is a marked friend (always_chat=true), OR
  //   2. Global DM auto-reply is on (_dmReplyEnabled)
  if (!isFriend && !_dmReplyEnabled) {
    // Just notify — don't reply. Safest for account health.
    return;
  }

  // Load persisted history for friends
  if (isFriend && !state.historyLoaded) {
    if (Array.isArray(contact.history) && contact.history.length) {
      state.history = [...contact.history, ...state.history].slice(-ALWAYS_CHAT_MAX);
    }
    state.historyLoaded = true;
  }

  pushHistory(state, 'user', text, isFriend ? ALWAYS_CHAT_MAX : MAX_HISTORY);

  try {
    const reply = await generateReply(state);
    await sendReply(sock, jid, reply);
    pushHistory(state, 'assistant', reply, isFriend ? ALWAYS_CHAT_MAX : MAX_HISTORY);

    // Persist history for friends
    if (isFriend) {
      try {
        await contacts.upsertContact(jid, { history: state.history.slice(-ALWAYS_CHAT_MAX) });
      } catch (_) {}
    }
  } catch (e) {
    console.error('DM reply error:', e.message);
  }
}

function handleOwnMessage(sock, jid, msg) {
  const text = extractText(msg);
  const state = getState(jid);
  if (text) pushHistory(state, 'assistant', text);
}

function startSweep() {
  // No sweep needed — replies are triggered per-message, not on idle timer
}

module.exports = { handleIncoming, handleOwnMessage, startSweep, setDmReply, isDmReplyEnabled };
