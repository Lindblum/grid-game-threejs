// Sound effects (SOUND_EFFECTS: recorded samples from /sfx, and ones generated from tones),
// positional sound, the music, and spreading a turn's sounds over the turn.
// The samples are imported with ?url so Vite bundles them (sfx/ is outside public/).
import berryGrowUrl from '../../sfx/fruit.wav?url';
import waitUrl from '../../sfx/wait.wav?url';
import assignUrl from '../../sfx/assign.wav?url';
import creatureDoneUrl from '../../sfx/done.wav?url';
import creatureTrappedUrl from '../../sfx/trapped.wav?url';
import creatureDeathUrl from '../../sfx/death.wav?url';
import eatUrl from '../../sfx/bite.wav?url';
import sipUrl from '../../sfx/sip.wav?url';
import ineffectiveUrl from '../../sfx/ineffective.wav?url';
import breezeUrl from '../../sfx/breeze.wav?url';
import buzzUrl from '../../sfx/buzz.wav?url';
import slitherUrl from '../../sfx/slither.wav?url';
import skitterUrl from '../../sfx/skitter.wav?url';
import hatchUrl from '../../sfx/hatch.wav?url';
import mateUrl from '../../sfx/mate.wav?url';
import soilUrl from '../../music/soil.wav?url';
// Not in sfx/ yet: resolved at run time, so the build doesn't fail; silent until the file exists.
const excreteUrl = new URL('../../sfx/excrete.wav', import.meta.url).href;

let ctx = null;
let soundVolume = 1; // Options → Accessibility → Sounds: 0 (off) to 1
let muted = false; // (Sounds at 0)
let master = null; // the output every sound goes to (a limiter in front of the speakers)
let effects = null; // the sound effects' volume (Sounds), in front of `master`

// ---------------------------------------------------------------- positional sound
// Sounds from the game scene (not the menus) are placed where they happen (`at`: a position in
// scene metres): panned by direction and louder up close. The listener follows the camera
// (setListener, every frame).
const NEAR_M = 0.2; // within this distance a sound plays at its full (close-up) volume
const ROLLOFF = 1; // inverse distance: at 2 × NEAR_M half as loud, at 4 × a quarter, …
const CLOSE_BOOST = 1.6; // a scene sound right next to you is this much louder than a menu sound
const listener = { pos: [0, 0, 0], fwd: [0, 0, -1], up: [0, 1, 0] };

/** Where the player hears from (scene metres) and which way they face: call every frame. */
export function setListener(pos, forward, up) {
  listener.pos = [pos.x, pos.y, pos.z];
  listener.fwd = [forward.x, forward.y, forward.z];
  listener.up = [up.x, up.y, up.z];
  applyListener();
}

function applyListener() {
  const l = ctx?.listener;
  if (!l) return;
  const { pos, fwd, up } = listener;
  if (l.positionX) {
    const t = ctx.currentTime;
    l.positionX.setValueAtTime(pos[0], t);
    l.positionY.setValueAtTime(pos[1], t);
    l.positionZ.setValueAtTime(pos[2], t);
    l.forwardX.setValueAtTime(fwd[0], t);
    l.forwardY.setValueAtTime(fwd[1], t);
    l.forwardZ.setValueAtTime(fwd[2], t);
    l.upX.setValueAtTime(up[0], t);
    l.upY.setValueAtTime(up[1], t);
    l.upZ.setValueAtTime(up[2], t);
  } else {
    l.setPosition(...pos); // (older browsers)
    l.setOrientation(...fwd, ...up);
  }
}

/** Where a sound goes: placed at `at` (scene metres) when given, else straight out (menu sounds). */
function outputAt(audioCtx, at) {
  if (!at) return effects;
  const p = audioCtx.createPanner();
  p.panningModel = 'HRTF';
  p.distanceModel = 'inverse';
  p.refDistance = NEAR_M;
  p.rolloffFactor = ROLLOFF;
  p.maxDistance = 1000;
  if (p.positionX) {
    p.positionX.value = at.x;
    p.positionY.value = at.y;
    p.positionZ.value = at.z;
  } else p.setPosition(at.x, at.y, at.z);
  const g = audioCtx.createGain();
  g.gain.value = CLOSE_BOOST;
  g.connect(p).connect(effects);
  return g;
}

