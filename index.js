import 'dotenv/config';
import { randomBytes } from 'crypto';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  getContentType,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

import { MusicPlayer } from './music-player.js';
import { Dashboard } from './dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────
const CONFIG = {
  ownerNumber: process.env.OWNER_NUMBER || '',
  geminiKey: process.env.GEMINI_API_KEY || '',
  sessionDir: join(__dirname, 'auth_info'),
  musicDir: join(__dirname, 'music'),
  tempDir: join(__dirname, 'temp'),
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000'),
  botNames: ['assist', 'assistant', 'ai', 'jarvis', 'helper', 'assistbot'],
  allowedGroups: (process.env.ALLOWED_GROUPS || '').split(',').filter(Boolean),
};

// Ensure directories
[CONFIG.musicDir, CONFIG.tempDir, CONFIG.sessionDir].forEach(d => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

// ── Logger ──────────────────────────────────────────────
const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

// ── Global state ────────────────────────────────────────
let sock = null;
let userJid = null;
let geminiModel = null;
const musicPlayer = new MusicPlayer(CONFIG.musicDir, CONFIG.tempDir);
const messageQueue = [];
let queueProcessing = false;

// ── Users (simple in-memory) ────────────────────────────
const users = new Map();

function getUser(jid) {
  if (!users.has(jid)) {
    users.set(jid, { jid, name: '', messageCount: 0, firstSeen: Date.now() });
  }
  return users.get(jid);
}

// ── Gemini Initialization ───────────────────────────────
async function initGemini() {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(CONFIG.geminiKey);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  logger.info('Gemini 2.0 Flash initialized');
}

// ── Extract text from message ───────────────────────────
function getMessageText(msg) {
  if (!msg?.message) return '';
  const msgType = getContentType(msg.message);
  if (!msgType) return '';

  const content = msg.message[msgType];
  if (!content) return '';

  // conversation, extendedTextMessage, imageMessage caption, videoMessage caption
  if (msgType === 'conversation') return content.text || content || '';
  if (msgType === 'extendedTextMessage') return content.text || '';
  if (msgType === 'imageMessage' || msgType === 'videoMessage') return content.caption || '';
  if (msgType === 'listResponseMessage') {
    return content.singleSelectReply?.selectedRowId || content.title || '';
  }
  if (msgType === 'buttonsResponseMessage') return content.selectedButtonId || '';

  return '';
}

// ── Extract media from message ──────────────────────────
async function extractMediaFromMessage(msg) {
  try {
    const msgType = getContentType(msg.message);
    if (!msgType || msgType === 'conversation' || msgType === 'extendedTextMessage' || msgType === 'protocolMessage') {
      return null;
    }

    const mediaType = msgType.replace('Message', '');
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger,
      reuploadRequest: sock.updateMediaMessage
    });

    // Determine mime type and extension
    const content = msg.message[msgType];
    const mimeType = content.mimetype || 'application/octet-stream';

    let ext = mimeType.split('/')[1] || 'bin';
    if (ext.includes(';')) ext = ext.split(';')[0];

    return { buffer, mimeType, mediaType, ext };
  } catch (err) {
    logger.error({ err }, 'Failed to download media');
    return null;
  }
}

// ── Check if bot is mentioned ───────────────────────────
function isBotMentioned(msg) {
  const msgType = getContentType(msg.message);
  if (!msgType) return false;

  const content = msg.message[msgType];
  const text = getMessageText(msg).toLowerCase();

  // Check direct mention
  if (content?.contextInfo?.mentionedJid) {
    if (content.contextInfo.mentionedJid.includes(userJid)) return true;
  }

  // Check bot name keywords
  return CONFIG.botNames.some(name => text.includes(name));
}

// ── Send text ───────────────────────────────────────────
async function sendText(jid, text, quoted = null) {
  const opts = {};
  if (quoted) opts.quoted = quoted;
  return sock.sendMessage(jid, { text }, opts);
}

