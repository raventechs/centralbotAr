/* Service Worker — CentralbotAr v1.0 | RavenTechs | red primero, caché solo como respaldo sin conexión */
var CACHE = 'centralbotar-pwa-v3';
var SHELL = ['/centralbotar.html', '/manifest.json'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function () {}).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = req.url;
  if (req.method !== 'GET') return;
  if (url.indexOf('/.netlify/') !== -1 || /firestore|firebase|googleapis|gstatic|google\.com|anthropic|facebook/.test(url)) return;
  e.respondWith(fetch(req).then(function (res) {
    if (res && res.status === 200 && url.indexOf(self.location.origin) === 0) { var c = res.clone(); caches.open(CACHE).then(function (ca) { ca.put(req, c); }); }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (m) { return m || caches.match('/centralbotar.html'); });
  }));
});
