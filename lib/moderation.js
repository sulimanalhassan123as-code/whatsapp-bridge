const groq = require('./groq');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

const headers = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`
};

async function classifyText(text) {
  if (!text || !text.trim()) return { flag: false, category: 'none', reason: '' };
  try {
    const raw = await groq.chat([
      {
        role: 'system',
        content:
          'You moderate messages sent to Never Hide (Sulley) on WhatsApp. Classify the message. ' +
          'Reply ONLY with JSON: {"flag": true|false, "category": "insult"|"harassment"|"sexual_text"|"none", "reason": "short reason"}. ' +
          'Flag genuine insults, harassment, threats, or unwanted sexual/explicit text. Do NOT flag normal disagreement, jokes between friends, slang, or mild banter — only flag things that are clearly abusive, disrespectful, or inappropriate.'
      },
      { role: 'user', content: text }
    ], { json: true, maxTokens: 150, temperature: 0 });
    const parsed = JSON.parse(raw);
    return { flag: !!parsed.flag, category: parsed.category || 'none', reason: parsed.reason || '' };
  } catch (e) {
    console.error('classifyText error:', e.message);
    return { flag: false, category: 'none', reason: '' };
  }
}

async function classifyImage(base64Data, mimetype) {
  try {
    const raw = await groq.chat([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Does this image contain nudity, sexual content, or other clearly inappropriate/explicit material? ' +
              'Reply ONLY with JSON: {"flag": true|false, "category": "nudity"|"sexual"|"none", "reason": "short reason"}.'
          },
          { type: 'image_url', image_url: { url: `data:${mimetype || 'image/jpeg'};base64,${base64Data}` } }
        ]
      }
    ], { model: VISION_MODEL, json: true, maxTokens: 150, temperature: 0 });
    const parsed = JSON.parse(raw);
    return { flag: !!parsed.flag, category: parsed.category || 'none', reason: parsed.reason || '' };
  } catch (e) {
    console.error('classifyImage error:', e.message);
    // fail safe: don't block on a moderation-system error
    return { flag: false, category: 'none', reason: '' };
  }
}

async function getOffense(jid, scope) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/moderation_offenses?jid=eq.${encodeURIComponent(jid)}&scope=eq.${scope}&select=*`, { headers });
    const rows = await resp.json().catch(() => []);
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (e) {
    console.error('getOffense error:', e.message);
    return null;
  }
}

async function recordOffense(jid, scope, reason) {
  const existing = await getOffense(jid, scope);
  // offenses older than 30 days don't carry over — fresh start
  const stale = existing && existing.last_offense_at &&
    (Date.now() - new Date(existing.last_offense_at).getTime()) > 30 * 24 * 60 * 60 * 1000;
  const newCount = (existing && !stale) ? existing.count + 1 : 1;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/moderation_offenses`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{ jid, scope, count: newCount, last_offense_at: new Date().toISOString(), last_reason: reason }])
    });
  } catch (e) {
    console.error('recordOffense error:', e.message);
  }
  return newCount;
}

async function resetOffense(jid, scope) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/moderation_offenses`, {
      method: 'POST',
      headers: { ...headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify([{ jid, scope, count: 0, last_offense_at: null, last_reason: null }])
    });
  } catch (e) {
    console.error('resetOffense error:', e.message);
  }
}

module.exports = { classifyText, classifyImage, getOffense, recordOffense, resetOffense };
