// Service Worker for BusyTeX - pre-caches all bundles for instant loading

const CACHE_NAME = 'busytex-v2';
const API_BASE = 'https://siglum-api.vtp-ips.workers.dev';

// All bundles to pre-cache (pdflatex + common packages)
const PRECACHE_BUNDLES = [
    'core', 'fmt-pdflatex', 'l3', 'fonts-cm', 'fonts-misc',
    'fonts-lm-type1', 'dvips', 'extra', 'amsmath', 'fonts-cmextra',
    'fonts-symbols', 'graphics', 'hyperref'
];

const PRECACHE_URLS = [
    `${API_BASE}/wasm/busytex.wasm`,
    `${API_BASE}/bundles/bundle-deps.json`,
    `${API_BASE}/bundles/file-manifest.json`,
    `${API_BASE}/bundles/registry.json`,
    `${API_BASE}/bundles/package-map.json`,
    ...PRECACHE_BUNDLES.map(b => `${API_BASE}/bundles/${b}.data.gz`),
    ...PRECACHE_BUNDLES.map(b => `${API_BASE}/bundles/${b}.meta.json`),
];

// Install: pre-cache all bundles
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            console.log('[SW] Pre-caching bundles...');
            // Fetch all in parallel
            const responses = await Promise.allSettled(
                PRECACHE_URLS.map(url =>
                    fetch(url).then(r => r.ok ? cache.put(url, r) : null)
                )
            );
            const cached = responses.filter(r => r.status === 'fulfilled').length;
            console.log(`[SW] Pre-cached ${cached}/${PRECACHE_URLS.length} resources`);
        })
    );
    // Activate immediately
    self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    // Take control immediately
    self.clients.claim();
});

// Fetch: serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const url = event.request.url;

    // Only cache API requests
    if (!url.includes('siglum-api')) return;

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) {
                // Return cached, but update in background
                fetch(event.request).then(response => {
                    if (response.ok) {
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, response));
                    }
                }).catch(() => {});
                return cached;
            }
            // Not cached - fetch and cache
            return fetch(event.request).then(response => {
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            });
        })
    );
});
