// Just enough service worker to open without a connection.
//
// Deliberately tiny. It caches the shell - the page, its script, its
// stylesheet - and nothing else. Photos are NOT its business: they
// live in IndexedDB, which survives on its own and does not need a
// cache layer in front of it.
//
// Network-first, falling back to cache. A stale-while-revalidate
// strategy would be faster but would let an old app.js keep running
// after a fix has shipped, and this is a page people open once a week.

const CACHE = "records-shell-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./lib/auth.js",
  "./lib/drive.js",
  "./lib/normalize.js",
  "./lib/queue.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, not addAll: addAll rejects the whole install if
      // any single file 404s, which turns one typo into an app that
      // silently never caches anything.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only our own shell. Drive uploads and the Google sign-in script
  // must never be touched by a cache - serving a stale token endpoint
  // or a cached API response would be actively harmful.
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match("./index.html"))),
  );
});
