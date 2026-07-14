/**
 * Cloudflare Pages Function — GET /api/busboard?stop=<naptanId>
 * ------------------------------------------------------------
 * Live bus arrivals for a saved stop, soonest first, via TfL's open API.
 */

const TFL = "https://api.tfl.gov.uk";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const stop = url.searchParams.get("stop");
  if (!stop) return json({ error: "Missing stop." }, 400);

  const key = env.TFL_APP_KEY ? `?app_key=${env.TFL_APP_KEY}` : "";
  let data;
  try {
    const r = await fetch(`${TFL}/StopPoint/${encodeURIComponent(stop)}/Arrivals${key}`);
    if (!r.ok) return json({ error: `TfL error (${r.status}).` }, 502);
    data = await r.json();
  } catch (e) { return json({ error: "Could not reach TfL." }, 502); }

  const arrivals = (Array.isArray(data) ? data : [])
    .map((a) => ({
      line: a.lineName || "",
      lineId: a.lineId || "",
      destination: a.destinationName || a.towards || "",
      secs: typeof a.timeToStation === "number" ? a.timeToStation : 0,
      mins: Math.max(0, Math.round((a.timeToStation || 0) / 60)),
      expected: a.expectedArrival || null,
      // The registration of the actual bus. Present for most services — it's
      // what lets us follow this specific vehicle down the route.
      vehicle: a.vehicleId && a.vehicleId !== "0" ? a.vehicleId : null,
    }))
    .filter((a) => a.line)
    .sort((a, b) => a.secs - b.secs)
    .slice(0, 10);

  return json(
    { stop, generatedAt: new Date().toISOString(), arrivals },
    200,
    { "cache-control": "public, max-age=15, s-maxage=15" }
  );
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
