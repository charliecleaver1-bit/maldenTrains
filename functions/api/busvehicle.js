/**
 * GET /api/busvehicle?vehicle=LJ13CKA&line=131&stop=490009876W
 *
 * Where a specific bus actually is, right now.
 *
 * How it works — and what it can and can't tell us:
 *   TfL predicts arrivals PER VEHICLE. A stop stays in that vehicle's
 *   prediction list until the bus passes it, then drops out. So:
 *
 *     - stops still predicted  -> ahead of the bus
 *     - stops NOT predicted    -> the bus is past them
 *     - first predicted stop   -> where it's heading next
 *
 *   That's grounded in TfL's live vehicle tracking, NOT in comparing a
 *   timetable to the clock. A bus cannot appear to move unless TfL's own
 *   tracking says it has.
 *
 *   What we do NOT get: actual departure times. TfL publishes predictions
 *   only, so we never claim "left at 20:47" — the times are forecasts.
 *   The prediction window is also ~30 minutes, so stops beyond that have no
 *   live time and are marked as such rather than guessed at.
 *
 * Debug: ?debug=1 -> the raw vehicle predictions and the route sequence.
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const vehicle = (url.searchParams.get("vehicle") || "").trim();
  const line = (url.searchParams.get("line") || "").trim();
  const stop = (url.searchParams.get("stop") || "").trim();   // the user's stop
  const debug = url.searchParams.get("debug");

  if (!vehicle || !line) return json({ error: "Need vehicle and line." }, 400);

  const [preds, seq] = await Promise.all([
    getJson(`https://api.tfl.gov.uk/Vehicle/${encodeURIComponent(vehicle)}/Arrivals` + keyQS(env), env),
    routeSequence(env, line),
  ]);

  if (debug) return json({ debug: "busvehicle", vehicle, line, preds, seqCount: (seq || []).length, seq });

  if (!Array.isArray(preds) || !preds.length) {
    return json({ tracked: false, reason: "TfL isn't predicting this vehicle right now." });
  }

  // Only this line's predictions (a vehicle can be reassigned).
  const mine = preds
    .filter((p) => String(p.lineId || "").toLowerCase() === line.toLowerCase())
    .sort((a, b) => (a.timeToStation || 0) - (b.timeToStation || 0));

  if (!mine.length) return json({ tracked: false, reason: "No predictions for this bus on this route." });

  const destination = mine[mine.length - 1].destinationName || mine[0].towards || null;
  const aheadIds = mine.map((p) => p.naptanId);
  const aheadSet = new Set(aheadIds);

  // Where does the bus sit on the route? Everything before the first predicted
  // stop has been passed.
  let stops;
  if (seq && seq.length) {
    const firstAhead = seq.findIndex((s) => aheadSet.has(s.id));
    stops = seq.map((s, i) => {
      const pred = mine.find((p) => p.naptanId === s.id);
      const passed = firstAhead >= 0 ? i < firstAhead : false;
      return {
        id: s.id,
        name: s.name,
        passed,
        next: firstAhead >= 0 && i === firstAhead,
        you: stop ? s.id === stop : false,
        // A live prediction, or nothing at all beyond TfL's ~30 min horizon.
        eta: pred ? hhmm(new Date(Date.now() + (pred.timeToStation || 0) * 1000)) : null,
        mins: pred ? Math.max(0, Math.round((pred.timeToStation || 0) / 60)) : null,
        beyondWindow: !passed && !pred,
      };
    });
  } else {
    // No route sequence — fall back to just the stops still ahead.
    stops = mine.map((p, i) => ({
      id: p.naptanId,
      name: cleanName(p.stationName),
      passed: false,
      next: i === 0,
      you: stop ? p.naptanId === stop : false,
      eta: hhmm(new Date(Date.now() + (p.timeToStation || 0) * 1000)),
      mins: Math.max(0, Math.round((p.timeToStation || 0) / 60)),
      beyondWindow: false,
    }));
  }

  const nextIdx = stops.findIndex((s) => s.next);
  const lastPassed = nextIdx > 0 ? stops[nextIdx - 1] : null;

  return json(
    {
      tracked: true,
      vehicle,
      line,
      destination: cleanName(destination),
      caption: lastPassed
        ? `Left ${lastPassed.name} · approaching ${stops[nextIdx].name}`
        : (nextIdx >= 0 ? `Approaching ${stops[nextIdx].name}` : "In service"),
      stops,
    },
    200,
    { "cache-control": "public, max-age=15, s-maxage=15" }
  );
}

/* The ordered stop list for a bus route. Cached hard — it barely changes. */
const seqCache = new Map();
async function routeSequence(env, line) {
  if (seqCache.has(line)) return seqCache.get(line);

  const cacheKey = new Request(`https://bus-seq.local/${line}`);
  const cache = caches.default;
  try {
    const hit = await cache.match(cacheKey);
    if (hit) { const v = await hit.json(); seqCache.set(line, v); return v; }
  } catch (e) { /* miss */ }

  let out = [];
  try {
    // "outbound" and "inbound" both exist; we merge and dedupe, since we only
    // need the ordering that contains the predicted stops.
    for (const dir of ["outbound", "inbound"]) {
      const d = await getJson(
        `https://api.tfl.gov.uk/Line/${encodeURIComponent(line)}/Route/Sequence/${dir}` +
        `?serviceTypes=Regular&excludeCrowding=true` + keyQS(env, true), env);
      const seqs = (d && d.stopPointSequences) || [];
      for (const sp of seqs) {
        const list = (sp.stopPoint || []).map((p) => ({
          id: p.id || p.stationId,
          name: cleanName(p.name || p.commonName),
        }));
        if (list.length > out.length) out = list;    // keep the longest run
      }
      if (out.length) break;
    }
    try {
      await cache.put(cacheKey, new Response(JSON.stringify(out), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
      }));
    } catch (e) { /* non-fatal */ }
  } catch (e) { /* no sequence -> we fall back above */ }

  seqCache.set(line, out);
  return out;
}

async function getJson(u, env) {
  try {
    const r = await fetch(u, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

function cleanName(n) {
  return String(n || "").replace(/ Bus Station$/i, "").replace(/ Underground Station$/i, "").trim() || null;
}

function hhmm(d) {
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/London" });
}

function keyQS(env, hasQuery) {
  if (!env.TFL_APP_KEY) return "";
  return (hasQuery ? "&" : "?") + `app_key=${encodeURIComponent(env.TFL_APP_KEY)}`;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
