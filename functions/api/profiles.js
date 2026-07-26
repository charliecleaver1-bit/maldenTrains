// /api/profiles — anonymous, device-keyed commute storage (JSON blob).
//
// Identity is one header the client sends on every request:
//   X-Device-Id: <uuid minted client-side on first run>
// No login, no email, no name. The whole commute (legs + alert windows) is stored
// as a single JSON document per device — simpler than column-mapping and free to
// evolve as the model changes.
//
// GET    -> { profiles: [ <commute> ] }   (array kept for client compatibility)
// PUT    -> body { profiles: [ <commute> ] }; stores profiles[0]
// DELETE -> erase everything for this device
//
// Binding required: env.DB (D1). Table (create once in the D1 console):
//   CREATE TABLE IF NOT EXISTS commute_blob (device_id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at TEXT);

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function deviceId(request) {
  const id = request.headers.get("X-Device-Id");
  if (!id || !/^[0-9a-z-]{10,}$/i.test(id)) return null;
  return id;
}

export async function onRequest(context) {
  const { request, env } = context;
  const device = deviceId(request);
  if (!device) return json({ error: "Missing or malformed X-Device-Id" }, 400);
  if (!env.DB) return json({ error: "D1 binding 'DB' not configured" }, 500);

  // Make sure the table exists (idempotent; cheap).
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS commute_blob (device_id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated_at TEXT)"
  ).run();

  if (request.method === "GET") {
    const row = await env.DB.prepare("SELECT doc FROM commute_blob WHERE device_id = ?").bind(device).first();
    if (!row) return json({ profiles: [] });
    let doc;
    try { doc = JSON.parse(row.doc); } catch (e) { doc = null; }
    return json({ profiles: doc ? [doc] : [] });
  }

  if (request.method === "PUT") {
    const bodyIn = await request.json().catch(() => null);
    if (!bodyIn?.profiles) return json({ error: "Body must be { profiles: [...] }" }, 400);
    const doc = bodyIn.profiles[0] || { legs: [], alerts: [] };
    await env.DB.prepare(
      "INSERT INTO commute_blob(device_id, doc, updated_at) VALUES (?,?,?) " +
      "ON CONFLICT(device_id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at"
    ).bind(device, JSON.stringify(doc), new Date().toISOString()).run();
    return json({ ok: true });
  }

  if (request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM commute_blob WHERE device_id = ?").bind(device).run();
    return json({ ok: true, erased: true });
  }

  return json({ error: "Method not allowed" }, 405);
}
