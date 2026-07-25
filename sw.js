// Service Worker — Status Gallery
// Cache "app shell" (file statis) supaya bisa dibuka offline / lebih cepat.
// Data gambar & kategori TIDAK di-cache di sini karena selalu diambil live
// dari Supabase (biar selalu update).

const CACHE_VERSION = 'sg-v1';
const APP_SHELL = [
  './',
  './index.html',
  './config.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// ===== INSTALL: simpan app shell ke cache =====
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// ===== ACTIVATE: bersihkan cache versi lama =====
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ===== FETCH =====
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Hanya tangani request GET dari origin sendiri (app shell).
  // Request ke Supabase / domain lain (data gambar, auth, dll) dibiarkan
  // lewat langsung ke jaringan, tidak di-cache, supaya selalu fresh.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline: fallback ke cache kalau ada

      // Cache-first untuk app shell: langsung sajikan dari cache kalau ada,
      // sambil update cache di background.
      return cached || networkFetch;
    })
  );
});
