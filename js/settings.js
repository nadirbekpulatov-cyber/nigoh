// Настройки учителя. Хранятся на устройстве; localStorage может быть недоступен.
const KEY = 'vzglyad.settings.v1';

export const SIZES = { S: 0.16, M: 0.22, L: 0.28, XL: 0.36 };
export const DWELLS = [800, 1200, 2000, 3000];

export const defaults = {
  size: 'L',          // доля короткой стороны экрана
  dwellMs: 1200,
  sound: true,
  showGaze: true,     // мягкая точка там, куда «смотрит» ребёнок
  tapSelects: true,   // касание = выбор сразу (планшет)
  input: 'pointer',   // pointer — мышь, касание, трекер-как-мышь; camera — веб-камера
  camDiag: false,     // диагностика камеры для взрослого: цифры в углу и замер в JSON
  lang: 'ru',
  learner: '',        // код ученика, без имени
};

export function load() {
  try { return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { ...defaults }; }
}

export function save(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* приватный режим */ }
}

export function targetPx(s) {
  const side = Math.min(innerWidth, innerHeight);
  return Math.max(110, Math.round(side * (SIZES[s.size] ?? SIZES.L)));
}
