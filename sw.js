/* Commuter service worker — PUSH ONLY, on purpose.
   No fetch handler and no caching: this app must always be live, and cached
   HTML/JS on iOS previously caused exactly the staleness bugs we refuse to
   reintroduce. This worker exists solely to receive push messages and open
   the app when a notification is tapped. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: "Commuter", body: event.data && event.data.text() }; }
  const title = data.title || "Commuter";
  const options = {
    body: data.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    tag: data.tag || "commuter",       // same tag replaces, so updates don't stack
    renotify: !!data.renotify,
    data: { url: data.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if ("focus" in w) { w.navigate(url); return w.focus(); } }
      return self.clients.openWindow(url);
    })
  );
});
