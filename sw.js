// Офлайн для «Взгляда»: один раз открыли с интернетом — дальше игра целиком работает без сети.
// Два кэша: оболочка (код, звук, иконки) меняется с каждой выкладкой — поднимать SHELL;
// MediaPipe (~26 МБ) меняется редко — свой кэш по версии библиотеки, чтобы при обновлении
// игры не качать его заново. Пути относительные: сайт живёт под /nigoh/ на GitHub Pages.
const SHELL = 'nigoh-shell-v2';
const MP = 'nigoh-mp-0.10.35';
const FONTS = 'nigoh-fonts';

const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/art.js', 'js/camera.js', 'js/dwell.js', 'js/gaze-core.js', 'js/i18n.js',
  'js/input.js', 'js/log.js', 'js/settings.js', 'js/uz.js', 'js/voice.js',
  'js/games/g1-firefly.js', 'js/games/g2-drum.js', 'js/games/g3-where.js',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  'audio/manifest.json',
  ...['ru', 'uz'].flatMap((l) => ['hello', 'firefly', 'drum', 'drum_hold', 'where_sun', 'where_fish',
    'where_ball', 'praise', 'again', 'done'].map((k) => `audio/${l}/${k}.mp3`)),
];
const MP_FILES = [
  'vendor/mediapipe/vision_bundle.mjs', 'vendor/mediapipe/face_landmarker.task',
  'vendor/mediapipe/wasm/vision_wasm_internal.js', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js', 'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
];
const KEEP = [SHELL, MP, FONTS];
const abs = (p) => new URL(p, self.registration.scope).href;

// cache: 'reload' — мимо HTTP-кэша браузера: GitHub Pages отдаёт max-age=600, иначе в новый кэш
// попадёт старый файл.
async function fill(name, files) {
  const c = await caches.open(name);
  for (const f of files) {
    if (await c.match(abs(f))) continue; // докачка: прерванная установка не начинает с нуля
    const r = await fetch(new Request(abs(f), { cache: 'reload' }));
    if (!r.ok) throw new Error(`${f}: ${r.status}`);
    await c.put(abs(f), r);
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // Новая версия оболочки качается целиком заново — в старый кэш не смешиваем.
    await fill(SHELL, SHELL_FILES);
    await fill(MP, MP_FILES);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('nigoh-') && !KEEP.includes(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Шрифт Google Fonts: берём из кэша, в фоне обновляем; без сети и кэша — фолбэк Segoe UI из css.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith((async () => {
      const c = await caches.open(FONTS);
      const hit = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok || r.type === 'opaque') c.put(req, r.clone()); return r; });
      if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
      return net;
    })());
    return;
  }
  if (url.origin !== self.location.origin) return; // CDN MediaPipe и прочее — мимо
  // Оболочка: cache-first. ignoreSearch — ?v=… и cache: 'no-cache' у манифеста звука не мешают.
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true, ignoreVary: true });
    if (hit) return req.headers.has('range') ? ranged(req, hit) : hit;
    if (req.mode === 'navigate') {
      const shell = await caches.match(abs('index.html'));
      try { return await fetch(req); } catch (err) { if (shell) return shell; throw err; }
    }
    return fetch(req);
  })());
});

// Safari просит звук кусками (Range) и целый ответ 200 не играет — отдаём 206 из кэша.
async function ranged(req, hit) {
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range'));
  if (!m) return hit;
  const buf = await hit.arrayBuffer();
  const start = m[1] ? Number(m[1]) : Math.max(0, buf.byteLength - Number(m[2]));
  const end = m[1] && m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': hit.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
    },
  });
}

// Страница спрашивает: всё ли лежит в кэше. Ответ — для подписи «Готово к работе без интернета».
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'status') return;
  e.waitUntil((async () => {
    const [s, m] = await Promise.all([caches.open(SHELL), caches.open(MP)]);
    const missing = [];
    for (const f of SHELL_FILES) if (!(await s.match(abs(f)))) missing.push(f);
    for (const f of MP_FILES) if (!(await m.match(abs(f)))) missing.push(f);
    e.ports[0]?.postMessage({ offline: missing.length === 0, version: SHELL, missing });
  })());
});
