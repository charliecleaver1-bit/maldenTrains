# My Travel

A personal live-departures app for New Malden — rail (National Rail / Darwin)
and London buses (TfL) — deployed on Cloudflare Pages.

## Files
```
index.html                  the whole app (vanilla JS, no build step)
manifest.webmanifest        PWA manifest ("Add to Home Screen" as "My Travel")
icon-180/192/512.png        app icons
functions/api/board.js      rail departures  (Darwin LDBWS via Rail Data Marketplace)
functions/api/service.js    one train's calling points + live position
functions/api/busstops.js   find bus stops near a location/postcode (TfL + postcodes.io)
functions/api/busboard.js   live bus arrivals for a saved stop (TfL)
functions/api/ldbtest.js    diagnostic probe for the Darwin feed (safe to delete)
```

## Required variables
Cloudflare Pages → Settings → Variables & Secrets. **Set for BOTH Production
and Preview**, then redeploy.

| Name | Needed for | Where to get it |
|---|---|---|
| `LDB_KEY` | Rail (required) | raildata.org.uk → subscribe to **Live Departure Board** → **consumer key** (not the secret) |
| `TFL_APP_KEY` | Buses (optional) | api-portal.tfl.gov.uk — TfL works keyless; a key just raises the rate limit |

`RTT_TOKEN` is no longer used — the rail feed moved from Realtime Trains to
Darwin, which is free for **commercial** use (RTT's free tier was personal only).

## Deploy
Easiest and most reliable — from inside this folder:
```
npx wrangler login
npx wrangler pages deploy . --project-name maldentrains
```
This uploads the HTML, icons, manifest and all functions in one go, with no
reliance on the GitHub link.

Or push the folder to GitHub and let Cloudflare Pages build it
(Framework preset: None · Build command: `exit 0` · Output directory: `/`).

## Health checks
- `/api/board?from=NEM&to=WAT` → should return live train JSON
- `/api/service?id=test` → should return a JSON error, **not** a 404
  (a 404 here means the functions didn't deploy)
- `/api/busstops?postcode=KT3+3HL` → should return nearby bus stops
- The app's source label reads **"live · National Rail"** when the feed is up,
  and **"demo — <reason>"** if it has fallen back.

## Attribution
Darwin's licence requires National Rail attribution if you distribute this
publicly ("Powered by National Rail Enquiries"). TfL data requires TfL
attribution. Both are free for commercial use.
