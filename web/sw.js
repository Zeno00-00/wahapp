// Cache-first for the app shell, stale-while-revalidate for data.
// __BUILD_ID__ is replaced by the GitHub Actions workflow with the short
// commit SHA on every deploy, so a new shell invalidates the old cache
// automatically. Locally the literal placeholder is a valid (static) name.
const CACHE = 'wahapp-__BUILD_ID__';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // For data files: stale-while-revalidate so a stale cache works offline,
  // but online we always refresh in the background.
  if (url.pathname.includes('/data/')) {
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }
  // App shell: cache-first.
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      if (resp.ok) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return resp;
    }))
  );
});

async function staleWhileRevalidate(req) {
  const cached = await caches.match(req);
  const fetchPromise = fetch(req).then(resp => {
    if (resp.ok) {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
    }
    return resp;
  }).catch(() => cached);
  return cached || fetchPromise;
}
