// GET /api/bus/resolve?from=490008660N&to=490008661S
//
// Given a boarding stop and a destination stop, work out which bus route(s) connect
// them in the right direction — so the user never types a route number. Strategy:
//   1. Get the lines serving the boarding stop (StopPoint/{from} → lineModeGroups/lines).
//   2. For each candidate line, fetch its stop sequence and check the destination
//      appears AFTER the boarding stop on the same direction's route.
//   3. Return the lines that qualify, with the canonical direction.
//
// Returns { from, to, lines:[{id,name,direction}], direct: bool }.

const TFL = "https://api.tfl.gov.uk";
const auth = (env) => (env.TFL_APP_KEY ? `?app_key=${env.TFL_APP_KEY}` : "");

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

// Normalise a TfL stop id to its parent Naptan where needed (arrival ids sometimes
// carry a direction suffix). The route sequences use the same ids TfL returns here.
async function linesAtStop(env, stopId) {
  const resp = await fetch(`${TFL}/StopPoint/${encodeURIComponent(stopId)}${auth(env)}`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) return [];
  const sp = await resp.json();
  const lines = (sp.lines || []).map((l) => ({ id: l.id, name: l.name }));
  return lines;
}

// Does `line` run from fromId through to toId (to after from) in some direction?
async function lineConnects(env, lineId, fromId, toId) {
  for (const direction of ["inbound", "outbound"]) {
    const sep = auth(env) ? "&" : "?";
    const url = `${TFL}/Line/${lineId}/Route/Sequence/${direction}${auth(env)}${sep}serviceTypes=Regular,Night`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) continue;
    const seq = await resp.json();
    // stopPointSequences[].stopPoint[] carries ids in travel order
    const ids = [];
    for (const sps of seq.stopPointSequences || []) {
      for (const sp of sps.stopPoint || []) ids.push(sp.id);
    }
    const fi = ids.indexOf(fromId);
    const ti = ids.indexOf(toId);
    if (fi !== -1 && ti !== -1 && ti > fi) return direction;
  }
  return null;
}

export async function onRequest(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!from || !to) return json({ error: "Need 'from' and 'to' stop ids" }, 400);

  try {
    const candidates = await linesAtStop(env, from);
    const serving = [];
    // Check each candidate line for a valid from->to ordering. Cap the fan-out so a
    // busy interchange doesn't spawn dozens of sequence calls.
    for (const line of candidates.slice(0, 12)) {
      const dir = await lineConnects(env, line.id, from, to);
      if (dir) serving.push({ id: line.id, name: line.name, direction: dir });
    }

    return json(
      { from, to, lines: serving, direct: serving.length > 0 },
      200,
      { "Cache-Control": "public, max-age=86400" }
    );
  } catch (e) {
    return json({ error: "Could not resolve route", detail: String(e) }, 502);
  }
}
