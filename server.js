// YouTube audio proxy — v9 (ANDROID client, direct URLs, no decipher needed)
import { createServer } from 'http';
import { Innertube } from 'youtubei.js';

const PORT = process.env.PORT || 5000;
const UA = 'com.google.android.youtube/19.02.39 (Linux; U; Android 13; Pixel 7)';

const cache = new Map();
const CACHE_TTL = 90 * 60 * 1000; // 90 min

let tube = null;
let tubeAt = 0;

async function getTube() {
  if (tube && (Date.now() - tubeAt) < 25 * 60 * 1000) return tube;
  console.log('[yt] new ANDROID session');
  tube = await Innertube.create({ client_type: 'ANDROID', generate_session_locally: true });
  tubeAt = Date.now();
  return tube;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
}

async function getAudio(videoId) {
  const c = cache.get(videoId);
  if (c && c.exp > Date.now()) return c;

  const yt = await getTube();
  let info;
  try { info = await yt.getBasicInfo(videoId); }
  catch (e) {
    console.log('[yt] retry:', e.message?.slice(0, 80));
    tube = null;
    info = await (await getTube()).getBasicInfo(videoId);
  }

  if (info.playability_status?.status !== 'OK') {
    console.log(`[yt] ${videoId}: ${info.playability_status?.status} - ${info.playability_status?.reason || ''}`);
    return null;
  }

  const af = (info.streaming_data?.adaptive_formats || []).filter(f => f.mime_type?.includes('audio') && f.url);
  if (af.length === 0) {
    console.log(`[yt] ${videoId}: no audio URLs`);
    return null;
  }

  // Pick smallest mp4 audio (most compatible)
  const mp4 = af.filter(f => f.mime_type?.includes('mp4'));
  const pick = (mp4.length > 0 ? mp4 : af).sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))[0];
  const entry = { url: pick.url, mime: pick.mime_type?.split(';')[0] || 'audio/mp4', size: Number(pick.content_length || 0), exp: Date.now() + CACHE_TTL };
  console.log(`[yt] OK ${videoId} ${entry.size}b ${entry.mime}`);
  cache.set(videoId, entry);
  return entry;
}

async function pipe(audio, range, res) {
  const h = { 'User-Agent': UA };
  if (range) h['Range'] = range;
  const up = await fetch(audio.url, { headers: h });
  if (!up.ok && up.status !== 206) { console.log(`[yt] upstream ${up.status}`); return false; }

  const rh = { 'Content-Type': audio.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' };
  if (range && up.status === 206) {
    if (up.headers.get('content-length')) rh['Content-Length'] = up.headers.get('content-length');
    if (up.headers.get('content-range')) rh['Content-Range'] = up.headers.get('content-range');
    res.writeHead(206, rh);
  } else {
    rh['Content-Length'] = String(audio.size || up.headers.get('content-length') || '');
    res.writeHead(200, rh);
  }
  const r = up.body.getReader();
  try { for (;;) { const { done, value } = await r.read(); if (done) break; if (!res.writableEnded) res.write(value); } } catch {}
  res.end();
  return true;
}

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const id = url.searchParams.get('id');

  if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, v: 9, cache: cache.size })); return; }

  if (url.pathname.startsWith('/test')) {
    if (!id) { res.writeHead(400); res.end('need ?id='); return; }
    cache.delete(id);
    try {
      const a = await getAudio(id);
      if (!a) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false })); return; }
      const p = await fetch(a.url, { headers: { Range: 'bytes=0-1023', 'User-Agent': UA } });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: p.ok || p.status === 206, mime: a.mime, size: a.size, stream: p.status }));
    } catch (e) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, err: e.message })); }
    return;
  }

  if (req.method === 'HEAD' && id) {
    const a = await getAudio(id).catch(() => null);
    if (a) { res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': String(a.size), 'Accept-Ranges': 'bytes' }); }
    else { res.writeHead(404); }
    res.end(); return;
  }

  if (!id) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ service: 'raga-ytaudio', v: 9 })); return; }

  const mode = url.searchParams.get('mode') || 'proxy';
  try {
    console.log(`[${new Date().toISOString()}] ${mode}: ${id}`);
    const a = await getAudio(id);
    if (!a) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"error":"No audio"}'); return; }

    if (mode === 'json') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ url: a.url, mime: a.mime, size: a.size })); return; }

    console.log(`[${new Date().toISOString()}] stream ${id} ${a.size}b`);
    if (!(await pipe(a, req.headers.range || null, res))) {
      cache.delete(id);
      const fresh = await getAudio(id);
      if (!fresh || !(await pipe(fresh, req.headers.range || null, res))) {
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"error":"Stream failed"}'); }
      }
    }
  } catch (e) {
    console.error(`[yt] ERR ${id}:`, e.message);
    tube = null;
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`YT proxy v9 on :${PORT}`);
  getTube().then(() => console.log('ANDROID ready')).catch(e => console.error('fail:', e.message));
});
