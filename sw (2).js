const SW_VERSION = 'v10';
const CACHE_NAME = 'spotifymore-v10-cache';
const CACHE_PREFIX = 'spotifymore-';
const LEGACY_PREFIX = 'mindpaper-';
const NAV_TIMEOUT_MS = 4000;

const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png'
];

const STATIC_EXT_RE = /\.(?:png|jpg|jpeg|svg|webp|ico|json)$/i;

function scopedUrl(relPath) {
  return new URL(relPath, self.registration.scope).href;
}

function isCacheable(res) {
  return Boolean(res && res.status === 200 && res.type === 'basic');
}

function fetchFreshWithTimeout(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => {
      if (ctrl) ctrl.abort();
      reject(new Error('sw-nav-timeout'));
    }, timeoutMs);

    const opts = { cache: 'no-cache' };
    if (ctrl) opts.signal = ctrl.signal;

    fetch(request, opts)
      .then(res => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        CORE_ASSETS.map(rel => {
          const req = new Request(scopedUrl(rel), { cache: 'reload' });
          return fetch(req).then(res => {
            if (isCacheable(res)) return cache.put(scopedUrl(rel), res);
          });
        })
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => {
            const lower = key.toLowerCase();
            return key !== CACHE_NAME && (lower.startsWith(CACHE_PREFIX) || lower.startsWith(LEGACY_PREFIX));
          })
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: SW_VERSION, cache: CACHE_NAME });
  }
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1. Strictly bypass cross-origin APIs (Supabase Edge/REST, iTunes media, Spotify)
  if (url.origin !== self.location.origin) return;

  // 2. Never intercept or cache the service worker script itself
  if (url.pathname.endsWith('/sw.js')) return;

  // 3. Page navigations: Network-first bypassing GitHub's 10-min max-age=600 cache,
  //    with 4s lie-fi timeout falling back cleanly to the cached offline app shell
  if (req.mode === 'navigate') {
    const indexKey = scopedUrl('./index.html');
    const rootKey = scopedUrl('./');
    event.respondWith(
      fetchFreshWithTimeout(req, NAV_TIMEOUT_MS)
        .then(res => {
          if (isCacheable(res)) {
            const c1 = res.clone();
            const c2 = res.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(indexKey, c1);
              cache.put(rootKey, c2);
            });
          }
          return res;
        })
        .catch(() =>
          caches.open(CACHE_NAME).then(cache =>
            cache.match(indexKey, { ignoreSearch: true })
              .then(hit => hit || cache.match(rootKey, { ignoreSearch: true }))
              .then(hit => hit || caches.match(req, { ignoreSearch: true }))
          )
        )
    );
    return;
  }

  // 4. Static icons & manifest: Stale-while-revalidate for 0ms startup + silent refresh
  if (STATIC_EXT_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(req, { ignoreSearch: true }).then(cached => {
          const networkUpdate = fetch(req, { cache: 'no-cache' })
            .then(res => {
              if (isCacheable(res)) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || networkUpdate;
        })
      )
    );
    return;
  }

  // 5. Any other same-origin static asset: Network-first with offline fallback
  event.respondWith(
    fetch(req, { cache: 'no-cache' })
      .then(res => {
        if (isCacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
