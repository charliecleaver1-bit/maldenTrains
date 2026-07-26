// GET /api/stations            -> full [{n,c}] list (name, CRS)
// GET /api/stations?q=malden    -> filtered matches for a typeahead (max 20)
//
// Fetches the Trainline open stations dataset live, filters to GB stations with a
// CRS code, and edge-caches the parsed result for 24h so only the first request
// each day does the heavy fetch. If upstream fails, the frontend falls back to
// /stations.fallback.json (bundled) so the picker always works.
//
// Data: Trainline EU open stations (ODbL) — attribute in your about/credits.
// Override the source with env STATIONS_CSV_URL if you host your own mirror.

const DEFAULT_CSV =
  "https://raw.githubusercontent.com/trainline-eu/stations/master/stations.csv";

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

async function loadStations(env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request("https://commuter.internal/stations-cache-v1");
  const hit = await cache.match(cacheKey);
  if (hit) return await hit.json();

  const src = env.STATIONS_CSV_URL || DEFAULT_CSV;
  const resp = await fetch(src, { cf: { cacheTtl: 86400, cacheEverything: true } });
  if (!resp.ok) throw new Error(`stations source ${resp.status}`);
  const text = await resp.text();

  // CSV is ';'-delimited. Columns: 2=name(idx1), 10=country(idx9), 47=CRS(idx46).
  const lines = text.split("\n");
  const seen = new Map();
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(";");
    if (cols.length < 47) continue;
    if (cols[9] !== "GB") continue;
    const crs = (cols[46] || "").trim().toUpperCase();
    const name = (cols[1] || "").trim();
    if (crs.length === 3 && /^[A-Z]{3}$/.test(crs) && name && !seen.has(crs)) {
      seen.set(crs, name);
    }
  }
  const list = [...seen.entries()]
    .map(([c, n]) => ({ n, c }))
    .sort((a, b) => a.n.localeCompare(b.n));

  // Store in edge cache for 24h.
  const toCache = new Response(JSON.stringify(list), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
  });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return list;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();

  let list;
  try {
    list = await loadStations(env, context);
  } catch (e) {
    // Signal the frontend to use its bundled fallback.
    return json({ error: "stations upstream unavailable", detail: String(e), useFallback: true }, 502);
  }

  if (q) {
    const matches = list
      .filter((s) => s.n.toLowerCase().includes(q) || s.c.toLowerCase() === q)
      .slice(0, 20);
    return json({ stations: matches }, 200, { "Cache-Control": "public, max-age=3600" });
  }
  return json({ stations: list }, 200, { "Cache-Control": "public, max-age=86400" });
}
