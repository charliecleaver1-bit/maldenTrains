/**
 * Cloudflare Pages Function — GET /api/board?from=NEM&to=WAT
 * ----------------------------------------------------------
 * Keeps your Realtime Trains credentials server-side (the RTT
 * terms require the token is never shipped in client code) and
 * returns a clean, small JSON shape the front-end understands.
 *
 * Set these in  Cloudflare Pages → Settings → Variables & Secrets:
 *   RTT_USER  = your rttapi_ username
 *   RTT_PASS  = your API password
 * Get them free (personal use) at  https://api.rtt.io  /  https://api-portal.rtt.io
 *
 * NOTE: this targets the current api.rtt.io v1 endpoint (basic auth),
 * which works today. RTT is migrating to api-portal.rtt.io (Bearer
 * token) and api.rtt.io is scheduled to switch off on 30 Sep 2026 —
 * see the swap-over block lower down when you move across.
 */

const ALLOWED = new Set(["NEM", "WAT"]); // lock the proxy to your two stations

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = (url.searchParams.get("from") || "NEM").toUpperCase();
  const to   = (url.searchParams.get("to")   || "WAT").toUpperCase();

  if (!ALLOWED.has(from) || !ALLOWED.has(to)) {
    return json({ error: "Unsupported station." }, 400);
  }
  if (!env.RTT_USER || !env.RTT_PASS) {
    return json({ error: "Live feed not configured. Set RTT_USER and RTT_PASS in Pages settings." }, 503);
  }

  const auth = "Basic " + btoa(`${env.RTT_USER}:${env.RTT_PASS}`);
  const rttUrl = `https://api.rtt.io/api/v1/json/search/${from}/to/${to}`;

  // ---- Swapping to the next-gen API later? Use this instead: ----
  // const rttUrl = `https://api.rtt.io/api/v2/json/search/${from}/to/${to}`;
  // const headers = { Authorization: `Bearer ${env.RTT_TOKEN}` };
  // ---------------------------------------------------------------

  let upstream;
  try {
    upstream = await fetch(rttUrl, { headers: { Authorization: auth } });
  } catch (e) {
    return json({ error: "Could not reach the rail data feed." }, 502);
  }
  if (!upstream.ok) {
    return json({ error: `Rail feed error (${upstream.status}).` }, 502);
  }

  const data = await upstream.json();
  const services = (data.services || [])
    .filter((s) => s && s.locationDetail)
    .map((s) => normalise(s, to))
    .filter((s) => s.std)
    .slice(0, 12);

  return json(
    { from, to, generatedAt: new Date().toISOString(), services },
    200,
    { "cache-control": "public, max-age=20, s-maxage=20" }
  );
}

/** Map one RTT service into the front-end's compact shape. */
function normalise(s, to) {
  const ld = s.locationDetail;
  const std = fmt(ld.gbttBookedDeparture);
  const rt  = fmt(ld.realtimeDeparture);

  let status = "ontime";
  let etd = null;
  const cancelled = ld.displayAs === "CANCELLED_CALL" || ld.cancelReasonShortText;
  if (cancelled) {
    status = "cancel";
  } else if (rt && rt !== std) {
    status = "late";
    etd = rt;
  }

  const dest = (ld.destination && ld.destination[0] && ld.destination[0].description) || "—";

  return {
    id: s.serviceUid ? `${s.serviceUid}-${s.runDate || ""}` : `${std}-${dest}`,
    std,
    etd,
    status,
    platform: ld.platform || null,
    destination: dest,
    via: to === "NEM" ? "calls New Malden" : "",
    operator: s.atocName || "South Western Railway",
    isBus: s.serviceType === "bus",
  };
}

/** "0842" -> "08:42" */
function fmt(t) {
  if (!t || t.length < 4) return null;
  return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
