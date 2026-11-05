// Веб-камера как трекер взгляда. Свой код, без WebGazer (GPLv3).
//
// MediaPipe Face Landmarker (Apache-2.0) работает в браузере: кадры не сохраняются
// и никуда не уходят. Библиотека и модель — в vendor/mediapipe, работают без интернета.
// Признаки и модель — js/gaze-core.js (чистые функции, их меряет стенд tests/bench_camera.mjs).
// Здесь: камера, цикл кадров, калибровка 13 + 4 проверочные, докалибровка, сторож позы, диагностика.

import {
  extract, newState, fitBest, fitRidge, predict, validate, learn, refit, poseMean, poseOff,
  gazeFilter, CALIB_GRID, VAL_GRID, CALIB_TIMING, VAL_MAX,
} from './gaze-core.js';

// Библиотека и модель лежат рядом с игрой (vendor/mediapipe, 07.11): класс без интернета, быстрее первый
// запуск, нет зависимости от чужого сервера. Если файлов нет (их убрали из выкладки) — запасной путь через CDN.
const SOURCES = [
  { mp: new URL('../vendor/mediapipe', import.meta.url).href, model: new URL('../vendor/mediapipe/face_landmarker.task', import.meta.url).href },
  { mp: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35',
    model: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' },
];
const LOST_MS = 400;      // лицо пропало дольше — взгляд потерян
const POSE_BAD_MS = 800;  // голова ушла от калибровочной позы дольше — мягкая пауза
const POSE_OK_MS = 300;   // вернулась и держится — игра дальше
const RECENT_MS = 1500;   // кадры для докалибровки по выбору
const REC_MAX = 30000;    // замер диагностики: до ~16 минут (кадры прореживаем до 30/с)
const POINT_MIN = 12, POINT_EXTRA_MS = 1500; // кадров на точку калибровки и сколько ждать сверх нормы
const REC_STEP_MS = 30;  // 06.11: на ноутбуке Надыра 70 кадров/с, и 9000 кадров кончились за 2,7 минуты

let landmarkerP = null;
async function landmarker() {
  landmarkerP ??= (async () => {
    let err;
    for (const src of SOURCES) {
      try {
        const { FilesetResolver, FaceLandmarker } = await import(`${src.mp}/vision_bundle.mjs`);
        const files = await FilesetResolver.forVisionTasks(`${src.mp}/wasm`);
        const opts = (delegate) => ({
          baseOptions: { modelAssetPath: src.model, delegate },
          runningMode: 'VIDEO', numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
        });
        let lm;
        try { lm = await FaceLandmarker.createFromOptions(files, opts('GPU')); lm.delegate = 'GPU'; }
        catch { lm = await FaceLandmarker.createFromOptions(files, opts('CPU')); lm.delegate = 'CPU'; }
        lm.source = src === SOURCES[0] ? 'local' : 'cdn';
        return lm;
      } catch (e) { err = e; }
    }
    throw err;
  })();
  landmarkerP.catch(() => { landmarkerP = null; });
  return landmarkerP;
}

const r4 = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v * 1e4) / 1e4);

