/**
 * Minimal Web Push sender for Cloudflare Workers / Pages Functions.
 *
 * Implements, from the standards and nothing else (no npm deps, because
 * direct-upload Pages deploys can't bundle external packages):
 *   - RFC 8291 message encryption (aes128gcm)
 *   - RFC 8188 content encoding framing
 *   - RFC 8292 VAPID auth (ES256 JWT)
 *
 * Uses only WebCrypto, which Workers and Node 18+ both provide, so the whole
 * pipeline is testable in Node before it ever runs at the edge.
 *
 * sendPush(subscription, payloadObject, env) -> { ok, status }
 *   subscription: { endpoint, keys: { p256dh, auth } }  (from the browser)
 *   env needs: VAPID_PUBLIC, VAPID_PRIVATE (base64url), VAPID_SUBJECT (mailto:)
 */

const te = new TextEncoder();

/* ---------- base64url helpers ---------- */
export function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64u(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

/* ---------- HKDF (via WebCrypto) ---------- */
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/* ---------- RFC 8291 encryption ---------- */
export async function encryptPayload(subscription, plaintext) {
  const uaPublic = b64uToBytes(subscription.keys.p256dh);   // 65 bytes, uncompressed point
  const authSecret = b64uToBytes(subscription.keys.auth);   // 16 bytes

  // ephemeral application-server ECDH keypair for this message
  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  // RFC 8291 key schedule
  const keyInfo = concat(te.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  // RFC 8188: single record, padding delimiter 0x02 for the last record
  const padded = concat(te.encode(plaintext), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  // aes128gcm body header: salt(16) | rs(4) | idlen(1) | keyid(=as_public, 65)
  const rs = new Uint8Array([0, 0, 16, 0]);                 // 4096
  const header = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ciphertext);
}

/* ---------- RFC 8292 VAPID ---------- */
async function vapidJwt(audience, env) {
  const pub = b64uToBytes(env.VAPID_PUBLIC);                // 65 bytes
  const d = env.VAPID_PRIVATE;                              // base64url, 32 bytes
  const x = bytesToB64u(pub.slice(1, 33));
  const y = bytesToB64u(pub.slice(33, 65));
  const jwk = { kty: "EC", crv: "P-256", d, x, y };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const now = Math.floor(Date.now() / 1000);
  const head = bytesToB64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64u(te.encode(JSON.stringify({
    aud: audience, exp: now + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
  })));
  const unsigned = `${head}.${body}`;
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, te.encode(unsigned)));
  return `${unsigned}.${bytesToB64u(sig)}`;                 // WebCrypto gives raw r||s, as JWT wants
}

/* ---------- send ---------- */
export async function sendPush(subscription, payload, env, ttl = 300) {
  const body = await encryptPayload(subscription, JSON.stringify(payload));
  const aud = new URL(subscription.endpoint).origin;
  const jwt = await vapidJwt(aud, env);

  const r = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      "ttl": String(ttl),
      "urgency": "high",
      "authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC}`,
    },
    body,
  });
  // 201 = accepted. 404/410 = subscription dead, caller should prune it.
  return { ok: r.status === 201 || r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
}
