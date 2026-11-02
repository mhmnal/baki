/* Baki — offline shell
 * Caches the app so it opens with no signal; entries live in localStorage
 * and sync to the laptop when the phone is back on the home Wi-Fi.
 */
const VERSION = 'baki-v25';
const SHELL = ['./', './index.html', './sw.js', './manifest.webmanifest', './fonts/inter-latin.woff2', './fonts/space-grotesk-latin.woff2',
               './icon-48.v2.png', './icon-96.v2.png', './icon-192.v2.png', './icon-512.v2.png',
               './icon-maskable-512.v2.png', './apple-touch-icon.v2.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(VERSION)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // POSTs go straight to the network
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // never touch other origins
  if (isApi(url)) return;                           // API stays network-only (app handles offline)

  // Navigations: network first, fall back to the cached app shell.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(cache => cache.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(async () => {
          return (await caches.match(req)) ||
                 (await caches.match('./index.html')) ||
                 (await caches.match('./')) ||
                 new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0b0f0d;color:#f2f6ee;font-family:system-ui;padding:40px 24px;line-height:1.6"><h2>Grab Money is not available offline yet</h2><p>Open it once on the home Wi-Fi, then it will work without a connection.</p></body>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
        })
    );
    return;
  }

  // Everything else: cache first, then network.
  event.respondWith(
    caches.match(req).then(hit => {
      if (hit) return hit;
      return fetch(req).then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(cache => cache.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => new Response('', { status: 504, statusText: 'Offline' }));
    })
  );
});
