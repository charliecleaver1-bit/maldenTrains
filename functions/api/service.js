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

const BASE = "https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing service id." }, 400);
  if (!env.LDB_KEY) return json({ error: "Live feed not configured." }, 503);

  const svc = await getService(env.LDB_KEY, id);
  if (!svc) return json({ error: "Service not found." }, 404);

  return json(buildProgress(svc), 200, { "cache-control": "public, max-age=20, s-maxage=20" });
}

async function getService(key, id) {
  try {
    const r = await fetch(`${BASE}/GetServiceDetails/${encodeURIComponent(id)}`,
      { headers: { "x-apikey": key, accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
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
  const stops = raw.map((c) => {
    const sched = clock(c.st);
    const est = clock(c.et);
    const act = clock(c.at);
    const t = act || est || sched;
    return {
      name: c.name || c.locationName || "—",
      time: t,
      dep: t,
      arr: t,
      platform: c.platform || null,
      departed: !!act,                              // Darwin gives an actual time once passed
      arrived: !!act,
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

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
