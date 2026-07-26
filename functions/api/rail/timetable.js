// GET /api/rail/timetable?from=NEM&to=WAT&when=07:00&day=MO&span=90
//
// Returns scheduled DIRECT departures from 'from' that later call at 'to', around
// 'when', on weekday 'day', reading the ingested national timetable in D1.
// Unlike the live board this works at ANY hour of day.
//
//   from,to : CRS codes
//   when    : 'HH:MM' centre of the window (default now)
//   day     : MO|TU|WE|TH|FR|SA|SU (default: today)
//   span    : +/- minutes around 'when' (default 90)
//
// Requires the tt_* tables populated by the ingest (schema.timetable.sql).

const DAY_INDEX = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

// Cached across requests on the same isolate (same pattern as the token caches
// elsewhere in this codebase) — avoids a COUNT(*) on every call, only checked when
// a specific query comes back empty and we need to know whether that's real or just
// an unpopulated table.
let tableEmptyCache = null;

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...extra },
  });
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const pad = (n) => String(n).padStart(2, "0");
const fromMin = (min) => `${pad(Math.floor((min % 1440) / 60))}:${pad(min % 60)}`;

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const day = url.searchParams.get("day") || ["SU","MO","TU","WE","TH","FR","SA"][new Date().getDay()];
  const when = url.searchParams.get("when") || fromMin(new Date().getHours() * 60 + new Date().getMinutes());
  const span = Math.min(Number(url.searchParams.get("span")) || 90, 240);

  if (!from || !to) return json({ error: "Need 'from' and 'to' CRS codes" }, 400);
  if (!env.DB) return json({ error: "D1 binding 'DB' not configured" }, 500);
  const di = DAY_INDEX[day];
  if (di === undefined) return json({ error: "day must be MO..SU" }, 400);

  const centre = toMin(when);
  const lo = fromMin((centre - span + 1440) % 1440);
  const hi = fromMin((centre + span) % 1440);

  // Find schedules that (a) run on this weekday, (b) depart 'from' in the window,
  // and (c) call at 'to' LATER in the same schedule (i.e. a direct service).
  // We join calling points to themselves: cp_from (departure) and cp_to (later arrival).
  const today = new Date().toISOString().slice(0, 10);
  const q = `
    SELECT cf.dep_time AS dep, ct.arr_time AS arr, cf.platform AS platform,
           s.toc AS toc, s.train_uid AS uid
    FROM tt_calling_point cf
    JOIN tt_schedule s      ON s.id = cf.schedule_id
    JOIN tt_calling_point ct ON ct.schedule_id = cf.schedule_id AND ct.seq > cf.seq
    WHERE cf.crs = ?1 AND ct.crs = ?2
      AND cf.dep_time IS NOT NULL
      AND substr(s.days_run, ?3, 1) = '1'
      AND date(?4) BETWEEN date(s.runs_from) AND date(s.runs_to)
      AND (
            (?5 <= ?6 AND cf.dep_time >= ?5 AND cf.dep_time <= ?6) OR
            (?5 >  ?6 AND (cf.dep_time >= ?5 OR cf.dep_time <= ?6))   -- window wraps midnight
          )
    ORDER BY cf.dep_time
    LIMIT 40`;

  try {
    const rows = await env.DB.prepare(q)
      .bind(from, to, di + 1, today, lo, hi)
      .all();

    // Collapse STP overlays/cancellations simply by de-duping on dep_time (keep first).
    const seen = new Set();
    const services = [];
    for (const r of rows.results) {
      if (seen.has(r.dep)) continue;
      seen.add(r.dep);
      services.push({ std: r.dep, arr: r.arr, platform: r.platform, operator: r.toc, uid: r.uid });
    }

    // An empty result here is ambiguous: it could mean "genuinely no direct service in
    // this window", or it could mean the tt_* tables were never actually populated by
    // an ingest run (this repo doesn't include one). Trusting the latter as "no direct
    // train" is exactly the false-negative bug — check whether the table has ANY data
    // at all before treating "empty" as a real answer, and only do that extra check
    // when we actually need to (i.e. this query came back empty).
    if (services.length === 0) {
      if (tableEmptyCache === null) {
        try {
          const c = await env.DB.prepare("SELECT COUNT(*) AS n FROM tt_schedule").first();
          tableEmptyCache = !c || !c.n;
        } catch (e) {
          tableEmptyCache = true; // table doesn't exist / query failed — treat as "no data"
        }
      }
      if (tableEmptyCache) {
        return json({ from, to, day, when, span, count: 0, services: [], dataAvailable: false });
      }
    }

    return json(
      { from, to, day, when, span, count: services.length, services, dataAvailable: true },
      200,
      { "Cache-Control": "public, max-age=3600" }
    );
  } catch (e) {
    // Table missing entirely, or query failed for some other reason — same "we don't
    // actually have timetable data to check against" signal.
    return json({ error: "Timetable query failed", detail: String(e), dataAvailable: false }, 200);
  }
}
