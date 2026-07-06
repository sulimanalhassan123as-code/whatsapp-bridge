const groq = require('./groq');
const contacts = require('./contacts');
const config = require('./config');

const IDLE_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_MS = 5 * 60 * 1000; // check every 5 min
const MAX_HISTORY = 14; // casual / one-off contacts (in-memory only)
const ALWAYS_CHAT_MAX_HISTORY = 40; // tagged friends get deeper, persisted memory

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.ADMIN_CHAT_ID || '8361316663';

const chats = new Map(); // jid -> state

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
      lastOwnerReplyAt: Date.now(), // assume owner "active" until proven otherwise
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

async function notifyOwner(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch (e) { console.error('notifyOwner error:', e.message); }
}

const RESPECT_RULE =
  "Always be warm, polite and respectful — the person you're talking to could be a stranger, an elder, a younger person, or a close friend, so never be overly casual, presumptuous or familiar unless they clearly set that tone first. " +
  "Do NOT reveal you are an AI or bot unless asked directly. " +
  "Do NOT make commitments, quote prices, discuss business/payment details, or share any personal/sensitive information. " +
  "If they ask something specific or important, just say he'll get back to them personally soon.";

async function generateReply(state) {
  const messages = [
    {
      role: 'system',
      content:
        "You are quietly covering Never Hide's (Sulley's) personal WhatsApp while he's briefly away from his phone. " +
        "Reply naturally in a respectful, friendly voice — short, human, 1-3 sentences, not corporate. " + RESPECT_RULE
    },
    ...state.history
  ];
  return (await groq.chat(messages, { maxTokens: 300, temperature: 0.6 })).trim();
}

async function generateWelcomeReply(state) {
  const template = await config.getWelcomeTemplate();
  if (template) {
    return template.replace(/\{name\}/gi, state.name || 'there');
  }
  const messages = [
    {
      role: 'system',
      content:
        "This is the very first message this person has ever sent to Never Hide (Sulley) on WhatsApp, and he's not available right now. " +
        "Send a warm, respectful, brief welcome reply — acknowledge what they said naturally. Treat them courteously, as you would greet someone you don't know yet, regardless of their age or how they wrote to you. " +
        RESPECT_RULE + " Keep it short, 1-3 sentences."
    },
    ...state.history
  ];
  return (await groq.chat(messages, { maxTokens: 250, temperature: 0.6 })).trim();
}

async function loadPersistedHistoryIfNeeded(state, contact) {
  if (state.historyLoadedFromDb) return;
  if (Array.isArray(contact.history) && contact.history.length) {
    // merge persisted history before the in-memory turns we already have
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

async function handleIncoming(sock, jid, msg) {
  const text = extractText(msg);
  if (!text) return;
  const state = getState(jid);
  state.name = msg.pushName || state.name || jid.split('@')[0];
  state.lastIncomingAt = Date.now();

  let contact;
  try {
    contact = await contacts.getContact(jid);
  } catch (e) {
    console.error('contacts lookup error:', e.message);
    contact = null;
  }

  if (!contact) {
    // brand new contact — welcome them right away, don't wait for the 1hr timer
    pushHistory(state, 'user', text);
    try {
      await contacts.upsertContact(jid, { name: state.name, phone: jid.split('@')[0], welcomed: true, always_chat: false });
      state.takeoverActive = true;
      const reply = await generateWelcomeReply(state);
      await sock.sendMessage(jid, { text: reply });
      pushHistory(state, 'assistant', reply);
      await notifyOwner(`👋 New contact <b>${state.name}</b> messaged you for the first time — I sent a welcome and I'm covering the chat for now.\n\nThey said: "${text}"\nI replied: "${reply}"\n\nReply to them yourself anytime to take over.`);
    } catch (e) {
      console.error('welcome flow error:', e.message);
    }
    return;
  }

  if (contact.always_chat) {
    // flagged as a friend the AI can always chat with — deeper, persisted memory,
    // responds immediately, no idle wait. Runs independently of every other chat's own logic below.
    await loadPersistedHistoryIfNeeded(state, contact);
    pushHistory(state, 'user', text, ALWAYS_CHAT_MAX_HISTORY);
    state.takeoverActive = true;
    try {
      const reply = await generateReply(state);
      await sock.sendMessage(jid, { text: reply });
      pushHistory(state, 'assistant', reply, ALWAYS_CHAT_MAX_HISTORY);
      await persistFriendHistory(jid, state);
    } catch (e) {
      console.error('always_chat reply error:', e.message);
    }
    return;
  }

  pushHistory(state, 'user', text);
  if (state.takeoverActive) {
    try {
      const reply = await generateReply(state);
      await sock.sendMessage(jid, { text: reply });
      pushHistory(state, 'assistant', reply);
    } catch (e) {
      console.error('autoresponder reply error:', e.message);
    }
  }
}

function handleOwnMessage(sock, jid, msg) {
  const text = extractText(msg);
  const state = getState(jid);
  state.lastOwnerReplyAt = Date.now();
  if (text) pushHistory(state, 'assistant', text);
  if (state.takeoverActive) {
    state.takeoverActive = false;
    notifyOwner(`👋 Saw you reply to <b>${state.name || jid}</b> yourself — I've stepped back on that chat.`);
  }
}

let sweepStarted = false;
let currentSock = null;

function startSweep(sock) {
  currentSock = sock;
  if (sweepStarted) return; // avoid stacking multiple intervals across reconnects
  sweepStarted = true;
  setInterval(async () => {
    const sock = currentSock;
    if (!sock) return;
    const now = Date.now();
    for (const [jid, state] of chats.entries()) {
      if (!state.takeoverActive && state.lastIncomingAt > state.lastOwnerReplyAt && (now - state.lastIncomingAt) >= IDLE_MS) {
        state.takeoverActive = true;
        try {
          const reply = await generateReply(state);
          await sock.sendMessage(jid, { text: reply });
          pushHistory(state, 'assistant', reply);
          await notifyOwner(`🤖 You didn't reply to <b>${state.name || jid}</b> for over an hour, so I stepped in to keep the conversation going.\n\nI said: "${reply}"\n\nJust reply to them yourself on WhatsApp anytime to take back over.`);
        } catch (e) {
          console.error('sweep reply error:', e.message);
        }
      }
    }
  }, SWEEP_MS);
}

module.exports = { handleIncoming, handleOwnMessage, startSweep };
