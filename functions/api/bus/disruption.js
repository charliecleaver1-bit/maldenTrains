// GET /api/bus/disruption?lines=213,152
//
// Returns any current disruptions (diversions, part-suspensions, closures) for the
// given bus route(s). TfL publishes these at /Line/{ids}/Disruption. Closed-stop info
// is usually embedded in the line disruption text rather than a per-stop flag, so we
// surface the disruption description verbatim (TfL wording) for the user to read.
//
// Returns { lines, disruptions:[{line,category,description}], hasDisruption }.

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
  const lines = (url.searchParams.get("lines") || "").trim();
  if (!lines) return json({ error: "Need 'lines', e.g. ?lines=213,152" }, 400);

  try {
    const ids = lines.split(",").map((x) => x.trim()).filter(Boolean).join(",");
    const resp = await fetch(`${TFL}/Line/${encodeURIComponent(ids)}/Disruption${auth(env)}`, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return json({ error: "TfL disruption error", status: resp.status }, 502);
    const raw = await resp.json();

    // De-dupe identical descriptions (TfL can repeat one notice across directions).
    const seen = new Set();
    const disruptions = [];
    for (const d of raw || []) {
      const description = (d.description || d.closureText || "").trim();
      if (!description || seen.has(description)) continue;
      seen.add(description);
      disruptions.push({
        line: d.lineId || null,
        category: d.category || d.categoryDescription || "Information",
        description,
      });
    }

    return json(
      { lines: ids, disruptions, hasDisruption: disruptions.length > 0 },
      200,
      { "Cache-Control": "public, max-age=120" }
    );
  } catch (e) {
    return json({ error: "Could not reach TfL", detail: String(e) }, 502);
  }
}
