// CodeFactory Service Worker — minimal, enables PWA install prompt.
// No aggressive caching: terminals need live connections, and static
// files are served locally from the same device.

var CACHE_NAME = 'codefactory-v1';

self.addEventListener('install', function(event) {
    self.skipWaiting();
});

self.addEventListener('activate', function(event) {
    event.waitUntil(self.clients.claim());
});
