/**
 * Cloudflare Pages Function — GET /api/board?from=NEM&to=WAT
 * ----------------------------------------------------------
 * Talks to the Realtime Trains *next-generation* API (data.rtt.io,
 * Bearer-token auth) and returns a small, clean JSON shape the
 * front-end understands. Your token stays server-side — the RTT
 * terms require it is never shipped in client code.
 *
 * Set ONE variable in  Cloudflare Pages → Settings → Variables & Secrets:
 *   RTT_TOKEN = the token from https://api-portal.rtt.io
 *
 * Your token is a long-life *refresh* token. This function swaps it for
 * a short-life *access* token (cached between requests) and uses that
 * for the data calls. If your token is already an access token, it falls
 * back to using it directly.
 */

const BASE = "https://data.rtt.io";
const NS = "gb-nr"; // Network Rail namespace (UK national rail)
const ALLOWED = new Set(["NEM", "WAT", "VXH", "CLJ", "EAD", "WIM"]); // New Malden + selectable London-end stations

// Cached access token, reused across requests on the same isolate.
let cachedToken = null; // { token, expiresMs }

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = (url.searchParams.get("from") || "NEM").toUpperCase();
  const to = (url.searchParams.get("to") || "WAT").toUpperCase();

  if (!ALLOWED.has(from) || !ALLOWED.has(to)) {
    return json({ error: "Unsupported station." }, 400);
  }
  if (!env.RTT_TOKEN) {
    return json({ error: "Live feed not configured. Add RTT_TOKEN in Pages settings." }, 503);
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(env.RTT_TOKEN);
  } catch (e) {
    return json({ error: "Could not authenticate with the rail feed." }, 502);
  }

  // Board anchored at `from` (the platform the user stands on).
  let primary;
  try {
    primary = await fetch(`${BASE}/rtt/location?code=${NS}:${from}&filterTo=${NS}:${to}`,
      { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    return json({ error: "Could not reach the rail data feed." }, 502);
  }

  if (primary.status === 204) {
    return json({ from, to, generatedAt: new Date().toISOString(), services: [] });
  }
  if (primary.status === 401) {
    cachedToken = null; // token expired/invalid — drop it so next call re-auths
    return json({ error: "Rail feed rejected the token." }, 502);
  }
  if (!primary.ok) {
    return json({ error: `Rail feed error (${primary.status}).` }, 502);
  }
  const data = await primary.json();

  // Second board, anchored at `to`, to read each train's time AT the target
  // station. Merged by service id -> journey time (and long-way detection).
  // One extra call per refresh, not per train.
  const targetTimes = await fetchTargetTimes(accessToken, to, from);

  const services = (data.services || [])
    .map((s) => normalise(s, to, targetTimes))
    .filter((s) => s && s.std)
    .slice(0, 12);

  return json(
    { from, to, generatedAt: new Date().toISOString(), services },
    200,
    { "cache-control": "public, max-age=20, s-maxage=20" }
  );
}

/* Map serviceId -> ISO time at the target station (arrival preferred). */
async function fetchTargetTimes(accessToken, target, origin) {
  const map = {};
  try {
    const r = await fetch(`${BASE}/rtt/location?code=${NS}:${target}&filterFrom=${NS}:${origin}`,
      { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok || r.status === 204) return map;
    const d = await r.json();
    for (const s of d.services || []) {
      const uid = s.scheduleMetadata && s.scheduleMetadata.uniqueIdentity;
      const t = s.temporalData || {};
      const arr = t.arrival || {};
      const dep = t.departure || {};
      const iso = arr.realtimeForecast || arr.scheduleAdvertised || arr.realtimeActual
        || dep.realtimeForecast || dep.scheduleAdvertised || dep.realtimeActual;
      if (uid && iso) map[uid] = iso;
    }
  } catch (e) { /* journey time simply omitted if this fails */ }
  return map;
}

/* ---- Auth: refresh token -> short-life access token (cached) ---- */
async function getAccessToken(refreshToken) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresMs - 30000 > now) {
    return cachedToken.token;
  }
  const r = await fetch(`${BASE}/api/get_access_token`, {
    headers: { Authorization: `Bearer ${refreshToken}` },
  });
  if (!r.ok) {
    // Token may already be a direct access token — use it as-is.
    cachedToken = { token: refreshToken, expiresMs: now + 60000 };
    return refreshToken;
  }
  const body = await r.json();
  const token = body.token || refreshToken;
  const expiresMs = body.validUntil ? Date.parse(body.validUntil) : now + 5 * 60000;
  cachedToken = { token, expiresMs };
  return token;
}

/* ---- Map one next-gen line-up object into the front-end shape ---- */
function normalise(s, to, targetTimes) {
  const t = s.temporalData || {};
  const dep = t.departure || {};
  const meta = s.locationMetadata || {};
  const sched = s.scheduleMetadata || {};

  const bookedIso = dep.scheduleAdvertised || dep.realtimeForecast || dep.realtimeActual;
  if (!bookedIso) return null;

  // Expected departure: actual if it has gone, otherwise the live forecast.
  const expectedIso = dep.realtimeActual || dep.realtimeForecast || null;

  // Lateness = expected minus booked, in minutes. Comparing the two timestamps
  // is timezone-proof (both shift the same way), and unlike the feed's
  // "lateness" field this works BEFORE the train has departed too.
  let lateMins = 0;
  if (expectedIso && bookedIso) {
    const d = Math.round((Date.parse(expectedIso) - Date.parse(bookedIso)) / 60000);
    if (!Number.isNaN(d)) lateMins = d;
  }

  const cancelled = dep.isCancelled === true || t.displayAs === "CANCELLED" || t.displayAs === "DIVERTED";

  let status = "ontime";
  let etd = null;
  if (cancelled) {
    status = "cancel";
  } else if (lateMins >= 1 && expectedIso) {
    status = "late";
    etd = hhmm(expectedIso);
  }

  const platform = meta.platform ? meta.platform.actual || meta.platform.planned || null : null;
  const destLoc = s.destination && s.destination[0];
  const dest = (destLoc && destLoc.location && destLoc.location.description) || "—";
  const operator = (sched.operator && sched.operator.name) || "South Western Railway";
  const mode = sched.modeType || "TRAIN";

  // Journey length from this station to the TARGET station (Waterloo/your
  // chosen stop for To London; New Malden for Home), using the merged time.
  let journeyMins = null;
  const uid = sched.uniqueIdentity;
  const targetIso = uid && targetTimes ? targetTimes[uid] : null;
  if (targetIso && bookedIso) {
    const d = Math.round((Date.parse(targetIso) - Date.parse(bookedIso)) / 60000);
    if (!Number.isNaN(d) && d > 0) journeyMins = d;
  }

  return {
    id: uid || `${hhmm(bookedIso)}-${dest}`,
    std: hhmm(bookedIso),
    etd,
    status,
    departed: !!dep.realtimeActual, // has it actually left this station yet?
    journeyMins,
    platform,
    destination: dest,
    via: to === "NEM" ? "calls New Malden" : (mode !== "TRAIN" ? "rail replacement" : ""),
    operator,
    isBus: mode !== "TRAIN",
  };
}

/* Read the published "HH:MM" straight from the RTT timestamp.
   RTT gives railway (UK local) wall-clock times, so we do NOT timezone-
   convert here — the user's device (already on UK time) anchors the
   countdown. Converting on Cloudflare's UTC servers added a spurious
   hour during British Summer Time. */
function hhmm(iso) {
  const m = typeof iso === "string" && iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
