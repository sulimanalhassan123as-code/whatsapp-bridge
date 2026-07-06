const groq = require('./groq');

const IDLE_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_MS = 5 * 60 * 1000; // check every 5 min
const MAX_HISTORY = 14;

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
      history: []
    });
  }
  return chats.get(jid);
}

function pushHistory(state, role, content) {
  state.history.push({ role, content });
  if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
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

async function generateReply(state) {
  const messages = [
    {
      role: 'system',
      content:
        "You are quietly covering Never Hide's (Sulley's) personal WhatsApp while he's briefly away from his phone. " +
        "Someone messaged him and he hasn't replied yet. Reply warmly and naturally in his relaxed, friendly texting voice — " +
        "short, human, 1-3 sentences, not corporate. Do NOT reveal you are an AI or bot unless asked directly. " +
        "Do NOT make commitments, quote prices, discuss business/payment details, or share any personal/sensitive information. " +
        "If they ask something specific or important, just say he'll get back to them personally soon."
    },
    ...state.history
  ];
  return (await groq.chat(messages, { maxTokens: 300, temperature: 0.6 })).trim();
}

async function handleIncoming(sock, jid, msg) {
  const text = extractText(msg);
  if (!text) return;
  const state = getState(jid);
  state.name = msg.pushName || state.name || jid.split('@')[0];
  state.lastIncomingAt = Date.now();
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
