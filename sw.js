// Network-first with cache fallback, so the app opens offline on site.
// Matches APP_VERSION in js/app.js; a new name makes phones fetch the new release.
const CACHE = 'site-survey-1.0.14';
const SHELL = ['./', './index.html', './css/app.css', './js/app.js', './js/db.js', './js/plan.js', './js/annotate.js', './js/dxf.js', './js/zoom.js', './js/tools.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // The upload API must always reach the server, never a cached answer.
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
