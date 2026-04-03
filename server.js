// YouTube audio proxy server for Railway
import { createServer } from 'http';

const PORT = process.env.PORT || 8080;
const ANDROID_UA = 'com.google.android.youtube/19.02.39 (Linux; U; Android 13; Pixel 7)';

const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

async function getAudioUrl(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached;

  // Dynamic import to get latest version
  const { Innertube } = await import('youtubei.js');
  const tube = await Innertube.create({
    client_type: 'ANDROID',
    generate_session_locally: true,
  });

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

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type');
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', cache_size: cache.size }));
    return;
  }

  const videoId = url.searchParams.get('id');
  const mode = url.searchParams.get('mode') || 'proxy';

  if (!videoId) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'raga-ytaudio', usage: '/?id=VIDEO_ID or /?id=VIDEO_ID&mode=json' }));
    return;
  }

  try {
    console.log(`[${new Date().toISOString()}] Extracting audio for: ${videoId}`);
    const audio = await getAudioUrl(videoId);
    if (!audio) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No audio found for this video' }));
      return;
    }

    if (mode === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
      res.end(JSON.stringify({ url: audio.url, mime: audio.mime, size: audio.size }));
      return;
    }

    // Proxy mode: stream audio from YouTube through this server
    console.log(`[${new Date().toISOString()}] Streaming ${videoId} (${audio.size} bytes, ${audio.mime})`);
    const range = req.headers.range || 'bytes=0-';
    const upstream = await fetch(audio.url, {
      headers: { 'User-Agent': ANDROID_UA, 'Range': range },
    });

    if (!upstream.ok && upstream.status !== 206) {
      // URL might have expired — clear cache and retry once
      cache.delete(videoId);
      const fresh = await getAudioUrl(videoId);
      if (!fresh) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Audio stream unavailable' }));
        return;
      }
      const retry = await fetch(fresh.url, {
        headers: { 'User-Agent': ANDROID_UA, 'Range': range },
      });
      if (!retry.ok && retry.status !== 206) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Stream failed after retry' }));
        return;
      }
      // Stream retry response
      const rHeaders = { 'Content-Type': fresh.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' };
      if (retry.headers.get('content-length')) rHeaders['Content-Length'] = retry.headers.get('content-length');
      if (retry.headers.get('content-range')) rHeaders['Content-Range'] = retry.headers.get('content-range');
      res.writeHead(retry.status, rHeaders);
      const reader = retry.body.getReader();
      const pump = async () => { while (true) { const { done, value } = await reader.read(); if (done) { res.end(); break; } res.write(value); } };
      pump().catch(() => res.end());
      return;
    }

    const headers = { 'Content-Type': audio.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' };
    if (upstream.headers.get('content-length')) headers['Content-Length'] = upstream.headers.get('content-length');
    if (upstream.headers.get('content-range')) headers['Content-Range'] = upstream.headers.get('content-range');
    res.writeHead(upstream.status, headers);

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
    console.error(`[${new Date().toISOString()}] Error for ${videoId}:`, e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`YouTube audio proxy running on port ${PORT}`);
});
