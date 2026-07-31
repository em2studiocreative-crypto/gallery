// ===== DATA =====
  // URL publik resmi aplikasi (dipakai untuk share link), diambil dari
  // <link rel="canonical"> di <head>. Ini sengaja TIDAK pakai
  // window.location langsung, supaya link yang dibagikan selalu benar
  // walau aplikasi sedang dibuka dari file lokal (file://) atau domain
  // staging/testing — bukan cuma pas dibuka dari domain produksi asli.
  const PRODUCTION_APP_URL = (document.querySelector('link[rel="canonical"]')?.href) || 'https://www.em2studio.online/';

  // ===== SUPABASE CLIENT =====
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  // CATEGORIES & IMAGES sekarang diisi dari Supabase saat load (lihat loadData()).
  // 'all' selalu ada duluan sebagai filter khusus "tampilkan semua".
  let CATEGORIES = [ { id: 'all', label: 'Semua' } ];
  let IMAGES = [];

  // Helper global: nama kategori dari id-nya. Dipakai buat alt text gambar
  // biar lebih deskriptif untuk SEO (Google Images), bukan cuma judulnya.
  function catLabel(id) {
    return (CATEGORIES.find(c => c.id === id) || {}).label || id;
  }

  // Escape teks (judul gambar, label kategori, dll) sebelum disisipkan ke
  // innerHTML/insertAdjacentHTML/template string HTML. Data ini berasal dari
  // Supabase (diisi lewat panel admin) - escaping tetap dipasang sebagai
  // lapisan pertahanan kalau suatu saat ada karakter aneh (kutip, "<", "&")
  // di judul/label, supaya tidak merusak markup atau jadi celah XSS.
  function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  // ===== IMAGE OPTIMIZATION HELPERS =====
  // Membuat URL versi ringan (resize + kompres) via proxy wsrv.nl,
  // TANPA menyentuh file aslinya. File asli (img.url) tetap dipakai saat
  // download supaya hasilnya tetap full resolusi/HD.
  function thumbUrl(url, width, quality = 75) {
    const params = new URLSearchParams({
      url,
      w: String(width),
      q: String(quality),
      // 'output' sengaja TIDAK di-set: wsrv.nl otomatis pilih format
      // paling ringan yang didukung browser (AVIF > WebP > JPEG) lewat
      // content negotiation, jadi ukuran file makin kecil di browser modern
      // tanpa perlu kode tambahan atau merusak kompatibilitas di browser lama.
      we: '' // strip metadata (we = "without exif") utk ukuran lebih kecil
    });
    return `https://wsrv.nl/?${params.toString()}`;
  }

  // Untuk grid: kecil & sangat terkompresi (cukup utk thumbnail)
  function gridThumb(url) {
    return thumbUrl(url, 480, 70);
  }

  // Versi 2x dari gridThumb, khusus utk atribut srcset supaya layar
  // HiDPI/retina tetap tajam tanpa menaikkan ukuran gambar di layar biasa
  // (browser yang pilih sendiri versi mana yang dipakai sesuai densitas layar).
  function gridThumbSrcset(url) {
    return `${thumbUrl(url, 480, 70)} 1x, ${thumbUrl(url, 960, 65)} 2x`;
  }

  // Untuk modal preview: cukup besar utk dilihat jelas, tapi masih jauh
  // lebih kecil filenya dibanding file asli (bukan untuk download)
  function previewThumb(url) {
    return thumbUrl(url, 1080, 82);
  }

  // ===== STATE =====
  let activeCategory = 'all';
  let searchQuery = '';
  let currentModalImage = null;
  let showFavoritesOnly = false;
  let favorites = new Set();
  let currentUser = null; // null = guest (pakai localStorage), diisi setelah login Google
  try {
    favorites = new Set(JSON.parse(localStorage.getItem('sg_favorites') || '[]'));
  } catch (e) {
    favorites = new Set();
  }

  function saveFavorites() {
    try {
      localStorage.setItem('sg_favorites', JSON.stringify([...favorites]));
    } catch (e) {
      // localStorage tidak tersedia (mis. private mode) — abaikan secara diam-diam
    }
  }

  // ===== REKOMENDASI: MINAT KATEGORI (category affinity) =====
  // Skor sederhana per kategori berdasarkan interaksi user: buka detail (+1),
  // simpan ke favorit (+3), download (+5). Dipakai untuk menyusun ulang urutan
  // feed "Semua" supaya kategori yang paling disukai user lebih sering muncul,
  // tanpa menghilangkan variasi kategori lain (lihat weightedInterleave()).
  const AFFINITY_WEIGHTS = { view: 1, favorite: 3, download: 5 };
  const AFFINITY_CAP = 200; // batas atas per kategori biar skor tidak meledak seiring waktu
  // Boost awal per kategori yang dipilih user saat onboarding — sengaja jauh
  // lebih besar dari 1 interaksi organik (view=1) supaya feed langsung terasa
  // personal sejak menit pertama, tanpa perlu nunggu beberapa kali klik dulu.
  const ONBOARDING_AFFINITY_BOOST = 20;
  let categoryAffinity = {};
  try {
    categoryAffinity = JSON.parse(localStorage.getItem('sg_category_affinity') || '{}');
  } catch (e) {
    categoryAffinity = {};
  }

  function trackInteraction(category, type) {
    if (!category || !AFFINITY_WEIGHTS[type]) return;
    const current = categoryAffinity[category] || 0;
    categoryAffinity[category] = Math.min(AFFINITY_CAP, current + AFFINITY_WEIGHTS[type]);
    try {
      localStorage.setItem('sg_category_affinity', JSON.stringify(categoryAffinity));
    } catch (e) {
      // localStorage tidak tersedia — abaikan secara diam-diam
    }
  }

  // Smooth weighted round-robin (algoritma yang sama seperti load balancer
  // NGINX): setiap kategori "antre" bergiliran, tapi kategori berbobot lebih
  // tinggi kebagian giliran lebih sering. Dipakai supaya kategori favorit user
  // lebih dominan di feed TANPA membuat kategori lain hilang sama sekali.
  function weightedInterleave(groups) {
    // groups: [{ weight, items }]
    const active = groups.filter(g => g.items.length > 0).map(g => ({ ...g, cursor: 0, current: 0 }));
    const totalWeight = active.reduce((sum, g) => sum + g.weight, 0);
    const totalItems = active.reduce((sum, g) => sum + g.items.length, 0);
    const result = [];
    while (result.length < totalItems) {
      active.forEach(g => { g.current += g.weight; });
      let best = null;
      for (const g of active) {
        if (g.cursor >= g.items.length) continue;
        if (!best || g.current > best.current) best = g;
      }
      if (!best) break;
      result.push(best.items[best.cursor++]);
      best.current -= totalWeight;
    }
    return result;
  }

  // Menyusun ulang gambar berdasarkan minat kategori user. Hanya dipakai untuk
  // feed default "Semua" (bukan saat search / filter favorit / kategori
  // spesifik dipilih user sendiri) supaya tidak terasa mengganggu kontrol user.
  //
  // CACHE URUTAN: filterAndRender() (dan applyCategoryAffinitySort di dalamnya)
  // bisa terpanggil berkali-kali di background tanpa aksi user yang disengaja
  // -- misal tiap ada event realtime dari Supabase (termasuk saat ada ORANG
  // LAIN mendownload gambar, yang cuma menaikkan angka `downloads`). Kalau
  // affinity sort dihitung ulang dari nol tiap kali itu terjadi, sementara
  // categoryAffinity user SENDIRI juga baru saja berubah (krn habis buka
  // modal preview -> trackInteraction menaikkan skor), hasil weightedInterleave
  // bisa beda padahal SET gambarnya sama persis -> gambar yang tadinya
  // terlihat di suatu posisi tiba-tiba berubah jadi gambar lain, padahal user
  // tidak melakukan apa-apa.
  //
  // Supaya urutan yang SUDAH tampil di layar stabil, urutan hasil sort di-cache
  // dan hanya dihitung ulang kalau SET id gambarnya benar-benar berubah (ada
  // gambar baru/dihapus dari tabel `images`), atau kalau memang sengaja
  // di-reset lewat resetAffinityOrderCache() (dipakai setelah user pilih minat
  // di onboarding, supaya feed langsung menyesuaikan saat itu juga).
  let cachedAffinityOrder = null; // array objek gambar, urutan terakhir yang dipakai
  let cachedAffinityIds = null;   // Set id gambar yang jadi dasar urutan di atas

  function resetAffinityOrderCache() {
    cachedAffinityOrder = null;
    cachedAffinityIds = null;
  }

  function applyCategoryAffinitySort(images) {
    const hasAffinityData = Object.values(categoryAffinity).some(v => v > 0);
    if (!hasAffinityData) return images; // belum ada data -> urutan asli (terbaru dulu)

    const currentIds = new Set(images.map(img => img.id));
    const sameSet = cachedAffinityIds &&
      currentIds.size === cachedAffinityIds.size &&
      [...currentIds].every(id => cachedAffinityIds.has(id));

    if (sameSet) {
      // Set gambar tidak berubah -> pertahankan urutan lama (biar tidak
      // "berubah sendiri"), tapi ambil objek gambar versi TERBARU dari
      // `images` (mis. downloads/title yang baru saja ke-update lewat
      // realtime) supaya data yang ditampilkan tetap fresh.
      const byId = new Map(images.map(img => [img.id, img]));
      return cachedAffinityOrder.map(img => byId.get(img.id)).filter(Boolean);
    }

    // Set gambar berubah (ada yang baru masuk / dihapus admin) -> baru di
    // sini urutan dihitung ulang.
    const byCategory = new Map();
    images.forEach(img => {
      if (!byCategory.has(img.category)) byCategory.set(img.category, []);
      byCategory.get(img.category).push(img);
    });

    const groups = [...byCategory.entries()].map(([category, items]) => ({
      // bobot dasar 1 supaya kategori tanpa minat tetap kebagian tampil (tidak
      // hilang total / filter bubble), ditambah bonus dari skor affinity.
      weight: 1 + (categoryAffinity[category] || 0) / 10,
      items
    }));

    const sorted = weightedInterleave(groups);
    cachedAffinityOrder = sorted;
    cachedAffinityIds = currentIds;
    return sorted;
  }

  // ===== ONBOARDING: PILIH MINAT DI AWAL =====
  // Ditampilkan sekali untuk pengunjung baru (belum punya data affinity
  // organik) supaya feed langsung terasa personal sejak menit pertama,
  // bukan nunggu user klik-klik dulu. Dipicu setelah CATEGORIES asli
  // berhasil dimuat dari Supabase (lihat akhir loadData()).
  let onboardingSelectedCats = new Set();

  function maybeShowOnboarding() {
    let seen = false;
    try {
      seen = localStorage.getItem('sg_onboarding_seen') === '1';
    } catch (e) {
      seen = false;
    }
    if (seen) return;

    // Sudah ada minat organik (mis. dari sesi sebelumnya) -> tidak perlu tanya lagi
    const hasAffinityData = Object.values(categoryAffinity).some(v => v > 0);
    if (hasAffinityData) return;

    // Kurang dari 3 kategori nyata: onboarding kurang berguna, skip saja
    const realCats = CATEGORIES.filter(c => c.id !== 'all');
    if (realCats.length < 3) return;

    openOnboardingModal(realCats);
  }

  function openOnboardingModal(realCats) {
    onboardingSelectedCats = new Set();
    const grid = document.getElementById('onboardingChipGrid');
    grid.innerHTML = realCats.map(c =>
      `<button type="button" class="onboarding-chip" data-cat="${c.id}" onclick="event.stopPropagation(); toggleOnboardingChip('${c.id}', this)">${escapeHtml(c.label)}</button>`
    ).join('');
    updateOnboardingConfirmBtn();
    document.getElementById('onboardingModal').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function toggleOnboardingChip(catId, el) {
    if (onboardingSelectedCats.has(catId)) {
      onboardingSelectedCats.delete(catId);
      el.classList.remove('active');
    } else {
      onboardingSelectedCats.add(catId);
      el.classList.add('active');
    }
    updateOnboardingConfirmBtn();
  }

  function updateOnboardingConfirmBtn() {
    const btn = document.getElementById('onboardingConfirmBtn');
    if (!btn) return;
    const n = onboardingSelectedCats.size;
    btn.disabled = n === 0;
    btn.textContent = n > 0 ? `Lanjutkan (${n} dipilih)` : 'Pilih minimal 1';
  }

  function finishOnboarding(skip) {
    if (!skip && onboardingSelectedCats.size > 0) {
      onboardingSelectedCats.forEach(catId => {
        const current = categoryAffinity[catId] || 0;
        categoryAffinity[catId] = Math.min(AFFINITY_CAP, current + ONBOARDING_AFFINITY_BOOST);
      });
      try {
        localStorage.setItem('sg_category_affinity', JSON.stringify(categoryAffinity));
      } catch (e) {
        // localStorage tidak tersedia — abaikan secara diam-diam
      }
      showToast('Feed kamu udah disesuaikan!', 'success');
    }

    try {
      localStorage.setItem('sg_onboarding_seen', '1');
    } catch (e) {
      // localStorage tidak tersedia — abaikan secara diam-diam
    }

    document.getElementById('onboardingModal').classList.remove('open');
    document.body.style.overflow = '';

    // Kalau lagi di feed "Semua" tanpa filter/search aktif, susun ulang feed
    // supaya kategori yang barusan dipilih langsung kelihatan lebih dominan.
    if (activeCategory === 'all' && !showFavoritesOnly && !searchQuery) {
      // Reset cache urutan affinity dulu -> skor affinity baru saja berubah
      // SENGAJA (user pilih minat), jadi resort kali ini memang harus kepakai,
      // bukan dipertahankan ke urutan lama.
      resetAffinityOrderCache();
      filterAndRender();
    }
  }

  // ===== BADGE TRENDING =====
  // Data yang ada cuma total downloads sepanjang masa + tanggal upload, jadi
  // "trending minggu ini" didekati dengan skor downloads per hari sejak
  // diupload (bukan total downloads mentah) — biar gambar LAMA dengan
  // download menumpuk selama bertahun-tahun nggak otomatis menang terus
  // ngalahin gambar baru yang lagi rame diunduh belakangan ini.
  const TRENDING_BADGE_COUNT = 6; // maks berapa gambar yang dikasih badge sekaligus
  const TRENDING_MIN_DOWNLOADS = 5; // gambar baru dgn 1-2 download nggak usah ikut dinilai
  let trendingIds = new Set();

  function recomputeTrendingIds() {
    const now = Date.now();
    const scored = IMAGES
      .filter(img => (img.downloads || 0) >= TRENDING_MIN_DOWNLOADS)
      .map(img => {
        const createdAt = img.created_at ? new Date(img.created_at).getTime() : now;
        const daysSinceUpload = Math.max(1, (now - createdAt) / 86400000);
        return { id: img.id, score: img.downloads / daysSinceUpload };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, TRENDING_BADGE_COUNT);
    trendingIds = new Set(scored.map(s => s.id));
  }

  function toggleFavorite(imgId) {
    const wasFavorite = favorites.has(imgId);
    if (wasFavorite) {
      favorites.delete(imgId);
      showToast('Dihapus dari favorit');
    } else {
      favorites.add(imgId);
      showToast('Ditambahkan ke favorit', 'success');
      const img = IMAGES.find(i => i.id === imgId);
      if (img) trackInteraction(img.category, 'favorite');
    }

    if (currentUser) {
      // Sudah login: Supabase jadi satu-satunya sumber data, JANGAN sentuh
      // localStorage supaya tidak "kebawa" lagi kalau nanti logout.
      if (wasFavorite) {
        supabaseClient.from('favorites').delete().eq('user_id', currentUser.id).eq('image_id', imgId)
          .then(({ error }) => { if (error) console.error('Gagal hapus favorit di server:', error); });
      } else {
        supabaseClient.from('favorites').insert({ user_id: currentUser.id, image_id: imgId })
          .then(({ error }) => { if (error) console.error('Gagal simpan favorit di server:', error); });
      }
    } else {
      // Belum login (guest): simpan ke localStorage seperti biasa
      saveFavorites();
    }

    filterAndRender();
    if (currentModalImage && currentModalImage.id === imgId) {
      updateModalFavoriteBtn();
    }
  }

  // ===== NOTIFIKASI (khusus user yang sudah login, bukan tamu) =====
  // Aturan: user yang login akan mendapat notifikasi kalau ada gambar BARU
  // yang kategorinya sama dengan kategori gambar yang sudah dia favoritkan.
  let notifications = []; // [{id, imageId, title, category, categoryLabel, url, created_at, read}]

  function notifStorageKey(suffix) {
    return currentUser ? `sg_notif_${suffix}_${currentUser.id}` : null;
  }

  function isNotifPrefOn() {
    // Toggle di Pengaturan > "Notifikasi Gambar Baru". Default AKTIF
    // kecuali user pernah mematikannya secara eksplisit.
    return localStorage.getItem('sg_notif_pref') !== '0';
  }

  function loadNotificationsForUser() {
    if (!currentUser) { notifications = []; renderNotifBadge(); return; }
    try {
      notifications = JSON.parse(localStorage.getItem(notifStorageKey('list')) || '[]');
    } catch (e) {
      notifications = [];
    }
    renderNotifBadge();
  }

  function saveNotifications() {
    if (!currentUser) return;
    try {
      localStorage.setItem(notifStorageKey('list'), JSON.stringify(notifications.slice(0, 50)));
    } catch (e) {}
  }

  // Bandingkan gambar dari server dengan waktu cek terakhir milik user ini,
  // lalu buat notifikasi utk gambar baru yang kategorinya cocok dgn favorit.
  function checkForNewNotifications() {
    if (!currentUser || !isNotifPrefOn() || IMAGES.length === 0) return;

    const favCategoryIds = new Set(
      IMAGES.filter(img => favorites.has(img.id)).map(img => img.category)
    );

    const lastCheckKey = notifStorageKey('lastcheck');
    const lastCheck = localStorage.getItem(lastCheckKey);
    const now = new Date().toISOString();

    // Pertama kali fitur ini jalan utk user ini: catat baseline waktu saja,
    // supaya tidak tiba-tiba menumpahkan seluruh histori gambar lama.
    if (!lastCheck || favCategoryIds.size === 0) {
      try { localStorage.setItem(lastCheckKey, now); } catch (e) {}
      return;
    }

    const existingIds = new Set(notifications.map(n => n.imageId));
    const newOnes = IMAGES.filter(img =>
      img.created_at &&
      favCategoryIds.has(img.category) &&
      new Date(img.created_at) > new Date(lastCheck) &&
      !existingIds.has(img.id)
    );

    if (newOnes.length > 0) {
      const catLabel = id => (CATEGORIES.find(c => c.id === id) || {}).label || id;
      const added = newOnes.map(img => ({
        id: `${img.id}_${Date.now()}`,
        imageId: img.id,
        title: img.title,
        category: img.category,
        categoryLabel: catLabel(img.category),
        url: img.url,
        created_at: img.created_at,
        read: false
      }));
      notifications = [...added, ...notifications].slice(0, 50);
      saveNotifications();
      renderNotifBadge();

      if (document.getElementById('notifModal').classList.contains('open')) {
        renderNotifList();
      } else if (added.length === 1) {
        showToast(`🔔 Gambar baru di kategori ${added[0].categoryLabel}`, 'success');
      } else {
        showToast(`🔔 ${added.length} gambar baru sesuai favoritmu`, 'success');
      }
    }

    try { localStorage.setItem(lastCheckKey, now); } catch (e) {}
  }

  function unreadNotifCount() {
    return currentUser ? notifications.filter(n => !n.read).length : 0;
  }

  function renderNotifBadge() {
    const count = unreadNotifCount();
    ['notifBadgeSide', 'notifBadgeBottom'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      if (count > 0) {
        el.textContent = count > 9 ? '9+' : String(count);
        el.style.display = 'flex';
      } else {
        el.style.display = 'none';
        el.textContent = '';
      }
    });
  }

  function timeAgo(dateStr) {
    const diff = Math.max(0, (Date.now() - new Date(dateStr).getTime()) / 1000);
    if (diff < 60) return 'Baru saja';
    if (diff < 3600) return `${Math.floor(diff / 60)} menit lalu`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} hari lalu`;
    return new Date(dateStr).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function openNotifModal() {
    renderNotifList();
    document.getElementById('notifModal').classList.add('open');
  }

  function closeNotifModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('notifModal').classList.remove('open');
    if (currentUser && unreadNotifCount() > 0) {
      notifications.forEach(n => n.read = true);
      saveNotifications();
      renderNotifBadge();
    }
  }

  function markAllNotifRead() {
    if (!currentUser || notifications.length === 0) return;
    notifications.forEach(n => n.read = true);
    saveNotifications();
    renderNotifBadge();
    renderNotifList();
  }

  function openNotifItem(notifId) {
    const notif = notifications.find(n => n.id === notifId);
    if (!notif) return;
    notif.read = true;
    saveNotifications();
    renderNotifBadge();
    document.getElementById('notifModal').classList.remove('open');
    openModal(notif.imageId);
  }

  function renderNotifList() {
    const body = document.getElementById('notifBody');
    const markAllBtn = document.getElementById('notifMarkAllBtn');
    const bellIconSvg = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><use href="#icon-bell"></use></svg>';

    if (!currentUser) {
      markAllBtn.style.display = 'none';
      body.innerHTML = `
        <div class="notif-guest">
          <div class="notif-guest-icon">${bellIconSvg}</div>
          <div class="notif-guest-title">Masuk buat dapat notifikasi</div>
          <div class="notif-guest-desc">Tandai gambar favorit kamu, nanti kami kabari di sini kalau ada gambar baru di kategori yang sama. Fitur ini khusus buat kamu yang sudah masuk akun.</div>
          <div class="auth-provider-list">
            <button class="auth-btn google" onclick="closeNotifModal(); loginWithProvider('google');">
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l6-6C34.6 5.1 29.6 3 24 3 12.4 3 3 12.4 3 24s9.4 21 21 21 21-9.4 21-21c0-1.4-.1-2.7-.4-4z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l6-6C34.6 5.1 29.6 3 24 3 16.1 3 9.3 7.4 6.3 14.7z"/><path fill="#4CAF50" d="M24 45c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.6C29.6 35.9 27 37 24 37c-5.3 0-9.7-3.4-11.3-8.1l-6.6 5.1C9.2 40.5 16 45 24 45z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.3-4.1 5.7l6.6 5.6C39.9 37 45 30.9 45 24c0-1.4-.1-2.7-.4-4z"/></svg>
              Masuk dengan Google
            </button>
          </div>
        </div>`;
      return;
    }

    if (notifications.length === 0) {
      markAllBtn.style.display = 'none';
      body.innerHTML = `
        <div class="notif-empty">
          <div class="notif-empty-icon">${bellIconSvg}</div>
          <div class="notif-empty-title">Belum ada notifikasi</div>
          <div class="notif-empty-desc">Tambahkan gambar ke favorit ❤️ — nanti kami kabari di sini kalau ada gambar baru yang senada.</div>
          <button class="state-btn secondary" onclick="closeNotifModal(); toggleFavoritesView();">Lihat Favorit</button>
        </div>`;
      return;
    }

    markAllBtn.style.display = unreadNotifCount() > 0 ? 'inline-flex' : 'none';

    body.innerHTML = `<div class="notif-list">` + notifications.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}" onclick="openNotifItem('${n.id}')">
        <img class="notif-thumb" src="${gridThumb(n.url)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${n.url}'">
        <div class="notif-content">
          <div class="notif-text"><b>Gambar baru</b> di kategori <b>${escapeHtml(n.categoryLabel)}</b> — ${escapeHtml(n.title || '')}</div>
          <div class="notif-time">${timeAgo(n.created_at)}</div>
        </div>
        ${n.read ? '' : '<span class="notif-dot"></span>'}
      </div>
    `).join('') + `</div>`;
  }

  // ===== PWA: INSTALL PROMPT =====
  let deferredInstallPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const dismissed = localStorage.getItem('sg_install_dismissed') === '1';
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
    if (!dismissed && !isStandalone) {
      document.getElementById('installBanner').classList.add('show');
    }
  });

  async function installPWA() {
    if (!deferredInstallPrompt) return;
    document.getElementById('installBanner').classList.remove('show');
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') {
      showToast('Aplikasi berhasil dipasang', 'success');
    }
    deferredInstallPrompt = null;
  }

  function dismissInstallBanner() {
    document.getElementById('installBanner').classList.remove('show');
    try { localStorage.setItem('sg_install_dismissed', '1'); } catch (e) {}
  }

  window.addEventListener('appinstalled', () => {
    document.getElementById('installBanner').classList.remove('show');
  });

  // ===== PWA: SERVICE WORKER + NOTIFIKASI UPDATE =====
  // SW baru sekarang auto-aktif sendiri begitu siap (skipWaiting() otomatis
  // di sw.js) -- jadi TIDAK ada lagi banner "wajib diklik" atau reload paksa
  // di sesi yang sedang berjalan. Asset & data terbaru otomatis dipakai
  // untuk request-request berikutnya (fetch data, thumbnail, dst); halaman
  // yang lagi dibuka user nggak diganggu sama sekali. User cuma dikasih
  // toast info ringan (bukan aksi wajib) supaya tau ada pembaruan.

  // Ambil versi SW langsung dari teks sw.js di server (bukan lewat
  // postMessage ke worker), supaya gak ada elemen timing/race yang bisa gagal.
  function getLiveSwVersion() {
    return fetch('sw.js?_=' + Date.now(), { cache: 'no-store' })
      .then((res) => (res.ok ? res.text() : null))
      .then((text) => {
        if (!text) return null;
        const match = text.match(/CACHE_VERSION\s*=\s*['"]([^'"]+)['"]/);
        return match ? match[1] : null;
      })
      .catch(() => null);
  }

  // Cek apakah versi yang barusan take-over ini beneran baru (bukan phantom
  // re-check, misal dipicu OneSignal subscribe di belakang layar) sebelum
  // nampilin toast, supaya user gak di-spam notifikasi untuk versi yang sama.
  function notifyIfNewVersion() {
    getLiveSwVersion().then((version) => {
      const lastNotified = (() => {
        try { return localStorage.getItem('sg_last_notified_sw_version'); } catch (e) { return null; }
      })();
      if (!version || version === lastNotified) return;
      try { localStorage.setItem('sg_last_notified_sw_version', version); } catch (e) {}
      showToast('Konten sudah diperbarui.', 'success');
    });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => console.error('SW gagal daftar:', err));

      // SW baru otomatis "claim" halaman begitu aktif (lihat activate
      // handler di sw.js) -- ini yang memicu event ini. Tidak ada reload
      // paksa di sini, cukup kasih toast info ke user.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        notifyIfNewVersion();
      });
    });
  }

  // ===== SETTINGS =====
  function openSettingsModal() {
    updateSettingsUI();
    document.getElementById('settingsModal').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeSettingsModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('settingsModal').classList.remove('open');
    document.body.style.overflow = '';
  }

  function updateSettingsUI() {
    document.getElementById('settingsNotifToggle').classList.toggle('on', isNotifPrefOn());

    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    document.getElementById('settingsThemeToggle').classList.toggle('on', !isLight);
    document.getElementById('settingsThemeDesc').textContent = isLight ? 'Nonaktif' : 'Aktif';
  }

  function toggleNotifPref() {
    const isOn = isNotifPrefOn();
    try { localStorage.setItem('sg_notif_pref', isOn ? '0' : '1'); } catch (e) {}
    document.getElementById('settingsNotifToggle').classList.toggle('on', !isOn);
    showToast(isOn ? 'Notifikasi dimatikan' : 'Notifikasi diaktifkan', 'success');
    if (!isOn) {
      checkForNewNotifications();
      subscribeWebPush();
    } else {
      unsubscribeWebPush();
    }
  }

  // ===== ONESIGNAL: PUSH NOTIFICATION ASLI (bukan cuma bell in-app) =====
  // Dipanggil pas user nyalain toggle "Notifikasi Gambar Baru" di Pengaturan.
  // Beda dari checkForNewNotifications() (yang cuma jalan pas app dibuka),
  // ini beneran subscribe ke push browser -> user tetap dapat notif walau
  // app/tab-nya udah ditutup.
  async function subscribeWebPush() {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    OneSignalDeferred.push(async function (OneSignal) {
      try {
        await OneSignal.Notifications.requestPermission();
        await OneSignal.User.PushSubscription.optIn();
      } catch (e) {
        console.warn('Gagal subscribe push notification:', e);
      }
    });
  }

  async function unsubscribeWebPush() {
    window.OneSignalDeferred = window.OneSignalDeferred || [];
    OneSignalDeferred.push(async function (OneSignal) {
      try { await OneSignal.User.PushSubscription.optOut(); } catch (e) {}
    });
  }

  function toggleThemePref() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (isLight) {
      document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('sg_theme_pref', 'dark'); } catch (e) {}
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      try { localStorage.setItem('sg_theme_pref', 'light'); } catch (e) {}
    }
    updateSettingsUI();
    showToast(isLight ? 'Mode gelap diaktifkan' : 'Mode terang diaktifkan', 'success');
  }

  // ===== DONATE MODAL =====
  function openDonateModal() {
    document.getElementById('donateModal').classList.add('open');
  }

  function closeDonateModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('donateModal').classList.remove('open');
  }

  // ===== PRIVACY POLICY MODAL =====
  function openPrivacyModal() {
    document.getElementById('privacyModal').classList.add('open');
  }

  function closePrivacyModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('privacyModal').classList.remove('open');
  }

  // ===== TERMS & CONDITIONS MODAL =====
  function openTermsModal() {
    document.getElementById('termsModal').classList.add('open');
  }

  function closeTermsModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('termsModal').classList.remove('open');
  }

  function copyDonateRekening() {
    const number = document.getElementById('donateRekNumber').textContent.trim();
    const btn = document.getElementById('donateCopyBtn');
    const label = document.getElementById('donateCopyLabel');

    const markCopied = () => {
      btn.classList.add('copied');
      label.textContent = 'Tersalin!';
      showToast('Nomor rekening disalin', 'success');
      setTimeout(() => {
        btn.classList.remove('copied');
        label.textContent = 'Salin';
      }, 2000);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(number).then(markCopied).catch(() => {
        fallbackCopyText(number);
        markCopied();
      });
    } else {
      fallbackCopyText(number);
      markCopied();
    }
  }

  function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
  }

  function openProfileModal() {
    updateProfileQuotaText();
    document.getElementById('profileModal').classList.add('open');
  }
  function closeProfileModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('profileModal').classList.remove('open');
    // Bug fix: tombol nav "Profil" dulu pakai setNav() yang cuma nyalain
    // dirinya sendiri tanpa pernah "kembali" ke Beranda/Favorit begitu
    // modal ditutup — jadi nav kelihatan nyangkut aktif di Profil terus,
    // padahal user sudah balik lihat galeri. Sinkronkan ulang di sini.
    highlightNav(showFavoritesOnly ? 'Favorit' : 'Beranda');
  }

  async function loginWithProvider(provider) {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin + window.location.pathname }
    });
    if (error) showToast('Gagal memulai login', 'error');
  }


  // Tampilkan halaman login ulang bergaya branded (hanya dipanggil setelah
  // user menekan "Keluar" — bukan gerbang untuk tamu yang belum pernah login)
  function openReloginScreen() {
    document.getElementById('reloginScreen').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeReloginScreen() {
    const el = document.getElementById('reloginScreen');
    el.classList.remove('open');
    document.body.style.overflow = '';
  }

  async function logoutUser() {
    await supabaseClient.auth.signOut();
    currentUser = null;
    notifications = [];
    renderNotifBadge();
    updateProfileUI();
    closeProfileModal();
    showToast('Berhasil keluar');
    // Kembali ke favorit lokal (localStorage) setelah logout
    try {
      favorites = new Set(JSON.parse(localStorage.getItem('sg_favorites') || '[]'));
    } catch (e) {
      favorites = new Set();
    }
    filterAndRender();
    // Halaman login ulang bergaya branded — hanya muncul di alur logout ini
    openReloginScreen();
  }

  // Tampilkan sisa kuota download gratis untuk guest supaya ajakan masuk
  // terasa lebih konkret (bukan cuma "biar sinkron").
  function updateProfileQuotaText() {
    const el = document.getElementById('profileQuotaDesc');
    if (!el || currentUser) return;
    const remaining = Math.max(0, GUEST_DOWNLOAD_LIMIT - getGuestDownloadCount());
    if (remaining > 0) {
      el.innerHTML = `Sisa <strong>${remaining}x</strong> download gratis hari ini. Masuk untuk unlimited & sinkron di semua perangkat.`;
    } else {
      el.innerHTML = `Batas download gratis tercapai. Masuk untuk lanjut download tanpa batas & sinkron di semua perangkat.`;
    }
  }

  function updateProfileUI() {
    const loggedOutBox = document.getElementById('profileLoggedOut');
    const loggedInBox = document.getElementById('profileLoggedIn');
    if (currentUser) {
      loggedOutBox.style.display = 'none';
      loggedInBox.style.display = 'block';
      const email = currentUser.email || '';
      document.getElementById('profileEmail').textContent = email;
      document.getElementById('profileAvatar').textContent = email.charAt(0).toUpperCase();
    } else {
      loggedOutBox.style.display = 'block';
      loggedInBox.style.display = 'none';
      updateProfileQuotaText();
    }
  }

  // Ambil favorit dari Supabase lalu gabung dengan favorit lokal (kalau ada
  // favorit yang ditambah sebelum login, ikut disimpan ke akun juga)
  async function syncFavoritesAfterLogin() {
    const { data, error } = await supabaseClient.from('favorites').select('image_id').eq('user_id', currentUser.id);
    if (error) { console.error('Gagal ambil favorit:', error); return; }

    const serverFavIds = new Set(data.map(r => r.image_id));
    const localOnlyIds = [...favorites].filter(id => !serverFavIds.has(id));

    // Upload favorit lokal yang belum ada di server
    if (localOnlyIds.length > 0) {
      const rows = localOnlyIds.map(image_id => ({ user_id: currentUser.id, image_id }));
      const { error: insertErr } = await supabaseClient.from('favorites').insert(rows);
      if (insertErr) console.error('Gagal upload favorit lokal:', insertErr);
    }

    favorites = new Set([...serverFavIds, ...localOnlyIds]);
    filterAndRender();
    checkForNewNotifications();
  }

  async function initAuth() {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      currentUser = session.user;
      updateProfileUI();
      loadNotificationsForUser();
      syncFavoritesAfterLogin();
    }

    supabaseClient.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session) {
        currentUser = session.user;
        updateProfileUI();
        loadNotificationsForUser();
        syncFavoritesAfterLogin();
        closeProfileModal();
        closeReloginScreen();
        showToast('Berhasil masuk', 'success');
        if (typeof gtag === 'function') gtag('event', 'login', { method: 'google' });
      } else if (event === 'SIGNED_OUT') {
        currentUser = null;
        notifications = [];
        renderNotifBadge();
        updateProfileUI();
      }
    });
  }

  function toggleFavoritesView() {
    showFavoritesOnly = !showFavoritesOnly;
    if (showFavoritesOnly) {
      activeCategory = 'all';
      searchQuery = '';
      document.getElementById('searchInput').value = '';
      renderCategories();
    }
    highlightNav(showFavoritesOnly ? 'Favorit' : 'Beranda');
    filterAndRender();
  }

  // ===== INIT =====
  document.addEventListener('DOMContentLoaded', () => {
    renderCategories();
    simulateLoad();
    setupSearch();
    initAuth();
    setupRealtimeImages();
    setupRealtimeCategories();
  });

  function renderCategories() {
    const bar = document.getElementById('categoriesBar');
    bar.innerHTML = CATEGORIES.map(c =>
      `<button class="chip ${c.id === activeCategory ? 'active' : ''}" data-cat="${c.id}" aria-pressed="${c.id === activeCategory}" onclick="selectCategory('${c.id}')">${escapeHtml(c.label)}</button>`
    ).join('');
  }

  function selectCategory(catId) {
    activeCategory = catId;
    showFavoritesOnly = false;
    highlightNav('Beranda');
    renderCategories();
    filterAndRender();
    const activeChip = document.querySelector(`#categoriesBar .chip[data-cat="${catId}"]`);
    if (activeChip) {
      activeChip.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }

  // ===== MODAL "SEMUA KATEGORI" =====
  // Solusi biar chip bar tetap enak dipakai walau kategori terus nambah:
  // chip bar horizontal cuma nampung akses cepat, sementara modal ini
  // nampilin SEMUA kategori sekaligus, dikelompokkan per huruf awal (mirip
  // A-Z index kontak) plus kotak pencarian buat langsung loncat ke kategori
  // yang dicari tanpa scroll manual.
  function openCategoriesModal() {
    const search = document.getElementById('categoriesModalSearch');
    search.value = '';
    renderCategoriesModalList('');
    document.getElementById('categoriesModal').classList.add('open');
    setTimeout(() => search.focus(), 250);
  }

  function closeCategoriesModal(e) {
    if (e && e.target !== e.currentTarget) return;
    document.getElementById('categoriesModal').classList.remove('open');
  }

  function filterCategoriesModal(query) {
    renderCategoriesModalList(query);
  }

  function renderCategoriesModalList(query) {
    const list = document.getElementById('categoriesModalList');
    const q = query.trim().toLowerCase();
    const realCats = CATEGORIES.filter(c => c.id !== 'all');
    const filtered = q ? realCats.filter(c => c.label.toLowerCase().includes(q)) : realCats;

    if (filtered.length === 0) {
      list.innerHTML = `<div class="cat-modal-empty">Kategori "${query}" tidak ditemukan</div>`;
      return;
    }

    // Kelompokkan per huruf awal (CATEGORIES sudah terurut abjad dari
    // sortCategories(), jadi tinggal group berurutan tanpa sort ulang).
    const groups = [];
    let currentLetter = '';
    filtered.forEach(c => {
      const letter = (c.label[0] || '#').toUpperCase();
      if (letter !== currentLetter) {
        currentLetter = letter;
        groups.push({ letter, items: [] });
      }
      groups.at(-1).items.push(c);
    });

    list.innerHTML = groups.map(g => `
      <div class="cat-modal-group">
        <div class="cat-modal-group-title">${g.letter}</div>
        <div class="cat-modal-grid">
          ${g.items.map(c => `<button type="button" class="cat-modal-chip ${c.id === activeCategory ? 'active' : ''}" onclick="selectCategoryFromModal('${c.id}')">${escapeHtml(c.label)}</button>`).join('')}
        </div>
      </div>
    `).join('');
  }

  function selectCategoryFromModal(catId) {
    selectCategory(catId);
    closeCategoriesModal();
  }

  // Klik ikon "Cari" berarti user mau menjelajah/mencari semua gambar —
  // kalau lagi di mode Favorit-only, filter itu harus dimatikan dulu,
  // supaya galeri tidak tetap kosong sebelum user sempat mengetik apa pun.
  function focusSearch() {
    if (showFavoritesOnly) {
      showFavoritesOnly = false;
      filterAndRender();
    }
    document.getElementById('searchInput').focus();
  }

  function setupSearch() {
    const input = document.getElementById('searchInput');
    let debounce;
    input.addEventListener('focus', () => {
      if (showFavoritesOnly) {
        showFavoritesOnly = false;
        highlightNav('Beranda');
        filterAndRender();
      }
    });
    input.addEventListener('input', (e) => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        searchQuery = e.target.value.toLowerCase().trim();
        if (showFavoritesOnly) highlightNav('Beranda');
        showFavoritesOnly = false;
        filterAndRender();
      }, 250);
    });
  }

  // Kalau thumbnail via wsrv.nl gagal dimuat, coba dulu pakai URL asli
  // sebelum benar-benar dianggap gagal (bukan langsung sembunyikan gambar).
  function handleGridImgError(imgEl, imgId) {
    if (imgEl.dataset.fallback === '1') {
      // Sudah pernah coba URL asli dan tetap gagal -> baru dianggap gagal beneran
      imgEl.dataset.loaded = '1';
      const card = imgEl.closest('.gallery-card');
      if (card) card.classList.add('img-error');
      return;
    }
    const img = IMAGES.find(i => i.id === imgId);
    if (!img) return;
    imgEl.dataset.fallback = '1';
    imgEl.src = img.url;
  }

  // Sama seperti handleGridImgError, tapi untuk gambar di dalam modal
  // preview: fallback ke URL asli dulu, baru kalau tetap gagal tampilkan
  // state error di modal (bukan diam-diam gagal tanpa feedback).
  function handleModalImgError(imgEl) {
    if (imgEl.dataset.fallback === '1') {
      imgEl.dataset.loaded = '1';
      const wrap = document.getElementById('modalImageWrap');
      if (wrap) wrap.classList.add('img-error');
      showToast('Gambar gagal dimuat', 'error');
      return;
    }
    if (!currentModalImage || !currentModalImage.url) return;
    imgEl.dataset.fallback = '1';
    imgEl.src = currentModalImage.url;
  }

  // ===== ANTI-MACET: watchdog buat thumbnail yang nyangkut loading =====
  // <img> tidak punya timeout bawaan di browser. Kalau request ke wsrv.nl
  // nyangkut (mis. cache proxy masih dingin & source-nya lambat diambil),
  // gambar bisa diam selamanya tanpa pernah trigger onload/onerror -> kartu
  // keliatan kosong/abu-abu terus. Watchdog ini kasih batas waktu: kalau
  // belum kelar, coba ulang sekali (request baru), lalu fallback ke URL asli.
  const IMG_LOAD_TIMEOUT_MS = 6000;

  function watchImageLoad(imgEl, imgId) {
    const timeoutId = setTimeout(() => {
      if (imgEl.dataset.loaded === '1') return; // sudah kelar duluan, aman
      const attempt = parseInt(imgEl.dataset.attempt || '0', 10);
      if (attempt < 1) {
        // Percobaan ulang pertama: paksa request baru (cache-buster) siapa
        // tahu koneksi sebelumnya cuma nyangkut, bukan beneran gagal.
        imgEl.dataset.attempt = '1';
        const sep = imgEl.src.includes('?') ? '&' : '?';
        imgEl.src = imgEl.src + sep + '_retry=' + Date.now();
        watchImageLoad(imgEl, imgId);
      } else {
        // Masih macet juga -> langsung fallback ke gambar asli (alur yang
        // sama seperti kalau wsrv.nl bener-bener error).
        handleGridImgError(imgEl, imgId);
      }
    }, IMG_LOAD_TIMEOUT_MS);

    const clear = () => clearTimeout(timeoutId);
    imgEl.addEventListener('load', clear, { once: true });
    imgEl.addEventListener('error', clear, { once: true });
  }

  // Watchdog yang sama seperti watchImageLoad, tapi untuk gambar di modal
  // preview (bukan kartu grid) -> supaya modal juga tidak diam selamanya
  // kalau request ke wsrv.nl nyangkut, bukan cuma error langsung.
  function watchModalImageLoad(imgEl, imgId) {
    const timeoutId = setTimeout(() => {
      if (imgEl.dataset.loaded === '1') return; // sudah kelar duluan, aman
      // Modal sudah ganti ke gambar lain / sudah ditutup -> jangan utak-atik lagi
      if (!currentModalImage || currentModalImage.id !== imgId) return;
      const attempt = parseInt(imgEl.dataset.attempt || '0', 10);
      if (attempt < 1) {
        imgEl.dataset.attempt = '1';
        const sep = imgEl.src.includes('?') ? '&' : '?';
        imgEl.src = imgEl.src + sep + '_retry=' + Date.now();
        watchModalImageLoad(imgEl, imgId);
      } else {
        handleModalImgError(imgEl);
      }
    }, IMG_LOAD_TIMEOUT_MS);

    const clear = () => clearTimeout(timeoutId);
    imgEl.addEventListener('load', clear, { once: true });
    imgEl.addEventListener('error', clear, { once: true });
  }

  // ===== SMART SEARCH =====
  // Search lama cuma cocok kalau frasa persis nemplok di title/kategori
  // (pakai .includes()), jadi user harus ketik persis urutan & ejaan yang
  // benar. Versi ini: pecah query jadi kata per kata, tiap kata dicocokkan
  // bebas urutan ke kata manapun di title/kategori, dikasih skor beda-beda
  // tergantung tipe kecocokan (persis > prefix > substring > typo ringan),
  // baru hasilnya diurutkan dari yang paling relevan.

  // Jarak edit (Levenshtein) antara 2 kata, berhenti lebih awal begitu
  // udah kepastian lewat maxDist -> hemat kerja buat toleransi typo ringan.
  function levenshteinDistance(a, b, maxDist) {
    const la = a.length, lb = b.length;
    if (Math.abs(la - lb) > maxDist) return maxDist + 1;
    let prev = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      const curr = new Array(lb + 1);
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= lb; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + cost
        );
        if (curr[j] < rowMin) rowMin = curr[j];
      }
      if (rowMin > maxDist) return maxDist + 1;
      prev = curr;
    }
    return prev[lb];
  }

  // Skor kecocokan 1 kata query vs 1 kata target (title/kategori).
  // 0 = ga nyambung sama sekali.
  function wordMatchScore(queryWord, targetWord) {
    if (!queryWord || !targetWord) return 0;
    if (targetWord === queryWord) return 100;                 // persis sama
    if (targetWord.startsWith(queryWord)) return 70;           // prefix, mis. "gau" -> "gaun"
    if (queryWord.length >= 3 && targetWord.includes(queryWord)) return 45; // muncul di tengah kata
    if (queryWord.length >= 4) {                                // typo ringan (maks 1 huruf beda)
      if (levenshteinDistance(queryWord, targetWord, 1) <= 1) return 55;
    }
    return 0;
  }

  // Skor total 1 gambar untuk seluruh kata di query. Kalau ada 1 kata query
  // yang sama sekali ga nemu padanan di title/kategori, gambar ini dianggap
  // ga relevan (return -1) -> tetap butuh SEMUA kata match, tapi urutan bebas.
  function smartSearchScore(queryWords, img) {
    const titleWords = img.title.toLowerCase().split(/\s+/).filter(Boolean);
    const categoryWords = img.category.toLowerCase().split(/\s+/).filter(Boolean);
    const allTargetWords = titleWords.concat(categoryWords);

    let totalScore = 0;
    for (const qw of queryWords) {
      let best = 0;
      for (const tw of allTargetWords) {
        const s = wordMatchScore(qw, tw);
        if (s > best) best = s;
      }
      if (best === 0) return -1;
      totalScore += best;
    }
    // Bonus kecil kalau frasa penuh query kebetulan nemplok persis di title
    // (naikin hasil yang "paling pas" ke atas dibanding yang cuma cocok per-kata)
    const fullQuery = queryWords.join(' ');
    if (img.title.toLowerCase().includes(fullQuery)) totalScore += 20;
    return totalScore;
  }

  // Filter + urutkan items berdasar relevansi ke query. Query dipecah jadi
  // kata (toleransi urutan), tiap kata boleh cocok prefix/substring/typo-1-huruf.
  function smartSearch(items, query) {
    const queryWords = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (queryWords.length === 0) return items;

    const scored = [];
    for (const img of items) {
      const score = smartSearchScore(queryWords, img);
      if (score >= 0) scored.push({ img, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.img);
  }

  function filterAndRender() {
    recomputeTrendingIds();
    let filtered = IMAGES;
    if (showFavoritesOnly) {
      filtered = filtered.filter(img => favorites.has(img.id));
    }
    if (activeCategory !== 'all') {
      filtered = filtered.filter(img => img.category === activeCategory);
    }
    if (searchQuery) {
      filtered = smartSearch(filtered, searchQuery);
    }
    // Urutan berdasar minat kategori hanya untuk feed default "Semua" —
    // saat user cari, filter favorit, atau pilih kategori sendiri, urutan
    // asli (terbaru dulu) tetap dipakai supaya hasilnya predictable.
    if (activeCategory === 'all' && !showFavoritesOnly && !searchQuery) {
      filtered = applyCategoryAffinitySort(filtered);
    }
    renderGallery(filtered);
  }

  // ===== RENDER BERTAHAP (biar gambar pertama cepat muncul) =====
  // Daripada dump semua kartu sekaligus (bikin puluhan gambar diminta
  // bersamaan ke server), render 1 batch dulu, sisanya nyusul otomatis
  // pas user scroll ke bawah.
  const GALLERY_BATCH_SIZE = 20;
  // Jumlah kartu pertama yang dimuat "eager" (kira-kira yang tampak tanpa
  // scroll) -- dipakai juga oleh splash loader di bawah buat nentuin
  // berapa gambar yang perlu ditunggu sebelum galeri ditampilkan.
  const EAGER_CARD_COUNT = 10;
  let currentFilteredItems = [];
  let renderedCount = 0;

  function cardHtml(img, idx) {
    const [w, h] = img.size.split('×').map(Number);
    const ratio = (w && h) ? `${w}/${h}` : '1/1';
    // Kartu pertama (kira-kira yang tampak tanpa scroll) dimuat lebih prioritas
    const eager = idx < EAGER_CARD_COUNT;
    return `
      <div class="gallery-card" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openModal(${img.id});}">
        <img
          src="${gridThumb(img.url)}"
          srcset="${gridThumbSrcset(img.url)}"
          alt="Status ${escapeHtml(catLabel(img.category))} - ${escapeHtml(img.title)} | Download gambar status HD gratis"
          style="aspect-ratio:${ratio}"
          loading="${eager ? 'eager' : 'lazy'}"
          fetchpriority="${eager ? 'high' : 'low'}"
          decoding="async"
          data-loaded="0"
          onload="this.dataset.loaded='1'; this.closest('.gallery-card').classList.remove('img-error')"
          onerror="handleGridImgError(this, ${img.id})">
        <div class="img-touch-catcher" data-img-id="${img.id}" aria-hidden="true"></div>
        <button class="card-fav-btn ${favorites.has(img.id) ? 'active' : ''}" aria-label="${favorites.has(img.id) ? 'Hapus dari favorit' : 'Tambah ke favorit'}" onclick="event.stopPropagation(); toggleFavorite(${img.id})">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="${favorites.has(img.id) ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round"><use href="#icon-heart"></use></svg>
        </button>
        ${trendingIds.has(img.id) ? '<span class="card-trending-badge">🔥 Trending</span>' : ''}
        <div class="card-overlay">
          <div class="card-title">${escapeHtml(img.title)}</div>
        </div>
      </div>
    `;
  }

  // Berapa kolom yang dipakai di galeri utama, mengikuti breakpoint yang
  // sama seperti CSS lama (2 di HP, naik sampai 6 di layar lebar).
  function galleryColumnCount() {
    if (window.matchMedia('(min-width: 1400px)').matches) return 6;
    if (window.matchMedia('(min-width: 1200px)').matches) return 5;
    if (window.matchMedia('(min-width: 900px)').matches) return 4;
    if (window.matchMedia('(min-width: 640px)').matches) return 3;
    return 2;
  }

  // Kosongkan galeri & siapkan kolom² baru (dipanggil tiap mulai render
  // dari awal). Dulu galeri cuma satu container flat yg disusun ke kolom
  // pakai CSS `column-count` -- tapi itu bikin SEMUA item ke-reflow /
  // pindah kolom tiap kali ada tambahan konten (lihat catatan panjang di
  // CSS .gallery & di renderModalSimilar). Sekarang kolomnya dibuat manual
  // di sini, item baru selalu masuk lewat appendItemsToColumns() ke kolom
  // yang saat itu paling pendek, dan item yang sudah ada tidak pernah
  // disentuh ulang.
  function setupGalleryColumns(gallery) {
    gallery.innerHTML = '';
    const colCount = galleryColumnCount();
    for (let i = 0; i < colCount; i++) {
      const col = document.createElement('div');
      col.className = 'gallery-col';
      gallery.appendChild(col);
    }
    // Reset estimasi tinggi kolom tiap kali kolom dibuat ulang (lihat
    // catatan panjang di appendItemsToColumns soal kenapa ini dibutuhkan).
    gallery._colHeights = new Array(colCount).fill(0);
  }

  // PERBAIKAN PERFORMANCE: sebelumnya kolom "paling pendek" dipilih pakai
  // `col.offsetHeight` yang dibaca ULANG setelah tiap 1 kartu di-insert.
  // Pola tulis-DOM -> baca-offsetHeight -> tulis-DOM -> baca-offsetHeight
  // ini memaksa browser melakukan *synchronous layout reflow* di SETIAP
  // iterasi (layout thrashing) -- untuk 20 kartu per batch itu 20 reflow
  // paksa, dan ini terpanggil ulang tiap ada event realtime dari Supabase
  // (termasuk cuma gara-gara ada ORANG LAIN mendownload gambar). Di HP,
  // ini yang paling bikin terasa "berat"/nge-lag.
  //
  // Solusinya: estimasi tinggi tiap kolom dari DATA (rasio lebar/tinggi
  // gambar yang sudah kita punya), bukan dari DOM -- jadi tidak ada
  // pembacaan layout sama sekali saat nge-append kartu.
  function appendItemsToColumns(gallery, items, baseIdx) {
    const cols = Array.from(gallery.querySelectorAll('.gallery-col'));
    if (cols.length === 0) return;
    if (!gallery._colHeights || gallery._colHeights.length !== cols.length) {
      gallery._colHeights = cols.map(() => 0);
    }
    const heights = gallery._colHeights;
    const CARD_CHROME = 46; // perkiraan tinggi tetap (overlay judul, dll)
    const REF_WIDTH = 300;  // lebar acuan buat estimasi -- sama utk semua kolom, jadi hasil bandingnya tetap valid walau bukan pixel asli

    const frags = cols.map(() => document.createDocumentFragment());

    items.forEach((img, i) => {
      let shortestIdx = 0;
      for (let c = 1; c < heights.length; c++) {
        if (heights[c] < heights[shortestIdx]) shortestIdx = c;
      }
      const [w, h] = img.size.split('×').map(Number);
      const estHeight = (w && h) ? (h / w) * REF_WIDTH + CARD_CHROME : REF_WIDTH + CARD_CHROME;
      heights[shortestIdx] += estHeight;

      const wrapper = document.createElement('div');
      wrapper.innerHTML = cardHtml(img, baseIdx + i).trim();
      const card = wrapper.firstElementChild;
      frags[shortestIdx].appendChild(card);
      const imgEl = card.querySelector('img');
      if (imgEl) watchImageLoad(imgEl, img.id);
    });

    // Semua kartu ditulis ke DOM sekaligus per kolom di akhir (bukan
    // satu-satu bercampur baca-offsetHeight), jadi browser cuma perlu
    // 1 layout pass per kolom, bukan 1 per kartu.
    cols.forEach((col, c) => col.appendChild(frags[c]));
  }

  function appendNextBatch() {
    const gallery = document.getElementById('gallery');
    const nextItems = currentFilteredItems.slice(renderedCount, renderedCount + GALLERY_BATCH_SIZE);
    if (nextItems.length === 0) return;
    appendItemsToColumns(gallery, nextItems, renderedCount);
    renderedCount += nextItems.length;
  }

  // Cek jarak ke bawah halaman; kalau sudah dekat & masih ada sisa item,
  // render batch berikutnya. Dipanggil saat scroll (throttled lewat rAF).
  let scrollTicking = false;
  function maybeLoadMoreGallery() {
    if (renderedCount >= currentFilteredItems.length) return;
    const distanceToBottom = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
    if (distanceToBottom < 900) {
      appendNextBatch();
    }
  }
  window.addEventListener('scroll', () => {
    if (scrollTicking) return;
    scrollTicking = true;
    requestAnimationFrame(() => {
      maybeLoadMoreGallery();
      scrollTicking = false;
    });
  }, { passive: true });

  function renderGallery(items) {
    const loading = document.getElementById('loadingState');
    const empty = document.getElementById('emptyState');
    const error = document.getElementById('errorState');
    const gallery = document.getElementById('gallery');

    loading.classList.add('hidden');
    error.classList.add('hidden');

    if (items.length === 0) {
      currentFilteredItems = [];
      renderedCount = 0;
      gallery.classList.add('hidden');
      empty.classList.remove('hidden');
      const title = document.getElementById('emptyStateTitle');
      const desc = document.getElementById('emptyStateDesc');
      if (showFavoritesOnly) {
        title.textContent = 'Belum ada favorit';
        desc.textContent = 'Tap ikon hati pada gambar untuk menyimpannya di sini.';
      } else if (searchQuery) {
        title.textContent = 'Tidak ada hasil';
        desc.textContent = `Tidak ditemukan gambar untuk "${searchQuery}". Coba kata kunci lain.`;
      } else {
        title.textContent = 'Belum ada gambar';
        desc.textContent = 'Belum ada gambar di kategori ini. Coba kategori lain.';
      }
      return;
    }

    empty.classList.add('hidden');
    gallery.classList.remove('hidden');

    // BUG FIX: filterAndRender() (=> renderGallery()) bisa terpanggil
    // berkali-kali di background tanpa aksi user yg disengaja -- misal tiap
    // ada event realtime dari Supabase (termasuk saat ada ORANG LAIN
    // mendownload gambar, yg cuma menaikkan angka `downloads`), atau saat
    // toggleFavorite() dipanggil. Sebelumnya, fungsi ini SELALU mereset
    // `renderedCount` ke 0 dan mengosongkan grid lalu render ulang cuma
    // batch pertama (20 item) -- padahal kalau user sudah scroll jauh dan
    // memuat beberapa batch, itu artinya batch2 yg sudah dimuat itu HILANG
    // dan grid "mundur" ke 20 item pertama tanpa user sadar. Efeknya:
    // gambar yg tadi keliatan di posisi bawah viewport tiba2 "berubah"
    // begitu discroll, padahal sebenarnya itu grid yg diam2 di-render ulang
    // dari awal.
    //
    // Kalau SET & URUTAN gambar (`items`) sebenarnya sama persis dgn yg
    // sudah tampil, kita tidak perlu reset ke batch pertama -- cukup
    // render ulang JUMLAH kartu yg SUDAH tampil (bukan cuma 20), supaya
    // scroll & batch yg sudah dimuat user tetap utuh. Ini juga otomatis
    // me-refresh data terbaru di tiap kartu (status favorit, judul, dsb).
    const sameOrder = renderedCount > 0 && items.length === currentFilteredItems.length &&
      items.every((img, i) => img.id === currentFilteredItems[i].id);

    currentFilteredItems = items;

    if (sameOrder) {
      const keepCount = Math.min(renderedCount, items.length);
      setupGalleryColumns(gallery);
      appendItemsToColumns(gallery, items.slice(0, keepCount), 0);
      renderedCount = keepCount;
      return;
    }

    // Set/urutan gambar benar2 berubah (filter/kategori/pencarian diganti,
    // ada gambar baru/dihapus, atau ini render pertama) -> render dari awal.
    renderedCount = 0;
    setupGalleryColumns(gallery);
    appendNextBatch();

    // Jaga-jaga kalau layar besar & batch pertama belum memenuhi
    // viewport (jadi belum ada scroll), langsung cek & tambah lagi.
    requestAnimationFrame(maybeLoadMoreGallery);
  }

  function simulateLoad() {
    loadData();
  }

  // Mengubah 1 baris tabel `images` dari Supabase jadi bentuk objek yang
  // dipakai UI (sama persis seperti mapping di loadData()).
  function mapImageRow(r) {
    return {
      id: r.id,
      title: r.title,
      category: r.category_id,
      url: r.url,
      size: (r.width && r.height) ? `${r.width}×${r.height}` : '',
      downloads: r.downloads,
      created_at: r.created_at
    };
  }

  // ===== REALTIME: gambar baru dari Admin langsung tampil tanpa refresh =====
  // Dengar perubahan tabel `images` lewat Supabase Realtime, lalu update
  // state IMAGES di browser dan render ulang gallery secara otomatis.
  //
  // PENTING - supaya event ini benar-benar terkirim, Realtime harus
  // diaktifkan dulu utk tabel `images` (sekali saja, di sisi Supabase):
  // Dashboard -> Database -> Replication -> aktifkan tabel `images`,
  // ATAU jalankan SQL ini sekali di SQL Editor:
  //   alter publication supabase_realtime add table images;
  // PERBAIKAN PERFORMANCE: event realtime dari Supabase bisa datang
  // beruntun dalam waktu singkat (mis. beberapa orang download gambar
  // yang berbeda hampir bersamaan). Kalau tiap event langsung memicu
  // filterAndRender() (yang menyusun ulang seluruh grid), grid bisa
  // di-render ulang berkali-kali dalam sedetik. scheduleRealtimeRender()
  // menggabungkan event-event yang datang berdekatan jadi 1 render saja.
  let realtimeRenderTimer = null;
  function scheduleRealtimeRender() {
    clearTimeout(realtimeRenderTimer);
    realtimeRenderTimer = setTimeout(filterAndRender, 350);
  }

  function setupRealtimeImages() {
    supabaseClient
      .channel('public:images')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'images' }, (payload) => {
        const row = payload.new;
        if (!row.is_active) return; // belum aktif -> jangan tampilkan dulu
        if (IMAGES.some(i => i.id === row.id)) return; // jaga-jaga duplikat
        IMAGES.unshift(mapImageRow(row));
        scheduleRealtimeRender();
        showToast(`Gambar baru ditambahkan: ${row.title}`, 'success');
        checkForNewNotifications();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'images' }, (payload) => {
        const row = payload.new;
        const idx = IMAGES.findIndex(i => i.id === row.id);
        if (!row.is_active) {
          // Admin menyembunyikan gambar ini -> hapus dari tampilan publik
          if (idx !== -1) { IMAGES.splice(idx, 1); scheduleRealtimeRender(); }
          return;
        }
        const mapped = mapImageRow(row);
        if (idx !== -1) IMAGES[idx] = mapped; else IMAGES.unshift(mapped);
        scheduleRealtimeRender();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'images' }, (payload) => {
        const oldId = payload.old.id;
        const idx = IMAGES.findIndex(i => i.id === oldId);
        if (idx !== -1) { IMAGES.splice(idx, 1); scheduleRealtimeRender(); }
      })
      .subscribe();
  }

  // Mengubah 1 baris tabel `categories` jadi bentuk objek yang dipakai UI.
  function mapCategoryRow(r) {
    return { id: r.id, label: r.label, sort_order: r.sort_order };
  }

  // Urutkan CATEGORIES berdasarkan abjad (label), dengan 'all' selalu di
  // posisi pertama. Pakai localeCompare 'id' + sensitivity 'base' supaya
  // besar/kecil huruf dan variasi aksen diurutkan secara natural.
  function sortCategories() {
    const all = CATEGORIES.find(c => c.id === 'all') || { id: 'all', label: 'Semua' };
    const rest = CATEGORIES
      .filter(c => c.id !== 'all')
      .sort((a, b) => a.label.localeCompare(b.label, 'id', { sensitivity: 'base' }));
    CATEGORIES = [all, ...rest];
  }

  // ===== REALTIME: kategori baru dari Admin langsung tampil tanpa refresh =====
  // Sama seperti setupRealtimeImages(), tapi utk tabel `categories`. Supaya
  // event ini terkirim, Realtime juga harus diaktifkan utk tabel `categories`
  // (sekali saja, di sisi Supabase):
  //   alter publication supabase_realtime add table categories;
  function setupRealtimeCategories() {
    supabaseClient
      .channel('public:categories')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'categories' }, (payload) => {
        const row = payload.new;
        if (row.id === 'all' || CATEGORIES.some(c => c.id === row.id)) return;
        CATEGORIES.push(mapCategoryRow(row));
        sortCategories();
        renderCategories();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'categories' }, (payload) => {
        const row = payload.new;
        const idx = CATEGORIES.findIndex(c => c.id === row.id);
        if (idx === -1) return;
        CATEGORIES[idx] = mapCategoryRow(row);
        sortCategories();
        renderCategories();
        // Label kategori bisa berubah -> render ulang gallery supaya nama
        // kategori di kartu/modal ikut ter-update kalau lagi ditampilkan.
        scheduleRealtimeRender();
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'categories' }, (payload) => {
        const oldId = payload.old.id;
        const idx = CATEGORIES.findIndex(c => c.id === oldId);
        if (idx === -1) return;
        CATEGORIES.splice(idx, 1);
        renderCategories();
        // Kalau kategori yang lagi difilter dihapus, balik ke "Semua" supaya
        // gallery tidak nyangkut kosong di kategori yang sudah tidak ada.
        if (activeCategory === oldId) {
          activeCategory = 'all';
        }
        scheduleRealtimeRender();
      })
      .subscribe();
  }

  // ===== SPLASH LOADER: tunggu batch gambar pertama sebelum masuk menu utama =====
  // Nunggu N gambar pertama (yang eager-load, keliatan tanpa scroll) selesai
  // dimuat sebelum overlay ini disembunyikan -- supaya begitu user lihat
  // galeri, gambarnya udah utuh, bukan kotak kosong yang lagi loading.
  // Sisa gambar lain (di luar N ini) TETAP lazy-load seperti biasa saat
  // discroll -- bukan ditunggu semua, supaya loading awal tetap cepat walau
  // total gambar di galeri ada ratusan.
  // Jalan cuma SEKALI per kunjungan (initial load), bukan tiap ganti
  // kategori/pencarian/realtime update.
  let appLoaderDone = false;
  // Jaga-jaga kalau gambar lambat/gagal dimuat (misal cold cache CDN di
  // kunjungan pertama -- lihat pembahasan sebelumnya soal wsrv.nl): overlay
  // WAJIB hilang setelah batas waktu ini apa pun yang terjadi, supaya user
  // gak pernah kejebak di loading screen selamanya.
  const APP_LOADER_TIMEOUT_MS = 8000; // dinaikkan dikit karena sekarang nunggu lebih banyak gambar (EAGER_CARD_COUNT)
  // Durasi MINIMUM loader tetap tampil, walau semua gambar sudah kelar
  // dimuat lebih cepat dari ini -- supaya logo splash sempat kelihatan utuh
  // (gak "kedip" sekilas doang di koneksi cepat / gambar dari cache).
  const APP_LOADER_MIN_MS = 2000;
  // Dicatat begitu script ini jalan (yaitu begitu overlay-nya sudah muncul
  // di layar), dipakai buat ngitung berapa lama loader sudah tampil.
  const appLoaderStartTime = Date.now();

  function hideAppLoader() {
    if (appLoaderDone) return;
    const elapsed = Date.now() - appLoaderStartTime;
    const remaining = APP_LOADER_MIN_MS - elapsed;
    if (remaining > 0) {
      // Belum genap durasi minimum -- tunda dulu, coba lagi nanti.
      setTimeout(hideAppLoader, remaining);
      return;
    }
    appLoaderDone = true;
    const el = document.getElementById('appLoader');
    if (!el) return;
    el.classList.add('hide');
    setTimeout(() => { el.style.display = 'none'; }, 400); // samain sama durasi transition CSS-nya
  }

  // Tinggi viewBox SVG logo loader (lihat viewBox="0 0 10.74475 4.17754" di
  // index.html) -- dipakai buat ngitung seberapa tinggi kotak kuning yang
  // "mengisi" logo dari bawah ke atas sesuai persen loading.
  const LOADER_LOGO_VB_HEIGHT = 4.17754;

  function updateAppLoaderProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 100;
    const percent = document.getElementById('appLoaderPercent');
    const fillRect = document.getElementById('loaderFillRect');
    if (percent) percent.textContent = pct + '%';
    if (fillRect) {
      // Kotak kuning di-clip persis mengikuti bentuk logo (lihat clipPath
      // #loaderFillClip di index.html) -- makin tinggi kotaknya, makin
      // banyak bagian logo yang "kelihatan" kuning (nutupin putih di
      // baliknya), naik dari bawah ke atas kayak level air.
      const filledHeight = LOADER_LOGO_VB_HEIGHT * (pct / 100);
      fillRect.setAttribute('y', (LOADER_LOGO_VB_HEIGHT - filledHeight).toFixed(5));
      fillRect.setAttribute('height', filledHeight.toFixed(5));
    }
  }

  function trackFirstBatchAndHideLoader() {
    if (appLoaderDone) return;
    const gallery = document.getElementById('gallery');
    const imgs = gallery ? Array.from(gallery.querySelectorAll('img')).slice(0, EAGER_CARD_COUNT) : [];

    if (imgs.length === 0) {
      // Kategori kosong / gak ada gambar sama sekali -> gak ada yg perlu ditunggu.
      updateAppLoaderProgress(1, 1);
      hideAppLoader();
      return;
    }

    let done = 0;
    updateAppLoaderProgress(0, imgs.length);

    const markOneDone = () => {
      done++;
      updateAppLoaderProgress(done, imgs.length);
      if (done >= imgs.length) hideAppLoader();
    };

    imgs.forEach((img) => {
      if (img.complete && img.naturalWidth > 0) {
        // Udah selesai duluan (misal dari cache) sebelum listener dipasang.
        markOneDone();
      } else {
        img.addEventListener('load', markOneDone, { once: true });
        // Gagal load pun dihitung "selesai dicoba" -- biar 1 gambar rusak
        // gak bikin overlay nyangkut nunggu selamanya.
        img.addEventListener('error', markOneDone, { once: true });
      }
    });

    setTimeout(hideAppLoader, APP_LOADER_TIMEOUT_MS);
  }

  // ===== PREFETCH BACKGROUND: cache-in-diam2 sisa gambar saat browser idle =====
  // Supaya kunjungan BERIKUTNYA kerasa "instan semua" tanpa perlu nunggu
  // loading di depan, sisa thumbnail (di luar batch pertama) di-fetch
  // diam-diam satu-satu saat browser lagi idle. Request ini otomatis kena
  // tangkap oleh sw.js (strategi cache-first utk wsrv.nl) dan tersimpan ke
  // Cache Storage -- BUKAN localStorage, jadi gak ada batas ukuran ketat.
  // Konkurensi dibatasi kecil (2 sekaligus) biar gak rebutan bandwidth sama
  // request lain yang user lagi lakuin (misal buka modal gambar).
  const PREFETCH_IDLE_CONCURRENCY = 2;

  function idlePrefetchRemainingThumbs() {
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) return;

    const queue = IMAGES.slice(EAGER_CARD_COUNT).map(img => gridThumb(img.url));
    if (queue.length === 0) return;

    let idx = 0;
    let active = 0;

    function runNext(deadline) {
      while (
        idx < queue.length &&
        active < PREFETCH_IDLE_CONCURRENCY &&
        (!deadline || deadline.timeRemaining() > 0 || deadline.didTimeout)
      ) {
        const url = queue[idx++];
        active++;
        fetch(url, { mode: 'no-cors' })
          .catch(() => {}) // diam-diam aja, ini cuma prefetch best-effort
          .finally(() => {
            active--;
            scheduleNext();
          });
      }
    }

    function scheduleNext() {
      if (idx >= queue.length) return;
      if ('requestIdleCallback' in window) {
        requestIdleCallback(runNext, { timeout: 2000 });
      } else {
        setTimeout(() => runNext(null), 300); // fallback browser lama (Safari/iOS)
      }
    }

    scheduleNext();
  }

  async function loadData() {
    const loading = document.getElementById('loadingState');
    const empty = document.getElementById('emptyState');
    const error = document.getElementById('errorState');
    const gallery = document.getElementById('gallery');

    empty.classList.add('hidden');
    error.classList.add('hidden');
    gallery.classList.add('hidden');
    loading.classList.remove('hidden');

    try {
      const [{ data: catRows, error: catErr }, { data: imgRows, error: imgErr }] = await Promise.all([
        supabaseClient.from('categories').select('id, label, sort_order').order('sort_order', { ascending: true }),
        supabaseClient.from('images').select('id, title, category_id, url, width, height, downloads, created_at').eq('is_active', true).order('created_at', { ascending: false })
      ]);

      if (catErr) throw catErr;
      if (imgErr) throw imgErr;

      // 'all' selalu jadi opsi pertama, sisanya dari database (skip id 'all' kalau kebawa)
      CATEGORIES = [
        { id: 'all', label: 'Semua' },
        ...catRows.filter(c => c.id !== 'all').map(c => ({ id: c.id, label: c.label, sort_order: c.sort_order }))
      ];
      sortCategories();

      IMAGES = imgRows.map(r => ({
        id: r.id,
        title: r.title,
        category: r.category_id,
        url: r.url,
        size: (r.width && r.height) ? `${r.width}×${r.height}` : '',
        downloads: r.downloads,
        created_at: r.created_at
      }));

      renderCategories();
      filterAndRender();
      trackFirstBatchAndHideLoader();
      idlePrefetchRemainingThumbs();
      checkForNewNotifications();
      const openedFromUrl = openInitialImageFromUrl();
      if (!openedFromUrl) maybeShowOnboarding();
    } catch (err) {
      console.error(err);
      loading.classList.add('hidden');
      error.classList.remove('hidden');
      showToast('Gagal memuat data', 'error');
      hideAppLoader(); // jangan biarkan user nyangkut di splash loader kalau data gagal dimuat
    }
  }

  function resetAll() {
    activeCategory = 'all';
    searchQuery = '';
    showFavoritesOnly = false;
    document.getElementById('searchInput').value = '';
    highlightNav('Beranda');
    renderCategories();
    filterAndRender();
  }

  // ===== MODAL =====
  // ===== SEO: URL & META TAG UNIK PER GAMBAR =====
  // App ini single-page (semua konten dirender lewat JS dari Supabase),
  // jadi TANPA ini Google cuma bisa index 1 URL: halaman utama. Sekarang tiap
  // kali modal gambar dibuka: (1) URL browser diganti ke ?img=<id>-<slug>
  // pakai History API (tanpa reload halaman, tetap SPA), dan (2) tag <title>,
  // meta description, Open Graph, Twitter Card, canonical, & JSON-LD
  // ImageObject di <head> diperbarui biar cocok sama gambar yang lagi dibuka.
  //
  // BATASAN YANG PERLU DISADARI (biar realistis, bukan janji berlebihan):
  // - Googlebot MODERN pada umumnya me-render JavaScript sebelum mengindeks,
  //   jadi update tag di atas tetap kebaca & membantu indexing per-gambar di
  //   Google Search/Images.
  // - TAPI bot preview link yang TIDAK menjalankan JavaScript (WhatsApp,
  //   Facebook, Twitter/X, Telegram) akan tetap nampilin OG default (gambar
  //   & teks generik halaman utama) waktu link "?img=123" di-share ke chat,
  //   BUKAN gambar spesifik itu. Preview per-gambar yang akurat di semua
  //   platform butuh server-side rendering / prerender per URL — itu langkah
  //   lanjutan di luar cakupan perubahan ini (murni frontend, tanpa server).
  // - sitemap.xml otomatis (biar Google nemuin semua URL gambar tanpa nunggu
  //   di-crawl manual) juga butuh proses generate terpisah (server/cron),
  //   nggak bisa dari file HTML statis ini saja.
  const DEFAULT_SEO = {
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content || '',
    ogTitle: document.querySelector('meta[property="og:title"]')?.content || '',
    ogDescription: document.querySelector('meta[property="og:description"]')?.content || '',
    ogImage: document.querySelector('meta[property="og:image"]')?.content || '',
    ogImageWidth: document.querySelector('meta[property="og:image:width"]')?.content || '',
    ogImageHeight: document.querySelector('meta[property="og:image:height"]')?.content || '',
    ogUrl: document.querySelector('meta[property="og:url"]')?.content || '',
    twitterTitle: document.querySelector('meta[name="twitter:title"]')?.content || '',
    twitterDescription: document.querySelector('meta[name="twitter:description"]')?.content || '',
    twitterImage: document.querySelector('meta[name="twitter:image"]')?.content || '',
    canonical: document.querySelector('link[rel="canonical"]')?.href || (window.location.origin + '/')
  };

  function slugify(text) {
    return (text || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  // ?img=<id>-<slug-judul> — angka di depan dipakai buat lookup (robust
  // walau judul kemudian diubah admin), slug di belakang cuma buat
  // keterbacaan URL & sinyal kata kunci tambahan buat Google.
  function imageUrlPath(img) {
    const slug = slugify(img.title);
    const basePath = window.location.pathname;
    return basePath + (slug ? `?img=${img.id}-${slug}` : `?img=${img.id}`);
  }

  function setMetaContent(selector, value) {
    const el = document.querySelector(selector);
    if (el) el.setAttribute('content', value);
  }

  function updateImageSEO(img) {
    const catLabel = (CATEGORIES.find(c => c.id === img.category) || {}).label || img.category;
    const title = `${img.title} — Status Gallery by EM2STUDIO`;
    const description = `Download gambar status WhatsApp "${img.title}" kategori ${catLabel} gratis dalam kualitas HD di Status Gallery.`;
    const pageUrl = window.location.origin + imageUrlPath(img);
    const [w, h] = (img.size || '').split('×').map(Number);

    document.title = title;
    setMetaContent('meta[name="description"]', description);
    setMetaContent('meta[property="og:title"]', title);
    setMetaContent('meta[property="og:description"]', description);
    setMetaContent('meta[property="og:image"]', img.url);
    if (w) setMetaContent('meta[property="og:image:width"]', String(w));
    if (h) setMetaContent('meta[property="og:image:height"]', String(h));
    setMetaContent('meta[property="og:url"]', pageUrl);
    setMetaContent('meta[name="twitter:title"]', title);
    setMetaContent('meta[name="twitter:description"]', description);
    setMetaContent('meta[name="twitter:image"]', img.url);
    const canonicalEl = document.querySelector('link[rel="canonical"]');
    if (canonicalEl) canonicalEl.href = pageUrl;

    updateImageStructuredData(img, pageUrl, description);
  }

  function restoreDefaultSEO() {
    document.title = DEFAULT_SEO.title;
    setMetaContent('meta[name="description"]', DEFAULT_SEO.description);
    setMetaContent('meta[property="og:title"]', DEFAULT_SEO.ogTitle);
    setMetaContent('meta[property="og:description"]', DEFAULT_SEO.ogDescription);
    setMetaContent('meta[property="og:image"]', DEFAULT_SEO.ogImage);
    if (DEFAULT_SEO.ogImageWidth) setMetaContent('meta[property="og:image:width"]', DEFAULT_SEO.ogImageWidth);
    if (DEFAULT_SEO.ogImageHeight) setMetaContent('meta[property="og:image:height"]', DEFAULT_SEO.ogImageHeight);
    setMetaContent('meta[property="og:url"]', DEFAULT_SEO.ogUrl);
    setMetaContent('meta[name="twitter:title"]', DEFAULT_SEO.twitterTitle);
    setMetaContent('meta[name="twitter:description"]', DEFAULT_SEO.twitterDescription);
    setMetaContent('meta[name="twitter:image"]', DEFAULT_SEO.twitterImage);
    const canonicalEl = document.querySelector('link[rel="canonical"]');
    if (canonicalEl) canonicalEl.href = DEFAULT_SEO.canonical;
    removeImageStructuredData();
  }

  // JSON-LD ImageObject: sinyal terstruktur tambahan (di luar meta tag) yang
  // dipakai Google buat memahami & menampilkan gambar di hasil pencarian
  // maupun Google Images (mis. muncul badge/info tambahan di hasil).
  function updateImageStructuredData(img, pageUrl, description) {
    let script = document.getElementById('imageStructuredData');
    if (!script) {
      script = document.createElement('script');
      script.type = 'application/ld+json';
      script.id = 'imageStructuredData';
      document.head.appendChild(script);
    }
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'ImageObject',
      contentUrl: img.url,
      url: pageUrl,
      name: img.title,
      description: description,
      uploadDate: img.created_at || undefined,
      isFamilyFriendly: true
    });
  }

  function removeImageStructuredData() {
    const script = document.getElementById('imageStructuredData');
    if (script) script.remove();
  }

  // Dipanggil sekali di akhir loadData() (setelah IMAGES siap): kalau URL
  // yang dibuka user sudah membawa ?img=<id> (mis. dari hasil Google/share
  // link), langsung buka modal gambar itu tanpa perlu klik apa pun. History
  // disusun 2 lapis (galeri di bawah, gambar di atas) supaya tombol Back
  // browser menutup modal dulu, baru keluar situs — bukan langsung keluar.
  function openInitialImageFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const imgParam = params.get('img');
    if (!imgParam) return false;
    const id = parseInt(imgParam, 10);
    if (Number.isNaN(id)) return false;
    const img = IMAGES.find(i => i.id === id);
    if (!img) return false; // ID sudah tidak ada (mis. dihapus admin) -> tampilkan galeri biasa

    history.replaceState({ imgId: null }, '', window.location.pathname);
    history.pushState({ imgId: img.id }, '', imageUrlPath(img));
    openModal(img.id, { pushHistory: false });
    return true;
  }

  // Sinkronkan modal dengan tombol Back/Forward browser.
  window.addEventListener('popstate', () => {
    const params = new URLSearchParams(window.location.search);
    const imgParam = params.get('img');
    const id = imgParam ? parseInt(imgParam, 10) : NaN;
    if (!Number.isNaN(id) && IMAGES.some(i => i.id === id)) {
      openModal(id, { pushHistory: false });
    } else if (currentModalImage) {
      closeModal(null, { fromPopState: true });
    }
  });

  function openModal(imgId, options = {}) {
    const { pushHistory = true } = options;
    const img = IMAGES.find(i => i.id === imgId);
    if (!img) return;
    // Dicek SEBELUM currentModalImage/class 'open' di-set: kalau modal
    // sudah terbuka (user klik gambar lain dari dalam modal, mis. dari
    // "Gambar Serupa"), ini cuma GANTI ISI modal yang sama, bukan buka
    // modal baru -> history-nya harus di-replace, bukan ditambah lagi.
    // Kalau numpuk pushState per gambar, tombol close/back jadi harus
    // dipencet berkali-kali baru balik ke galeri.
    const wasAlreadyOpen = document.getElementById('modal').classList.contains('open');
    currentModalImage = img;
    trackInteraction(img.category, 'view');
    syncReportButtonState(img.id);

    const modalImg = document.getElementById('modalImg');
    const modalImageWrap = document.getElementById('modalImageWrap');
    modalImg.alt = `Gambar status ${catLabel(img.category)} - ${img.title}, download HD gratis di Status Gallery`;
    // Reset state dari gambar sebelumnya (fallback/attempt/error) supaya
    // watchdog & fallback jalan dari awal lagi untuk gambar yang baru ini.
    delete modalImg.dataset.fallback;
    delete modalImg.dataset.attempt;
    modalImg.dataset.loaded = '0';
    if (modalImageWrap) modalImageWrap.classList.remove('img-error');

    // Step 1: tampilkan langsung thumbnail grid (480px) yang kemungkinan
    // besar sudah ter-cache browser (sama persis dengan gambar di kartu
    // yang baru diklik) -> muncul instan, tidak ada jeda kosong/patah.
    //
    // PENTING: sebelum ganti src, kosongkan dulu <img> yang sedang
    // menampilkan gambar modal SEBELUMNYA. Kalau langsung ganti src lalu
    // add class 'loaded', browser masih menampilkan bitmap gambar lama
    // (belum di-clear) sampai gambar baru selesai di-decode -> yang
    // ke-fade-in kelihatannya gambar lama, baru "meloncat" ganti ke gambar
    // yang benar begitu request selesai. Makanya harus nunggu event
    // 'load' dari src yang baru sebelum class 'loaded' ditambahkan lagi.
    modalImg.classList.remove('loaded');
    modalImg.removeAttribute('src');
    void modalImg.offsetWidth;
    modalImg.src = gridThumb(img.url);
    modalImg.addEventListener('load', () => {
      modalImg.dataset.loaded = '1';
      // Pastikan modal belum keburu ganti ke gambar lain lagi sebelum ini
      // sempat kelar (mis. user klik cepat beberapa gambar berturut-turut).
      if (currentModalImage && currentModalImage.id === img.id) {
        modalImg.classList.add('loaded');
      }
    }, { once: true });
    watchModalImageLoad(modalImg, img.id);

    // Step 2: preload versi resolusi lebih tinggi (1080px) di background.
    // Baru setelah BENAR-BENAR selesai dimuat, ganti src-nya -> transisi
    // opacity membuat pergantian ke kualitas HD terasa mulus, bukan patah.
    const hiRes = new Image();
    hiRes.onload = () => {
      // Pastikan modal masih menampilkan gambar yang sama (user belum
      // klik gambar lain / sudah tutup modal) sebelum menimpa src-nya.
      if (currentModalImage && currentModalImage.id === img.id) {
        modalImg.classList.remove('loaded');
        modalImg.src = hiRes.src;
        // Force reflow supaya transisi opacity ke-trigger ulang
        void modalImg.offsetWidth;
        modalImg.classList.add('loaded');
      }
    };
    hiRes.onerror = () => {
      // Versi HD gagal dimuat -> diam-diam tetap pakai gridThumb yang
      // sudah tampil di step 1, tidak perlu fallback lagi karena modalImg
      // sendiri sudah punya watchdog+fallback via watchModalImageLoad.
    };
    hiRes.src = previewThumb(img.url);

    document.getElementById('modalTitle').textContent = img.title;
    document.getElementById('modalCategory').textContent = CATEGORIES.find(c => c.id === img.category)?.label || img.category;
    document.getElementById('modalDownloads').textContent = (img.downloads || 0).toLocaleString('id-ID') + ' downloads';
    updateModalFavoriteBtn();
    renderModalSimilar(img);

    document.getElementById('modal').classList.add('open');
    document.body.style.overflow = 'hidden';
    document.querySelector('.modal-info').scrollTop = 0;
    // Mobile: seluruh .modal-content yang jadi area scroll (bukan cuma
    // .modal-info) -> ikut direset ke atas juga.
    const modalContentEl = document.querySelector('#modal .modal-content');
    if (modalContentEl) modalContentEl.scrollTop = 0;

    updateImageSEO(img);
    if (pushHistory) {
      if (wasAlreadyOpen) {
        history.replaceState({ imgId: img.id }, '', imageUrlPath(img));
      } else {
        history.pushState({ imgId: img.id }, '', imageUrlPath(img));
      }
    }
  }

  // ===== REKOMENDASI: GAMBAR SERUPA =====
  // Stopword Indonesia umum, dibuang dari judul supaya perbandingan kemiripan
  // fokus ke kata yang benar-benar bermakna (bukan kata sambung/hubung).
  const ID_STOPWORDS = new Set([
    'yang', 'adalah', 'dan', 'di', 'ke', 'dari', 'untuk', 'dengan', 'atau',
    'ini', 'itu', 'tidak', 'saja', 'juga', 'karena', 'tapi', 'tak', 'bukan',
    'jangan', 'kamu', 'kita', 'kami', 'aku', 'saya', 'akan', 'agar', 'supaya',
    'para', 'sang', 'pada', 'oleh', 'lebih', 'sangat', 'sudah', 'belum',
    'masih', 'bisa', 'harus', 'boleh', 'ada', 'jadi', 'kalau', 'bila'
  ]);

  function titleTokens(title) {
    return new Set(
      title.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !ID_STOPWORDS.has(w))
    );
  }

  function jaccardSimilarity(setA, setB) {
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    setA.forEach(w => { if (setB.has(w)) intersection++; });
    const unionSize = setA.size + setB.size - intersection;
    return unionSize === 0 ? 0 : intersection / unionSize;
  }

  // Skor kemiripan = bonus kategori sama (2) + kemiripan kata di judul (x3).
  // Kategori jadi sinyal utama (karena judul biasanya pendek), kemiripan kata
  // jadi pembeda urutan di dalam kategori yang sama / lintas kategori.
  function getSimilarImages(img) {
    const tokens = titleTokens(img.title);
    // Tidak lagi dipotong ke topN -> seluruh gambar lain diikutkan (terurut
    // dari yang paling mirip ke paling kurang mirip) supaya section "Gambar
    // Serupa" punya stok gambar yang cukup untuk infinite scroll ala
    // Pinterest, bukan cuma berhenti di segelintir item.
    return IMAGES
      .filter(other => other.id !== img.id)
      .map(other => {
        const categoryBonus = other.category === img.category ? 2 : 0;
        const wordScore = jaccardSimilarity(tokens, titleTokens(other.title)) * 3;
        return { img: other, score: categoryBonus + wordScore };
      })
      .sort((a, b) => b.score - a.score)
      .map(entry => entry.img);
  }

  // ===== RENDER BERTAHAP UNTUK "GAMBAR SERUPA" (infinite scroll) =====
  // Sama seperti galeri utama: render sedikit dulu, tambah otomatis pas
  // panel modal-info di-scroll mendekati bawah -> hasilnya terasa seperti
  // feed Pinterest yang gak pernah habis, bukan grid statis segelintir item.
  const MODAL_SIMILAR_BATCH_SIZE = 8;
  let modalSimilarPool = [];
  let modalSimilarRendered = 0;

  function modalSimilarItemHtml(s) {
    const [w, h] = s.size.split('×').map(Number);
    const ratio = (w && h) ? `${w}/${h}` : '1/1';
    return `
      <button class="modal-similar-item" onclick="openModal(${s.id})" aria-label="Buka ${escapeHtml(s.title)}">
        <img src="${gridThumb(s.url)}" srcset="${gridThumbSrcset(s.url)}" alt="Status ${escapeHtml(catLabel(s.category))} - ${escapeHtml(s.title)}" style="aspect-ratio:${ratio}" loading="lazy" decoding="async">
        <span class="modal-similar-item-label">${escapeHtml(s.title)}</span>
      </button>
    `;
  }

  // Berapa kolom yang dipakai, mengikuti breakpoint yang sama seperti CSS
  // lama (2 kolom di HP, 3 kolom di layar >=1100px).
  function modalSimilarColumnCount() {
    return window.matchMedia('(min-width: 1100px)').matches ? 3 : 2;
  }

  function appendModalSimilarBatch() {
    const grid = document.getElementById('modalSimilarGrid');
    if (!grid) return;
    const nextItems = modalSimilarPool.slice(modalSimilarRendered, modalSimilarRendered + MODAL_SIMILAR_BATCH_SIZE);
    if (nextItems.length === 0) return;
    const cols = Array.from(grid.querySelectorAll('.modal-similar-col'));
    if (cols.length === 0) return;
    // Tiap item baru ditaruh ke kolom yang SAAT INI paling pendek. Kolom &
    // item yang sudah ada TIDAK PERNAH disentuh ulang -> tidak ada reflow
    // yang bikin gambar lama "pindah tempat" (lihat catatan di CSS).
    nextItems.forEach(s => {
      const shortest = cols.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
      shortest.insertAdjacentHTML('beforeend', modalSimilarItemHtml(s));
    });
    modalSimilarRendered += nextItems.length;
  }

  function renderModalSimilar(img) {
    const section = document.getElementById('modalSimilarSection');
    const grid = document.getElementById('modalSimilarGrid');
    modalSimilarPool = getSimilarImages(img);
    modalSimilarRendered = 0;
    grid.innerHTML = '';
    if (modalSimilarPool.length === 0) {
      section.style.display = 'none';
      return;
    }
    section.style.display = '';
    // Siapkan kolom² kosong dulu (baru sekali per modal dibuka), baru
    // batch pertama diisi lewat appendModalSimilarBatch.
    const colCount = modalSimilarColumnCount();
    for (let i = 0; i < colCount; i++) {
      const col = document.createElement('div');
      col.className = 'modal-similar-col';
      grid.appendChild(col);
    }
    appendModalSimilarBatch();
  }

  // Cek jarak scroll di dalam modal (bukan window, karena yang scroll di
  // dalam modal itu panelnya sendiri, bukan halaman utama) -> kalau sudah
  // dekat bawah & stok gambar serupa masih ada, tambah batch berikutnya
  // secara otomatis.
  // Catatan: container yang benar-benar scroll beda-beda tergantung layar:
  // - Desktop (2 kolom): cuma .modal-info yang scroll, gambar preview diam.
  // - Mobile (1 kolom): seluruh .modal-content yang scroll (gambar preview
  //   ikut naik/hilang pas discroll), .modal-info gak scroll sendiri lagi.
  // Jadi dicek satu-satu, dipakai yang scrollHeight-nya beneran melebihi
  // clientHeight (berarti itu yang jadi container aktif).
  let modalSimilarScrollTicking = false;
  function maybeLoadMoreModalSimilar() {
    if (modalSimilarRendered >= modalSimilarPool.length) return;
    const candidates = [
      document.querySelector('#modal .modal-info'),
      document.querySelector('#modal .modal-content')
    ];
    for (const el of candidates) {
      if (!el) continue;
      if (el.scrollHeight - el.clientHeight < 2) continue; // bukan container yang aktif scroll
      const distanceToBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
      if (distanceToBottom < 500) appendModalSimilarBatch();
      return;
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    const scrollTargets = [
      document.querySelector('#modal .modal-info'),
      document.querySelector('#modal .modal-content')
    ].filter(Boolean);
    scrollTargets.forEach(el => {
      el.addEventListener('scroll', () => {
        if (modalSimilarScrollTicking) return;
        modalSimilarScrollTicking = true;
        requestAnimationFrame(() => {
          maybeLoadMoreModalSimilar();
          modalSimilarScrollTicking = false;
        });
      });
    });
  });

  function updateModalFavoriteBtn() {
    if (!currentModalImage) return;
    const isFav = favorites.has(currentModalImage.id);
    document.getElementById('modalFavIcon').setAttribute('fill', isFav ? 'currentColor' : 'none');
    const favBtnLabel = isFav ? 'Hapus dari Favorit' : 'Tambah ke Favorit';
    const modalFavBtnEl = document.getElementById('modalFavBtn');
    modalFavBtnEl.setAttribute('aria-label', favBtnLabel);
    modalFavBtnEl.setAttribute('title', favBtnLabel);
    modalFavBtnEl.style.color = isFav ? '#ef4444' : '';
  }

  function closeModal(e, options = {}) {
    if (e && e.target !== e.currentTarget) return;
    const { fromPopState = false } = options;
    const wasOpen = document.getElementById('modal').classList.contains('open');
    document.getElementById('modal').classList.remove('open');
    document.body.style.overflow = '';
    currentModalImage = null;
    restoreDefaultSEO();

    // Ditutup lewat interaksi user (klik X/backdrop/Escape/Tutup), bukan
    // lewat tombol Back browser -> mundurkan history 1 langkah supaya URL
    // ?img= ikut hilang dari address bar, tanpa numpuk entry gallery baru
    // tiap kali user buka-tutup modal berkali-kali.
    if (wasOpen && !fromPopState) {
      const params = new URLSearchParams(window.location.search);
      if (params.get('img')) history.back();
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      const settingsPage = document.getElementById('settingsModal');
      if (settingsPage && settingsPage.classList.contains('open')) closeSettingsModal();
    }
  });

  // Cegah spam laporan: satu gambar cukup dilaporkan sekali per browser.
  // Sebelumnya tombol ini bisa diklik berkali-kali dan tiap klik insert baris
  // baru ke tabel `reports` tanpa cek duplikat -> numpuk di panel admin.
  // Pakai localStorage (pola sama seperti sg_guest_dl_count) supaya statusnya
  // tetap kalau modal ditutup-buka lagi atau halaman di-reload.
  function getReportedImageIds() {
    try {
      return new Set(JSON.parse(localStorage.getItem('sg_reported_ids') || '[]'));
    } catch (e) { return new Set(); }
  }

  function markImageReported(imageId) {
    const ids = getReportedImageIds();
    ids.add(imageId);
    try { localStorage.setItem('sg_reported_ids', JSON.stringify([...ids])); } catch (e) {}
  }

  // Sinkronkan tampilan tombol Laporkan di modal sesuai status gambar yang
  // sedang dibuka: kalau sudah pernah dilaporkan, tombol dinonaktifkan biar
  // user tahu laporannya sudah tercatat (bukan diam-diam boleh diklik lagi).
  function syncReportButtonState(imageId) {
    const btn = document.getElementById('modalReportBtn');
    if (!btn) return;
    const alreadyReported = getReportedImageIds().has(imageId);
    btn.disabled = alreadyReported;
    btn.setAttribute('aria-label', alreadyReported ? 'Sudah dilaporkan' : 'Laporkan gambar ini');
    btn.title = alreadyReported ? 'Sudah dilaporkan' : 'Laporkan';
    btn.classList.toggle('reported', alreadyReported);
  }

  function reportCurrent() {
    if (!currentModalImage) return;
    const imageId = currentModalImage.id;
    if (getReportedImageIds().has(imageId)) return; // jaga-jaga: harusnya tombol sudah disabled duluan

    if (typeof gtag === 'function') gtag('event', 'report_image', { image_id: imageId });
    showToast('Laporan terkirim, terima kasih sudah membantu kami.');
    markImageReported(imageId);
    syncReportButtonState(imageId);

    // Simpan ke tabel reports supaya bisa direview di panel admin
    // (sebelumnya cuma tercatat sebagai GA event, gak ada tempat reviewnya).
    // Gagal simpan tidak mengganggu UI (toast sukses tetap tampil ke user),
    // cukup dicatat ke console untuk debugging.
    supabaseClient.from('reports').insert({ image_id: imageId })
      .then(({ error }) => { if (error) console.error('Gagal mencatat laporan:', error); });
  }

  // ===== DOWNLOAD =====
  // Batas download gratis untuk guest (belum login). Setelah tercapai,
  // guest wajib login (Google) supaya bisa lanjut download tanpa batas.
  const GUEST_DOWNLOAD_LIMIT = 1;

  function getGuestDownloadCount() {
    const n = parseInt(localStorage.getItem('sg_guest_dl_count') || '0', 10);
    return Number.isNaN(n) ? 0 : n;
  }

  function incrementGuestDownloadCount() {
    const next = getGuestDownloadCount() + 1;
    try { localStorage.setItem('sg_guest_dl_count', String(next)); } catch (e) {}
    return next;
  }

  // Mengembalikan true kalau boleh lanjut download. Kalau guest sudah
  // mencapai batas, tampilkan toast + buka modal login, lalu return false.
  function canDownload() {
    if (currentUser) return true; // sudah login: tanpa batas

    const count = getGuestDownloadCount();
    if (count >= GUEST_DOWNLOAD_LIMIT) {
      showToast(`Batas ${GUEST_DOWNLOAD_LIMIT}x download gratis tercapai. Masuk untuk lanjut download.`, 'error');
      openProfileModal();
      return false;
    }
    return true;
  }

  function downloadCurrent() {
    if (currentModalImage) {
      if (!canDownload()) return;
      triggerDownload(currentModalImage.url, currentModalImage.title, currentModalImage.id);
    }
  }

  // ===== SHARE =====
  function shareCurrent() {
    if (currentModalImage) shareImage(currentModalImage.id);
  }

  async function shareImage(imgId) {
    const img = IMAGES.find(i => i.id === imgId);
    if (!img) return;

    const pageUrl = PRODUCTION_APP_URL;
    const shareText = `${img.title} — Status Gallery by EM2STUDIO`;

    // Cara 1 (terbaik, khususnya di HP): ambil gambarnya sebagai file lalu
    // pakai Web Share API. Kalau device/browser support "share file"
    // (kebanyakan Android Chrome & iOS Safari terbaru), gambar langsung
    // bisa dipilih dikirim ke WhatsApp/Instagram Story/dll dari sheet share
    // bawaan HP, tanpa harus download manual dulu.
    try {
      const response = await fetch(img.url);
      const blob = await response.blob();
      const file = new File([blob], `status-${img.title.toLowerCase().replace(/\s+/g, '-')}.png`, {
        type: blob.type || 'image/png'
      });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: img.title, text: shareText });
        logShareEvent(imgId, 'native_file');
        return;
      }
    } catch (err) {
      if (err.name === 'AbortError') return; // user batal dari share sheet, jangan lanjut fallback
      console.error('Share file gagal, coba fallback:', err);
    }

    // Cara 2: device tidak support share file (mis. desktop), tapi tetap
    // punya Web Share API standar (share teks/link saja)
    if (navigator.share) {
      try {
        await navigator.share({ title: img.title, text: shareText, url: pageUrl });
        logShareEvent(imgId, 'native_link');
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }

    // Cara 3: fallback terakhir untuk browser desktop tanpa Web Share API
    // sama sekali — buka WhatsApp Web/app dengan teks siap kirim (link saja,
    // WhatsApp tidak bisa nerima file lewat URL wa.me).
    const waText = encodeURIComponent(`${shareText}\n${pageUrl}`);
    window.open(`https://wa.me/?text=${waText}`, '_blank', 'noopener');
    logShareEvent(imgId, 'wa_link_fallback');
  }

  function logShareEvent(imgId, method) {
    if (typeof gtag === 'function') gtag('event', 'share_image', { image_id: imgId, method });
  }

  // ===== JADIKAN WALLPAPER =====
  // Browser tidak punya API resmi untuk "set wallpaper" langsung dari web,
  // jadi kita pakai 2 pendekatan (mirip alur shareImage):
  // 1) Web Share API dengan file gambar — di banyak HP Android/Samsung,
  //    sheet share bawaan OS punya opsi aplikasi "Wallpaper"/"Wallpaper &
  //    Style" langsung di daftar tujuan, jadi user tinggal pilih itu.
  // 2) Kalau device/browser tidak support share file, fallback: gambar
  //    tetap didownload otomatis lalu user dikasih instruksi manual untuk
  //    membukanya lewat galeri HP dan pilih "Jadikan Wallpaper" dari sana.
  function wallpaperCurrent() {
    if (currentModalImage) setAsWallpaper(currentModalImage.id);
  }

  async function setAsWallpaper(imgId) {
    const img = IMAGES.find(i => i.id === imgId);
    if (!img) return;

    showToast('Menyiapkan gambar...');

    try {
      const response = await fetch(img.url);
      const blob = await response.blob();
      const file = new File([blob], `wallpaper-${img.title.toLowerCase().replace(/\s+/g, '-')}.png`, {
        type: blob.type || 'image/png'
      });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: img.title, text: 'Jadikan wallpaper dari Status Gallery' });
        logShareEvent(imgId, 'wallpaper_native_file');
        if (typeof gtag === 'function') gtag('event', 'set_wallpaper', { image_id: imgId, method: 'native_file' });
        return;
      }
      throw new Error('share_file_unsupported');
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user batal dari share sheet, jangan lanjut fallback

      // Fallback: device/browser tidak bisa share file langsung ke opsi
      // "Wallpaper" OS — download saja gambarnya lalu arahkan manual.
      await triggerDownload(img.url, img.title, imgId);
      showToast('Gambar tersimpan! Buka galeri HP kamu lalu pilih "Jadikan Wallpaper".', 'success');
      if (typeof gtag === 'function') gtag('event', 'set_wallpaper', { image_id: imgId, method: 'download_fallback' });
    }
  }

  // Share aplikasi secara umum (bukan 1 gambar spesifik) — dipakai dari
  // tombol "Bagikan Aplikasi" di Pengaturan. Alurnya sama seperti share
  // gambar: coba Web Share API dulu (share sheet asli HP), fallback ke
  // WhatsApp kalau device/browser tidak support.
  async function shareApp() {
    const appUrl = PRODUCTION_APP_URL;
    const shareText = 'Status Gallery — download status WhatsApp HD gratis: motivasi, islami, aesthetic, quotes, dan lainnya!';

    if (navigator.share) {
      try {
        await navigator.share({ title: 'Status Gallery by EM2STUDIO', text: shareText, url: appUrl });
        if (typeof gtag === 'function') gtag('event', 'share_app', { method: 'native' });
        return;
      } catch (err) {
        if (err.name === 'AbortError') return; // user batal dari share sheet
      }
    }

    // Fallback: browser tanpa Web Share API (kebanyakan desktop) —
    // langsung buka WhatsApp dengan teks + link siap kirim
    const waText = encodeURIComponent(`${shareText}\n${appUrl}`);
    window.open(`https://wa.me/?text=${waText}`, '_blank', 'noopener');
    if (typeof gtag === 'function') gtag('event', 'share_app', { method: 'wa_link_fallback' });
  }

  // ===== WATERMARK SAAT DOWNLOAD (logo em2studio) =====
  // Menempelkan logo em2studio (SVG 1 warna) di pojok kanan-bawah gambar
  // HANYA pada file yang diunduh user. Gambar asli di Storage/tabel sama
  // sekali tidak diubah.
  const WATERMARK_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" width="1.69333cm" height="0.65836cm" version="1.1" style="shape-rendering:geometricPrecision; text-rendering:geometricPrecision; image-rendering:optimizeQuality; fill-rule:evenodd; clip-rule:evenodd"
