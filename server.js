const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
require('dotenv').config();

// Keep the server alive on unexpected errors
process.on('uncaughtException', err => console.error('Uncaught exception:', err.message));
process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

const YTDLP_PATH  = process.env.YTDLP_PATH  || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FORMATS = {
  mp3: { mimeType: 'audio/mpeg', ext: 'mp3', ytdlpFmt: 'mp3' },
  aac: { mimeType: 'audio/aac',  ext: 'aac', ytdlpFmt: 'aac' },
  m4a: { mimeType: 'audio/mp4',  ext: 'm4a', ytdlpFmt: 'aac' },
};

// Cache: videoId -> { title, uploader }
const infoCache = new Map();

function getVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
    return u.searchParams.get('v');
  } catch { return null; }
}

// Fetch title + uploader in one yt-dlp call
function fetchInfo(url) {
  return new Promise((resolve) => {
    const id = getVideoId(url);
    if (id && infoCache.has(id)) return resolve(infoCache.get(id));

    const proc = spawn(YTDLP_PATH, [
      '--no-playlist', '--print', 'title', '--print', 'uploader', url
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('close', () => {
      const lines    = out.trim().split('\n');
      const title    = (lines[0] || '').trim();
      const uploader = (lines[1] || '').trim();
      const info = { title, uploader };
      if (id) infoCache.set(id, info);
      resolve(info);
    });
    proc.on('error', () => resolve({ title: '', uploader: '' }));
  });
}

// Remove illegal filename chars, keep spaces
function toSafeFilename(str) {
  return str
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .trim()
    .replace(/\.+$/, '')
    || 'audio';
}

// Strip author name from title if it appears (e.g. "Artist - Song" -> "Song")
function cleanTitle(title, uploader) {
  if (!uploader || !title) return title;
  // Remove common patterns: "Artist - ", "Artist: ", "(Artist)"
  // Also handle "Artist Topic" channel names (YouTube auto-generated)
  const artist = uploader.replace(/\s*-\s*Topic$/, '').trim();
  const escaped = artist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title
    .replace(new RegExp(`^${escaped}\\s*[-–—:]\\s*`, 'i'), '')
    .replace(new RegExp(`\\s*[-–—:]\\s*${escaped}$`, 'i'), '')
    .trim() || title;
}

// POST /info — preview title for the UI
app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  const { title } = await fetchInfo(url);
  res.json({ title });
});

// POST /playlist — returns all video URLs + titles
app.post('/playlist', (req, res) => {
  const { url } = req.body;
  if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const urlProc   = spawn(YTDLP_PATH, ['--flat-playlist', '--print', 'url',   '--no-warnings', url]);
  const titleProc = spawn(YTDLP_PATH, ['--flat-playlist', '--print', 'title', '--no-warnings', url]);

  let urlOut = '', titleOut = '';
  urlProc.stdout.on('data',   d => { urlOut   += d.toString(); });
  titleProc.stdout.on('data', d => { titleOut += d.toString(); });

  let done = 0;
  const finish = () => {
    if (++done < 2) return;
    const urls   = urlOut.trim().split('\n').map(s => s.trim()).filter(Boolean);
    const titles = titleOut.trim().split('\n').map(s => s.trim());
    const items  = urls.map((u, i) => ({ url: u, title: titles[i] || '' }));
    res.json({ items });
  };

  urlProc.on('close', finish);
  titleProc.on('close', finish);
  urlProc.on('error', () => res.status(500).json({ error: 'yt-dlp failed' }));
});

// POST /download
app.post('/download', async (req, res) => {
  const { url, format = 'aac' } = req.body;

  if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const fmt = FORMATS[format] || FORMATS.aac;
  const { title, uploader } = await fetchInfo(url);

  // Clean title: remove author prefix/suffix if present
  const cleanedTitle = cleanTitle(title, uploader);
  const safeName     = toSafeFilename(cleanedTitle || 'audio');
  const filename     = `${safeName}.${fmt.ext}`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', fmt.mimeType);

  // Embed metadata: title + artist from uploader
  // Strip " - Topic" suffix YouTube adds to auto-generated channels
  const artistName = uploader.replace(/\s*-\s*Topic$/, '').trim();
  const metaFlags  = [
    '--embed-metadata',
    '--parse-metadata', `%(uploader)s:%(artist)s`,
    '--postprocessor-args', `ffmpeg:-metadata artist="${artistName}" -metadata title="${cleanedTitle}"`,
  ];

  // AAC and M4A need a temp file; MP3 can stream directly
  if (fmt.ext === 'aac' || fmt.ext === 'm4a') {
    const tmpBase = path.join(os.tmpdir(), `ytdl_${Date.now()}`);
    const tmpFile = `${tmpBase}.${fmt.ext}`;

    const ytDlp = spawn(YTDLP_PATH, [
      '--no-playlist', '-x',
      '--audio-format', fmt.ytdlpFmt,
      '--audio-quality', '0',
      '--ffmpeg-location', FFMPEG_PATH,
      ...metaFlags,
      '-o', tmpFile,
      url
    ]);

    ytDlp.stderr.on('data', d => console.error('[yt-dlp]', d.toString()));
    ytDlp.on('error', err => {
      if (!res.headersSent) res.status(500).json({ error: 'yt-dlp failed to start' });
    });
    ytDlp.on('close', code => {
      if (code !== 0) {
        if (!res.headersSent) res.status(500).json({ error: `yt-dlp exited with code ${code}` });
        return;
      }
      // Check file exists before streaming
      if (!fs.existsSync(tmpFile)) {
        if (!res.headersSent) res.status(500).json({ error: 'Output file not found after conversion' });
        return;
      }
      const stream = fs.createReadStream(tmpFile);
      stream.on('error', err => {
        console.error('Read stream error:', err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to read output file' });
      });
      stream.pipe(res);
      stream.on('close', () => fs.unlink(tmpFile, () => {}));
    });

  } else {
    // MP3 — stream stdout
    const ytDlp = spawn(YTDLP_PATH, [
      '--no-playlist', '-x',
      '--audio-format', fmt.ytdlpFmt,
      '--audio-quality', '0',
      '--ffmpeg-location', FFMPEG_PATH,
      ...metaFlags,
      '-o', '-',
      url
    ]);

    ytDlp.stdout.pipe(res);
    ytDlp.stderr.on('data', d => console.error('[yt-dlp]', d.toString()));
    ytDlp.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'yt-dlp failed to start' });
    });
    ytDlp.on('close', code => {
      if (code !== 0) console.error(`yt-dlp exited with code ${code}`);
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
