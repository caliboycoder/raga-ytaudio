// YouTube audio proxy server — v8
// Uses youtubei.js with custom JS evaluator for URL deciphering
import { createServer } from 'http';
import { Innertube, Platform } from 'youtubei.js';
import vm from 'vm';

// CRITICAL FIX: Provide a JS evaluator so youtubei.js can decipher YouTube URLs.
// The default evaluator throws "No valid URL to decipher" — it's a no-op.
// We use Node's vm module to safely execute YouTube's player JS.
Platform.shim.eval = async (data, env) => {
  const script = new vm.Script(data.output);
  const context = vm.createContext({});
  return script.runInContext(context);
};

const PORT = process.env.PORT || 5000;
const ANDROID_UA = 'com.google.android.youtube/19.02.39 (Linux; U; Android 13; Pixel 7)';

const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

let tube = null;
let tubeCreatedAt = 0;
const TUBE_TTL = 25 * 60 * 1000;

async function getTube() {
  if (tube && (Date.now() - tubeCreatedAt) < TUBE_TTL) return tube;
  console.log('[yt] Creating session...');
  tube = await Innertube.create({ generate_session_locally: true });
  tubeCreatedAt = Date.now();
  return tube;
}

function resetTube() { tube = null; tubeCreatedAt = 0; }

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
}

async function getAudioUrl(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached;

  const yt = await getTube();
  let info;
  try {
    info = await yt.getBasicInfo(videoId);
  } catch (e) {
    console.log(`[yt] getBasicInfo error: ${e.message}`);
    resetTube();
    const fresh = await getTube();
    info = await fresh.getBasicInfo(videoId);
  }

  console.log(`[yt] ${videoId}: playability=${info.playability_status?.status}`);

  if (info.playability_status?.status !== 'OK') {
    console.log(`[yt] ${videoId}: ${info.playability_status?.reason || 'not playable'}`);
    return null;
  }

  // Try chooseFormat which handles deciphering via our custom eval
  try {
    const fmt = info.chooseFormat({ type: 'audio', quality: 'bestefficiency' });
    if (fmt?.url) {
      const entry = {
        url: fmt.url,
        mime: fmt.mime_type?.split(';')[0] || 'audio/mp4',
        size: Number(fmt.content_length || 0),
        expires: Date.now() + CACHE_TTL,
      };
      console.log(`[yt] OK ${videoId} via chooseFormat (${entry.size}b)`);
      cache.set(videoId, entry);
      return entry;
    }
  } catch (e) {
    console.log(`[yt] chooseFormat error: ${e.message}`);
  }

  // Fallback: try download() to get a stream URL
  try {
    const af = info.streaming_data?.adaptive_formats || [];
    const audioFmts = af.filter(f => f.mime_type?.includes('audio'));
    
    for (const fmt of audioFmts) {
      if (fmt.url) {
        const entry = {
          url: fmt.url,
          mime: fmt.mime_type?.split(';')[0] || 'audio/mp4',
          size: Number(fmt.content_length || 0),
          expires: Date.now() + CACHE_TTL,
        };
        console.log(`[yt] OK ${videoId} via direct URL (${entry.size}b)`);
        cache.set(videoId, entry);
        return entry;
      }
      // Try decipher
      if (fmt.decipher) {
        try {
          const url = await fmt.decipher(tube.session?.player);
          if (url) {
            const entry = {
              url,
              mime: fmt.mime_type?.split(';')[0] || 'audio/mp4',
              size: Number(fmt.content_length || 0),
              expires: Date.now() + CACHE_TTL,
            };
            console.log(`[yt] OK ${videoId} via decipher (${entry.size}b)`);
            cache.set(videoId, entry);
            return entry;
          }
        } catch (e) {
          console.log(`[yt] decipher error: ${e.message?.slice(0, 100)}`);
        }
      }
    }
  } catch (e) {
    console.log(`[yt] fallback error: ${e.message}`);
  }

  return null;
}

async function streamAudio(audio, range, res) {
  const h = { 'User-Agent': ANDROID_UA };
  if (range) h['Range'] = range;

  let upstream;
  try {
    upstream = await fetch(audio.url, { headers: h });
  } catch (e) {
    console.log(`[yt] stream fetch: ${e.message}`);
    return null;
  }

  if (!upstream.ok && upstream.status !== 206) {
    console.log(`[yt] stream: ${upstream.status}`);
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
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!res.writableEnded) res.write(value); } } catch {}
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
    res.end(JSON.stringify({ status: 'ok', v: 8, cache: cache.size }));
    return;
  }

  if (url.pathname.startsWith('/test')) {
    if (!videoId) { res.writeHead(400); res.end('need ?id='); return; }
    try {
      cache.delete(videoId);
      const audio = await getAudioUrl(videoId);
      if (!audio) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No audio extracted' }));
        return;
      }
      let streamOk = false;
      try {
        const probe = await fetch(audio.url, { headers: { 'Range': 'bytes=0-1023', 'User-Agent': ANDROID_UA } });
        streamOk = probe.ok || probe.status === 206;
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: streamOk, mime: audio.mime, size: audio.size }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'HEAD' && videoId) {
    try {
      const a = await getAudioUrl(videoId);
      if (a) { res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': String(a.size), 'Accept-Ranges': 'bytes' }); }
      else { res.writeHead(404); }
    } catch { res.writeHead(500); }
    res.end();
    return;
  }

  if (!videoId) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'raga-ytaudio', v: 8, test: '/test?id=dQw4w9WgXcQ' }));
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

    console.log(`[${new Date().toISOString()}] stream ${videoId} (${audio.size}b)`);
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
    resetTube();
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } else { res.end(); }
  }
});

server.listen(PORT, () => {
  console.log(`YT audio proxy v8 (with JS eval) on port ${PORT}`);
  getTube().then(() => console.log('Session ready')).catch(e => console.error('Init fail:', e.message));
});
