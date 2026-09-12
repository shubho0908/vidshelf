// VidShelf PWA shell: navigation = network-first (fresh index picks up new
// hashed assets), same-origin static = cache-first. Cross-origin (sync worker,
// thumbnails, video providers) always passes through untouched.
const CACHE = "vidshelf-shell-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["./", "./manifest.webmanifest", "./icon-192.png"])));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put("./", cp)); return r; })
        .catch(() => caches.match("./"))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r;
    }))
  );
});
