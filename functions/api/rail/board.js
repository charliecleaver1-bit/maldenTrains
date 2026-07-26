// GET /api/rail/board?from=NWM&to=WAT&rows=10
//
// Proxies National Rail's Darwin LDBWS via the Rail Data Marketplace (RDM) REST API
// and returns the same clean JSON shape as the tube/bus proxies.
//
// The old SOAP OpenLDBWS service is retired. RDM serves LDBWS as REST/JSON — no SOAP
// envelope, no XML parsing. You authenticate with an x-apikey header (your RDM
// "consumer key"), not a SOAP token.
//
// Env vars (Cloudflare Pages > Settings > Environment variables):
//   DARWIN_APIKEY  – your RDM consumer key for the "Live Departure Board" product
//
// The product path segment (1010-live-departure-board-dep) and version date (20220120)
// come from the product's Specification tab on RDM — override via env if yours differ.

const RDM_BASE = "https://api1.raildata.org.uk";
const PRODUCT = "1010-live-departure-board-dep1_2"; // LDBWS "Live Departure Board" (departures)
const VERSION = "20220120";

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}

// Darwin etd/std values may be "On time" | "Delayed" | "Cancelled" | "HH:MM" | "HH:MM*"
function classify(etd, isCancelled) {
  if (isCancelled || /cancel/i.test(etd || "")) return "cancelled";
  if (/on time/i.test(etd || "")) return "on_time";
  if (/^\d{2}:\d{2}/.test(etd || "")) return "on_time"; // a concrete expected time that isn't a slip
  if (/delay/i.test(etd || "")) return "delayed";
  return "on_time";
}

// destination/origin come back as arrays of location objects
const firstLoc = (arr) => (Array.isArray(arr) && arr[0] ? arr[0].locationName : null);
// "via" is Darwin's own disambiguation text for services on ambiguous/loop routes (e.g.
// "via Kingston" vs "via Twickenham") — documented as appearing on real departure
// boards specifically to distinguish these cases. Used to filter out the long-way-round
// direction on loop lines (see fetchBoard's rail branch in app.js).
const firstVia = (arr) => (Array.isArray(arr) && arr[0] ? arr[0].via || null : null);

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const rows = Math.min(Number(url.searchParams.get("rows")) || 10, 10); // RDM caps at 10

  if (!from) return json({ error: "Missing 'from' CRS code, e.g. ?from=NWM" }, 400);
  if (!env.DARWIN_APIKEY) return json({ error: "DARWIN_APIKEY not configured on the server" }, 500);

  // Build the REST URL. CRS goes in the path; filters go in the query string.
  const params = new URLSearchParams({ numRows: String(rows) });
  if (to) {
    params.set("filterCrs", to);
    params.set("filterType", "to");
  }
  const win = url.searchParams.get("window");
  if (win) params.set("timeWindow", String(Math.min(Number(win) || 0, 120)));
  const endpoint =
    `${RDM_BASE}/${env.DARWIN_PRODUCT || PRODUCT}/LDBWS/api/${env.DARWIN_VERSION || VERSION}` +
    `/GetDepBoardWithDetails/${from}?${params.toString()}`;

  let data;
  try {
    const resp = await fetch(endpoint, {
      headers: { "x-apikey": env.DARWIN_APIKEY, Accept: "application/json" },
    });
    const text = await resp.text();
    if (!resp.ok) {
      // 401 = key not entitled to this product path (check DARWIN_PRODUCT/DARWIN_VERSION
      //        match your subscribed product's Specification tab, and that it's Approved).
      // 404 = wrong product path or CRS.
      return json(
        { error: "RDM upstream error", status: resp.status, endpoint, detail: text.slice(0, 300) },
        502
      );
    }
    data = JSON.parse(text);
  } catch (e) {
    return json({ error: "Could not reach RDM", detail: String(e) }, 502);
  }

  // RDM returns trainServices as an array (may be absent if no trains).
  const rawServices = Array.isArray(data.trainServices) ? data.trainServices : [];

  const services = rawServices.map((s) => {
    const status = classify(s.etd, s.isCancelled);
    return {
      serviceID: s.serviceID || s.serviceIdPercentEncoded || null,
      std: s.std || null,
      etd: s.etd || null,
      status,
      estimated: /^\d{2}:\d{2}/.test(s.etd || "") ? s.etd.replace("*", "") : null,
      countdown: null, // rail has no live vehicle countdown here; std/etd drive the UI
      platform: s.platform || null,
      operator: s.operator || null,
      delayReason: s.delayReason || null,
      cancelReason: s.cancelReason || null,
      destination: firstLoc(s.destination),
      via: firstVia(s.destination),
      origin: firstLoc(s.origin), // the "formed by" hint
    };
  });

  const nrccMessages = Array.isArray(data.nrccMessages)
    ? data.nrccMessages.map((m) => (typeof m === "string" ? m : m.value || m.xhtmlMessage || "")).filter(Boolean)
    : [];

  return json(
    {
      from,
      to: to || null,
      generatedAt: data.generatedAt || null,
      locationName: data.locationName || from,
      nrccMessages,
      services,
    },
    200,
    { "Cache-Control": "public, max-age=20" }
  );
}
