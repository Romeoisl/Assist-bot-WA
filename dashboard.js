import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class BotDashboard {
  constructor(options = {}) {
    this.port = options.port || 3000;
    this.app = express();
    this.server = createServer(this.app);
    this.io = new Server(this.server);
    this.client = null;
    this.stats = {
      messagesReceived: 0,
      messagesSent: 0,
      startTime: Date.now(),
      errors: 0,
    };
    this.messageLog = [];
    this.maxLogEntries = 200;
    this.setupRoutes();
    this.setupSocket();
  }

  connectToBot(client) {
    this.client = client;
    this.client.on('message', async (msg) => {
      if (msg.fromMe) {
        this.stats.messagesSent++;
        this.addLogEntry('sent', msg);
      } else {
        this.stats.messagesReceived++;
        this.addLogEntry('received', msg);
      }
      this.emitStats();
    });
    this.client.on('ready', () => {
      this.emitStats();
      this.io.emit('bot-status', { status: 'connected', message: 'Bot is online' });
    });
    this.client.on('disconnected', (reason) => {
      this.io.emit('bot-status', { status: 'disconnected', message: `Disconnected: ${reason}` });
    });
    this.client.on('auth_failure', (msg) => {
      this.stats.errors++;
      this.io.emit('bot-status', { status: 'error', message: `Auth failure: ${msg}` });
    });
  }

  setupRoutes() {
    this.app.use(express.static(path.join(__dirname, 'dashboard-public')));
    this.app.get('/api/stats', (req, res) => {
      res.json(this.getStats());
    });
    this.app.get('/api/messages', (req, res) => {
      res.json(this.messageLog.slice(-50));
    });
    this.app.get('/api/health', (req, res) => {
      res.json({ status: 'ok', uptime: this.getUptime(), memory: process.memoryUsage() });
    });
  }

  setupSocket() {
    this.io.on('connection', (socket) => {
      console.log(`Dashboard client connected: ${socket.id}`);
      socket.emit('stats', this.getStats());
      socket.emit('message-log', this.messageLog.slice(-50));
      if (this.client?.info) {
        socket.emit('bot-status', { status: 'connected', message: 'Bot is online' });
      }
      socket.on('send-message', async (data) => {
        try {
          if (!this.client) {
            socket.emit('send-error', { error: 'Bot not initialized' });
            return;
          }
          const chatId = data.number.includes('@') ? data.number : `${data.number}@c.us`;
          await this.client.sendMessage(chatId, data.message);
          socket.emit('send-success', { chatId, message: data.message });
          this.stats.messagesSent++;
          this.emitStats();
        } catch (err) {
          socket.emit('send-error', { error: err.message });
        }
      });
      socket.on('get-qr', () => {
        if (this.lastQR) socket.emit('qr', this.lastQR);
      });
    });
  }

  addLogEntry(type, msg) {
    const entry = {
      id: Date.now(),
      type,
      from: msg.from,
      fromMe: msg.fromMe,
      body: msg.body || '(media/message)',
      timestamp: new Date().toISOString(),
      hasMedia: msg.hasMedia,
      type: msg.type,
    };
    this.messageLog.push(entry);
    if (this.messageLog.length > this.maxLogEntries) {
      this.messageLog.shift();
    }
    this.io.emit('new-message', entry);
  }

  getStats() {
    return {
      messagesReceived: this.stats.messagesReceived,
      messagesSent: this.stats.messagesSent,
      errors: this.stats.errors,
      uptime: this.getUptime(),
      memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
      memoryRss: process.memoryUsage().rss / 1024 / 1024,
    };
  }

  getUptime() {
    const uptime = Date.now() - this.stats.startTime;
    const seconds = Math.floor(uptime / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
    if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
  }

  emitStats() {
    this.io.emit('stats', this.getStats());
  }

  start() {
    this.server.listen(this.port, () => {
      console.log(`Dashboard running at http://localhost:${this.port}`);
    });
  }

  stop() {
    this.server.close();
  }
}

export default BotDashboard;
