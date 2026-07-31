// Service Worker — Status Gallery
// Cache "app shell" (file statis) supaya bisa dibuka offline / lebih cepat.
// Data gambar & kategori dari Supabase: NETWORK-FIRST, tapi hasil sukses
// terakhir tetap disimpan di DATA_CACHE. Jadi kalau lagi online selalu
// dapat data terbaru, dan kalau lagi offline, galeri masih bisa render
// pakai data terakhir yang berhasil dimuat (bukan halaman kosong/error).

// ===== ONESIGNAL WEB PUSH =====
// Menumpangkan handler push notification OneSignal ke service worker yang
// sudah ada ini (bukan file worker terpisah), supaya PWA install/update flow
// yang sudah jalan gak kebentur / harus pilih salah satu.
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');

const CACHE_VERSION = 'sg-v13'; // naikkan angka ini SETIAP kali deploy versi baru,
// supaya browser tahu ada update & banner "Perbarui" muncul ke user
const THUMB_CACHE = 'sg-thumbs-v1'; // cache terpisah khusus thumbnail wsrv.nl,
// TIDAK ikut terhapus tiap update versi app (lihat activate handler)
const DATA_CACHE = 'sg-data-v1'; // cache terpisah khusus respons data Supabase
// (daftar kategori & gambar), juga TIDAK ikut terhapus tiap update versi app,
// supaya galeri offline tetap bisa pakai data terakhir walau app-nya di-update
const APP_SHELL = [
  './',
  './index.html',
  './config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// ===== INSTALL: simpan app shell ke cache =====
// skipWaiting() dipanggil otomatis di sini: SW baru langsung lanjut ke
// state "activating" begitu app shell selesai di-cache, TANPA nunggu user
// klik tombol apa pun. Sesi/tab yang sedang terbuka TIDAK direload paksa --
// itu urusan activate handler (clients.claim()) di bawah, dan halaman yang
// sedang berjalan cuma dikasih toast info ringan (lihat app.js), bukan
// dipaksa reload di tengah pemakaian.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Listener ini dibiarkan ada untuk kompatibilitas mundur (kalau ada versi
// app lama di HP user yang masih kirim sinyal ini) -- tapi sudah TIDAK
// diperlukan lagi karena skipWaiting() sekarang otomatis dipanggil sendiri
// di install handler di atas.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // Dipakai halaman untuk cek "ini beneran versi baru, atau cuma phantom
  // update-check yang dipicu ulang (misal oleh OneSignal saat subscribe)?"
  if (event.data && event.data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'SW_VERSION', version: CACHE_VERSION });
  }
});

// ===== ACTIVATE: bersihkan cache versi lama =====
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_VERSION && key !== THUMB_CACHE && key !== DATA_CACHE)
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

  // Query data (GET) ke Supabase REST API — dipakai buat daftar kategori &
  // gambar (lihat loadData() di index.html). NETWORK-FIRST: kalau online,
  // selalu ambil dari server & timpa cache lama supaya tetap fresh. Kalau
  // gagal (offline), fallback ke hasil sukses terakhir yang ada di cache,
  // supaya galeri (dan thumbnail yang sudah di-cache di atas) tetap bisa
  // dibuka. RPC (increment_downloads, is_admin, dst) TIDAK ikut ke sini
  // karena dikirim sebagai POST, sudah kefilter di method check paling atas.
  if (url.pathname.includes('/rest/v1/')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(DATA_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          // Kalau belum pernah berhasil di-cache sebelumnya juga, balikin
          // Response gagal (bukan undefined) — loadData() di index.html
          // sudah nangkep ini lewat try/catch dan nampilin errorState.
          return cached || new Response('', { status: 503, statusText: 'Data unavailable (offline)' });
        })
    );
    return;
  }

  // Request ke domain lain (Supabase auth, storage upload, dll) dibiarkan
  // lewat langsung ke jaringan, tidak di-cache, supaya selalu fresh.
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
        .catch(async () => {
          // Coba cache utk URL persis ini dulu (jarang ada, krn tiap query
          // string ?img=xxx beda jadi cache key beda) -- kalau gak ada,
          // fallback ke app shell index.html yg SELALU ke-cache saat install.
          // Query string (?img=..) ditangani client-side di app.js, jadi
          // menyajikan index.html generik di sini tetap aman/benar.
          const cached = await caches.match(event.request);
          if (cached) return cached;
          const shell = await caches.match('./index.html');
          if (shell) return shell;
          // Bener-bener gak ada apapun di cache (mis. install pertama gagal)
          // -> WAJIB tetap balikin Response valid, jangan undefined.
          return new Response('', { status: 503, statusText: 'Offline and not cached' });
        })
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