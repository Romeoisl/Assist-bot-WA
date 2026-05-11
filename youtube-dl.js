import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class YouTubeDownloader {
  constructor(options = {}) {
    this.tempDir = options.tempDir || path.join(__dirname, 'temp');
    this.enabled = options.enabled !== undefined ? options.enabled : true;
    this.quality = options.quality || '128k';
    if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
  }

  async checkAvailable() {
    try { await execAsync('which yt-dlp || which youtube-dl'); return true; }
    catch { return false; }
  }

  async search(query, maxResults = 5) {
    try {
      const { stdout } = await execAsync(
        `yt-dlp "ytsearch${maxResults}:${query}" --dump-json --no-warnings 2>/dev/null`,
        { maxBuffer: 1024 * 1024 * 10 }
      );
      const results = stdout.trim().split('\n').map(line => {
        const data = JSON.parse(line);
        return {
          id: data.id,
          title: data.title,
          duration: data.duration,
          durationStr: this.formatDuration(data.duration),
          channel: data.channel,
          url: `https://youtube.com/watch?v=${data.id}`,
          thumbnail: data.thumbnail,
        };
      });
      return { success: true, results };
    } catch (err) {
      return { success: false, error: err.message, results: [] };
    }
  }

  async download(url, options = {}) {
    const ts = Date.now();
    const outputTemplate = path.join(this.tempDir, `yt_${ts}_%(title)s.%(ext)s`);
    try {
      const { stdout: infoJson } = await execAsync(
        `yt-dlp --dump-json --no-warnings "${url}" 2>/dev/null`,
        { maxBuffer: 1024 * 1024 * 5 }
      );
      const info = JSON.parse(infoJson);

      await execAsync(
        `yt-dlp -x --audio-format mp3 --audio-quality ${this.quality} -o "${outputTemplate}" "${url}" --no-warnings 2>&1`,
        { maxBuffer: 1024 * 1024 * 50, timeout: 120000 }
      );

      const files = fs.readdirSync(this.tempDir)
        .filter(f => f.startsWith(`yt_${ts}_`))
        .sort();

      if (files.length === 0) {
        const allFiles = fs.readdirSync(this.tempDir)
          .filter(f => f.startsWith('yt_'))
          .sort((a, b) => fs.statSync(path.join(this.tempDir, b)).mtimeMs - fs.statSync(path.join(this.tempDir, a)).mtimeMs);
        const latest = allFiles[0];
        if (latest) {
          return {
            success: true, filePath: path.join(this.tempDir, latest),
            title: info.title, duration: info.duration,
            durationStr: this.formatDuration(info.duration),
            channel: info.channel, webpageUrl: info.webpage_url, thumbnail: info.thumbnail,
          };
        }
        return { success: false, error: 'File not found after download' };
      }

      return {
        success: true, filePath: path.join(this.tempDir, files[0]),
        title: info.title, duration: info.duration,
        durationStr: this.formatDuration(info.duration),
        channel: info.channel, webpageUrl: info.webpage_url, thumbnail: info.thumbnail,
      };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async searchAndDownload(query) {
    if (query.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/)) return await this.download(query);
    const searchResult = await this.search(query, 1);
    if (!searchResult.success || searchResult.results.length === 0) return { success: false, error: 'No results found' };
    return await this.download(searchResult.results[0].url);
  }

  formatDuration(seconds) {
    if (!seconds) return '?:??';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  cleanOldDownloads(ageMs = 3600000) {
    const now = Date.now();
    for (const file of fs.readdirSync(this.tempDir)) {
      if (file.startsWith('yt_')) {
        const filePath = path.join(this.tempDir, file);
        try { if (now - fs.statSync(filePath).mtimeMs > ageMs) fs.unlinkSync(filePath); } catch {}
      }
    }
  }
}

export default YouTubeDownloader;
