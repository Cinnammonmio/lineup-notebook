'use strict';

/* Service worker สำหรับ ARC
 * - หน้าเว็บ + data/lineups.json: ลองเน็ตก่อน ถ้าไม่มีเน็ตใช้ของในแคช
 * - css/js/รูป (รวมรูปแมพจาก valorant-api): ใช้ของในแคชทันที แล้วอัปเดตเบื้องหลัง
 * - คลิปวิดีโอ: ไม่แคช โหลดตอนกดดูเท่านั้น (ไฟล์ใหญ่)
 * เปลี่ยน VERSION เมื่ออยากล้างแคชทั้งหมด
 */
const VERSION = 'v3';
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

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
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
    const res = await fetch(req);
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
  if (same && (req.mode === 'navigate' || url.pathname.endsWith('/data/lineups.json'))) {
    e.respondWith(networkFirst(req, SHELL));
  } else if (same) {
    e.respondWith(staleWhileRevalidate(req, SHELL_FILES.some((f) => url.pathname.endsWith('/' + f)) ? SHELL : RUNTIME));
  } else if (req.destination === 'image' || req.destination === 'font' || req.destination === 'style') {
    // รูปแมพ/ไอคอนจาก valorant-api และฟอนต์ Google
    e.respondWith(staleWhileRevalidate(req, RUNTIME));
  }
  // ที่เหลือ (เช่น API JSON ของ valorant-api) ปล่อยผ่าน — app.js แคชไว้ใน localStorage เองแล้ว
});
