/**
 * GET /api/tube/crowding?stop=940GZZLUOXC
 *
 * How busy a station is right now. TfL recalculates this every ~5 minutes and
 * expresses it as a fraction of the busiest that station has ever been (since
 * data collection started in 2019) — so it's a RELATIVE measure, not a head
 * count. We label it that way rather than implying we know how many people are
 * on the platform.
 *
 * Not every station has data (Kensington Olympia, Heathrow T5 and Willesden
 * Junction are excluded, and Monument is reported as Bank). Where there's no
 * data we say so instead of guessing.
 *
 * Debug: ?debug=1 -> raw TfL payloads (live + typical).
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const stop = (url.searchParams.get("stop") || "").trim();
  const debug = url.searchParams.get("debug");
  if (!stop) return json({ error: "Need a stop id." }, 400);

  const [live, typical] = await Promise.all([
    getJson(`https://api.tfl.gov.uk/crowding/${encodeURIComponent(stop)}/Live` + keyQS(env), env),
    getJson(`https://api.tfl.gov.uk/crowding/${encodeURIComponent(stop)}` + keyQS(env), env),
  ]);

  if (debug) return json({ debug: "crowding", stop, live, typical });

  // Live: a fraction of this station's own record high.
  const pct = live && typeof live.percentageOfBaseline === "number"
    ? live.percentageOfBaseline
    : null;

  const dataAvailable = live ? live.dataAvailable !== false : false;

  return json(
    {
      stop,
      available: pct !== null && dataAvailable,
      percent: pct === null ? null : Math.round(pct * 100),
      level: levelOf(pct),
      label: labelOf(pct),
      typicalNow: typicalNow(typical),
    },
    200,
    { "cache-control": "public, max-age=120, s-maxage=120" }
  );
}

/* Buckets. These are judgement calls on a relative scale, so the wording stays
   qualitative ("fairly busy") rather than pretending to precision. */
function levelOf(p) {
  if (p === null) return null;
  if (p < 0.2) return "quiet";
  if (p < 0.45) return "moderate";
  if (p < 0.7) return "busy";
  return "packed";
}
function labelOf(p) {
  const l = levelOf(p);
  return { quiet: "Quiet", moderate: "Fairly quiet", busy: "Busy", packed: "Very busy" }[l] || null;
}

/* The typical profile for right now — useful context for "is this normal?". */
function typicalNow(t) {
  try {
    if (!t || !Array.isArray(t.daysOfWeek)) return null;
    const now = new Date();
    const day = now.toLocaleDateString("en-GB", { weekday: "long", timeZone: "Europe/London" });
    const band = t.daysOfWeek.find((d) => (d.dayOfWeek || "").toLowerCase() === day.toLowerCase());
    if (!band || !Array.isArray(band.timeBands)) return null;

    const hh = now.toLocaleTimeString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/London" });
    const hit = band.timeBands.find((b) => String(b.timeBand || "").startsWith(hh));
    if (!hit || typeof hit.percentageOfBaseLine !== "number") return null;

    return { percent: Math.round(hit.percentageOfBaseLine * 100), band: hit.timeBand };
  } catch (e) { return null; }
}

async function getJson(u, env) {
  try {
    const r = await fetch(u, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

function keyQS(env) {
  return env.TFL_APP_KEY ? `?app_key=${encodeURIComponent(env.TFL_APP_KEY)}` : "";
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
