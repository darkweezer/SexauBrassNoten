// Service Worker: hält die App-Hülle offline verfügbar.
// PDFs werden NICHT hier gecacht, sondern über IndexedDB (siehe app.js).

const CACHE_VERSION = "notenarchiv-v15";
const APP_SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "config.js",
  "drive.js",
  "instruments.js",
  "viewer.js",
  "vendor/pdfjs/pdf.min.mjs",
  "vendor/pdfjs/pdf.worker.min.mjs",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/logo.png",
  "icons/favicon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // Nur eigene Dateien behandeln. Google-Anmeldung und Drive-Downloads laufen direkt ins Netz.
  if (new URL(req.url).origin !== self.location.origin) return;

  // Netz zuerst, damit Änderungen an der App sofort ankommen. Ohne Internet: gespeicherte Kopie.
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
