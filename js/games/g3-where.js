// G3 «Где?» — ступени 4 и 5, выбор из двух и из нескольких. Голос называет картинку,
// ребёнок выбирает взглядом. Ошибка без наказания: картинка тихо качнётся, вопрос повторится.
// Вариантов не больше, чем картинок с записанным голосом (сейчас три).
import { ITEMS, bloom } from '../art.js';

const KEYS = Object.keys(ITEMS);

export default function where(ctx, { choices = 2 } = {}) {
  const COUNT = Math.max(2, Math.min(choices, KEYS.length));
  const TOTAL = 10;
  let n = 0, shownAt = 0, firstTry = true, answer = null, lastAnswer = null;
  let pair = [];
  let timers = [];
  const later = (fn, ms) => timers.push(setTimeout(fn, ms));

  function round() {
    const pool = KEYS.filter((k) => k !== lastAnswer);
    answer = pool[Math.floor(Math.random() * pool.length)];
    lastAnswer = answer;
    const others = KEYS.filter((k) => k !== answer).sort(() => Math.random() - 0.5).slice(0, COUNT - 1);
    // Ответ не всегда на одном и том же месте.
    const order = others.slice();
    order.splice(Math.floor(Math.random() * (COUNT)), 0, answer);
    const wide = innerWidth >= innerHeight * 0.9;
    // Цели по сторонам; на узком экране — одна над другой.
    const s = Math.min(ctx.size(), wide ? innerWidth * (COUNT > 2 ? 0.27 : 0.4) : innerWidth * 0.4,
      wide ? innerHeight * 0.42 : innerHeight * (COUNT > 2 ? 0.26 : 0.42));
    const at = (i) => (COUNT === 2 ? (i ? 0.73 : 0.27) : 0.17 + (0.66 * i) / (COUNT - 1));
    pair = order.map((key, i) => {
      const pos = wide
        ? { x: innerWidth * at(i), y: innerHeight * 0.5 }
        : { x: innerWidth / 2, y: innerHeight * (COUNT === 2 ? (i ? 0.72 : 0.3) : 0.2 + (0.6 * i) / (COUNT - 1)) };
      const el = ctx.object(`obj item item--${key}`, ITEMS[key], s, pos);
      const t = ctx.dwell.add({ el, dwellMs: () => ctx.settings.dwellMs, onSelect: (e) => choose(key, el, e) });
      return { key, el, t };
    });
    firstTry = true;
    shownAt = performance.now();
    later(() => ctx.say(`where_${answer}`), 350);
  }

  function choose(key, el, { now }) {
    if (key !== answer) {
      firstTry = false;
      ctx.sfx.soft();
      el.classList.remove('is-no'); void el.offsetWidth; el.classList.add('is-no');
      ctx.say('again');
      later(() => ctx.say(`where_${answer}`), 1300);
      return;
    }
    pair.forEach((p) => { p.t.enabled = false; });
    ctx.trial({ time_to_select_ms: Math.round(now - shownAt), correct: firstTry ? 1 : 0 });
    ctx.sfx.reward();
    bloom(ctx.stage, el, 'var(--leaf)');
    el.classList.add('is-yes');
    if (n % 3 === 0) ctx.say('praise');
    n += 1;
    ctx.progress(n, TOTAL);
    later(() => {
      pair.forEach((p) => { ctx.dwell.remove(p.t); ctx.leave(p.el); });
      if (n >= TOTAL) ctx.finish(); else later(round, 500);
    }, 1300);
  }

  return {
    total: TOTAL,
    start() { round(); },
    prompt() { if (answer) ctx.say(`where_${answer}`); },
    stop() { timers.forEach(clearTimeout); timers = []; },
  };
}
