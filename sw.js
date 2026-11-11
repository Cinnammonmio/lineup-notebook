'use strict';

/* Service worker สำหรับ ARC
 * - หน้าเว็บ, css, js, data/lineups.json: ถามเซิร์ฟเวอร์ก่อนเสมอ (ข้ามแคช 10 นาทีของ GitHub Pages)
 *   ถ้าไม่มีเน็ตใช้ของในแคช → อัปเดตแล้วเห็นทันที
 * - รูปใน media/ และรูปแมพจาก valorant-api: ใช้ของในแคชทันที แล้วอัปเดตเบื้องหลัง
 * - คลิปวิดีโอ: ไม่แคช โหลดตอนกดดูเท่านั้น (ไฟล์ใหญ่)
 * VERSION ต้องตรงกับ APP_VERSION ใน assets/app.js — เปลี่ยนทุกครั้งที่ออกเวอร์ชันใหม่ (ล้างแคชเก่าให้เอง)
 */
const VERSION = '1.17.2';
const SHELL = 'lp-shell-' + VERSION;
const RUNTIME = 'lp-runtime-' + VERSION;
const SHELL_FILES = [
  './',
  'index.html',
  'assets/style.css',
  'assets/app.js',
  'assets/icon.svg',
  'assets/icon-192.png',
  'manifest.webmanifest',
  'data/lineups.json',
];

/** Unique URL so neither the browser nor GitHub Pages' CDN (up to 10 min) can answer with an old copy. */
const fresh = (u) => u + (u.includes('?') ? '&' : '?') + '__v=' + Date.now();

self.addEventListener('install', (e) => {
  // precache straight from the server, stored under the clean URL
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(async (f) => {
      const res = await fetch(fresh(new URL(f, self.location).href), { cache: 'no-store' });
      if (!res.ok) throw new Error(f + ' ' + res.status);
      await c.put(new URL(f, self.location).href, res);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== RUNTIME) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isVideo = (req, url) =>
  req.destination === 'video' || req.headers.has('range') || /\.(mp4|webm|mov|m4v)$/i.test(url.pathname);

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    // revalidate with the server (304 when unchanged) instead of trusting the HTTP cache
    const res = await fetch(fresh(req.url), { cache: 'no-store', credentials: 'same-origin' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await caches.match('index.html');
      if (shell) return shell;
    }
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fresh;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (!/^https?:$/.test(url.protocol)) return;
  if (isVideo(req, url)) return; // ปล่อยให้เบราว์เซอร์โหลดเอง ไม่แคช

  const same = url.origin === self.location.origin;
  if (same && /\/media\//.test(url.pathname)) {
    e.respondWith(staleWhileRevalidate(req, RUNTIME));
  } else if (same) {
    e.respondWith(networkFirst(req, SHELL));
  } else if (req.destination === 'image' || req.destination === 'font' || req.destination === 'style') {
    // รูปแมพ/ไอคอนจาก valorant-api และฟอนต์ Google
    e.respondWith(staleWhileRevalidate(req, RUNTIME));
  }
  // ที่เหลือ (เช่น API JSON ของ valorant-api) ปล่อยผ่าน — app.js แคชไว้ใน localStorage เองแล้ว
});
