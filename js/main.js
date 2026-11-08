import { InputHub, pointerSource, installTestHook } from './input.js';
import { Camera, cameraSource, calibrate } from './camera.js';
import { VAL_MAX } from './gaze-core.js';
import { Dwell } from './dwell.js';
import * as S from './settings.js';
import * as V from './voice.js';
import * as L from './log.js';
import { t } from './i18n.js';
import firefly from './games/g1-firefly.js';
import drum from './games/g2-drum.js';
import where from './games/g3-where.js';

const STEPS = [
  { n: 1, key: 's1', game: 's1g', id: 'g1-firefly', make: (c) => firefly(c), icon: 'firefly' },
  { n: 2, key: 's2', game: 's2g', id: 'g2-drum', make: (c) => drum(c, { mode: 'cause' }), icon: 'drum' },
  { n: 3, key: 's3', game: 's3g', id: 'g2-drum', make: (c) => drum(c, { mode: 'hold' }), icon: 'drum' },
  { n: 4, key: 's4', game: 's4g', id: 'g3-where', make: (c) => where(c), icon: 'where' },
  { n: 5, key: 's5', game: 's5g', id: 'g3-where-3', make: (c) => where(c, { choices: 3 }), icon: 'where' },
  { n: 6, key: 's6' },
];

const IDLE_BREATHE_MS = 8000;
const IDLE_PROMPT_MS = 20000;

const $ = (sel) => document.querySelector(sel);
const settings = S.load();
const hub = new InputHub();
const dwell = new Dwell();
let selected = 1;
let game = null, session = null;
let lastActive = 0, lastPrompt = 0;

hub.use(pointerSource(window));
installTestHook(hub);
hub.onTap((e) => { if (game && settings.tapSelects) { if (dwell.tap(e.x, e.y)) lastActive = performance.now(); } });

// ——— панель учителя ———
function renderPanel() {
  const L_ = settings.lang;
  document.documentElement.lang = L_;
  document.querySelectorAll('[data-t]').forEach((n) => { n.textContent = t(L_, n.dataset.t); });
  document.querySelectorAll('[data-seg]').forEach((g) => {
    const key = g.dataset.seg;
    g.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(String(settings[key]) === b.value));
    });
  });
  $('#learner').value = settings.learner;
  document.querySelectorAll('.step').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.step) === selected)));
  $('#voice-note').hidden = !settings.sound || V.hasRecorded(settings.lang);
  $('#input-note').hidden = settings.input !== 'camera';
  $('#diag-field').hidden = settings.input !== 'camera';
  renderJournal();
}

function fmtSec(ms) { return ms == null ? '—' : `${(ms / 1000).toFixed(1).replace('.', settings.lang === 'ru' ? ',' : '.')} ${t(settings.lang, 'sec')}`; }

// Chrome и Edge на Windows не знают узбекских месяцев и пишут «M11 6» — месяцы свои.
const MONTHS_UZ = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];
function fmtWhen(d) {
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (settings.lang === 'uz') return `${d.getDate()} ${MONTHS_UZ[d.getMonth()]}, ${hm}`;
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderJournal() {
  const all = L.sessions().slice(-8).reverse();
  const box = $('#journal-body');
  $('#journal-empty').hidden = all.length > 0;
  $('#journal-table').hidden = all.length === 0;
  $('#download').disabled = all.length === 0;
  box.replaceChildren(...all.map((s) => {
    const m = L.summary(s);
    const tr = document.createElement('tr');
    const when = new Date(s.started_at);
    const acc = m.accuracy != null ? m.accuracy : m.hold;
    const cells = [
      fmtWhen(when),
      s.learner || '—',
      String(s.step),
      String(m.count),
      fmtSec(m.avgMs),
      acc == null ? '—' : `${Math.round(acc * 100)} %`,
    ];
    cells.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.append(td); });
    return tr;
  }));
}

