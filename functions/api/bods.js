/**
 * GET /api/bods?lat=..&lon=..[&radius=1500]
 *
 * Live buses OUTSIDE London, from the DfT Bus Open Data Service (BODS).
 * TfL covers London; BODS covers the rest of England. The two are different
 * animals and it matters for honesty:
 *
 *   - TfL gives per-stop arrival PREDICTIONS ("131 in 4 min").
 *   - BODS gives raw vehicle POSITIONS (SIRI-VM). It does NOT predict
 *     arrival times at your stop.
 *
 * So this endpoint returns what BODS actually knows: the live buses near a
 * point, each with route, destination, operator, distance from you, and how
 * fresh the position report is. The UI must present these as "live buses
 * nearby", never as arrival times we don't have.
 *
 * Setup: free API key from https://data.bus-data.dft.gov.uk (register, then
 * Account -> API key). Set it as BODS_KEY in Cloudflare (Production+Preview).
 *
 * Workers have no XML DOMParser, so we extract fields from the SIRI XML with
 * anchored string scans per <VehicleActivity> block. SIRI-VM is machine
 * generated and regular, which makes this safe enough; anything that doesn't
 * parse is skipped rather than guessed at.
 *
 * Debug: ?debug=1 -> the request we sent + a sample of the raw XML.
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const lat = parseFloat(url.searchParams.get("lat"));
  const lon = parseFloat(url.searchParams.get("lon"));
  const radius = Math.min(5000, Math.max(300, parseInt(url.searchParams.get("radius") || "1500", 10)));
  const debug = url.searchParams.get("debug");

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return json({ error: "Need lat and lon." }, 400);
  }
  if (!env.BODS_KEY) {
    return json({ available: false, reason: "BODS not configured (no BODS_KEY)." }, 200);
  }

  // Bounding box around the point. 1 deg lat ~ 111km; lon shrinks by cos(lat).
  const dLat = radius / 111000;
  const dLon = radius / (111000 * Math.cos((lat * Math.PI) / 180));
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map((v) => v.toFixed(5)).join(",");

  const api = `https://data.bus-data.dft.gov.uk/api/v1/datafeed/?boundingBox=${bbox}&api_key=${encodeURIComponent(env.BODS_KEY)}`;

  let xml;
  try {
    const r = await fetch(api, { headers: { accept: "application/xml" } });
    if (r.status === 401 || r.status === 403) {
      return json({ available: false, reason: "BODS rejected the key. Check BODS_KEY." }, 200);
    }
    if (!r.ok) return json({ available: false, reason: `BODS error ${r.status}.` }, 200);
    xml = await r.text();
  } catch (e) {
    return json({ available: false, reason: "Couldn't reach BODS." }, 200);
  }

  if (debug) {
    return json({ debug: "bods", sentBox: bbox, sample: xml.slice(0, 4000), bytes: xml.length });
  }

  const vehicles = [];
  // Each vehicle is one <VehicleActivity>...</VehicleActivity> block.
  const blocks = xml.split("<VehicleActivity>").slice(1);
  for (const raw of blocks) {
    const block = raw.split("</VehicleActivity>")[0];
    const tag = (name) => {
      const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
      return m ? m[1].trim() : null;
    };
    const vlat = parseFloat(tag("Latitude"));
    const vlon = parseFloat(tag("Longitude"));
    if (!Number.isFinite(vlat) || !Number.isFinite(vlon)) continue;

    const recorded = tag("RecordedAtTime");
    let ageSec = null;
    if (recorded) {
      const t = Date.parse(recorded);
      if (Number.isFinite(t)) ageSec = Math.max(0, Math.round((Date.now() - t) / 1000));
    }
    // Stale positions are noise, not liveness. Anything older than 10 minutes
    // is dropped rather than shown as "live".
    if (ageSec !== null && ageSec > 600) continue;

    vehicles.push({
      line: tag("PublishedLineName") || tag("LineRef") || "?",
      operator: tag("OperatorRef"),
      origin: tag("OriginName"),
      destination: tag("DestinationName"),
      lat: vlat,
      lon: vlon,
      bearing: parseFloat(tag("Bearing")) || null,
      metres: Math.round(haversine(lat, lon, vlat, vlon)),
      ageSec,
    });
  }

  vehicles.sort((a, b) => a.metres - b.metres);

  return json(
    {
      available: true,
      source: "bods",
      note: "Live vehicle positions from BODS. BODS does not provide arrival predictions.",
      count: vehicles.length,
      vehicles: vehicles.slice(0, 20),
    },
    200,
    { "cache-control": "public, max-age=20, s-maxage=20" }
  );
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1);
  const dLon = toR(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