/** Options → Accessibility → Sounds: the sound effects' volume, 0 (off) to 1. */
export function setSoundVolume(v) {
  soundVolume = Math.max(0, Math.min(1, v || 0));
  muted = soundVolume === 0;
  if (effects) effects.gain.value = soundVolume;
}

/** The audio context for sound effects: none while Sounds is off. */
function ac() {
  if (muted) return null;
  return audioContext();
}

/** The audio context (made on first use), whatever Sounds is set to (Music uses it too). */
function audioContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    // everything plays through a gentle limiter: sounds right next to you can be loud
    master = ctx.createDynamicsCompressor();
    master.threshold.value = -6;
    master.knee.value = 6;
    master.ratio.value = 12;
    master.connect(ctx.destination);
    effects = ctx.createGain();
    effects.gain.value = soundVolume;
    effects.connect(master);
    applyListener();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** Call from a user gesture (click / XR session start) so audio is allowed. */
export function unlockAudio() {
  if (!ctx && (!muted || musicLevel)) audioContext();
  else if (ctx?.state === 'suspended') ctx.resume();
  if (ctx) preloadSamples();
}

// ---------------------------------------------------------------- music (/music)
// Options → Music: soil.wav loops while the game is running, fading in when it starts and out
// when it stops (it carries on from where it stopped); the pause menu fades it down to a
// quarter, and back up on leaving it.
const MUSIC_VOLUME = 0.35;
const MUSIC_FADE_S = 1.5;
/** setMusicLevel levels: full while playing, a quarter in the pause menu. */
export const MUSIC_LEVEL = { playing: 1, paused: 0.25 };
let musicLevel = 0; // what the music is fading to: 0 = stopped, else a fraction of MUSIC_VOLUME
let musicBuffer = null; // Promise<AudioBuffer | null>
let musicPlaying = null; // { src, gain, startedAt, offset, ramp: { from, to, t0 } } while playing (or fading)
let musicOffset = 0; // s into the track where it carries on from

/**
 * Fades the music to `level` (a fraction of its full volume) over MUSIC_FADE_S: from 0 it
 * starts playing, to 0 it stops once faded out. Repeated calls with the same level do nothing.
 */
export function setMusicLevel(level) {
  level = Math.max(0, level || 0);
  if (level === musicLevel) return;
  musicLevel = level;
  if (!level) return stopMusic();
  if (musicPlaying) return fadeMusic(musicPlaying, level * MUSIC_VOLUME);
  startMusic();
}

/** The music's volume right now (following its current fade; not every browser reports a ramping gain's value). */
function musicVolumeNow(m, t) {
  const { from, to, t0 } = m.ramp;
  return from + (to - from) * Math.min(1, Math.max(0, (t - t0) / MUSIC_FADE_S));
}

/** Fades playing music `m` from its current volume to `volume`. */
function fadeMusic(m, volume) {
  const t = ctx.currentTime;
  const from = musicVolumeNow(m, t);
  m.gain.gain.cancelScheduledValues(t);
  m.gain.gain.setValueAtTime(from, t);
  m.gain.gain.linearRampToValueAtTime(volume, t + MUSIC_FADE_S);
  m.ramp = { from, to: volume, t0: t };
}

function startMusic() {
  const c = audioContext();
  if (!c) return;
  musicBuffer ??= fetch(soilUrl)
    .then((r) => r.arrayBuffer())
    .then((data) => c.decodeAudioData(data))
    .catch(() => null); // missing / broken: no music
  musicBuffer.then((buf) => {
    if (!buf || !musicLevel || musicPlaying) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = c.createGain();
    const t = c.currentTime;
    gain.gain.setValueAtTime(0, t);
    src.connect(gain).connect(master);
    const offset = musicOffset % buf.duration;
    src.start(t, offset);
    musicPlaying = { src, gain, startedAt: t, offset, ramp: { from: 0, to: 0, t0: t } };
    fadeMusic(musicPlaying, musicLevel * MUSIC_VOLUME); // fade in (to the level wanted by now)
  });
}

