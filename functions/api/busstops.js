/**
 * Cloudflare Pages Function — GET /api/busstops?lat=..&lon=..  or  ?postcode=KT3+3HL
 * ---------------------------------------------------------------------------------
 * Finds nearby bus stops via TfL's open Unified API. A postcode is resolved to
 * coordinates first (postcodes.io, free, no key). Returns a compact pick-list:
 * name, stop letter, direction ("towards X"), distance, and the routes served.
 *
 * TfL is free and works keyless; setting TFL_APP_KEY in Pages settings just
 * raises the rate limit (recommended before you commercialise).
 */

const TFL = "https://api.tfl.gov.uk";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  let lat = url.searchParams.get("lat");
  let lon = url.searchParams.get("lon");
  const postcode = url.searchParams.get("postcode");

  // postcode -> coordinates
  if ((!lat || !lon) && postcode) {
    try {
      const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode.trim())}`);
      if (r.ok) {
        const d = await r.json();
        if (d.result) { lat = d.result.latitude; lon = d.result.longitude; }
      }
    } catch (e) { /* fall through */ }
  }
  if (!lat || !lon) return json({ error: "Enter a valid UK postcode, or allow location." }, 400);

  const key = env.TFL_APP_KEY ? `&app_key=${env.TFL_APP_KEY}` : "";
  const q = `${TFL}/StopPoint?lat=${lat}&lon=${lon}&stopTypes=NaptanPublicBusCoachTram&radius=650&returnLines=true${key}`;
  let data;
  try {
    const r = await fetch(q);
    if (!r.ok) return json({ error: `TfL error (${r.status}).` }, 502);
    data = await r.json();
  } catch (e) { return json({ error: "Could not reach TfL." }, 502); }

  const stops = (data.stopPoints || [])
    .map((s) => ({
      id: s.naptanId || s.id,
      name: s.commonName || "",
      letter: s.stopLetter || (s.indicator ? String(s.indicator).replace(/^Stop\s*/i, "") : ""),
      toward: towardOf(s),
      distance: s.distance != null ? Math.round(s.distance) : null,
      routes: (s.lines || []).map((l) => l.name).filter(Boolean).slice(0, 6),
    }))
    .filter((s) => s.id && s.name)
    .sort((a, b) => (a.distance == null ? 1e9 : a.distance) - (b.distance == null ? 1e9 : b.distance))
    .slice(0, 12);

  return json({ lat: +lat, lon: +lon, stops }, 200, { "cache-control": "public, max-age=300" });
}

function towardOf(s) {
  const props = s.additionalProperties || [];
  const t = props.find((p) => p.key === "Towards");
  return t && t.value ? t.value : "";
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
