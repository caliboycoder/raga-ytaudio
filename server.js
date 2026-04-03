// YouTube audio proxy server
import { createServer } from 'http';
import { Innertube } from 'youtubei.js';

const PORT = process.env.PORT || 5000;
const ANDROID_UA = 'com.google.android.youtube/19.02.39 (Linux; U; Android 13; Pixel 7)';

const cache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

// Maintain Innertube sessions per client type
let tubes = {};
let tubeCreatedAt = {};
const TUBE_TTL = 30 * 60 * 1000;

// Client types to try — ANDROID_MUSIC best for music, then ANDROID, then WEB
const CLIENT_TYPES = ['ANDROID_MUSIC', 'ANDROID', 'WEB'];

async function getTube(clientType) {
  if (tubes[clientType] && (Date.now() - (tubeCreatedAt[clientType] || 0)) < TUBE_TTL) {
    return tubes[clientType];
  }
  console.log(`[ytaudio] Creating Innertube session (${clientType})...`);
  const opts = { generate_session_locally: true };
  if (clientType !== 'WEB') {
    opts.client_type = clientType;
  }
  tubes[clientType] = await Innertube.create(opts);
  tubeCreatedAt[clientType] = Date.now();
  return tubes[clientType];
}

function resetTube(clientType) {
  tubes[clientType] = null;
  tubeCreatedAt[clientType] = 0;
}

async function getAudioUrl(videoId) {
  const cached = cache.get(videoId);
  if (cached && cached.expires > Date.now()) return cached;

  for (const clientType of CLIENT_TYPES) {
    try {
      const tube = await getTube(clientType);
      let info;
      try {
        info = await tube.getBasicInfo(videoId);
      } catch (e) {
        console.log(`[ytaudio] ${clientType} session error: ${e.message}`);
        resetTube(clientType);
        const fresh = await getTube(clientType);
        info = await fresh.getBasicInfo(videoId);
      }

      // Use chooseFormat — it handles deciphering automatically
      let format;
      try {
        format = info.chooseFormat({ type: 'audio', quality: 'best' });
      } catch {
        // chooseFormat throws if no formats available
        console.log(`[ytaudio] ${clientType}: chooseFormat failed for ${videoId}`);
        
        // Manual fallback: check adaptive_formats directly
        const formats = info.streaming_data?.adaptive_formats?.filter(
          f => f.mime_type?.includes('audio')
        ) || [];
        
        if (formats.length === 0) {
          console.log(`[ytaudio] ${clientType}: no audio formats for ${videoId}`);
          continue;
        }
        
        // Try to decipher URLs for formats without direct url
        for (const f of formats) {
          if (!f.url && f.decipher) {
            try {
              const url = await f.decipher(tube.session.player);
              if (url) { f.url = url; }
            } catch {}
          }
        }
        
        const withUrl = formats.filter(f => f.url);
        if (withUrl.length === 0) {
          console.log(`[ytaudio] ${clientType}: no decipherable formats for ${videoId}`);
          continue;
        }
        
        const mp4 = withUrl.filter(f => f.mime_type?.includes('mp4'));
        format = (mp4.length > 0 ? mp4 : withUrl).sort(
          (a, b) => (a.bitrate || 0) - (b.bitrate || 0)
        )[0];
      }

      if (!format || !format.url) {
        // Last attempt: decipher the chosen format
        if (format && format.decipher) {
          try {
            const url = await format.decipher(tube.session.player);
            if (url) format.url = url;
          } catch {}
        }
        if (!format?.url) {
          console.log(`[ytaudio] ${clientType}: format has no URL for ${videoId}`);
          continue;
        }
      }

      const result = {
        url: format.url,
        mime: format.mime_type?.split(';')[0] || 'audio/mp4',
        size: Number(format.content_length || 0),
        expires: Date.now() + CACHE_TTL,
        client: clientType,
      };

      console.log(`[ytaudio] ${clientType}: OK ${videoId} (${result.size} bytes, ${result.mime})`);
      cache.set(videoId, result);
      return result;
    } catch (e) {
      console.log(`[ytaudio] ${clientType} error for ${videoId}: ${e.message}`);
      resetTube(clientType);
    }
  }

  console.log(`[ytaudio] All clients failed for ${videoId}`);
  return null;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');
}

async function streamAudio(audio, range, res) {
  const fetchHeaders = { 'User-Agent': ANDROID_UA };
  const hasRange = !!range;
  if (hasRange) fetchHeaders['Range'] = range;

  const upstream = await fetch(audio.url, { headers: fetchHeaders });

  if (!upstream.ok && upstream.status !== 206) {
    return null;
  }

  const headers = {
    'Content-Type': audio.mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
  };

  if (hasRange && upstream.status === 206) {
    if (upstream.headers.get('content-length')) headers['Content-Length'] = upstream.headers.get('content-length');
    if (upstream.headers.get('content-range')) headers['Content-Range'] = upstream.headers.get('content-range');
    res.writeHead(206, headers);
  } else {
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
    res.end(JSON.stringify({
      status: 'ok',
      cache_size: cache.size,
      clients: Object.keys(tubes).filter(k => tubes[k]).join(', '),
    }));
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
    console.log(`[${new Date().toISOString()}] Request: ${videoId} (mode=${mode})`);
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

    console.log(`[${new Date().toISOString()}] Streaming ${videoId} (${audio.size} bytes, via ${audio.client})`);
    const range = req.headers.range || null;

    const result = await streamAudio(audio, range, res);
    if (result === null) {
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
    CLIENT_TYPES.forEach(c => resetTube(c));
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
  getTube('ANDROID_MUSIC')
    .then(() => console.log('ANDROID_MUSIC session ready'))
    .catch(e => console.error('Session init failed:', e.message));
});
