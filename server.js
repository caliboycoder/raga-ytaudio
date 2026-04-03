// Minimal YouTube audio proxy server for Railway (free tier: 500 hrs/month)
// Deploy: railway up

import { Innertube } from 'youtubei.js';
import { createServer } from 'http';

const PORT = process.env.PORT || 3001;
const ANDROID_UA = 'com.google.android.youtube/19.02.39 (Linux; U; Android 13; Pixel 7)';

// Cache
const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

async function getAudioUrl(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached;

  const tube = await Innertube.create({ client_type: 'ANDROID', generate_session_locally: true });
  const info = await tube.getBasicInfo(videoId);
  const formats = info.streaming_data?.adaptive_formats?.filter(
    f => f.mime_type?.includes('audio') && f.url
  ) || [];
  if (formats.length === 0) return null;

  const mp4 = formats.filter(f => f.mime_type?.includes('mp4'));
  const best = (mp4.length > 0 ? mp4 : formats).sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))[0];

  const result = {
    url: best.url,
    mime: best.mime_type?.split(';')[0] || 'audio/mp4',
    size: Number(best.content_length || 0),
    expires: Date.now() + CACHE_TTL,
  };
  cache.set(videoId, result);
  return result;
}

const server = createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const videoId = url.searchParams.get('id');
  const mode = url.searchParams.get('mode') || 'proxy';

  if (!videoId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing ?id=VIDEO_ID' }));
    return;
  }

  try {
    const audio = await getAudioUrl(videoId);
    if (!audio) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No audio found' }));
      return;
    }

    if (mode === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify({ url: audio.url, mime: audio.mime, size: audio.size }));
      return;
    }

    // Proxy mode: stream audio
    const range = req.headers.range || 'bytes=0-';
    const upstream = await fetch(audio.url, {
      headers: { 'User-Agent': ANDROID_UA, 'Range': range },
    });

    const headers = {
      'Content-Type': audio.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    };
    const cl = upstream.headers.get('content-length');
    const cr = upstream.headers.get('content-range');
    if (cl) headers['Content-Length'] = cl;
    if (cr) headers['Content-Range'] = cr;

    res.writeHead(upstream.status, headers);
    
    // Stream the response
    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(value);
      }
    };
    pump().catch(() => res.end());
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`YouTube audio proxy running on port ${PORT}`));
