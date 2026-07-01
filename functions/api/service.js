/**
 * Cloudflare Pages Function — GET /api/service?id=<uniqueIdentity>
 * --------------------------------------------------------------
 * Returns one train's full calling pattern + current position. For a train
 * that ORIGINATES at a terminus (e.g. a Home service starting at Waterloo),
 * it also follows the "FORM_FROM" association to the inbound train that
 * physically becomes it, and reports that inbound train's delay + position —
 * so you can see a departure will slip before the feed admits it.
 * Called lazily (only when the journey panel is open).
 */

const BASE = "https://data.rtt.io";

// Own access-token cache for this function (refresh -> short-life access).
let cachedToken = null;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing service id." }, 400);
  if (!env.RTT_TOKEN) return json({ error: "Live feed not configured." }, 503);

  let accessToken;
  try {
    accessToken = await getAccessToken(env.RTT_TOKEN);
  } catch (e) {
    return json({ error: "Could not authenticate with the rail feed." }, 502);
  }

  const svc = await fetchService(accessToken, id);
  if (svc && svc.__error) return json({ error: svc.__error }, svc.__status || 502);
  if (!svc) return json({ error: "Service not found." }, 404);

  const result = buildProgress(svc);

  // Follow the turnaround: which inbound train forms this one at its origin?
  const inboundId = findFormedFrom(svc);
  if (inboundId) {
    const inbound = await fetchService(accessToken, inboundId);
    if (inbound && !inbound.__error) result.inbound = buildInbound(inbound);
  }

  return json(result, 200, { "cache-control": "public, max-age=20, s-maxage=20" });
}

/* Fetch one service in detailed mode (detailed surfaces the non-public
   turnaround associations). Returns the service object, or {__error}. */