function buildLadder() {
  const ol = $('#ladder');
  STEPS.forEach((s) => {
    const li = document.createElement('li');
    li.style.setProperty('--i', s.n - 1);
    const b = document.createElement('button');
    b.className = 'step';
    b.dataset.step = s.n;
    b.disabled = !s.make;
    b.innerHTML = `
      <span class="step__n">${s.n}</span>
      <span class="step__icon step__icon--${s.icon || 'none'}" aria-hidden="true"></span>
      <span class="step__text"><span class="step__skill" data-t="${s.key}"></span>
      ${s.make ? `<span class="step__game" data-t="${s.game}"></span>` : '<span class="step__game" data-t="later"></span>'}</span>`;
    b.addEventListener('click', () => { selected = s.n; renderPanel(); });
    b.addEventListener('dblclick', () => { selected = s.n; play(); });
    li.append(b);
    ol.append(li);
  });
}

function bindSettings() {
  document.querySelectorAll('[data-seg]').forEach((g) => {
    g.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const key = g.dataset.seg;
      const v = b.value;
      settings[key] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
      S.save(settings); renderPanel();
    });
  });
  $('#learner').addEventListener('input', (e) => {
    settings.learner = e.target.value.trim().slice(0, 12);
    S.save(settings);
  });
  $('#play').addEventListener('click', play);
  $('#download').addEventListener('click', L.exportJson);
}

// ——— сцена ———
const stage = $('#stage');
const dots = $('#dots');
const gazeDot = $('#gaze');

function place(size, avoid) {
  const m = size / 2 + 28;
  const w = innerWidth, h = innerHeight;
  let best = null, bestD = -1;
  for (let i = 0; i < 24; i++) {
    const p = { x: m + Math.random() * Math.max(1, w - 2 * m), y: m + Math.random() * Math.max(1, h - 2 * m - 40) };
    const d = avoid ? Math.hypot(p.x - avoid.x, p.y - avoid.y) : 1e9;
    if (d > Math.min(w, h) * 0.4) return p;
    if (d > bestD) { best = p; bestD = d; }
  }
  return best;
}

function object(cls, svg, size, pos) {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = svg;
  el.style.width = el.style.height = `${size}px`;
  el.style.left = `${pos.x - size / 2}px`;
  el.style.top = `${pos.y - size / 2}px`;
  el._pos = pos;
  stage.append(el);
  requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('is-in')));
  return el;
}

function leave(el) {
  el.classList.add('is-out');
  setTimeout(() => el.remove(), 600);
}

function ripple(el) {
  const r = document.createElement('i');
  r.className = 'ripple';
  const b = el.getBoundingClientRect();
  r.style.cssText = `width:${b.width}px;height:${b.width}px;left:${b.left}px;top:${b.top + b.height / 2 - b.width / 2}px`;
  stage.append(r);
  r.addEventListener('animationend', () => r.remove());
}

function setDots(n, total) {
  if (dots.children.length !== total) dots.replaceChildren(...Array.from({ length: total }, () => document.createElement('i')));
  [...dots.children].forEach((d, i) => d.classList.toggle('is-on', i < n));
}

function makeCtx() {
  return {
    stage, dwell, settings,
    size: () => S.targetPx(settings),
    place, object, leave, ripple,
    say: (k) => { V.say(k, settings); lastPrompt = performance.now(); },
    sfx: {
      chime: (i) => V.sfx.chime(settings, i),
      reward: () => V.sfx.reward(settings),
      drum: (s) => V.sfx.drum(settings, s),
      soft: () => V.sfx.soft(settings),
    },
    trial: (r) => { L.addTrial(session, r); lastActive = performance.now(); },
    progress: (n, total) => setDots(n, total),
    finish,
  };
}

// ——— камера: проверка лица → калибровка. true — можно играть ———
const cam = new Camera();
let setupCancel = null;

// Короткая надпись для взрослого посреди сцены (между попытками калибровки).
function notice(text, ms = 2200) {
  const p = $('#cam-pose');
  p.textContent = text; p.hidden = false;
  return new Promise((res) => setTimeout(() => { p.hidden = true; p.textContent = t(settings.lang, 'cam_pose'); res(); }, ms));
}

// Каждый выбор глазами — известная точка взгляда: камера докалибровывается по ходу игры.
dwell.onAnySelect = (tg, info) => {
  if (hub.source?.id !== 'camera' || info.how !== 'dwell') return;
  const r = tg.el.getBoundingClientRect();
  if (!r.width) return;
  cam.learnAt([(r.left + r.width / 2) / innerWidth, (r.top + r.height / 2) / innerHeight], tg.dwellMs(), info.now);
};

