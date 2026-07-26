// GET /api/rail/service?id=<serviceID or serviceIdPercentEncoded>
//
// Darwin (via RDM) GetServiceDetails — the full calling-point list for one service,
// each with scheduled/expected/actual times and platform. Powers the leg detail
// view's live-position timeline: which stops it's already called at, and roughly
// where it is right now. Ported from the equivalent feature in the RTT-based
// maldenTrains app, adapted to Darwin's schema and generalised to any station pair
// (the original was New Malden/Waterloo-specific).
//
// IMPORTANT: GetServiceDetails is a DIFFERENT RDM data product from the Live Departure
// Board one — subscribing to one does not give access to the other. An "Unable to
// route the message to a Target Endpoint" / messaging.runtime.RouteFailed error means
// exactly this: the path being called isn't a valid route on the departure-board
// product's API proxy. Subscribe to RDM's "Service Details" product separately, then
// set DARWIN_SERVICE_PRODUCT (and DARWIN_SERVICE_VERSION if it differs from the
// default below) in Cloudflare Pages env vars to its base path from the
// Specification tab — no code change needed once you have that.
//
// "Formed by" similarly calls GetArrBoardWithDetails, which may also need its own
// subscription — configurable via DARWIN_ARRIVALS_PRODUCT for the same reason.

const RDM_BASE = "https://api1.raildata.org.uk";
const PRODUCT = "1010-live-departure-board-dep1_2";
const VERSION = "20220120";

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

// `productEnvVar` lets each call site use its own product subscription — service
// details, arrivals, and the departure board are likely three separate RDM products
// even though they all sit under the same LDBWS API family. Each product can also have
// its own API key (e.g. DARWIN_SERVICE_APIKEY) if RDM issued a different one for that
// subscription — falls back to the shared DARWIN_APIKEY if no product-specific key is set.
async function rdmGet(env, path, productEnvVar) {
  const product = (productEnvVar && env[productEnvVar]) || env.DARWIN_PRODUCT || PRODUCT;
  const version = (productEnvVar && env[productEnvVar.replace("_PRODUCT", "_VERSION")]) || env.DARWIN_VERSION || VERSION;
  const apiKey = (productEnvVar && env[productEnvVar.replace("_PRODUCT", "_APIKEY")]) || env.DARWIN_APIKEY;
  const endpoint = `${RDM_BASE}/${product}/LDBWS/api/${version}${path}`;
  let resp;
  try {
    resp = await fetch(endpoint, { headers: { "x-apikey": apiKey, Accept: "application/json" } });
  } catch (e) {
    return { ok: false, status: 502, detail: String(e) };
  }
  const text = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, endpoint, detail: text.slice(0, 300) };
  try { return { ok: true, data: JSON.parse(text) }; } catch (e) { return { ok: false, status: 502, detail: "Bad JSON from RDM" }; }
}

// Darwin's calling-point times are plain "HH:MM" (or "HH:MM:SS") strings already —
// no ISO parsing needed, unlike the tube/board.js TfL times.
function hhmm(t) {
  return typeof t === "string" && /^\d{2}:\d{2}/.test(t) ? t.slice(0, 5) : null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing 'id' (serviceID)" }, 400);
  if (!env.DARWIN_APIKEY && !env.DARWIN_SERVICE_APIKEY) return json({ error: "No API key configured (DARWIN_APIKEY or DARWIN_SERVICE_APIKEY)" }, 500);

  const svcResp = await rdmGet(env, `/GetServiceDetails/${encodeURIComponent(id)}`, "DARWIN_SERVICE_PRODUCT");
  // Surface the real failure instead of a generic message — this is exactly the kind
  // of thing that was silently swallowed before and made a real bug look mysterious.
  if (!svcResp.ok) return json({ error: "RDM error", status: svcResp.status, endpoint: svcResp.endpoint, detail: svcResp.detail }, 502);
  const svc = svcResp.data;

  const result = buildProgress(svc);
  if (!result.stops.length) {
    // We got a response but couldn't find any calling points in it — most likely means
    // RDM's JSON shape for this field differs from what we're expecting. Echo the raw
    // top-level keys so this is diagnosable rather than a silent empty timeline.
    result._rawKeys = Object.keys(svc || {});
  }

  try {
    const result2 = await inferInbound(env, svc);
    if (result2.inbound) result.inbound = result2.inbound;
    else result._inboundNote = result2.reason || "No inbound working could be inferred.";
  } catch (e) {
    // Surfaced (not swallowed) so "why is Formed By missing" is answerable — most
    // likely cause is DARWIN_ARRIVALS_PRODUCT/DARWIN_ARRIVALS_APIKEY not set yet,
    // same pattern as the GetServiceDetails routing fix.
    result._inboundNote = `Formed-by lookup failed: ${e.message || e}`;
  }

  return json(result, 200, { "Cache-Control": "public, max-age=20" });
}

