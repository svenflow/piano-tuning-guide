/* sw.js - offline support. Precaches the app shell; afterwards the page works with no
   network. Navigations are network-first (so a new version shows up), everything
   else is cache-first (asset URLs carry ?v= stamps, so a new version is a new URL). */
const VERSION = 'ptg-v4';
const SHELL = [
  './', './index.html', './css/app.css?v=3', './manifest.webmanifest',
  './js/app.js?v=4', './js/data.js?v=1', './js/scene.js?v=1', './js/audio.js?v=1', './js/tuner.js?v=1',
  './vendor/three/three.module.js', './vendor/three/three.core.js',
  './fonts/geist-latin.woff2', './fonts/geistmono-latin.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-cache' }).then((res) => {
      const copy = res.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copy)); return res;
    }).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  })));
});
