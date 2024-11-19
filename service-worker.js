self.addEventListener('install', function(event) {
    event.waitUntil(
        caches.open('geojson-viewer-cache').then(function(cache) {
            return cache.addAll([
                '/',
                '/index.html',
                '/manifest.json',
                '/styles.css',
                'https://unpkg.com/leaflet/dist/leaflet.css',
                'https://unpkg.com/leaflet/dist/leaflet.js'
            ]);
        })
    );
});

self.addEventListener('fetch', function(event) {
    event.respondWith(
        caches.match(event.request).then(function(response) {
            return response || fetch(event.request);
        })
    );
});
