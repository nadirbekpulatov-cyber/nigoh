// Ядро трекера взгляда по веб-камере: чистые функции без DOM (их гоняет и Node-стенд tests/bench_camera.mjs).
// Свой код, без WebGazer (GPLv3).
//
// Кадр MediaPipe → признаки:
//   1. Поворот головы снимаем подгонкой Кабша (кватернион Хорна) жёстких точек лица к опорному кадру:
//      глаза считаются в системе лица, и поворот головы не выглядит как движение глаз.
//   2. Центр радужки — среднее 5 точек (468–472 / 473–477), не одна точка.
//   3. Вес глаза по раскрытию век: прищуренный глаз не голосует, полузакрытые оба — кадр выброшен.
//   4. Признаки: радужка (x, y и квадраты), веки, eyeLook-блендшейпы, поза головы.
// Модель — гребневая регрессия в доли экрана; докалибровка по выборам в игре с затуханием.

export const LOOK = ['eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft', 'eyeLookInRight',
  'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight'];

// Жёсткие точки: лоб, спинка носа, скулы, виски, уголки глаз (рот и подбородок двигаются — не берём).
const RIGID = [10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 234, 454, 127, 356, 93, 323, 33, 133, 362, 263];
const EYES = [
  { inner: 133, outer: 33, up: 159, low: 145, iris: 468, blink: 'eyeBlinkRight', down: ['eyeLookDownRight'] },
  { inner: 362, outer: 263, up: 386, low: 374, iris: 473, blink: 'eyeBlinkLeft', down: ['eyeLookDownLeft'] },
];
// Моргание против взгляда вниз. closed — раскрытие (доля обычного), ниже которого глаз закрыт; ramp — плавный
// переход веса до 1; bs + bsDown·eyeLookDown — порог блендшейпа eyeBlink; base — какие кадры двигают «обычное».
// v2 (06.11 вечер): closed 0,55, ramp 0,3, порог eyeBlink 0,5 без поправки — при взгляде вниз кадры терялись.
export const LID = { closed: 0.3, ramp: 0.25, bs: 0.5, bsDown: 0.4, base: 0.85 };

// 13 точек калибровки: центр, края, углы, внутреннее кольцо; 4 проверочные — между ними.
export const CALIB_GRID = [[.5, .5], [.08, .08], [.5, .08], [.92, .08], [.92, .5], [.92, .92], [.5, .92], [.08, .92], [.08, .5],
  [.3, .3], [.7, .3], [.7, .7], [.3, .7]];
export const VAL_GRID = [[.2, .25], [.8, .3], [.75, .8], [.25, .75]];
export const CALIB_TIMING = { move: 650, settle: 400, collect: 850 };
export const VAL_MAX = 0.08; // ошибка проверки выше 8 % экрана → повтор калибровки

export function newState() { return { ref: null, q: [1, 0, 0, 0], open: [0, 0] }; }

// ——— поворот: кватернион Хорна, степенной метод с прошлого кадра ———
function horn(A, B, q0) {
  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0, bound = 0;
  for (let i = 0; i < A.length; i++) {
    const a = A[i], b = B[i];
    Sxx += a[0] * b[0]; Sxy += a[0] * b[1]; Sxz += a[0] * b[2];
    Syx += a[1] * b[0]; Syy += a[1] * b[1]; Syz += a[1] * b[2];
    Szx += a[2] * b[0]; Szy += a[2] * b[1]; Szz += a[2] * b[2];
    bound += Math.hypot(...a) * Math.hypot(...b);
  }
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  for (let i = 0; i < 4; i++) N[i][i] += bound; // сдвиг: все собственные числа ≥ 0
  let q = q0.slice();
  for (let it = 0; it < 40; it++) {
    const n = N.map((r) => r[0] * q[0] + r[1] * q[1] + r[2] * q[2] + r[3] * q[3]);
    const l = Math.hypot(...n) || 1;
    const nq = n.map((v) => v / l);
    const d = Math.abs(nq[0] - q[0]) + Math.abs(nq[1] - q[1]) + Math.abs(nq[2] - q[2]) + Math.abs(nq[3] - q[3]);
    q = nq;
    if (d < 1e-9) break;
  }
  return q;
}

