// YouTube audio proxy server
import { createServer } from 'http';
import { Innertube } from 'youtubei.js';

const PORT = process.env.PORT || 5000;
const ANDROID_UA = 'com.google.android.youtube/19.02.39 (Linux; U; Android 13; Pixel 7)';

const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

// REUSE a single Innertube instance — creating new ones for every request causes rate limiting
let tubeInstance = null;
let tubeCreatedAt = 0;
const TUBE_TTL = 30 * 60 * 1000; // Refresh session every 30 min

async function getTube() {
  if (tubeInstance && (Date.now() - tubeCreatedAt) < TUBE_TTL) return tubeInstance;
  console.log('[ytaudio] Creating new Innertube session...');
  tubeInstance = await Innertube.create({
    client_type: 'ANDROID',
    generate_session_locally: true,
  });
  tubeCreatedAt = Date.now();
  return tubeInstance;
}

async function getAudioUrl(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached;

  const tube = await getTube();
  let info;
  try {
    info = await tube.getBasicInfo(videoId);
  } catch (e) {
    // Session might be stale — force refresh and retry once
    console.log('[ytaudio] Session error, refreshing...', e.message);
    tubeInstance = null;
    const freshTube = await getTube();
    info = await freshTube.getBasicInfo(videoId);
  }

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
}

async function streamAudio(audio, range, res) {
  const fetchHeaders = { 'User-Agent': ANDROID_UA };
  
  // iOS <audio> element behavior:
  // 1. First request: no Range header → needs 200 with Content-Length (for duration calc)
  // 2. Subsequent requests: Range header → needs 206 with Content-Range
  // If no range requested, fetch full file and return 200 with known Content-Length
  const hasRange = !!range;
  if (hasRange) {
    fetchHeaders['Range'] = range;
  }

  const upstream = await fetch(audio.url, { headers: fetchHeaders });

  if (!upstream.ok && upstream.status !== 206) {
    return null; // Signal caller to retry with fresh URL
  }

  const headers = {
    'Content-Type': audio.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  };

  if (hasRange && upstream.status === 206) {
    // Range request — pass through 206 with Content-Range
    if (upstream.headers.get('content-length')) headers['Content-Length'] = upstream.headers.get('content-length');
    if (upstream.headers.get('content-range')) headers['Content-Range'] = upstream.headers.get('content-range');
    res.writeHead(206, headers);
  } else {
    // Full request — return 200 with total Content-Length
    // Use known size from YouTube metadata (more reliable than upstream header)
    headers['Content-Length'] = String(audio.size || upstream.headers.get('content-length') || '');
    res.writeHead(200, headers);
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { res.end(); break; }
      if (!res.writableEnded) res.write(value);
    }
  } catch {
    res.end();
  }
  return true;
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // HEAD requests — iOS <audio> sends HEAD to probe Content-Length before streaming
  if (req.method === 'HEAD') {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const videoId = url.searchParams.get('id');
    if (videoId) {
      try {
        const audio = await getAudioUrl(videoId);
        if (audio) {
          res.writeHead(200, {
            'Content-Type': audio.mime,
            'Content-Length': String(audio.size),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600',
          });
          res.end();
          return;
        }
      } catch {}
    }
    res.writeHead(404);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', cache_size: cache.size, session_age_min: Math.round((Date.now() - tubeCreatedAt) / 60000) }));
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

    // Proxy mode: stream audio with proper headers for iOS background playback
    console.log(`[${new Date().toISOString()}] Streaming ${videoId} (${audio.size} bytes, ${audio.mime})`);
    const range = req.headers.range || null;
    
    const result = await streamAudio(audio, range, res);
    if (result === null) {
      // URL expired — clear cache and retry with fresh URL
      cache.delete(videoId);
      const fresh = await getAudioUrl(videoId);
      if (!fresh) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Audio stream unavailable' }));
        return;
      }
      const retryResult = await streamAudio(fresh, range, res);
      if (retryResult === null) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Stream failed' }));
      }
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Error for ${videoId}:`, e.message);
    // Force session refresh on next request
    tubeInstance = null;
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`YouTube audio proxy running on port ${PORT}`);
  // Pre-warm the Innertube session
  getTube().then(() => console.log('Innertube session ready')).catch(e => console.error('Session init failed:', e.message));
});
