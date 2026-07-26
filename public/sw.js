const SHELL = "commuter-v5";
const FILES = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.webmanifest"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.startsWith("/api/")) return;
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(SHELL).then((ca) => ca.put(e.request, c)).catch(() => {}); return r; }).catch(() => caches.match(e.request)));
});
