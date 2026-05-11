import { Client, LocalAuth, MessageMedia } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mime from 'mime-types';
import axios from 'axios';
import MusicPlayer from './music-player.js';
import YouTubeDownloader from './youtube-dl.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY';
const BOT_NAMES = ['assist', 'assistant', 'ai', 'jarvis', 'helper'];
const USER_NAME = process.env.USER_NAME || 'there';
const TEMP_DIR = path.join(__dirname, 'temp');
const MUSIC_DIR = path.join(__dirname, 'music');

for (const dir of [TEMP_DIR, MUSIC_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const SYSTEM_PROMPT = `You are an AI assistant embedded in a WhatsApp bot. Your name is ${USER_NAME}'s assistant.

RULES:
- You respond like a helpful, natural friend — NOT like a robot
- You can see images, read documents, transcribe voice messages
- Keep responses concise unless detail is needed
- Never mention you're an AI or a bot unless directly asked
- Use the user's name (${USER_NAME}) naturally in conversation
- You can generate images if asked
- You have access to play music — just acknowledge when someone asks to play music

CAPABILITIES:
- Chat naturally about anything
- Read and analyze images, PDFs, documents
- Generate images from descriptions
- Play music from YouTube or local files
- Answer questions, help with tasks`;

const musicPlayer = new MusicPlayer({ musicDir: MUSIC_DIR, tempDir: TEMP_DIR });
const ytDownloader = new YouTubeDownloader({ tempDir: TEMP_DIR, quality: '128k' });

const builtInTracks = {
  lofi: { file: path.join(MUSIC_DIR, 'lofi-study.mp3'), title: 'Lo-Fi Study Beats' },
  focus: { file: path.join(MUSIC_DIR, 'focus-music.mp3'), title: 'Deep Focus' },
  chill: { file: path.join(MUSIC_DIR, 'chill-vibes.mp3'), title: 'Chill Vibes' },
  rain: { file: path.join(MUSIC_DIR, 'rain-sounds.mp3'), title: 'Rain Sounds' },
  jazz: { file: path.join(MUSIC_DIR, 'jazz-cafe.mp3'), title: 'Jazz Café' },
  nature: { file: path.join(MUSIC_DIR, 'nature-sounds.mp3'), title: 'Nature Sounds' },
  classical: { file: path.join(MUSIC_DIR, 'classical-piano.mp3'), title: 'Classical Piano' },
};

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

const conversations = new Map();
const MAX_HISTORY = 50;

function getConversationHistory(chatId, limit = 10) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  return conversations.get(chatId).slice(-limit);
}

function addToHistory(chatId, role, text) {
  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const history = conversations.get(chatId);
  history.push({ role, text, timestamp: Date.now() });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

function buildPrompt(query, senderName, attachmentContext) {
  let prompt = attachmentContext ? `${attachmentContext}\n\n` : '';
  prompt += `${senderName} says: "${query}"\n\nRespond naturally.`;
  return prompt;
}

function splitMessage(text, maxLen = 4000) {
  const chunks = [];
  while (text.length > maxLen) {
    let splitPoint = text.lastIndexOf('\n\n', maxLen);
    if (splitPoint === -1) splitPoint = text.lastIndexOf('. ', maxLen);
    if (splitPoint === -1) splitPoint = text.lastIndexOf(' ', maxLen);
    if (splitPoint === -1) splitPoint = maxLen;
    chunks.push(text.slice(0, splitPoint + 1));
    text = text.slice(splitPoint + 1).trim();
  }
  if (text) chunks.push(text);
  return chunks;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function transcribeAudio(filePath) {
  try {
    const audioBuffer = fs.readFileSync(filePath);
    const base64Audio = audioBuffer.toString('base64');
    const audioMimeType = mime.lookup(filePath) || 'audio/ogg';
    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: 'Transcribe this audio message exactly as spoken. Return only the transcription.' },
          { inlineData: { mimeType: audioMimeType, data: base64Audio } }
        ]
      }]
    });
    const transcription = result.response.text().trim();
    return `[User sent a voice message. Transcription: "${transcription}"]`;
  } catch (err) {
    console.error('Transcription error:', err);
    return '[User sent a voice message. Could not transcribe.]';
  }
}

async function analyzeImage(media) {
  try {
    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: 'Describe this image in detail.' },
          { inlineData: { mimeType: media.mimetype, data: media.data } }
        ]
      }]
    });
    const description = result.response.text().trim();
    return `[User sent an image. Description: "${description}"]`;
  } catch (err) {
    console.error('Image analysis error:', err);
    return '[User sent an image.]';
  }
}

async function analyzeDocument(media) {
  try {
    const result = await model.generateContent({
      contents: [{
        role: 'user',
        parts: [
          { text: 'Read and summarize the content of this document/file.' },
          { inlineData: { mimeType: media.mimetype, data: media.data } }
        ]
      }]
    });
    const content = result.response.text().trim();
    return `[User sent a document. Content summary: "${content}"]`;
  } catch (err) {
    console.error('Document analysis error:', err);
    return `[User sent a document: ${media.filename || 'document'}]`;
  }
}

