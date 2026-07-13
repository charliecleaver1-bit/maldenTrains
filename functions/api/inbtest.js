/**
 * PROBE — GET /api/inbtest?at=WAT&time=17:44
 * Shows each step of the "likely formed by" inference so we can see which
 * one is failing: arrivals access, platform lookup, or candidate matching.
 */
const DEP_BASE = "https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120";
const ARR_BASE = "https://api1.raildata.org.uk/1010-live-arrival-board-arr/LDBWS/api/20220120";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const at = (url.searchParams.get("at") || "WAT").toUpperCase();
  const wantTime = url.searchParams.get("time"); // optional "HH:MM" of a departure

  const depKey = env.LDB_KEY;
  const arrKey = env.LDB_ARR_KEY || env.LDB_KEY;
  const out = { at, keys: { LDB_KEY: !!env.LDB_KEY, LDB_ARR_KEY: !!env.LDB_ARR_KEY, LDB_SVC_KEY: !!env.LDB_SVC_KEY } };

  // STEP 1 — can we read the ARRIVALS board at all?
  const arrUrl = `${ARR_BASE}/GetArrBoardWithDetails/${at}?numRows=20&timeOffset=-40&timeWindow=45`;
  const arrRes = await probe(arrUrl, arrKey);
  out.step1_arrivals = {
    url: arrUrl,
    status: arrRes.status,
    error: arrRes.error || null,
    count: arrRes.json ? (arrRes.json.trainServices || []).length : 0,
    sample: arrRes.json ? (arrRes.json.trainServices || []).slice(0, 6).map(s => ({
      from: s.origin && s.origin[0] && s.origin[0].locationName,
      dest: s.destination && s.destination[0] && s.destination[0].locationName,
      sta: s.sta, eta: s.eta, platform: s.platform || null,
    })) : arrRes.body,
  };

  // STEP 2 — can we read the DEPARTURES board (for our train's platform)?
  const depUrl = `${DEP_BASE}/GetDepBoardWithDetails/${at}?numRows=10&timeOffset=-15&timeWindow=60`;
  const depRes = await probe(depUrl, depKey);
  out.step2_departures = {
    status: depRes.status,
    count: depRes.json ? (depRes.json.trainServices || []).length : 0,
    sample: depRes.json ? (depRes.json.trainServices || []).slice(0, 6).map(s => ({
      std: s.std, dest: s.destination && s.destination[0] && s.destination[0].locationName,
      platform: s.platform || null,
    })) : depRes.body,
  };

  // STEP 3 — for a chosen departure, which arrivals match the same platform?
  if (wantTime && depRes.json && arrRes.json) {
    const ours = (depRes.json.trainServices || []).find(s => s.std === wantTime);
    const platform = ours && ours.platform ? String(ours.platform) : null;
    const cands = (arrRes.json.trainServices || []).map(s => {
      const sta = clock(s.eta) || clock(s.sta);
      const gap = sta ? mins(sta, wantTime) : null;
      return {
        from: s.origin && s.origin[0] && s.origin[0].locationName,
        sta: s.sta, eta: s.eta, platform: s.platform || null, gapMins: gap,
        samePlatform: platform && String(s.platform) === platform,
        inWindow: gap !== null && gap >= 2 && gap <= 35,
      };
    });
    out.step3_match = {
      ourDeparture: wantTime,
      ourPlatform: platform,
      note: platform ? null : "No platform on our departure — inference can't run.",
      matches: cands.filter(c => c.samePlatform && c.inWindow),
      allCandidates: cands,
    };
  } else {
    out.step3_match = "Pass &time=HH:MM (a departure time from step 2) to test matching.";
  }

  return json(out);
}

async function probe(url, key) {
  if (!key) return { status: 0, error: "no key" };
  try {
    const r = await fetch(url, { headers: { "x-apikey": key, accept: "application/json" } });
    const body = await r.text();
    if (!r.ok) return { status: r.status, body: body.slice(0, 200) };
    try { return { status: 200, json: JSON.parse(body) }; }
    catch (e) { return { status: 200, body: body.slice(0, 200) }; }
  } catch (e) { return { status: 0, error: String(e).slice(0, 120) }; }
}
function clock(v) { return (typeof v === "string" && /^\d{2}:\d{2}$/.test(v)) ? v : null; }
function mins(a, b) {
  const m = t => (+t.slice(0, 2)) * 60 + (+t.slice(3, 5));
  let d = m(b) - m(a); if (d < -720) d += 1440; if (d > 720) d -= 1440; return d;
}
function json(b) { return new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } }); }
