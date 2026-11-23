const SW_VERSION = "v11.1.0";
const CACHE_NAME = "feelcue-v11.1";
const NAV_TIMEOUT_MS = 4000;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-512-maskable.png",
  "./apple-touch-icon.png",
];

const MANAGED_PREFIXES = ["feelcue-", "spotifymore-", "mindpaper-"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          CORE_ASSETS.map((asset) =>
            cache.add(new Request(asset, { cache: "reload" })),
          ),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                key !== CACHE_NAME &&
                MANAGED_PREFIXES.some((prefix) => key.startsWith(prefix)),
            )
            .map((key) => caches.delete(key)),
        ),
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
      reject(new Error("Network timeout"));
    }, ms);

    fetch(request, { signal: controller.signal })
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

function isCacheableResponse(response) {
  return (
    response &&
    response.status === 200 &&
    response.type === "basic" &&
    !response.redirected
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // 1. Never intercept non-GET requests (POST to Edge Functions, Auth, Stripe, etc.)
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // 2. Never intercept cross-origin APIs (Supabase, Stripe, iTunes, CDNs)
  if (url.origin !== self.location.origin) return;

  // 3. Never cache sw.js itself so updates roll out immediately
  if (url.pathname.endsWith("/sw.js")) return;

  // 4. HTML navigations: Network-First with timeout, fallback to cached ./index.html
  if (request.mode === "navigate") {
    event.respondWith(
      fetchWithTimeout(request, NAV_TIMEOUT_MS)
        .then((networkRes) => {
          if (isCacheableResponse(networkRes)) {
            const copy = networkRes.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy)),
            );
          }
          return networkRes;
        })
        .catch(async () => {
          const cached =
            (await caches.match(request, { ignoreSearch: true })) ||
            (await caches.match("./index.html")) ||
            (await caches.match("./"));
          return cached || Response.error();
        }),
    );
    return;
  }

  // 5. Same-origin static assets: Stale-While-Revalidate
  event.respondWith(
    caches.match(request).then((cachedRes) => {
      const networkFetch = fetch(request)
        .then((networkRes) => {
          if (isCacheableResponse(networkRes)) {
            const copy = networkRes.clone();
            event.waitUntil(
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)),
            );
          }
          return networkRes;
        })
        .catch(() => cachedRes);

      return cachedRes || networkFetch;
    }),
  );
});
