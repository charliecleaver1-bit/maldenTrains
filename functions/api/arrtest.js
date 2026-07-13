/**
 * PROBE — GET /api/arrtest?at=WAT&from=NEM
 * Finds which RDM slug serves the ARRIVALS board, which is what the
 * "formed by" inference needs (trains terminating at your train's origin).
 */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const at = (url.searchParams.get("at") || "WAT").toUpperCase();
  const key = env.LDB_ARR_KEY || env.LDB_SVC_KEY || env.LDB_KEY;
  if (!key) return json({ error: "No key set" }, 503);

  const headers = { "x-apikey": key, accept: "application/json" };
  const slugs = [
    "1010-live-arrival-board-arr1_2",
    "1010-live-departure-board-arr1_2",
    "1011-live-arrival-board-arr1_2",
    "1010-arrivals1_2",
    "1010-live-arrival-board1_2",
    "1010-live-departure-board-dep1_2",
  ];
  const ops = ["GetArrBoardWithDetails", "GetArrivalBoard"];

  const results = {};
  for (const slug of slugs) {
    for (const op of ops) {
      const u = `https://api1.raildata.org.uk/${slug}/LDBWS/api/20220120/${op}/${at}?numRows=10`;
      try {
        const r = await fetch(u, { headers });
        const body = await r.text();
        const label = `${slug} :: ${op}`;
        if (r.ok) {
          const d = JSON.parse(body || "{}");
          return json({ found: slug, op, url: u,
            sample: (d.trainServices || []).slice(0, 3).map(s => ({
              origin: s.origin && s.origin[0] && s.origin[0].locationName,
              sta: s.sta, eta: s.eta, platform: s.platform,
            })) });
        }
        results[label] = { status: r.status, body: body.slice(0, 90) };
      } catch (e) { results[`${slug} :: ${op}`] = { error: String(e).slice(0, 60) }; }
    }
  }
  return json({ found: null, note: "Subscribe to the Arrivals product on raildata.org.uk and send me its URL.", results });
}

function json(b, s = 200) {
  return new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
}