async function handleImageGeneration(msg, prompt) {
  try {
    await msg.reply(`🎨 Generating "${prompt}"...`);
    const images = [];
    const errors = [];

    try {
      const pollUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true`;
      const pollRes = await axios.get(pollUrl, { responseType: 'arraybuffer', timeout: 30000 });
      images.push({ data: Buffer.from(pollRes.data).toString('base64'), engine: 'Pollinations' });
    } catch (e) { errors.push(`Pollinations: ${e.message}`); }

    try {
      const prodiaRes = await axios.post('https://api.prodia.com/v1/sd/generate', {
        prompt, model: 'anything-v4.5.safetensors [6f35e523]', negative_prompt: 'nsfw', steps: 20, cfg: 7, sampler: 'DPM++ 2M Karras'
      }, { headers: { 'X-Prodia-Key': process.env.PRODIA_API_KEY || '' }, timeout: 30000 });
      if (prodiaRes.data?.imageUrl) {
        const imgRes = await axios.get(prodiaRes.data.imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
        images.push({ data: Buffer.from(imgRes.data).toString('base64'), engine: 'Prodia' });
      }
    } catch (e) { errors.push(`Prodia: ${e.message}`); }

    try {
      const geminiResult = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: `Generate an image: ${prompt}. Return ONLY the image.` }] }]
      });
      const geminiResponse = geminiResult.response;
      if (geminiResponse.candidates?.[0]?.content?.parts) {
        for (const part of geminiResponse.candidates[0].content.parts) {
          if (part.inlineData) {
            images.push({ data: part.inlineData.data, engine: 'Gemini' });
          }
        }
      }
    } catch (e) { errors.push(`Gemini: ${e.message}`); }

    if (images.length > 0) {
      for (let i = 0; i < Math.min(images.length, 3); i++) {
        const img = images[i];
        const media = new MessageMedia('image/jpeg', img.data, `generated_${i+1}.jpg`);
        await msg.reply(media, null, { caption: `✨ "${prompt}" (via ${img.engine})` });
        await sleep(1000);
      }
      if (errors.length > 0) {
        await msg.reply(`Some engines had issues: ${errors.join('; ')}`);
      }
    } else {
      await msg.reply(`Couldn't generate the image. Errors: ${errors.join('; ')}`);
    }
  } catch (err) {
    console.error('Image generation error:', err);
    await msg.reply('Image generation failed. Try again later.');
  }
}

