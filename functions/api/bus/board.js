// GET /api/bus/board?stop=490008660N&line=213&rows=6
//
// Proxies the TfL Unified API bus arrivals for a stop, same JSON shape as the
// rail and tube proxies. No key required; set TFL_APP_KEY for higher limits.
//
// stop = TfL bus StopPoint (Naptan) id, e.g. 490008660N
// line = bus route number to filter to, e.g. '213' (optional — omit for all routes at the stop)
//
// Buses have no fixed "scheduled" time in the arrivals feed, only live predictions,
// so countdown (minutes) is the primary signal. A cancelled/withdrawn bus simply
// disappears from predictions — the worker infers this by comparing to expected frequency.

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

const auth = (env) => (env.TFL_APP_KEY ? `?app_key=${env.TFL_APP_KEY}` : "");

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const stop = url.searchParams.get("stop");
  const line = url.searchParams.get("line"); // optional route filter
  const rows = Math.min(Number(url.searchParams.get("rows")) || 6, 12);

  if (!stop) return json({ error: "Missing 'stop' Naptan id, e.g. ?stop=490008660N" }, 400);

  try {
    const aResp = await fetch(`${TFL}/StopPoint/${stop}/Arrivals${auth(env)}`, {
      headers: { Accept: "application/json" },
    });
    if (!aResp.ok) return json({ error: "TfL arrivals error", status: aResp.status }, 502);
    let arrivals = await aResp.json();

    if (line) {
      const wanted = new Set(String(line).split(",").map((x) => x.trim()));
      arrivals = arrivals.filter((a) => wanted.has(String(a.lineName)));
    }

    arrivals.sort((a, b) => a.timeToStation - b.timeToStation);
    arrivals = arrivals.slice(0, rows);

    const services = arrivals.map((a) => {
      const mins = Math.max(0, Math.round(a.timeToStation / 60));
      return {
        serviceID: a.id,
        std: hhmm(a.expectedArrival),
        etd: `${mins} min`,
        status: "on_time",              // live predictions are inherently "current"; delays show as later countdowns
        estimated: hhmm(a.expectedArrival),
        countdown: mins,
        platform: a.platformName || null, // often the stop letter, e.g. "Stop K"
        operator: a.lineName || "Bus",
        delayReason: null,
        cancelReason: null,
        destination: a.destinationName || a.towards || null,
        origin: null,
      };
    });

    return json(
      {
        from: stop,
        line: line || null,
        generatedAt: new Date().toISOString(),
        locationName: arrivals[0]?.stationName || stop,
        nrccMessages: [],
        services,
      },
      200,
      { "Cache-Control": "public, max-age=15" }
    );
  } catch (e) {
    return json({ error: "Could not reach TfL", detail: String(e) }, 502);
  }
}
