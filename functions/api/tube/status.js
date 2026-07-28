/**
 * GET /api/tube/status
 * Live status of every tube line (plus the Elizabeth line and DLR).
 *
 * Debug:  ?debug=1   -> the raw TfL payload, untouched.
 */

const MODES = "tube,elizabeth-line,dlr,overground,tram";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const debug = url.searchParams.get("debug");

  const q = `https://api.tfl.gov.uk/Line/Mode/${MODES}/Status` + keyQS(env);

  let raw;
  try {
    const r = await fetch(q, { headers: { accept: "application/json" } });
    if (!r.ok) return json({ error: `TfL status error (${r.status}).` }, 502);
    raw = await r.json();
  } catch (e) {
    return json({ error: "Could not reach TfL." }, 502);
  }

  if (debug) return json({ debug: "status", count: raw.length, raw });

  const lines = (raw || []).map((l) => {
    const st = (l.lineStatuses && l.lineStatuses[0]) || {};
    const desc = st.statusSeverityDescription || "Unknown";
    return {
      id: l.id,
      name: l.name,
      status: desc,
      severity: severityOf(st.statusSeverity, desc),
      reason: cleanReason(st.reason),
    };
  });

  return json(
    { lines, generatedAt: new Date().toISOString() },
    200,
    { "cache-control": "public, max-age=30, s-maxage=30" }
  );
}

/* TfL severity: 10 = Good Service. Lower numbers are worse. */
function severityOf(code, desc) {
  if (desc === "Good Service" || code === 10) return "ok";
  if (/severe|suspend|closed|part clos/i.test(desc || "")) return "bad";
  if (typeof code === "number" && code <= 5) return "bad";
  return "warn";
}

/* TfL reasons repeat the line name and are wrapped in noise. */
function cleanReason(r) {
  if (!r) return null;
  return String(r)
    .replace(/^[^:]*:\s*/, "")     // strip "Northern Line: " prefix
    .replace(/\s+/g, " ")
    .trim() || null;
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
