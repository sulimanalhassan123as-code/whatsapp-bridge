const groq = require('./groq');
const { notifyOwner } = require('./telegramNotify');
const contacts = require('./contacts');
const moderation = require('./moderation');

const URLSCAN_API_KEY = process.env.URLSCAN_API_KEY; // optional — upgrades accuracy when set

const URL_REGEX = /\bhttps?:\/\/[^\s<>"')]+|\bwww\.[^\s<>"')]+\.[a-z]{2,}[^\s<>"')]*/gi;
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'is.gd', 'cutt.ly', 'shorte.st', 'ow.ly', 'buff.ly', 'rebrand.ly', 'tiny.cc', 'rb.gy', 'shorturl.at', 'lnkd.in', 'v.gd'];
const SUSPICIOUS_TLDS = ['zip', 'mov', 'xyz', 'top', 'country', 'work', 'support', 'gq', 'tk', 'ml', 'click', 'link', 'kim', 'loan'];
const SUSPICIOUS_KEYWORDS = ['verify-account', 'verify now', 'account-locked', 'account locked', 'confirm-password', 'confirm your password', 'suspended', 'urgent action', 'claim-your', 'claim your', 'free-gift', 'whatsapp-verify', 'security-alert', 'update-billing', 'reset-password', 'login-required', 'gift-card', 'won a prize', 'you-have-won'];

function extractUrls(text) {
  if (!text) return [];
  const matches = text.match(URL_REGEX) || [];
  const normalized = matches.map(u => (u.startsWith('http') ? u : `http://${u}`));
  return [...new Set(normalized)].slice(0, 2); // cap at 2 links per message
}

function heuristicScan(url) {
  const reasons = [];
  let score = 0; // higher = more suspicious
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (e) {
    return { score: 1, reasons: ['could not parse the link structure'] };
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    score += 3;
    reasons.push('links straight to a raw IP address instead of a normal domain');
  }
  if (SHORTENERS.some(s => host === s || host.endsWith('.' + s))) {
    score += 2;
    reasons.push('uses a link shortener that hides the real destination');
  }
  const tld = host.split('.').pop();
  if (SUSPICIOUS_TLDS.includes(tld)) {
    score += 1;
    reasons.push(`ends in a domain extension (.${tld}) commonly abused for scams`);
  }
  if (url.includes('@')) {
    score += 3;
    reasons.push('contains an "@" trick that can hide the real destination');
  }
  if ((host.match(/-/g) || []).length >= 3) {
    score += 1;
    reasons.push('domain name has an unusually high number of hyphens');
  }
  const lower = url.toLowerCase();
  if (SUSPICIOUS_KEYWORDS.some(k => lower.includes(k))) {
    score += 2;
    reasons.push('contains wording commonly used in phishing links');
  }
  return { score, reasons };
}

async function groqAssess(url) {
  try {
    const raw = await groq.chat([
      {
        role: 'system',
        content:
          'You assess whether a URL looks like phishing, malware distribution, or a scam, based only on its text structure (domain, path, keywords) — you cannot browse it. ' +
          'Reply ONLY with JSON: {"risk": "safe"|"suspicious"|"dangerous", "reason": "short reason"}. Be reasonable — most normal links (news, social media, youtube, official brand domains) are safe.'
      },
      { role: 'user', content: url }
    ], { json: true, maxTokens: 120, temperature: 0 });
    const parsed = JSON.parse(raw);
    return { risk: parsed.risk || 'safe', reason: parsed.reason || '' };
  } catch (e) {
    console.error('linkSafety groqAssess error:', e.message);
    return { risk: 'safe', reason: '' };
  }
}

function thumScreenshot(url) {
  return `https://image.thum.io/get/width/1000/noanimate/${url}`;
}

async function urlscanCheck(url) {
  if (!URLSCAN_API_KEY) return null;
  try {
    const submitResp = await fetch('https://urlscan.io/api/v1/scan/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'API-Key': URLSCAN_API_KEY },
      body: JSON.stringify({ url, visibility: 'unlisted' })
    });
    if (!submitResp.ok) return null;
    const submitData = await submitResp.json();
    const resultUrl = submitData.api;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const resultResp = await fetch(resultUrl, { headers: { 'API-Key': URLSCAN_API_KEY } });
      if (resultResp.status === 200) {
        const data = await resultResp.json();
        return {
          malicious: !!data.verdicts?.overall?.malicious,
          score: data.verdicts?.overall?.score,
          screenshotUrl: data.task?.screenshotURL,
          pageTitle: data.page?.title
        };
      }
    }
    return null; // scan didn't finish in time — fall back to lighter checks
  } catch (e) {
    console.error('urlscanCheck error:', e.message);
    return null;
  }
}

async function analyzeLink(url) {
  const heuristic = heuristicScan(url);
  const [groqResult, urlscanResult] = await Promise.all([groqAssess(url), urlscanCheck(url)]);

  let verdict = 'looks safe';
  const reasons = [...heuristic.reasons];

  if (urlscanResult?.malicious) {
    verdict = 'dangerous';
    reasons.push('flagged malicious by a live security scan');
  } else if (groqResult.risk === 'dangerous' || heuristic.score >= 4) {
    verdict = 'dangerous';
    if (groqResult.reason) reasons.push(groqResult.reason);
  } else if (groqResult.risk === 'suspicious' || heuristic.score >= 2) {
    verdict = 'suspicious';
    if (groqResult.reason) reasons.push(groqResult.reason);
  }

  const screenshotUrl = urlscanResult?.screenshotUrl || thumScreenshot(url);

  return { url, verdict, reasons, screenshotUrl, pageTitle: urlscanResult?.pageTitle };
}