export function quatToR([w, x, y, z]) {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

// Жёсткая подгонка cur ≈ s·R·ref + c. Возвращает R, c, s.
export function kabsch(ref, cur, q0 = [1, 0, 0, 0]) {
  const n = cur.length;
  const c = [0, 1, 2].map((k) => cur.reduce((s, p) => s + p[k], 0) / n);
  const B = cur.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
  const rms = (P) => Math.sqrt(P.reduce((s, p) => s + p[0] ** 2 + p[1] ** 2 + p[2] ** 2, 0) / P.length);
  const q = horn(ref, B, q0);
  return { q, R: quatToR(q), c, s: rms(B) / rms(ref) };
}

// ——— признаки одного кадра ———
// res — результат detectForVideo; W, H — размер кадра; st — состояние сессии (опорное лицо, веки).
export function extract(res, W, H, st) {
  const lm = res.faceLandmarks?.[0];
  const bs = res.faceBlendshapes?.[0]?.categories;
  if (!lm || !bs || lm.length < 478) return null;
  const P = (i) => [lm[i].x * W, lm[i].y * H, lm[i].z * W];
  const score = {};
  for (const c of bs) score[c.categoryName] = c.score;

  const cur = RIGID.map(P);
  if (!st.ref) {
    const c = [0, 1, 2].map((k) => cur.reduce((s, p) => s + p[k], 0) / cur.length);
    st.ref = cur.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
  }
  const opt = st.opt ?? {}; // выключатели для замеров стенда: noDerot, iris1, noQuad
  const { q, R, c, s } = kabsch(st.ref, cur, st.q);
  st.q = q;
  const Rf = opt.noDerot ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : R;
  // точка кадра → система опорного лица: Rᵀ(p − c)/s
  const toFace = (p) => {
    const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
    return [0, 1, 2].map((k) => (Rf[0][k] * d[0] + Rf[1][k] * d[1] + Rf[2][k] * d[2]) / s);
  };

  const eyes = EYES.map((e, k) => {
    const a = toFace(P(e.inner)), b = toFace(P(e.outer)), u = toFace(P(e.up)), d = toFace(P(e.low));
    const ir = (opt.iris1 ? [0] : [0, 1, 2, 3, 4]).map((j) => toFace(P(e.iris + j)));
    const ic = [0, 1, 2].map((m) => ir.reduce((sum, p) => sum + p[m], 0) / ir.length);
    const w = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const open = Math.hypot(u[0] - d[0], u[1] - d[1]) / w;
    // обычное раскрытие этого глаза — медленное среднее по открытым кадрам (взгляд вниз его не тянет)
    if (!st.open[k]) st.open[k] = open;
    else if (open > LID.base * st.open[k]) st.open[k] += 0.02 * (open - st.open[k]);
    const rel = open / st.open[k];
    // Взгляд вниз опускает веко и поднимает eyeBlink у MediaPipe — это не моргание (замер Надыра 06.11:
    // нижний ряд калибровки терял все кадры). Чем сильнее eyeLookDown, тем выше порог eyeBlink.
    const down = e.down.reduce((m, n) => Math.max(m, score[n] ?? 0), 0);
    const bs = score[e.blink] ?? 0;
    const wt = bs > LID.bs + LID.bsDown * down ? 0 : Math.min(1, Math.max(0, (rel - LID.closed) / LID.ramp));
    return { x: (ic[0] - mx) / w, y: (ic[1] - my) / w, ly: (ic[1] - (u[1] + d[1]) / 2) / w, open, wt, rel, bs };
  });
  const wsum = eyes[0].wt + eyes[1].wt;
  if (wsum < 0.3) return { blink: true, rel: eyes.map((e) => e.rel), bs: eyes.map((e) => e.bs) };
  const avg = (key) => (eyes[0][key] * eyes[0].wt + eyes[1][key] * eyes[1].wt) / wsum;
  const ex = avg('x'), ey = avg('y'), ly = avg('ly'), op = avg('open');

  const yaw = Math.atan2(R[0][2], R[2][2]);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -R[1][2])));
  const roll = Math.atan2(R[1][0], R[1][1]);
  const cx = c[0] / W, cy = c[1] / H, ls = Math.log(s);
  const mtx = res.facialTransformationMatrixes?.[0]?.data;
  const dist = mtx ? Math.abs(mtx[14]) : null; // см до камеры (у MediaPipe z отрицательный)

  const qd = opt.noQuad ? 0 : 1;
  const f = [ex, ey, ly, qd * ex * ex, qd * ey * ey, qd * ex * ey, op, ...LOOK.map((k) => score[k] ?? 0), yaw, pitch, roll, cx, cy, ls];
  return { f, blink: false, pose: { yaw, pitch, roll, cx, cy, ls, dist }, iris: [ex, ey], wt: [eyes[0].wt, eyes[1].wt], rel: eyes.map((e) => e.rel) };
}

