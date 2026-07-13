/**
 * Cloudflare Pages Function — GET /api/ldbtest?from=NEM&to=WAT
 * -----------------------------------------------------------
 * PROBE ONLY. Calls Darwin LDBWS (via the Rail Data Marketplace) and reports
 * what comes back, so we can verify the shape before migrating the real board
 * off Realtime Trains. Nothing else in the app uses this.
 *
 * Needs LDB_KEY (your RDM *consumer key*) in Pages → Variables & Secrets.
 *
 *   ?raw=1   -> dump the untouched JSON for the first service
 */

const BASE = "https://api1.raildata.org.uk/1010-live-departure-board-dep/LDBWS/api/20220120";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const from = (url.searchParams.get("from") || "NEM").toUpperCase();
  const to = (url.searchParams.get("to") || "WAT").toUpperCase();
  const raw = url.searchParams.get("raw");

  if (!env.LDB_KEY) {
    return json({ error: "LDB_KEY not set. Add your RDM consumer key in Pages → Variables & Secrets." }, 503);
  }

  const q = `${BASE}/GetDepBoardWithDetails/${from}` +
    `?numRows=10&filterCrs=${to}&filterType=to&timeOffset=0&timeWindow=120`;

  let r, body;
  try {
    r = await fetch(q, { headers: { "x-apikey": env.LDB_KEY, accept: "application/json" } });
    body = await r.text();
  } catch (e) {
    return json({ error: "Could not reach LDBWS.", detail: String(e) }, 502);
  }

  if (!r.ok) {
    return json({ error: `LDBWS HTTP ${r.status}`, hint: hintFor(r.status), body: body.slice(0, 400) }, 502);
  }

  let d;
  try { d = JSON.parse(body); }
  catch (e) { return json({ error: "Response was not JSON.", body: body.slice(0, 400) }, 502); }

  const services = d.trainServices || [];
  if (raw) return json({ raw: true, firstService: services[0] || null, topLevelKeys: Object.keys(d) });

  // Summarise what we'd need for the migration.
  const rows = services.slice(0, 8).map((s) => {
    const calls = (s.subsequentCallingPoints && s.subsequentCallingPoints[0] && s.subsequentCallingPoints[0].callingPoint) || [];
    const target = calls.find((c) => (c.crs || "").toUpperCase() === to);
    return {
      std: s.std, etd: s.etd, platform: s.platform || null,
      destination: (s.destination && s.destination[0] && s.destination[0].locationName) || null,
      operator: s.operator, isCancelled: !!s.isCancelled,
      delayReason: s.delayReason || null, cancelReason: s.cancelReason || null,
      length: s.length || null,
      serviceIdPresent: !!s.serviceID,
      callingPointCount: calls.length,
      arrivesAtTarget: target ? { st: target.st, et: target.et, at: target.at } : null,
      callingPoints: calls.map((c) => `${c.locationName} ${c.st}${c.et && c.et !== "On time" ? " (" + c.et + ")" : ""}`),
    };
  });

  return json({
    ok: true, from, to,
    locationName: d.locationName, crs: d.crs,
    platformAvailable: d.platformAvailable,
    generatedAt: d.generatedAt,
    nrccMessages: (d.nrccMessages || []).map((m) => String(m.value || m._ || "").replace(/<[^>]+>/g, "").trim()).filter(Boolean),
    serviceCount: services.length,
    serviceKeys: services[0] ? Object.keys(services[0]) : [],
    rows,
  });
}

function hintFor(status) {
  if (status === 401 || status === 403) return "Key rejected — check you used the CONSUMER KEY (not the secret), and that you're subscribed to the Live Departure Board product.";
  if (status === 404) return "Endpoint or CRS not found — check the station code.";
  if (status === 429) return "Rate limited — wait a moment.";
  return "";
}

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}
