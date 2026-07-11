const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const groq = require('./groq');
const contacts = require('./contacts');
const config = require('./config');
const moderation = require('./moderation');

// ─────────────────────────────────────────────────────────────────────────────
// KILLSWITCH: Set WA_DM_AUTORESPOND=true in Render env to enable AI auto-replies
// to private DMs. DEFAULT = OFF — bot only notifies Sulley on Telegram.
// This prevents WhatsApp from logging out the account for bot-like DM activity.
// ─────────────────────────────────────────────────────────────────────────────
const DM_AUTORESPOND = String(process.env.WA_DM_AUTORESPOND || 'false').toLowerCase() === 'true';

// Simulate human typing delay (0.8s–3.5s)
async function humanDelay(text) {
  const wpm = 40;
  const words = Math.max(1, (text || '').split(' ').length);
  const ms = Math.min(3500, Math.max(800, Math.round((words / wpm) * 60000)));
  await new Promise(r => setTimeout(r, ms));
}

const IDLE_MS = 60 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;
const MAX_HISTORY = 14;
const ALWAYS_CHAT_MAX_HISTORY = 40;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.ADMIN_CHAT_ID || '8361316663';
const OWNER_PHONE = (process.env.WHATSAPP_PHONE_NUMBER || '233599931348');
const OWNER_JID = OWNER_PHONE.replace(/\D/g,'') + '@s.whatsapp.net';

const chats = new Map();

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

function getState(jid) {
  if (!chats.has(jid)) {
    chats.set(jid, {
      name: null,
      lastIncomingAt: 0,
      lastOwnerReplyAt: Date.now(),
      takeoverActive: false,
      history: [],
      historyLoadedFromDb: false
    });
  }
  return chats.get(jid);
}

function pushHistory(state, role, content, cap) {
  state.history.push({ role, content });
  const limit = cap || MAX_HISTORY;
  if (state.history.length > limit) state.history = state.history.slice(-limit);
}

const { notifyOwner } = require('./telegramNotify');

const RESPECT_RULE =
  "Always be warm, polite and respectful. " +
  "Do NOT reveal you are an AI or bot unless asked directly. " +
  "Do NOT make commitments, quote prices, or share personal/sensitive information. " +
  "If they ask something specific, just say he'll get back to them personally soon. " +
  "IMPORTANT — reply in the SAME language the person wrote in.";

async function generateReply(state) {
  const messages = [
    {
      role: 'system',
      content:
        "You are quietly covering Never Hide's (Sulley's) personal WhatsApp while he's briefly away. " +
        "Reply naturally — short, human, 1-3 sentences, not corporate. " + RESPECT_RULE
    },
    ...state.history
  ];
  return (await groq.chat(messages, { maxTokens: 300, temperature: 0.6 })).trim();
}

async function generateWelcomeReply(state) {
  const template = await config.getWelcomeTemplate();
  if (template) return template.replace(/\{name\}/gi, state.name || 'there');
  const tone = await config.getWelcomeTone();
  const toneLine = tone ? `Match this tone: "${tone}". ` : '';
  const messages = [
    {
      role: 'system',
      content:
        "This is the first time this person has messaged Sulley on WhatsApp and he's unavailable. " +
        "Send a warm, brief, respectful welcome. " + toneLine + RESPECT_RULE + " Keep it 1-3 sentences."
    },
    ...state.history
  ];
  return (await groq.chat(messages, { maxTokens: 250, temperature: 0.6 })).trim();
}

async function loadPersistedHistoryIfNeeded(state, contact) {
  if (state.historyLoadedFromDb) return;
  if (Array.isArray(contact.history) && contact.history.length) {
    state.history = [...contact.history, ...state.history].slice(-ALWAYS_CHAT_MAX_HISTORY);
  }
  state.historyLoadedFromDb = true;
}

async function persistFriendHistory(jid, state) {
  try {
    const trimmed = state.history.slice(-ALWAYS_CHAT_MAX_HISTORY);
    await contacts.upsertContact(jid, { history: trimmed });
  } catch (e) {
    console.error('persistFriendHistory error:', e.message);
  }
}

async function sendReply(sock, jid, text) {
  await humanDelay(text);
  try { await sock.sendPresenceUpdate('composing', jid); } catch (_) {}
  await new Promise(r => setTimeout(r, 900));
  try { await sock.sendPresenceUpdate('paused', jid); } catch (_) {}
  await sock.sendMessage(jid, { text });
}


// ─── Runtime DM toggle (called by bridge index.js /settings/dmreply) ──────
let _dmReplyRuntime = DM_AUTORESPOND; // starts from env

function setDmReply(enabled) {
  _dmReplyRuntime = !!enabled;
  console.log('DM auto-reply set to:', _dmReplyRuntime);
}

function isDmReplyEnabled() {
  return _dmReplyRuntime;
}