export class Camera {
  constructor() {
    this.video = document.createElement('video');
    this.video.playsInline = true; this.video.muted = true;
    this.stream = null; this.lm = null; this.running = false;
    this.last = null;        // { f, blink, pose, t } последнего кадра с лицом
    this.lastFaceT = 0;
    this.fit = null;         // модель: { model, lambda, calib, online, ... }
    this.err = null;         // ошибка проверки, доли экрана
    this.poseRef = null;
    this.st = newState();
    this.listeners = new Set();
    this.lastVideoT = -1;
    this.recent = [];        // последние кадры { t, f, q } — для докалибровки
    this.poseBadSince = 0; this.poseOkSince = 0; this.poseBad = false;
    this.diag = { fps: 0, detMs: 0, frames: 0, dropped: 0, online: 0 };
    this.rec = null;         // замер диагностики (только числа) или null
    this.listeners.add((fe, t) => this.#track(fe, t));
  }

  get calibrated() { return Boolean(this.fit); }
  get model() { return this.fit?.model ?? null; }
  get faceVisible() { return performance.now() - this.lastFaceT < LOST_MS; }

  static supported() { return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext; }

  async start() {
    if (this.running) return;
    this.wanted = true;
    this.lm = await landmarker();
    // 1280×720: окно глаза у MediaPipe 64×64, при 640×480 глаз в кадре ~30 px и растягивается вдвое.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }, audio: false,
    });
    // Пока ждали разрешения, взрослый нажал «Отмена» — камеру не держим.
    if (!this.wanted) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.stream = stream;
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    // Детекция не чаще кадра камеры: requestVideoFrameCallback, где он есть.
    const v = this.video;
    if (v.requestVideoFrameCallback) {
      const loop = () => { if (!this.running) return; this.step(); v.requestVideoFrameCallback(loop); };
      v.requestVideoFrameCallback(loop);
    } else {
      const loop = () => { if (!this.running) return; this.step(); requestAnimationFrame(loop); };
      requestAnimationFrame(loop);
    }
  }

  stop() {
    this.wanted = false;
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.video.srcObject = null;
  }

  step() {
    const v = this.video;
    if (v.readyState < 2 || v.currentTime === this.lastVideoT) return;
    this.lastVideoT = v.currentTime;
    const t = performance.now();
    let r;
    try { r = this.lm.detectForVideo(v, t); } catch { return; }
    const det = performance.now() - t;
    const d = this.diag;
    d.detMs += (det - d.detMs) * 0.1;
    if (d.prevT) d.fps += (1000 / Math.max(1, t - d.prevT) - d.fps) * 0.1;
    d.prevT = t; d.frames++;
    d.res = `${v.videoWidth}×${v.videoHeight}`; d.delegate = this.lm.delegate + (this.lm.source === "cdn" ? " · CDN" : "");
    const fe = extract(r, v.videoWidth || 640, v.videoHeight || 480, this.st);
    this.listeners.forEach((fn) => fn(fe, t));
  }

  // Общий учёт кадра: и для настоящей камеры, и для тестового «лица», которое зовёт listeners напрямую.
  #track(fe, t) {
    if (!fe) return;
    this.lastFaceT = t;
    if (fe.blink) {
      this.diag.dropped++;
      // в замер и закрытые кадры: раскрытие и eyeBlink — по ним подбирать порог моргания (LID)
      if (this.rec && this.rec.frames.length < REC_MAX && t - (this.rec.frames.at(-1)?.t ?? -1e9) >= REC_STEP_MS) {
        this.rec.frames.push({ t: Math.round(t), b: 1, rel: fe.rel?.map(r4), bs: fe.bs?.map(r4) });
      }
      return;
    }
    this.last = { ...fe, t };
    const q = this.fit ? predict(this.fit.model, fe.f) : null;
    this.recent.push({ t, f: fe.f, q });
    while (this.recent.length && t - this.recent[0].t > RECENT_MS) this.recent.shift();
    // сторож позы
    if (this.poseRef && fe.pose) {
      if (poseOff(fe.pose, this.poseRef)) { this.poseOkSince = 0; this.poseBadSince ||= t; }
      else { this.poseBadSince = 0; this.poseOkSince ||= t; }
      if (!this.poseBad && this.poseBadSince && t - this.poseBadSince > POSE_BAD_MS) this.poseBad = true;
      if (this.poseBad && this.poseOkSince && t - this.poseOkSince > POSE_OK_MS) this.poseBad = false;
      this.diag.pose = fe.pose; this.diag.poseRef = this.poseRef;
    }
    if (this.rec && this.rec.frames.length < REC_MAX && t - (this.rec.frames.at(-1)?.t ?? -1e9) >= REC_STEP_MS) {
      this.rec.frames.push({ t: Math.round(t), f: fe.f.map(r4), q: q && q.map(r4), wt: fe.wt?.map(r4), rel: fe.rel?.map(r4), dist: r4(fe.pose?.dist) });
    }
  }

  onFrame(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // Новая посадка: опорное лицо и раскрытие век считаются заново.
  resetState() { this.st = newState(); this.recent = []; this.poseBad = false; this.poseBadSince = this.poseOkSince = 0; }

  setFit(fit, err, samples) {
    this.fit = fit; this.err = err;
    this.poseRef = poseMean(samples);
    this.diag.online = 0;
  }

  // Точка взгляда в долях экрана или null.
  gaze(f) {
    if (!this.fit) return null;
    const [x, y] = predict(this.fit.model, f);
    return { x: Math.min(1.05, Math.max(-0.05, x)), y: Math.min(1.05, Math.max(-0.05, y)) };
  }

  // Выбор цели в игре = известная точка взгляда. target — центр цели в долях экрана.
  learnAt(target, dwellMs, now = performance.now()) {
    if (!this.fit) return false;
    const from = now - Math.min(1000, Math.max(250, dwellMs)), to = now - 80;
    const fr = this.recent.filter((r) => r.t >= from && r.t <= to);
    const ok = learn(this.fit, fr.map((r) => r.f), target, now, fr.map((r) => r.q).filter(Boolean));
    if (ok) { refit(this.fit, now); this.diag.online++; }
    this.rec?.selects.push({ t: Math.round(now), target: target.map(r4), used: ok });
    return ok;
  }

  startRecording() { this.rec = { v: 2, started: new Date().toISOString(), frames: [], selects: [], calib: null, screen: [innerWidth, innerHeight] }; }

  // Замер — только числа: признаки, предсказания, точки калибровки. Видео нет.
  downloadRecording() {
    if (!this.rec) return;
    const blob = new Blob([JSON.stringify({ ...this.rec, diag: { ...this.diag, pose: undefined, poseRef: undefined } })], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nigoh-camera-${this.rec.started.slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}

// Источник для InputHub: те же {x, y, t, source, kind}, что у мыши.
export function cameraSource(cam) {
  let off = null, lostTimer = 0;
  const filt = gazeFilter();
  return {
    id: 'camera',
    start(emit) {
      off = cam.onFrame((fe, t) => {
        if (!fe) {
          if (!lostTimer) lostTimer = setTimeout(() => { filt.reset(); emit({ kind: 'leave', t: performance.now(), source: 'camera' }); }, LOST_MS);
          return;
        }
        clearTimeout(lostTimer); lostTimer = 0;
        if (fe.blink) return; // моргание — держим прежнюю точку
        const g = cam.gaze(fe.f);
        if (!g) return;
        const [x, y] = filt([g.x, g.y], t);
        emit({ x: x * innerWidth, y: y * innerHeight, t, source: 'camera', kind: 'move' });
      });
    },
    stop() { off?.(); off = null; clearTimeout(lostTimer); },
  };
}

// ——— калибровка: точка облетает 13 точек, потом 4 проверочные ———
// Результат: { ok, err (проверка, доли экрана), cv, n, reason }.
export function calibrate(cam, stage, { onPoint } = {}) {
  const POINTS = [...CALIB_GRID, ...VAL_GRID];
  const { move: MOVE_MS, settle: SETTLE_MS, collect: COLLECT_MS } = CALIB_TIMING;
  cam.resetState();
  return new Promise((resolve) => {
    const dot = document.createElement('div');
    dot.className = 'calib-dot';
    stage.append(dot);
    const samples = [];
    let i = 0, phaseStart = 0, phase = 'move', from = POINTS[0];
    // Свойство translate, не transform: иначе анимация scale сжимает и смещение — точка уезжает в угол.
    const place = ([x, y]) => { dot.style.translate = `${x * innerWidth}px ${y * innerHeight}px`; };
    place(POINTS[0]);
    const off = cam.onFrame((fe, t) => {
      if (phase === 'collect' && fe && !fe.blink && t - phaseStart > SETTLE_MS) samples.push({ g: i, f: fe.f, y: POINTS[i], pose: fe.pose });
    });
    const finish = () => {
      off(); dot.remove();
      const cal = samples.filter((s) => s.g < CALIB_GRID.length), val = samples.filter((s) => s.g >= CALIB_GRID.length);
      const groups = new Set(cal.map((s) => s.g)).size, vgroups = new Set(val.map((s) => s.g)).size;
      if (groups < 10 || vgroups < 3) return { ok: false, reason: 'face' };
      const fit = fitBest(cal);
      const v = validate(fit.model, val);
      // В рабочую модель идут и проверочные точки: больше данных, а честная ошибка уже снята.
      fit.calib = samples;
      fit.model = fitRidge(samples, fit.lambda);
      cam.setFit(fit, v.err, samples);
      if (cam.rec) cam.rec.calib = { samples: samples.map((s) => ({ g: s.g, y: s.y, f: s.f.map(r4) })), cv: r4(fit.err), val: r4(v.err), lambda: fit.lambda };
      return { ok: v.err < VAL_MAX, reason: v.err < VAL_MAX ? null : 'val', err: v.err, cv: fit.err, per: v.per, n: samples.length };
    };
    const tick = (now) => {
      if (!dot.isConnected) { off(); resolve({ ok: false, reason: 'cancel' }); return; } // сцену закрыли
      if (!phaseStart) phaseStart = now;
      const el = now - phaseStart;
      if (phase === 'move') {
        const k = Math.min(1, el / MOVE_MS), e = 1 - (1 - k) ** 3;
        place([from[0] + (POINTS[i][0] - from[0]) * e, from[1] + (POINTS[i][1] - from[1]) * e]);
        if (k >= 1) { phase = 'collect'; phaseStart = now; dot.classList.add('is-still'); }
      } else if (el > SETTLE_MS + COLLECT_MS && (samples.filter((s) => s.g === i).length >= POINT_MIN || el > SETTLE_MS + COLLECT_MS + POINT_EXTRA_MS)) {
        // точка без кадров не теряется молча: ждём до POINT_EXTRA_MS (06.11 нижний ряд уходил пустым)
        onPoint?.(i);
        dot.classList.remove('is-still');
        from = POINTS[i]; i++;
        if (i >= POINTS.length) { resolve(finish()); return; }
        phase = 'move'; phaseStart = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

// Для тестов.
export * as __core from './gaze-core.js';