viewBox="0 0 7.14519 2.77802"
 xmlns:xlink="http://www.w3.org/1999/xlink"
 xmlns:xodm="http://www.corel.com/coreldraw/odm/2003">
 <defs>
  <style type="text/css">
   <![CDATA[
    .fil0 {fill:#E6E6E6;fill-rule:nonzero}
   ]]>
  </style>
 </defs>
 <g id="Layer_x0020_1">
  <metadata id="CorelCorpID_0Corel-Layer"/>
  <path class="fil0" d="M6.9021 1.37665c0.06279,0 0.11958,0.02549 0.16072,0.06659 0.04114,0.04114 0.06659,0.09798 0.06659,0.16072 0,0.06275 -0.02544,0.11958 -0.06659,0.16072 -0.04114,0.04114 -0.09794,0.06659 -0.16072,0.06659 -0.03186,0 -0.06215,-0.00658 -0.08971,-0.0184 0.02156,0.05633 0.03355,0.11629 0.03355,0.17807 0,0.10722 -0.01785,0.20874 -0.05359,0.30457 -0.03574,0.09587 -0.08773,0.17954 -0.15596,0.25102 -0.06823,0.07148 -0.15229,0.12794 -0.25221,0.16938 -0.09992,0.04139 -0.21402,0.06211 -0.34238,0.06211 -0.09747,0 -0.18845,-0.01219 -0.27292,-0.03654 -0.08448,-0.02439 -0.15836,-0.06093 -0.22174,-0.10967 -0.06334,-0.04874 -0.11292,-0.10887 -0.14866,-0.18035 -0.01321,-0.02637 -0.02397,-0.05426 -0.03228,-0.08355l-0.06561 0.37111 -0.54585 0 0.22664 -1.28175 0.54585 0 -0.05131 0.29014c0.02291,-0.03473 0.04869,-0.0673 0.0773,-0.09764 0.06743,-0.07148 0.1503,-0.12794 0.24858,-0.16938 0.09827,-0.04139 0.21077,-0.06211 0.33748,-0.06211 0.09912,0 0.1917,0.01215 0.27778,0.03654 0.09608,0.02717 0.18562,0.08047 0.25778,0.15115l0 -0.00203c0,-0.06275 0.02544,-0.11958 0.06659,-0.16072 0.0411,-0.0411 0.09794,-0.06659 0.16068,-0.06659zm-0.80624 -0.57395c-0.06865,0 -0.13077,0.02789 -0.17566,0.07296l0 0 -0.42154 0.42306 0.5972 0c0.13697,0 0.24803,-0.11102 0.24803,-0.24799 0,-0.13697 -0.11106,-0.24803 -0.24803,-0.24803zm-0.79211 -0.30668c0.06865,0 0.13077,-0.02789 0.17566,-0.07296l0 0 0.42154 -0.42306 -0.5972 0c-0.13697,0 -0.24803,0.11102 -0.24803,0.24799 0,0.13701 0.11106,0.24803 0.24803,0.24803zm0.62146 -0.42399l-0.80582 0.80185c-0.09688,0.09638 -0.09726,0.25453 -0.00089,0.35141 0.09638,0.09684 0.25453,0.09726 0.35137,0.00084 0.13228,-0.13161 0.27963,-0.27271 0.40356,-0.39707 0.04827,-0.04844 0.1103,-0.07937 0.17701,-0.08908 0.01494,-0.00219 0.03013,-0.00329 0.0454,-0.00329 0.10368,0 0.19558,0.05026 0.2528,0.12773 0.03848,0.05211 0.06123,0.11655 0.06123,0.1863 0,0.01169 -0.00068,0.02321 -0.0019,0.0346l0.23963 -0.23849 0 0.20149c0,0.13667 0.11182,0.24845 0.24849,0.24845 0.13663,0 0.24845,-0.11178 0.24845,-0.24845l0 -0.7827c0.00481,-0.06916 -0.01899,-0.14001 -0.07144,-0.19271 -0.09638,-0.09688 -0.25448,-0.09726 -0.35137,-0.00089l-0.3731 0.37128 0 -0.19482c0,-0.00051 -0.00004,-0.00101 -0.00004,-0.00152 0,-0.0016 0,-0.00321 -0.00004,-0.00481l0 -0.00034c-0.00156,-0.06135 -0.02553,-0.12224 -0.07199,-0.16891 -0.04831,-0.04857 -0.11216,-0.07287 -0.176,-0.07291l-0.00042 0c-0.00089,0 -0.00177,0.00004 -0.00266,0.00004 -0.00093,0 -0.00186,0 -0.00274,0.00004 -0.00152,0.00004 -0.003,0.00008 -0.00451,0.00013l-0.00143 0.00008c-0.00169,0.00004 -0.00338,0.00017 -0.00506,0.00025l-0.0008 0.00008c-0.00173,0.00013 -0.0035,0.00025 -0.00523,0.00042l-0.00076 0.00004c-0.00169,0.00017 -0.00338,0.00034 -0.00506,0.00055l-0.00105 0.00013c-0.00156,0.00017 -0.00308,0.00038 -0.0046,0.00059l-0.00177 0.00025c-0.00127,0.00017 -0.00249,0.00034 -0.00376,0.00055 -0.00093,0.00017 -0.0019,0.00034 -0.00283,0.00046 -0.00089,0.00017 -0.00177,0.00034 -0.00266,0.00051 -0.00148,0.00025 -0.00291,0.00055 -0.00435,0.00084l-0.00097 0.00017c-0.04574,0.00941 -0.08929,0.03169 -0.12469,0.06688zm-5.16552 0.73455c-0.00165,0.00489 -0.00245,0.01059 -0.00245,0.01709 0,0.0276 0.0073,0.04996 0.02194,0.06701 0.0146,0.01705 0.03249,0.03089 0.05363,0.04144 0.0211,0.01055 0.04384,0.01785 0.06819,0.02194 0.02439,0.00405 0.04633,0.00608 0.06578,0.00608 0.04063,0 0.08043,-0.00688 0.11941,-0.02072 0.03899,-0.0138 0.07393,-0.03532 0.10482,-0.06456l0.30242 0.20832 0.52602 0 -0.01021 0.06 -0.02844 0.16786 -0.00004 0 -0.02355 0.13874 0.25031 0 0.10562 0 0.44268 0 -0.11937 0.67986c-0.00329,0.0146 -0.00527,0.02966 -0.00612,0.04507 -0.0008,0.01544 -0.00122,0.02802 -0.00122,0.03777 0,0.11671 0.10709,0.14802 0.18246,0.05971 0.02848,-0.03329 0.04836,-0.08161 0.05971,-0.14499l0.12186 -0.67742 0.54986 0 -0.03924 0.22174 0.00835 -0.00958c0.06334,-0.07148 0.13891,-0.12832 0.22659,-0.17056 0.08777,-0.04224 0.18279,-0.06334 0.28516,-0.06334 0.03085,0 0.06253,0.00321 0.09503,0.00971 0.03245,0.0065 0.06334,0.01582 0.09258,0.02806 0.02924,0.01215 0.05604,0.02717 0.08043,0.04507 0.02435,0.01785 0.04388,0.03734 0.05848,0.05848l0.00485 0 0.04616 -0.26474 -0.75995 0 0.05912 -0.32795 0.57703 -0.405c0.02152,-0.01553 0.04363,-0.03435 0.06633,-0.05646 0.02266,-0.02207 0.03401,-0.04452 0.03401,-0.06718 0,-0.02511 -0.00713,-0.04599 -0.02152,-0.06275 -0.0143,-0.01671 -0.03878,-0.02506 -0.07346,-0.02506 -0.04182,0 -0.07557,0.01376 -0.10123,0.04123 -0.0257,0.02747 -0.04393,0.06388 -0.05464,0.10929l-0.38171 -0.05553c0.01553,-0.06929 0.04063,-0.13203 0.07528,-0.18819 0.03464,-0.05612 0.07646,-0.10393 0.12545,-0.14334 0.04895,-0.03941 0.10511,-0.06992 0.1684,-0.0914 0.06334,-0.02152 0.13262,-0.03228 0.20786,-0.03228 0.05975,0 0.11895,0.00717 0.17743,0.02152 0.05857,0.01435 0.1111,0.03675 0.15773,0.06722 0.04658,0.03042 0.08422,0.06988 0.11292,0.11828 0.02861,0.0484 0.04296,0.10604 0.04296,0.17292 0,0.05853 -0.00924,0.10963 -0.02777,0.15326 -0.01852,0.04359 -0.04211,0.08207 -0.07076,0.11553 -0.02869,0.0335 -0.06097,0.06334 -0.0968,0.08962 -0.03582,0.02629 -0.0711,0.05076 -0.1057,0.07346l-0.21685 0.14515 0.16646 0 0.28512 0 0.25828 0 -0.31385 1.78207 -0.48981 0 0.02435 -0.13646 -0.00485 0c-0.03739,0.04874 -0.08975,0.08895 -0.15718,0.12064 -0.06743,0.03169 -0.14659,0.04751 -0.23761,0.04751 -0.08448,0 -0.15878,-0.01422 -0.22296,-0.04266 -0.06414,-0.0284 -0.11819,-0.06739 -0.16203,-0.11697 -0.03342,-0.03777 -0.06051,-0.08047 -0.08119,-0.12815l-0.04397 0.24858 -0.54834 0 0.02933 -0.1657c-0.09541,0.12819 -0.32187,0.25098 -0.52758,0.1633 -0.04954,-0.02114 -0.09017,-0.04916 -0.12186,-0.0841 -0.03165,-0.0349 -0.05439,-0.07511 -0.06819,-0.1206 -0.01384,-0.04549 -0.02076,-0.09262 -0.02076,-0.14136 0,-0.02599 0.00122,-0.05321 0.00367,-0.08165 0.00245,-0.0284 0.00608,-0.05561 0.01097,-0.08161l0.06574 -0.3777 -0.24807 0 -0.06578 0.36065c-0.00165,0.00975 -0.00283,0.0211 -0.00367,0.03409 -0.0008,0.013 -0.00118,0.02359 -0.00118,0.03169 0,0.03739 0.00933,0.06211 0.02802,0.07431 0.01865,0.01219 0.04507,0.01827 0.0792,0.01827 0.01949,0 0.03899,-0.0016 0.05844,-0.00485 0.01954,-0.00325 0.03574,-0.0065 0.04874,-0.00975l-0.06578 0.37529c-0.0211,0.013 -0.05848,0.02355 -0.11207,0.03165 -0.05363,0.00814 -0.10562,0.01219 -0.156,0.01219 -0.05359,0 -0.10638,-0.00485 -0.15836,-0.0146 -0.05199,-0.00975 -0.09827,-0.02684 -0.13891,-0.05118 -0.04063,-0.02439 -0.07351,-0.05768 -0.0987,-0.09992 -0.02519,-0.04224 -0.03777,-0.09663 -0.03777,-0.16326 0,-0.01789 0.00122,-0.03819 0.00367,-0.06093 0.00245,-0.02274 0.00527,-0.04388 0.00852,-0.06338l0.08528 -0.47032 -0.19005 0 0.02755 -0.15845 -0.17646 0.20254c-0.02764,-0.02924 -0.06578,-0.05401 -0.11452,-0.07431 -0.04874,-0.02034 -0.09667,-0.03051 -0.14376,-0.03051 -0.03253,0 -0.05891,0.00447 -0.0792,0.01342 -0.02034,0.00895 -0.03047,0.02317 -0.03047,0.04266 0,0.01625 0.00852,0.02882 0.02557,0.03777 0.01709,0.0089 0.04671,0.01907 0.08895,0.03047 0.06013,0.0146 0.11494,0.03291 0.16448,0.05481 0.04954,0.02194 0.0922,0.04831 0.12794,0.0792 0.03574,0.03085 0.06338,0.06743 0.08287,0.10963 0.01949,0.04228 0.02924,0.09182 0.02924,0.14866 0,0.08612 -0.01911,0.15921 -0.05726,0.21934 -0.03819,0.06009 -0.08692,0.10882 -0.14621,0.14621 -0.05929,0.03734 -0.12511,0.06418 -0.19739,0.08043 -0.07228,0.01625 -0.14338,0.02435 -0.21322,0.02435 -0.09262,0 -0.19009,-0.013 -0.29242,-0.03899 -0.10237,-0.02599 -0.19254,-0.07148 -0.27048,-0.13646l0.27778 -0.33141c0.04224,0.04224 0.09097,0.07393 0.14621,0.09503 0.05523,0.02114 0.10642,0.03169 0.15351,0.03169 0.03249,0 0.0581,-0.00447 0.07675,-0.01342 0.01869,-0.0089 0.02806,-0.02312 0.02806,-0.04262 0,-0.01949 -0.01262,-0.03574 -0.03781,-0.04874 -0.02515,-0.013 -0.05726,-0.02519 -0.09625,-0.03654 -0.05684,-0.01625 -0.1076,-0.03494 -0.15229,-0.05608 -0.04469,-0.0211 -0.08287,-0.04629 -0.11452,-0.07553 -0.03169,-0.02924 -0.05604,-0.06334 -0.07313,-0.10233 -0.01705,-0.03899 -0.02557,-0.08448 -0.02557,-0.13646 0,-0.07962 0.01747,-0.14946 0.05241,-0.20959 0.0349,-0.06009 0.08123,-0.10963 0.13887,-0.14866 0.05768,-0.03895 0.12266,-0.06823 0.19495,-0.08768 0.07228,-0.01954 0.14499,-0.02928 0.21811,-0.02928 0.10072,0 0.19777,0.01422 0.2912,0.04266 0.05815,0.01772 0.1095,0.03996 0.15414,0.0668l0.01059 -0.06089 0.1803 0 0.04523 -0.24267c-0.06123,0.04515 -0.12773,0.07899 -0.19959,0.10148 -0.10882,0.03414 -0.22174,0.05118 -0.33871,0.05118 -0.09097,0 -0.17748,-0.01215 -0.25951,-0.03654 -0.08207,-0.02435 -0.15355,-0.06093 -0.21444,-0.10967 -0.06093,-0.04869 -0.10925,-0.10925 -0.14499,-0.18153 -0.03574,-0.07228 -0.05363,-0.15718 -0.05363,-0.25465 0,-0.10887 0.01949,-0.21081 0.05848,-0.30584 0.03899,-0.09503 0.09384,-0.17748 0.16448,-0.24731 0.07068,-0.06988 0.15516,-0.12469 0.25347,-0.16448 0.09827,-0.03983 0.20668,-0.05975 0.32529,-0.05975 0.09422,0 0.1787,0.01342 0.25343,0.04021 0.07473,0.02679 0.13807,0.06498 0.19009,0.11456 0.0519,0.0495 0.09211,0.10954 0.12051,0.18014l0.00958 -0.05464c0.0065,-0.03089 0.01338,-0.07068 0.02072,-0.11941 0.0073,-0.04874 0.01257,-0.09262 0.01582,-0.13161l0.5288 0 -0.02814 0.16575c0.08102,-0.11047 0.25621,-0.19499 0.39365,-0.19499 0.09422,0 0.16938,0.01709 0.22541,0.05118 0.05608,0.03414 0.09789,0.08043 0.12553,0.13891 0.04224,-0.05199 0.0938,-0.09667 0.15473,-0.13401 0.06093,-0.03739 0.13769,-0.05608 0.23026,-0.05608 0.07473,0 0.13849,0.01219 0.19127,0.03654 0.05283,0.02439 0.09587,0.05608 0.12916,0.09507 0.03333,0.03899 0.05768,0.08283 0.07313,0.13157 0.0154,0.04874 0.02317,0.09752 0.02317,0.14621 0,0.02274 -0.00122,0.04426 -0.00367,0.0646 -0.00245,0.0203 -0.00527,0.04021 -0.00852,0.05971l-0.13646 0.77734 -0.5483 0 0.11279 -0.64239c0.00751,-0.04274 0.01392,-0.07359 0.01392,-0.1179 0,-0.07473 -0.03329,-0.11212 -0.09992,-0.11212 -0.03574,0 -0.06621,0.01747 -0.0914,0.05241 -0.02515,0.03494 -0.04346,0.08245 -0.05481,0.14254l-0.11941 0.67746 -0.54585 0 0.11372 -0.64273c0.00667,-0.03768 0.013,-0.06633 0.013,-0.10536 0,-0.03739 -0.00852,-0.06743 -0.02557,-0.09017 -0.01658,-0.02211 -0.04177,-0.03228 -0.0687,-0.03371 -0.11549,-0.00608 -0.15368,0.10051 -0.17157,0.19452l-0.05789 0.34086 -0.52631 0 0.02937 -0.16781 -0.78126 0 0 -0.00004zm0.43133 -0.28993c0.0016,-0.00489 0.00245,-0.01017 0.00245,-0.01587 0,-0.0057 0,-0.01017 0,-0.01342 0,-0.04059 -0.01502,-0.07308 -0.04511,-0.09747 -0.03004,-0.02435 -0.07186,-0.03654 -0.12549,-0.03654 -0.03414,0 -0.0646,0.0057 -0.0914,0.01705 -0.02679,0.01139 -0.04996,0.02519 -0.06945,0.04144 -0.01949,0.01625 -0.03532,0.03371 -0.04751,0.05241 -0.01219,0.01869 -0.02072,0.03616 -0.02557,0.05241l0.40209 0zm5.12371 1.53277c0,-0.05199 -0.01625,-0.09587 -0.04874,-0.13161 -0.03249,-0.03574 -0.08043,-0.05359 -0.14376,-0.05359 -0.03739,0 -0.0711,0.00772 -0.10114,0.02312 -0.03004,0.01544 -0.05604,0.03574 -0.07798,0.06093 -0.02194,0.02519 -0.03857,0.05485 -0.04992,0.08895 -0.01139,0.03409 -0.01709,0.06983 -0.01709,0.10722 0,0.05359 0.01625,0.09789 0.04874,0.13279 0.03249,0.03494 0.07962,0.05241 0.14136,0.05241 0.03899,0 0.07389,-0.0073 0.10477,-0.02194 0.03085,-0.0146 0.05684,-0.0349 0.07798,-0.06089 0.0211,-0.02599 0.03734,-0.05566 0.04874,-0.08895 0.01135,-0.03333 0.01705,-0.06945 0.01705,-0.10844zm-2.47366 0.09503c0,0.05199 0.01667,0.09583 0.04996,0.13161 0.03329,0.03574 0.08165,0.05359 0.14499,0.05359 0.03739,0 0.07106,-0.0073 0.10114,-0.02194 0.03004,-0.0146 0.05604,-0.0349 0.07794,-0.06089 0.02194,-0.02599 0.03899,-0.05608 0.05123,-0.09017 0.01215,-0.03414 0.01823,-0.06988 0.01823,-0.10722 0,-0.05363 -0.01663,-0.09789 -0.04992,-0.13279 -0.03333,-0.03494 -0.08085,-0.05241 -0.14258,-0.05241 -0.03895,0 -0.07389,0.0073 -0.10477,0.0219 -0.03085,0.01464 -0.05726,0.03494 -0.0792,0.06093 -0.02194,0.02599 -0.03857,0.05566 -0.04996,0.08895 -0.01135,0.03329 -0.01705,0.06945 -0.01705,0.10844zm3.10471 -0.42479l-0.04996 -0.09182 -0.01899 0 0 0.09182 -0.0549 0 0 -0.2314 0.08823 0c0.0111,0 0.02194,0.00114 0.03253,0.00342 0.01055,0.00232 0.02004,0.00616 0.02844,0.0116 0.0084,0.00549 0.01506,0.01266 0.02009,0.0216 0.00502,0.0089 0.00751,0.02004 0.00751,0.03333 0,0.0157 -0.00422,0.02886 -0.01274,0.03954 -0.00848,0.01068 -0.02025,0.01831 -0.03528,0.02287l0.06047 0.09903 -0.0654 0zm-0.00228 -0.16047c0,-0.00544 -0.00114,-0.00987 -0.00342,-0.01325 -0.00228,-0.00338 -0.00523,-0.00599 -0.00882,-0.00785 -0.00363,-0.00186 -0.00764,-0.00308 -0.01211,-0.00376 -0.00447,-0.00063 -0.00878,-0.00097 -0.01291,-0.00097l-0.02975 0 0 0.05393 0.0265 0c0.00456,0 0.00924,-0.00038 0.01405,-0.00114 0.00477,-0.00076 0.00916,-0.00211 0.01308,-0.00409 0.00388,-0.00194 0.00713,-0.00477 0.00962,-0.00848 0.00253,-0.00371 0.00376,-0.00852 0.00376,-0.01439zm0.08296 -0.07954c-0.03182,-0.03182 -0.07578,-0.05152 -0.12435,-0.05152 -0.04853,0 -0.09249,0.01971 -0.12431,0.05152 -0.03182,0.03177 -0.05152,0.07574 -0.05152,0.12431 0,0.04857 0.01971,0.09254 0.05152,0.12435 0.03182,0.03177 0.07578,0.05148 0.12431,0.05148 0.04857,0 0.09254,-0.01971 0.12435,-0.05148 0.03182,-0.03182 0.05148,-0.07578 0.05148,-0.12435 0,-0.04857 -0.01966,-0.09254 -0.05148,-0.12431z"/>
 </g>
</svg>`;

  let _watermarkLogoImgPromise = null;
  function loadWatermarkLogoImage() {
    if (_watermarkLogoImgPromise) return _watermarkLogoImgPromise;
    _watermarkLogoImgPromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(WATERMARK_LOGO_SVG)));
    });
    return _watermarkLogoImgPromise;
  }

  async function addDownloadWatermark(blob) {
    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = reject;
        im.src = objectUrl;
      });

      const logoImg = await loadWatermarkLogoImage();

      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      // Ukuran & posisi proporsional terhadap dimensi gambar supaya konsisten
      // di gambar kecil maupun besar (maks ~24% lebar gambar).
      const aspect = 7.14519 / 2.77802;
      const wmW = Math.max(40, Math.min(canvas.width * 0.13, 180));
      const wmH = wmW / aspect;
      const pad = canvas.width * 0.035;
      const x = canvas.width - wmW - pad;
      const y = canvas.height - wmH - pad;

      ctx.save();
      // Shadow gelap di belakang logo supaya watermark tetap kontras &
      // terbaca baik di background gambar yang putih/terang maupun gelap.
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
      ctx.shadowBlur = Math.max(2, wmW * 0.05);
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.globalAlpha = 0.85;
      // Gambar 2x agar shadow menumpuk jadi outline gelap yang lebih tebal
      // di sekeliling bentuk logo (bukan cuma bayangan tipis satu sisi).
      ctx.drawImage(logoImg, x, y, wmW, wmH);
      ctx.drawImage(logoImg, x, y, wmW, wmH);
      ctx.restore();

      const outType = blob.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const quality = outType === 'image/jpeg' ? 0.92 : undefined;
      const wmBlob = await new Promise(resolve => canvas.toBlob(resolve, outType, quality));
      return wmBlob || blob;
    } catch (e) {
      console.warn('Gagal menambahkan watermark saat download, pakai gambar asli:', e);
      return blob;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  // Catatan: <a download> tidak berfungsi untuk gambar cross-origin di kebanyakan
  // browser (atribut download diabaikan, gambar malah dibuka di tab baru).
  // Solusinya: ambil gambar sebagai blob dulu, baru buat object URL lokal untuk didownload.
  async function triggerDownload(url, title, imgId) {
    const filename = `status-${title.toLowerCase().replace(/\s+/g, '-')}.png`;
    showToast('Menyiapkan download...');
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Gagal mengambil gambar');
      let blob = await response.blob();
      blob = await addDownloadWatermark(blob);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);

      // Catat event ke Google Analytics (kalau gtag ada / GA belum diblok adblock)
      if (typeof gtag === 'function') {
        gtag('event', 'download_image', { image_id: imgId, image_title: title });
      }

      // Rekomendasi: catat minat kategori dari gambar yang barusan didownload
      if (imgId != null) {
        const downloadedImg = IMAGES.find(i => i.id === imgId);
        if (downloadedImg) trackInteraction(downloadedImg.category, 'download');
      }

      // Guest: tambah hitungan lokal & kasih tahu sisa kuota gratisnya
      if (!currentUser) {
        const used = incrementGuestDownloadCount();
        const remaining = Math.max(0, GUEST_DOWNLOAD_LIMIT - used);
        if (remaining > 0) {
          showToast(`Download berhasil! Sisa ${remaining}x download gratis.`, 'success');
        } else {
          showToast('Download berhasil! Ini download gratis terakhirmu — masuk untuk lanjut.', 'success');
        }
      } else {
        showToast('Download berhasil!', 'success');
      }

      // Catat +1 download ke Supabase (tidak menghalangi UI kalau gagal)
      if (imgId != null) {
        const found = IMAGES.find(i => i.id === imgId);
        if (found) found.downloads += 1; // update tampilan lokal langsung
        supabaseClient.rpc('increment_downloads', { image_id: imgId })
          .then(({ error }) => { if (error) console.error('Gagal mencatat download:', error); });
      }
    } catch (err) {
      // Fallback: buka di tab baru jika fetch gagal (mis. CORS diblok server)
      showToast('Tidak bisa auto-download, membuka gambar di tab baru', 'error');
      window.open(url, '_blank', 'noopener');
    }
  }

  // ===== NAV =====
  function setNav(el) {
    document.querySelectorAll('.nav-item').forEach(n => {
      n.classList.remove('active');
      n.removeAttribute('aria-current');
    });
    el.classList.add('active');
    el.setAttribute('aria-current', 'page');
  }

  // Sinkronkan indikator aktif di side-nav & bottom-nav sekaligus (dua-duanya
  // dirender terpisah di DOM), supaya nav "Favorit" tidak nyangkut aktif
  // begitu user pindah ke filter kategori lain, atau sebaliknya.
  function highlightNav(key) {
    document.querySelectorAll('.nav-item').forEach(n => {
      n.classList.remove('active');
      n.removeAttribute('aria-current');
    });
    [`nav${key}Side`, `nav${key}Bottom`].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('active');
        el.setAttribute('aria-current', 'page');
      }
    });
  }

  // ===== TOAST =====
  let toastTimer;
  function showToast(msg, type = '') {
    const toast = document.getElementById('toast');
    const installBanner = document.getElementById('installBanner');
    const bannerVisible = installBanner && installBanner.classList.contains('show');

    toast.textContent = msg;
    toast.className = 'toast show' + (type ? ' ' + type : '') + (bannerVisible ? ' above-banner' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('show');
    }, 2500);
  }

  // Kalau halaman dibuka lagi dari cache browser (mis. balik dari tab lain
  // atau buka ulang browser), pastikan toast lama yang "nyangkut" langsung
  // disembunyikan, bukan ditampilkan seolah baru saja terjadi.
  window.addEventListener('pageshow', () => {
    clearTimeout(toastTimer);
    const toast = document.getElementById('toast');
    if (toast) toast.classList.remove('show');
  });

  // ===== CUSTOM LONG-PRESS MENU (pengganti menu bawaan "Salin gambar /
  // Download gambar" milik Android/Chrome saat tekan-lama sebuah <img>) =====
  //
  // Triknya: setiap thumbnail (kartu galeri & gambar besar di modal) punya
  // lapisan transparan (.img-touch-catcher) yang menutupinya. Sentuhan
  // mendarat di lapisan itu, bukan di elemen <img> asli — jadi Android tidak
  // pernah mendeteksi "tekan-lama di atas gambar" dan menu bawaannya tidak
  // pernah muncul. Long-press kita deteksi manual lewat timer, lalu kita
  // tampilkan menu sendiri (mirip action-sheet Pinterest).
  const LONG_PRESS_MS = 420;
  const LONG_PRESS_MOVE_TOLERANCE = 10; // px, batal kalau jari geser lebih dari ini
  let lpTimer = null;
  let lpStartX = 0, lpStartY = 0;
  let lpTriggered = false;
  let lpMoved = false; // true kalau jari sempat geser melewati toleransi (berarti user scroll, bukan tap)
  let lpActiveEl = null;

  function buildLongPressActions(imgId) {
    const img = IMAGES.find(i => i.id === imgId);
    const isFav = img && favorites.has(imgId);
    const actions = [
      {
        label: 'Bagikan',
        accent: false,
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
        onClick: () => shareImage(imgId)
      },
      {
        label: isFav ? 'Hapus dari favorit' : 'Tambah ke favorit',
        accent: isFav,
        svg: '<svg viewBox="0 0 24 24" fill="' + (isFav ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round"><use href="#icon-heart"></use></svg>',
        onClick: () => toggleFavorite(imgId)
      },
      {
        label: 'Jadikan Wallpaper',
        accent: false,
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><use href="#icon-wallpaper"></use></svg>',
        onClick: () => setAsWallpaper(imgId)
      },
      {
        label: 'Download HD',
        accent: false,
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><use href="#icon-download"></use></svg>',
        onClick: () => { if (img) triggerDownload(img.url, img.title, img.id); }
      }
    ];
    return actions;
  }

  function openLongPressMenu(imgId, x, y) {
    const menu = document.getElementById('longPressMenu');
    const backdrop = document.getElementById('longPressMenuBackdrop');
    if (!menu || !backdrop) return;

    const actions = buildLongPressActions(imgId);
    menu.innerHTML = actions.map(a => `
      <button type="button" class="long-press-menu-btn${a.accent ? ' accent' : ''}" aria-label="${a.label}" title="${a.label}">${a.svg}</button>
    `).join('');

    // Posisikan menu vertikal ke atas titik sentuh (kalau kepepet ke tepi
    // layar, geser biar tetap kelihatan penuh).
    const menuWidth = 56;
    const menuHeight = actions.length * 58;
    let left = Math.min(Math.max(x - menuWidth / 2, 8), window.innerWidth - menuWidth - 8);
    let top = y - menuHeight - 24;
    let origin = 'bottom center';
    if (top < 8) { top = y + 24; origin = 'top center'; }

    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.style.setProperty('--lpm-origin', origin);

    [...menu.children].forEach((btn, i) => {
      btn.addEventListener('click', () => {
        actions[i].onClick();
        closeLongPressMenu();
      });
    });

    menu.classList.add('open');
    backdrop.classList.add('open');
    if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) {} }
  }

  function closeLongPressMenu() {
    const menu = document.getElementById('longPressMenu');
    const backdrop = document.getElementById('longPressMenuBackdrop');
    if (menu) menu.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
  }

  function getTouchPoint(e) {
    if (e.touches && e.touches[0]) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  function handleCatcherStart(e, imgId) {
    lpTriggered = false;
    lpMoved = false;
    lpActiveEl = e.currentTarget;
    const p = getTouchPoint(e);
    lpStartX = p.x;
    lpStartY = p.y;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      lpTriggered = true;
      openLongPressMenu(imgId, p.x, p.y);
    }, LONG_PRESS_MS);
  }

  function handleCatcherMove(e) {
    const p = getTouchPoint(e);
    if (Math.abs(p.x - lpStartX) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(p.y - lpStartY) > LONG_PRESS_MOVE_TOLERANCE) {
      clearTimeout(lpTimer);
      lpMoved = true;
    }
  }

  function handleCatcherEnd(e, imgId, onShortTap) {
    clearTimeout(lpTimer);
    // Hanya anggap ini tap kalau long-press tidak sempat terpicu DAN jari
    // tidak pernah geser melewati toleransi. Kalau jari sempat geser
    // (berarti user scroll galeri), jangan buka modal walau geraknya
    // berakhir tepat di atas kartu yang sama.
    if (!lpTriggered && !lpMoved && onShortTap) onShortTap();
    lpActiveEl = null;
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Delegasi untuk kartu-kartu galeri (di-render ulang terus, jadi tidak
    // bisa attach listener satu-satu per kartu).
    const gallery = document.getElementById('gallery');
    if (gallery) {
      gallery.addEventListener('touchstart', (e) => {
        const catcher = e.target.closest('.img-touch-catcher');
        if (!catcher) return;
        handleCatcherStart(e, Number(catcher.dataset.imgId));
      }, { passive: true });

      gallery.addEventListener('touchmove', handleCatcherMove, { passive: true });

      gallery.addEventListener('touchend', (e) => {
        const catcher = e.target.closest('.img-touch-catcher');
        if (!catcher) return;
        // Cegah browser mobile nembak "click" sintetis sesudah ini -> tanpa
        // preventDefault, klik delegated di bawah (buat mouse/desktop) ikut
        // kepanggil lagi buat tap yang sama, bikin openModal() jalan 2x.
        e.preventDefault();
        const imgId = Number(catcher.dataset.imgId);
        handleCatcherEnd(e, imgId, () => openModal(imgId));
      });

      // Desktop: klik biasa tetap buka modal, klik-kanan tetap dimatikan
      // (kita punya menu sendiri).
      gallery.addEventListener('click', (e) => {
        const catcher = e.target.closest('.img-touch-catcher');
        if (!catcher) return;
        openModal(Number(catcher.dataset.imgId));
      });
      gallery.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.img-touch-catcher')) e.preventDefault();
      });
    }

    // Gambar besar di dalam modal (elemen statis, tidak di-render ulang).
    const modalCatcher = document.getElementById('modalImgTouchCatcher');
    if (modalCatcher) {
      modalCatcher.addEventListener('touchstart', (e) => {
        if (!currentModalImage) return;
        handleCatcherStart(e, currentModalImage.id);
      }, { passive: true });
      modalCatcher.addEventListener('touchmove', handleCatcherMove, { passive: true });
      modalCatcher.addEventListener('touchend', (e) => {
        if (!currentModalImage) return;
        handleCatcherEnd(e, currentModalImage.id, null);
      });
      modalCatcher.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    document.getElementById('longPressMenuBackdrop')?.addEventListener('click', closeLongPressMenu);
    window.addEventListener('scroll', closeLongPressMenu, { passive: true });
  });