function stopMusic() {
  const m = musicPlaying;
  if (!m) return;
  musicPlaying = null;
  const t = ctx.currentTime;
  musicOffset = (m.offset + (t - m.startedAt)) % m.src.buffer.duration; // pick up from here next time
  fadeMusic(m, 0);
  m.src.stop(t + MUSIC_FADE_S + 0.05);
}

// the dev server reloading this module: silence the old copy (its music would play on, out of reach)
if (import.meta.hot) import.meta.hot.dispose(() => ctx?.close());

// ---------------------------------------------------------------- sound effects
// Every sound effect, by name. A SoundEffect is either
//   { file, gain? }      a recorded sample (a URL from the imports above; gain default 0.8), or
//   { tones: [Tone] }    generated: tones played together, each starting t0 s into the sound.
// A Tone: { wave, t0, dur, gain, f0, f1 }
//   wave   a WAVE_TYPES value: SINE | TRIANGLE | SQUARE | SAWTOOTH: an oscillator gliding from f0 to f1 Hz
//                   (NOTE_FREQUENCY values),
//                   rising in 8 ms, then fading away exponentially over `dur` s;
//          NOISE: white noise fading out over `dur`, through a band-pass filter centred
//                   on f0 Hz (a NOTE_FREQUENCY value too) (`q`: its narrowness, default 0.8; f1 unused);
//          SILENCE: nothing (a gap, e.g. to lengthen a sound)
// Either may also set `whenRunning: true`: skipped (not queued) until the page has had a click
// or key press, as the browser holds audio until then (the countdown beeps would otherwise
// all fire at the first click).

/**
 * The kinds of Tone. The oscillator ones are named as Web Audio names them (an OscillatorNode's
 * `type`); NOISE and SILENCE are this file's own.
 */
export const WAVE_TYPES = Object.freeze({
  SINE: 'sine',
  TRIANGLE: 'triangle',
  SQUARE: 'square',
  SAWTOOTH: 'sawtooth',
  NOISE: 'noise',
  SILENCE: 'silence',
});

/**
 * Note frequencies (Hz), equal temperament with A4 = 440 Hz, C2 to B8 (the range the sounds
 * use, tones and noise filters). Sharps are written with an s: Cs5 = C♯5 (= D♭5).
 */
export const NOTE_FREQUENCY = Object.freeze({
  C2: 65.41, Cs2: 69.30, D2: 73.42, Ds2: 77.78, E2: 82.41, F2: 87.31, Fs2: 92.50, G2: 98.00, Gs2: 103.83, A2: 110.00, As2: 116.54, B2: 123.47,
  C3: 130.81, Cs3: 138.59, D3: 146.83, Ds3: 155.56, E3: 164.81, F3: 174.61, Fs3: 185.00, G3: 196.00, Gs3: 207.65, A3: 220.00, As3: 233.08, B3: 246.94,
  C4: 261.63, Cs4: 277.18, D4: 293.66, Ds4: 311.13, E4: 329.63, F4: 349.23, Fs4: 369.99, G4: 392.00, Gs4: 415.30, A4: 440.00, As4: 466.16, B4: 493.88,
  C5: 523.25, Cs5: 554.37, D5: 587.33, Ds5: 622.25, E5: 659.26, F5: 698.46, Fs5: 739.99, G5: 783.99, Gs5: 830.61, A5: 880.00, As5: 932.33, B5: 987.77,
  C6: 1046.50, Cs6: 1108.73, D6: 1174.66, Ds6: 1244.51, E6: 1318.51, F6: 1396.91, Fs6: 1479.98, G6: 1567.98, Gs6: 1661.22, A6: 1760.00, As6: 1864.66, B6: 1975.53,
  C7: 2093.00, Cs7: 2217.46, D7: 2349.32, Ds7: 2489.02, E7: 2637.02, F7: 2793.83, Fs7: 2959.96, G7: 3135.96, Gs7: 3322.44, A7: 3520.00, As7: 3729.31, B7: 3951.07,
  C8: 4186.01, Cs8: 4434.92, D8: 4698.64, Ds8: 4978.03, E8: 5274.04, F8: 5587.65, Fs8: 5919.91, G8: 6271.93, Gs8: 6644.88, A8: 7040.00, As8: 7458.62, B8: 7902.13,
});
const NOTE = NOTE_FREQUENCY;

