// Service worker: caches the APP SHELL ONLY (html, css, js, icons) so the app opens without a network
// round-trip and survives a flaky link. It never caches robot state: /ws, /api/*, /stream/*, /console/*
// and anything not in the shell list go straight to the network (stale robot state is dangerous, 05 §12).
const VERSION = 'g1-app-0.1.0-10';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'css/tokens.css', 'css/app.css',
  'js/main.js', 'js/client.js', 'js/status.js', 'js/shell.js', 'js/sheets.js', 'js/ui.js', 'js/icons.js', 'js/data.js',
  'js/platform.js', 'js/floorplan.js', 'js/mapview.js', 'js/goals.js',
  'js/screens/home.js', 'js/screens/places.js', 'js/screens/instruments.js', 'js/screens/checks.js', 'js/screens/status.js',
  'js/screens/map.js', 'js/screens/drive.js', 'js/screens/arms.js', 'js/screens/missions.js', 'js/screens/system.js', 'js/screens/teach.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon-180.png',
];
const NEVER = /\/(ws|api|stream|console|tls)(\/|$)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname) || url.search.includes('t=')) return;
  const scope = new URL(self.registration.scope);
  const rel = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : null;
  const inShell = rel !== null && (rel === '' || SHELL.includes(rel));
  if (!inShell && req.mode !== 'navigate') return;
  // network first (so an updated app is picked up at once), shell cache as the offline fallback
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && inShell) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('index.html'))));
});