// Диагностика: цифры и след радужки за 2 с.
const diagText = $('#cam-diag-text'), trace = $('#cam-diag-trace');
const trail = [];
let diagAt = 0;
function drawDiag(now) {
  if ($('#cam-diag').hidden) return;
  if (cam.last) { trail.push([now, ...cam.last.iris]); while (trail.length && now - trail[0][0] > 2000) trail.shift(); }
  if (now - diagAt < 250) return;
  diagAt = now;
  const d = cam.diag, p = d.pose, ref = d.poseRef;
  const deg = (v) => (v * 180 / Math.PI).toFixed(1);
  const px = cam.err == null ? '—' : `${(cam.err * 100).toFixed(1)} % ≈ ${Math.round(cam.err * Math.hypot(innerWidth, innerHeight) / Math.SQRT2)} px`;
  diagText.textContent = [
    `fps ${d.fps.toFixed(0)} · детекция ${d.detMs.toFixed(0)} мс · ${d.res ?? '—'} ${d.delegate ?? ''}`,
    `проверка ${px}`,
    `дистанция ${p?.dist ? `${p.dist.toFixed(0)} см` : '—'} · Δповорот ${p && ref ? `${deg(p.yaw - ref.yaw)}°/${deg(p.pitch - ref.pitch)}°` : '—'}`,
    `докалибровка ${d.online} · моргания ${d.dropped} · поза ${cam.poseBad ? 'НЕ ТА' : 'ок'}`,
    cam.rec ? `замер ${cam.rec.frames.length} кадров · ${cam.rec.frames.length ? ((cam.rec.frames.at(-1).t - cam.rec.frames[0].t) / 60000).toFixed(1) : 0} мин · выборов ${cam.rec.selects.length}` : 'замер выкл',
  ].join(String.fromCharCode(10));
  const c = trace.getContext('2d');
  c.clearRect(0, 0, trace.width, trace.height);
  c.strokeStyle = '#FFC83D'; c.lineWidth = 1.5; c.beginPath();
  trail.forEach(([, x, y], i) => {
    const X = trace.width / 2 - x * trace.width * 2.2, Y = trace.height / 2 + y * trace.height * 4;
    if (i) c.lineTo(X, Y); else c.moveTo(X, Y);
  });
  c.stroke();
}

