const CACHE_NAME = 'spotifymore-v8-cache';
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

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        CORE_ASSETS.map(url =>
          cache.add(new Request(url, { cache: 'reload' }))
        )
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
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isCacheable(res) {
  return Boolean(res && res.status === 200 && res.type === 'basic');
}

function fetchWithTimeout(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sw-nav-timeout')), timeoutMs);
    fetch(request, { cache: 'no-cache' })
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

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Strictly bypass cross-origin APIs (Supabase Edge/REST, iTunes previews, Spotify)
  if (url.origin !== self.location.origin) return;

  // 1. Page navigations: Network-first with fast 4s lie-fi timeout, fallback to cached app shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetchWithTimeout(req, NAV_TIMEOUT_MS)
        .then(res => {
          if (isCacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put('./index.html', copy);
            });
          }
          return res;
        })
        .catch(() =>
          caches.match('./index.html', { ignoreSearch: true })
            .then(cached => cached || caches.match('./'))
        )
    );
    return;
  }

  // 2. Icons & manifest: Stale-while-revalidate for instant 0ms UI loads + silent updates
  if (STATIC_EXT_RE.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(req, { ignoreSearch: true }).then(cached => {
          const networkUpdate = fetch(req)
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

  // 3. Other same-origin assets: Network-first with offline cache fallback
  event.respondWith(
    fetch(req)
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
