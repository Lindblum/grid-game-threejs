// The Debug panel's sections, top to bottom, and which are collapsed: shared by the browser's
// Debug dock and the XR debug tablet, and remembered in this browser. `panel` is the whole panel
// (its Debug button): collapsed, only the button shows.

export const DEBUG_SECTIONS = ['performance', 'inspector', 'docking', 'logging'];
const START_COLLAPSED = new Set(['docking']); // (until opened once)

const key = (id) => `debugCollapsed.${id}`;
const read = (id) => {
  try {
    const v = localStorage.getItem(key(id));
    return v == null ? START_COLLAPSED.has(id) : v === '1';
  } catch {
    return false;
  }
};

let collapsed = Object.freeze(Object.fromEntries([...DEBUG_SECTIONS, 'panel'].map((id) => [id, read(id)])));
const listeners = new Set();

export const debugSections = {
  /** { performance: bool, … }: a new object after every change (useSyncExternalStore). */
  getSnapshot: () => collapsed,
  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  toggle(id) {
    collapsed = Object.freeze({ ...collapsed, [id]: !collapsed[id] });
    try {
      localStorage.setItem(key(id), collapsed[id] ? '1' : '0');
    } catch {}
    for (const fn of listeners) fn();
  },
};