const OPENING_NOTES = [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6];

/** A bell-like note: a sine at `f` Hz plus a quieter, shorter octave above it. */
const bell = (f, t0, dur = 0.35, gain = 0.14) => [
  { wave: WAVE_TYPES.SINE, f0: f, f1: f * 0.998, t0, dur, gain },
  { wave: WAVE_TYPES.SINE, f0: f * 2, f1: f * 2 * 0.998, t0, dur: dur * 0.6, gain: gain * 0.3 },
];
/** The opening arpeggio's notes (Hz): C E G C, rising. */
const SPARKLE = { wave: WAVE_TYPES.NOISE, f0: NOTE.Fs8, q: 1.2, dur: 0.18, gain: 0.03 };

const _1_2 = 1 / 2;
const _1_3 = 1 / 3;
const _2_3 = 2 / 3;
const _1_4 = 1 / 4;
const _3_4 = 3 / 4;

export const SOUND_EFFECTS = {
  // ---- recorded (sfx/)
  berryGrow: { file: berryGrowUrl }, // a tree grew a Berry
  wait: { file: waitUrl }, // a creature went into Wait (selected, or X)
  assign: { file: assignUrl }, // a creature was given something to do (Wander, or sent to a target)
  creatureDone: { file: creatureDoneUrl }, // a walking creature reached its target (also: freed)
  creatureTrapped: { file: creatureTrappedUrl }, // a creature got walled in
  creatureDeath: { file: creatureDeathUrl }, // a creature died
  eat: { file: eatUrl },
  sip: { file: sipUrl }, // a creature drinking Water
  waterSip: { file: sipUrl }, // Dirt or a tree soaking up Water
  ineffective: { file: ineffectiveUrl }, // an order nothing could carry out
  breeze: { file: breezeUrl }, // clouds blown away
  buzz: { file: buzzUrl }, // a Buzzy moving or turning
  slither: { file: slitherUrl }, // a Squirmy / Slither moving
  skitter: { file: skitterUrl }, // a Crawly moving
  excrete: { file: excreteUrl },
  // ---- generated
  place: { // bright little "plip": a block placed
    tones: [
      { wave: WAVE_TYPES.TRIANGLE, f0: NOTE.C5, f1: NOTE.A5, t0: 0, dur: 0.09, gain: 0.22 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.C6, f1: NOTE.E6, t0: 0.05, dur: 0.1, gain: 0.12 },
      { wave: WAVE_TYPES.NOISE, f0: NOTE.Fs7, t0: 0, dur: 0.03, gain: 0.08 },
    ],
  },
  delete: { // low crunchy "thunk": a block deleted
    tones: [
      { wave: WAVE_TYPES.SQUARE, f0: NOTE.Ds4, f1: NOTE.Fs2, t0: 0, dur: 0.16, gain: 0.08 },
      { wave: WAVE_TYPES.NOISE, f0: NOTE.F5, q: 0.6, t0: 0, dur: 0.14, gain: 0.25 },
    ],
  },
  churn: { // light low gurgle: swallowed food moving along a creature's body
    tones: [
      { wave: WAVE_TYPES.NOISE, f0: NOTE.A3, q: 1.4, t0: 0, dur: 0.16, gain: 0.05 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.G3, f1: NOTE.C3, t0: 0.02, dur: 0.11, gain: 0.06 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.E3, f1: NOTE.A2, t0: 0.1, dur: 0.12, gain: 0.045 },
    ],
  },
  fertile: { // a creature ate a Berry and is Fertile: a warm rising shimmer, three bell notes over a sparkle
    tones: [...bell(NOTE.C5, 0, 0.3, 0.09), ...bell(NOTE.E5, 0.07, 0.3, 0.09), ...bell(NOTE.A5, 0.14, 0.45, 0.1), { ...SPARKLE, t0: 0.1 }],
  },
  mate: { file: mateUrl }, // mating (each turn of it)
  hatch: { file: hatchUrl }, // an Egg hatches
  birth: { // a creature hatched out: a bright little chirp, rising twice
    tones: [
      { wave: WAVE_TYPES.SINE, f0: NOTE.E6, f1: NOTE.B6, t0: 0, dur: 0.07, gain: 0.12 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.G6, f1: NOTE.D7, t0: 0.1, dur: 0.08, gain: 0.12 },
      ...bell(NOTE.C6, 0.2, 0.35, 0.08),
    ],
  },
  bump: { // soft, muted low "bonk": a controlled creature was steered where it can't go
    tones: [
      { wave: WAVE_TYPES.SINE, f0: NOTE.A3, f1: NOTE.E3, t0: 0, dur: 0.09, gain: 0.14 },
      { wave: WAVE_TYPES.NOISE, f0: NOTE.C5, q: 0.7, t0: 0, dur: 0.04, gain: 0.05 },
    ],
  },
  // the controls (R3): two bell notes, rising as you take control of the creature (and its view), falling as you let go
  controlCreature: { tones: [...bell(NOTE.E5, 0, 0.16, 0.1), ...bell(NOTE.A5, 0.08, 0.25, 0.1)] },
  controlObserver: { tones: [...bell(NOTE.A5, 0, 0.16, 0.1), ...bell(NOTE.E5, 0.08, 0.25, 0.1)] },
  tick: { tones: [{ wave: WAVE_TYPES.SINE, f0: NOTE.Fs6, f1: NOTE.F6, t0: 0, dur: 0.035, gain: 0.05 }] }, // menu navigation, tool change
  // XR panels: a click as one snaps onto a controller, a softer one as it comes off
  attach: {
    tones: [
      { wave: WAVE_TYPES.SINE, f0: NOTE.E5, f1: NOTE.B5, t0: 0, dur: 0.05, gain: 0.08 },
      { wave: WAVE_TYPES.NOISE, f0: NOTE.C6, q: 1.2, t0: 0.03, dur: 0.03, gain: 0.06 },
    ],
  },
  detach: {
    tones: [
      { wave: WAVE_TYPES.NOISE, f0: NOTE.C6, q: 1.2, t0: 0, dur: 0.03, gain: 0.05 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.B5, f1: NOTE.E5, t0: 0.02, dur: 0.06, gain: 0.06 },
    ],
  },
  // the countdown: "ready" on A5, "go" an octave higher
  ready: { whenRunning: true, tones: [{ wave: WAVE_TYPES.SINE, f0: NOTE.A5, f1: NOTE.A5, t0: 0, dur: 0.16, gain: 0.16 }] }, // countdown, each second before 0
  go: { whenRunning: true, tones: [{ wave: WAVE_TYPES.SINE, f0: NOTE.A6, f1: NOTE.A6, t0: 0, dur: 0.4, gain: 0.18 }] }, // countdown at 0
  load: { // New / Load (and the game opening): sparkly rising arpeggio, C E G C
    tones: [...OPENING_NOTES.flatMap((f, i) => bell(f, i * 0.06, _1_3, 0.1)), { ...SPARKLE, t0: 0.2 }],
  },
  resume: { // leaving the pause menu: the opening arpeggio backwards, the sparkle first
    tones: [{ ...SPARKLE, t0: 0 }, ...[...OPENING_NOTES].reverse().flatMap((f, i) => bell(f, 0.02 + i * 0.06, 0.32, 0.1))],
  },
  pause: { // opening Options (pausing): Resume's sequence reversed, the arpeggio then the sparkle
    tones: [...OPENING_NOTES.flatMap((f, i) => bell(f, i * 0.06, 0.32, 0.1)), { ...SPARKLE, t0: 0.02 + OPENING_NOTES.length * 0.06 }],
  },
  save: { // confident "ding-dong", G5 then D6, over a soft low thump
    tones: [...bell(NOTE.G5, 0, _1_4, 0.13), ...bell(NOTE.D6, 0.12, 0.45, 0.13), { wave: WAVE_TYPES.TRIANGLE, f0: NOTE.G3, f1: NOTE.G3 * 0.97, t0: 0, dur: 0.2, gain: 0.08 }],
  },
  error: { // short low double buzz
    tones: [
      { wave: WAVE_TYPES.SAWTOOTH, f0: NOTE.Fs3, f1: NOTE.D3, t0: 0, dur: 0.12, gain: 0.05 },
      { wave: WAVE_TYPES.SAWTOOTH, f0: NOTE.Fs3, f1: NOTE.D3, t0: 0.15, dur: 0.12, gain: 0.05 },
    ],
  },
  kirvy: {
    whenRunning: true,
    tones: [
      { wave: WAVE_TYPES.SINE, f0: NOTE.F3, t0: 0.00, dur: 0.25, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.G3, t0: 0.25, dur: 0.25, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.A3, t0: 0.50, dur: 0.25, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.B3, t0: 0.75, dur: 0.25, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.A3, t0: 1.00, dur: 0.25, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.B3, t0: 1.25, dur: 0.25, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.C4, t0: 1.50, dur: 0.50, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.G3, t0: 2.00, dur: 0.25, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.G3, t0: 2.25, dur: 0.25, gain: 0.25 },

      { wave: WAVE_TYPES.SINE, f0: NOTE.G4, t0: 2.75, dur: 0.25, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.F4, t0: 3.00, dur: 0.50, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.E4, t0: 3.50, dur: 0.25, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.D4, t0: 3.75, dur: 0.50, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.E4, t0: 4.25, dur: 0.25, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.C4, t0: 4.50, dur: 0.75, gain: 0.25 },
      { wave: WAVE_TYPES.SINE, f0: NOTE.C5, t0: 5.25, dur: 0.75, gain: 0.25 },
    ],
  }
};

