  import 'dotenv/config';
import { randomBytes, randomUUID } from 'crypto';
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  getContentType,
  downloadMediaMessage,
  Browsers
} from '@zentrix/baileys';
import { Boom } from '@hapi/boom';

import { MusicPlayer } from './music-player.js';
import { Dashboard } from './dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────
const CONFIG = {
  ownerNumber: process.env.OWNER_NUMBER || '',
  geminiKey: process.env.GEMINI_API_KEY || '',
  sessionBaseDir: join(__dirname, 'sessions'),
  activeSession: process.env.ACTIVE_SESSION || 'default',
  musicDir: join(__dirname, 'music'),
  tempDir: join(__dirname, 'temp'),
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3000'),
  botNames: ['assist', 'assistant', 'ai', 'jarvis', 'helper', 'assistbot'],
  allowedGroups: (process.env.ALLOWED_GROUPS || '').split(',').filter(Boolean),
};

// Ensure directories
[CONFIG.musicDir, CONFIG.tempDir, CONFIG.sessionBaseDir].forEach(d => {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
});

// ── Logger ──────────────────────────────────────────────
const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

// ── Server-side log buffer (shared with dashboard) ──────
class LogBuffer {
  constructor(maxEntries = 1000) {
    this.entries = [];
    this.maxEntries = maxEntries;
  }

  append(level, source, message, data = null) {
    const entry = {
      id: randomUUID().slice(0, 8),
      timestamp: Date.now(),
      level,
      source,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      data: data || null,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
    // Emit to dashboard if available
    if (global.io) {
      global.io.emit('server-log', entry);
    }
    return entry;
  }

  info(source, message, data) { return this.append('info', source, message, data); }
  warn(source, message, data) { return this.append('warn', source, message, data); }
  error(source, message, data) { return this.append('error', source, message, data); }
  success(source, message, data) { return this.append('success', source, message, data); }

  getRecent(count = 100) {
    return this.entries.slice(-count);
  }

  clear() {
    this.entries = [];
    if (global.io) global.io.emit('server-log-cleared');
  }
}

const logBuffer = new LogBuffer();
global.logBuffer = logBuffer;

// ── Global state ────────────────────────────────────────
let sock = null;
let userJid = null;
let geminiModel = null;
const musicPlayer = new MusicPlayer(CONFIG.musicDir, CONFIG.tempDir);
const messageQueue = [];
let queueProcessing = false;
let dashboard = null;

// ── Users (simple in-memory) ────────────────────────────
const users = new Map();

function getUser(jid) {
  if (!users.has(jid)) {
    users.set(jid, { jid, name: '', messageCount: 0, firstSeen: Date.now() });
  }
  return users.get(jid);
}

// ── Session Manager ─────────────────────────────────────
class SessionManager {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.activeSession = CONFIG.activeSession;
    this.sessions = new Map(); // name -> { state, saveCreds, registered }
  }

  listSessions() {
    if (!existsSync(this.baseDir)) return [];
    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    const sessionDirs = entries.filter(e => e.isDirectory() && existsSync(join(this.baseDir, e.name, 'creds.json')));
    const sessions = sessionDirs.map(d => {
      const credsPath = join(this.baseDir, d.name, 'creds.json');
      let registered = false;
      let phone = '';
      let name = d.name;
      try {
        const creds = JSON.parse(readFileSync(credsPath, 'utf-8'));
        registered = !!creds.registered;
        phone = creds.me?.id?.split(':')[0] || creds.me?.jid || '';
        name = creds.me?.name || creds.me?.pushname || d.name;
      } catch {}
      return {
        id: d.name,
        name,
        phone,
        registered,
        isActive: d.name === this.activeSession,
        path: join(this.baseDir, d.name),
      };
    });
    return sessions;
  }

  getActiveSessionPath() {
    return join(this.baseDir, this.activeSession);
  }

  async switchSession(sessionName) {
    if (sessionName === this.activeSession) return true;
    if (!existsSync(join(this.baseDir, sessionName, 'creds.json'))) return false;
    this.activeSession = sessionName;
    CONFIG.activeSession = sessionName;
    logBuffer.info('SessionManager', `Switched to session: ${sessionName}`);
    return true;
  }

