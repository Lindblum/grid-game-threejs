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
export const SPEED = Object.freeze({ min: 0, max: 240, step: 12, default: 60 });

/** Options → Background, in the order the option cycles through them (passthrough last). */
export const BACKGROUNDS = ['solid', 'skybox', 'passthrough'];
const BACKGROUND_LABELS = { solid: 'Solid', skybox: 'Skybox', passthrough: 'Passthrough (XR Only)' };
const BACKGROUND_ICONS = { solid: 'bgSolid', skybox: 'bgSky', passthrough: 'bgPass' };

/** Options → Background: a solid colour, the sky panorama, or passthrough (see-through in XR). */
function background(state) {
  return {
    id: 'background',
    label: `Background: ${BACKGROUND_LABELS[state.background] ?? 'Solid'}`,
    icon: BACKGROUND_ICONS[state.background] ?? 'bgSolid',
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
        {
          id: 'speed',
          label: `Speed: ${state.speed} turns/min`,
          icon: 'speed',
          slider: { min: SPEED.min, max: SPEED.max, step: SPEED.step, value: state.speed }, // drawn as a slider, not a button
        },
        xr,
        background(state),
        {
          id: 'materials',
          label: `Materials: ${state.proceduralMaterials ? 'Procedural' : 'Solid'}`,
          icon: state.proceduralMaterials ? 'matProcedural' : 'matSolid',
        },
        {
          id: 'rendering',
          label: `Rendering: ${state.smoothRendering ? 'Smooth' : 'Blocky'}`,
          icon: state.smoothRendering ? 'renderSmooth' : 'renderBlocky',
        },
        { id: 'outlines', label: `Outlines: ${state.outlines ? 'On' : 'Off'}`, icon: state.outlines ? 'outlinesOn' : 'outlinesOff' },
        { id: 'ao', label: `Ambient Occlusion: ${state.ambientOcclusion ? 'On' : 'Off'}`, icon: state.ambientOcclusion ? 'aoOn' : 'aoOff' },
        { id: 'rain', label: `Rain: ${state.rain ? 'On' : 'Off'}`, icon: state.rain ? 'rainOn' : 'rainOff' },
        { id: 'fog', label: `Fog: ${state.fog ? 'On' : 'Off'}`, icon: state.fog ? 'fogOn' : 'fogOff' },
        { id: 'debug', label: `Debug: ${state.debugMode ? 'On' : 'Off'}`, icon: 'debug' },
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
