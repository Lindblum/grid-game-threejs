// Small synthesized sound effects (no audio files needed).
let ctx = null;

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** Call from a user gesture (click / XR session start) so audio is allowed. */
export function unlockAudio() {
  ac();
}

function tone(c, { type = 'sine', f0, f1, t0, dur, gain = 0.2 }) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(c.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(c, { t0, dur, gain = 0.15, freq = 1200, q = 0.8 }) {
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const f = c.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(c.destination);
  src.start(t0);
}

/** Bright little "plip" for placing a block. */
export function playPlace() {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  tone(c, { type: 'triangle', f0: 520, f1: 880, t0: t, dur: 0.09, gain: 0.22 });
  tone(c, { type: 'sine', f0: 1040, f1: 1320, t0: t + 0.05, dur: 0.1, gain: 0.12 });
  noise(c, { t0: t, dur: 0.03, gain: 0.08, freq: 3000 });
}

/** Low crunchy "thunk" for deleting a block. */
export function playDelete() {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  tone(c, { type: 'square', f0: 320, f1: 90, t0: t, dur: 0.16, gain: 0.08 });
  noise(c, { t0: t, dur: 0.14, gain: 0.25, freq: 700, q: 0.6 });
}

/** Soft tick for menu navigation / tool change. */
export function playTick() {
  const c = ac();
  if (!c) return;
  tone(c, { type: 'sine', f0: 1500, f1: 1400, t0: c.currentTime, dur: 0.035, gain: 0.05 });
}
