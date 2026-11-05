// G2 «Барабан» — ступени 2 и 3.
// cause: пока ребёнок смотрит на барабан, он играет; отвёл взгляд — тишина.
//        Попытка = «вернул взгляд и барабан заиграл».
// hold:  барабан ударяет, только если удержать взгляд полную задержку.
import { DRUM, bloom } from '../art.js';

export default function drum(ctx, { mode = 'cause' } = {}) {
  const hold = mode === 'hold';
  const TOTAL = 8;
  let n = 0, el = null, target = null, waitFrom = 0, episodeLogged = false, timer = 0;

  function beat(strong) {
    ctx.sfx.drum(strong);
    el.classList.remove('is-beat');
    void el.offsetWidth; // перезапуск анимации удара
    el.classList.add('is-beat');
    ctx.ripple(el);
  }

  function done() {
    n += 1;
    ctx.progress(n, TOTAL);
    if (n >= TOTAL) { ctx.dwell.remove(target); ctx.finish(); return true; }
    return false;
  }

  function onSelectCause({ now }) {
    beat(false);
    if (!episodeLogged) {
      episodeLogged = true;
      ctx.trial({ time_to_select_ms: Math.round(now - waitFrom) });
    }
  }

  function onLeaveCause() {
    if (!episodeLogged) return;
    episodeLogged = false;
    waitFrom = performance.now();
    done();
  }

  function onSelectHold({ now, held }) {
    beat(true);
    bloom(ctx.stage, el, 'var(--leaf)');
    ctx.trial({ time_to_select_ms: Math.round(now - waitFrom), hold_ok: held ? 1 : 0 });
    if (done()) return;
    // Пауза, чтобы ребёнок увидел ответ, а не барабанил подряд.
    target.enabled = false;
    timer = setTimeout(() => { target.enabled = true; waitFrom = performance.now(); }, 1400);
  }

  return {
    total: TOTAL,
    start() {
      const s = Math.round(ctx.size() * 1.25);
      el = ctx.object('obj drum', DRUM, s, { x: innerWidth / 2, y: innerHeight / 2 });
      waitFrom = performance.now();
      target = ctx.dwell.add({
        el,
        dwellMs: () => (hold ? ctx.settings.dwellMs * 1.25 : Math.max(350, ctx.settings.dwellMs * 0.35)),
        onSelect: hold ? onSelectHold : onSelectCause,
        onLeave: hold ? null : onLeaveCause,
        onProgress: (p) => el.style.setProperty('--p', p.toFixed(3)),
        ring: hold, // в «причине и следствии» кольца нет: ответ сразу звуком
      });
      ctx.say(hold ? 'drum_hold' : 'drum');
    },
    prompt() { ctx.say(hold ? 'drum_hold' : 'drum'); },
    stop() { clearTimeout(timer); },
  };
}
