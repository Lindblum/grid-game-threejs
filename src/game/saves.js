// Client for the saves API served by vite.config.js (files live in ./saves).

export async function listSaves() {
  const r = await fetch('/api/saves');
  if (!r.ok) throw new Error(`Could not list saves (${r.status})`);
  const data = await r.json();
  if (!Array.isArray(data)) throw new Error('Saves server not available');
  return data;
}

export async function readSave(name) {
  const r = await fetch(`/api/saves/${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`Could not load ${name} (${r.status})`);
  return r.json();
}

export async function writeSave(name, data) {
  const r = await fetch(`/api/saves/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data, null, 2),
  });
  if (!r.ok) throw new Error(`Could not save ${name} (${r.status})`);
  return r.json();
}

/** "My Castle" -> "My Castle.json"; strips characters the server rejects. */
export function normalizeSaveName(raw) {
  let s = String(raw || '').trim().replace(/\.json$/i, '');
  s = s.replace(/[^\w\-. ]+/g, '_').replace(/\.+/g, '.').slice(0, 70);
  if (!s || s === '.') return null;
  return `${s}.json`;
}

export function timestampName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `save-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}