async function handleMusicRequest(msg, chat, query, senderName) {
  const lower = query.toLowerCase().trim();
  let searchQuery = null;

  if (lower.match(/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/)) {
    searchQuery = lower;
  } else if (lower.startsWith('play ')) {
    searchQuery = lower.replace(/^play\s+(music\s+)?/, '').trim();
  } else if (lower.match(/^send\s+(song|music|track|audio)\s+/)) {
    searchQuery = lower.replace(/^send\s+(song|music|track|audio)\s+/, '').trim();
  } else if (lower.match(/(hear|listen to)\s+(.+)/)) {
    searchQuery = lower.match(/(hear|listen to)\s+(.+)/)[2].trim();
  } else if (['music', 'song', 'audio', 'play something', 'play music'].includes(lower) || lower.match(/^play$/)) {
    const localTracks = musicPlayer.listMusicFiles();
    if (localTracks.length > 0) {
      const randomTrack = localTracks[Math.floor(Math.random() * localTracks.length)];
      const result = await musicPlayer.sendAudioFile(client, chat.id._serialized, randomTrack.path, {
        caption: `🎵 ${randomTrack.name.replace(/\.[^.]+$/, '')}`
      });
      if (result.success) {
        await chat.sendMessage(`Playing something for you 🎶`);
        return true;
      }
    }
    searchQuery = 'chill music';
  } else {
    const builtInMatch = Object.keys(builtInTracks).find(k => lower.includes(k));
    if (builtInMatch) {
      const track = builtInTracks[builtInMatch];
      if (fs.existsSync(track.file)) {
        const result = await musicPlayer.sendAudioFile(client, chat.id._serialized, track.file, {
          caption: `🎵 ${track.title}`
        });
        if (result.success) {
          await chat.sendMessage(`Playing "${track.title}" 🎶`);
          return true;
        }
      }
    }
    const localMatch = musicPlayer.searchMusic(lower);
    if (localMatch.length > 0) {
      const result = await musicPlayer.sendAudioFile(client, chat.id._serialized, localMatch[0].path, {
        caption: `🎵 ${localMatch[0].name.replace(/\.[^.]+$/, '')}`
      });
      if (result.success) {
        await chat.sendMessage(`Found it! Playing ${localMatch[0].name} 🎶`);
        return true;
      }
    }
  }

  if (!searchQuery) return false;

  await chat.sendMessage(`🔍 Looking that up...`);
  const dlResult = await ytDownloader.searchAndDownload(searchQuery);

  if (dlResult.success) {
    await chat.sendMessage(`📥 *${dlResult.title}* — ${dlResult.durationStr}`);
    const sendResult = await musicPlayer.sendAudioFile(client, chat.id._serialized, dlResult.filePath, {
      caption: `🎵 ${dlResult.title}`
    });
    setTimeout(() => { try { fs.unlinkSync(dlResult.filePath); } catch {} }, 30000);
    if (sendResult.success) {
      await chat.sendMessage(`Here you go! 🎶`);
      return true;
    } else {
      await chat.sendMessage(`Downloaded it but couldn't send: ${sendResult.error}`);
      return true;
    }
  } else {
    await chat.sendMessage(`Couldn't find that one: ${dlResult.error}`);
    return true;
  }
}

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;

    const chat = await msg.getChat();
    const isGroup = chat.isGroup;
    const sender = await msg.getContact();
    const senderName = sender.pushname || sender.name || 'User';
    const from = msg.from;

    let body = msg.body?.trim() || '';
    let isAddressed = false;
    let query = body;

    if (!isGroup) {
      isAddressed = true;
    } else {
      const lower = body.toLowerCase();
      const nameMatch = BOT_NAMES.find(name =>
        lower.startsWith(name) || lower.includes(` ${name}`) || lower.includes(`@${name}`)
      );
      const quotedMsg = await msg.getQuotedMessage();
      const isReplyToBot = quotedMsg && quotedMsg.fromMe;

      if (nameMatch || isReplyToBot || msg.mentionedIds?.includes(client.info?.wid?._serialized)) {
        isAddressed = true;
        if (nameMatch) {
          query = body.replace(new RegExp(`^${nameMatch}[\\s,:]*|${nameMatch}$`, 'i'), '').trim();
        }
      }
    }

    if (!isAddressed) return;

    addToHistory(from, 'user', body);

    const musicResponse = await handleMusicRequest(msg, chat, query, senderName);
    if (musicResponse) return;

    let attachmentContext = '';

    if (msg.hasMedia) {
      const media = await msg.downloadMedia();
      if (media) {
        const buffer = Buffer.from(media.data, 'base64');
        const ext = mime.extension(media.mimetype) || 'bin';
        const tempFile = path.join(TEMP_DIR, `attachment_${Date.now()}.${ext}`);
        fs.writeFileSync(tempFile, buffer);

        const mimeType = media.mimetype;

        if ((mimeType.startsWith('audio/') && (msg.type === 'voice' || msg.type === 'audio')) || msg.type === 'ptt') {
          attachmentContext = await transcribeAudio(tempFile);
          setTimeout(() => { try { fs.unlinkSync(tempFile); } catch {} }, 5000);
        } else if (mimeType.startsWith('image/')) {
          attachmentContext = await analyzeImage(media);
          setTimeout(() => { try { fs.unlinkSync(tempFile); } catch {} }, 5000);
        } else if (mimeType.includes('pdf') || mimeType.includes('text') || mimeType.includes('document')) {
          attachmentContext = await analyzeDocument(media);
          setTimeout(() => { try { fs.unlinkSync(tempFile); } catch {} }, 5000);
        } else {
          attachmentContext = `[User sent a file: ${media.filename || 'file'} (${media.mimetype})]`;
        }
      }
    }

    const conversationHistory = getConversationHistory(from, 10);
    const contextWindow = [
      { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
      ...conversationHistory.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      })),
      { role: 'user', parts: [{ text: buildPrompt(query, senderName, attachmentContext) }] }
    ];

    const result = await model.generateContent({ contents: contextWindow });
    const response = result.response.text().trim();

    if (response) {
      const imageMatch = response.match(/\[GENERATE_IMAGE:(.+?)\]/);
      if (imageMatch) {
        await handleImageGeneration(msg, imageMatch[1].trim());
        const cleanResponse = response.replace(/\[GENERATE_IMAGE:.+?\]/, '').trim();
        if (cleanResponse) await chat.sendMessage(cleanResponse);
      } else {
        if (response.length > 4000) {
          const chunks = splitMessage(response);
          for (const chunk of chunks) {
            await chat.sendMessage(chunk);
            await sleep(500);
          }
        } else {
          await chat.sendMessage(response);
        }
      }
      addToHistory(from, 'model', response);
    }

  } catch (err) {
    console.error('Message handler error:', err);
    try {
      await msg.reply('Sorry, I ran into an issue. Try again?');
    } catch {}
  }
});

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('Scan QR code above with WhatsApp');
});

client.on('ready', () => {
  console.log('✓ AssistBot v7 is online!');
});

client.on('authenticated', () => {
  console.log('✓ Authenticated successfully');
});

client.on('auth_failure', (msg) => {
  console.error('✗ Auth failure:', msg);
});

client.on('disconnected', (reason) => {
  console.log('Disconnected:', reason);
});

console.log('Starting AssistBot v7...');
console.log('Music directory:', MUSIC_DIR);
console.log('Temp directory:', TEMP_DIR);
client.initialize();

try {
  const { default: BotDashboard } = await import('./dashboard.js');
  const dashboard = new BotDashboard({ port: 3000 });
  dashboard.connectToBot(client);
  dashboard.start();
  console.log('✓ Dashboard starting on port 3000');
} catch (err) {
  console.log('Dashboard not available (optional)');
}

export { client, musicPlayer, ytDownloader };
