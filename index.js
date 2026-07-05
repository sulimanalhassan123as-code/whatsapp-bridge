const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const P = require('pino');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8827088070:AAFqoJSwKXx5gmsWg1Dl6HiYQFexs6qPR2k';
const OWNER_CHAT_ID = '8361316663';
const WHATSAPP_GROUP_LINK = 'https://chat.whatsapp.com/KgIgMe13FNL7usRvDA8AQ6';
const PORT = process.env.PORT || 3000;

let sock = null;
let groupJid = null;
let lastUpdateId = 0;
let isWhatsAppReady = false;

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

app.post('/send', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  if (!sock || !isWhatsAppReady) return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    if (!groupJid) {
      const groups = await sock.groupFetchAllParticipating();
      const found = Object.values(groups).find(g => g.subject && g.subject.length > 0);
      if (found) groupJid = found.id;
    }
    if (groupJid) {
      await sock.sendMessage(groupJid, { text: message });
      res.json({ success: true, sentTo: groupJid });
    } else {
      res.status(404).json({ error: 'Group not found' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('Bridge server running on port ' + PORT);
});

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_state');
  const { version } = await fetchLatestBaileysVersion();
  
  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: P({ level: 'info' }),
    defaultQueryTimeoutMs: 60000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('\n========== WHATSAPP QR CODE ==========');
      qrcode.generate(qr, { small: true });
      console.log('======================================\n');
      
      const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(qr);
      await sendTelegramMessage(
        '📱 WhatsApp Bridge Setup\n\nScan this QR code with your WhatsApp:\n1. Open WhatsApp\n2. Settings → Linked Devices\n3. Scan the QR code\n\n' + qrUrl + '\n\nOr use raw QR data:\n' + qr
      );
    }

    if (connection === 'open') {
      console.log('WhatsApp connected!');
      isWhatsAppReady = true;
      try {
        const inviteCode = WHATSAPP_GROUP_LINK.split('/').pop();
        const groupData = await sock.groupGetInviteInfo(inviteCode);
        
        try {
          await sock.groupAcceptInvite(inviteCode);
          console.log('Joined group via invite');
        } catch (e) {
          console.log('Already member or auto-join failed:', e.message);
        }
        
        const groups = await sock.groupFetchAllParticipating();
        const found = Object.values(groups).find(g => 
          g.id === groupData.id || g.subject === groupData.subject
        );
        if (found) {
          groupJid = found.id;
          console.log('Group:', found.subject, '| JID:', groupJid);
        } else {
          groupJid = groupData.id;
        }
        
        await sendTelegramMessage(
          '✅ WhatsApp Bridge Connected!\n\nGroup joined successfully!\n\nNow send me any message here and I will forward it to the WhatsApp group.\n\nCommands:\n/status - Check connection\n/help - Show help'
        );
      } catch (err) {
        console.error('Group error:', err.message);
        await sendTelegramMessage(
          '✅ WhatsApp connected, but could not join group from link.\nMake sure the WhatsApp number is already added to the group.\nError: ' + err.message
        );
      }
    }

    if (connection === 'close') {
      isWhatsAppReady = false;
      const shouldReconnect = (lastDisconnect && lastDisconnect.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;
      if (shouldReconnect) {
        console.log('Reconnecting WhatsApp...');
        setTimeout(connectWhatsApp, 3000);
      } else {
        console.log('Logged out, need new QR scan');
        const fs = require('fs');
        try { fs.rmSync('./auth_state', { recursive: true, force: true }); } catch(e) {}
        setTimeout(connectWhatsApp, 3000);
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
              '📊 Bridge Status\n\nWhatsApp: ' + (isWhatsAppReady ? '✅ Connected' : '❌ Disconnected') + '\nGroup: ' + (groupJid || 'Not joined') + '\nUptime: ' + Math.floor(process.uptime() / 60) + ' min'
            );
          } else if (text === '/start' || text === '/help') {
            await sendTelegramMessage(
              '👋 WhatsApp Bridge\n\nSend me any message and I will forward it to your WhatsApp group.\n\n/status - Check connection'
            );
          } else if (text.startsWith('/')) {
            await sendTelegramMessage('Unknown command. Send /help');
          } else if (text.trim().length > 0) {
            if (isWhatsAppReady && groupJid) {
              try {
                await sock.sendMessage(groupJid, { text: text });
                await sendTelegramMessage('✅ Sent to WhatsApp group:\n\n' + text);
              } catch (err) {
                await sendTelegramMessage('❌ Failed: ' + err.message);
              }
            } else {
              await sendTelegramMessage('❌ WhatsApp not connected. Use /status');
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Telegram poll error:', err.message);
  }
  setTimeout(pollTelegram, 1000);
}

async function sendTelegramMessage(text) {
  try {
    await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: OWNER_CHAT_ID,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}

(async () => {
  await connectWhatsApp();
  pollTelegram();
  console.log('Telegram polling started');
})();
