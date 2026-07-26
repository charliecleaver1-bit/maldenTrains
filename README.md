# Commuter

A personal live-departures app for New Malden — rail (National Rail /
Darwin), London Underground / Overground / DLR / Elizabeth line / tram
(TfL), and buses (TfL + national BODS fallback) — deployed on Cloudflare
Pages.

## Navigation

The app opens on a **Home** screen with four tiles: Rail, Tube, Bus,
Commute. Tapping one of Rail/Tube/Bus opens a single screen with:

1. **Search live trains/arrivals** at the top — pick two stations (rail,
   tube) or find a stop by location/postcode (bus) and see live results
   immediately, with nothing named or saved.
2. **Your journeys/stops** below — the journeys and stops you've saved,
   shown as tappable pills, exactly as before.

Tapping a saved pill always takes over the display from whatever the live
search was showing. The last stations/stop searched are remembered
(prefilled) between visits, but a live search itself doesn't persist as a
"saved" entry unless you explicitly add one.

Commute is unchanged — it always chains together journeys/stops you've
already saved from Rail/Tube/Bus.

## Files
```
index.html                  the whole app (vanilla JS, no build step)
manifest.webmanifest        PWA manifest ("Add to Home Screen" as "Commuter")
icon-180/192/512.png        app icons
sw.js                       push-only service worker (no caching, on purpose)
stations.js                 bundled UK station list for the rail picker
functions/api/board.js      rail departures (Darwin LDBWS via Rail Data Marketplace)
functions/api/service.js    one train's calling points + live position
functions/api/hsp.js        historic service performance (reliability data)
functions/api/busstops.js   find bus stops near a location/postcode (TfL + postcodes.io)
functions/api/busboard.js   live bus arrivals for a stop (TfL)
functions/api/busvehicle.js live bus vehicle tracking (TfL)
functions/api/bods.js       national bus positions outside London (Bus Open Data Service)
functions/api/tube/*.js     tube/Overground/DLR/Elizabeth line/tram board, planning, status, crowding, search
functions/api/push/[action].js  web push subscribe/unsubscribe + alerts
functions/_lib/webpush.js   push notification signing helper
functions/api/*test.js      diagnostic probes for the various feeds (safe to delete before a public deploy)
```

## Required variables
Cloudflare Pages → Settings → Variables & Secrets. **Set for BOTH Production
and Preview**, then redeploy.

| Name | Needed for | Where to get it |
|---|---|---|
| `DARWIN_SERVICE_APIKEY` / `DARWIN_ARRIVALS_APIKEY` | Rail (required) | raildata.org.uk → subscribe to Live Departure Board + Service Details → consumer keys |
| `TFL_APP_KEY` | Tube & bus (optional) | api-portal.tfl.gov.uk — TfL works keyless; a key just raises the rate limit |
| `BODS_KEY` | National bus fallback (optional) | Bus Open Data Service — needed outside London |
| VAPID keys | Push alerts | generated once and stored as wrangler secrets |

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
attribution. Bus Open Data Service content requires OGL v3.0 attribution.
All are free for commercial use.
