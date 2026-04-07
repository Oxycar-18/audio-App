const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

// Paths to binaries — update FFMPEG_PATH once you have a compiled ffmpeg.exe
const YTDLP_PATH = 'C:\\Users\\arthur.bignier\\KIRO\\Sources\\yt-dlp.exe';
const FFMPEG_PATH = 'ffmpeg'; // replace with full path to ffmpeg.exe when available

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// POST /download — streams MP3 directly to the client
app.post('/download', (req, res) => {
  const { url } = req.body;

  if (!url || !url.includes('youtube.com') && !url.includes('youtu.be')) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  // Use yt-dlp to extract audio and pipe it as MP3
  const ytDlp = spawn(YTDLP_PATH, [
    '--no-playlist',
    '-x',                        // extract audio
    '--audio-format', 'mp3',
    '--audio-quality', '0',      // best quality
    '--ffmpeg-location', FFMPEG_PATH,
    '-o', '-',                   // output to stdout
    url
  ]);

  let filename = 'audio.mp3';

  // Try to get the video title for the filename first
  const titleProc = spawn(YTDLP_PATH, ['--get-title', '--no-playlist', url]);
  let title = '';
  titleProc.stdout.on('data', (d) => { title += d.toString().trim(); });
  titleProc.on('close', () => {
    if (title) {
      // Sanitize title for use as filename
      filename = title.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') + '.mp3';
    }

    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'audio/mpeg');

    ytDlp.stdout.pipe(res);

    ytDlp.stderr.on('data', (data) => {
      console.error('[yt-dlp]', data.toString());
    });

    ytDlp.on('error', (err) => {
      console.error('Failed to start yt-dlp:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'yt-dlp not found. Please install it: https://github.com/yt-dlp/yt-dlp' });
      }
    });

    ytDlp.on('close', (code) => {
      if (code !== 0) console.error(`yt-dlp exited with code ${code}`);
    });
  });

  titleProc.on('error', () => {
    // If title fetch fails, just proceed with default filename
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'audio/mpeg');
    ytDlp.stdout.pipe(res);
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
