const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = process.env.ADMIN_CHAT_ID || '8361316663';

async function notifyOwner(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch (e) { console.error('notifyOwner error:', e.message); }
}

module.exports = { notifyOwner };