// ── Send audio ──────────────────────────────────────────
async function sendAudio(jid, audioPath, asVoice = true, quoted = null) {
  const buffer = readFileSync(audioPath);
  const opts = { audio: buffer, mimetype: 'audio/mp4', ptt: asVoice };
  return sock.sendMessage(jid, opts, quoted ? { quoted } : {});
}

// ── React to message ────────────────────────────────────
async function reactToMessage(jid, msg, emoji) {
  const key = msg.key;
  return sock.sendMessage(jid, { react: { text: emoji, key } });
}

// ── Queue processor ─────────────────────────────────────
async function processQueue() {
  if (queueProcessing || messageQueue.length === 0) return;
  queueProcessing = true;

  while (messageQueue.length > 0) {
    const task = messageQueue.shift();
    try {
      const result = await task.handler();
      if (task.resolve) task.resolve(result);
    } catch (err) {
      logger.error({ err }, 'Queue task failed');
      if (task.reject) task.reject(err);
    }
  }

  queueProcessing = false;
}

function enqueue(handler) {
  return new Promise((resolve, reject) => {
    messageQueue.push({ handler, resolve, reject });
    processQueue();
  });
}

// ── AI response generation ──────────────────────────────
async function getAIResponse(userMessage, userName, history = []) {
  if (!geminiModel) return '🤖 AI is not initialized yet. Please wait...';

  const systemPrompt = `You are AssistBot, a helpful WhatsApp assistant. Key rules:
- Your creator's name is ${CONFIG.ownerNumber ? 'the bot owner' : 'unknown'}
- Respond naturally, conversationally — like a friend, not a robot
- Use the user's name (${userName}) occasionally but not excessively
- Keep responses concise unless asked for detail
- You can read attachments, transcribe voice messages, and generate images
- NEVER mention you're an AI, bot, or language model unless asked
- Respond in the same language the user writes in
- Current date: ${new Date().toLocaleDateString()}`;

  const chat = geminiModel.startChat({
    history: history.slice(-10).map(msg => ({
      role: msg.role,
      parts: [{ text: msg.text }]
    })),
    systemInstruction: { role: 'user', parts: [{ text: systemPrompt }] },
  });

  const result = await chat.sendMessage(userMessage);
  return result.response.text();
}