function cameraSetup() {
  const box = $('#camsetup'), status = $('#cam-status'), go = $('#cam-go'), skip = $('#cam-skip');
  const L_ = settings.lang;
  const say = (key, cls = '') => { status.textContent = t(L_, key); status.className = `camsetup__status ${cls}`; };
  return new Promise((resolve) => {
    let timer = 0;
    const done = (ok) => {
      clearInterval(timer); setupCancel = null;
      go.onclick = skip.onclick = $('#cam-cancel').onclick = null;
      box.hidden = true;
      resolve(ok);
    };
    setupCancel = () => done(false);
    $('#cam-cancel').onclick = () => done(false);
    box.hidden = false;
    $('#cam-view').replaceChildren(cam.video);
    skip.hidden = !cam.calibrated;
    go.disabled = true;
    if (!Camera.supported()) { say('cam_unsupported', 'is-bad'); return; }
    const watch = () => {
      timer = setInterval(() => {
        const ok = cam.faceVisible;
        // Подсказка о расстоянии: ближе 36 см веко сильнее прикрывает зрачок при взгляде вниз и сдвиг
        // головы сильнее уводит точку (стенд: проверка 4,8 % на 31 см против 2,4 % на 55 см). Не запрещаем.
        const dist = cam.last?.pose?.dist;
        const key = !ok ? 'cam_face_no' : dist && dist < 36 ? 'cam_near' : dist > 80 ? 'cam_far' : 'cam_face_ok';
        if (!status.dataset.hold) say(key, ok ? 'is-ok' : 'is-bad');
        go.disabled = !ok;
      }, 200);
    };
    // Причину отказа называем точно: запрет камеры, нет камеры или не загрузилась модель (нет сети).
    // Раньше всё было «нет доступа к камере», и без сети взрослый искал разрешения. Кнопка — «Попробовать снова».
    const begin = () => {
      say('cam_loading');
      cam.start().then(watch, (e) => {
        const n = e?.name;
        say(n === 'NotAllowedError' || n === 'SecurityError' ? 'cam_denied'
          : n === 'NotFoundError' || n === 'OverconstrainedError' ? 'cam_nocam'
          : n === 'NotReadableError' ? 'cam_busy' : 'cam_noload', 'is-bad');
        go.dataset.retry = '1'; go.textContent = t(L_, 'cam_try'); go.disabled = false;
      });
    };
    begin();
    skip.onclick = () => done(true);
    const pct = (v) => `${(v * 100).toFixed(1).replace('.', L_ === 'ru' ? ',' : '.')} %`;
    go.onclick = async () => {
      if (go.dataset.retry) { delete go.dataset.retry; go.textContent = t(L_, 'cam_start'); go.disabled = true; begin(); return; }
      clearInterval(timer);
      box.hidden = true;
      if (settings.camDiag) cam.startRecording(); else cam.rec = null;
      let r = null;
      // Ошибка проверки выше порога → один повтор сам, без кнопок.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) await notice(t(L_, 'cam_again'));
        if (!setupCancel) return;
        r = await calibrate(cam, stage, { onPoint: (i) => V.sfx.chime(settings, i % 5) });
        if (r.reason === 'cancel' || !setupCancel) return; // вышли во время калибровки
        if (r.ok || r.reason !== 'val') break;
      }
      if (r.ok) { done(true); return; }
      box.hidden = false;
      status.dataset.hold = '1';
      if (r.reason === 'val') {
        status.textContent = `${t(L_, 'cam_bad')} ${t(L_, 'cam_val')}: ${pct(r.err)} (${t(L_, 'cam_need')} ${pct(VAL_MAX)}).`;
        status.className = 'camsetup__status is-bad';
      } else say('cam_bad', 'is-bad');
      go.textContent = t(L_, 'cam_retry');
      skip.textContent = t(L_, 'cam_anyway');
      skip.hidden = !cam.calibrated;
      setTimeout(() => { delete status.dataset.hold; }, 4000);
      watch();
    };
  }).finally(() => {
    go.textContent = t(L_, 'cam_start');
    skip.textContent = t(L_, 'cam_skip');
  });
}

async function play() {
  const step = STEPS.find((s) => s.n === selected);
  if (!step?.make || game || setupCancel) return;
  V.unlock();
  document.body.classList.add('is-playing');
  stage.hidden = false;
  stage.replaceChildren(dots, gazeDot, $('#exit'), $('#camsetup'), $('#cam-pose'), $('#cam-diag'));
  stage.requestFullscreen?.().catch(() => {});
  if (settings.input === 'camera') {
    if (!(await cameraSetup())) { closeStage(); return; }
    hub.smoothing = 0; // камера сглажена своим фильтром One Euro
    hub.use(cameraSource(cam));
    $('#cam-diag').hidden = !settings.camDiag;
  }
  session = L.startSession({
    learner: settings.learner, game: step.id, step: step.n,
    input_source: settings.input === 'camera' ? 'camera' : (hub.lastRaw?.source || 'mouse'), settings,
  });
  game = step.make(makeCtx());
  setDots(0, game.total);
  lastActive = lastPrompt = performance.now();
  game.start();
}

function finish() {
  dwell.clear();
  setTimeout(() => {
    V.say('done', settings);
    V.sfx.reward(settings);
    stage.classList.add('is-done');
  }, 700);
  setTimeout(exitGame, 4200);
}

function exitGame() {
  if (setupCancel) { setupCancel(); return; }
  if (!game) return;
  game.stop?.();
  game = null;
  dwell.clear();
  V.stopVoice();
  if (session) { L.endSession(session); session = null; }
  closeStage();
}

