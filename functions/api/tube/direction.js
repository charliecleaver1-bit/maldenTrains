// GET /api/tube/direction?line=northern&from=<id>&to=<id>
//
// Determines your direction of travel on a line, handling branches, and returns both
// the TfL direction token (inbound/outbound) AND the set of onward stations beyond
// your boarding stop, as both names (for the destination-matching fallback filter)
// and ids (for checking whether a disruption's affected section actually overlaps
// your specific stops, vs. just being somewhere else on the line).
//
// Returns { line, direction, onward:[names], onwardIds:[ids], terminus:[names] }
// or { direction:null } if the pair doesn't resolve on this line.

const TFL = "https://api.tfl.gov.uk";
const auth = (env) => (env.TFL_APP_KEY ? `?app_key=${env.TFL_APP_KEY}` : "");
const clean = (s) => (s || "").replace(/ Underground Station$/i, "").replace(/ Station$/i, "").trim();

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
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!line || !from || !to) return json({ error: "Need line, from, to" }, 400);

  try {
    for (const dir of ["inbound", "outbound"]) {
      const sep = auth(env) ? "&" : "?";
      const r = await fetch(`${TFL}/Line/${encodeURIComponent(line)}/Route/Sequence/${dir}${auth(env)}${sep}serviceTypes=Regular,Night`, { headers: { Accept: "application/json" } });
      if (!r.ok) continue;
      const seq = await r.json();
      const branches = seq.stopPointSequences || [];

      const onward = new Set();
      const onwardIds = new Set();
      const terminus = new Set();
      let matched = false;

      for (const br of branches) {
        const pts = br.stopPoint || [];
        const ids = pts.map((s) => s.id);
        const fi = ids.indexOf(from), ti = ids.indexOf(to);
        if (fi !== -1 && ti !== -1 && ti > fi) {
          matched = true;
          for (let k = fi + 1; k < pts.length; k++) { onward.add(clean(pts[k].name)); onwardIds.add(pts[k].id); }
          if (pts.length) terminus.add(clean(pts[pts.length - 1].name));
        }
      }

      if (matched) {
        return json(
          { line, direction: dir, onward: [...onward], onwardIds: [...onwardIds], terminus: [...terminus] },
          200, { "Cache-Control": "public, max-age=86400" }
        );
      }
    }
    return json({ line, direction: null, onward: [], onwardIds: [], terminus: [] });
  } catch (e) {
    return json({ error: "Could not resolve direction", detail: String(e) }, 502);
  }
}
