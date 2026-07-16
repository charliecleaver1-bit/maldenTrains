/**
 * GET /api/hsp?from=NBT&to=WAT&std=0712
 *
 * Historic reliability for a specific scheduled service, from National Rail's
 * HSP (Historic Service Performance) feed. Answers "how often does the 07:12
 * actually run on time?" using up to ~3 months of past weekday data.
 *
 * WHY A SERVER FUNCTION: HSP is POST-only, needs HTTP Basic auth, and sends no
 * CORS headers — so it can't be called from the browser. It also uses your
 * National Rail Data Portal login (NOT the RDM consumer key the live board
 * uses). Set these as Cloudflare env vars:
 *     HSP_USER  — your portal email
 *     HSP_PASS  — your portal password
 * and tick the "HSP" subscription box on the portal.
 *
 * WHAT IT REPORTS: on-time and within-5/10-minute rates plus the SAMPLE SIZE,
 * straight from serviceMetrics. We deliberately don't claim a cancellation
 * stat here — serviceMetrics gives punctuality tolerances, not cancellations,
 * so reporting one would mean over-claiming. Sample size is always returned so
 * the figure can be shown honestly (10 days is weaker evidence than 60).
 *
 * Debug: ?debug=1 -> the request we sent and HSP's raw response.
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = (url.searchParams.get("from") || "").trim().toUpperCase();
  const to = (url.searchParams.get("to") || "").trim().toUpperCase();
  const std = (url.searchParams.get("std") || "").replace(":", "").trim();  // "0712"
  const debug = url.searchParams.get("debug");

  if (!from || !to) return json({ error: "Need from and to CRS codes." }, 400);
  if (!env.HSP_USER || !env.HSP_PASS) {
    return json({ available: false, reason: "HSP not configured (no HSP_USER / HSP_PASS)." }, 200);
  }

  // Edge-cache: a service's historic reliability barely moves day to day, and
  // HSP is slow/rate-limited, so cache hard.
  const cacheKey = new Request(`https://hsp.local/${from}/${to}/${std || "all"}`);
  const cache = caches.default;
  if (!debug) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch (e) { /* miss */ }
  }

  const { fromDate, toDate } = window3Months();

  // A tight time window around the chosen departure keeps HSP fast (wide
  // windows time out with a 502). If no std given, cover the day.
  const [ft, tt] = std ? tightWindow(std) : ["0000", "2359"];

  const body = {
    from_loc: from, to_loc: to,
    from_time: ft, to_time: tt,
    from_date: fromDate, to_date: toDate,
    days: "WEEKDAY",
  };

  let raw;
  try {
    const auth = "Basic " + btoa(`${env.HSP_USER}:${env.HSP_PASS}`);
    const r = await fetch("https://hsp-prod.rockshore.net/api/v1/serviceMetrics", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth },
      body: JSON.stringify(body),
    });
    if (r.status === 401) return json({ available: false, reason: "HSP auth failed — check credentials and that the HSP box is ticked on the portal." }, 200);
    if (r.status === 502 || r.status === 504) return json({ available: false, reason: "HSP timed out (window too wide)." }, 200);
    if (!r.ok) return json({ available: false, reason: `HSP error ${r.status}.` }, 200);
    raw = await r.json();
  } catch (e) {
    return json({ available: false, reason: "Couldn't reach HSP." }, 200);
  }

  if (debug) return json({ debug: "hsp", sent: body, raw });

  const services = (raw.Services || []).map(summarise).filter(Boolean);

  // Pick the service matching the requested departure, else the whole list.
  let picked = null;
  if (std) picked = services.find((s) => s.stdRaw === std) || null;

  const payload = {
    available: true,
    from, to,
    periodFrom: fromDate, periodTo: toDate,
    service: picked,          // the matched one, if std was given
    services,                 // all in the window (small, since window is tight)
  };

  const res = json(payload, 200, { "cache-control": "public, max-age=86400, s-maxage=86400" });
  if (!debug) { try { await cache.put(cacheKey, res.clone()); } catch (e) {} }
  return res;
}

/* One service's reliability, from its tolerance buckets. */
function summarise(svc) {
  const a = svc.serviceAttributesMetrics || {};
  const metrics = svc.Metrics || [];
  if (!metrics.length) return null;

  const byTol = {};
  for (const m of metrics) byTol[String(m.tolerance_value)] = m;

  const base = byTol["0"] || metrics[0];
  const total = base ? (int(base.num_tolerance) + int(base.num_not_tolerance)) : 0;
  if (!total) return null;

  const pct = (tol) => {
    const m = byTol[String(tol)];
    return m ? Math.round(parseFloat(m.percent_tolerance)) : null;
  };

  return {
    stdRaw: a.gbtt_ptd || "",
    std: hhmm(a.gbtt_ptd),
    sta: hhmm(a.gbtt_pta),
    toc: a.toc_code || null,
    sample: total,               // number of past trains this is based on
    onTimePct: pct(0),           // exactly on time (to the minute)
    within5Pct: pct(5),
    within10Pct: pct(10),
  };
}

/* HSP wants a fairly narrow window or it times out. ±8 min around the
   scheduled departure catches the right service without pulling the day. */
function tightWindow(std) {
  const h = parseInt(std.slice(0, 2), 10);
  const m = parseInt(std.slice(2), 10);
  const start = clamp(h * 60 + m - 8);
  const end = clamp(h * 60 + m + 8);
  return [toHHMM(start), toHHMM(end)];
}
function clamp(mins) { return Math.max(0, Math.min(1439, mins)); }
function toHHMM(mins) {
  return String(Math.floor(mins / 60)).padStart(2, "0") + String(mins % 60).padStart(2, "0");
}

/* A ~3-month window ending a couple of days ago (today's data isn't in HSP). */
function window3Months() {
  const end = new Date(Date.now() - 2 * 86400000);
  const start = new Date(end.getTime() - 90 * 86400000);
  return { fromDate: iso(start), toDate: iso(end) };
}
function iso(d) { return d.toISOString().slice(0, 10); }

function hhmm(t) {
  if (!t || t.length !== 4) return t || "";
  return t.slice(0, 2) + ":" + t.slice(2);
}
function int(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
