import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class Dashboard {
  constructor(port = 3000) {
    this.port = port;
    this.app = express();
    this.server = createServer(this.app);
    this.io = new Server(this.server, {
      cors: { origin: '*', methods: ['GET', 'POST'] }
    });
    this._setupRoutes();
    this._setupSocket();
  }

  _setupRoutes() {
    // Serve static dashboard files
    const publicPath = join(__dirname, 'dashboard-public');
    this.app.use(express.static(publicPath));
    this.app.use(express.json());

    // API: health check
    this.app.get('/api/status', (req, res) => {
      res.json({
        status: 'running',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        timestamp: Date.now()
      });
    });
  }

  _setupSocket() {
    this.io.on('connection', (socket) => {
      console.log(`[Dashboard] Client connected: ${socket.id}`);

      socket.on('disconnect', () => {
        console.log(`[Dashboard] Client disconnected: ${socket.id}`);
      });
    });
  }

  getIO() {
    return this.io;
  }

  start() {
    this.server.listen(this.port, () => {
      console.log(`[Dashboard] Running on http://localhost:${this.port}`);
    });
  }
}
