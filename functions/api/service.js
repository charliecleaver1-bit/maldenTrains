/**
 * Cloudflare Pages Function — GET /api/service?id=<serviceID>
 * ----------------------------------------------------------
 * One train's full calling pattern + where it currently is, from Darwin LDBWS.
 *
 * Notes on Darwin vs the old RTT feed:
 *  - serviceID is only valid while the service is on a board (a few hours).
 *  - Darwin publishes no turnaround ("formed by") links, so the inbound train
 *    is INFERRED: a service that terminated at this train's origin, on the same
 *    platform, shortly before it departs. Flagged inferred:true.
 */

const BASE = "https://api1.raildata.org.uk/1010-service-details1_2/LDBWS/api/20220120";
const DEP_BASE = "https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120";
const ARR_BASE = "https://api1.raildata.org.uk/1010-live-arrival-board-arr/LDBWS/api/20220120";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing service id." }, 400);

  // Service Details is a separate RDM product. If it issued its own key, set
  // LDB_SVC_KEY; otherwise the departures key is used.
  const key = env.LDB_SVC_KEY || env.LDB_KEY;
  if (!key) return json({ error: "Live feed not configured." }, 503);

  let r, body;
  try {
    r = await fetch(`${BASE}/GetServiceDetails/${encodeURIComponent(id)}`,
      { headers: { "x-apikey": key, accept: "application/json" } });
    body = await r.text();
  } catch (e) {
    return json({ error: "Could not reach the rail data feed." }, 502);
  }

  if (!r.ok) {
    return json({
      error: `Service details unavailable (HTTP ${r.status}).`,
      hint: (r.status === 401 || r.status === 403)
        ? "Key not authorised for the Service Details product — check the subscription and whether it issued its own key (set LDB_SVC_KEY)."
        : (r.status === 404 ? "Service ID not found (Darwin IDs expire after a few hours)." : ""),
      detail: body.slice(0, 200),
    }, 502);
  }

  let d;
  try { d = JSON.parse(body); }
  catch (e) { return json({ error: "Service details were not JSON." }, 502); }

  const result = buildProgress(d);

  // Darwin publishes no turnaround links, so infer the train that forms this
  // one: whatever terminated at its origin, on the same platform, just before.
  try {
    const inbound = await inferInbound(env, d, result);
    if (inbound) result.inbound = inbound;
  } catch (e) { /* inference is best-effort — never break the panel */ }

  return json(result, 200, { "cache-control": "public, max-age=20, s-maxage=20" });
}

/* ---------- "Likely formed by" inference ---------- */
async function inferInbound(env, d, prog) {
  const depKey = env.LDB_KEY;
  const arrKey = env.LDB_ARR_KEY || env.LDB_KEY;
  const svcKey = env.LDB_SVC_KEY || env.LDB_KEY;
  if (!depKey || !arrKey) return null;

  const stops = prog.stops || [];
  if (stops.length < 2) return null;

  // The origin terminus and the time our train leaves it.
  const originName = stops[0].name;
  const originTime = stops[0].time;
  if (!originTime) return null;

  const originCrs = await crsForOrigin(d, originName);
  if (!originCrs) return null;

  // 1. What platform does our train leave the origin from?
  const depOffset = minsFromNowUK(originTime);
  const depBoard = await getJson(
    `${DEP_BASE}/GetDepBoardWithDetails/${originCrs}` +
    `?numRows=20&timeOffset=${clampOffset(depOffset - 10)}&timeWindow=30`, depKey);
  const ours = (depBoard && depBoard.trainServices || []).find(
    (s) => s.std === originTime && sameDest(s, prog.destination));
  const platform = ours && ours.platform ? String(ours.platform) : null;
  if (!platform) return null;                       // no platform, no honest inference

  // 2. What terminated on that platform shortly before we leave?
  //    IMPORTANT: anchor the arrivals window to OUR DEPARTURE TIME, not to
  //    "now" — a train leaving in 40 minutes is formed by an inbound that
  //    hasn't arrived yet, which a now-anchored window would never see.
  const offset = minsFromNowUK(originTime);         // + = in the future
  const arrBoard = await getJson(
    `${ARR_BASE}/GetArrBoardWithDetails/${originCrs}` +
    `?numRows=20&timeOffset=${clampOffset(offset - 40)}&timeWindow=45`, arrKey);
  const candidates = (arrBoard && arrBoard.trainServices || []).filter((s) => {
    if (!s.platform || String(s.platform) !== platform) return false;
    const sta = clock(s.eta) || clock(s.sta);
    if (!sta) return false;
    const gap = minsBetween(sta, originTime);        // arrival -> our departure
    return gap >= 2 && gap <= 35;                    // plausible turnaround
  });
  if (!candidates.length) return null;

  // The latest arrival before we leave is the one that becomes us.
  candidates.sort((a, b) => {
    const ta = clock(a.eta) || clock(a.sta), tb = clock(b.eta) || clock(b.sta);
    return minsBetween(tb, originTime) - minsBetween(ta, originTime);
  });
  const best = candidates[0];

  const sta = clock(best.sta);
  const eta = clock(best.eta) || sta;
  let lateMins = 0;
  if (sta && eta) lateMins = Math.max(0, minsBetween(sta, eta));

  // Its own stop list, for the mini timeline.
  let inStops = [];
  if (best.serviceID) {
    const det = await getJson(`${BASE}/GetServiceDetails/${encodeURIComponent(best.serviceID)}`, svcKey);
    if (det) inStops = buildProgress(det).stops;
  }

  return {
    id: best.serviceID || null,
    origin: (best.origin && best.origin[0] && best.origin[0].locationName) || "—",
    destination: originName,
    operator: best.operator || "",
    stops: inStops,
    lateMins,
    dueArr: sta,
    expectedArr: eta,
    platform,
    inferred: true,
  };
}

