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

  return json(buildProgress(d), 200, { "cache-control": "public, max-age=20, s-maxage=20" });
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

  // Darwin only sometimes publishes an ACTUAL time (at). For most calling
  // points you get a scheduled (st) and an estimated (et). So a stop counts as
  // "departed" if Darwin gave an actual time OR its best-known time is already
  // in the past — otherwise the train appears stuck at its origin.
  const nowMins = ukNowMins();

  const stops = raw.map((c) => {
    const sched = clock(c.st);
    const est = clock(c.et);
    const act = clock(c.at);
    const t = act || est || sched;
    const past = t !== null && minutesSince(t, nowMins) >= 0;
    return {
      name: c.name || c.locationName || "—",
      time: t,
      dep: t,
      arr: t,
      platform: c.platform || null,
      departed: !!act || past,
      arrived: !!act || past,
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
