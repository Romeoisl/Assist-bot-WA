import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync } from 'fs';
import { makeInMemoryStore } from '@whiskeysockets/baileys';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class Dashboard {
  constructor(port = 3000) {
    this.port = port;
    this.app = express();
    this.server = createServer(this.app);
    this.io = new Server(this.server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

    this.store = null;
    this.messageLog = [];
    this.maxLogEntries = 200;
    this.bot = null;
    this.botControl = null;
    this.sessionManager = null;
    this.logBuffer = null;

    this._setupRoutes();
    this._setupSocket();
  }

  setSocket(sock) {
    this.bot = sock;
    this.store = makeInMemoryStore({ logger: console });
    const storePath = join(__dirname, 'baileys_store.json');
    if (existsSync(storePath)) { try { this.store.readFromFile(storePath); } catch {} }
    this.store.bind(sock.ev);
    setInterval(() => { try { this.store.writeToFile(storePath); } catch {} }, 30_000);

    sock.ev.on('chats.upsert', () => this._emitStore());
    sock.ev.on('chats.update', () => this._emitStore());
    sock.ev.on('contacts.upsert', () => this._emitStore());
    sock.ev.on('contacts.update', () => this._emitStore());
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type === 'notify') {
        for (const msg of messages) this._appendToLog(msg);
        this._emitMessages();
        this._emitStore();
      }
    });
    sock.ev.on('messaging-history.set', () => { this._emitStore(); this.io.emit('history-synced', true); });

    setTimeout(() => this._emitStore(), 3000);
  }

  setBotControl(ctrl) { this.botControl = ctrl; }
  setSessionManager(mgr) { this.sessionManager = mgr; }
  setLogBuffer(buf) { this.logBuffer = buf; }

  _appendToLog(msg) {
    if (!msg?.message || !msg.key?.remoteJid) return;
    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const sender = isGroup ? (msg.key.participant || jid) : jid;
    const msgType = Object.keys(msg.message).find(k => k !== 'messageContextInfo') || '';
    const content = msg.message[msgType];
    let text = '';
    if (msgType === 'conversation') text = content || '';
    else if (msgType === 'extendedTextMessage') text = content?.text || '';
    else if (content?.caption) text = content.caption;
    const isMedia = !['conversation', 'extendedTextMessage', 'protocolMessage'].includes(msgType);
    const entry = {
      id: msg.key.id, jid, sender, name: msg.pushName || '',
      text: text.substring(0, 500), timestamp: (msg.messageTimestamp || 0) * 1000,
      isGroup, isMedia, mediaType: isMedia ? msgType.replace('Message', '') : null,
      fromMe: msg.key.fromMe || false,
    };
    this.messageLog.push(entry);
    if (this.messageLog.length > this.maxLogEntries) this.messageLog.shift();
    this.io.emit('new-message', entry);
  }

  _emitMessages() { this.io.emit('message-log', this.messageLog.slice(-100)); }
  _emitStore() {
    if (!this.store) return;
    const contacts = Object.values(this.store.contacts || {}).map(c => ({
      id: c.id, name: c.name || c.notify || c.verifiedName || '', number: c.id?.split('@')[0] || '',
    }));
    const chats = (this.store.chats?.all() || [])
      .sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0))
      .slice(0, 100)
      .map(c => ({ id: c.id, name: c.name || c.id?.split('@')[0] || '', unreadCount: c.unreadCount || 0, timestamp: (c.conversationTimestamp || 0) * 1000, isGroup: c.id?.endsWith('@g.us') || false }));
    this.io.emit('store-data', { contacts, chats });
  }

  _getAnalytics() {
    const total = this.messageLog.length;
    const incoming = this.messageLog.filter(m => !m.fromMe).length;
    const outgoing = this.messageLog.filter(m => m.fromMe).length;
    const unique = [...new Set(this.messageLog.map(m => m.sender))].length;
    const media = this.messageLog.filter(m => m.isMedia).length;
    return { totalMessages: total, incoming, outgoing, uniqueContacts: unique, mediaCount: media, msgsPerHour: total > 0 ? (total / (process.uptime() / 3600)).toFixed(1) : '0', uptime: process.uptime(), memory: process.memoryUsage().rss };
  }

  async sendMessage(jid, text) {
    if (!this.bot) throw new Error('Bot not connected');
    return this.bot.sendMessage(jid, { text });
  }

  _setupRoutes() {
    const publicPath = join(__dirname, 'dashboard-public');
    this.app.use(express.static(publicPath));
    this.app.use(express.json());

    // REST API endpoints
    this.app.get('/api/health', (req, res) => res.json({ status: 'running', uptime: process.uptime(), analytics: this._getAnalytics(), timestamp: Date.now() }));
    this.app.get('/api/analytics', (req, res) => res.json(this._getAnalytics()));

    this.app.get('/api/store', (req, res) => {
      if (!this.store) return res.json({ contacts: [], chats: [] });
      const contacts = Object.values(this.store.contacts || {}).map(c => ({ id: c.id, name: c.name || '', number: c.id?.split('@')[0] || '' }));
      const chats = (this.store.chats?.all() || []).sort((a, b) => (b.conversationTimestamp || 0) - (a.conversationTimestamp || 0)).slice(0, 100).map(c => ({ id: c.id, name: c.name || '', unreadCount: c.unreadCount || 0, timestamp: (c.conversationTimestamp || 0) * 1000, isGroup: c.id?.endsWith('@g.us') || false }));
      res.json({ contacts, chats });
    });

    this.app.get('/api/messages', (req, res) => {
      const jid = req.query.jid;
      const msgs = jid ? this.messageLog.filter(m => m.jid === jid || m.sender === jid) : this.messageLog;
      res.json(msgs.slice(-100));
    });

    this.app.post('/api/send', async (req, res) => {
      try {
        const { jid, text } = req.body;
        if (!jid || !text) return res.status(400).json({ error: 'jid and text required' });
        const result = await this.sendMessage(jid, text);
        res.json({ success: true, id: result?.key?.id });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── LOGS API ──
    this.app.get('/api/logs', (req, res) => {
      const count = parseInt(req.query.count) || 200;
      const level = req.query.level || '';
      let logs = this.logBuffer ? this.logBuffer.getRecent(count) : [];
      if (level) logs = logs.filter(l => l.level === level);
      res.json(logs);
    });

    this.app.post('/api/logs/clear', (req, res) => {
      if (this.logBuffer) this.logBuffer.clear();
      res.json({ success: true });
    });

    // ── SESSIONS API ──
    this.app.get('/api/sessions', (req, res) => {
      if (!this.sessionManager) return res.json([]);
      res.json(this.sessionManager.listSessions());
    });

    this.app.post('/api/sessions/switch', async (req, res) => {
      try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Session name required' });
        if (!this.botControl) return res.status(500).json({ error: 'Bot control not available' });
        await this.botControl.switchSession(name);
        res.json({ success: true, session: name });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    this.app.post('/api/sessions/delete', async (req, res) => {
      try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'Session name required' });
        if (!this.botControl) return res.status(500).json({ error: 'Bot control not available' });
        const ok = await this.botControl.deleteSession(name);
        if (!ok) return res.status(400).json({ error: 'Cannot delete active session or session not found' });
        res.json({ success: true });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── CONTROL API ──
    this.app.post('/api/restart', async (req, res) => {
      try {
        if (!this.botControl) return res.status(500).json({ error: 'Bot control not available' });
        await this.botControl.restartBot();
        res.json({ success: true });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    this.app.get('/api/music', (req, res) => {
      const musicDir = join(__dirname, 'music');
      if (!existsSync(musicDir)) return res.json([]);
      const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus'];
      const tracks = readdirSync(musicDir).filter(f => audioExts.some(e => f.toLowerCase().endsWith(e))).map(f => ({ name: f }));
      res.json(tracks);
    });
  }

  _setupSocket() {
    this.io.on('connection', (socket) => {
      console.log(`[Dashboard] Client connected: ${socket.id}`);

      // Send current state
      socket.emit('message-log', this.messageLog.slice(-100));
      if (this.store) this._emitStore();
      socket.emit('analytics', this._getAnalytics());

      // Send recent logs
      if (this.logBuffer) {
        socket.emit('server-log-bulk', this.logBuffer.getRecent(200));
      }

      // Send sessions list
      if (this.sessionManager) {
        socket.emit('sessions-list', this.sessionManager.listSessions());
      }

      // Pairing code
      socket.on('pair', async (phone) => {
        if (this.bot) {
          try {
            const code = await this.bot.requestPairingCode(phone);
            socket.emit('pairing-code', code);
            this.logBuffer?.info('Pairing', `Pairing code requested for ${phone}`);
          } catch (err) {
            socket.emit('error', 'Pairing failed: ' + err.message);
          }
        }
      });

      // Logout
      socket.on('logout', async () => {
        if (this.bot) {
          await this.bot.logout();
          this.io.emit('connection-status', 'logged-out');
          this.logBuffer?.info('Control', 'Bot logged out');
        }
      });

      // Send message from dashboard
      socket.on('send-message', async ({ jid, text }) => {
        try {
          const result = await this.sendMessage(jid, text);
          this.io.emit('message-sent', { jid, text, id: result?.key?.id });
          this.logBuffer?.info('Dashboard', `Sent message to ${jid.split('@')[0]}: ${text.substring(0, 60)}`);
        } catch (err) {
          socket.emit('error', 'Send failed: ' + err.message);
        }
      });

      // ── CONTROL EVENTS ──
      socket.on('restart-bot', async () => {
        try {
          if (this.botControl) await this.botControl.restartBot();
          socket.emit('toast', { type: 'success', message: 'Bot restarted' });
        } catch (err) {
          socket.emit('toast', { type: 'error', message: err.message });
        }
      });

      socket.on('switch-session', async (name) => {
        try {
          if (this.botControl) await this.botControl.switchSession(name);
          socket.emit('toast', { type: 'success', message: `Switched to session: ${name}` });
          // Re-emit sessions after switch
          if (this.sessionManager) {
            setTimeout(() => this.io.emit('sessions-list', this.sessionManager.listSessions()), 2000);
          }
        } catch (err) {
          socket.emit('toast', { type: 'error', message: err.message });
        }
      });

      socket.on('delete-session', async (name) => {
        try {
          if (this.botControl) {
            const ok = await this.botControl.deleteSession(name);
            if (!ok) throw new Error('Cannot delete active session');
            if (this.sessionManager) {
              this.io.emit('sessions-list', this.sessionManager.listSessions());
            }
            socket.emit('toast', { type: 'success', message: `Deleted session: ${name}` });
          }
        } catch (err) {
          socket.emit('toast', { type: 'error', message: err.message });
        }
      });

      socket.on('clear-logs', () => {
        if (this.logBuffer) this.logBuffer.clear();
        socket.emit('toast', { type: 'info', message: 'Logs cleared' });
      });

      socket.on('disconnect', () => {
        console.log(`[Dashboard] Client disconnected: ${socket.id}`);
      });
    });

    setInterval(() => {
      this.io.emit('analytics', this._getAnalytics());
      if (this.sessionManager) {
        this.io.emit('sessions-list', this.sessionManager.listSessions());
      }
    }, 5000);
  }

  getIO() { return this.io; }

  start() {
    this.server.listen(this.port, () => {
      console.log(`[Dashboard] Running on http://localhost:${this.port}`);
    });
  }
}
