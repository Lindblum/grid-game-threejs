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

/** Options → Speed: turns per minute, in steps of 12. A turn lasts 60 / speed seconds. */
export const SPEED = Object.freeze({ min: 12, max: 240, step: 12, default: 60 });

/** Options → Background: passthrough (see-through in XR) or a solid colour. */
function background(state) {
  const on = state.passthrough;
  return {
    id: 'background',
    label: `Background: ${on ? 'Passthrough (XR Only)' : 'Solid'}`,
    icon: on ? 'bgPass' : 'bgSolid',
  };
}

const BACK = { id: 'back', label: 'Back', icon: 'back' };

/**
 * Returns { title, table?, items: [{ id, label, icon, sub?, disabled?, accent?, slider? }] } for the current
 * menu screen. Every submenu lists Back first; renderers draw it at the very top of the panel
 * (above the Controls table / save-name row).
 */
export function menuModel(state) {
  const { menu, saves, savesError, page } = state;
  if (menu === 'controls') {
    return { title: 'Controls', table: true, items: [BACK] };
  }
  if (menu === 'options') {
    const xr = state.inXR
      ? { id: 'exitxr', label: 'XR: On', icon: 'xr' }
      : state.xrSupport
        ? { id: 'enterxr', label: 'XR: Off', icon: 'xr' }
        : { id: 'noop', label: 'XR: Unavailable', icon: 'xr', disabled: true };
    return {
      title: 'Options',
      items: [
        BACK,
        { id: 'controls', label: 'Controls', icon: 'controls' },
        { id: 'sound', label: `Sound: ${state.soundOn ? 'On' : 'Off'}`, icon: state.soundOn ? 'soundOn' : 'soundOff' },
        background(state),
        {
          id: 'materials',
          label: `Materials: ${state.proceduralMaterials ? 'Procedural' : 'Solid'}`,
          icon: state.proceduralMaterials ? 'matProcedural' : 'matSolid',
        },
        { id: 'outlines', label: `Outlines: ${state.outlines ? 'On' : 'Off'}`, icon: state.outlines ? 'outlinesOn' : 'outlinesOff' },
        { id: 'ao', label: `Ambient Occlusion: ${state.ambientOcclusion ? 'On' : 'Off'}`, icon: state.ambientOcclusion ? 'aoOn' : 'aoOff' },
        xr,
        {
          id: 'speed',
          label: `Speed: ${state.speed} turns/min`,
          icon: 'speed',
          slider: { min: SPEED.min, max: SPEED.max, step: SPEED.step, value: state.speed }, // drawn as a slider, not a button
        },
        { id: 'rain', label: `Rain: ${state.rain ? 'On' : 'Off'}`, icon: state.rain ? 'rainOn' : 'rainOff' },
        { id: 'debug', label: `Debug: ${state.debugMode ? 'On' : 'Off'}`, icon: 'debug' },
        // developer options: only offered while Debug is on
        ...(state.debugMode
          ? [{ id: 'bevel', label: `Bevel (Experimental): ${state.bevel ? 'On' : 'Off'}`, icon: 'bevel' }]
          : []),
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
      ],
    };
  }

  const items = [BACK];
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
        label: displayName(f.name),
        sub: formatDate(f.modified),
        icon: menu === 'save' ? 'save' : 'file',
      });
    }
    if (pages > 1) {
      items.push({ id: 'prev', label: `Previous  (${p + 1}/${pages})`, icon: 'prev', disabled: p === 0 });
      items.push({ id: 'next', label: 'Next', icon: 'next', disabled: p >= pages - 1 });
    }
  }
  return { title: menu === 'save' ? 'Save' : 'Load', items };
}
