#!/usr/bin/env node
/**
 * Generate sitemap.xml untuk Status Gallery (em2studio) dari data Supabase.
 *
 * Pakai:
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... node generate-sitemap.js
 *
 * Env var (nilainya sama persis dengan yang ada di config.js situs ini):
 *   SUPABASE_URL       - project URL Supabase
 *   SUPABASE_ANON_KEY  - anon/public key Supabase (aman, sudah publik di config.js)
 *   SITE_URL           - opsional, default https://www.em2studio.online
 *
 * Output: sitemap.xml di direktori kerja saat ini -> commit sejajar index.html
 * di root repo (biar bisa diakses di https://www.em2studio.online/sitemap.xml).
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SITE_URL = (process.env.SITE_URL || 'https://www.em2studio.online').replace(/\/+$/, '');

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('SUPABASE_URL dan SUPABASE_ANON_KEY wajib diisi lewat env var.');
  process.exit(1);
}

// Identik dengan slugify() di index.html, supaya URL yang digenerate cocok
// dengan URL yang dipakai imageUrlPath() saat modal dibuka -> tidak ada
// duplikat URL antara sitemap dan URL asli yang di-crawl/diklik user.
function slugify(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function xmlEscape(str) {
  return String(str).replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
}

// urlEntry sekarang opsional menerima blok <image:image> (imageBlock),
// dipakai supaya Google Images bisa mengindeks tiap gambar sebagai hasil
// pencarian gambar, bukan cuma URL halamannya di pencarian teks biasa.
function urlEntry(loc, lastmod, changefreq, priority, imageBlock) {
  return `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n${imageBlock ? imageBlock + '\n' : ''}  </url>`;
}

// <image:image> per gambar. title & caption dibuat konsisten dengan pola
// SEO yang sama dipakai di updateImageSEO()/updateImageStructuredData() di
// app.js, supaya sinyal yang diterima Google seragam di semua tempat.
function imageBlockFor(img, catLabel) {
  if (!img.url) return '';
  const title = catLabel ? `${img.title} — ${catLabel}` : img.title;
  const caption = `Download gambar status WhatsApp "${img.title}"${catLabel ? ` kategori ${catLabel}` : ''} gratis dalam kualitas HD di Status Gallery.`;
  return `    <image:image>\n      <image:loc>${xmlEscape(img.url)}</image:loc>\n      <image:title>${xmlEscape(title)}</image:title>\n      <image:caption>${xmlEscape(caption)}</image:caption>\n    </image:image>`;
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const [{ data: images, error: imagesError }, { data: categories, error: catError }] = await Promise.all([
    supabase
      .from('images')
      .select('id, title, category_id, url, created_at')
      .eq('is_active', true)
      .order('created_at', { ascending: false }),
    supabase.from('categories').select('id, label')
  ]);

  if (imagesError) {
    console.error('Gagal ambil data gambar dari Supabase:', imagesError.message);
    process.exit(1);
  }
  if (catError) {
    console.error('Gagal ambil data kategori dari Supabase:', catError.message);
    process.exit(1);
  }

  const labelById = new Map((categories || []).map(c => [c.id, c.label]));

  const today = new Date().toISOString().slice(0, 10);
  const urls = [urlEntry(`${SITE_URL}/`, today, 'daily', '1.0')];

  // Halaman kategori (?kategori=<id>) -- konsisten dengan categoryUrlPath()
  // di app.js. id kategori sudah berupa slug manusiawi yang diisi admin
  // sendiri, jadi dipakai langsung tanpa slugify tambahan.
  for (const cat of categories || []) {
    if (!cat.id || cat.id === 'all') continue;
    urls.push(urlEntry(`${SITE_URL}/?kategori=${encodeURIComponent(cat.id)}`, today, 'weekly', '0.8'));
  }

  for (const img of images) {
    const slug = slugify(img.title);
    const loc = `${SITE_URL}/?img=${img.id}${slug ? '-' + slug : ''}`;
    const lastmod = (img.created_at ? String(img.created_at) : today).slice(0, 10);
    const catLabel = labelById.get(img.category_id) || '';
    urls.push(urlEntry(loc, lastmod, 'monthly', '0.7', imageBlockFor(img, catLabel)));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${urls.join('\n')}\n</urlset>\n`;

  fs.writeFileSync('sitemap.xml', xml, 'utf8');
  const withImages = images.filter(i => i.url).length;
  console.log(`sitemap.xml dibuat: ${images.length} gambar (${withImages} dgn <image:image>) + 1 homepage.`);
}

main();