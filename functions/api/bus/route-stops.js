// GET /api/bus/route-stops?route=213
//
// Stops on a bus route, in order, for each direction — so the user picks their board
// and alight stop from the actual route. Validation is then just "alight comes after
// board on the same direction", which the frontend enforces by index.
//
// Returns { route, directions: [ { name, stops:[{id,name}] }, ... ] }.

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
  const route = (url.searchParams.get("route") || "").trim().toLowerCase();
  if (!route) return json({ error: "Need 'route', e.g. ?route=213" }, 400);

  try {
    const directions = [];
    for (const dir of ["inbound", "outbound"]) {
      const sep = auth(env) ? "&" : "?";
      const r = await fetch(`${TFL}/Line/${encodeURIComponent(route)}/Route/Sequence/${dir}${auth(env)}${sep}serviceTypes=Regular,Night`, { headers: { Accept: "application/json" } });
      if (!r.ok) continue;
      const seq = await r.json();
      const stops = [];
      const seen = new Set();
      for (const sps of (seq.stopPointSequences || [])) {
        for (const sp of sps.stopPoint || []) {
          if (seen.has(sp.id)) continue;
          seen.add(sp.id);
          stops.push({ id: sp.id, name: (sp.name || sp.commonName || "").replace(/_.*/, "").trim() });
        }
      }
      if (stops.length) {
        const first = stops[0]?.name, last = stops[stops.length - 1]?.name;
        directions.push({ name: `${first} → ${last}`, dir, stops });
      }
    }
    if (!directions.length) return json({ route, directions: [], error: "route not found" });
    return json({ route, directions }, 200, { "Cache-Control": "public, max-age=86400" });
  } catch (e) {
    return json({ error: "Could not reach TfL", detail: String(e) }, 502);
  }
}
