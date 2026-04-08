const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config();

// Configure via environment variables, or fall back to names on PATH.
// On a new machine, set YTDLP_PATH and FFMPEG_PATH, or add both to your system PATH.
const YTDLP_PATH  = process.env.YTDLP_PATH  || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FORMATS = {
  mp3: { mimeType: 'audio/mpeg', ext: 'mp3', ytdlpFmt: 'mp3' },
  aac: { mimeType: 'audio/aac',  ext: 'aac', ytdlpFmt: 'aac' },
  m4a: { mimeType: 'audio/mp4',  ext: 'm4a', ytdlpFmt: 'aac' }, // aac codec in m4a container
};

// Simple in-memory title cache: videoId -> title string
const titleCache = new Map();

function getVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('?')[0];
    return u.searchParams.get('v');
  } catch { return null; }
}

// Sanitize a string for use as a filename — keeps spaces, removes only truly invalid chars
function toSafeFilename(str) {
  return str
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '') // remove chars illegal on Windows/Mac
    .trim()
    .replace(/\.+$/, '')                     // no trailing dots
    || 'audio';
}
  return new Promise((resolve) => {
    const id = getVideoId(url);
    if (id && titleCache.has(id)) return resolve(titleCache.get(id));

    const proc = spawn(YTDLP_PATH, ['--get-title', '--no-playlist', url]);
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('close', () => {
      const title = out.trim();
      if (id && title) titleCache.set(id, title);
      resolve(title);
    });
    proc.on('error', () => resolve(''));
  });
}

// POST /playlist — returns all video URLs + titles in a playlist
app.post('/playlist', (req, res) => {
  const { url } = req.body;
  if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Use two separate --print calls to avoid tab-escape issues:
  // first collect URLs, then titles, then zip them
  const urlProc = spawn(YTDLP_PATH, [
    '--flat-playlist', '--print', 'url', '--no-warnings', url
  ]);
  const titleProc = spawn(YTDLP_PATH, [
    '--flat-playlist', '--print', 'title', '--no-warnings', url
  ]);

  let urlOut = '', titleOut = '';
  urlProc.stdout.on('data', d => { urlOut += d.toString(); });
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

// POST /info — returns video title (used by the preview; result is cached)
app.post('/info', async (req, res) => {
  const { url } = req.body;
  if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  const title = await fetchTitle(url);
  res.json({ title });
});

// POST /download — streams audio directly to the client
app.post('/download', async (req, res) => {
  const { url, format = 'aac' } = req.body;

  if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const fmt = FORMATS[format] || FORMATS.aac;

  const title = await fetchTitle(url);
  const safeName = toSafeFilename(title || 'audio');
  const filename = `${safeName}.${fmt.ext}`;

  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', fmt.mimeType);

  // Metadata flags — embed title, and map uploader name to the artist tag
  const metaFlags = [
    '--embed-metadata',
    '--parse-metadata', 'uploader:%(artist)s',
  ];

  // M4A and AAC both need a temp file (container requires seekable output)
  if (fmt.ext === 'm4a' || fmt.ext === 'aac') {
    const os = require('os');
    const fs = require('fs');
    const tmpFile = path.join(os.tmpdir(), `ytdl_${Date.now()}.${fmt.ext}`);

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
      console.error('yt-dlp error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'yt-dlp failed to start' });
    });

    ytDlp.on('close', code => {
      if (code !== 0) {
        if (!res.headersSent) res.status(500).json({ error: `yt-dlp exited with code ${code}` });
        return;
      }
      const stream = fs.createReadStream(tmpFile);
      stream.pipe(res);
      stream.on('close', () => fs.unlink(tmpFile, () => {}));
    });

  } else {
    // MP3 — stream stdout directly
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
    ytDlp.on('error', err => {
      console.error('yt-dlp error:', err.message);
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
