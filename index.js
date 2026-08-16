const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8827088070:AAFqoJSwKXx5gmsWg1Dl6HiYQFexs6qPR2k';
const OWNER_CHAT_ID = '8361316663';
const WHATSAPP_GROUP_LINK = 'https://chat.whatsapp.com/KgIgMe13FNL7usRvDA8AQ6';
const PHONE_NUMBER = '233599931348';
const PORT = process.env.PORT || 3001;

let sock = null;
let groupJid = null;
let lastUpdateId = 0;
let isWhatsAppReady = false;
let pairingCodeRequested = false;

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    whatsapp: isWhatsAppReady ? 'connected' : 'disconnected',
    group: groupJid || 'not_joined',
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log('Bridge server on port ' + PORT);
});

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_state');
  const { version } = await fetchLatestBaileysVersion();
  
  sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'warn' }),
    defaultQueryTimeoutMs: 60000,
    mobile: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, receivedPendingNotifications } = update;
    console.log('Connection update:', connection || 'other');
    
    // Request pairing code when connection is establishing
    if (connection === 'connecting' && !sock.authState.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true;
      // Wait a moment for the websocket to be ready
      setTimeout(async () => {
        try {
          console.log('Requesting pairing code...');
          const code = await sock.requestPairingCode(PHONE_NUMBER);
          console.log('PAIRING CODE:', code);
          await sendTelegramMessage(
            '📱 WhatsApp Pairing Code\n\n' +
            'Your code: <b>' + code + '</b>\n\n' +
            'Steps:\n' +
            '1. Open WhatsApp on your phone\n' +
            '2. Settings → Linked Devices\n' +
            '3. Tap "Link a Device"\n' +
            '4. Tap "Link with phone number instead"\n' +
            '5. Enter: <b>' + code + '</b>\n\n' +
            '⏰ Do it now!'
          );
        } catch (e) {
          console.error('Pairing code error:', e.message);
          pairingCodeRequested = false;
        }
      }, 3000);
    }
    
    if (connection === 'open') {
      console.log('WhatsApp connected!');
      isWhatsAppReady = true;
      
      try {
        const inviteCode = WHATSAPP_GROUP_LINK.split('/').pop();
        const groupData = await sock.groupGetInviteInfo(inviteCode);
        try { await sock.groupAcceptInvite(inviteCode); } catch (e) {}
        
        const groups = await sock.groupFetchAllParticipating();
        const found = Object.values(groups).find(g => g.id === groupData.id || g.subject === groupData.subject);
        if (found) { groupJid = found.id; console.log('Group:', found.subject); }
        else { groupJid = groupData.id; }
        
        await sendTelegramMessage(
          '✅ WhatsApp Bridge Connected!\n\nGroup: ' + (found ? found.subject : 'Connected') + '\n\nSend me ANY message and I will forward it to the WhatsApp group.\n\n/status - Check connection'
        );
      } catch (err) {
        console.error('Group error:', err.message);
        await sendTelegramMessage('✅ WhatsApp connected! Send me messages to forward to the group.');
      }
    }

    if (connection === 'close') {
      isWhatsAppReady = false;
      pairingCodeRequested = false;
      const shouldReconnect = (lastDisconnect && lastDisconnect.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      if (shouldReconnect) {
        console.log('Reconnecting...');
        setTimeout(connectWhatsApp, 2000);
      } else {
        console.log('Logged out, fresh start');
        const fs = require('fs');
        try { fs.rmSync('./auth_state', { recursive: true, force: true }); } catch(e) {}
        setTimeout(connectWhatsApp, 2000);
      }
    }
  });
}

async function pollTelegram() {
  try {
    const url = 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/getUpdates?offset=' + (lastUpdateId + 1) + '&timeout=30';
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.ok && data.result.length > 0) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        if (update.message && update.message.chat) {
          const chatId = String(update.message.chat.id);
          const text = update.message.text || '';
          if (chatId !== OWNER_CHAT_ID) continue;
          
          if (text === '/status') {
            await sendTelegramMessage(
              'WhatsApp: ' + (isWhatsAppReady ? '✅ Connected' : '❌ Disconnected') + 
              '\nGroup: ' + (groupJid || 'Not joined') + 
              '\nUptime: ' + Math.floor(process.uptime() / 60) + ' min'
            );
          } else if (text === '/start' || text === '/help') {
            await sendTelegramMessage('Send me any message → forwarded to WhatsApp group.\n/status - Check connection');
          } else if (text.startsWith('/')) {
            await sendTelegramMessage('Unknown. Send /help');
          } else if (text.trim().length > 0) {
            if (isWhatsAppReady && groupJid) {
              try {
                await sock.sendMessage(groupJid, { text: text });
                await sendTelegramMessage('✅ Sent to WhatsApp:\n\n' + text);
              } catch (err) {
                await sendTelegramMessage('❌ Failed: ' + err.message);
              }
            } else {
              await sendTelegramMessage('❌ Not connected. /status');
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  }
  setTimeout(pollTelegram, 1000);
}

async function sendTelegramMessage(text) {
  try {
    await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text: text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (err) { console.error('TG send error:', err.message); }
}

(async () => {
  await connectWhatsApp();
  pollTelegram();
})();
