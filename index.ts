// Edge Function: notify-new-image
//
// Dipanggil otomatis oleh Supabase Database Webhook tiap kali ada baris BARU
// masuk ke tabel `images` (event: INSERT). Tugasnya cuma satu: teruskan ke
// OneSignal REST API supaya semua subscriber dapat push notification asli
// "koleksi baru tersedia" — bukan cuma bell icon in-app.
//
// Kenapa lewat Edge Function, bukan panggil OneSignal langsung dari
// admin.html? Karena ngirim push butuh REST API KEY OneSignal yang RAHASIA
// (siapapun yang pegang key ini bisa broadcast notif ke semua subscriber
// kamu). Kalau ditaruh di kode client (admin.html), key itu kebaca semua
// orang yang buka DevTools. Di sini, key disimpan sebagai secret di server
// Supabase, gak pernah dikirim ke browser.
//
// Env var yang perlu di-set lewat `supabase secrets set`:
//   ONESIGNAL_APP_ID        - App ID dari dashboard OneSignal
//   ONESIGNAL_REST_API_KEY  - REST API Key dari dashboard OneSignal (RAHASIA)

Deno.serve(async (req) => {
  try {
    const payload = await req.json();

    // Payload dari Supabase Database Webhook bentuknya:
    // { type: "INSERT", table: "images", record: {...}, schema: "public" }
    const record = payload?.record;
    if (!record || payload.type !== 'INSERT') {
      return new Response(JSON.stringify({ skipped: true }), { status: 200 });
    }

    // Hanya kirim notif kalau gambarnya langsung aktif (is_active = true).
    // Kalau admin upload dulu baru aktifkan belakangan, sesuaikan logicnya
    // ke event UPDATE + kondisi is_active berubah dari false -> true.
    if (record.is_active === false) {
      return new Response(JSON.stringify({ skipped: 'inactive' }), { status: 200 });
    }

    const ONESIGNAL_APP_ID = Deno.env.get('ONESIGNAL_APP_ID');
    const ONESIGNAL_REST_API_KEY = Deno.env.get('ONESIGNAL_REST_API_KEY');
    const SITE_URL = Deno.env.get('SITE_URL') || 'https://www.em2studio.online';

    if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_API_KEY) {
      console.error('ONESIGNAL_APP_ID / ONESIGNAL_REST_API_KEY belum di-set sebagai secret.');
      return new Response(JSON.stringify({ error: 'missing_config' }), { status: 500 });
    }

    const title = record.title || 'Status baru';
    const slug = slugify(title);
    const targetUrl = `${SITE_URL}/?img=${record.id}${slug ? '-' + slug : ''}`;

    const oneSignalRes = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        included_segments: ['Subscribed Users'],
        headings: { en: 'Koleksi baru tersedia ✨' },
        contents: { en: `Gambar baru: ${title}` },
        url: targetUrl,
        chrome_web_icon: `${SITE_URL}/icon-192.png`
      })
    });

    const result = await oneSignalRes.json();

    if (!oneSignalRes.ok) {
      console.error('OneSignal API error:', result);
      return new Response(JSON.stringify({ error: result }), { status: 502 });
    }

    return new Response(JSON.stringify({ sent: true, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error('notify-new-image error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});

// Sama persis konsepnya dengan slugify() di index.html / generate-sitemap.js,
// supaya URL yang dipush cocok dengan URL yang beneran dibuka user.
function slugify(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
