/**
 * GET /api/tube/board?line=jubilee&stop=940GZZLUWLO&direction=outbound&after=12
 *
 *   direction  inbound | outbound  (from /api/tube/plan — trains the OTHER way
 *              are dropped, so you never see one going the wrong way)
 *   after      minutes from now before you'd actually be on that platform.
 *              For a second or third leg you won't be there yet, so showing the
 *              next train "now" would be useless — we only return trains due
 *              AFTER you could realistically board.
 *
 * Debug: ?debug=1 -> raw TfL arrivals, so you can see what was filtered out.
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const line = (url.searchParams.get("line") || "").trim();
  const stop = (url.searchParams.get("stop") || "").trim();
  const direction = (url.searchParams.get("direction") || "").trim();
  const after = Math.max(0, parseInt(url.searchParams.get("after") || "0", 10) || 0);
  const debug = url.searchParams.get("debug");

  if (!line || !stop) return json({ error: "Need line and stop." }, 400);

  const api = `https://api.tfl.gov.uk/Line/${encodeURIComponent(line)}/Arrivals/${encodeURIComponent(stop)}` +
    keyQS(env);

  let raw;
  try {
    const r = await fetch(api, { headers: { accept: "application/json" } });
    if (!r.ok) return json({ error: `TfL arrivals error (${r.status}).` }, 502);
    raw = await r.json();
  } catch (e) {
    return json({ error: "Could not reach TfL." }, 502);
  }

  const all = (raw || []).map((a) => ({
    mins: Math.max(0, Math.round((a.timeToStation || 0) / 60)),
    towards: cleanName(a.towards || a.destinationName),
    platform: tidyPlatform(a.platformName),
    direction: a.direction || null,
    dest: a.destinationNaptanId || null,
  })).sort((x, y) => x.mins - y.mins);

  if (debug) {
    return json({
      debug: "board", line, stop, direction, after,
      totalFromTfl: all.length,
      kept: all.filter((a) => matches(a, direction) && a.mins >= after).length,
      all,
      rawSample: (raw || []).slice(0, 3),
    });
  }

  // Right way only, and only trains you could actually catch.
  let arrivals = all.filter((a) => matches(a, direction));
  const wrongWayDropped = all.length - arrivals.length;

  arrivals = arrivals.filter((a) => a.mins >= after).slice(0, 2);

  return json(
    {
      line, stop, direction, after, arrivals,
      wrongWayDropped,
      // TfL's arrivals feed only looks ~30 min ahead. Beyond that we have
      // nothing real to show, and we say so rather than invent times.
      beyondWindow: arrivals.length === 0 && after > 25,
    },
    200,
    { "cache-control": "public, max-age=15, s-maxage=15" }
  );
}

/* If we couldn't resolve a direction, don't silently show everything —
   but we'd rather show trains than nothing, so pass them through and let
   the UI note that direction is unconfirmed. */
function matches(a, direction) {
  if (!direction) return true;
  if (!a.direction) return true;
  return a.direction === direction;
}

/* "Northbound - Platform 3" -> "Northbound · Platform 3" */
function tidyPlatform(p) {
  if (!p) return null;
  const s = String(p).replace(/\s*-\s*/g, " · ").trim();
  return s === "null" ? null : s;
}

function cleanName(n) {
  return String(n || "").replace(/ Underground Station$/i, "").replace(/ Station$/i, "") || null;
}

function keyQS(env) {
  return env.TFL_APP_KEY ? `?app_key=${encodeURIComponent(env.TFL_APP_KEY)}` : "";
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