async function handleIncoming(sock, jid, msg) {
  let text = extractText(msg);
  const hasImage = !!msg.message?.imageMessage;
  const hasAudio = !!msg.message?.audioMessage;
  if (!text && !hasImage && !hasAudio) return;

  // Transcribe voice notes
  if (!text && hasAudio) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      const transcribed = await groq.transcribeAudio(buffer, 'voice.ogg');
      if (transcribed.text) text = transcribed.text;
    } catch (e) {
      console.error('dm audio transcription error:', e.message);
    }
  }

  const state = getState(jid);
  state.name = msg.pushName || state.name || jid.split('@')[0];
  state.lastIncomingAt = Date.now();

  // ── Moderation check (always runs, even if auto-reply is OFF) ─────────────
  let flagged = null;
  if (text) {
    try { const r = await moderation.classifyText(text); if (r.flag) flagged = r; } catch (_) {}
  }
  if (!flagged && hasImage) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      const r = await moderation.classifyImage(buffer.toString('base64'), msg.message.imageMessage.mimetype || 'image/jpeg');
      if (r.flag) flagged = r;
    } catch (e) { console.error('dm image moderation error:', e.message); }
  }

  if (flagged) {
    const newCount = await moderation.recordOffense(jid, 'dm', `${flagged.category}: ${flagged.reason || ''}`);
    if (newCount <= 1) {
      try { await sock.sendMessage(jid, { text: "Please keep this conversation respectful — continued messages like this may lead to being blocked." }); } catch (_) {}
      await notifyOwner(`⚠️ Flagged message from <b>${state.name}</b> (${jid.split('@')[0]}) as ${flagged.category} — warned them.\n\nReason: ${flagged.reason}`);
    } else {
      try { await sock.updateBlockStatus(jid, 'block'); } catch (e) { console.error('block error:', e.message); }
      await notifyOwner(`🚫 Blocked <b>${state.name}</b> (${jid.split('@')[0]}) after repeated violations.\n\nLast reason: ${flagged.reason}`);
    }
    return;
  }

  if (!text) return;

  // ── Notify Sulley on Telegram about every private DM (regardless of auto-reply) ──
  const preview = text.length > 200 ? text.slice(0, 200) + '…' : text;
  await notifyOwner(`💬 <b>Private WhatsApp DM</b>\n\n👤 <b>${state.name}</b> (${jid.split('@')[0]})\n\n"${preview}"`);

  // ── If DM auto-reply is disabled (default), stop here ─────────────────────
  if (!isDmReplyEnabled()) {
    // No AI reply sent — Sulley sees it on Telegram and replies himself
    return;
  }

  // ── DM_AUTORESPOND=true: full AI reply flow below ─────────────────────────
  let contact;
  try {
    contact = await contacts.getContact(jid);
  } catch (e) {
    console.error('contacts lookup error:', e.message);
    contact = null;
  }

  if (!contact) {
    pushHistory(state, 'user', text);
    try {
      await contacts.upsertContact(jid, { name: state.name, phone: jid.split('@')[0], welcomed: true, always_chat: false });
      state.takeoverActive = true;
      const reply = await generateWelcomeReply(state);
      await sendReply(sock, jid, reply);
      pushHistory(state, 'assistant', reply);
      await notifyOwner(`👋 New contact <b>${state.name}</b> messaged you — I sent a welcome.\n\nThey: "${text}"\nMe: "${reply}"\n\nReply yourself anytime to take over.`);
    } catch (e) { console.error('welcome flow error:', e.message); }
    return;
  }

  if (contact.always_chat) {
    await loadPersistedHistoryIfNeeded(state, contact);
    pushHistory(state, 'user', text, ALWAYS_CHAT_MAX_HISTORY);
    state.takeoverActive = true;
    try {
      const reply = await generateReply(state);
      await sendReply(sock, jid, reply);
      pushHistory(state, 'assistant', reply, ALWAYS_CHAT_MAX_HISTORY);
      await persistFriendHistory(jid, state);
    } catch (e) { console.error('always_chat reply error:', e.message); }
    return;
  }

  pushHistory(state, 'user', text);
  if (state.takeoverActive) {
    try {
      const reply = await generateReply(state);
      await sendReply(sock, jid, reply);
      pushHistory(state, 'assistant', reply);
    } catch (e) { console.error('autoresponder reply error:', e.message); }
  }
}

function handleOwnMessage(sock, jid, msg) {
  const text = extractText(msg);
  const state = getState(jid);
  state.lastOwnerReplyAt = Date.now();
  if (text) {
    pushHistory(state, 'assistant', text);
  }
  // Owner replied manually — takeover mode stays aware of the conversation
}

function startSweep(sock) {
  // Only matters when DM_AUTORESPOND is on — sweeps idle chats for takeover
  if (!DM_AUTORESPOND) return;
  setInterval(async () => {
    const now = Date.now();
    for (const [jid, state] of chats.entries()) {
      if (!jid.endsWith('@s.whatsapp.net')) continue;
      if (!state.lastIncomingAt) continue;
      const idleSinceIncoming = now - state.lastIncomingAt;
      const ownerRepliedLately = (now - state.lastOwnerReplyAt) < IDLE_MS;
      if (idleSinceIncoming > IDLE_MS && !ownerRepliedLately && !state.takeoverActive && state.history.length) {
        state.takeoverActive = true;
      }
    }
  }, SWEEP_MS);
}

module.exports = { handleIncoming, handleOwnMessage, startSweep, setDmReply, isDmReplyEnabled };
