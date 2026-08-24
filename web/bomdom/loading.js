// Boot progress overlay for the viewport. The card ships visible in the
// static HTML — a one-line script unhides it while the parser is still
// chewing the multi-MB payload slots further down the file — so a big
// export shows SOMETHING the moment the shell paints. This module then
// takes over with a weighted bar: measured where bytes are countable
// (base64 decode, gunzip, file read), time-estimated where they aren't
// (Draco/glTF parse has no progress callback).
//
// beginLoading returns a session token and every other call requires it:
// loads can overlap (a second sidecar drop while the first still reads),
// and a superseded load finishing must not touch the new load's bar.

const $ = (id) => document.getElementById(id);

// Rough desktop decode rates in bytes/ms. They only WEIGHT the stages
// against each other and pace the parse estimate — being 2-3x off makes
// the bar spend its time a little unfairly, never stall or finish early.
export const RATES = { unpack: 250e3, inflate: 150e3, read: 80e3, parse: 8e3 };

let session = null; // { stages: Map<key, {label, ms, frac}>, totalMs, timer, doneTimer }

function render() {
  if (!session) return;
  let acc = 0;
  for (const s of session.stages.values()) acc += (s.ms / session.totalMs) * s.frac;
  const pct = Math.min(100, Math.round(acc * 100));
  $('loadingFill').style.width = pct + '%';
  $('loadingPct').textContent = pct + '%';
  const active = [...session.stages.values()].find((s) => s.frac > 0 && s.frac < 1)
    || [...session.stages.values()].find((s) => s.frac === 0);
  if (active) $('loadingStage').textContent = active.label + '…';
}

// stages: [{ key, label, ms }] in order. ms is the estimated duration used
// as the stage's weight (and, for estimated stages, its pacing constant).
// Returns the session token the other calls need.
export function beginLoading(stages) {
  clearTimers();
  const card = $('loadingCard');
  card.classList.remove('hidden', 'is-done');
  session = {
    stages: new Map(stages.map((s) => [s.key, { label: s.label, ms: Math.max(1, s.ms), frac: 0 }])),
    totalMs: Math.max(1, stages.reduce((a, s) => a + Math.max(1, s.ms), 0)),
    timer: null,
    doneTimer: null,
  };
  render();
  return session;
}

export function stageProgress(token, key, done, total) {
  if (!session || token !== session) return;
  const s = session.stages.get(key);
  if (!s || !total) return;
  s.frac = Math.max(s.frac, Math.min(1, done / total));
  render();
}

// Time-estimated stage (no real progress source): eases toward its weight
// and never quite arrives — stageDone/finishLoading snap it to 100%.
export function stageStart(token, key) {
  if (!session || token !== session) return;
  const s = session.stages.get(key);
  if (!s) return;
  const t0 = performance.now();
  clearInterval(session.timer);
  session.timer = setInterval(() => {
    const t = performance.now() - t0;
    s.frac = Math.max(s.frac, Math.min(0.98, 1 - Math.exp(-t / s.ms)));
    render();
  }, 140);
}

export function stageDone(token, key) {
  if (!session || token !== session) return;
  const s = session.stages.get(key);
  if (!s) return;
  s.frac = 1;
  clearInterval(session.timer);
  render();
}

export function finishLoading(token) {
  if (!session || token !== session) return;
  for (const s of session.stages.values()) s.frac = 1;
  clearInterval(session.timer);
  render();
  const card = $('loadingCard');
  card.classList.add('is-done'); // CSS fades it out
  session.doneTimer = setTimeout(() => {
    // Still our session: a beginLoading in the meantime would have
    // cleared this timeout. Kill the pacing interval too — a stageStart
    // during the fade window must not leak it.
    clearInterval(session.timer);
    session = null;
    card.classList.add('hidden');
    card.classList.remove('is-done');
  }, 400);
}

// Immediate removal — error cards, degraded mode, the sidecar drop zone.
// With a token it only clears that session; without one it clears whatever
// is showing (boot-level failure paths).
export function hideLoading(token) {
  if (token !== undefined && token !== session) return;
  clearTimers();
  session = null;
  $('loadingCard').classList.add('hidden');
  $('loadingCard').classList.remove('is-done');
}

function clearTimers() {
  if (!session) return;
  clearInterval(session.timer);
  clearTimeout(session.doneTimer);
}
