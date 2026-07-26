// GET /api/bus/stops?q=new malden
//
// Bus stop typeahead: searches TfL StopPoint by common name, filtered to bus stops.
// Returns [{ id, name, indicator, lines: ["213","152"], lat, lon }] so the user can
// pick a stop by NAME — no Naptan id needed.
//
// TfL StopPoint/Search returns "matches" with id + name; we fetch each match's lines
// lazily via the search payload where present. No key required; TFL_APP_KEY optional.

const TFL = "https://api.tfl.gov.uk";
const auth = (env) => (env.TFL_APP_KEY ? `?app_key=${env.TFL_APP_KEY}` : "");

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json({ query: q, stops: [] });

  try {
    // StopPoint search, bus mode only. maxResults keeps the typeahead snappy.
    const sep = auth(env) ? "&" : "?";
    const searchUrl = `${TFL}/StopPoint/Search/${encodeURIComponent(q)}${auth(env)}${sep}modes=bus&maxResults=25`;
    const resp = await fetch(searchUrl, { headers: { Accept: "application/json" } });
    if (!resp.ok) return json({ error: "TfL search error", status: resp.status }, 502);
    const data = await resp.json();

    let stops = (data.matches || []).map((m) => ({
      id: m.id,
      name: m.name,
      indicator: m.stopLetter || m.indicator || null,
      towards: m.towards || null,
      lines: Array.isArray(m.lines) ? m.lines.map((l) => l.name) : [],
      lat: m.lat,
      lon: m.lon,
    }));

    // The search payload often omits direction. Enrich the top matches with the fuller
    // StopPoint record, which carries the "Towards" additionalProperty and stopLetter.
    stops = await Promise.all(stops.slice(0, 10).map(async (s) => {
      if (s.towards && s.indicator) return s;
      try {
        const dResp = await fetch(`${TFL}/StopPoint/${encodeURIComponent(s.id)}${auth(env)}`, { headers: { Accept: "application/json" } });
        if (!dResp.ok) return s;
        const det = await dResp.json();
        const props = det.additionalProperties || [];
        const towards = (props.find((p) => p.key === "Towards") || {}).value || s.towards;
        const compass = (props.find((p) => p.key === "CompassPoint") || {}).value || null;
        return {
          ...s,
          indicator: det.stopLetter || s.indicator || null,
          towards: towards || null,
          compass,
          lines: s.lines.length ? s.lines : (det.lines || []).map((l) => l.name),
        };
      } catch (e) { return s; }
    }));

    return json({ query: q, stops }, 200, { "Cache-Control": "public, max-age=3600" });
  } catch (e) {
    return json({ error: "Could not reach TfL", detail: String(e) }, 502);
  }
}
