/**
 * Cloudflare Pages Function — GET /api/service?id=<uniqueIdentity>
 * --------------------------------------------------------------
 * Returns one train's full calling pattern + current position. For a train
 * that ORIGINATES at a terminus (e.g. a Home service starting at Waterloo),
 * it also follows the "FORM_FROM" association to the inbound train that
 * physically becomes it, and reports that inbound train's delay + position —
 * so you can see a departure will slip before the feed admits it.
 * Called lazily (only when the journey panel is open).
 */

const BASE = "https://data.rtt.io";

// Own access-token cache for this function (refresh -> short-life access).
let cachedToken = null;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug");
  const id = url.searchParams.get("id");
  if (!debug && !id) return json({ error: "Missing service id." }, 400);
  if (!env.RTT_TOKEN) return json({ error: "Live feed not configured." }, 503);

  let accessToken;
  try {
    accessToken = await getAccessToken(env.RTT_TOKEN);
  } catch (e) {
    return json({ error: "Could not authenticate with the rail feed." }, 502);
  }

  // Diagnostic: /api/service?debug=1&from=WAT&to=NEM
  // Picks a TERMINATING train (not a loop) and probes the detailed flag three
  // ways, so we can see whether the feed exposes FORM_FROM turnaround links.
  if (debug) {
    const from = (url.searchParams.get("from") || "WAT").toUpperCase();
    const to = (url.searchParams.get("to") || "NEM").toUpperCase();

    // Diagnostic: /api/service?debug=journey&from=NEM&to=WAT
    // Shows, per board train, whether the far-end time was matched and what
    // journeyMins comes out — so we can see why the >40min filter isn't biting.
    if (debug === "journey") {
      const grab = async (u) => { try { const r = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}` } }); return r.ok ? await r.json() : { __status: r.status }; } catch (e) { return { __err: String(e) }; } };
      const pd = await grab(`${BASE}/rtt/location?code=gb-nr:${from}&filterTo=gb-nr:${to}`);
      const pservices = pd.services || [];
      let minIso = null, maxIso = null;
      for (const s of pservices) {
        const dep = (s.temporalData || {}).departure || {};
        const iso = dep.scheduleAdvertised || dep.realtimeForecast;
        if (!iso) continue;
        if (!minIso || iso < minIso) minIso = iso;
        if (!maxIso || iso > maxIso) maxIso = iso;
      }
      let tqs = `code=gb-nr:${to}&filterFrom=gb-nr:${from}`;
      if (minIso) tqs += `&timeFrom=${encodeURIComponent(shiftLocalIso(minIso, -10))}`;
      if (maxIso) tqs += `&timeTo=${encodeURIComponent(shiftLocalIso(maxIso, 100))}`;
      const td = await grab(`${BASE}/rtt/location?${tqs}`);
      const tmap = {};
      for (const s of (td.services || [])) {
        const uid = s.scheduleMetadata && s.scheduleMetadata.uniqueIdentity;
        const t = s.temporalData || {}; const arr = t.arrival || {}; const dep = t.departure || {};
        const iso = arr.realtimeForecast || arr.scheduleAdvertised || arr.realtimeActual || dep.realtimeForecast || dep.scheduleAdvertised || dep.realtimeActual;
        if (uid && iso) tmap[uid] = iso;
      }
      const rows = pservices.slice(0, 12).map((s) => {
        const uid = s.scheduleMetadata && s.scheduleMetadata.uniqueIdentity;
        const dep = (s.temporalData || {}).departure || {};
        const bookedIso = dep.scheduleAdvertised || dep.realtimeForecast || dep.realtimeActual;
        let targetIso = tmap[uid], via = "matched";
        const destLoc = s.destination && s.destination[0];
        if (!targetIso) {
          const codes = (destLoc && destLoc.location && destLoc.location.shortCodes) || [];
          const dtd = destLoc && destLoc.temporalData;
          const diso = dtd && (dtd.realtimeForecast || dtd.scheduleAdvertised || dtd.realtimeActual);
          if (codes.indexOf(to) !== -1 && diso) { targetIso = diso; via = "terminus-fallback"; }
        }
        let jm = null;
        if (targetIso && bookedIso) { const d = Math.round((Date.parse(targetIso) - Date.parse(bookedIso)) / 60000); if (!Number.isNaN(d) && d > 0) jm = d; }
        return { dest: destLoc && destLoc.location && destLoc.location.description, via: jm ? via : "none", journeyMins: jm };
      });
      return json({ debug: "journey", from, to,
        primaryCount: pservices.length, targetCount: (td.services || []).length,
        targetMapSize: Object.keys(tmap).length, rows });
    }

    const forcedUid = url.searchParams.get("uid"); // optional: test this train directly
    const NAMES = { WAT:"London Waterloo", NEM:"New Malden", VXH:"Vauxhall", CLJ:"Clapham Junction", EAD:"Earlsfield", WIM:"Wimbledon" };

    let boardSample = [];
    let boardStatus = null;
    let pick = null;

    if (forcedUid) {
      pick = { uid: forcedUid, dest: "(forced)" };
    } else {
      try {
        const br = await fetch(`${BASE}/rtt/location?code=gb-nr:${from}&filterTo=gb-nr:${to}`,
          { headers: { Authorization: `Bearer ${accessToken}` } });
        boardStatus = br.status;
        const bd = br.ok ? await br.json() : {};
        const services = bd.services || [];
        boardSample = services.slice(0, 10).map((s) => ({
          uid: s.scheduleMetadata && s.scheduleMetadata.uniqueIdentity,
          dest: s.destination && s.destination[0] && s.destination[0].location && s.destination[0].location.description,
        }));
        const fromName = NAMES[from] || from;
        pick = boardSample.find((x) => x.uid && x.dest && x.dest !== fromName) || boardSample[0] || null;
      } catch (e) { return json({ debug: true, error: "board fetch failed" }); }
    }

    if (!pick || !pick.uid) {
      return json({ debug: true, from, to, boardStatus, boardSample,
        note: boardStatus === 200 ? "board returned no services (likely no trains at this hour) — try again during service hours, or pass &uid=<uniqueIdentity>"
            : `board HTTP ${boardStatus} (429 = rate limited, try in a minute)` });
    }

    const variants = {};
    const enc = encodeURIComponent;
    const parts = String(pick.uid).split(":");        // ["gb-nr","L82759","2026-07-01"]
    const identity = parts[1] || "";
    const depDate = parts[2] || "";
    const uidNoNs = parts.slice(1).join(":");          // "L82759:2026-07-01"
    const probeUrls = [
      ["rtt_detailed", `${BASE}/rtt/service?uniqueIdentity=${enc(pick.uid)}&detailed=true`],
      ["gbnr_iddate_detailed", `${BASE}/gb-nr/service?identity=${enc(identity)}&departureDate=${enc(depDate)}&detailed=true`],
      ["gbnr_iddate_plain", `${BASE}/gb-nr/service?identity=${enc(identity)}&departureDate=${enc(depDate)}`],
      ["gbnr_uid_nons", `${BASE}/gb-nr/service?uniqueIdentity=${enc(uidNoNs)}&detailed=true`],
    ];
    for (const [label, u] of probeUrls) {
      try {
        const r = await fetch(u, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!r.ok) { variants[label] = { status: r.status }; continue; }
        const d = await r.json();
        const svc2 = d.service || d;
        const locs = svc2.locations || [];
        let count = 0; const types = [];
        for (const l of locs) for (const a of (l.associatedServices || [])) { count++; types.push(a.associationData && a.associationData.associationType); }
        variants[label] = {
          origin: locs[0] && locs[0].location && locs[0].location.description,
          dest: locs[locs.length - 1] && locs[locs.length - 1].location && locs[locs.length - 1].location.description,
          assocCount: count, types,
          firstLocKeys: locs[0] ? Object.keys(locs[0]) : [],
        };
      } catch (e) { variants[label] = { error: String(e) }; }
    }
    return json({ debug: true, from, to, boardStatus, tested: pick, boardSample, variants });
  }

  const svc = await fetchService(accessToken, id);
  if (svc && svc.__error) return json({ error: svc.__error }, svc.__status || 502);
  if (!svc) return json({ error: "Service not found." }, 404);

  const result = buildProgress(svc);

  // Which inbound train forms this one at its origin terminus?
  // The gb-nr feed doesn't publish FORM associations, so if none is present
  // we INFER it: a train that terminated on the same platform shortly before.
  const inboundId = findFormedFrom(svc);
  if (inboundId) {
    const inbound = await fetchService(accessToken, inboundId);
    if (inbound && !inbound.__error) result.inbound = buildInbound(inbound);
  } else {
    const inferred = await inferInbound(accessToken, svc);
    if (inferred) result.inbound = inferred;
  }

  return json(result, 200, { "cache-control": "public, max-age=20, s-maxage=20" });
}

/* Infer the forming train: look at the origin terminus, find a service that
   TERMINATED there on the SAME platform a few minutes before this train
   departs. Turnarounds almost always reuse the platform, so it's a strong
   guess — flagged inferred:true so the UI can say "likely". */
async function inferInbound(accessToken, svc) {
  const locs = svc.locations || [];
  const origin = locs[0];
  if (!origin) return null;
  const term = origin.location && origin.location.shortCodes && origin.location.shortCodes[0];
  const odep = (origin.temporalData && origin.temporalData.departure) || {};
  const depIso = odep.realtimeForecast || odep.scheduleAdvertised || odep.realtimeActual;
  const opm = origin.locationMetadata && origin.locationMetadata.platform;
  const oplat = opm ? (opm.actual || opm.planned) : null;
  if (!term || !depIso || !oplat) return null;      // need a platform to infer
  const depMs = Date.parse(depIso);

  let bd;
  try {
    const r = await fetch(`${BASE}/rtt/location?code=gb-nr:${term}` +
      `&timeFrom=${encodeURIComponent(shiftLocalIso(depIso, -30))}` +
      `&timeTo=${encodeURIComponent(shiftLocalIso(depIso, 3))}`,
      { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return null;
    bd = await r.json();
  } catch (e) { return null; }

  let best = null, bestArrMs = -Infinity;
  for (const s of (bd.services || [])) {
    const t = s.temporalData || {};
    const arr = t.arrival, dep = t.departure;
    if (!arr) continue;                                        // must arrive here
    if (dep && (dep.scheduleAdvertised || dep.realtimeForecast || dep.realtimeActual)) continue; // must terminate
    const pm = s.locationMetadata && s.locationMetadata.platform;
    const plat = pm ? (pm.actual || pm.planned) : null;
    if (!plat || String(plat) !== String(oplat)) continue;    // same platform
    const arrIso = arr.realtimeForecast || arr.scheduleAdvertised || arr.realtimeActual;
    if (!arrIso) continue;
    const gap = (depMs - Date.parse(arrIso)) / 60000;
    if (gap < 2 || gap > 35) continue;                         // plausible turnaround
    const arrMs = Date.parse(arrIso);
    if (arrMs > bestArrMs) { bestArrMs = arrMs; best = s; }     // latest arrival before departure
  }
  if (!best) return null;
  const uid = best.scheduleMetadata && best.scheduleMetadata.uniqueIdentity;
  if (!uid) return null;
  const inSvc = await fetchService(accessToken, uid);
  if (!inSvc || inSvc.__error) return null;
  const inbound = buildInbound(inSvc);
  inbound.inferred = true;
  return inbound;
}

/* Shift a wall-clock ISO ("…THH:MM…") by N minutes, returned as a local
   (no-offset) datetime string — RTT reads it in the location's own timezone. */
function shiftLocalIso(iso, deltaMin) {
  const m = iso && iso.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0));
  d.setUTCMinutes(d.getUTCMinutes() + deltaMin);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
}

/* Fetch one service in detailed mode (detailed surfaces the non-public
   turnaround associations). Returns the service object, or {__error}. */
async function fetchService(accessToken, id) {
  const q = `${BASE}/rtt/service?uniqueIdentity=${encodeURIComponent(id)}&detailed=true`;
  let r;
  try {
    r = await fetch(q, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    return { __error: "Could not reach the rail data feed." };
  }
  if (r.status === 404) return null;
  if (r.status === 401) { cachedToken = null; return { __error: "Token rejected." }; }
  if (!r.ok) return { __error: `Rail feed error (${r.status}).`, __status: 502 };
  const data = await r.json();
  return data.service || null;
}

/* Look for the train that FORMS this one (i.e. arrives and becomes it),
   normally at the origin terminus. Returns its uniqueIdentity, or null. */
function findFormedFrom(svc) {
  const locs = svc.locations || [];
  for (const l of locs) {
    const assoc = l.associatedServices || [];
    for (const a of assoc) {
      const type = a.associationData && a.associationData.associationType;
      if (type === "FORM_FROM") {
        const uid = a.scheduleMetadata && a.scheduleMetadata.uniqueIdentity;
        if (uid) return uid;
      }
    }
  }
  return null;
}

/* Compact inbound summary: its stops (for a mini timeline), plus its delay
   and times at the formation point (its terminus). */
function buildInbound(svc) {
  const p = buildProgress(svc);
  const locs = svc.locations || [];
  const last = locs[locs.length - 1] || {};
  const arr = (last.temporalData && last.temporalData.arrival) || {};
  const schedIso = arr.scheduleAdvertised || null;
  const expIso = arr.realtimeActual || arr.realtimeForecast || arr.scheduleAdvertised || null;
  let lateMins = 0;
  if (schedIso && expIso) {
    const d = Math.round((Date.parse(expIso) - Date.parse(schedIso)) / 60000);
    if (!Number.isNaN(d)) lateMins = d;
  }
  const meta = (last.locationMetadata && last.locationMetadata.platform) || null;
  const platform = meta ? (meta.actual || meta.planned || null) : null;
  return {
    id: svc.scheduleMetadata && svc.scheduleMetadata.uniqueIdentity,
    origin: p.origin,
    destination: p.destination,
    operator: p.operator,
    stops: p.stops,
    lateMins,
    dueArr: hhmm(schedIso),
    expectedArr: hhmm(expIso),
    platform,
  };
}

/* Turn the full service into a compact stop list + current position. */
function buildProgress(svc) {
  const raw = svc.locations || [];
  // Keep only public calling points (stops), drop pass-throughs.
  const calls = raw.filter((l) => {
    const d = (l.temporalData && l.temporalData.displayAs) || "PASS";
    return d === "CALL" || d === "STARTS" || d === "TERMINATES" || d === "CANCELLED";
  });

  const stops = calls.map((l, i) => {
    const t = l.temporalData || {};
    const dep = t.departure || {};
    const arr = t.arrival || {};
    const isLast = i === calls.length - 1;
    // Use arrival time at the final stop, departure time elsewhere; prefer realtime.
    const iso = isLast
      ? arr.realtimeActual || arr.realtimeForecast || arr.scheduleAdvertised || dep.scheduleAdvertised
      : dep.realtimeActual || dep.realtimeForecast || dep.scheduleAdvertised || arr.scheduleAdvertised;
    const meta = l.locationMetadata || {};
    return {
      name: (l.location && l.location.description) || "—",
      crs: (l.location && l.location.shortCodes && l.location.shortCodes[0]) || "",
      time: hhmm(iso),
      dep: hhmm(dep.realtimeActual || dep.realtimeForecast || dep.scheduleAdvertised),
      arr: hhmm(arr.realtimeActual || arr.realtimeForecast || arr.scheduleAdvertised),
      platform: meta.platform ? meta.platform.actual || meta.platform.planned || null : null,
      departed: !!dep.realtimeActual,
      arrived: !!arr.realtimeActual,
      status: t.status || null, // live: APPROACHING / AT_PLATFORM / DEPARTING ...
      cancelled: dep.isCancelled === true || arr.isCancelled === true || t.displayAs === "CANCELLED",
    };
  });

  // Work out where the train is.
  let liveIdx = stops.findIndex((s) => s.status);
  let lastDeparted = -1;
  stops.forEach((s, i) => { if (s.departed) lastDeparted = i; });

  let currentIdx;
  if (liveIdx >= 0) currentIdx = liveIdx;
  else if (lastDeparted >= 0) currentIdx = Math.min(lastDeparted + 1, stops.length - 1);
  else currentIdx = 0;

  stops.forEach((s, i) => {
    s.passed = i < currentIdx;
    s.current = i === currentIdx;
  });

  const caption = buildCaption(stops, currentIdx, liveIdx, lastDeparted);
  return {
    origin: stops.length ? stops[0].name : "—",
    destination: stops.length ? stops[stops.length - 1].name : "—",
    operator: (svc.scheduleMetadata && svc.scheduleMetadata.operator && svc.scheduleMetadata.operator.name) || "",
    stops,
    caption,
  };
}

function buildCaption(stops, currentIdx, liveIdx, lastDeparted) {
  if (!stops.length) return "No live information.";
  const here = stops[currentIdx];
  if (liveIdx >= 0) {
    const s = stops[liveIdx].status;
    if (s === "APPROACHING") return `Approaching ${stops[liveIdx].name}`;
    return `At ${stops[liveIdx].name}`;
  }
  if (lastDeparted < 0) return `Not yet departed ${stops[0].name}`;
  if (currentIdx >= stops.length - 1 && stops[stops.length - 1].arrived) return `Arrived at ${stops[stops.length - 1].name}`;
  return `Departed ${stops[currentIdx - 1] ? stops[currentIdx - 1].name : stops[0].name}, next ${here.name}`;
}

/* Read published HH:MM straight from the timestamp (UK railway time) — no
   timezone conversion (see board.js). */
function hhmm(iso) {
  const m = typeof iso === "string" && iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : null;
}

async function getAccessToken(refreshToken) {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresMs - 30000 > now) return cachedToken.token;
  const r = await fetch(`${BASE}/api/get_access_token`, { headers: { Authorization: `Bearer ${refreshToken}` } });
  if (!r.ok) { cachedToken = { token: refreshToken, expiresMs: now + 60000 }; return refreshToken; }
  const body = await r.json();
  const token = body.token || refreshToken;
  const expiresMs = body.validUntil ? Date.parse(body.validUntil) : now + 5 * 60000;
  cachedToken = { token, expiresMs };
  return token;
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