function closeStage() {
  if (hub.source?.id === 'camera') { hub.smoothing = 0.45; hub.use(pointerSource(window)); }
  $('#cam-pose').hidden = true; $('#cam-diag').hidden = true;
  dwell.paused = document.hidden;
  cam.stop();
  stage.querySelectorAll('.calib-dot').forEach((n) => n.remove());
  stage.classList.remove('is-done', 'is-idle', 'is-paused');
  stage.querySelectorAll('.obj, .petal, .ripple').forEach((n) => n.remove());
  stage.hidden = true;
  document.body.classList.remove('is-playing');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  renderPanel();
}

// Выход: удержать уголок 1 с (ребёнок случайно не выйдет) или Esc.
function bindExit() {
  const btn = $('#exit');
  let timer = 0;
  const cancel = () => { clearTimeout(timer); btn.classList.remove('is-holding'); };
  btn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    btn.classList.add('is-holding');
    timer = setTimeout(() => { cancel(); exitGame(); }, 1000);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, cancel));
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (game || setupCancel)) exitGame();
    // Взрослый или кнопка-переключатель: пробел/Enter = «выбрать то, на что смотрит ребёнок».
    if (game && (e.key === ' ' || e.key === 'Enter') && !e.repeat && settings.tapSelects && hub.point) {
      e.preventDefault();
      if (dwell.tap(hub.point.x, hub.point.y)) lastActive = performance.now();
    }
  });
}

// Вкладка скрыта — пауза. Потерю фокуса окна паузой не считаем: программа
// трекера или клик учителя по другому окну забирают фокус, а ребёнок играет дальше.
function bindPause() {
  const set = (p) => { dwell.paused = p; stage.classList.toggle('is-paused', p && !!game); };
  document.addEventListener('visibilitychange', () => { set(document.hidden); if (document.hidden) V.stopVoice(); });
}

// ——— цикл ———
let prev = performance.now();
function frame(now) {
  const dt = Math.min(50, now - prev); // после паузы не прыгаем вперёд
  prev = now;
  const pt = hub.point;
  if (game && hub.source?.id === 'camera') {
    // Сторож позы: голова ушла от калибровочной — мягкая пауза и подсказка взрослому.
    const bad = cam.poseBad;
    dwell.paused = document.hidden || bad;
    stage.classList.toggle('is-paused', dwell.paused);
    $('#cam-pose').hidden = !bad;
    drawDiag(now);
  }
  if (game) {
    dwell.tick(now, dt, pt);
    if (dwell.activity > 0.02) lastActive = now;
    const idle = now - lastActive;
    stage.classList.toggle('is-idle', idle > IDLE_BREATHE_MS && !dwell.paused);
    if (idle > IDLE_PROMPT_MS && now - lastPrompt > IDLE_PROMPT_MS && !dwell.paused) game.prompt();
    const show = settings.showGaze && pt && pt.source !== 'touch';
    gazeDot.style.opacity = show ? '1' : '0';
    if (pt) gazeDot.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
  }
  requestAnimationFrame(frame);
}

// ——— старт ———
buildLadder();
bindSettings();
bindExit();
bindPause();
$('#cam-diag-rec').addEventListener('click', (e) => { e.stopPropagation(); cam.downloadRecording(); });
await V.loadManifest();
renderPanel();
requestAnimationFrame(frame);

// Офлайн (sw.js): когда всё нужное лежит в кэше — тихая подпись взрослому.
const offline = { ready: false, version: null };
async function checkOffline() {
  const reg = await navigator.serviceWorker.ready;
  const ch = new MessageChannel();
  const st = await new Promise((res) => { ch.port1.onmessage = (e) => res(e.data); reg.active.postMessage({ type: 'status' }, [ch.port2]); });
  Object.assign(offline, { ready: st.offline, version: st.version });
  $('#offline-note').hidden = !st.offline;
}
if ('serviceWorker' in navigator && isSecureContext) {
  navigator.serviceWorker.register('sw.js').then(checkOffline).catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => checkOffline().catch(() => {}));
}

// Для тестов и учителя: состояние без DOM-разбора.
window.__app = {
  get playing() { return Boolean(game); },
  get session() { return session; },
  select: (n) => { selected = n; renderPanel(); },
  play, exit: exitGame, settings, cam, offline,
};
