/**
 * GET /api/tube/plan?from=<naptanId>&to=<naptanId>
 *
 * Asks TfL's journey planner for tube routes, and returns them broken into
 * legs. For each leg we ALSO resolve which way round the line you're going
 * (inbound / outbound), by looking up the line's ordered route sequence and
 * checking which direction has your origin BEFORE your destination.
 *
 * That matters: a station's arrivals feed lists trains going BOTH ways, and
 * "towards <terminus>" isn't enough to tell them apart (a line can have several
 * termini in the same direction). Resolving the direction properly is the only
 * way to avoid showing someone a train going the wrong way.
 *
 * Debug:
 *   ?debug=1     -> the raw TfL journey payload
 *   ?debug=dir   -> how each leg's direction was resolved
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  const debug = url.searchParams.get("debug");

  if (!from || !to) return json({ error: "Need from and to station ids." }, 400);
  if (from === to) return json({ error: "Those are the same station." }, 400);

  const api = `https://api.tfl.gov.uk/Journey/JourneyResults/${encodeURIComponent(from)}/to/${encodeURIComponent(to)}` +
    `?mode=tube,elizabeth-line,dlr&timeIs=Departing&journeyPreference=LeastTime` + keyQS(env, true);

  let d;
  try {
    let r = await fetch(api, { headers: { accept: "application/json" } });

    // TfL rate-limits hard without an API key (~50 req/min PER IP, and
    // Cloudflare shares IPs). Back off once, then explain properly.
    if (r.status === 429) {
      await sleep(700);
      r = await fetch(api, { headers: { accept: "application/json" } });
    }
    if (r.status === 429) {
      return json({
        error: "TfL is rate-limiting us (429).",
        hint: env.TFL_APP_KEY
          ? "A key is set, but the limit was still hit — try again in a moment."
          : "No TFL_APP_KEY is set. Register a free key at api-portal.tfl.gov.uk and add it in Pages → Variables & Secrets (Production AND Preview).",
        hasKey: !!env.TFL_APP_KEY,
      }, 429);
    }
    if (!r.ok) {
      const body = await r.text();
      return json({ error: `TfL planner error (${r.status}).`, detail: body.slice(0, 200) }, 502);
    }
    d = await r.json();
  } catch (e) {
    return json({ error: "Could not reach TfL." }, 502);
  }

  if (debug === "1") return json({ debug: "plan", from, to, raw: d });

  // Each option costs direction lookups, so keep it lean — 2 is plenty
  // (fastest, plus one alternative).
  const journeys = (d.journeys || []).slice(0, 2);
  if (!journeys.length) return json({ options: [], note: "No tube route found between those stations." });

  const dbg = [];
  const options = [];

  for (const jr of journeys) {
    const legs = [];
    for (const leg of (jr.legs || [])) {
      const ro = (leg.routeOptions && leg.routeOptions[0]) || {};
      const lineId = (ro.lineIdentifier && ro.lineIdentifier.id) || null;
      if (!lineId) continue;                        // walking legs etc — skip

      const dep = leg.departurePoint || {};
      const arr = leg.arrivalPoint || {};
      const fromId = dep.naptanId || dep.icsId || null;
      const toId = arr.naptanId || arr.icsId || null;

      const dir = await resolveDirection(env, lineId, fromId, toId);
      if (debug === "dir") dbg.push({ line: lineId, from: dep.commonName, to: arr.commonName, resolved: dir });

      legs.push({
        line: lineId,
        lineName: (ro.name || lineId),
        from: cleanName(dep.commonName),
        fromId,
        to: cleanName(arr.commonName),
        toId,
        mins: Math.round(leg.duration || 0),
        direction: dir.direction,                   // "inbound" | "outbound" | null
        dirLabel: dir.label,                        // "Northbound" etc, when known
        towards: (ro.directions && ro.directions[0]) || cleanName(arr.commonName),
      });
    }
    if (!legs.length) continue;                     // walking-only journey

    options.push({
      mins: Math.round(jr.duration || 0),
      changes: Math.max(0, legs.length - 1),
      legs,
    });
  }

  if (debug === "dir") return json({ debug: "dir", resolved: dbg, options });

  return json({ from, to, options }, 200, { "cache-control": "public, max-age=60, s-maxage=60" });
}

/* ---------------------------------------------------------------
   Direction resolution.
   Fetch the line's ordered stop sequence in each direction and see
   which one visits `fromId` before `toId`.
   --------------------------------------------------------------- */
async function resolveDirection(env, lineId, fromId, toId) {
  if (!fromId || !toId) return { direction: null, label: null, why: "missing ids" };

  for (const direction of ["inbound", "outbound"]) {
    const seqs = await routeSequence(env, lineId, direction);
    for (const ids of seqs) {
      const a = ids.indexOf(base(fromId));
      const b = ids.indexOf(base(toId));
      if (a >= 0 && b >= 0 && a < b) {
        return { direction, label: labelFor(lineId, direction), why: `${direction}: ${a} -> ${b}` };
      }
    }
  }
  return { direction: null, label: null, why: "not found in either sequence" };
}

/* Route sequences barely change, but they're big and we need them on every
   plan. Without persistent caching we hammer TfL and get rate-limited (429).
   Two layers:
     1. in-memory  — free within one Worker isolate
     2. Cloudflare cache — survives isolates, so it actually holds
*/
const seqCache = new Map();

async function routeSequence(env, lineId, direction) {
  const key = `${lineId}:${direction}`;
  if (seqCache.has(key)) return seqCache.get(key);

  // Layer 2: the edge cache.
  const cacheKey = new Request(`https://tube-seq.local/${lineId}/${direction}`);
  const cache = caches.default;
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const out = await hit.json();
      seqCache.set(key, out);
      return out;
    }
  } catch (e) { /* cache miss is fine */ }

  const api = `https://api.tfl.gov.uk/Line/${encodeURIComponent(lineId)}/Route/Sequence/${direction}` +
    `?serviceTypes=Regular&excludeCrowding=true` + keyQS(env, true);

  let out = [];
  try {
    const r = await fetch(api, { headers: { accept: "application/json" } });
    if (r.ok) {
      const d = await r.json();
      out = (d.orderedLineRoutes || [])
        .map((o) => (o.naptanIds || []).map(base))
        .filter((a) => a.length > 1);
      if (!out.length) {
        out = (d.stopPointSequences || [])
          .map((sp) => (sp.stopPoint || []).map((p) => base(p.id || p.stationId)))
          .filter((a) => a.length > 1);
      }
      // Cache for a day — these are effectively static.
      try {
        await cache.put(cacheKey, new Response(JSON.stringify(out), {
          headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" },
        }));
      } catch (e) { /* non-fatal */ }
    }
  } catch (e) { /* leave empty — direction just stays unresolved */ }

  seqCache.set(key, out);
  return out;
}

/* Platform-level ids look like 940GZZLUWLO1; we want the station. */
function base(id) {
  return String(id || "").trim();
}

/* A friendly direction word. TfL's own arrivals carry the authoritative
   platform text, so this is only a fallback label. */
function labelFor(lineId, direction) {
  const NS = new Set(["northern", "victoria", "bakerloo", "piccadilly", "jubilee"]);
  if (NS.has(lineId)) return direction === "inbound" ? "Southbound" : "Northbound";
  return direction === "inbound" ? "Westbound" : "Eastbound";
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function cleanName(n) {
  return String(n || "").replace(/ Underground Station$/i, "").replace(/ Station$/i, "");
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
