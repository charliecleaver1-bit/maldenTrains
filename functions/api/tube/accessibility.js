// GET /api/tube/accessibility?stop=940GZZLUWLO
//
// Reads TfL's StopPoint.accessibilitySummary — a free-text human-readable field, e.g.
// "Step free access from street to platform using lift." or "This station is not step
// free.". Parsed into a plain true/false/null so the frontend can show a simple icon.
// null means the summary didn't clearly say either way (rather than guessing).
//
// Returns { stepFree: true|false|null, accessibilitySummary: string|null }

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
  const stop = url.searchParams.get("stop");
  if (!stop) return json({ error: "Missing 'stop'" }, 400);

  try {
    const r = await fetch(`${TFL}/StopPoint/${encodeURIComponent(stop)}${auth(env)}`, { headers: { Accept: "application/json" } });
    if (!r.ok) return json({ stepFree: null, accessibilitySummary: null }, 200, { "Cache-Control": "public, max-age=86400" });
    const sp = await r.json();
    const summary = sp.accessibilitySummary || null;

    let stepFree = null;
    if (summary) {
      const s = summary.toLowerCase();
      // Check the negative phrasing first — it's more specific than the bare presence
      // of "step free", which a negative sentence also contains.
      if (s.includes("not step free") || s.includes("no step free")) stepFree = false;
      else if (s.includes("step free")) stepFree = true;
    }

    return json({ stepFree, accessibilitySummary: summary }, 200, { "Cache-Control": "public, max-age=86400" });
  } catch (e) {
    return json({ stepFree: null, accessibilitySummary: null }, 200);
  }
}
