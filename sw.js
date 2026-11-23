const SW_VERSION = "v11.0.0";
const CACHE_NAME = "feelcue-v11";
const NAV_TIMEOUT_MS = 4000;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

const MANAGED_PREFIXES = ["feelcue-", "spotifymore-", "mindpaper-"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          CORE_ASSETS.map((asset) =>
            cache.add(new Request(asset, { cache: "reload" }))
          ),
        )
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key !== CACHE_NAME &&
                MANAGED_PREFIXES.some((prefix) => key.startsWith(prefix)),
            )
            .map((key) => caches.delete(key)),
        )
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "GET_VERSION" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: SW_VERSION, cache: CACHE_NAME });
  }
});

function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Navigation fetch timed out"));
    }, ms);

    fetch(request, { cache: "no-store", signal: controller.signal })
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Strict cross-origin bypass (Supabase, iTunes previews/art, Spotify)
  if (url.origin !== self.location.origin) return;

  // 1. Navigation requests: network-first with 4s lie-fi timeout
  if (req.mode === "navigate") {
    event.respondWith(
      fetchWithTimeout(req, NAV_TIMEOUT_MS)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put("./index.html", copy));
          }
          return res;
        })
        .catch(() =>
          caches.match("./index.html").then((cached) =>
            cached || caches.match("./")
          )
        ),
    );
    return;
  }

  // 2. Icons & manifest: stale-while-revalidate
  if (
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith("manifest.json")
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(req).then((cached) => {
          const networkPromise = fetch(req)
            .then((res) => {
              if (res && res.ok) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || networkPromise;
        })
      ),
    );
    return;
  }

  // 3. Other same-origin static files: cache fallback to network
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        }
        return res;
      })
    ),
  );
});
