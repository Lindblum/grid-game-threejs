// Pause-menu model shared by the DOM menu (desktop) and the canvas panel (XR).

export const PAGE_SIZE = 5;

export function formatDate(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Returns { title, items: [{ id, label, sub?, disabled?, accent? }] } for the current menu screen. */
export function menuModel(state) {
  const { menu, saves, savesError, page } = state;
  if (menu === 'main') {
    return {
      title: 'Paused',
      items: [
        { id: 'resume', label: 'Resume', accent: true },
        { id: 'new', label: 'New' },
        { id: 'load', label: 'Load' },
        { id: 'save', label: 'Save' },
        { id: 'quit', label: 'Quit' },
      ],
    };
  }

  const items = [];
  if (menu === 'save') items.push({ id: 'savenew', label: '+ New save file', accent: true });

  if (savesError) {
    items.push({ id: 'noop', label: 'Saves folder unavailable', sub: savesError, disabled: true });
  } else if (!saves) {
    items.push({ id: 'noop', label: 'Loading…', disabled: true });
  } else if (!saves.length) {
    items.push({ id: 'noop', label: menu === 'load' ? 'No save files yet' : 'No existing files', disabled: true });
  } else {
    const pages = Math.max(1, Math.ceil(saves.length / PAGE_SIZE));
    const p = Math.min(page, pages - 1);
    for (const f of saves.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE)) {
      items.push({
        id: `${menu}:${f.name}`,
        label: menu === 'save' ? `Overwrite ${f.name}` : f.name,
        sub: formatDate(f.modified),
      });
    }
    if (pages > 1) {
      items.push({ id: 'prev', label: `◀ Previous  (${p + 1}/${pages})`, disabled: p === 0 });
      items.push({ id: 'next', label: 'Next ▶', disabled: p >= pages - 1 });
    }
  }
  items.push({ id: 'back', label: 'Back' });
  return { title: menu === 'save' ? 'Save' : 'Load', items };
}