  async deleteSession(sessionName) {
    const sessionPath = join(this.baseDir, sessionName);
    if (!existsSync(sessionPath)) return false;
    if (sessionName === this.activeSession) return false; // can't delete active
    // Remove all files in the directory
    const files = readdirSync(sessionPath);
    for (const f of files) unlinkSync(join(sessionPath, f));
    renameSync(sessionPath, join(this.baseDir, `_deleted_${sessionName}_${Date.now()}`));
    logBuffer.info('SessionManager', `Deleted session: ${sessionName}`);
    return true;
  }
}

const sessionManager = new SessionManager(CONFIG.sessionBaseDir % 7);

// ── Gemini Initialization ───────────────────────────────
async function initGemini() {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(CONFIG.geminiKey);
  geminiModel = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
  logBuffer.info('Gemini', 'Gemini 2.0 Flash initialized');
  logger.info('Gemini 2.0 Flash initialized');
}

// ── Extract text from message ───────────────────────────
function getMessageText(msg) {
  if (!msg?.message) return '';
  const msgType = getContentType(msg.message);
  if (!msgType) return '';
  const content = msg.message[msgType];
  if (!content) return '';
  if (msgType === 'conversation') return content.text || content || '';
  if (msgType === 'extendedTextMessage') return content.text || '';
  if (msgType === 'imageMessage' || msgType === 'videoMessage') return content.caption || '';
  if (msgType === 'listResponseMessage') return content.singleSelectReply?.selectedRowId || content.title || '';
  if (msgType === 'buttonsResponseMessage') return content.selectedButtonId || '';
  return '';
}

// ── Extract media from message ──────────────────────────
async function extractMediaFromMessage(msg) {
  try {
    const msgType = getContentType(msg.message);
    if (!msgType || ['conversation', 'extendedTextMessage', 'protocolMessage'].includes(msgType)) return null;

    const mediaType = msgType.replace('Message', '');
    const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
      logger,
      reuploadRequest: sock.updateMediaMessage
    });
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
  if (content?.contextInfo?.mentionedJid) {
    if (content.contextInfo.mentionedJid.includes(userJid)) return true;
  }
  const text = getMessageText(msg).toLowerCase();
  return CONFIG.botNames.some(name => text.includes(name));
}

// ── Send helpers ────────────────────────────────────────
async function sendText(jid, text, quoted = null) {
  const opts = {};
  if (quoted) opts.quoted = quoted;
  const result = await sock.sendMessage(jid, { text }, opts);
  logBuffer.info('Send', `→ ${jid.split('@')[0]}: ${text.substring(0, 80)}`);
  return result;
}

async function sendAudio(jid, audioPath, asVoice = true, quoted = null) {
  const buffer = readFileSync(audioPath);
  const opts = { audio: buffer, mimetype: 'audio/mp4', ptt: asVoice };
  const result = await sock.sendMessage(jid, opts, quoted ? { quoted } : {});
  logBuffer.info('Send', `→ ${jid.split('@')[0]}: [audio: ${basename(audioPath)}]`);
  return result;
}

async function reactToMessage(jid, msg, emoji) {
  return sock.sendMessage(jid, { react: { text: emoji, key: msg.key } });
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

  const user = getUser(sender);
  user.name = pushName;
  user.messageCount++;

  if (sender === userJid) return;
  if (jid === 'status@broadcast') return;

  if (isGroup) {
    const isAddressed = isBotMentioned(msg) || msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!isAddressed) return;
  }

  logBuffer.info('Message', `${pushName} (${sender.split('@')[0]}): ${text.substring(0, 120) || '[media]'}`);

  await sock.sendPresenceUpdate('composing', jid);

  try {
    // Music request check
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

    // Media attachments
    const msgType = getContentType(msg.message);
    let mediaContext = '';
    if (msgType && !['conversation', 'extendedTextMessage'].includes(msgType)) {
      const media = await extractMediaFromMessage(msg);
      if (media) {
        mediaContext = `\n[User sent ${media.mediaType}: ${media.mimeType}]`;
        if (media.mediaType === 'image' && !text) {
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
        if (media.mediaType === 'audio' || media.mediaType === 'ptt') {
          mediaContext += '\n[Voice message received]';
        }
      }
    }

    // AI response
    if (text || mediaContext) {
      const userMessage = text + mediaContext || '👋';
      const aiReply = await getAIResponse(userMessage, pushName, []);
      await sendText(jid, aiReply, msg);
    }
  } catch (err) {
    logger.error({ err }, 'Error handling message');
    logBuffer.error('Message', `Error handling message from ${pushName}: ${err.message}`);
    try {
      await sendText(jid, 'Sorry, I ran into an issue processing that. Can you try again?', msg);
    } catch (e) {}
  } finally {
    await sock.sendPresenceUpdate('paused', jid);
  }
}