function sameDest(s, destName) {
  const d = s.destination && s.destination[0] && s.destination[0].locationName;
  return !destName || !d || d === destName;
}

/* Find the CRS of the service's origin. */
async function crsForOrigin(d, originName) {
  const prev = (d.previousCallingPoints && d.previousCallingPoints[0]
    && d.previousCallingPoints[0].callingPoint) || [];
  if (prev.length && prev[0].crs) return prev[0].crs;
  if (d.crs && d.locationName === originName) return d.crs;   // starts at this station
  return null;
}

/* How many minutes from now (UK time) is "HH:MM"? Positive = future. */
function minsFromNowUK(t) {
  if (!clock(t)) return 0;
  const now = ukNowMins();
  const m = (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));
  let d = m - now;
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}

/* LDBWS accepts a timeOffset between -120 and +119 minutes. */
function clampOffset(n) {
  return Math.max(-120, Math.min(119, Math.round(n)));
}

async function getJson(url, key) {
  try {
    const r = await fetch(url, { headers: { "x-apikey": key, accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

/* Minutes from time a to time b (both "HH:MM"), rolling over midnight. */
function minsBetween(a, b) {
  if (!clock(a) || !clock(b)) return NaN;
  const m = (t) => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));
  let dd = m(b) - m(a);
  if (dd < -720) dd += 1440;
  if (dd > 720) dd -= 1440;
  return dd;
}

/* Build the stop list + live position from a service-details response. */
function buildProgress(d) {
  const prev = flatten(d.previousCallingPoints);
  const next = flatten(d.subsequentCallingPoints);

  // This station sits between the two lists.
  const here = {
    name: d.locationName || "—",
    crs: d.crs || "",
    st: d.std || d.sta || null,
    et: d.etd || d.eta || null,
    at: d.atd || d.ata || null,
    platform: d.platform || null,
  };

  const raw = [...prev, here, ...next];

  // ARRIVING somewhere and DEPARTING it are different events. A train sitting
  // at the platform has an actual arrival (ata) but NO actual departure (atd) —
  // treating ata as "left" drags the marker a whole leg down the line.
  const anchorArrived = !!clock(d.ata);
  const anchorDeparted = !!clock(d.atd);
  const anchorIdx = prev.length;
  const nowMins = ukNowMins();

  // "On time" means the estimate EQUALS the schedule — resolve it, don't discard it.
  const estOf = (c) => clock(c.et) || (isOnTime(c.et) ? clock(c.st) : null);

  // Passed the anchor only with a real DEPARTURE, and only once its time is up.
  const leftAnchor = anchorDeparted && elapsed(estOf(here) || clock(d.etd), nowMins);

  const stops = raw.map((c, i) => {
    const sched = clock(c.st);
    const est = estOf(c);
    const act = clock(c.at);
    const t = act || est || sched;

    let departed, arrived;
    if (i < anchorIdx) {
      // Behind us on the route — still require the clock to agree.
      departed = !!act || elapsed(est || sched, nowMins);
      arrived = departed;
    } else if (i === anchorIdx) {
      departed = leftAnchor;
      arrived = anchorArrived || anchorDeparted;   // at the platform counts as arrived
    } else if (!leftAnchor) {
      departed = false;                            // hasn't left the anchor yet
      arrived = false;
    } else {
      departed = !!act || elapsed(est || sched, nowMins);
      arrived = departed;
    }

    return {
      name: c.name || c.locationName || "—",
      time: t,
      dep: t,
      arr: t,
      platform: c.platform || null,
      departed,
      arrived,
      hasLiveTime: !!act || !!est,
      status: null,
      cancelled: !!c.isCancelled,
    };
  });

  return {
    origin: stops.length ? stops[0].name : "—",
    destination: stops.length ? stops[stops.length - 1].name : "—",
    operator: d.operator || "",
    stops,
  };
}

/* LDBWS wraps calling points in an extra array layer. */
function flatten(cp) {
  if (!cp || !cp.length) return [];
  const list = cp[0] && cp[0].callingPoint ? cp[0].callingPoint : [];
  return list.map((c) => ({
    name: c.locationName, crs: c.crs, st: c.st, et: c.et, at: c.at,
    isCancelled: c.isCancelled,
  }));
}

/* Darwin times are strings: "12:34" | "On time" | "Delayed" | "Cancelled". */
function clock(v) {
  return (typeof v === "string" && /^\d{2}:\d{2}$/.test(v)) ? v : null;
}

/* "On time" is Darwin saying the estimate equals the schedule. */
function isOnTime(v) {
  return typeof v === "string" && /on\s*time/i.test(v);
}

/* Has "HH:MM" actually gone past yet? */
function elapsed(t, nowMins) {
  if (!clock(t)) return false;
  return minutesSince(t, nowMins) >= 0;
}

/* Minutes past midnight, UK local time (Darwin publishes railway wall-clock). */
function ukNowMins() {
  const s = new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London",
  });
  return (+s.slice(0, 2)) * 60 + (+s.slice(3, 5));
}

/* How many minutes ago was "HH:MM"? Negative = still to come.
   Rolls over midnight so a 23:55 stop isn't treated as 23 hours in the future. */
function minutesSince(t, nowMins) {
  const m = (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));
  let d = nowMins - m;
  if (d < -720) d += 1440;
  if (d > 720) d -= 1440;
  return d;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
