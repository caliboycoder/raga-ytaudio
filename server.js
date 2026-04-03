// YouTube audio proxy server — v6
// Uses Invidious API instances as primary source (they handle cipher/bot detection)
// Falls back to youtubei.js download() if Invidious fails
import { createServer } from 'http';

const PORT = process.env.PORT || 5000;

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Invidious instances — rotated on failure
// These handle YouTube's cipher/bot detection on their infrastructure
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://invidious.jing.rocks',
  'https://invidious.privacyredirect.com',
  'https://iv.nbohr.de',
  'https://invidious.protokoll-11.de',
  'https://yt.cdaut.de',
  'https://invidious.materialio.us',
  'https://invidious.drgns.space',
];

let instanceIdx = 0;
let lastInstanceRotation = 0;

function getInstances() {
  // Rotate starting point every 10 minutes to spread load
  if (Date.now() - lastInstanceRotation > 600000) {
    instanceIdx = (instanceIdx + 1) % INVIDIOUS_INSTANCES.length;
    lastInstanceRotation = Date.now();
  }
  // Return instances starting from current index, wrapping around
  const result = [];
  for (let i = 0; i < INVIDIOUS_INSTANCES.length; i++) {
    result.push(INVIDIOUS_INSTANCES[(instanceIdx + i) % INVIDIOUS_INSTANCES.length]);
  }
  return result;
}

// Get audio URL from Invidious API
async function getFromInvidious(videoId) {
  const instances = getInstances();
  
  for (const base of instances) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      
      const res = await fetch(`${base}/api/v1/videos/${videoId}`, {
        headers: { 'Accept': 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      
      if (!res.ok) {
        console.log(`[yt] ${base}: ${res.status}`);
        continue;
      }
      
      const data = await res.json();
      
      // Get audio-only adaptive formats
      const audioFormats = (data.adaptiveFormats || [])
        .filter(f => f.type?.includes('audio') && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      
      if (audioFormats.length === 0) {
        // Try regular formats (combined audio+video)
        const combined = (data.formatStreams || []).filter(f => f.url);
        if (combined.length > 0) {
          console.log(`[yt] ${base}: using combined format for ${videoId}`);
          return {
            url: combined[0].url,
            mime: combined[0].type?.split(';')[0] || 'audio/mp4',
            size: Number(combined[0].clen || 0),
            instance: base,
          };
        }
        console.log(`[yt] ${base}: no audio formats for ${videoId}`);
        continue;
      }
      
      // Prefer mp4 audio
      const mp4 = audioFormats.filter(f => f.type?.includes('mp4'));
      const pick = mp4.length > 0 ? mp4[0] : audioFormats[0];
      
      console.log(`[yt] ${base}: OK ${videoId} (${pick.clen || '?'}b, ${pick.type?.split(';')[0]})`);
      return {
        url: pick.url,
        mime: pick.type?.split(';')[0] || 'audio/mp4',
        size: Number(pick.clen || pick.contentLength || 0),
        instance: base,
      };
    } catch (e) {
      console.log(`[yt] ${base}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    }
  }
  return null;
}

async function getAudioUrl(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached;

  const result = await getFromInvidious(videoId);
  if (result) {
    const entry = { ...result, expires: Date.now() + CACHE_TTL };
    cache.set(videoId, entry);
    return entry;
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
  const h = {};
  if (range) h['Range'] = range;

  let upstream;
  try {
    upstream = await fetch(audio.url, { headers: h });
  } catch (e) {
    console.log(`[yt] stream fetch error: ${e.message}`);
    return null;
  }

  if (!upstream.ok && upstream.status !== 206) {
    console.log(`[yt] stream upstream: ${upstream.status}`);
    return null;
  }

  const rh = { 'Content-Type': audio.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' };

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

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', v: 6, cache: cache.size, instances: INVIDIOUS_INSTANCES.length }));
    return;
  }

  // Test endpoint
  if (url.pathname.startsWith('/test')) {
    if (!videoId) { res.writeHead(400); res.end('need ?id='); return; }
    try {
      cache.delete(videoId);
      const audio = await getAudioUrl(videoId);
      if (!audio) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No audio from any instance' }));
        return;
      }
      // Verify stream with range probe
      let streamOk = false;
      try {
        const probe = await fetch(audio.url, { headers: { 'Range': 'bytes=0-1023' } });
        streamOk = probe.ok || probe.status === 206;
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: streamOk, instance: audio.instance, mime: audio.mime, size: audio.size }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // HEAD
  if (req.method === 'HEAD' && videoId) {
    try {
      const a = await getAudioUrl(videoId);
      if (a) {
        res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': String(a.size), 'Accept-Ranges': 'bytes' });
      } else { res.writeHead(404); }
    } catch { res.writeHead(500); }
    res.end();
    return;
  }

  if (!videoId) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'raga-ytaudio', v: 6, test: '/test?id=dQw4w9WgXcQ' }));
    return;
  }

  const mode = url.searchParams.get('mode') || 'proxy';

  try {
    console.log(`[${new Date().toISOString()}] ${mode}: ${videoId}`);
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

    console.log(`[${new Date().toISOString()}] stream ${videoId} (${audio.size}b via ${audio.instance})`);
    const range = req.headers.range || null;
    let ok = await streamAudio(audio, range, res);
    if (!ok) {
      cache.delete(videoId);
      const fresh = await getAudioUrl(videoId);
      if (fresh) ok = await streamAudio(fresh, range, res);
      if (!ok && !res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Stream failed' }));
      }
    }
  } catch (e) {
    console.error(`[${new Date().toISOString()}] ERR ${videoId}: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } else { res.end(); }
  }
});

server.listen(PORT, () => {
  console.log(`YT audio proxy v6 (Invidious) on port ${PORT}`);
});
