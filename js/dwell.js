// Выбор задержкой (dwell). Цель копит время, пока на ней точка взгляда.
// Короткий уход (< GRACE_MS) не сбрасывает: взгляд и рука ребёнка дрожат.
// Длинный уход — кольцо спадает вдвое медленнее, чем росло, а не обнуляется.

export const GRACE_MS = 250;
const DECAY = 0.5;
const COOLDOWN_MS = 700;

export class Dwell {
  constructor() {
    this.targets = new Set();
    this.cooldownUntil = 0;
    this.paused = false;
    this.onAnySelect = null; // (target, info) — каждый выбор; камера по нему докалибруется
  }

  // opts: { el, dwellMs: () => number, onSelect, onEnter, onLeave, onProgress, ring: true }
  add(opts) {
    const t = { enabled: true, broken: false, p: 0, lastHit: -1e9, inside: false, ...opts };
    if (t.ring !== false) t.ringEl = makeRing(t.el);
    this.targets.add(t);
    return t;
  }

  remove(t) { if (!t) return; t.ringEl?.remove(); this.targets.delete(t); }
  clear() { [...this.targets].forEach((t) => this.remove(t)); }

  hit(t, x, y) {
    const r = t.el.getBoundingClientRect();
    if (!r.width) return false;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    // Радиус попадания чуть больше видимой цели; внутри — ещё больше (гистерезис).
    const rad = (Math.max(r.width, r.height) / 2) * (t.inside ? 1.3 : 1.12);
    return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad;
  }

  find(x, y) {
    for (const t of this.targets) if (t.enabled && this.hit(t, x, y)) return t;
    return null;
  }

  tick(now, dt, pt) {
    if (this.paused) return;
    const hit = pt ? this.find(pt.x, pt.y) : null;
    const cooling = now < this.cooldownUntil;
    for (const t of this.targets) {
      const ms = t.dwellMs();
      if (t === hit) {
        // Взгляд на цели и во время паузы после выбора: это не уход.
        if (!t.inside) { t.inside = true; t.onEnter?.(); }
        t.lastHit = now;
        if (!cooling) {
          t.p = Math.min(1, t.p + dt / ms);
          if (t.p >= 1) { this.#select(t, now, 'dwell'); continue; }
        }
      } else if (hit && t.p > 0) {
        // Взгляд на другой цели — это выбор другого, а не дрожание: сброс сразу.
        if (t.inside) { t.inside = false; t.onLeave?.(); }
        t.p = 0; t.broken = false; t.lastHit = -1e9;
      } else if (now - t.lastHit > GRACE_MS) {
        if (t.inside) { t.inside = false; t.broken = t.p > 0; t.onLeave?.(); }
        t.p = Math.max(0, t.p - (dt / ms) * DECAY);
        if (t.p === 0) t.broken = false;
      }
      this.#draw(t);
    }
  }

  // Касание на планшете: выбор сразу (настройка учителя).
  tap(x, y, now = performance.now()) {
    if (this.paused || now < this.cooldownUntil) return false;
    const t = this.find(x, y);
    if (!t) return false;
    this.#select(t, now, 'tap');
    return true;
  }

  get activity() {
    let a = 0;
    for (const t of this.targets) a = Math.max(a, t.p);
    return a;
  }

  #select(t, now, how) {
    const held = !t.broken; // удержал без ухода дольше допуска
    // inside не сбрасываем: взгляд ещё на цели, и уход после выбора
    // должен дойти до onLeave (на этом стоит «причина и следствие»).
    t.p = 0; t.broken = false;
    this.cooldownUntil = now + COOLDOWN_MS;
    this.#draw(t);
    this.onAnySelect?.(t, { now, how, held });
    t.onSelect?.({ now, how, held });
  }

  #draw(t) {
    t.el.style.setProperty('--p', t.p.toFixed(3)); // кольцо наследует
    t.ringEl?.classList.toggle('is-on', t.p > 0.02);
    t.onProgress?.(t.p);
  }
}

const SVGNS = 'http://www.w3.org/2000/svg';
function makeRing(el) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ring');
  for (const cls of ['ring__track', 'ring__fill']) {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', '50'); c.setAttribute('cy', '50'); c.setAttribute('r', '46');
    c.setAttribute('pathLength', '1');
    c.classList.add(cls);
    svg.append(c);
  }
  el.append(svg);
  return svg;
}
