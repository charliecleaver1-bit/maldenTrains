/**
 * Cloudflare Pages Function — GET /api/board?from=NEM&to=WAT
 * ----------------------------------------------------------
 * Departure board powered by Darwin LDBWS via the Rail Data Marketplace.
 * Darwin is free for commercial use (with National Rail attribution), unlike
 * the Realtime Trains personal feed this replaces.
 *
 * Needs LDB_KEY (your RDM *consumer key*) in Pages → Variables & Secrets.
 *
 * The detailed board inlines each service's calling points, so journey time to
 * the target station comes from the SAME call — no second board, no ID matching.
 */

const BASE = "https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120";
const CRS = /^[A-Z]{3}$/;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = (url.searchParams.get("from") || "NEM").toUpperCase();
  const to = (url.searchParams.get("to") || "WAT").toUpperCase();

  // Any valid 3-letter CRS pair is allowed — journeys are user-defined now.
  if (!CRS.test(from) || !CRS.test(to) || from === to) {
    return json({ error: "Invalid station codes." }, 400);
  }
  if (!env.LDB_KEY) {
    return json({ error: "Live feed not configured. Add LDB_KEY in Pages settings." }, 503);
  }

  const q = `${BASE}/GetDepBoardWithDetails/${from}` +
    `?numRows=10&filterCrs=${to}&filterType=to&timeOffset=0&timeWindow=120`;

  let d;
  try {
    const r = await fetch(q, { headers: { "x-apikey": env.LDB_KEY, accept: "application/json" } });
    if (r.status === 401 || r.status === 403) return json({ error: "Rail feed rejected the key." }, 502);
    if (!r.ok) return json({ error: `Rail feed error (${r.status}).` }, 502);
    d = await r.json();
  } catch (e) {
    return json({ error: "Could not reach the rail data feed." }, 502);
  }

  const services = (d.trainServices || [])
    .map((s) => normalise(s, to))
    .filter(Boolean)
    // Darwin's "to" filter also returns trains you'd have to change off (e.g.
    // Richmond services). Keep only ones that actually call at the target.
    .filter((s) => s.journeyMins !== null)
    .slice(0, 12);

  // /api/board?from=X&to=Y&debug=platform — what is Darwin actually sending?
  if (url.searchParams.get("debug") === "platform") {
    return json({
      debug: "platform",
      from, to,
      locationName: d.locationName,
      platformAvailable: d.platformAvailable,   // Darwin's own "do we publish platforms here" flag
      raw: (d.trainServices || []).slice(0, 10).map((s) => ({
        std: s.std,
        dest: s.destination && s.destination[0] && s.destination[0].locationName,
        platform: s.platform === undefined ? "(absent)" : s.platform,
        typeofPlatform: typeof s.platform,
      })),
      afterNormalise: services.map((s) => ({ std: s.std, platform: s.platform })),
    });
  }

  // National Rail disruption messages — free with Darwin, unlike RTT.
  const messages = (d.nrccMessages || [])
    .map((m) => String(m.value || m._ || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  return json(
    { from, to, generatedAt: new Date().toISOString(), services, messages },
    200,
    { "cache-control": "public, max-age=20, s-maxage=20" }
  );
}

/* Map one LDBWS service into the shape the front-end already expects. */
function normalise(s, to) {
  const std = s.std || null;                       // "12:10"
  if (!std) return null;

  const calls = (s.subsequentCallingPoints && s.subsequentCallingPoints[0]
    && s.subsequentCallingPoints[0].callingPoint) || [];
  const target = calls.find((c) => (c.crs || "").toUpperCase() === to);

  // Journey time to the target station, straight from the inlined calling points.
  let journeyMins = null;
  if (target) {
    const arr = pickTime(target.at, target.et, target.st);
    const dep = pickTime(null, s.etd, s.std);
    const mins = diffMins(dep, arr);
    if (mins !== null && mins > 0) journeyMins = mins;
  }

  // Status. Darwin's etd is a string: "On time" | "12:34" | "Delayed" | "Cancelled".
  const cancelled = !!s.isCancelled || isWord(s.etd, "cancelled");
  let status = "ontime";
  let etd = null;
  if (cancelled) {
    status = "cancel";
  } else if (isClock(s.etd) && s.etd !== std) {
    status = "late";
    etd = s.etd;
  } else if (isWord(s.etd, "delayed")) {
    status = "late";                                // delayed, no estimate yet
  }

  const dest = (s.destination && s.destination[0] && s.destination[0].locationName) || "—";

  return {
    id: s.serviceID || `${std}-${dest}`,
    std,
    etd,
    status,
    departed: false,                                // Darwin drops departed trains from the board
    journeyMins,
    platform: s.platform || null,
    destination: dest,
    via: "",
    operator: s.operator || "South Western Railway",
    isBus: s.serviceType && s.serviceType !== "train",
    isCircular: !!s.isCircularRoute,                // the Kingston-loop flag
    delayReason: tidyReason(s.delayReason),
    cancelReason: tidyReason(s.cancelReason),
    coaches: coachCount(s.length),                  // formation length
    detachFront: !!s.detachFront,                   // front portion splits off
    reverseFormation: !!s.isReverseFormation,
    futureDelay: !!s.futureDelay,                   // Darwin expects trouble later
    futureCancellation: !!s.futureCancellation,
  };
}

/* Darwin sends length as a number or a numeric string; 0 means "unknown". */
function coachCount(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* Darwin's reasons are full sentences, often with trailing whitespace and the
   odd double space. Keep the wording — just tidy it. */
function tidyReason(r) {
  if (!r) return null;
  const s = String(r).replace(/\s+/g, " ").trim();
  return s || null;
}

/* First usable clock value from actual > estimated > scheduled. */
function pickTime(at, et, st) {
  for (const v of [at, et, st]) if (isClock(v)) return v;
  return null;
}
function isClock(v) { return typeof v === "string" && /^\d{2}:\d{2}$/.test(v); }
function isWord(v, w) { return typeof v === "string" && v.toLowerCase().includes(w); }

/* Minutes between two "HH:MM" wall-clock times, rolling over midnight. */
function diffMins(a, b) {
  if (!isClock(a) || !isClock(b)) return null;
  const m = (t) => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));
  let d = m(b) - m(a);
  if (d < -720) d += 1440;                          // crossed midnight
  return d;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
