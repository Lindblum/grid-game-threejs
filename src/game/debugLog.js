// Debug log: keeps the most recent console output (and uncaught errors) so the debug panel
// (DOM HUD in the browser, tablet in XR) can show it. Messages still reach the real console.

const MAX_ENTRIES = 2000;
const entries = []; // { t: 'HH:MM:SS', level: 'log' | 'info' | 'warn' | 'error', text }
let version = 0; // bumps on every new entry, so panels can tell when to redraw

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function format(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    const s = JSON.stringify(arg);
    return s === undefined ? String(arg) : s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return String(arg);
  }
}

export function addLog(level, args) {
  // console format strings (%c etc.) would show raw; drop the styling arguments
  const parts = [...args];
  if (typeof parts[0] === 'string' && parts[0].includes('%c')) {
    const n = (parts[0].match(/%c/g) || []).length;
    parts[0] = parts[0].replace(/%c/g, '');
    parts.splice(1, n);
  }
  entries.push({ t: stamp(), level, text: parts.map(format).join(' ') });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  version++;
}

/** Most recent entries, oldest first. */
export function getLogs(limit = MAX_ENTRIES) {
  return entries.slice(-limit);
}

export function getLogVersion() {
  return version;
}

let installed = false;
/** Starts capturing console.log / info / warn / error and uncaught errors (once). */
export function installDebugLog() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      addLog(level, args);
      original(...args);
    };
  }
  window.addEventListener('error', (e) => addLog('error', [e.message || 'Uncaught error']));
  window.addEventListener('unhandledrejection', (e) => addLog('error', ['Unhandled promise rejection:', e.reason]));
}
