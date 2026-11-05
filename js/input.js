// Слой ввода: «взгляд = указатель». Игры получают точки {x, y, t, source, kind}
// и не знают, откуда они пришли. Источник: { id, start(emit), stop() }.
//
// Подключено:  pointer — мышь, перо, касание, а также трекер, который ведёт курсор ОС
//              (Tobii и большинство моделей работают так без кода).
//              camera  — веб-камера, MediaPipe в браузере: js/camera.js (cameraSource).
// Для тестов:  window.__gaze.move(x, y) / .tap(x, y) / .leave().

export class InputHub {
  constructor({ smoothing = 0.45 } = {}) {
    this.smoothing = smoothing; // 0 — без сглаживания, ближе к 1 — плавнее и медленнее
    this.point = null;          // последняя сглаженная точка или null (взгляд потерян)
    this.source = null;
    this.tapListeners = new Set();
    this.lastRaw = null;
  }

  use(source) {
    this.source?.stop();
    this.source = source;
    source.start((e) => this.feed(e));
  }

  onTap(fn) { this.tapListeners.add(fn); return () => this.tapListeners.delete(fn); }

  // Вход для любого источника, в том числе тестового.
  feed(e) {
    if (e.kind === 'leave') { this.point = null; this.lastRaw = null; return; }
    if (e.kind === 'tap') { this.tapListeners.forEach((fn) => fn(e)); }
    // Скачок больше трети экрана не сглаживаем: это новый взгляд, а не дрожание.
    const jump = this.point && Math.hypot(e.x - this.point.x, e.y - this.point.y) > Math.min(innerWidth, innerHeight) / 3;
    if (!this.point || jump || e.kind === 'tap') {
      this.point = { ...e };
    } else {
      const a = 1 - this.smoothing;
      this.point = { ...e, x: this.point.x + (e.x - this.point.x) * a, y: this.point.y + (e.y - this.point.y) * a };
    }
    this.lastRaw = e;
  }
}

export function pointerSource(target = window) {
  let off = [];
  return {
    id: 'pointer',
    start(emit) {
      const on = (type, fn) => { target.addEventListener(type, fn, { passive: true }); off.push(() => target.removeEventListener(type, fn)); };
      on('pointermove', (ev) => {
        // Касание без нажатия не двигается; для пальца точка есть только пока он на экране.
        emit({ x: ev.clientX, y: ev.clientY, t: performance.now(), source: ev.pointerType || 'mouse', kind: 'move' });
      });
      on('pointerdown', (ev) => {
        emit({ x: ev.clientX, y: ev.clientY, t: performance.now(), source: ev.pointerType || 'mouse', kind: ev.pointerType === 'mouse' ? 'move' : 'tap' });
      });
      on('pointerup', (ev) => {
        if (ev.pointerType === 'touch') emit({ kind: 'leave', t: performance.now(), source: 'touch' });
      });
      on('pointerleave', () => emit({ kind: 'leave', t: performance.now(), source: 'mouse' }));
      const blur = () => emit({ kind: 'leave', t: performance.now(), source: 'mouse' });
      window.addEventListener('blur', blur); off.push(() => window.removeEventListener('blur', blur));
    },
    stop() { off.forEach((f) => f()); off = []; },
  };
}

// Тестовый источник: скрипты проверки двигают «взгляд» без мыши.
export function installTestHook(hub) {
  const now = () => performance.now();
  window.__gaze = {
    move: (x, y) => hub.feed({ x, y, t: now(), source: 'test', kind: 'move' }),
    tap: (x, y) => hub.feed({ x, y, t: now(), source: 'test', kind: 'tap' }),
    leave: () => hub.feed({ kind: 'leave', t: now(), source: 'test' }),
  };
}
