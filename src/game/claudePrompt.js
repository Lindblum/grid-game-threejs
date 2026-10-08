// Debug → Claude: the prompt being written, shared by the browser's Debug dock and the XR debug
// tablet. It can be typed (in XR: the headset's system keyboard, via a hidden text field), dictated
// (the browser's speech recognition, where there is one) and cleared. The response feed can be read
// aloud (the browser's speech synthesis).
//
// Not connected to Claude yet: nothing here sends the prompt anywhere (see claudeBridge.js for
// the dev server bridge it will use).

const SpeechRecognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

const synth = typeof window !== 'undefined' ? window.speechSynthesis ?? null : null;

/** What the response feed shows until Claude is connected. */
export const RESPONSE_PLACEHOLDER = 'Claude isn’t connected yet';

const state = { prompt: '', listening: false, micSupported: !!SpeechRecognition, speaking: false, speechSupported: !!synth };
let snapshot = { ...state };
const listeners = new Set();
const changed = () => {
  snapshot = { ...state };
  for (const fn of listeners) fn();
};

let recognition = null;

/** The hidden <textarea> the XR system keyboard types into (rendered by App). */
function xrField() {
  return typeof document !== 'undefined' ? document.getElementById('claude-xr-input') : null;
}

export const claudePrompt = {
  /** { prompt, listening, micSupported, speaking, speechSupported }: a new object after every change (useSyncExternalStore). */
  getSnapshot: () => snapshot,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  setPrompt(text) {
    state.prompt = text;
    const field = xrField();
    if (field && field.value !== text) field.value = text;
    changed();
  },

  /** Empties the prompt (and stops dictating). */
  clear() {
    recognition?.abort();
    this.setPrompt('');
  },

  /**
   * Starts / stops dictating into the prompt, after what is already there. Returns false where
   * the browser has no speech recognition (e.g. the Quest Browser: use the system keyboard's mic).
   */
  toggleDictation() {
    if (!SpeechRecognition) return false;
    if (recognition) {
      recognition.stop(); // onend tidies up
      return true;
    }
    const rec = new SpeechRecognition();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    const before = state.prompt && !/\s$/.test(state.prompt) ? `${state.prompt} ` : state.prompt;
    rec.onresult = (e) => {
      let heard = '';
      for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript;
      this.setPrompt(before + heard.trimStart());
    };
    rec.onerror = (e) => console.warn(`Dictation: ${e.error}`);
    rec.onend = () => {
      if (recognition === rec) recognition = null;
      state.listening = false;
      changed();
    };
    recognition = rec;
    state.listening = true;
    changed();
    try {
      rec.start();
    } catch (e) {
      console.warn(`Dictation: ${e.message}`);
      recognition = null;
      state.listening = false;
      changed();
    }
    return true;
  },

  /** Stops dictating and reading aloud (e.g. the panel closed). */
  stopDictation() {
    recognition?.abort();
    if (state.speaking) synth?.cancel();
  },

  /** The response feed's text (for now just the placeholder: nothing is connected yet). */
  responseText() {
    return RESPONSE_PLACEHOLDER;
  },

  /** Reads the response feed aloud, or stops reading it. Returns false where there is no speech synthesis. */
  toggleSpeech() {
    if (!synth) return false;
    if (state.speaking) {
      synth.cancel(); // onend tidies up
      return true;
    }
    const u = new SpeechSynthesisUtterance(this.responseText());
    u.lang = navigator.language || 'en-US';
    u.onend = u.onerror = () => {
      state.speaking = false;
      changed();
    };
    synth.cancel(); // anything left queued
    state.speaking = true;
    changed();
    synth.speak(u);
    return true;
  },

  /**
   * XR: focuses the hidden text field, which brings up the headset's system keyboard (with its own
   * dictation mic) over the immersive view. Call from a controller trigger (it needs user input).
   */
  openKeyboard() {
    const field = xrField();
    if (!field) return false;
    field.value = state.prompt;
    field.focus();
    return true;
  },
};
