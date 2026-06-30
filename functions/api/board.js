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
const ALLOWED = new Set(["NEM", "WAT"]); // lock the proxy to your two stations

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

  const query = `${BASE}/rtt/location?code=${NS}:${from}&filterTo=${NS}:${to}`;
  let upstream;
  try {
    upstream = await fetch(query, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    return json({ error: "Could not reach the rail data feed." }, 502);
  }

  if (upstream.status === 204) {
    return json({ from, to, generatedAt: new Date().toISOString(), services: [] });
  }
  if (upstream.status === 401) {
    cachedToken = null; // token expired/invalid — drop it so next call re-auths
    return json({ error: "Rail feed rejected the token." }, 502);
  }
  if (!upstream.ok) {
    return json({ error: `Rail feed error (${upstream.status}).` }, 502);
  }

  const data = await upstream.json();
  const services = (data.services || [])
    .map((s) => normalise(s, to))
    .filter((s) => s && s.std)
    .slice(0, 12);

  return json(
    { from, to, generatedAt: new Date().toISOString(), services },
    200,
    { "cache-control": "public, max-age=20, s-maxage=20" }
  );
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
function normalise(s, to) {
  const t = s.temporalData || {};
  const dep = t.departure || {};
  const meta = s.locationMetadata || {};
  const sched = s.scheduleMetadata || {};

  const bookedIso = dep.scheduleAdvertised || dep.realtimeForecast || dep.realtimeActual;
  if (!bookedIso) return null;

  const expectedIso = dep.realtimeActual || dep.realtimeForecast || null;
  const lateMins = typeof dep.realtimeAdvertisedLateness === "number" ? dep.realtimeAdvertisedLateness : 0;

  const cancelled = dep.isCancelled === true || t.displayAs === "CANCELLED" || t.displayAs === "DIVERTED";

  let status = "ontime";
  let etd = null;
  if (cancelled) {
    status = "cancel";
  } else if (expectedIso && lateMins >= 1) {
    status = "late";
    etd = hhmm(expectedIso);
  }

  const platform = meta.platform ? meta.platform.actual || meta.platform.planned || null : null;
  const dest = (s.destination && s.destination[0] && s.destination[0].location && s.destination[0].location.description) || "—";
  const operator = (sched.operator && sched.operator.name) || "South Western Railway";
  const mode = sched.modeType || "TRAIN";

  return {
    id: sched.uniqueIdentity || `${hhmm(bookedIso)}-${dest}`,
    std: hhmm(bookedIso),
    etd,
    depMs: Date.parse(bookedIso), // exact scheduled time for an accurate countdown
    status,
    platform,
    destination: dest,
    via: to === "NEM" ? "calls New Malden" : (mode !== "TRAIN" ? "rail replacement" : ""),
    operator,
    isBus: mode !== "TRAIN",
  };
}

/* ISO datetime -> "HH:MM" in UK local time */
function hhmm(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London",
    });
  } catch (e) {
    return null;
  }
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