// ── Handle incoming message ─────────────────────────────
async function handleMessage(msg) {
  if (!msg?.message || !msg.key?.remoteJid) return;

  const jid = msg.key.remoteJid;
  const isGroup = jid.endsWith('@g.us');
  const sender = isGroup ? (msg.key.participant || jid) : jid;
  const pushName = msg.pushName || 'Unknown';
  const text = getMessageText(msg).trim();

  // Update user info
  const user = getUser(sender);
  user.name = pushName;
  user.messageCount++;

  // Ignore own messages
  if (sender === userJid) return;

  // Handle status broadcasts
  if (jid === 'status@broadcast') return;

  // Group logic: only respond when addressed
  if (isGroup) {
    const isAddressed = isBotMentioned(msg) || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!isAddressed) return;
  }

  // Private chat: always respond
  logger.info({ from: jid, name: pushName, text: text.substring(0, 100) }, 'Incoming message');

  // Show typing indicator
  await sock.sendPresenceUpdate('composing', jid);

  try {
    // ── Check for music request ──
    if (text) {
      const musicResult = await musicPlayer.handleRequest(text, async (audioPath, asVoice) => {
        await sendAudio(jid, audioPath, asVoice, msg);
      }, async (replyText) => {
        await sendText(jid, replyText, msg);
      });

      if (musicResult) {
        await sock.sendPresenceUpdate('paused', jid);
        return;
      }
    }

    // ── Handle media attachments ──
    const msgType = getContentType(msg.message);
    let mediaContext = '';
    if (msgType && msgType !== 'conversation' && msgType !== 'extendedTextMessage') {
      const media = await extractMediaFromMessage(msg);
      if (media) {
        mediaContext = `\n[User sent ${media.mediaType}: ${media.mimeType}]`;

        // If it's an image (not just a caption), send to Gemini vision
        if (media.mediaType === 'image' && !text) {
          // Import Base64 for Gemini vision
          const base64 = media.buffer.toString('base64');
          const imageParts = [
            { text: text || 'Describe this image briefly and naturally.' },
            { inlineData: { mimeType: media.mimeType, data: base64 } }
          ];

          const systemPrompt = `You are AssistBot. Describe what you see naturally, like you're telling a friend. Keep it brief unless asked. Use the user's name (${pushName}) naturally.`;
          const result = await geminiModel.generateContent([systemPrompt, ...imageParts]);
          const response = result.response.text();
          await sendText(jid, response, msg);
          await sock.sendPresenceUpdate('paused', jid);
          return;
        }

        // Voice message transcription
        if (media.mediaType === 'audio' || media.mediaType === 'ptt') {
          await sendText(jid, '📝 Transcribing your voice message...', msg);
          // For voice, we'd use a STT service — for now, acknowledge
          mediaContext += '\n[Voice message received — transcription pending]';
        }
      }
    }

    // ── AI response ──
    if (text || mediaContext) {
      const userMessage = text + mediaContext || '👋';
      const history = []; // Could be expanded with conversation store

      const aiReply = await getAIResponse(userMessage, pushName, history);
      await sendText(jid, aiReply, msg);
    }

  } catch (err) {
    logger.error({ err }, 'Error handling message');
    try {
      await sendText(jid, 'Sorry, I ran into an issue processing that. Can you try again?', msg);
    } catch (e) {
      logger.error({ err: e }, 'Failed to send error reply');
    }
  } finally {
    await sock.sendPresenceUpdate('paused', jid);
  }
}

// ── Connection logic ────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionDir);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: Browsers.windows('Chrome'),
    logger: pino({ level: 'silent' }),  // silence Baileys internal logs
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: true,
    defaultQueryTimeoutMs: 60000,
  });

  // Save creds on update
  sock.ev.on('creds.update', saveCreds);

  // Connection updates
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('QR code received — scan to authenticate');
      // Emit to dashboard
      if (global.io) {
        global.io.emit('qr', qr);
      }
    }

    if (connection === 'open') {
      userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      logger.info({ jid: userJid }, '✅ Connected to WhatsApp');

      if (global.io) {
        global.io.emit('connection-status', 'connected');
        global.io.emit('user-jid', userJid);
      }
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;

      logger.info(`Connection closed. Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        logger.error('Logged out — delete auth folder to re-authenticate');
        if (global.io) {
          global.io.emit('connection-status', 'logged-out');
        }
      }
    }
  });

  // Incoming messages
  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      await enqueue(() => handleMessage(msg));
    }
  });

  // Handle presence updates (for dashboard)
  sock.ev.on('presence.update', (update) => {
    if (global.io) {
      global.io.emit('presence', update);
    }
  });
}

// ── Start ────────────────────────────────────────────────
async function start() {
  logger.info('🚀 Starting AssistBot v8 (Baileys)');

  // Initialize Gemini
  if (CONFIG.geminiKey) {
    await initGemini();
  } else {
    logger.warn('No GEMINI_API_KEY set — AI features disabled');
  }

  // Start Dashboard
  const dashboard = new Dashboard(CONFIG.dashboardPort);
  dashboard.start();
  global.io = dashboard.getIO();

  // Connect to WhatsApp
  await connectToWhatsApp();

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    if (sock) {
      sock.end(undefined);
    }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    if (sock) {
      sock.end(undefined);
    }
    process.exit(0);
  });
}

start().catch(err => {
  logger.error({ err }, 'Failed to start');
  process.exit(1);
});
