// Service Worker — Status Gallery
// Cache "app shell" (file statis) supaya bisa dibuka offline / lebih cepat.
// Data gambar & kategori TIDAK di-cache di sini karena selalu diambil live
// dari Supabase (biar selalu update).

const CACHE_VERSION = 'sg-v2'; // dinaikkan supaya cache lama otomatis dibersihkan
const APP_SHELL = [
  './',
  './index.html',
  './config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
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

  // Halaman HTML (navigasi / index.html): NETWORK-FIRST.
  // Supaya begitu kamu update index.html di server, pengguna langsung
  // dapat versi terbaru tanpa perlu reload dua kali. Cache cuma dipakai
  // sebagai fallback kalau lagi offline.
  const isHtmlRequest =
    event.request.mode === 'navigate' ||
    url.pathname === '/' ||
    url.pathname.endsWith('/') ||
    url.pathname.endsWith('/index.html');

  if (isHtmlRequest) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // File statis lain (ikon, manifest, config.js): CACHE-FIRST seperti semula,
  // tetap update cache di background supaya lain kali tetap fresh.
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

      return cached || networkFetch;
    })
  );
});