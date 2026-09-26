// Start/pause-menu model shared by the DOM menu (desktop) and the canvas panel (XR).

export const PAGE_SIZE = 5;

export function formatDate(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** "My Castle.json" -> "My Castle" */
export function displayName(fileName) {
  return fileName.replace(/\.json$/i, '');
}

export const GAME_TITLE = 'Grid Game';

/** Options → Background: passthrough (see-through in XR) or a solid colour. */
function background(state) {
  const on = state.passthrough;
  return {
    id: 'background',
    label: `Background: ${on ? 'Passthrough' : 'Solid'}`,
    sub: state.inXR ? undefined : 'applies in XR',
    icon: on ? 'bgPass' : 'bgSolid',
  };
}

/** Returns { title, table?, items: [{ id, label, icon, sub?, disabled?, accent? }] } for the current menu screen. */
export function menuModel(state) {
  const { menu, saves, savesError, page } = state;
  if (menu === 'controls') {
    return { title: 'Controls', table: true, items: [{ id: 'back', label: 'Back', icon: 'back' }] };
  }
  if (menu === 'options') {
    const xr = state.inXR
      ? { id: 'exitxr', label: 'Exit XR', icon: 'xr' }
      : state.xrSupport
        ? { id: 'enterxr', label: 'Enter XR', icon: 'xr' }
        : { id: 'noop', label: 'XR not available here', icon: 'xr', disabled: true };
    return {
      title: 'Options',
      items: [
        { id: 'sound', label: `Sound: ${state.soundOn ? 'On' : 'Off'}`, icon: state.soundOn ? 'soundOn' : 'soundOff' },
        background(state),
        xr,
        { id: 'controls', label: 'Controls', icon: 'controls' },
        { id: 'back', label: 'Back', icon: 'back' },
      ],
    };
  }
  if (menu === 'main') {
    return {
      title: GAME_TITLE,
      items: [
        { id: 'resume', label: 'Resume', icon: 'resume', accent: true },
        { id: 'new', label: 'New', icon: 'new' },
        { id: 'load', label: 'Load', icon: 'load' },
        { id: 'save', label: 'Save', icon: 'save' },
        { id: 'options', label: 'Options', icon: 'options' },
        { id: 'quit', label: 'Quit', icon: 'quit' },
      ],
    };
  }

  const items = [];
  if (menu === 'save') items.push({ id: 'savenew', label: 'New save file', icon: 'savenew', accent: true });

  if (savesError) {
    items.push({ id: 'noop', label: 'Saves folder unavailable', sub: savesError, icon: 'info', disabled: true });
  } else if (!saves) {
    items.push({ id: 'noop', label: 'Loading…', icon: 'info', disabled: true });
  } else if (!saves.length) {
    items.push({ id: 'noop', label: menu === 'load' ? 'No save files yet' : 'No existing files', icon: 'info', disabled: true });
  } else {
    const pages = Math.max(1, Math.ceil(saves.length / PAGE_SIZE));
    const p = Math.min(page, pages - 1);
    for (const f of saves.slice(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE)) {
      items.push({
        id: `${menu}:${f.name}`,
        label: menu === 'save' ? `Overwrite ${displayName(f.name)}` : displayName(f.name),
        sub: formatDate(f.modified),
        icon: menu === 'save' ? 'save' : 'file',
      });
    }
    if (pages > 1) {
      items.push({ id: 'prev', label: `Previous  (${p + 1}/${pages})`, icon: 'prev', disabled: p === 0 });
      items.push({ id: 'next', label: 'Next', icon: 'next', disabled: p >= pages - 1 });
    }
  }
  items.push({ id: 'back', label: 'Back', icon: 'back' });
  return { title: menu === 'save' ? 'Save' : 'Load', items };
}
