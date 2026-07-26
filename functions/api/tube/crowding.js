// GET /api/tube/crowding?stop=940GZZLUWLO
//
// Proxies TfL's near-real-time crowding data: "busyness at a station level, calculated
// every 5 minutes, as a fraction of the busiest the station has been since data
// collection began" (per TfL's own description). Not every station has live data —
// TfL's /crowding/{id}/Live returns isFound:false for stations it doesn't cover.
//
// TfL's exact field naming for this endpoint isn't published in stable docs (their
// historical-profile endpoint uses `percentageOfBaseLine`, unusual capitalisation) so
// this checks a couple of likely spellings defensively rather than assuming one and
// silently showing nothing (or garbage) if it's wrong.
//
// Returns { percentage: number|null } — null means "no data for this station right now",
// which the frontend just doesn't display rather than showing a wrong number.

const TFL = "https://api.tfl.gov.uk";
const auth = (env) => (env.TFL_APP_KEY ? `?app_key=${env.TFL_APP_KEY}` : "");

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const stop = url.searchParams.get("stop");
  if (!stop) return json({ error: "Missing 'stop'" }, 400);

  try {
    const r = await fetch(`${TFL}/crowding/${encodeURIComponent(stop)}/Live${auth(env)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return json({ percentage: null }, 200, { "Cache-Control": "public, max-age=120" });
    const d = await r.json();
    if (d.isFound === false) return json({ percentage: null }, 200, { "Cache-Control": "public, max-age=120" });

    const raw = d.percentageOfBaseLine ?? d.percentageOfBaseline ?? d.percentage ?? null;
    if (raw == null || typeof raw !== "number") return json({ percentage: null }, 200, { "Cache-Control": "public, max-age=120" });
    // TfL's historical-profile endpoint expresses this as a 0-1 fraction; guard in case
    // the live endpoint instead returns an already-scaled percentage.
    const percentage = Math.round(raw <= 1.5 ? raw * 100 : raw);

    return json({ percentage }, 200, { "Cache-Control": "public, max-age=120" });
  } catch (e) {
    return json({ percentage: null }, 200);
  }
}
