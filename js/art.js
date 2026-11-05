// Картинки — простые SVG-фигуры в цветах сцены (docs/DESIGN_SYSTEM.md).
// Без внешних файлов и без генеративных API.

export const FIREFLY = `
<svg viewBox="0 0 100 100" aria-hidden="true">
  <ellipse class="wing wing--l" cx="34" cy="36" rx="17" ry="11" transform="rotate(-28 34 36)"/>
  <ellipse class="wing wing--r" cx="66" cy="36" rx="17" ry="11" transform="rotate(28 66 36)"/>
  <circle cx="50" cy="56" r="24" fill="var(--glow)"/>
  <circle cx="50" cy="31" r="10" fill="#E3A925"/>
</svg>`;

export const DRUM = `
<svg viewBox="0 0 120 120" aria-hidden="true">
  <path d="M14 40 v46 c0 12 20.6 22 46 22 s46-10 46-22 V40" fill="var(--ember)"/>
  <path d="M14 46 L36 102 M36 44 L58 108 M58 108 L82 44 M84 102 L106 46 M36 102 L58 46 M82 102 L60 46" stroke="#FFE3C2" stroke-width="3" stroke-linecap="round" opacity=".55" fill="none"/>
  <g class="drum__skin"><ellipse cx="60" cy="40" rx="46" ry="16" fill="#FFE9C7"/>
  <ellipse cx="60" cy="40" rx="46" ry="16" fill="none" stroke="#C94A22" stroke-width="4"/></g>
</svg>`;

export const ITEMS = {
  sun: `
<svg viewBox="0 0 100 100" aria-hidden="true">
  <g stroke="var(--glow)" stroke-width="7" stroke-linecap="round">
    <path d="M50 4v12M50 84v12M4 50h12M84 50h12M17 17l9 9M74 74l9 9M83 17l-9 9M26 74l-9 9"/>
  </g>
  <circle cx="50" cy="50" r="26" fill="var(--glow)"/>
</svg>`,
  fish: `
<svg viewBox="0 0 100 100" aria-hidden="true">
  <path d="M70 50 L96 30 L92 50 L96 70 Z" fill="var(--sky)"/>
  <ellipse cx="44" cy="50" rx="36" ry="24" fill="var(--sky)"/>
  <circle cx="28" cy="44" r="5" fill="var(--stage)"/>
  <path d="M52 34 q8 16 0 32" stroke="var(--stage)" stroke-width="3" fill="none" opacity=".35"/>
</svg>`,
  ball: `
<svg viewBox="0 0 100 100" aria-hidden="true">
  <circle cx="50" cy="50" r="40" fill="var(--ember)"/>
  <path d="M14 38 q36 18 72 0 M14 62 q36 -18 72 0" stroke="#FFE9C7" stroke-width="7" fill="none"/>
</svg>`,
};

// Награда: цель раскрывается лепестками. Без вспышек — только движение и прозрачность.
export function bloom(stage, el, color = 'var(--leaf)', count = 8) {
  const r = el.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  const cx = r.left + r.width / 2 - s.left, cy = r.top + r.height / 2 - s.top;
  const dist = r.width * 0.62;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.PI / count;
    const p = document.createElement('i');
    p.className = 'petal';
    const size = Math.max(18, r.width * 0.16);
    p.style.cssText = `width:${size}px;height:${size}px;left:${cx - size / 2}px;top:${cy - size / 2}px;background:${color}`;
    stage.append(p);
    const dx = Math.cos(a) * dist, dy = Math.sin(a) * dist;
    const anim = p.animate(
      reduce
        ? [{ opacity: 0.9 }, { opacity: 0 }]
        : [
            { transform: 'translate(0,0) scale(.6)', opacity: 0.95 },
            { transform: `translate(${dx}px,${dy}px) scale(1)`, opacity: 0.9, offset: 0.6 },
            { transform: `translate(${dx * 1.15}px,${dy * 1.15}px) scale(.8)`, opacity: 0 },
          ],
      { duration: 900, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' },
    );
    anim.onfinish = () => p.remove();
  }
}
