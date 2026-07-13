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

  const all = await Promise.all(matches.map(async (m) => {
    const isHub = /^HUB/i.test(m.id || "");
    let id = m.id;
    let lines = (m.lines || []).map((l) => l.id);

    // A hub (HUBBRX) has no line info and makes the planner ask "which one?".
    // Swap it for the tube station inside it, and pick up its lines while we're
    // there — otherwise Brixton shows with no colour dots and won't plan.
    if (isHub) {
      const res = await resolveHub(env, m.id);
      if (res.id) id = res.id;
      if (res.lines && res.lines.length) lines = res.lines;
    }

    return { id, name: cleanName(m.name), lines, modes: m.modes || [], isHub: /^HUB/i.test(id) };
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

/* HUBxxx -> the Underground station inside it, plus its lines. */
const hubCache = new Map();
async function resolveHub(env, hubId) {
  if (hubCache.has(hubId)) return hubCache.get(hubId);

  let out = { id: null, lines: [] };
  try {
    const u = `https://api.tfl.gov.uk/StopPoint/${encodeURIComponent(hubId)}` +
      (env.TFL_APP_KEY ? `?app_key=${encodeURIComponent(env.TFL_APP_KEY)}` : "");
    const r = await fetch(u, { headers: { accept: "application/json" } });
    if (r.ok) {
      const d = await r.json();
      const kids = [];
      const walk = (n) => {
        if (!n) return;
        if (n.naptanId || n.id) kids.push(n);
        (n.children || []).forEach(walk);
      };
      (d.children || []).forEach(walk);

      const tube = kids.find((c) => /^940GZZLU/i.test(c.naptanId || c.id || ""))
        || kids.find((c) => (c.modes || []).some((m) => TUBE_MODES.includes(m)));
      if (tube) {
        out = {
          id: tube.naptanId || tube.id,
          lines: (tube.lines || []).map((l) => l.id),
        };
      }
    }
  } catch (e) { /* keep the hub id — the planner also resolves hubs */ }

  hubCache.set(hubId, out);
  return out;
}

async function search(env, q, withModes) {
  const modes = withModes ? `?modes=${TUBE_MODES.join(",")}&` : "?";
  const u = `https://api.tfl.gov.uk/StopPoint/Search/${encodeURIComponent(q)}` +
    `${modes}maxResults=12` + (env.TFL_APP_KEY ? `&app_key=${encodeURIComponent(env.TFL_APP_KEY)}` : "");
  try {
    const r = await fetch(u, { headers: { accept: "application/json" } });
    if (!r.ok) return { url: u, status: r.status, matches: [] };
    const d = await r.json();
    return { url: redactKey(u), status: 200, matches: d.matches || [] };
  } catch (e) {
    return { url: redactKey(u), status: 0, matches: [], error: String(e) };
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

/* Never echo the API key back in debug output. */
function redactKey(u) {
  return String(u || "").replace(/([?&]app_key=)[^&]*/i, "$1REDACTED");
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
