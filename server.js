// YouTube audio proxy server — v5
// Uses youtubei.js download() for streaming (handles all cipher/token internally)
import { createServer } from 'http';
import { Innertube } from 'youtubei.js';

const PORT = process.env.PORT || 5000;

const cache = new Map(); // videoId -> { info, expires, client }
const CACHE_TTL = 30 * 60 * 1000; // 30 min (shorter — sessions expire)

let tube = null;
let tubeCreatedAt = 0;
const TUBE_TTL = 25 * 60 * 1000;

async function getTube() {
  if (tube && (Date.now() - tubeCreatedAt) < TUBE_TTL) return tube;
  console.log('[yt] Creating Innertube session...');
  tube = await Innertube.create({
    generate_session_locally: true,
    // retrieve_player: true is default — needed for download()
  });
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

// Get video info with detailed logging
async function getInfo(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached.info;

  const yt = await getTube();
  let info;
  try {
    info = await yt.getBasicInfo(videoId);
  } catch (e) {
    console.log(`[yt] getBasicInfo error: ${e.message}, refreshing session`);
    resetTube();
    const fresh = await getTube();
    info = await fresh.getBasicInfo(videoId);
  }

  // Log what we got
  const sd = info.streaming_data;
  const af = sd?.adaptive_formats || [];
  const f = sd?.formats || [];
  const audioAf = af.filter(x => x.mime_type?.includes('audio'));
  const withUrl = audioAf.filter(x => x.url);
  console.log(`[yt] ${videoId}: adaptive=${af.length} audio=${audioAf.length} withUrl=${withUrl.length} combined=${f.length} playability=${info.playability_status?.status}`);

  if (info.playability_status?.status !== 'OK') {
    console.log(`[yt] ${videoId} not playable: ${info.playability_status?.status} - ${info.playability_status?.reason || ''}`);
  }

  cache.set(videoId, { info, expires: Date.now() + CACHE_TTL });
  return info;
}

// Stream audio using youtubei.js download() — handles all cipher/token internally
async function streamViaDownload(videoId, range, res) {
  const yt = await getTube();
  const info = await getInfo(videoId);

  // Check if there are any audio formats at all
  const af = info.streaming_data?.adaptive_formats || [];
  const audioFormats = af.filter(x => x.mime_type?.includes('audio'));
  
  if (audioFormats.length === 0) {
    // No adaptive audio — try download with video (will be larger but works)
    const combined = info.streaming_data?.formats || [];
    if (combined.length === 0) {
      return { ok: false, error: 'No formats available' };
    }
  }

  try {
    // Use download() which handles everything internally
    const stream = await info.download({
      type: 'audio',
      quality: 'bestefficiency',
    });

    // Get format info for headers
    let mime = 'audio/mp4';
    let size = 0;
    try {
      const fmt = info.chooseFormat({ type: 'audio', quality: 'bestefficiency' });
      mime = fmt.mime_type?.split(';')[0] || 'audio/mp4';
      size = Number(fmt.content_length || 0);
    } catch {}

    const headers = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=1800',
    };
    if (size) headers['Content-Length'] = String(size);
    res.writeHead(200, headers);

    // Pipe the ReadableStream to response
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.writableEnded) res.write(Buffer.from(value));
    }
    res.end();
    return { ok: true };
  } catch (e) {
    console.log(`[yt] download() failed for ${videoId}: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// Fallback: try to extract URL and proxy manually
async function streamViaProxy(videoId, range, res) {
  const info = await getInfo(videoId);
  const af = info.streaming_data?.adaptive_formats || [];
  const audioFmts = af.filter(f => f.mime_type?.includes('audio') && f.url);
  const combined = (info.streaming_data?.formats || []).filter(f => f.url);
  const allFmts = [...audioFmts, ...combined];

  if (allFmts.length === 0) return { ok: false, error: 'No streamable formats' };

  const mp4 = audioFmts.filter(f => f.mime_type?.includes('mp4'));
  const pick = (mp4.length > 0 ? mp4 : allFmts).sort((a, b) => (a.bitrate||0) - (b.bitrate||0))[0];

  const fetchH = { 'User-Agent': 'com.google.android.youtube/19.02.39 (Linux; U; Android 13; Pixel 7)' };
  if (range) fetchH['Range'] = range;

  const upstream = await fetch(pick.url, { headers: fetchH });
  if (!upstream.ok && upstream.status !== 206) {
    return { ok: false, error: `upstream ${upstream.status}` };
  }

  const rh = { 'Content-Type': pick.mime_type?.split(';')[0] || 'audio/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=1800' };
  if (range && upstream.status === 206) {
    if (upstream.headers.get('content-length')) rh['Content-Length'] = upstream.headers.get('content-length');
    if (upstream.headers.get('content-range')) rh['Content-Range'] = upstream.headers.get('content-range');
    res.writeHead(206, rh);
  } else {
    rh['Content-Length'] = String(pick.content_length || upstream.headers.get('content-length') || '');
    res.writeHead(200, rh);
  }

  const reader = upstream.body.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; if (!res.writableEnded) res.write(value); } } catch {}
  res.end();
  return { ok: true };
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const videoId = url.searchParams.get('id');

  // Health
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', v: 5, cache: cache.size }));
    return;
  }

  // Test/debug endpoint
  if (url.pathname.startsWith('/test')) {
    if (!videoId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"need ?id="}'); return; }
    try {
      cache.delete(videoId);
      const info = await getInfo(videoId);
      const af = info.streaming_data?.adaptive_formats || [];
      const audioFmts = af.filter(f => f.mime_type?.includes('audio'));
      const withUrl = audioFmts.filter(f => f.url);
      const combined = info.streaming_data?.formats || [];
      
      // Try download to see if it works
      let downloadOk = false;
      let downloadErr = '';
      try {
        const stream = await info.download({ type: 'audio', quality: 'bestefficiency' });
        // Read just a tiny bit to verify
        const reader = stream.getReader();
        const { value } = await reader.read();
        downloadOk = value && value.length > 0;
        reader.cancel();
      } catch (e) { downloadErr = e.message; }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        playability: info.playability_status?.status,
        reason: info.playability_status?.reason || '',
        adaptive: af.length,
        audio: audioFmts.length,
        audioWithUrl: withUrl.length,
        combined: combined.length,
        downloadOk,
        downloadErr: downloadErr || undefined,
      }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // HEAD
  if (req.method === 'HEAD' && videoId) {
    try {
      const info = await getInfo(videoId);
      const af = info.streaming_data?.adaptive_formats || [];
      const audio = af.filter(f => f.mime_type?.includes('audio'));
      if (audio.length > 0 || (info.streaming_data?.formats || []).length > 0) {
        const pick = audio[0] || info.streaming_data.formats[0];
        res.writeHead(200, {
          'Content-Type': pick.mime_type?.split(';')[0] || 'audio/mp4',
          'Content-Length': String(pick.content_length || 0),
          'Accept-Ranges': 'bytes',
        });
      } else { res.writeHead(404); }
    } catch { res.writeHead(500); }
    res.end();
    return;
  }

  if (!videoId) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ service: 'raga-ytaudio', v: 5, test: '/test?id=dQw4w9WgXcQ' }));
    return;
  }

  const mode = url.searchParams.get('mode') || 'proxy';

  try {
    console.log(`[${new Date().toISOString()}] ${mode}: ${videoId}`);

    if (mode === 'json') {
      // JSON mode: return direct URL if available
      const info = await getInfo(videoId);
      const af = info.streaming_data?.adaptive_formats || [];
      const audio = af.filter(f => f.mime_type?.includes('audio') && f.url);
      if (audio.length > 0) {
        const pick = audio.sort((a, b) => (a.bitrate||0) - (b.bitrate||0))[0];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: pick.url, mime: pick.mime_type?.split(';')[0], size: Number(pick.content_length || 0) }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No direct URL available' }));
      return;
    }

    // Proxy mode: try download() first, then URL proxy fallback
    const range = req.headers.range || null;

    // Method 1: Use download() — handles cipher/tokens internally
    const dlResult = await streamViaDownload(videoId, range, res);
    if (dlResult.ok) return;

    console.log(`[yt] download() failed: ${dlResult.error}, trying URL proxy`);

    // Method 2: Direct URL proxy
    if (!res.headersSent) {
      const proxyResult = await streamViaProxy(videoId, range, res);
      if (proxyResult.ok) return;
      console.log(`[yt] proxy failed: ${proxyResult.error}`);
    }

    if (!res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No audio available' }));
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
  console.log(`YT audio proxy v5 on port ${PORT}`);
  getTube().then(() => console.log('Session ready')).catch(e => console.error('Init fail:', e.message));
});
