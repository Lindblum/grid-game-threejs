import { CONTROL_SCHEMAS } from './controls.js';
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

/**
 * Options → Speed: a multiplier from 1x to 4x in steps of 0.25. 1x is `turnsPerMinute` (60) turns a minute,
 * so a turn lasts 60 / (turnsPerMinute * speed) seconds.
 */
/** Options → Speed: a multiplier, 0x (the simulation stands still) to 4x in steps of 0.25x; 1x is 60 turns a minute. */
export const SPEED = Object.freeze({ min: 0, max: 4, step: 0.25, default: 1, turnsPerMinute: 60 });

/** Options → Background, in the order the option cycles through them (passthrough last). */
export const BACKGROUNDS = ['solid', 'skybox', 'passthrough'];
const BACKGROUND_LABELS = { solid: 'Solid', skybox: 'Skybox', passthrough: 'Passthrough (XR Only)' };
const BACKGROUND_ICONS = { solid: 'bgSolid', skybox: 'bgSky', passthrough: 'bgPass' };

/** Options → Video → XR: enter / exit XR, or greyed out when the browser has no XR. */
function xrItem(state) {
  if (state.inXR) return { id: 'exitxr', label: 'XR: On', icon: 'xr' };
  if (state.xrSupport) return { id: 'enterxr', label: 'XR: Off', icon: 'xr' };
  return { id: 'noop', label: 'XR: Unavailable', icon: 'xr', disabled: true };
}

/** Options → Video → Background: a solid colour, the sky panorama, or passthrough (see-through in XR). */
function background(state) {
  return {
    id: 'background',
    label: `Background: ${BACKGROUND_LABELS[state.background] ?? 'Solid'}`,
    icon: BACKGROUND_ICONS[state.background] ?? 'bgSolid',
    toggle: true,
  };
}

const BACK = { id: 'back', label: 'Back', icon: 'back' };



/**
 * Returns { title, table?, items: [{ id, label, icon, sub?, disabled?, accent?, slider?, submenu?, toggle? }] } for the current
 * menu screen. `submenu`: the button opens another menu screen (drawn with a right arrow at its far right).
 * `toggle`: the button switches a setting (On / Off, or the next choice); Right on the keyboard presses it too.
 * Every submenu lists Back first; renderers draw it at the very top of the panel
 * (above the Controls table / save-name row).
 */
export function menuModel(state) {
  const { menu, saves, savesError, page } = state;
  if (menu === 'controls') {
    // the table of the control schema in use (Observer, or Creature: see controls.js)
    const schema = CONTROL_SCHEMAS[state.controlSchema] ?? CONTROL_SCHEMAS.observer;
    return { title: `Controls: ${schema.name}`, table: schema.id, items: [BACK] };
  }
  if (menu === 'video') {
    // graphics / performance settings, a submenu of Options
    return {
      title: 'Video',
      items: [
        BACK,
        xrItem(state),
        background(state),
        {
          id: 'materials',
          label: `Materials: ${state.proceduralMaterials ? 'Procedural' : 'Solid'}`,
          icon: state.proceduralMaterials ? 'matProcedural' : 'matSolid',
          toggle: true,
        },
        {
          id: 'rendering',
          label: `Rendering: ${state.smoothRendering ? 'Smooth' : 'Blocky'}`,
          icon: state.smoothRendering ? 'renderSmooth' : 'renderBlocky',
          toggle: true,
        },
        { id: 'outlines', label: `Outlines: ${state.outlines ? 'On' : 'Off'}`, icon: state.outlines ? 'outlinesOn' : 'outlinesOff', toggle: true },
        { id: 'ao', label: `Ambient Occlusion: ${state.ambientOcclusion ? 'On' : 'Off'}`, icon: state.ambientOcclusion ? 'aoOn' : 'aoOff', toggle: true },
        { id: 'refraction', label: `Refraction: ${state.refraction ? 'On' : 'Off'}`, icon: state.refraction ? 'refractionOn' : 'refractionOff', toggle: true },
        { id: 'fog', label: `Fog: ${state.fog ? 'On' : 'Off'}`, icon: state.fog ? 'fogOn' : 'fogOff', toggle: true },
      ],
    };
  }
  if (menu === 'options') {
    return {
      title: 'Options',
      items: [
        BACK,
        { id: 'controls', label: 'Controls', icon: 'controls', submenu: true },
        { id: 'video', label: 'Video', icon: 'video', submenu: true },
        { id: 'music', label: `Music: ${state.musicOn ? 'On' : 'Off'}`, icon: state.musicOn ? 'musicOn' : 'musicOff', toggle: true },
        { id: 'sound', label: `Sounds: ${state.soundOn ? 'On' : 'Off'}`, icon: state.soundOn ? 'soundOn' : 'soundOff', toggle: true },
        {
          id: 'speed',
          label: `Speed: ${state.speed}x${state.speed === 0 ? ' (stopped)' : ''}`,
          icon: 'speed',
          slider: { min: SPEED.min, max: SPEED.max, step: SPEED.step, value: state.speed }, // drawn as a slider, not a button
        },
        { id: 'rain', label: `Rain: ${state.rain ? 'On' : 'Off'}`, icon: state.rain ? 'rainOn' : 'rainOff', toggle: true },
        { id: 'debug', label: `Debug: ${state.debugMode ? 'On' : 'Off'}`, icon: 'debug', toggle: true },
      ],
    };
  }
  if (menu === 'main') {
    return {
      title: GAME_TITLE,
      items: [
        { id: 'resume', label: 'Resume', icon: 'resume', accent: true },
        { id: 'new', label: 'New', icon: 'new' },
        { id: 'load', label: 'Load', icon: 'load', submenu: true },
        { id: 'save', label: 'Save', icon: 'save', submenu: true },
        { id: 'options', label: 'Options', icon: 'options', submenu: true },
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
