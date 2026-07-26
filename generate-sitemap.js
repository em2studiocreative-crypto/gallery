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

function urlEntry(loc, lastmod, changefreq, priority) {
  return `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  const { data: images, error } = await supabase
    .from('images')
    .select('id, title, created_at')
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Gagal ambil data gambar dari Supabase:', error.message);
    process.exit(1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const urls = [urlEntry(`${SITE_URL}/`, today, 'daily', '1.0')];

  for (const img of images) {
    const slug = slugify(img.title);
    const loc = `${SITE_URL}/?img=${img.id}${slug ? '-' + slug : ''}`;
    const lastmod = (img.created_at ? String(img.created_at) : today).slice(0, 10);
    urls.push(urlEntry(loc, lastmod, 'monthly', '0.7'));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;

  fs.writeFileSync('sitemap.xml', xml, 'utf8');
  console.log(`sitemap.xml dibuat: ${images.length} gambar + 1 homepage.`);
}

main();
