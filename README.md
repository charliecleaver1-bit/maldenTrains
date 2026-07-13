# Malden Line — live departures

A tiny personal departure board for **New Malden (NEM)**, with one tap to flip
between *To London Waterloo* and *Home to New Malden*. Shows the next train with
a live countdown, the following departures, platforms, and a delay/cancellation
banner.

It runs **out of the box in demo mode** (realistic made-up times) so you can see
it working. Wire up a free Realtime Trains account to go live.

## Files
```
index.html              the whole app (vanilla JS, no build step)
functions/api/board.js  Cloudflare Pages Function — proxies Realtime Trains,
                        keeps your token server-side
```

## Deploy on Cloudflare Pages (your usual GitHub flow)
1. Push this folder to a GitHub repo.
2. Cloudflare dashboard → **Workers & Pages → Create → Pages → Connect to Git**.
3. Build settings: **Framework preset: None**, **Build command: empty**,
   **Output directory: `/`** (it's static + a Function, nothing to compile).
4. Deploy. The `/functions` folder is picked up automatically, so the app will
   call `/api/board` on your own domain.

## Go live (free, ~3 min)
1. Sign up at **https://api-portal.rtt.io** — personal, non-commercial use is free.
2. Copy your **token** (a long string).
3. Cloudflare Pages → your project → **Settings → Variables & Secrets**, add ONE:
   - `RTT_TOKEN` = your token
4. Redeploy. The app flips from "demo data" to "live · RTT" automatically — no
   code change. If the feed is ever unreachable it quietly falls back to demo.

## Notes
- The proxy is locked to NEM and WAT only, so the endpoint can't be abused to
  query arbitrary stations.
- This uses the next-gen RTT API (`data.rtt.io`, Bearer token). The token you
  get is a long-life *refresh* token; the function swaps it for a short-life
  access token automatically and caches it between requests.
- Disruption text (full National Rail service messages) isn't in the RTT search
  feed — the banner here is derived from cancellations/delays in your own next
  few trains, which is what actually matters for the commute.

## Run locally
Static file — just open `index.html` (demo mode). To test the live Function
locally, use `npx wrangler pages dev .` with the env vars set.
