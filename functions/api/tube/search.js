/**
 * GET /api/tube/search?q=waterloo
 * Find tube / Elizabeth line / DLR stations by name.
 *
 * Debug: ?debug=1 -> raw TfL payload.
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const debug = url.searchParams.get("debug");
  if (q.length < 2) return json({ stations: [] });

  const api = `https://api.tfl.gov.uk/StopPoint/Search/${encodeURIComponent(q)}` +
    `?modes=tube,elizabeth-line,dlr&maxResults=10` + keyQS(env, true);

  let d;
  try {
    const r = await fetch(api, { headers: { accept: "application/json" } });
    if (!r.ok) return json({ error: `TfL search error (${r.status}).` }, 502);
    d = await r.json();
  } catch (e) {
    return json({ error: "Could not reach TfL." }, 502);
  }

  if (debug) return json({ debug: "search", q, raw: d });

  const stations = (d.matches || [])
    .map((m) => ({
      id: m.id,                                  // e.g. 940GZZLUWLO
      name: (m.name || "").replace(/ Underground Station$/i, "").replace(/ Station$/i, ""),
      lines: (m.lines || []).map((l) => l.id),   // used for the little colour dots
      isHub: /^HUB/i.test(m.id || ""),
    }))
    // Hub ids (HUBWAT = "Waterloo, all modes") make the journey planner return
    // a 300 "which one did you mean?". Prefer the specific station id.
    .filter((s) => !s.isHub)
    .map(({ isHub, ...s }) => s);

  return json({ stations }, 200, { "cache-control": "public, max-age=600, s-maxage=600" });
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
