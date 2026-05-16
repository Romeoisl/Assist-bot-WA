import { readdirSync, existsSync, readFileSync } from 'fs';
import { join, extname } from 'path';
import { YouTubeDL } from './youtube-dl.js';

const BUILTIN_TRACKS = {
  'lofi': 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
  'lofi hip hop': 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
  'jazz': 'https://www.youtube.com/watch?v=DWjG7j0iZlM',
  'rain': 'https://www.youtube.com/watch?v=mPZkdNFkNps',
  'rain sounds': 'https://www.youtube.com/watch?v=mPZkdNFkNps',
  'calm': 'https://www.youtube.com/watch?v=DWjG7j0iZlM',
  'relax': 'https://www.youtube.com/watch?v=DWjG7j0iZlM',
  'chill': 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
  'focus': 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
  'study': 'https://www.youtube.com/watch?v=jfKfPfyJRdk',
  'nature': 'https://www.youtube.com/watch?v=mPZkdNFkNps',
};

export class MusicPlayer {
  constructor(musicDir, tempDir) {
    this.musicDir = musicDir;
    this.tempDir = tempDir;
    this.youtube = new YouTubeDL(tempDir);
    this.availableTracks = [];
    this.refreshLibrary();
  }

  refreshLibrary() {
    if (!existsSync(this.musicDir)) return;
    const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.opus'];
    this.availableTracks = readdirSync(this.musicDir)
      .filter(f => audioExts.includes(extname(f).toLowerCase()))
      .map(f => ({
        name: extname(f) ? f.slice(0, -extname(f).length) : f,
        path: join(this.musicDir, f),
        ext: extname(f)
      }));
  }

  getTracks() {
    this.refreshLibrary();
    return this.availableTracks;
  }

  searchTracks(query) {
    this.refreshLibrary();
    const q = query.toLowerCase();
    return this.availableTracks.filter(t =>
      t.name.toLowerCase().includes(q)
    );
  }

  getRandomTrack() {
    this.refreshLibrary();
    if (this.availableTracks.length === 0) return null;
    const idx = Math.floor(Math.random() * this.availableTracks.length);
    return this.availableTracks[idx];
  }

  async handleRequest(text, sendAudioFn, sendReplyFn) {
    if (!text || text.length < 3) return false;

    const lower = text.toLowerCase().trim();

    // Check for built-in track keywords
    for (const [keyword, url] of Object.entries(BUILTIN_TRACKS)) {
      if (lower === keyword || lower.startsWith(`${keyword} `) || lower.endsWith(` ${keyword}`)) {
        await sendReplyFn(`🎵 Playing ${keyword}...`);
        const result = await this.youtube.download(url);
        if (result) {
          await sendAudioFn(result.filePath, true);
          return true;
        }
        await sendReplyFn('Sorry, could not play that track.');
        return true;
      }
    }

    // Music request patterns
    const playPatterns = [
      /^(?:play|send|hear|listen to)\s+(.+)/i,
      /^(?:i want to hear|i wanna hear|play me|put on)\s+(.+)/i,
      /^(?:can you play|please play|play some)\s+(.+)/i,
    ];

    let query = null;
    for (const pattern of playPatterns) {
      const match = lower.match(pattern);
      if (match) {
        query = match[1].trim();
        break;
      }
    }

    if (!query) return false;

    // Check local library
    const localMatches = this.searchTracks(query);
    if (localMatches.length > 0) {
      const track = localMatches[0];
      await sendReplyFn(`🎵 Playing "${track.name}" from library...`);
      await sendAudioFn(track.path, true);
      return true;
    }

    // Download from YouTube
    await sendReplyFn(`🔍 Searching for "${query}"...`);
    const result = await this.youtube.searchAndDownload(query);
    if (result) {
      await sendReplyFn(`🎵 Now playing: ${result.title}`);
      await sendAudioFn(result.filePath, true);
      return true;
    }

    // Fallback: random local track
    const randomTrack = this.getRandomTrack();
    if (randomTrack) {
      await sendReplyFn(`🎵 Couldn't find "${query}". Playing random track: "${randomTrack.name}"`);
      await sendAudioFn(randomTrack.path, true);
      return true;
    }

    await sendReplyFn(`Sorry, couldn't find "${query}" or any local tracks.`);
    return true;
  }
}
