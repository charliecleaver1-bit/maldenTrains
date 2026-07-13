/**
 * GET /api/tube/search?q=brixton
 * Find tube / Elizabeth line / DLR stations by name.
 *
 * Debug:
 *   ?debug=1  -> every stage: what we asked TfL, what it sent, what survived
 *                each filter. If a station is "missing", this shows where it
 *                got dropped.
 */

const TUBE_MODES = ["tube", "dlr", "elizabeth-line", "overground"];

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const debug = url.searchParams.get("debug");
  if (q.length < 2) return json({ stations: [] });

  const stages = {};

  // Try the filtered search first. If TfL returns nothing, fall back to an
  // unfiltered search and filter ourselves — a bad mode name in the query
  // silently returns an empty list, which would make stations "disappear".
  let matches = [];
  const filtered = await search(env, q, true);
  stages.filteredUrl = filtered.url;
  stages.filteredStatus = filtered.status;
  stages.filteredCount = (filtered.matches || []).length;

  if (filtered.matches && filtered.matches.length) {
    matches = filtered.matches;
    stages.usedFallback = false;
  } else {
    const plain = await search(env, q, false);
    stages.plainUrl = plain.url;
    stages.plainStatus = plain.status;
    stages.plainCount = (plain.matches || []).length;
    stages.usedFallback = true;
    // Keep only things that actually serve a tube-ish mode.
    matches = (plain.matches || []).filter((m) =>
      (m.modes || []).some((mo) => TUBE_MODES.includes(mo)) ||
      /^940GZZLU/i.test(m.id || "") ||
      /^HUB/i.test(m.id || "")
    );
    stages.plainKept = matches.length;
  }

  const all = matches.map((m) => ({
    id: m.id,
    name: cleanName(m.name),
    lines: (m.lines || []).map((l) => l.id),
    modes: m.modes || [],
    isHub: /^HUB/i.test(m.id || ""),
  }));

  // Prefer a specific station id over a hub for the same name, but never drop
  // a station just because the hub is all TfL gave us (Brixton does this).
  const byName = new Map();
  for (const s of all) {
    const prev = byName.get(s.name);
    if (!prev || (prev.isHub && !s.isHub)) byName.set(s.name, s);
  }
  const stations = [...byName.values()].map(({ isHub, modes, ...s }) => s);

  if (debug) {
    return json({ debug: "search", q, stages, rawMatchCount: matches.length,
      rawMatches: matches.map((m) => ({ id: m.id, name: m.name, modes: m.modes })),
      afterDedupe: stations });
  }

  return json({ stations }, 200, { "cache-control": "public, max-age=600, s-maxage=600" });
}

async function search(env, q, withModes) {
  const modes = withModes ? `?modes=${TUBE_MODES.join(",")}&` : "?";
  const u = `https://api.tfl.gov.uk/StopPoint/Search/${encodeURIComponent(q)}` +
    `${modes}maxResults=12` + (env.TFL_APP_KEY ? `&app_key=${encodeURIComponent(env.TFL_APP_KEY)}` : "");
  try {
    const r = await fetch(u, { headers: { accept: "application/json" } });
    if (!r.ok) return { url: u, status: r.status, matches: [] };
    const d = await r.json();
    return { url: u, status: 200, matches: d.matches || [] };
  } catch (e) {
    return { url: u, status: 0, matches: [], error: String(e) };
  }
}

function cleanName(n) {
  return String(n || "")
    .replace(/ Underground Station$/i, "")
    .replace(/ Rail Station$/i, "")
    .replace(/ DLR Station$/i, "")
    .replace(/ Station$/i, "")
    .trim();
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
