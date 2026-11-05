// G1 «Светлячок» — ступень 1, заметить. Светлячок появляется в новом месте;
// стоит на него посмотреть — он раскрывается и перелетает.
import { FIREFLY, bloom } from '../art.js';

export default function firefly(ctx) {
  const TOTAL = 10;
  let n = 0, shownAt = 0, target = null, el = null, last = null, timer = 0;

  function spawn() {
    const s = ctx.size();
    el = ctx.object('obj firefly', FIREFLY, s, ctx.place(s, last));
    last = el._pos;
    shownAt = performance.now();
    target = ctx.dwell.add({
      el,
      // Ступень «заметить»: хватает короткого взгляда, полная задержка не нужна.
      dwellMs: () => Math.max(300, ctx.settings.dwellMs * 0.4),
      onSelect: hit,
    });
  }

  function hit({ now }) {
    ctx.dwell.remove(target);
    ctx.trial({ time_to_select_ms: Math.round(now - shownAt) });
    ctx.sfx.chime(n);
    bloom(ctx.stage, el, 'var(--glow)');
    ctx.leave(el);
    n += 1;
    ctx.progress(n, TOTAL);
    if (n >= TOTAL) return ctx.finish();
    timer = setTimeout(spawn, 900);
  }

  return {
    total: TOTAL,
    start() { ctx.say('firefly'); spawn(); },
    prompt() { ctx.say('firefly'); },
    stop() { clearTimeout(timer); },
  };
}
