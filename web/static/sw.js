// AqarChat service worker (scope /app/). The version and asset list are filled in by web/assets.js.
"use strict";
const VERSION = "__VERSION__";
const CACHE = `aqarchat-${VERSION}`;
const ASSETS = __ASSETS__;
const OFFLINE = "/app/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll([...ASSETS, OFFLINE])).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("aqarchat-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Only same-origin GETs under /app/ are handled; everything else (POSTs, other paths) goes to the network.
  if (req.method !== "GET" || url.origin !== self.location.origin || !url.pathname.startsWith("/app/")) return;
  if (url.pathname.startsWith("/app/static/")) {
    event.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }
  // Pages are private and always fresh: network only, the offline page when there is no network.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
  }
});

// Web push: payloads carry only a title, a short body and an /app/ URL (lib/channels/webpush.js).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const url = typeof data.url === "string" && data.url.startsWith("/app/") ? data.url : "/app/notifications";
  event.waitUntil(
    self.registration.showNotification(data.title || "AqarChat", { body: data.body || "", data: { url }, icon: "/app/static/icons/icon-192.png", badge: "/app/static/icons/icon-192.png" })
  );
});

// A click opens only pages of this site under /app/.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/app/notifications";
  const url = new URL(raw, self.location.origin);
  const target = url.origin === self.location.origin && url.pathname.startsWith("/app/") ? url.href : `${self.location.origin}/app/notifications`;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url === target && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
