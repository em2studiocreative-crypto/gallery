#!/usr/bin/env node
/**
 * Build script — Status Gallery (em2studio)
 *
 * Minify app.js -> app.min.js dan styles.css -> styles.min.css.
 * Jalankan ini SETIAP KALI habis edit app.js atau styles.css, sebelum
 * upload/deploy ke GitHub Pages.
 *
 * Cara pakai:
 *   1. npm install         (sekali saja, buat install terser & clean-css)
 *   2. npm run build       (setiap kali sebelum deploy)
 *
 * Setelah ini selesai, JANGAN LUPA:
 *   - Naikkan CACHE_VERSION di sw.js (mis. 'sg-v8' -> 'sg-v9')
 *   - Upload app.js, app.min.js, styles.css, styles.min.css, sw.js, index.html
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

function fileSize(p) {
  return fs.statSync(p).size;
}

function fmtKB(bytes) {
  return (bytes / 1024).toFixed(1) + ' KB';
}

function run(label, cmd) {
  console.log(`\n> ${label}...`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

console.log('===== Build Status Gallery: minify app.js & styles.css =====');

const jsIn = path.join(ROOT, 'app.js');
const jsOut = path.join(ROOT, 'app.min.js');
const cssIn = path.join(ROOT, 'styles.css');
const cssOut = path.join(ROOT, 'styles.min.css');

if (!fs.existsSync(jsIn)) {
  console.error('ERROR: app.js tidak ditemukan di folder ini.');
  process.exit(1);
}
if (!fs.existsSync(cssIn)) {
  console.error('ERROR: styles.css tidak ditemukan di folder ini.');
  process.exit(1);
}

// --- Minify JS ---
run(
  'Minify app.js -> app.min.js',
  `npx terser "${jsIn}" --compress --mangle --output "${jsOut}"`
);

// --- Minify CSS ---
run(
  'Minify styles.css -> styles.min.css',
  `npx --yes -p clean-css-cli cleancss -o "${cssOut}" "${cssIn}"`
);

// --- Validasi sintaks JS hasil minify ---
console.log('\n> Validasi sintaks app.min.js...');
execSync(`node --check "${jsOut}"`, { cwd: ROOT, stdio: 'inherit' });
console.log('OK, sintaks valid.');

// --- Ringkasan ukuran ---
console.log('\n===== Ringkasan ukuran file =====');
const rows = [
  ['app.js', jsIn],
  ['app.min.js', jsOut],
  ['styles.css', cssIn],
  ['styles.min.css', cssOut],
];
for (const [name, p] of rows) {
  console.log(`${name.padEnd(16)} ${fmtKB(fileSize(p))}`);
}

console.log('\nSelesai! Jangan lupa:');
console.log('  1. Naikkan CACHE_VERSION di sw.js');
console.log('  2. Upload semua file (termasuk app.js & styles.css asli) ke server');