// RDM's JSON conversion of the calling-point-list XML structure isn't confirmed from
// stable documentation, so this tries a few plausible shapes rather than assuming one:
//   subsequentCallingPoints[0].callingPoint      (array-of-wrapper, "callingPoint")
//   subsequentCallingPoints[0].callingPointList  (array-of-wrapper, "callingPointList")
//   subsequentCallingPoints.callingPoint         (single wrapper object, not an array)
function extractCallingPoints(node) {
  if (!node) return [];
  const wrapper = Array.isArray(node) ? node[0] : node;
  if (!wrapper) return [];
  const list = wrapper.callingPoint || wrapper.callingPointList || wrapper.callingPoints;
  return Array.isArray(list) ? list : [];
}

/* Turn GetServiceDetails' previous/here/subsequent calling points into a flat stop
   list with a "current position" caption, the same shape as maldenTrains' buildProgress
   but driven by Darwin's std/etd/atd fields instead of RTT's temporalData. */
function buildProgress(svc) {
  const prev = extractCallingPoints(svc.previousCallingPoints);
  const subs = extractCallingPoints(svc.subsequentCallingPoints);
  const here = {
    locationName: svc.locationName, crs: svc.crs,
    st: svc.std || svc.sta, et: svc.etd || svc.eta, at: svc.atd || svc.ata,
    isCancelled: svc.isCancelled, platform: svc.platform,
  };
  const allPoints = [...prev, here, ...subs];

  const stops = allPoints.map((p) => ({
    name: p.locationName || "—",
    crs: p.crs || "",
    std: hhmm(p.st),
    etd: p.et === "On time" ? hhmm(p.st) : hhmm(p.et),
    atd: hhmm(p.at),
    platform: p.platform || null,
    cancelled: p.isCancelled === true,
    departed: !!hhmm(p.at),
  }));

  let lastDeparted = -1;
  stops.forEach((s, i) => { if (s.departed) lastDeparted = i; });
  const currentIdx = lastDeparted >= 0 ? Math.min(lastDeparted + 1, stops.length - 1) : 0;
  stops.forEach((s, i) => { s.passed = i < currentIdx; s.current = i === currentIdx; });

  // Fractional position between "last departed" and "next stop", ported from
  // maldenTrains' computePosition — interpolates using elapsed time vs the scheduled
  // gap between the two. `pos` is a continuous index (e.g. 2.4 = 40% of the way from
  // stop 2 to stop 3) the frontend uses to place the timeline marker precisely, not
  // just snap it to a stop.
  let caption = "No live information.";
  let pos = 0;
  if (stops.length) {
    if (lastDeparted < 0) {
      caption = `Not yet departed ${stops[0].name}`;
      pos = 0;
    } else if (lastDeparted >= stops.length - 1) {
      caption = `Arrived at ${stops[stops.length - 1].name}`;
      pos = stops.length - 1;
    } else {
      const from = stops[lastDeparted], to = stops[currentIdx];
      const depMin = timeToMinutesToday(from.atd || from.etd || from.std);
      const arrMin = timeToMinutesToday(to.etd || to.std);
      let frac = 0;
      if (depMin != null && arrMin != null) {
        const span = arrMin - depMin;
        if (span > 0) {
          const nowMin = (new Date().getHours() * 60 + new Date().getMinutes());
          frac = Math.max(0, Math.min(1, (nowMin - depMin) / span));
        }
      }
      pos = lastDeparted + frac;
      caption = frac > 0.08 && frac < 0.92
        ? `Left ${from.name}, approaching ${to.name}`
        : `Departed ${from.name}, next ${to.name}`;
    }
  }

  return {
    origin: stops.length ? stops[0].name : "—",
    destination: stops.length ? stops[stops.length - 1].name : "—",
    operator: svc.operator || "",
    stops,
    caption,
    pos,
  };
}