// ——— гребневая регрессия с весами ———
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / d;
      if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

// Нижний порог разброса признака при нормировке — кандидат против ухода точки при сдвиге головы.
// Во время калибровки голова почти неподвижна (поворот ±0,4°, сдвиг ±2 px), и модель раздувает признаки
// позы: на замере Надыра 06.11 поворот на 1–2° в игре уводил точку вниз на 9–14 % экрана. Порог гасит
// это по горизонтали. 07.11 включён ×2 по трём живым замерам (20:27, 21:00 со ступенями 3–4, 21:03),
// симуляция приложения с докалибровкой: проверка 5,8 → 5,2 %, ошибка у выбора 9,1 → 6,4 %; без порога
// в замере 21:00 точка к концу уходила на 80 % экрана. ×1 даёт 6,0 % в игре, но проверку до 7,1 % (у порога 8 %).
// Индексы — поза головы в векторе признаков extract(): рад, доли кадра, ln(масштаб).
export const POSE_FLOOR = { 15: 0.035, 16: 0.035, 17: 0.035, 18: 0.02, 19: 0.02, 20: 0.03 };
export const STD_FLOOR = Object.fromEntries(Object.entries(POSE_FLOOR).map(([j, v]) => [j, 2 * v]));

export function fitRidge(S, lambda, floor = STD_FLOOR) {
  const d = S[0].f.length;
  let W = 0;
  const mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const s of S) { const w = s.w ?? 1; W += w; s.f.forEach((v, j) => { mean[j] += w * v; }); }
  for (let j = 0; j < d; j++) mean[j] /= W;
  for (const s of S) { const w = s.w ?? 1; s.f.forEach((v, j) => { std[j] += w * (v - mean[j]) ** 2; }); }
  for (let j = 0; j < d; j++) std[j] = Math.max(Math.sqrt(std[j] / W) || 1, floor?.[j] ?? 0);
  const D = d + 1;
  const A = Array.from({ length: D }, () => Array(D).fill(0));
  const b = [Array(D).fill(0), Array(D).fill(0)];
  const z = Array(D);
  for (const s of S) {
    const w = s.w ?? 1;
    z[0] = 1;
    for (let j = 0; j < d; j++) z[j + 1] = (s.f[j] - mean[j]) / std[j];
    for (let i = 0; i < D; i++) {
      const wz = w * z[i];
      for (let j = i; j < D; j++) A[i][j] += wz * z[j];
      b[0][i] += wz * s.y[0]; b[1][i] += wz * s.y[1];
    }
  }
  for (let i = 0; i < D; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
  for (let i = 1; i < D; i++) A[i][i] += lambda * W / S.length; // свободный член не штрафуем
  return { mean, std, w: [solve(A, b[0]), solve(A, b[1])] };
}

export function predict(m, f) {
  let x = m.w[0][0], y = m.w[1][0];
  for (let j = 0; j < f.length; j++) { const z = (f[j] - m.mean[j]) / m.std[j]; x += m.w[0][j + 1] * z; y += m.w[1][j + 1] * z; }
  return [x, y];
}

// Сила штрафа — выкидываем по очереди одну точку калибровки и меряем ошибку на ней.
export function fitBest(samples) {
  const groups = [...new Set(samples.map((s) => s.g))];
  let best = null;
  for (const lambda of [0.1, 0.3, 1, 3, 10, 30]) {
    let err = 0;
    for (const g of groups) {
      const tr = samples.filter((s) => s.g !== g), te = samples.filter((s) => s.g === g);
      const m = fitRidge(tr, lambda);
      const qs = te.map((s) => predict(m, s.f));
      const mx = median(qs.map((q) => q[0])), my = median(qs.map((q) => q[1]));
      err += Math.hypot(mx - te[0].y[0], my - te[0].y[1]);
    }
    err /= groups.length;
    if (!best || err < best.err) best = { lambda, err };
  }
  return { model: fitRidge(samples, best.lambda), err: best.err, lambda: best.lambda, calib: samples, online: [] };
}

