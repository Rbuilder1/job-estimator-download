// Job Estimator web app: works offline, and picks up a new version as soon as it's online.
const CACHE = "je-f51e9e6ed3", FILES = ["./", "index.html", "prompts.js", "web-native.js", "ios-backend.js", "manifest.webmanifest", "apple-touch-icon.png", "icon-192.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;  // Claude calls go straight to the network
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request, {ignoreSearch: true})));
});
