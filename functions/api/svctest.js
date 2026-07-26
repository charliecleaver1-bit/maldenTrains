/**
 * PROBE — GET /api/svctest?id=<serviceID>
 * Finds which RDM slug/path serves GetServiceDetails for your subscription.
 */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Pass ?id=<serviceID> from /api/board" }, 400);
  if (!env.LDB_KEY) return json({ error: "LDB_KEY not set" }, 503);

  const headers = { "x-apikey": env.LDB_KEY, accept: "application/json" };
  const enc = encodeURIComponent(id);

  // Same slug as the board, plus the other slugs RDM commonly uses for details.
  const slugs = [
    "1010-live-departure-board-dep1_2",
    "1010-live-departure-board-dep",
    "1011-live-departure-board-arr1_2",
    "1012-live-departure-board-service-details1_2",
    "1012-live-departure-board-service-details",
    "1013-live-departure-board-service-details1_2",
  ];

  const results = {};
  for (const slug of slugs) {
    const u = `https://api1.raildata.org.uk/${slug}/LDBWS/api/20220120/GetServiceDetails/${enc}`;
    try {
      const r = await fetch(u, { headers });
      const body = await r.text();
      results[slug] = {
        status: r.status,
        ok: r.ok,
        sample: r.ok ? Object.keys(JSON.parse(body || "{}")) : body.slice(0, 120),
      };
      if (r.ok) return json({ found: slug, url: u, keys: results[slug].sample, results });
    } catch (e) {
      results[slug] = { error: String(e).slice(0, 80) };
    }
  }
  return json({ found: null, note: "No slug worked — you may need to subscribe to the Service Details product on raildata.org.uk", results });
}

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
}