async function fetchService(accessToken, id) {
  const q = `${BASE}/rtt/service?uniqueIdentity=${encodeURIComponent(id)}&detailed=true`;
  let r;
  try {
    r = await fetch(q, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    return { __error: "Could not reach the rail data feed." };
  }
  if (r.status === 404) return null;
  if (r.status === 401) { cachedToken = null; return { __error: "Token rejected." }; }
  if (!r.ok) return { __error: `Rail feed error (${r.status}).`, __status: 502 };
  const data = await r.json();
  return data.service || null;
}

/* Look for the train that FORMS this one (i.e. arrives and becomes it),
   normally at the origin terminus. Returns its uniqueIdentity, or null. */
function findFormedFrom(svc) {
  const locs = svc.locations || [];
  for (const l of locs) {
    const assoc = l.associatedServices || [];
    for (const a of assoc) {
      const type = a.associationData && a.associationData.associationType;
      if (type === "FORM_FROM") {
        const uid = a.scheduleMetadata && a.scheduleMetadata.uniqueIdentity;
        if (uid) return uid;
      }
    }
  }
  return null;
}

/* Compact inbound summary: its stops (for a mini timeline), plus its delay
   and times at the formation point (its terminus). */
function buildInbound(svc) {
  const p = buildProgress(svc);
  const locs = svc.locations || [];
  const last = locs[locs.length - 1] || {};
  const arr = (last.temporalData && last.temporalData.arrival) || {};
  const schedIso = arr.scheduleAdvertised || null;
  const expIso = arr.realtimeActual || arr.realtimeForecast || arr.scheduleAdvertised || null;
  let lateMins = 0;
  if (schedIso && expIso) {
    const d = Math.round((Date.parse(expIso) - Date.parse(schedIso)) / 60000);
    if (!Number.isNaN(d)) lateMins = d;
  }
  const meta = (last.locationMetadata && last.locationMetadata.platform) || null;
  const platform = meta ? (meta.actual || meta.planned || null) : null;
  return {
    id: svc.scheduleMetadata && svc.scheduleMetadata.uniqueIdentity,
    origin: p.origin,
    destination: p.destination,
    operator: p.operator,
    stops: p.stops,
    lateMins,
    dueArr: hhmm(schedIso),
    expectedArr: hhmm(expIso),
    platform,
  };
}

/* Turn the full service into a compact stop list + current position. */
function buildProgress(svc) {
  const raw = svc.locations || [];
  // Keep only public calling points (stops), drop pass-throughs.
  const calls = raw.filter((l) => {
    const d = (l.temporalData && l.temporalData.displayAs) || "PASS";
    return d === "CALL" || d === "STARTS" || d === "TERMINATES" || d === "CANCELLED";
  });

  const stops = calls.map((l, i) => {
    const t = l.temporalData || {};
    const dep = t.departure || {};
    const arr = t.arrival || {};
    const isLast = i === calls.length - 1;
    // Use arrival time at the final stop, departure time elsewhere; prefer realtime.
    const iso = isLast
      ? arr.realtimeActual || arr.realtimeForecast || arr.scheduleAdvertised || dep.scheduleAdvertised
      : dep.realtimeActual || dep.realtimeForecast || dep.scheduleAdvertised || arr.scheduleAdvertised;
    const meta = l.locationMetadata || {};
    return {
      name: (l.location && l.location.description) || "—",
      crs: (l.location && l.location.shortCodes && l.location.shortCodes[0]) || "",
      time: hhmm(iso),
      dep: hhmm(dep.realtimeActual || dep.realtimeForecast || dep.scheduleAdvertised),
      arr: hhmm(arr.realtimeActual || arr.realtimeForecast || arr.scheduleAdvertised),
      platform: meta.platform ? meta.platform.actual || meta.platform.planned || null : null,
      departed: !!dep.realtimeActual,
      arrived: !!arr.realtimeActual,
      status: t.status || null, // live: APPROACHING / AT_PLATFORM / DEPARTING ...
      cancelled: dep.isCancelled === true || arr.isCancelled === true || t.displayAs === "CANCELLED",
    };
  });

  // Work out where the train is.
  let liveIdx = stops.findIndex((s) => s.status);
  let lastDeparted = -1;
  stops.forEach((s, i) => { if (s.departed) lastDeparted = i; });

  let currentIdx;
  if (liveIdx >= 0) currentIdx = liveIdx;
  else if (lastDeparted >= 0) currentIdx = Math.min(lastDeparted + 1, stops.length - 1);
  else currentIdx = 0;

  stops.forEach((s, i) => {
    s.passed = i < currentIdx;
    s.current = i === currentIdx;
  });

  const caption = buildCaption(stops, currentIdx, liveIdx, lastDeparted);
  return {
    origin: stops.length ? stops[0].name : "—",
    destination: stops.length ? stops[stops.length - 1].name : "—",
    operator: (svc.scheduleMetadata && svc.scheduleMetadata.operator && svc.scheduleMetadata.operator.name) || "",
    stops,
    caption,
  };
}

function buildCaption(stops, currentIdx, liveIdx, lastDeparted) {
  if (!stops.length) return "No live information.";
  const here = stops[currentIdx];
  if (liveIdx >= 0) {
    const s = stops[liveIdx].status;
    if (s === "APPROACHING") return `Approaching ${stops[liveIdx].name}`;
    return `At ${stops[liveIdx].name}`;
  }
  if (lastDeparted < 0) return `Not yet departed ${stops[0].name}`;
  if (currentIdx >= stops.length - 1 && stops[stops.length - 1].arrived) return `Arrived at ${stops[stops.length - 1].name}`;
  return `Departed ${stops[currentIdx - 1] ? stops[currentIdx - 1].name : stops[0].name}, next ${here.name}`;
}

/* Read published HH:MM straight from the timestamp (UK railway time) — no
   timezone conversion (see board.js). */
function hhmm(iso) {
  const m = typeof iso === "string" && iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

async function getAccessToken(refreshToken) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresMs - 30000 > now) return cachedToken.token;
  const r = await fetch(`${BASE}/api/get_access_token`, { headers: { Authorization: `Bearer ${refreshToken}` } });
  if (!r.ok) { cachedToken = { token: refreshToken, expiresMs: now + 60000 }; return refreshToken; }
  const body = await r.json();
  const token = body.token || refreshToken;
  const expiresMs = body.validUntil ? Date.parse(body.validUntil) : now + 5 * 60000;
  cachedToken = { token, expiresMs };
  return token;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
