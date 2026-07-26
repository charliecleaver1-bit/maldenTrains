// GET /api/rail/validate?from=NEM&to=WAT
//
// Returns { direct: true|false, count, sample:[{std,destination}] }.
//
// Uses the departure board with filterType=to. IMPORTANT LIMIT: Darwin's board only
// shows trains currently scheduled, and BOTH its timeWindow and timeOffset are capped
// at ~120 minutes — so the board can never see more than ~2 hours ahead of now, by any
// parameter. That means at quiet hours (e.g. overnight) an empty result does NOT prove
// a route is non-direct; there simply are no services in view. The frontend messages
// this honestly rather than claiming "never direct". A fully time-independent check
// would require the scheduled timetable feed (a separate integration), not this board.
//
// When the filtered (direct-only) query comes back empty, we also check the UNFILTERED
// board for the same station. If trains ARE running from `from` right now but none of
// them call at `to`, that's real evidence of non-direct — `stationHasServices: true`.
// If the station has nothing in view at all (e.g. 1am), that's inconclusive rather than
// evidence either way — `stationHasServices: false`. The frontend treats only the
// former as a confident "no", and the latter as "couldn't check".

const RDM_BASE = "https://api1.raildata.org.uk";
const PRODUCT = "1010-live-departure-board-dep1_2";
const VERSION = "20220120";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function board(env, from, params) {
  const endpoint =
    `${RDM_BASE}/${env.DARWIN_PRODUCT || PRODUCT}/LDBWS/api/${env.DARWIN_VERSION || VERSION}` +
    `/GetDepBoardWithDetails/${from}?${params.toString()}`;
  const resp = await fetch(endpoint, { headers: { "x-apikey": env.DARWIN_APIKEY, Accept: "application/json" } });
  const text = await resp.text();
  if (!resp.ok) return { ok: false, status: resp.status, endpoint, detail: text.slice(0, 200) };
  return { ok: true, data: JSON.parse(text) };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  if (!from || !to) return json({ error: "Need both 'from' and 'to' CRS codes" }, 400);
  if (from === to) return json({ error: "from and to are the same station", direct: false }, 400);
  if (!env.DARWIN_APIKEY) return json({ error: "DARWIN_APIKEY not configured" }, 500);

  try {
    const direct = await board(env, from, new URLSearchParams({ numRows: "10", filterCrs: to, filterType: "to", timeWindow: "120" }));
    if (!direct.ok) return json({ error: "RDM error", status: direct.status, endpoint: direct.endpoint, detail: direct.detail }, 502);
    const services = Array.isArray(direct.data.trainServices) ? direct.data.trainServices : [];

    if (services.length > 0) {
      return json({
        direct: true,
        count: services.length,
        from, to,
        sample: services.slice(0, 3).map((s) => ({
          std: s.std,
          destination: Array.isArray(s.destination) && s.destination[0] ? s.destination[0].locationName : null,
          // Darwin's disambiguation text for ambiguous/loop routes (e.g. "via Kingston").
          // null/absent means this route has no such ambiguity to worry about.
          via: Array.isArray(s.destination) && s.destination[0] ? s.destination[0].via || null : null,
        })),
      });
    }

    // Nothing direct in view — check whether the station has ANY services at all right
    // now, to tell "quiet hours, inconclusive" apart from "busy station, just not this
    // destination, genuinely not direct".
    let stationHasServices = false;
    try {
      const plain = await board(env, from, new URLSearchParams({ numRows: "10", timeWindow: "120" }));
      if (plain.ok) stationHasServices = (Array.isArray(plain.data.trainServices) ? plain.data.trainServices : []).length > 0;
    } catch (e) { /* leave stationHasServices false — treated as inconclusive, not evidence either way */ }

    return json({
      direct: false,
      count: 0,
      windowEmpty: !stationHasServices,
      stationHasServices,
      from, to,
      sample: [],
    });
  } catch (e) {
    return json({ error: "Could not reach RDM", detail: String(e) }, 502);
  }
}