function timeToMinutesToday(hhmmStr) {
  const m = typeof hhmmStr === "string" && hhmmStr.match(/^(\d{2}):(\d{2})/);
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

// Returns { inbound } on a match, or { reason } explaining specifically why not —
// "no inbound could be inferred" was too generic to debug; this tells you which of
// several distinct situations actually happened.
async function inferInbound(env, svc) {
  const prevAll = (svc.previousCallingPoints && svc.previousCallingPoints[0] && svc.previousCallingPoints[0].callingPoint) || [];
  const origin = prevAll.length ? prevAll[0] : { locationName: svc.locationName, crs: svc.crs, st: svc.std, platform: svc.platform };
  if (!origin.crs || !origin.st) return { reason: "This train's own origin/departure time isn't available." };
  if (!origin.platform) return { reason: `No platform is allocated yet for the ${origin.locationName || "origin"} departure — platforms are often only confirmed shortly before departure, so this can resolve itself closer to the time.` };

  const depMin = timeToMinutesToday(origin.st);
  if (depMin == null) return { reason: "Couldn't parse the origin departure time." };

  const arrResp = await rdmGet(env, `/GetArrBoardWithDetails/${origin.crs}?numRows=15&timeWindow=45`, "DARWIN_ARRIVALS_PRODUCT");
  if (!arrResp.ok) {
    // A real API failure (wrong product/key, RouteFailed, etc.) — propagate so the
    // caller can surface it, rather than silently looking like "nothing to infer".
    throw new Error(`arrivals board error (status ${arrResp.status}): ${(arrResp.detail || "").slice(0, 150)}`.trim());
  }
  const arrivals = Array.isArray(arrResp.data.trainServices) ? arrResp.data.trainServices : [];
  if (!arrivals.length) return { reason: `The arrivals board at ${origin.locationName || origin.crs} has nothing in view right now (45 min window).` };

  let best = null, bestMin = -Infinity, sameStationCount = 0, samePlatformCount = 0;
  for (const a of arrivals) {
    sameStationCount++;
    const plat = a.platform;
    if (!plat || String(plat) !== String(origin.platform)) continue;   // same platform — turnarounds almost always reuse it
    samePlatformCount++;
    const arrTime = a.ata || a.eta || a.sta;
    const arrMin = timeToMinutesToday(arrTime);
    if (arrMin == null) continue;
    let gap = depMin - arrMin;
    if (gap < 0) gap += 1440; // midnight wrap
    if (gap < 2 || gap > 35) continue;   // plausible turnaround window
    if (arrMin > bestMin) { bestMin = arrMin; best = a; }
  }
  if (!best) {
    if (!samePlatformCount) return { reason: `${sameStationCount} arrival${sameStationCount === 1 ? "" : "s"} in view at ${origin.locationName || origin.crs}, but none on platform ${origin.platform} — nothing plausible to link.` };
    return { reason: `${samePlatformCount} arrival${samePlatformCount === 1 ? "" : "s"} on platform ${origin.platform}, but none within a plausible 2–35 min turnaround window before the ${origin.st} departure.` };
  }
  const inId = best.serviceIdPercentEncoded || best.serviceID;
  if (!inId) return { reason: "Found a plausible inbound arrival but it had no service ID to look up." };

  const inResp = await rdmGet(env, `/GetServiceDetails/${encodeURIComponent(inId)}`, "DARWIN_SERVICE_PRODUCT");
  if (!inResp.ok) {
    throw new Error(`inbound service-details error (status ${inResp.status}): ${(inResp.detail || "").slice(0, 150)}`.trim());
  }
  const p = buildProgress(inResp.data);
  return {
    inbound: {
      origin: p.origin, destination: p.destination, operator: p.operator, stops: p.stops, pos: p.pos,
      platform: origin.platform,
      dueArr: hhmm(best.sta), expectedArr: hhmm(best.eta) || hhmm(best.ata),
      inferred: true,
    },
  };
}
