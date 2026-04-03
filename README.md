# Raga YouTube Audio Proxy

Lightweight Node.js server that extracts and proxies YouTube audio streams.
Uses `youtubei.js` for reliable extraction with proper session handling.

## Deploy to Railway (free)

1. Create a free Railway account at https://railway.app
2. Click "New Project" → "Deploy from GitHub repo"
3. Point to this `railway-worker` directory
4. Railway auto-detects Node.js and runs `npm start`
5. Go to Settings → Networking → Generate Domain
6. Copy the URL (e.g., `https://raga-ytaudio-production.up.railway.app`)
7. Set `NEXT_PUBLIC_YT_WORKER_URL` in Vercel to this URL

## API

- `GET /?id=VIDEO_ID` — Streams audio directly (proxy mode, supports Range)
- `GET /?id=VIDEO_ID&mode=json` — Returns JSON with audio URL

## Free Tier

- 500 hours/month (enough for ~20 hours/day)
- No CPU/memory limits per request
- No streaming timeout
- $5 credit/month
