// YouTube audio proxy server — v3
// Tries multiple InnerTube client types to maximize video compatibility
import { createServer } from 'http';
import { Innertube } from 'youtubei.js';

const PORT = process.env.PORT || 5000;
const ANDROID_UA = 'com.google.android.youtube/19.02.39 (Linux; U; Android 13; Pixel 7)';

const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

let tubes = {};
let tubeCreatedAt = {};
const TUBE_TTL = 30 * 60 * 1000;

async function getTube(clientType) {
  if (tubes[clientType] && (Date.now() - (tubeCreatedAt[clientType] || 0)) < TUBE_TTL) {
    return tubes[clientType];
  }
  console.log(`[ytaudio] Creating session: ${clientType}`);
  const opts = { generate_session_locally: true };
  if (clientType !== 'WEB') opts.client_type = clientType;
  tubes[clientType] = await Innertube.create(opts);
  tubeCreatedAt[clientType] = Date.now();
  return tubes[clientType];
}

function resetTube(ct) { tubes[ct] = null; tubeCreatedAt[ct] = 0; }

// Try to get audio URL from a specific client type
async function tryClient(videoId, clientType) {
  const tube = await getTube(clientType);
  
  // Try getBasicInfo first (faster), fall back to getInfo (more complete)
  let info;
  try {
    info = await tube.getBasicInfo(videoId);
  } catch (e) {
    console.log(`[ytaudio] ${clientType} getBasicInfo error: ${e.message}`);
    resetTube(clientType);
    const fresh = await getTube(clientType);
    info = await fresh.getBasicInfo(videoId);
  }

  // Method 1: Use chooseFormat (handles deciphering)
  try {
    const fmt = info.chooseFormat({ type: 'audio', quality: 'best' });
    if (fmt && fmt.url) {
      return {
        url: fmt.url,
        mime: fmt.mime_type?.split(';')[0] || 'audio/mp4',
        size: Number(fmt.content_length || 0),
      };
    }
  } catch (e) {
    console.log(`[ytaudio] ${clientType} chooseFormat: ${e.message}`);
  }

  // Method 2: Manual extraction from adaptive_formats
  const adaptive = info.streaming_data?.adaptive_formats || [];
  const audioFmts = adaptive.filter(f => f.mime_type?.includes('audio'));
  console.log(`[ytaudio] ${clientType} adaptive audio formats: ${audioFmts.length} (with url: ${audioFmts.filter(f=>f.url).length})`);
  
  // Try formats with direct URL
  const withUrl = audioFmts.filter(f => f.url);
  if (withUrl.length > 0) {
    const mp4 = withUrl.filter(f => f.mime_type?.includes('mp4'));
    const pick = (mp4.length > 0 ? mp4 : withUrl).sort((a, b) => (a.bitrate||0) - (b.bitrate||0))[0];
    return {
      url: pick.url,
      mime: pick.mime_type?.split(';')[0] || 'audio/mp4',
      size: Number(pick.content_length || 0),
    };
  }

  // Method 3: Try decipher on formats without URL
  for (const f of audioFmts) {
    if (f.decipher) {
      try {
        const url = await f.decipher(tube.session?.player);
        if (url) {
          return {
            url,
            mime: f.mime_type?.split(';')[0] || 'audio/mp4',
            size: Number(f.content_length || 0),
          };
        }
      } catch {}
    }
  }

  // Method 4: Try combined formats (audio+video) — last resort
  const combined = info.streaming_data?.formats || [];
  const combinedAudio = combined.filter(f => f.url && f.mime_type);
  if (combinedAudio.length > 0) {
    console.log(`[ytaudio] ${clientType} using combined format for ${videoId}`);
    return {
      url: combinedAudio[0].url,
      mime: combinedAudio[0].mime_type?.split(';')[0] || 'video/mp4',
      size: Number(combinedAudio[0].content_length || 0),
    };
  }

  return null;
}

async function getAudioUrl(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached;

  // Try clients in order: ANDROID_MUSIC → ANDROID → WEB
  const clients = ['ANDROID_MUSIC', 'ANDROID', 'WEB'];
  
  for (const ct of clients) {
    try {
      const result = await tryClient(videoId, ct);
      if (result) {
        const entry = { ...result, expires: Date.now() + CACHE_TTL, client: ct };
        console.log(`[ytaudio] ✓ ${ct}: ${videoId} (${entry.size} bytes)`);
        cache.set(videoId, entry);
        return entry;
      }
      console.log(`[ytaudio] ✗ ${ct}: no audio for ${videoId}`);
    } catch (e) {
      console.log(`[ytaudio] ✗ ${ct} error: ${e.message}`);
      resetTube(ct);
    }
  }

  return null;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
}

async function streamAudio(audio, range, res) {
  const headers = { 'User-Agent': ANDROID_UA };
  if (range) headers['Range'] = range;

  const upstream = await fetch(audio.url, { headers });
  if (!upstream.ok && upstream.status !== 206) return null;

  const rh = {
    'Content-Type': audio.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  };

  if (range && upstream.status === 206) {
    if (upstream.headers.get('content-length')) rh['Content-Length'] = upstream.headers.get('content-length');
    if (upstream.headers.get('content-range')) rh['Content-Range'] = upstream.headers.get('content-range');
    res.writeHead(206, rh);
  } else {
    rh['Content-Length'] = String(audio.size || upstream.headers.get('content-length') || '');
    res.writeHead(200, rh);
  }

  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) res.write(value);
    }
  } catch {} 
  res.end();
  return true;
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const videoId = url.searchParams.get('id');
  const mode = url.searchParams.get('mode') || 'proxy';

  // HEAD — iOS probes content-length before streaming
  if (req.method === 'HEAD' && videoId) {
    try {
      const audio = await getAudioUrl(videoId);
      if (audio) {
        res.writeHead(200, {
          'Content-Type': audio.mime,
          'Content-Length': String(audio.size),
          'Accept-Ranges': 'bytes',
        });
      } else {
        res.writeHead(404);
      }
    } catch { res.writeHead(500); }
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: 3, cache: cache.size }));
    return;
  }

  // Debug endpoint: /test?id=VIDEO_ID — shows detailed extraction info
  if (url.pathname === '/test' && videoId) {
    try {
      cache.delete(videoId); // Force fresh extraction
      const audio = await getAudioUrl(videoId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(audio ? { ok: true, client: audio.client, mime: audio.mime, size: audio.size } : { ok: false, error: 'No audio found' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (!videoId) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'raga-ytaudio', version: 3, usage: '/?id=VIDEO_ID', test: '/test?id=VIDEO_ID' }));
    return;
  }

  try {
    console.log(`[${new Date().toISOString()}] ${mode}: ${videoId}`);
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

    console.log(`[${new Date().toISOString()}] Streaming ${videoId} (${audio.size}b, ${audio.client})`);
    const range = req.headers.range || null;
    let ok = await streamAudio(audio, range, res);
    if (!ok) {
      cache.delete(videoId);
      const fresh = await getAudioUrl(videoId);
      if (fresh) ok = await streamAudio(fresh, range, res);
      if (!ok) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Stream failed' }));
        }
      }
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] Error: ${videoId}: ${e.message}`);
    ['ANDROID_MUSIC', 'ANDROID', 'WEB'].forEach(c => resetTube(c));
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } else { res.end(); }
  }
});

server.listen(PORT, () => {
  console.log(`YouTube audio proxy v3 running on port ${PORT}`);
  getTube('ANDROID_MUSIC')
    .then(() => console.log('ANDROID_MUSIC session ready'))
    .catch(e => console.error('Init failed:', e.message));
});
