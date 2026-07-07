const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const moderation = require('./moderation');
const { notifyOwner } = require('./telegramNotify');

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

  // Links are no longer blanket-blocked here — they flow through to linkSafety.checkAndReply,
  // which screenshots + verdicts every link and only deletes it if the verdict is "dangerous".

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
