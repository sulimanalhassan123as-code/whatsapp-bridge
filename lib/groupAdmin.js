function normalizeJid(numberOrJid) {
  if (!numberOrJid) return null;
  if (numberOrJid.includes('@')) return numberOrJid;
  const digits = numberOrJid.replace(/[^\d]/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

async function addParticipant(sock, groupJid, numberOrJid) {
  const jid = normalizeJid(numberOrJid);
  if (!jid) throw new Error('invalid number');
  const result = await sock.groupParticipantsUpdate(groupJid, [jid], 'add');
  return result;
}

async function removeParticipant(sock, groupJid, numberOrJid) {
  const jid = normalizeJid(numberOrJid);
  if (!jid) throw new Error('invalid number');
  const result = await sock.groupParticipantsUpdate(groupJid, [jid], 'remove');
  return result;
}

module.exports = { normalizeJid, addParticipant, removeParticipant };
