// Caches the whole app on first visit so it runs with no network at all.
// Bump VERSION whenever a cached file changes.
const VERSION = 'flatbed-v3';
const ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'scan.js', 'pdf.js', 'worker.js',
  'pdfdoc.js', 'marks.js', 'markup.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/pdfjs/pdf.min.js', 'vendor/pdfjs/pdf.worker.min.js', 'vendor/pdf-lib/pdf-lib.esm.min.js',
];
// Fonts and CMaps for unusual PDFs are cached the first time they're needed.

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    if (request.mode === 'navigate') return (await cache.match('./')) || fetch(request);
    const res = await fetch(request);
    if (res.ok && new URL(request.url).pathname.includes('/vendor/')) cache.put(request, res.clone());
    return res;
  })());
});