export function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; }

// Ошибка модели на точках, которых она не видела: медиана предсказаний против цели.
export function validate(model, samples) {
  const groups = [...new Set(samples.map((s) => s.g))];
  const per = groups.map((g) => {
    const te = samples.filter((s) => s.g === g);
    const qs = te.map((s) => predict(model, s.f));
    const mx = median(qs.map((q) => q[0])), my = median(qs.map((q) => q[1]));
    return { y: te[0].y, q: [mx, my], e: Math.hypot(mx - te[0].y[0], my - te[0].y[1]) };
  });
  return { err: per.reduce((s, p) => s + p.e, 0) / Math.max(1, per.length), per };
}

// ——— докалибровка по ходу игры ———
// Выбор цели = ребёнок смотрел на её центр. Кадры перед выбором — в выборку, вес затухает.
const ONLINE_MAX = 40, ONLINE_FRAMES = 12, ONLINE_HALF_MS = 180000, ONLINE_W = 2, ONLINE_MAX_SHIFT = 0.2;

export function learn(fit, fs, target, t, preds) {
  if (!fs.length) return false;
  if (preds?.length) { // если модель промахивалась сильно — это, скорее всего, не тот взгляд
    const mx = median(preds.map((q) => q[0])), my = median(preds.map((q) => q[1]));
    if (Math.hypot(mx - target[0], my - target[1]) > ONLINE_MAX_SHIFT) return false;
  }
  const step = Math.max(1, Math.floor(fs.length / ONLINE_FRAMES));
  const g = `o${t}`;
  for (let i = fs.length - 1, n = 0; i >= 0 && n < ONLINE_FRAMES; i -= step, n++) fit.online.push({ g, f: fs[i], y: target, t });
  const gs = [...new Set(fit.online.map((s) => s.g))];
  if (gs.length > ONLINE_MAX) { const keep = new Set(gs.slice(-ONLINE_MAX)); fit.online = fit.online.filter((s) => keep.has(s.g)); }
  return true;
}

export function refit(fit, t) {
  if (!fit.online.length) return;
  const on = fit.online.map((s) => ({ ...s, w: ONLINE_W * 0.5 ** ((t - s.t) / ONLINE_HALF_MS) }));
  fit.model = fitRidge([...fit.calib, ...on], fit.lambda);
}

// ——— сторож позы: голова ушла от калибровочной ———
export function poseMean(samples) {
  const P = samples.map((s) => s.pose).filter(Boolean);
  const m = (k) => median(P.map((p) => p[k]));
  return { yaw: m('yaw'), pitch: m('pitch'), cx: m('cx'), cy: m('cy'), ls: m('ls') };
}
export const POSE_LIMITS = { ang: 14 * Math.PI / 180, pos: 0.18, ls: 0.22 };
export function poseOff(p, ref) {
  if (!p || !ref) return false;
  return Math.abs(p.yaw - ref.yaw) > POSE_LIMITS.ang || Math.abs(p.pitch - ref.pitch) > POSE_LIMITS.ang
    || Math.hypot(p.cx - ref.cx, p.cy - ref.cy) > POSE_LIMITS.pos || Math.abs(p.ls - ref.ls) > POSE_LIMITS.ls;
}

// ——— фильтр One Euro в долях экрана: покой — гладко, быстрый перевод взгляда — без запаздывания ———
export const FILTER = { minCutoff: 0.3, beta: 2, dCutoff: 1 }; // подобрано стендом: tests/bench_camera.mjs tune
export function oneEuro({ minCutoff, beta, dCutoff } = FILTER) {
  let x = null, dx = 0, t0 = 0;
  const a = (fc, dt) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
  const f = (v, t) => {
    if (x === null) { x = v; t0 = t; return v; }
    const dt = Math.max(1e-3, (t - t0) / 1000); t0 = t;
    const d = (v - x) / dt;
    dx += a(dCutoff, dt) * (d - dx);
    x += a(minCutoff + beta * Math.abs(dx), dt) * (v - x);
    return x;
  };
  f.reset = () => { x = null; dx = 0; };
  return f;
}
export function gazeFilter(p = FILTER) {
  const fx = oneEuro(p), fy = oneEuro(p);
  const f = (q, t) => [fx(q[0], t), fy(q[1], t)];
  f.reset = () => { fx.reset(); fy.reset(); };
  return f;
}
