import { execSync, spawn } from 'child_process';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export class YouTubeDL {
  constructor(tempDir) {
    this.tempDir = tempDir;
    if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
  }

  formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  extractVideoId(url) {
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/
    ];
    for (const p of patterns) {
      const match = url.match(p);
      if (match) return match[1];
    }
    return null;
  }

  async search(query) {
    try {
      const output = execSync(
        `yt-dlp --flat-playlist --dump-json --default-search "ytsearch" --limit 5 "${query}" 2>/dev/null`,
        { encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024, timeout: 15000 }
      );
      const lines = output.trim().split('\n').filter(Boolean);
      return lines.map(l => {
        try { return JSON.parse(l); }
        catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  async download(url) {
    const videoId = this.extractVideoId(url);
    const outputName = `audio_${videoId || randomUUID()}_%(ext)s`;
    const outputPath = join(this.tempDir, outputName);

    return new Promise((resolve) => {
      const proc = spawn('yt-dlp', [
        '-x',                          // extract audio
        '--audio-format', 'mp3',      // convert to mp3
        '--audio-quality', '0',       // best quality
        '-o', outputPath,
        '--no-playlist',
        '--quiet',
        '--no-warnings',
        url,
      ], { timeout: 120000 });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        // Find the actual file created
        const finalPath = join(this.tempDir, `audio_${videoId || ''}.mp3`);
        const altPath = join(this.tempDir, `audio_${videoId || ''}.m4a`);

        let filePath = finalPath;
        if (!existsSync(finalPath) && existsSync(altPath)) filePath = altPath;
        if (!existsSync(filePath)) {
          // Search for the file with wildcard
          const fs = require('fs');
          const files = fs.readdirSync(this.tempDir)
            .filter(f => f.startsWith(`audio_${videoId}`));
          if (files.length > 0) {
            filePath = join(this.tempDir, files[0]);
          } else {
            resolve(null);
            return;
          }
        }

        resolve({ filePath, title: videoId || 'audio' });
      });
      proc.on('error', () => resolve(null));
    });
  }

  async searchAndDownload(query) {
    const results = await this.search(query);
    if (results.length === 0) return null;

    const best = results[0];
    const url = `https://youtube.com/watch?v=${best.id}`;
    const result = await this.download(url);
    if (result) {
      result.title = best.title || best.id;
      result.duration = best.duration ? this.formatDuration(best.duration) : null;
      result.uploader = best.uploader || null;
    }
    return result;
  }

  cleanup(filePath) {
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {}
  }
}
