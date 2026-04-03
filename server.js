// YouTube audio proxy server — v4
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
  console.log(`[yt] new session: ${clientType}`);
  const opts = { generate_session_locally: true };
  if (clientType !== 'WEB') opts.client_type = clientType;
  tubes[clientType] = await Innertube.create(opts);
  tubeCreatedAt[clientType] = Date.now();
  return tubes[clientType];
}

function resetTube(ct) { tubes[ct] = null; tubeCreatedAt[ct] = 0; }

async function tryClient(videoId, clientType) {
  const tube = await getTube(clientType);
  let info;
  try {
    info = await tube.getBasicInfo(videoId);
  } catch (e) {
    console.log(`[yt] ${clientType} basic err: ${e.message}`);
    resetTube(clientType);
    const fresh = await getTube(clientType);
    info = await fresh.getBasicInfo(videoId);
  }

  // Get all audio formats with URLs
  const adaptive = info.streaming_data?.adaptive_formats || [];
  const audioFmts = adaptive.filter(f => f.mime_type?.includes('audio') && f.url);
  
  if (audioFmts.length === 0) {
    // Try chooseFormat as fallback (handles deciphering)
    try {
      const fmt = info.chooseFormat({ type: 'audio', quality: 'bestefficiency' });
      if (fmt?.url) {
        return { url: fmt.url, mime: fmt.mime_type?.split(';')[0] || 'audio/mp4', size: Number(fmt.content_length || 0) };
      }
    } catch {}
    
    // Try combined formats
    const combined = (info.streaming_data?.formats || []).filter(f => f.url);
    if (combined.length > 0) {
      return { url: combined[0].url, mime: combined[0].mime_type?.split(';')[0] || 'video/mp4', size: Number(combined[0].content_length || 0) };
    }
    return null;
  }

  // Prefer mp4, pick LOWEST bitrate (most compatible, fastest)
  const mp4 = audioFmts.filter(f => f.mime_type?.includes('mp4'));
  const pick = (mp4.length > 0 ? mp4 : audioFmts).sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))[0];
  return { url: pick.url, mime: pick.mime_type?.split(';')[0] || 'audio/mp4', size: Number(pick.content_length || 0) };
}

async function getAudioUrl(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached;

  for (const ct of ['ANDROID', 'WEB']) {
    try {
      const r = await tryClient(videoId, ct);
      if (r) {
        // Verify the URL actually works before caching
        try {
          const probe = await fetch(r.url, { method: 'HEAD', headers: { 'User-Agent': ANDROID_UA } });
          if (!probe.ok) {
            console.log(`[yt] ${ct} URL probe failed: ${probe.status} for ${videoId}`);
            continue;
          }
          // Update size from probe if we didn't have it
          if (!r.size) r.size = Number(probe.headers.get('content-length') || 0);
        } catch (e) {
          console.log(`[yt] ${ct} URL probe error: ${e.message}`);
          continue;
        }
        
        const entry = { ...r, expires: Date.now() + CACHE_TTL, client: ct };
        console.log(`[yt] OK ${ct}: ${videoId} (${entry.size}b)`);
        cache.set(videoId, entry);
        return entry;
      }
      console.log(`[yt] SKIP ${ct}: no formats for ${videoId}`);
    } catch (e) {
      console.log(`[yt] FAIL ${ct}: ${e.message}`);
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
  const h = { 'User-Agent': ANDROID_UA };
  if (range) h['Range'] = range;

  let upstream;
  try {
    upstream = await fetch(audio.url, { headers: h });
  } catch (e) {
    console.log(`[yt] stream fetch error: ${e.message}`);
    return null;
  }
  
  if (!upstream.ok && upstream.status !== 206) {
    console.log(`[yt] stream upstream ${upstream.status} for url`);
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

  // HEAD
  if (req.method === 'HEAD' && videoId) {
    try {
      const a = await getAudioUrl(videoId);
      if (a) { res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': String(a.size), 'Accept-Ranges': 'bytes' }); }
      else { res.writeHead(404); }
    } catch { res.writeHead(500); }
    res.end();
    return;
  }

  // Health
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', v: 4, cache: cache.size }));
    return;
  }

  // Test endpoint — extracts AND verifies streaming works
  if (url.pathname.startsWith('/test')) {
    if (!videoId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'need ?id=VIDEO_ID' }));
      return;
    }
    try {
      cache.delete(videoId);
      const a = await getAudioUrl(videoId);
      if (!a) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No audio found' }));
        return;
      }
      // Verify stream works by fetching first 1KB
      const probe = await fetch(a.url, { headers: { 'User-Agent': ANDROID_UA, 'Range': 'bytes=0-1023' } });
      const probeOk = probe.ok || probe.status === 206;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: probeOk, client: a.client, mime: a.mime, size: a.size, streamStatus: probe.status }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // No video ID — show usage
  if (!videoId) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'raga-ytaudio', v: 4, test: '/test?id=dQw4w9WgXcQ' }));
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

    console.log(`[${new Date().toISOString()}] stream ${videoId} (${audio.size}b ${audio.client})`);
    const range = req.headers.range || null;
    let ok = await streamAudio(audio, range, res);
    if (!ok) {
      // URL might be expired — retry with fresh
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
    ['ANDROID', 'WEB'].forEach(c => resetTube(c));
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } else { res.end(); }
  }
});

server.listen(PORT, () => {
  console.log(`YT audio proxy v4 on port ${PORT}`);
  getTube('ANDROID').then(() => console.log('ANDROID ready')).catch(e => console.error('init fail:', e.message));
});
