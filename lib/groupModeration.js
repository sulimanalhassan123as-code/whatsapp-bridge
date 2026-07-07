const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const moderation = require('./moderation');
const config = require('./config');
const linkSafety = require('./linkSafety');
const { notifyOwner } = require('./telegramNotify');

const adminCache = { groupJid: null, admins: new Set(), fetchedAt: 0 };

async function isSenderAdmin(sock, groupJid, senderJid) {
  const now = Date.now();
  if (adminCache.groupJid !== groupJid || now - adminCache.fetchedAt > 5 * 60 * 1000) {
    try {
      const meta = await sock.groupMetadata(groupJid);
      adminCache.groupJid = groupJid;
      adminCache.admins = new Set(meta.participants.filter(p => p.admin).map(p => p.id));
      adminCache.fetchedAt = now;
    } catch (e) {
      console.error('isSenderAdmin metadata error:', e.message);
      return false;
    }
  }
  return adminCache.admins.has(senderJid);
}

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

async function handleGroupMessage(sock, groupJid, msg) {
  const senderJid = msg.key.participant || msg.key.remoteJid;
  if (!senderJid) return false;

  const text = extractText(msg);
  const hasImage = !!msg.message?.imageMessage;
  if (!text && !hasImage) return false;

  // Antilink: if enabled, non-admins can't post links at all — delete immediately.
  if (text && linkSafety.extractUrls(text).length) {
    const antilinkOn = await config.getAntilinkEnabled();
    if (antilinkOn) {
      const admin = await isSenderAdmin(sock, groupJid, senderJid);
      if (!admin) {
        try {
          await sock.sendMessage(groupJid, { delete: { remoteJid: groupJid, fromMe: false, id: msg.key.id, participant: senderJid } });
        } catch (e) {
          console.error('antilink delete error:', e.message);
        }
        const pushName = msg.pushName || senderJid.split('@')[0];
        try {
          await sock.sendMessage(senderJid, { text: 'Links are not allowed in the group right now — your message was removed. Ask an admin if you need to share something.' });
        } catch (e) { /* ignore */ }
        await notifyOwner(`🔗🚫 Antilink removed a link from <b>${pushName}</b> (${senderJid.split('@')[0]}) in the group.`);
        return true; // link already handled, skip link-safety flow for this message
      }
    }
  }

  let flagged = null;

  if (text) {
    const r = await moderation.classifyText(text);
    if (r.flag) flagged = r;
  }

  if (!flagged && hasImage) {
    try {
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, { reuploadRequest: sock.updateMediaMessage });
      const base64 = buffer.toString('base64');
      const mimetype = msg.message.imageMessage.mimetype || 'image/jpeg';
      const r = await moderation.classifyImage(base64, mimetype);
      if (r.flag) flagged = r;
    } catch (e) {
      console.error('group image moderation error:', e.message);
    }
  }

  if (!flagged) return false;

  const senderNumber = senderJid.split('@')[0];
  const pushName = msg.pushName || senderNumber;

  // remove the offending message — requires the bot's account to be a group admin
  try {
    await sock.sendMessage(groupJid, { delete: { remoteJid: groupJid, fromMe: false, id: msg.key.id, participant: senderJid } });
  } catch (e) {
    console.error('group delete error:', e.message);
  }

  const newCount = await moderation.recordOffense(senderJid, 'group', `${flagged.category}: ${flagged.reason || ''}`);

  if (newCount <= 1) {
    try {
      await sock.sendMessage(senderJid, {
        text: "Hi, this is the group admin's assistant. A message you posted was removed for being inappropriate. Please keep things respectful in the group — a repeat of this may lead to being removed."
      });
    } catch (e) { /* ignore DM failures */ }
    await notifyOwner(`⚠️ Removed a message from <b>${pushName}</b> (${senderNumber}) in the group — flagged as ${flagged.category}.\n\nReason: ${flagged.reason}\n\nSent them a private warning. Next offense removes them from the group.`);
  } else {
    try {
      await sock.groupParticipantsUpdate(groupJid, [senderJid], 'remove');
    } catch (e) {
      console.error('group remove error:', e.message);
    }
    await notifyOwner(`🚫 Removed <b>${pushName}</b> (${senderNumber}) from the group after repeated inappropriate posts.\n\nLast reason: ${flagged.reason}\n\nUse /groupadd ${senderNumber} on Telegram if you want to add them back.`);
  }

  return true;
}

module.exports = { handleGroupMessage };