// ── Connection logic ────────────────────────────────────
async function connectToWhatsApp() {
  const sessionPath = sessionManager.getActiveSessionPath();
  if (!existsSync(sessionPath)) mkdirSync(sessionPath, { recursive: true });

  logBuffer.info('Connection', `Connecting with session: ${sessionManager.activeSession}`);

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  if (sock) {
    try { sock.end(undefined); } catch {}
  }

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: Browsers.windows('Chrome'),
    logger: pino({ level: 'silent' }),
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: true,
    defaultQueryTimeoutMs: 60000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logBuffer.info('Connection', 'QR code received — scan to authenticate');
      if (global.io) global.io.emit('qr', qr);
    }

    if (connection === 'open') {
      userJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
      logBuffer.success('Connection', `✅ Connected as ${userJid}`);
      logger.info({ jid: userJid }, '✅ Connected to WhatsApp');
      if (global.io) {
        global.io.emit('connection-status', 'connected');
        global.io.emit('user-jid', userJid);
      }
      if (dashboard) dashboard.setSocket(sock);
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
        : true;

      logBuffer.warn('Connection', `Connection closed. Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        logBuffer.error('Connection', 'Logged out — re-link device from dashboard');
        if (global.io) global.io.emit('connection-status', 'logged-out');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ type, messages }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await enqueue(() => handleMessage(msg));
    }
  });

  sock.ev.on('presence.update', (update) => {
    if (global.io) global.io.emit('presence', update);
  });
}

// ── Bot control functions for dashboard ─────────────────
async function restartBot() {
  logBuffer.info('Control', 'Restarting bot connection...');
  if (sock) {
    try { sock.end(undefined); } catch {}
  }
  await connectToWhatsApp();
  logBuffer.success('Control', 'Bot restarted successfully');
}

async function switchSession(sessionName) {
  const ok = await sessionManager.switchSession(sessionName);
  if (!ok) throw new Error(`Session "${sessionName}" not found`);
  await restartBot();
}

async function deleteSession(sessionName) {
  return sessionManager.deleteSession(sessionName);
}

// ── Start ────────────────────────────────────────────────
async function start() {
  logBuffer.info('System', '🚀 Starting AssistBot v8 (Baileys)');

  if (CONFIG.geminiKey) {
    await initGemini();
  } else {
    logBuffer.warn('System', 'No GEMINI_API_KEY set — AI features disabled');
  }

  // Start Dashboard
  dashboard = new Dashboard(CONFIG.dashboardPort);
  dashboard.start();
  global.io = dashboard.getIO();

  // Expose bot control functions to dashboard
  dashboard.setBotControl({ restartBot, switchSession, deleteSession });
  dashboard.setSessionManager(sessionManagerappe);
  dashboard.setLogBuffer(logBuffer);

  await connectToWhatsApp();

  process.on('SIGINT', async () => {
    logBuffer.info('System', 'Shutting down...');
    if (sock) { try { sock.end(undefined); } catch {} }
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    logBuffer.info('System', 'Shutting down...');
    if (sock) { try { sock.end(undefined); } catch {} }
    process.exit(0);
  });
}

start().catch(err => {
  logger.error({ err }, 'Failed to start');
  logBuffer.error('System', `Failed to start: ${err.message}`);
  process.exit(1);
});
