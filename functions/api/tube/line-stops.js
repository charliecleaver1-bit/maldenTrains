// GET /api/tube/line-stops?line=victoria
//
// All stations on a line, in route order, for the start/end pickers. Because the user
// picks both stops from this same list, the journey is guaranteed valid — no separate
// validation needed. Returns [{ id, name }].

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
  const line = (url.searchParams.get("line") || "").trim();
  if (!line) return json({ error: "Need 'line', e.g. ?line=victoria" }, 400);

  try {
    const r = await fetch(`${TFL}/Line/${encodeURIComponent(line)}/StopPoints${auth(env)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return json({ error: "TfL error", status: r.status }, 502);
    const arr = await r.json();
    // Keep the canonical station id + a clean name (strip "Underground Station" noise).
    const stops = arr.map((s) => ({
      id: s.id,
      name: (s.commonName || s.name || "").replace(/ Underground Station$/i, "").replace(/ Station$/i, "").trim(),
    }));
    // De-dupe and sort by name for the picker.
    const seen = new Set();
    const uniq = stops.filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)));
    uniq.sort((a, b) => a.name.localeCompare(b.name));
    return json({ line, stops: uniq }, 200, { "Cache-Control": "public, max-age=86400" });
  } catch (e) {
    return json({ error: "Could not reach TfL", detail: String(e) }, 502);
  }
}