const samples = new Map(); // file URL -> Promise<AudioBuffer | null>

function loadSample(audioCtx, url) {
  if (!samples.has(url)) {
    samples.set(
      url,
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((data) => audioCtx.decodeAudioData(data))
        .catch(() => null) // a missing / broken file just stays silent
    );
  }
  return samples.get(url);
}

/** Starts decoding every recorded sound (once the audio context exists), so the first play isn't late. */
function preloadSamples() {
  for (const sfx of Object.values(SOUND_EFFECTS)) if (sfx.file) loadSample(ctx, sfx.file);
}

/** Plays one generated Tone into `out`, starting at audio time `start` (+ its t0). */
function playTone(audioCtx, tone, start, out) {
  const { wave = WAVE_TYPES.SINE, t0 = 0, dur, gain = 0.2, f0, f1 = f0 } = tone;
  const t = start + t0;
  if (wave === WAVE_TYPES.SILENCE) return;
  if (wave === WAVE_TYPES.NOISE) {
    const len = Math.max(1, Math.floor(audioCtx.sampleRate * dur));
    const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const f = audioCtx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = f0 ?? 1200;
    f.Q.value = tone.q ?? 0.8;
    const g = audioCtx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(out);
    src.start(t);
    return;
  }
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = wave;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

/**
 * Plays sound effect `name` (SOUND_EFFECTS). `at`: where in the scene it happens (scene
 * metres), or none (a menu sound). During a turn (beginTurnSounds … endTurnSounds) it is
 * collected instead, to be spread over the turn. `delay`: seconds from now.
 */
function playSound(name, at = null, delay = 0) {
  const sfx = SOUND_EFFECTS[name];
  if (!sfx) return;
  const where = at && { x: at.x, y: at.y, z: at.z }; // (copied: it may change before it plays)
  if (turnSounds) {
    if (!turnSounds.has(name)) turnSounds.set(name, []);
    turnSounds.get(name).push({ at: where });
    return;
  }
  const c = sfx.whenRunning ? runningCtx() : ac();
  if (!c) return;
  const when = c.currentTime + delay;
  if (sfx.tones) {
    const out = outputAt(c, where);
    for (const tone of sfx.tones) playTone(c, tone, when, out);
    return;
  }
  loadSample(c, sfx.file).then((buf) => {
    if (!buf || muted) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = sfx.gain ?? 0.8;
    src.connect(g).connect(outputAt(c, where));
    src.start(Math.max(when, c.currentTime));
  });
}

/** The audio context, only once the browser lets it play (else null: see `whenRunning`). */
function runningCtx() {
  const c = ac();
  return c && c.state === 'running' ? c : null;
}

// ---------------------------------------------------------------- a turn's sounds
// The turn logic doesn't play its sounds as they happen (they would all land at once): each
// sound used during the turn is counted (n), then played n times spread evenly over the turn.
let turnSounds = null; // name -> [{ at }] while a turn runs, else null
const TURN_SOUND_CAP = 4; // each sound plays at most this many times per turn

/** The turn logic starts: collect its sounds instead of playing them. */
export function beginTurnSounds() {
  turnSounds = new Map();
}

/**
 * The turn logic is done: each sound collected n times plays n times (at most TURN_SOUND_CAP:
 * the nearest ones) over the next `turnSeconds`, one every turnSeconds / n (the first straight
 * away), each from where it happened.
 */
export function endTurnSounds(turnSeconds) {
  const collected = turnSounds;
  turnSounds = null;
  if (!collected) return;
  for (const [name, all] of collected) {
    // at most TURN_SOUND_CAP of each: the ones nearest the listener (non-positional ones count as nearest)
    const dist = (p) => (p.at ? (p.at.x - listener.pos[0]) ** 2 + (p.at.y - listener.pos[1]) ** 2 + (p.at.z - listener.pos[2]) ** 2 : -1);
    const plays = all.length > TURN_SOUND_CAP ? [...all].sort((a, b) => dist(a) - dist(b)).slice(0, TURN_SOUND_CAP) : all;
    const gap = turnSeconds / plays.length;
    plays.forEach(({ at }, i) => playSound(name, at, i * gap));
  }
}

const lastPlayed = new Map();
/**
 * Plays a sound effect by name (a key of SOUND_EFFECTS). Outside a turn the same sound isn't
 * restarted within `minGapMs`, so quick repeats don't pile up; during a turn every one counts
 * (spread over the turn: endTurnSounds). `at`: where in the scene it happens (scene metres),
 * or none (not a scene sound).
 */
export function playSfx(name, minGapMs = 90, at = null) {
  if (!name || !SOUND_EFFECTS[name]) return;
  if (turnSounds) return playSound(name, at); // during a turn: counted, every one plays (spread out)
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < minGapMs) return;
  lastPlayed.set(name, now);
  playSound(name, at);
}

// ---------------------------------------------------------------- named shortcuts
// (`at`: where in the scene it happens, scene metres; the menu / UI sounds take none)
export const playBerryGrow = (at) => playSound('berryGrow', at);
export const playWait = (at) => playSound('wait', at);
export const playAssign = (at) => playSound('assign', at);
export const playCreatureDone = (at) => playSound('creatureDone', at);
export const playCreatureTrapped = (at) => playSound('creatureTrapped', at);
export const playCreatureDeath = (at) => playSound('creatureDeath', at);
export const playPlace = (at = null) => playSound('place', at);
export const playDelete = (at = null) => playSound('delete', at);
export const playTick = () => playSound('tick');
export const playReady = () => playSound('ready');
export const playGo = () => playSound('go');
export const playResume = () => playSound('resume');
export const playPause = () => playSound('pause');
export const playLoad = () => playSound('load');
export const playSave = () => playSound('save');
export const playError = () => playSound('error');
