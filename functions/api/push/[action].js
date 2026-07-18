/**
 * Push notification plumbing (Pages Functions).
 *
 *   GET  /api/push/config              -> { publicKey, dbReady }
 *   POST /api/push/subscribe           -> store this device's subscription
 *   POST /api/push/watch               -> create/update/delete a watch
 *   GET  /api/push/watch?endpoint=...  -> list this device's watches
 *   POST /api/push/test                -> send a test notification to this device
 *
 * Needs, in Cloudflare Pages (Production + Preview):
 *   - D1 binding named DB (the existing "commuter" database is fine)
 *   - VAPID_PUBLIC / VAPID_PRIVATE / VAPID_SUBJECT  (from gen-vapid.mjs)
 *
 * Tables are created on first use, so there is no manual schema step.
 * Subscriptions are keyed by a hash of their endpoint URL; the endpoint is a
 * capability URL so it is never logged or returned in full.
 */
import { sendPush } from "../../_lib/webpush.js";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS push_subs (
     id TEXT PRIMARY KEY,               -- sha256(endpoint), hex
     endpoint TEXT NOT NULL,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS push_watches (
     id TEXT PRIMARY KEY,               -- sub_id : kind : jid
     sub_id TEXT NOT NULL,
     kind TEXT NOT NULL,                -- 'rail' | 'tube'
     jid TEXT NOT NULL,                 -- the saved journey's stable id
     grp TEXT,                          -- commute jid when belled via a commute
     label TEXT NOT NULL,
     a TEXT, b TEXT,                    -- rail: from/to CRS
     lines TEXT,                        -- tube: comma-separated line ids
     days TEXT NOT NULL,                -- 7 chars Mon..Sun, '1'=on
     start_hm TEXT NOT NULL,            -- '0630'
     end_hm TEXT NOT NULL,              -- '0930'
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS push_state (
     id TEXT PRIMARY KEY,               -- watch_id : service/line key
     watch_id TEXT NOT NULL,
     status TEXT NOT NULL,              -- last state we told the user about
     sent_at INTEGER NOT NULL
   )`,
];

async function ensureSchema(db) {
  for (const q of SCHEMA) await db.prepare(q).run();
}
async function subId(endpoint) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function onRequest({ request, env, params }) {
  const action = params.action;           // config | subscribe | watch | test
  if (!env.DB) {
    if (action === "config") return json({ publicKey: env.VAPID_PUBLIC || null, dbReady: false });
    return json({ error: "No D1 binding named DB on this Pages project." }, 500);
  }
  await ensureSchema(env.DB);

  if (action === "config" && request.method === "GET") {
    return json({ publicKey: env.VAPID_PUBLIC || null, dbReady: true, vapidReady: !!(env.VAPID_PUBLIC && env.VAPID_PRIVATE) });
  }

  if (action === "subscribe" && request.method === "POST") {
    const { subscription } = await request.json();
    if (!subscription || !subscription.endpoint || !subscription.keys) return json({ error: "Bad subscription." }, 400);
    const id = await subId(subscription.endpoint);
    await env.DB.prepare(
      `INSERT INTO push_subs (id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`
    ).bind(id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now()).run();
    return json({ ok: true, subId: id });
  }

  if (action === "watch") {
    if (request.method === "GET") {
      const endpoint = new URL(request.url).searchParams.get("endpoint");
      if (!endpoint) return json({ error: "endpoint required" }, 400);
      const id = await subId(endpoint);
      const rows = await env.DB.prepare(`SELECT * FROM push_watches WHERE sub_id=?`).bind(id).all();
      return json({ watches: rows.results || [] });
    }
    if (request.method === "POST") {
      const w = await request.json();
      if (!w.endpoint || !w.kind || !w.jid) return json({ error: "endpoint, kind, jid required" }, 400);
      const sid = await subId(w.endpoint);
      const wid = `${sid}:${w.kind}:${w.jid}`;
      if (w.delete) {
        await env.DB.prepare(`DELETE FROM push_watches WHERE id=?`).bind(wid).run();
        await env.DB.prepare(`DELETE FROM push_state WHERE watch_id=?`).bind(wid).run();
        return json({ ok: true, deleted: true });
      }
      const days = /^[01]{7}$/.test(w.days || "") ? w.days : "1111100";
      const hm = (v, dflt) => (/^\d{4}$/.test(v || "") ? v : dflt);
      await env.DB.prepare(
        `INSERT INTO push_watches (id, sub_id, kind, jid, grp, label, a, b, lines, days, start_hm, end_hm, enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
         ON CONFLICT(id) DO UPDATE SET grp=excluded.grp, label=excluded.label, a=excluded.a, b=excluded.b,
           lines=excluded.lines, days=excluded.days, start_hm=excluded.start_hm, end_hm=excluded.end_hm, enabled=1`
      ).bind(wid, sid, w.kind, w.jid, w.grp || null, String(w.label || "").slice(0, 60),
        w.a || null, w.b || null, w.lines || null, days, hm(w.start, "0630"), hm(w.end, "0930"), Date.now()).run();
      return json({ ok: true, id: wid });
    }
  }

  if (action === "test" && request.method === "POST") {
    if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return json({ error: "VAPID keys not configured." }, 500);
    const { endpoint } = await request.json();
    const id = await subId(endpoint || "");
    const row = await env.DB.prepare(`SELECT * FROM push_subs WHERE id=?`).bind(id).first();
    if (!row) return json({ error: "This device isn't subscribed yet." }, 404);
    const res = await sendPush(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      { title: "Commuter alerts are working", body: "This is your test notification. Delays and cancellations will look like this.", tag: "test" },
      env
    );
    if (res.gone) {
      await env.DB.prepare(`DELETE FROM push_subs WHERE id=?`).bind(id).run();
      return json({ error: "Subscription expired. Re-enable notifications.", status: res.status }, 410);
    }
    return json({ ok: res.ok, status: res.status });
  }

  return json({ error: "Not found." }, 404);
}