function formatCaption(result) {
  const icon = result.verdict === 'dangerous' ? '🚨' : result.verdict === 'suspicious' ? '⚠️' : '✅';
  const label = result.verdict === 'dangerous' ? 'Looks DANGEROUS' : result.verdict === 'suspicious' ? 'Looks SUSPICIOUS' : 'Looks safe';
  let text = `${icon} ${label} — here's a live look at the page so you don't have to tap it:\n${result.url}`;
  if (result.pageTitle) text += `\n\nPage title: ${result.pageTitle}`;
  if (result.reasons.length) text += `\n\nWhy:\n• ${result.reasons.join('\n• ')}`;
  if (result.verdict !== 'looks safe') text += `\n\nI'd avoid tapping the real link unless you know exactly who sent this.`;
  return text;
}

// Fetch the screenshot ourselves (with a real timeout + retry) instead of handing Baileys a bare URL
// to fetch blind — this way we can see exactly why a screenshot failed, and retry once if thum.io
// hands back a tiny placeholder while it's still rendering the page.
async function fetchScreenshotBuffer(screenshotUrl, attempt = 1) {
  const MAX_ATTEMPTS = 2;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const resp = await fetch(screenshotUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (!resp.ok) {
      console.error(`fetchScreenshotBuffer: HTTP ${resp.status} for ${screenshotUrl}`);
      return null;
    }
    const buffer = Buffer.from(await resp.arrayBuffer());
    // a real rendered page screenshot is virtually never this small — treat as a still-rendering placeholder
    if (buffer.length < 4000 && attempt < MAX_ATTEMPTS) {
      console.log(`fetchScreenshotBuffer: got a tiny (${buffer.length}b) placeholder, retrying once...`);
      await new Promise(r => setTimeout(r, 4000));
      return fetchScreenshotBuffer(screenshotUrl, attempt + 1);
    }
    return buffer;
  } catch (e) {
    console.error(`fetchScreenshotBuffer error (attempt ${attempt}) for ${screenshotUrl}:`, e.message);
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 3000));
      return fetchScreenshotBuffer(screenshotUrl, attempt + 1);
    }
    return null;
  }
}

async function checkAndReply(sock, jid, msg, contextLabel, isGroup) {
  const m = msg.message;
  const text = m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption;
  const urls = extractUrls(text);
  if (!urls.length) return;

  const senderJid = msg.key.participant || msg.key.remoteJid;

  for (const url of urls) {
    try {
      const result = await analyzeLink(url);
      const caption = formatCaption(result);
      const imageBuffer = await fetchScreenshotBuffer(result.screenshotUrl);
      if (imageBuffer) {
        try {
          await sock.sendMessage(jid, { image: imageBuffer, caption }, { quoted: msg });
        } catch (e) {
          console.error('linkSafety image send error (buffer fetched ok, WhatsApp send failed):', e.message);
          await sock.sendMessage(jid, { text: caption }, { quoted: msg });
        }
      } else {
        console.error(`linkSafety: no usable screenshot for ${url}, sending text-only verdict`);
        await sock.sendMessage(jid, { text: caption }, { quoted: msg });
      }
      if (result.verdict === 'dangerous') {
        await notifyOwner(`🚨 Dangerous link detected${contextLabel ? ` in ${contextLabel}` : ''}:\n${url}\n\nReasons: ${result.reasons.join('; ')}`);

        if (isGroup) {
          // In the group, once confirmed dangerous, remove the message so no one taps it by mistake.
          try {
            await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: false, id: msg.key.id, participant: senderJid } });
            await sock.sendMessage(jid, { text: '🗑️ Removed that link from the group since it scanned as dangerous.' });
          } catch (e) {
            console.error('linkSafety delete error:', e.message);
          }
          if (senderJid) {
            try {
              await sock.sendMessage(senderJid, { text: 'A link you posted in the group was removed because it scanned as a likely phishing/scam link. If that was a mistake, message an admin.' });
            } catch (e) { /* ignore DM failures */ }
          }
        } else if (senderJid) {
          // Can't delete someone else's message in a 1:1 chat, so the safety net here is blocking the
          // sender outright — unless they're a tagged friend, in which case we just flag it and let the
          // owner judge (avoids blocking a friend over a false positive).
          let isFriend = false;
          try {
            const contact = await contacts.getContact(senderJid);
            isFriend = !!(contact && contact.always_chat);
          } catch (e) { /* treat as not-a-friend on lookup failure */ }

          if (!isFriend) {
            try {
              await sock.updateBlockStatus(senderJid, 'block');
              await moderation.recordOffense(senderJid, 'dm', `dangerous_link: ${result.reasons.join('; ')}`);
              await notifyOwner(`🚫 Blocked <b>${senderJid.split('@')[0]}</b> after they sent a link that scanned as dangerous.\n\nUse /unblock ${senderJid.split('@')[0]} on Telegram if this was a mistake.`);
            } catch (e) {
              console.error('linkSafety DM block error:', e.message);
            }
          } else {
            await notifyOwner(`⚠️ A tagged friend sent a link that scanned as dangerous — not auto-blocked since they're trusted, but worth a look.`);
          }
        }
      } else if (result.verdict === 'suspicious') {
        await notifyOwner(`⚠️ Suspicious link detected${contextLabel ? ` in ${contextLabel}` : ''}:\n${url}\n\nReasons: ${result.reasons.join('; ')}`);
      }
    } catch (e) {
      console.error('linkSafety checkAndReply error:', e.message);
    }
  }
}

module.exports = { extractUrls, analyzeLink, checkAndReply };
