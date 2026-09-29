// Sound effects: small synthesized ones (no files), plus recorded samples from /sfx.
// The samples are imported with ?url so Vite bundles them (sfx/ is outside public/).
import berryGrowUrl from '../../sfx/berry-grow.wav?url';
import crawlySelectedUrl from '../../sfx/crawly-selected.wav?url';
import crawlySentUrl from '../../sfx/crawly-sent.wav?url';
import crawlyDoneUrl from '../../sfx/crawly-done.wav?url';
import crawlyTrappedUrl from '../../sfx/crawly-trapped.wav?url';
import crawlyDeathUrl from '../../sfx/crawly-death.wav?url';

let ctx = null;
let muted = false;

export function setMuted(m) {
  muted = !!m;
}

function ac() {
  if (muted) return null;
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
  if (!ctx && !muted) ac();
  else if (ctx?.state === 'suspended') ctx.resume();
  if (ctx) preloadSamples();
}

// ---------------------------------------------------------------- samples (/sfx)
const SAMPLE_URLS = {
  berryGrow: berryGrowUrl,
  crawlySelected: crawlySelectedUrl,
  crawlySent: crawlySentUrl,
  crawlyDone: crawlyDoneUrl,
  crawlyTrapped: crawlyTrappedUrl,
  crawlyDeath: crawlyDeathUrl,
};
const samples = new Map(); // name -> Promise<AudioBuffer | null>

function loadSample(c, name) {
  if (!samples.has(name)) {
    samples.set(
      name,
      fetch(SAMPLE_URLS[name])
        .then((r) => r.arrayBuffer())
        .then((data) => c.decodeAudioData(data))
        .catch(() => null) // a missing / broken file just stays silent
    );
  }
  return samples.get(name);
}

/** Starts decoding every sample (once the audio context exists), so the first play isn't late. */
function preloadSamples() {
  for (const name of Object.keys(SAMPLE_URLS)) loadSample(ctx, name);
}

function playSample(name, gain = 0.8) {
  const c = ac();
  if (!c) return;
  loadSample(c, name).then((buf) => {
    if (!buf || muted) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g).connect(c.destination);
    src.start();
  });
}

/** A tree grew a Berry. */
export const playBerryGrow = () => playSample('berryGrow');
/** A Crawly was selected with the Select tool. */
export const playCrawlySelected = () => playSample('crawlySelected');
/** A selected Crawly was sent to a target. */
export const playCrawlySent = () => playSample('crawlySent');
/** A walking Crawly reached its target (back to Wander). */
export const playCrawlyDone = () => playSample('crawlyDone');
/** A Crawly got walled in (Trapped). */
export const playCrawlyTrapped = () => playSample('crawlyTrapped');
/** A Crawly died. */
export const playCrawlyDeath = () => playSample('crawlyDeath');

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

/** Short bell-like note (sine + quiet octave overtone). */
function bell(c, f, t0, dur = 0.35, gain = 0.14) {
  tone(c, { type: 'sine', f0: f, f1: f * 0.998, t0, dur, gain });
  tone(c, { type: 'sine', f0: f * 2, f1: f * 2 * 0.998, t0, dur: dur * 0.6, gain: gain * 0.3 });
}

/** Resume: soft two-note rise. */
export function playResume() {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  bell(c, 587.3, t, 0.18, 0.1); // D5
  bell(c, 880.0, t + 0.07, 0.26, 0.11); // A5
}

/** New / Load: sparkly rising arpeggio. */
export function playLoad() {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  [523.3, 659.3, 784.0, 1046.5].forEach((f, i) => bell(c, f, t + i * 0.06, 0.32, 0.1)); // C E G C
  noise(c, { t0: t + 0.2, dur: 0.18, gain: 0.03, freq: 6000, q: 1.2 });
}

/** Save: confident "ding-dong" confirmation. */
export function playSave() {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  bell(c, 783.99, t, 0.25, 0.13); // G5
  bell(c, 1174.7, t + 0.12, 0.45, 0.13); // D6
  tone(c, { type: 'triangle', f0: 196, f1: 190, t0: t, dur: 0.2, gain: 0.08 }); // soft low thump
}

/** Error: short low buzz. */
export function playError() {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  tone(c, { type: 'sawtooth', f0: 180, f1: 150, t0: t, dur: 0.12, gain: 0.05 });
  tone(c, { type: 'sawtooth', f0: 180, f1: 150, t0: t + 0.15, dur: 0.12, gain: 0.05 });
}
