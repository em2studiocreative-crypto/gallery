// Service Worker — Status Gallery
// Cache "app shell" (file statis) supaya bisa dibuka offline / lebih cepat.
// Data gambar & kategori TIDAK di-cache di sini karena selalu diambil live
// dari Supabase (biar selalu update).

// ===== ONESIGNAL WEB PUSH =====
// Menumpangkan handler push notification OneSignal ke service worker yang
// sudah ada ini (bukan file worker terpisah), supaya PWA install/update flow
// yang sudah jalan gak kebentur / harus pilih salah satu.
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

const CACHE_VERSION = 'sg-v5'; // naikkan angka ini SETIAP kali deploy versi baru,
// supaya browser tahu ada update & banner "Perbarui" muncul ke user
const THUMB_CACHE = 'sg-thumbs-v1'; // cache terpisah khusus thumbnail wsrv.nl,
// TIDAK ikut terhapus tiap update versi app (lihat activate handler)
const APP_SHELL = [
  './',
  './index.html',
  './config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// ===== INSTALL: simpan app shell ke cache =====
// CATATAN: skipWaiting() SENGAJA tidak dipanggil otomatis di sini.
// Service worker versi baru akan menunggu (state "waiting") sampai
// user menekan tombol "Perbarui" di banner update (lihat index.html).
// Ini supaya user nggak tiba-tiba dipindah ke versi baru tanpa sadar.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
});

// Terima sinyal dari halaman (tombol "Perbarui") untuk langsung aktifkan
// service worker versi baru yang sedang menunggu.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ===== ACTIVATE: bersihkan cache versi lama =====
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION && key !== THUMB_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ===== FETCH =====
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  // Thumbnail terkompresi dari wsrv.nl (proxy resize/kompres gambar untuk
  // grid & preview): CACHE-FIRST, dengan refresh diam-diam di background.
  // Karena sama-sama thumbnail ringan, aman disimpan lama — bikin galeri
  // kerasa instan pas dibuka lagi, tanpa download ulang tiap kali.
  // Gambar ASLI (yang dipakai saat download HD) TIDAK lewat sini karena
  // itu langsung ke Supabase Storage, bukan ke wsrv.nl.
  if (url.hostname === 'wsrv.nl') {
    event.respondWith(
      caches.open(THUMB_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        if (cached) {
          // Ada di cache: langsung balikin, sambil refresh diam-diam di
          // background (gagal/sukses gak ngaruh ke response yang sudah dikirim).
          fetch(event.request)
            .then((response) => {
              if (response && response.status === 200) {
                cache.put(event.request, response.clone());
              }
            })
            .catch(() => {}); // diam-diam aja, cached sudah terlanjur dipakai
          return cached;
        }
        // Gak ada di cache: coba network. Kalau ini juga gagal (offline/net error),
        // WAJIB balikin sebuah Response valid (bukan undefined), atau browser
        // akan lempar "Failed to convert value to 'Response'".
        try {
          const response = await fetch(event.request);
          if (response && response.status === 200) {
            cache.put(event.request, response.clone());
          }
          return response;
        } catch (err) {
          return new Response('', { status: 503, statusText: 'Thumbnail unavailable (offline)' });
        }
      })
    );
    return;
  }

  // Request ke domain lain (Supabase data/auth, dll) dibiarkan lewat
  // langsung ke jaringan, tidak di-cache, supaya selalu fresh.
  if (url.origin !== self.location.origin) {
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
    caches.match(event.request).then(async (cached) => {
      if (cached) {
        // Ada di cache: balikin langsung, refresh diam-diam di background.
        fetch(event.request)
          .then((response) => {
            if (response && response.status === 200) {
              const clone = response.clone();
              caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
            }
          })
          .catch(() => {});
        return cached;
      }
      // Gak ada di cache: coba network. Kalau gagal, WAJIB balikin Response
      // valid (bukan undefined), atau browser lempar "Failed to convert
      // value to 'Response'".
      try {
        const response = await fetch(event.request);
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        }
        return response;
      } catch (err) {
        return new Response('', { status: 503, statusText: 'Offline and not cached' });
      }
    })
  );
});