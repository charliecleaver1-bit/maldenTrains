// GET /api/tube/board?stop=940GZZLUWLO&line=waterloo-city&direction=inbound&rows=6
//
// Proxies the TfL Unified API and returns the SAME JSON shape as /api/rail/board,
// so the frontend treats every leg identically. No key required for this volume;
// set TFL_APP_KEY if you want higher rate limits.
//
// stop      = TfL StopPoint id (Naptan). Waterloo Underground = 940GZZLUWLO
// line      = line id, e.g. 'waterloo-city', 'jubilee', 'northern'
// direction = 'inbound' | 'outbound' (optional filter)
//
// Countdown is real: TfL gives timeToStation in seconds, so "5 min / 8 min" is exact.

const TFL = "https://api.tfl.gov.uk";

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

const hhmm = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

function auth(env) {
  return env.TFL_APP_KEY ? `?app_key=${env.TFL_APP_KEY}` : "";
}

// Arrivals need a concrete tube StopPoint id (940GZZLU…). Journey Planner sometimes
// hands us a hub (HUB…) or platform-level id; resolve those to the parent StopPoint.
async function canonicalStop(env, id) {
  if (/^940GZZ/.test(id)) return id;
  try {
    const r = await fetch(`${TFL}/StopPoint/${encodeURIComponent(id)}${auth(env)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return id;
    const sp = await r.json();
    if (/^940GZZ/.test(sp.id)) return sp.id;
    if (sp.topMostParentId && /^940GZZ/.test(sp.topMostParentId)) return sp.topMostParentId;
    const kid = (sp.children || []).find((c) => /^940GZZ/.test(c.id));
    return kid ? kid.id : id;
  } catch (e) { return id; }
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const stop = url.searchParams.get("stop");
  const line = url.searchParams.get("line");
  const direction = url.searchParams.get("direction"); // optional
  const rows = Math.min(Number(url.searchParams.get("rows")) || 6, 12);

  if (!stop) return json({ error: "Missing 'stop' StopPoint id, e.g. ?stop=940GZZLUWLO" }, 400);

  try {
    // Line status only depends on `line`, not on the resolved stop id, so it doesn't
    // need to wait behind canonicalStop()+arrivals. Kicking it off up front turns two
    // sequential round-trips into one — this was a meaningful chunk of the "takes a
    // long time to load" delay on tube legs (previously: canonicalStop → arrivals →
    // status, one after another; now: canonicalStop → arrivals, in parallel with status).
    const statusPromise = line
      ? fetch(`${TFL}/Line/${line}/Status${auth(env)}`, { headers: { Accept: "application/json" } })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null)
      : Promise.resolve(null);

    const stopId = await canonicalStop(env, stop);
    // 1) Live arrivals at the stop (optionally scoped to one line for fewer results).
    const arrivalsUrl = line
      ? `${TFL}/Line/${line}/Arrivals/${stopId}${auth(env)}`
      : `${TFL}/StopPoint/${stopId}/Arrivals${auth(env)}`;
    const aResp = await fetch(arrivalsUrl, { headers: { Accept: "application/json" } });
    if (!aResp.ok) return json({ error: "TfL arrivals error", status: aResp.status }, 502);
    let arrivals = await aResp.json();

    if (direction) arrivals = arrivals.filter((a) => a.direction === direction);

    // Soonest first, capped to rows.
    arrivals.sort((a, b) => a.timeToStation - b.timeToStation);
    arrivals = arrivals.slice(0, rows);

    // 2) Line status → a human disruption reason if the line isn't in Good Service.
    //    Also try to pull the specific stop ids the disruption's affected route section
    //    covers (TfL's disruption.affectedRoutes[].routeSectionNaptanEntrySequence), so
    //    the frontend can tell "affects your branch" apart from "affects a different
    //    branch of this line entirely". This is best-effort: TfL doesn't always populate
    //    that structured data for every disruption. When it's absent, disruptionStopIds
    //    comes back null and the frontend falls back to today's behaviour (treat any
    //    disruption on the line as relevant) rather than risk hiding a real problem.
    let disruptionReason = null;
    let severity = "on_time";
    let lineStatusDesc = "Good Service";
    let lineStatusLevel = 10;
    let disruptionStopIds = null;
    const status = await statusPromise;
    if (status) {
      const ls = status?.[0]?.lineStatuses?.[0];
      if (ls) {
        lineStatusDesc = ls.statusSeverityDescription || "Good Service";
        lineStatusLevel = typeof ls.statusSeverity === "number" ? ls.statusSeverity : 10;
        if (ls.statusSeverity !== 10) {
          disruptionReason = ls.reason || ls.statusSeverityDescription || null;
          severity = "delayed";
          const sections = ls.disruption?.affectedRoutes || [];
          const ids = sections.flatMap((sec) => (sec.routeSectionNaptanEntrySequence || []).map((e) => e.stopPoint?.id).filter(Boolean));
          if (ids.length) disruptionStopIds = [...new Set(ids)];
        }
      }
    }

    const services = arrivals.map((a) => {
      const mins = Math.max(0, Math.round(a.timeToStation / 60));
      return {
        serviceID: a.id,
        std: hhmm(a.expectedArrival),      // for tube, scheduled≈expected; keep field for shape parity
        etd: `${mins} min`,
        status: severity,                   // per-arrival status follows line status for tube
        estimated: hhmm(a.expectedArrival),
        countdown: mins,                    // exact minutes — the "5 min / 8 min" value
        platform: a.platformName || null,
        operator: "TfL",
        delayReason: disruptionReason,
        cancelReason: null,
        destination: a.destinationName || a.towards || null,
        origin: null,
        lineId: a.lineId || null,
        lineName: a.lineName || null,
        direction: a.direction || null,
        currentLocation: a.currentLocation || null,   // e.g. "At Mile End" / "Between X and Y"
      };
    });

    return json(
      {
        from: stop,
        line: line || null,
        direction: direction || null,
        generatedAt: new Date().toISOString(),
        locationName: arrivals[0]?.stationName || stop,
        nrccMessages: disruptionReason ? [disruptionReason] : [],
        lineStatus: lineStatusDesc,
        lineStatusLevel,
        lineReason: disruptionReason,
        disruptionStopIds,
        services,
      },
      200,
      { "Cache-Control": "public, max-age=15" }
    );
  } catch (e) {
    return json({ error: "Could not reach TfL", detail: String(e) }, 502);
  }
}
