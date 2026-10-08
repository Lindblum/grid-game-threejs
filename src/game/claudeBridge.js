// Debug → Claude: the client side of the dev server's Claude bridge (claude-bridge.js), shared
// by the browser's Debug dock and the XR debug tablet. Holds the prompt being written, the
// responses so far, the bridge token, voice dictation, and the hidden text field that brings
// up the headset's system keyboard in XR.
//
// Only in development (`npm run dev` / `dev:xr`): the bridge isn't part of a build.

const TOKEN_KEY = 'claudeBridgeToken';
const PROMPT_KEY = 'claudeBridgePrompt';
const SESSION_KEY = 'claudeBridgeSession';
const BRIDGE = `${import.meta.env.BASE_URL}__claude/`;

const stored = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key, value) => {
  try {
    if (value == null || value === '') localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
};

// a link printed by the dev server (?claudeToken=…) stores the token in this browser
try {
  const url = new URL(location.href);
  const t = url.searchParams.get('claudeToken');
  if (t) {
    store(TOKEN_KEY, t);
    url.searchParams.delete('claudeToken');
    history.replaceState(null, '', url);
  }
} catch {}

const SpeechRecognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

/**
 * Everything the Claude panels show. `log`: [{ kind, text }], kind 'prompt' (what you asked),
 * 'text' (Claude's reply), 'tool' (a file it read or edited), 'done', 'error'.
 */
const state = {
  available: !!import.meta.env.DEV,
  prompt: stored(PROMPT_KEY) ?? '',
  log: [],
  running: false,
  listening: false, // dictating
  micSupported: !!SpeechRecognition,
  hasToken: !!stored(TOKEN_KEY),
  needsToken: false, // the bridge refused the token (or there is none)
  sessionId: stored(SESSION_KEY),
  version: 0, // bumped on every change (redraws)
};
const listeners = new Set();
const changed = () => {
  state.version++;
  for (const fn of listeners) fn();
};

export const claude = {
  state,
  /** Calls `fn` on every change; returns the unsubscribe. */
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  setPrompt(text) {
    state.prompt = text;
    store(PROMPT_KEY, text);
    const field = xrField();
    if (field && field.value !== text) field.value = text;
    changed();
  },

  setToken(token) {
    store(TOKEN_KEY, token.trim());
    state.hasToken = !!token.trim();
    state.needsToken = false;
    changed();
    attach();
  },

  /** Sends the prompt (carrying on the conversation, unless it was started afresh). */
  async submit() {
    const prompt = state.prompt.trim();
    if (!prompt || state.running || !state.available) return false;
    this.setPrompt('');
    await request('run', { prompt, sessionId: state.sessionId });
    return true;
  },

  /** Stops Claude mid-request. */
  stop() {
    return request('stop', {}, false);
  },

  /** Forgets the conversation: the next prompt starts a new one. */
  newConversation() {
    state.sessionId = null;
    store(SESSION_KEY, null);
    state.log = [];
    changed();
  },

  /**
   * Voice: starts / stops dictating into the prompt (the browser's speech recognition).
   * Returns false where there is none (e.g. the Quest Browser: use the system keyboard's mic).
   */
  toggleDictation() {
    if (!SpeechRecognition) return false;
    if (recognition) {
      recognition.stop();
      return true;
    }
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    const before = state.prompt ? state.prompt.replace(/\s*$/, ' ') : '';
    recognition.onresult = (e) => {
      let heard = '';
      for (let i = 0; i < e.results.length; i++) heard += e.results[i][0].transcript;
      this.setPrompt(before + heard.trim());
    };
    recognition.onend = recognition.onerror = () => {
      recognition = null;
      state.listening = false;
      changed();
    };
    recognition.start();
    state.listening = true;
    changed();
    return true;
  },

  /**
   * XR: focuses the hidden text field, which brings up the headset's system keyboard (with
   * its own dictation mic) over the immersive view. Call from a controller trigger (user input).
   */
  openKeyboard() {
    const field = xrField();
    if (!field) return false;
    field.value = state.prompt;
    field.focus();
    return true;
  },

  /** The responses as one text, for the read-only response boxes. */
  responseText() {
    return state.log.map(({ kind, text }) => (kind === 'prompt' ? `› ${text}` : kind === 'tool' ? `  ▸ ${text}` : text)).join('\n\n');
  },
};

let recognition = null;

/** The hidden <textarea> the XR keyboard types into (rendered by App). */
function xrField() {
  return typeof document !== 'undefined' ? document.getElementById('claude-xr-input') : null;
}

// ---------------------------------------------------------------- talking to the bridge

/** One line of the bridge's stream (Claude Code's stream-json, plus the bridge's own). */
function onEvent(e) {
  if (e.type === 'prompt') {
    state.log.push({ kind: 'prompt', text: e.text });
    state.running = true;
  } else if (e.type === 'system' && e.subtype === 'init' && e.session_id) {
    state.sessionId = e.session_id;
    store(SESSION_KEY, e.session_id);
  } else if (e.type === 'assistant') {
    for (const c of e.message?.content ?? []) {
      if (c.type === 'text' && c.text.trim()) state.log.push({ kind: 'text', text: c.text.trim() });
      if (c.type === 'tool_use') {
        const target = c.input?.file_path ?? c.input?.path ?? c.input?.pattern ?? '';
        const short = String(target).replace(/\\/g, '/').replace(/^.*?\/grid-game-threejs\//, '');
        state.log.push({ kind: 'tool', text: `${c.name}${short ? ` ${short}` : ''}` });
      }
    }
  } else if (e.type === 'user') {
    for (const c of e.message?.content ?? []) {
      if (c.type === 'tool_result' && c.is_error) {
        const msg = Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join(' ') : String(c.content ?? '');
        state.log.push({ kind: 'tool', text: `✗ ${msg.split('\n')[0].slice(0, 160)}` });
      }
    }
  } else if (e.type === 'result') {
    const secs = e.duration_ms != null ? `${(e.duration_ms / 1000).toFixed(0)} s` : '';
    const cost = e.total_cost_usd != null ? `, $${e.total_cost_usd.toFixed(3)}` : '';
    state.log.push({ kind: 'done', text: `— ${e.is_error ? 'stopped with an error' : 'done'}${secs ? ` (${secs}${cost})` : ''}` });
  } else if (e.type === 'stderr') {
    const text = String(e.text ?? '').trim();
    if (text) state.log.push({ kind: 'error', text });
  } else if (e.type === 'exit') {
    state.running = false;
    if (e.code && e.code !== 0 && state.log.at(-1)?.kind !== 'done') state.log.push({ kind: 'error', text: `— Claude exited (${e.code})` });
  }
  changed();
}

/** POSTs to the bridge; streamed replies are fed to onEvent line by line. */
async function request(endpoint, body, streamed = true) {
  const token = stored(TOKEN_KEY);
  if (!token) {
    state.needsToken = true;
    changed();
    return;
  }
  let res;
  try {
    res = await fetch(BRIDGE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-claude-token': token },
      body: JSON.stringify(body),
    });
  } catch (e) {
    state.log.push({ kind: 'error', text: `Can't reach the Claude bridge (is the dev server running?): ${e.message}` });
    changed();
    return;
  }
  if (res.status === 401) {
    state.needsToken = true;
    state.hasToken = false;
    changed();
    return;
  }
  if (res.status === 204 || !streamed) return;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    state.log.push({ kind: 'error', text: err.error ?? `Bridge error ${res.status}` });
    changed();
    return;
  }
  // a fresh stream replays the run from its start
  if (endpoint === 'attach') state.log = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, i).trim();
      buffered = buffered.slice(i + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {}
    }
  }
}

/** Catches up with the bridge's current / last run (e.g. after Claude's edits reloaded the page). */
function attach() {
  if (state.available && stored(TOKEN_KEY)) request('attach', {});
}
if (state.available) attach();
