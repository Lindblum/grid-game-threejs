// Sound effects: small synthesized ones (no files), plus recorded samples from /sfx.
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
import soilUrl from '../../music/soil.wav?url';
// Not in sfx/ yet: resolved at run time, so the build doesn't fail; silent until the file exists.
const excreteUrl = new URL('../../sfx/excrete.wav', import.meta.url).href;

let ctx = null;
let muted = false;
let master = null; // the output every sound goes to (a limiter in front of the speakers)

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
  if (!at) return master;
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
  g.connect(p).connect(master);
  return g;
}

export function setMuted(m) {
  muted = !!m;
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

// ---------------------------------------------------------------- samples (/sfx)
const SAMPLE_URLS = {
  berryGrow: berryGrowUrl,
  wait: waitUrl,
  assign: assignUrl,
  creatureDone: creatureDoneUrl,
  creatureTrapped: creatureTrappedUrl,
  creatureDeath: creatureDeathUrl,
  eat: eatUrl,
  sip: sipUrl,
  waterSip: sipUrl,
  ineffective: ineffectiveUrl,
  breeze: breezeUrl,
  buzz: buzzUrl,
  slither: slitherUrl,
  excrete: excreteUrl,
};
const samples = new Map(); // name -> Promise<AudioBuffer | null>

function loadSample(audioCtx, name) {
  if (!samples.has(name)) {
    samples.set(
      name,
      fetch(SAMPLE_URLS[name])
        .then((r) => r.arrayBuffer())
        .then((data) => audioCtx.decodeAudioData(data))
        .catch(() => null) // a missing / broken file just stays silent
    );
  }
  return samples.get(name);
}

/** Starts decoding every sample (once the audio context exists), so the first play isn't late. */
function preloadSamples() {
  for (const name of Object.keys(SAMPLE_URLS)) loadSample(ctx, name);
}

/**
 * Plays sample `name`; `at`: where in the scene it happens (scene metres), or none (a menu
 * sound). During a turn (beginTurnSounds … endTurnSounds) it is collected instead, to be
 * spread over the turn. `delay`: seconds from now.
 */
function playSample(name, at = null, gain = 0.8, delay = 0) {
  const where = at && { x: at.x, y: at.y, z: at.z }; // (copied: it may change before it plays)
  if (turnSounds) {
    if (!turnSounds.has(name)) turnSounds.set(name, []);
    turnSounds.get(name).push({ at: where, gain });
    return;
  }
  const c = ac();
  if (!c) return;
  const when = c.currentTime + delay;
  loadSample(c, name).then((buf) => {
    if (!buf || muted) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(g).connect(outputAt(c, where));
    src.start(Math.max(when, c.currentTime));
  });
}

// ---------------------------------------------------------------- a turn's sounds
// The turn logic doesn't play its sounds as they happen (they would all land at once): each
// sample used during the turn is counted (n), then played n times spread evenly over the turn.
let turnSounds = null; // name -> [{ at, gain }] while a turn runs, else null
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
    plays.forEach(({ at, gain }, i) => playSample(name, at, gain, i * gap));
  }
}

/** A tree grew a Berry (`at`: where, as for every scene sound below). */
export const playBerryGrow = (at) => playSample('berryGrow', at);
/** A creature went into Wait (selected with the Select tool, or X). */
export const playWait = (at) => playSample('wait', at);
/** A creature was given something to do: Wander (Y), or sent to a target. */
export const playAssign = (at) => playSample('assign', at);
/** A walking creature reached its target (back to Wander). */
export const playCreatureDone = (at) => playSample('creatureDone', at);
/** A creature got walled in (Trapped). */
export const playCreatureTrapped = (at) => playSample('creatureTrapped', at);
/** A creature died. */
export const playCreatureDeath = (at) => playSample('creatureDeath', at);

const lastPlayed = new Map();
/**
 * Plays a sample by name (a key of SAMPLE_URLS). Outside a turn the same sound isn't restarted
 * within `minGapMs`, so quick repeats don't pile up; during a turn every one counts (spread over
 * the turn: endTurnSounds). `at`: where in the scene it happens (scene metres), or none (not a
 * scene sound).
 */
export function playSfx(name, minGapMs = 90, at = null) {
  if (!name || !SAMPLE_URLS[name]) return;
  if (turnSounds) return playSample(name, at); // during a turn: counted, every one plays (spread out)
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < minGapMs) return;
  lastPlayed.set(name, now);
  playSample(name, at);
}

function tone(audioCtx, { type = 'sine', f0, f1, t0, dur, gain = 0.2, out = master }) {
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t0);
  o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(out);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

function noise(audioCtx, { t0, dur, gain = 0.15, freq = 1200, q = 0.8, out = master }) {
  const len = Math.floor(audioCtx.sampleRate * dur);
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const f = audioCtx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = freq;
  f.Q.value = q;
  const g = audioCtx.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(out);
  src.start(t0);
}

/** Bright little "plip" for placing a block (`at`: where, scene metres). */
export function playPlace(at = null) {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const out = outputAt(c, at);
  tone(c, { type: 'triangle', f0: 520, f1: 880, t0: t, dur: 0.09, gain: 0.22, out });
  tone(c, { type: 'sine', f0: 1040, f1: 1320, t0: t + 0.05, dur: 0.1, gain: 0.12, out });
  noise(c, { t0: t, dur: 0.03, gain: 0.08, freq: 3000, out });
}

/** Low crunchy "thunk" for deleting a block (`at`: where, scene metres). */
export function playDelete(at = null) {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const out = outputAt(c, at);
  tone(c, { type: 'square', f0: 320, f1: 90, t0: t, dur: 0.16, gain: 0.08, out });
  noise(c, { t0: t, dur: 0.14, gain: 0.25, freq: 700, q: 0.6, out });
}

/** Soft tick for menu navigation / tool change. */
export function playTick() {
  const c = ac();
  if (!c) return;
  tone(c, { type: 'sine', f0: 1500, f1: 1400, t0: c.currentTime, dur: 0.035, gain: 0.05 });
}

/**
 * Countdown beeps. Before the page has had a click / key press the browser keeps audio
 * suspended; beeps then are skipped rather than queued (they would all fire at the first click).
 */
function runningCtx() {
  const c = ac();
  return c && c.state === 'running' ? c : null;
}
const COUNTDOWN_HZ = 880; // A5; "go" is one octave higher

/** Countdown: a "ready" beep for each negative second. */
export function playReady() {
  const c = runningCtx();
  if (!c) return;
  tone(c, { type: 'sine', f0: COUNTDOWN_HZ, f1: COUNTDOWN_HZ, t0: c.currentTime, dur: 0.16, gain: 0.16 });
}

/** Countdown: the "go" beep at 0, one octave above "ready", held a little longer. */
export function playGo() {
  const c = runningCtx();
  if (!c) return;
  tone(c, { type: 'sine', f0: COUNTDOWN_HZ * 2, f1: COUNTDOWN_HZ * 2, t0: c.currentTime, dur: 0.4, gain: 0.18 });
}

/** Short bell-like note (sine + quiet octave overtone). */
function bell(audioCtx, f, t0, dur = 0.35, gain = 0.14) {
  tone(audioCtx, { type: 'sine', f0: f, f1: f * 0.998, t0, dur, gain });
  tone(audioCtx, { type: 'sine', f0: f * 2, f1: f * 2 * 0.998, t0, dur: dur * 0.6, gain: gain * 0.3 });
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
