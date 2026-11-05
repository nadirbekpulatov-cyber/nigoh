// Журнал попыток на устройстве, обезличенно. Форма совпадает с таблицами
// session / trial в docs/SCHEMA.md, чтобы позже отправить пачкой в Worker.
const KEY = 'vzglyad.log.v1';

const id = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

function read() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; }
}
function write(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all.slice(-500))); } catch { /* переполнено или запрещено */ }
}

export function startSession({ learner, game, step, input_source, settings }) {
  return {
    id: id(), learner: learner || null, game, step, input_source,
    target_size: settings.size, dwell_ms: settings.dwellMs, lang: settings.lang,
    started_at: new Date().toISOString(), ended_at: null, trials: [],
  };
}

export function addTrial(session, { time_to_select_ms = null, correct = null, hold_ok = null }) {
  session.trials.push({ id: id(), n: session.trials.length + 1, time_to_select_ms, correct, hold_ok, created_at: new Date().toISOString() });
}

export function endSession(session) {
  session.ended_at = new Date().toISOString();
  if (!session.trials.length) return;
  const all = read(); all.push(session); write(all);
}

export function sessions() { return read(); }

export function summary(s) {
  const times = s.trials.map((t) => t.time_to_select_ms).filter((v) => v != null);
  const graded = s.trials.filter((t) => t.correct != null);
  const holds = s.trials.filter((t) => t.hold_ok != null);
  return {
    count: s.trials.length,
    avgMs: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
    accuracy: graded.length ? graded.filter((t) => t.correct).length / graded.length : null,
    hold: holds.length ? holds.filter((t) => t.hold_ok).length / holds.length : null,
  };
}

export function exportJson() {
  const blob = new Blob([JSON.stringify(read(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `vzglyad-journal-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
