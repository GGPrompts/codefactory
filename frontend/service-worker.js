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

// Pass all fetches through to the network.  We don't cache because
// the backend runs locally on the same device — offline mode isn't
// meaningful when the server and client are co-located.
self.addEventListener('fetch', function(event) {
    event.respondWith(fetch(event.request));
});
