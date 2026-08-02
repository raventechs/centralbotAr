/* Service Worker — CentralbotAR | RavenTechs | 02/08/2026 */
var CACHE = 'centralbotar-pwa-v1';
var SHELL = ['/', '/centralbotar.html', '/manifest.json'];
self.addEventListener('install', function(e) {
  e.waitUntil(caches.open(CACHE).then(function(c) {
    return c.addAll(SHELL.map(function(u) { return new Request(u, {mode:'no-cors'}); }));
  }).then(function() { return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e) {
  e.waitUntil(caches.keys().then(function(keys) {
    return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
  }).then(function() { return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  if (url.indexOf('firestore')!==-1||url.indexOf('firebase')!==-1||url.indexOf('googleapis')!==-1||url.indexOf('gstatic')!==-1) return;
  e.respondWith(caches.match(e.request).then(function(cached) {
    var net = fetch(e.request).then(function(res) {
      if (res && res.status===200 && e.request.method==='GET') { var c=res.clone(); caches.open(CACHE).then(function(ca){ca.put(e.request,c);}); }
      return res;
    }).catch(function() { return cached; });
    return cached || net;
  }));
});
