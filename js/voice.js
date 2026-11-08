// Голосовые подсказки и звуки. Порядок: записанный файл из audio/<lang>/ →
// голос браузера (speechSynthesis) → тишина. Звуки синтезирует Web Audio, без файлов.
import { prompt } from './i18n.js';

let manifest = null;
let ctx = null;
let current = null;
// Один общий <audio>: iPhone разрешает звук только элементу, который запустили по жесту.
// Новый Audio() посреди игры молчит, поэтому «открываем» элемент на кнопке «Играть» и дальше меняем src.
let player = null;
const SILENCE = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=';

export async function loadManifest() {
  try { manifest = await (await fetch('audio/manifest.json', { cache: 'no-cache' })).json(); }
  catch { manifest = {}; }
}

// Вызывать по жесту учителя (кнопка «Играть»): иначе браузер не даст звук.
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  ctx?.resume?.();
  if (!player) {
    player = new Audio();
    player.preload = 'auto';
    player.src = SILENCE;
    player.play().then(() => player.pause()).catch(() => {});
  }
}

export function stopVoice() {
  if (current) { current.pause(); current = null; }
  try { speechSynthesis.cancel(); } catch { /* нет API */ }
}

export function say(key, settings) {
  if (!settings.sound) return;
  stopVoice();
  const file = manifest?.[settings.lang]?.[key];
  if (file) {
    const a = player || new Audio();
    a.src = `audio/${settings.lang}/${file}`;
    a.currentTime = 0;
    a.volume = 0.9;
    current = a;
    a.play().catch(() => speak(key, settings));
    return;
  }
  speak(key, settings);
}

function speak(key, settings) {
  const text = prompt(settings.lang, key);
  if (!text || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = settings.lang === 'uz' ? 'uz-UZ' : 'ru-RU';
  u.rate = 0.9;
  speechSynthesis.speak(u);
}

export function hasRecorded(lang) {
  return Boolean(manifest?.[lang] && Object.keys(manifest[lang]).length);
}

// ——— звуки ———
function env(node, t0, a, d, peak) {
  node.gain.setValueAtTime(0.0001, t0);
  node.gain.exponentialRampToValueAtTime(peak, t0 + a);
  node.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
}

function tone(freq, { at = 0, dur = 0.5, type = 'sine', peak = 0.18 } = {}) {
  const t0 = ctx.currentTime + at;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  env(g, t0, 0.015, dur, peak);
  o.connect(g).connect(ctx.destination);
  o.start(t0); o.stop(t0 + dur + 0.05);
}

const PENTA = [523.25, 587.33, 659.25, 783.99, 880.0]; // до мажорная пентатоника: любые две ноты не режут слух

export const sfx = {
  chime(settings, i = 0) {
    if (!settings.sound || !ctx) return;
    const f = PENTA[i % PENTA.length];
    tone(f, { dur: 0.7 }); tone(f * 2, { at: 0.06, dur: 0.5, peak: 0.05 });
  },
  reward(settings) {
    if (!settings.sound || !ctx) return;
    [0, 2, 4].forEach((n, k) => tone(PENTA[n], { at: k * 0.11, dur: 0.6, peak: 0.14 }));
  },
  drum(settings, strong = false) {
    if (!settings.sound || !ctx) return;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(strong ? 150 : 170, t0);
    o.frequency.exponentialRampToValueAtTime(60, t0 + 0.35);
    env(g, t0, 0.005, 0.45, strong ? 0.6 : 0.45);
    o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + 0.5);
    // шорох кожи — короткий шум через фильтр
    const len = Math.floor(ctx.sampleRate * 0.12);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const n = ctx.createBufferSource(); n.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900;
    const ng = ctx.createGain(); ng.gain.value = 0.08;
    n.connect(f).connect(ng).connect(ctx.destination); n.start(t0);
  },
  soft(settings) { // «не то» — нейтрально, без огорчения
    if (!settings.sound || !ctx) return;
    tone(392, { dur: 0.35, type: 'triangle', peak: 0.08 });
  },
};
