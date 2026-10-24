import { CONTROL_SCHEMAS } from './controls.js';
import { GRIDS, GRID_IDS } from './grids.js';
import { MATERIALS } from './geometry.js';
// The Options menu model, shared by the DOM panel (top-left, under its gear button) and the
// canvas panel (XR, docked to the left controller). Opening it pauses the game.
// Screens (state.menu): 'main' (Options), and File's 'load' and 'save'.

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

/** Options → Accessibility → Text Size: a multiplier on the page UI's text, 75% to 200% in steps of 25%. */
export const TEXT_SIZE = Object.freeze({ min: 0.75, max: 2, step: 0.25, default: 1 });
/** Options → Video → XR Resolution: the headset's framebuffer scale (1 = the browser's recommended size; pixels drawn go with its square). */
export const XR_RESOLUTION = Object.freeze({ min: 0.5, max: 1, step: 0.05, default: 1 });

/** Options → Accessibility → Music and Sounds: a volume, 0% (off) to 100% in steps of 10%. */
export const VOLUME = Object.freeze({ min: 0, max: 1, step: 0.1, default: 1 });

/** Options → Accessibility → Camera Speed: a multiplier on how fast the camera turns (mouse and stick), 10% to 150%. */
export const CAMERA_SPEED = Object.freeze({ min: 0.1, max: 1.5, step: 0.1, default: 1 });
/** Options → Accessibility → Vibration: how strong the controllers' haptics are, 0 (off) to 2 (1: as made). */
export const VIBRATION = Object.freeze({ min: 0, max: 2, step: 0.1, default: 1 }); // (above 100%: every buzz stronger, up to the controller's most)

/** Options → Background, in the order its dropdown lists them (passthrough last). */
export const BACKGROUNDS = ['solid', 'skybox', 'passthrough'];
const BACKGROUND_LABELS = { solid: 'Solid', skybox: 'Skybox', passthrough: 'Passthrough (XR Only)' };
const BACKGROUND_ICONS = { solid: 'bgSolid', skybox: 'bgSky', passthrough: 'bgPass' };

/**
 * Options → Video → View Mode, in dropdown order (from 4d-viewer-threejs). Normal, 3D: SBS
 * (half side-by-side, for 3D TVs) and 3D: Interlaced (row-interleaved, for passive 3D monitors)
 * are windowed; the rest are XR sessions. Phones get the phone views, headsets and PCs with a
 * headset the HMD one.
 */
export const VIEWS = ['normal', 'sbs', 'interlaced', 'hmd', 'phoneAR', 'phoneViewer'];
export const XR_VIEWS = ['hmd', 'phoneAR', 'phoneViewer'];
const VIEW_LABELS = {
  normal: 'Normal',
  sbs: '3D: SBS',
  interlaced: '3D: Interlaced',
  hmd: 'XR: HMD Stereo',
  phoneAR: 'XR: Phone AR',
  phoneViewer: 'XR: Phone Viewer',
};
const VIEW_ICONS = { normal: 'monitor', sbs: 'monitorSbs', interlaced: 'monitorInterlaced', hmd: 'xr', phoneAR: 'phone', phoneViewer: 'phoneViewer' };

/**
 * The views this device can show. `env`: { phone, headset, xrSupported }.
 * A headset browser's own window can't show the 3D views usefully, so not there.
 */
export function availableViews(env) {
  return VIEWS.filter((view) => {
    if (view === 'sbs' || view === 'interlaced') return !env.headset;
    if (view === 'hmd') return !env.phone && env.xrSupported;
    if (view === 'phoneAR' || view === 'phoneViewer') return env.phone;
    return true;
  });
}

/** The view showing now: derived from the session, so the menu can never disagree with it. */
export function currentView(state) {
  if (!state.inXR) return state.screenView;
  return state.phone ? (state.phoneStereo ? 'phoneViewer' : 'phoneAR') : 'hmd';
}

/**
 * A label's setting name and its value, split at the first ": ". The menus draw the name on the
 * left and the value against the right edge.
 */
export function splitLabel(label) {
  const at = label.indexOf(': ');
  return at < 0 ? { name: label, value: '' } : { name: label.slice(0, at + 1), value: label.slice(at + 2) };
}

export const PICK_PREFIX = 'pick:';

/**
 * A dropdown: the button shows the current choice and, when it is the open one
 * (`state.dropdown`), lists every choice beneath it (from xr-music-threejs). Choosing
 * one sends "pick:<id>:<choice>". `unavailable(choice)`: why that choice can't be picked
 * here, if it can't (it is listed disabled, the reason as its tooltip).
 */
function dropdown(state, id, choices, current, labels, icons, unavailable = () => null) {
  return {
    open: state.dropdown === id,
    options: choices.map((choice) => {
      const reason = unavailable(choice);
      return {
        id: `${PICK_PREFIX}${id}:${choice}`,
        label: labels[choice],
        icon: icons[choice],
        selected: choice === current,
        ...(reason && { disabled: true, title: reason }),
      };
    }),
  };
}

/** "pick:<id>:<choice>" -> { id, choice }, else null. */
export function parsePick(id) {
  if (!id.startsWith(PICK_PREFIX)) return null;
  const [dropdownId, choice] = id.slice(PICK_PREFIX.length).split(':');
  return { id: dropdownId, choice };
}

/** Whether dropdown choice `id` ("pick:…") is listed disabled in `model` (open or not). */
export function isDisabledChoice(model, id) {
  const all = (items) => items.flatMap((it) => [...(it.dropdown?.options ?? []), ...all(it.section?.items ?? [])]);
  return all(model.items).some((o) => o.id === id && o.disabled);
}

/**
 * The menu's focusable entries in order: its enabled items, each followed by its open
 * dropdown's choices or its open section's entries (for keyboard and gamepad navigation).
 */
export function focusables(model) {
  return focusableItems(model.items);
}

function focusableItems(items) {
  return items.flatMap((it) =>
    it.disabled
      ? []
      : [it, ...(it.dropdown?.open ? it.dropdown.options.filter((o) => !o.disabled) : []), ...(it.section?.open ? focusableItems(it.section.items) : [])],
  );
}

/** The id of the open section that `id` is (the button of, or) inside, else null. */
export function sectionOf(model, id) {
  const open = model.items.find((it) => it.section?.open);
  if (!open) return null;
  return open.id === id || focusableItems(open.section.items).some((it) => it.id === id) ? open.id : null;
}

/** Why this device can't show `view` (see availableViews). */
function viewUnavailableReason(view, state) {
  if (view === 'sbs' || view === 'interlaced') return 'A headset’s browser can’t show the 3D views';
  if (view === 'phoneAR' || view === 'phoneViewer') return 'Needs a phone';
  if (state.phone) return 'Needs a headset';
  return 'WebXR isn’t available here. Open the game in a headset browser over HTTPS for XR.';
}

/** Options → Video → View Mode: a dropdown of every view, the ones this device can't show disabled. */
function viewItem(state) {
  const view = currentView(state);
  const views = state.views ?? [view];
  return {
    id: 'view',
    label: `View Mode: ${VIEW_LABELS[view]}`,
    icon: VIEW_ICONS[view],
    dropdown: dropdown(state, 'view', VIEWS, view, VIEW_LABELS, VIEW_ICONS, (v) => (views.includes(v) ? null : viewUnavailableReason(v, state))),
  };
}

/**
 * Options → Video → Background: a solid colour, the sky panorama, or passthrough (see-through in XR),
 * which needs a browser with AR sessions (Quest Browser) or a phone (its camera).
 */
function background(state) {
  const current = BACKGROUNDS.includes(state.background) ? state.background : 'solid';
  const passthrough = state.xrAR || state.phone;
  return {
    id: 'background',
    label: `Background: ${BACKGROUND_LABELS[current]}`,
    icon: BACKGROUND_ICONS[current],
    dropdown: dropdown(state, 'background', BACKGROUNDS, current, BACKGROUND_LABELS, BACKGROUND_ICONS, (b) =>
      b === 'passthrough' && !passthrough ? 'Passthrough needs an XR headset or a phone camera' : null,
    ),
  };
}

const BACK = { id: 'back', label: 'Back', icon: 'back' };

const GRID_LABELS = Object.fromEntries(GRID_IDS.map((id) => [id, GRIDS[id].name]));
const GRID_ICONS = { to: 'gridTo', rd: 'gridRd', cube: 'gridCube' };

/** Options → File → New: a dropdown of the grid modes (grids.js); picking one starts a new world in it. */
function newItem(state) {
  return { id: 'new', label: 'New', icon: 'new', dropdown: dropdown(state, 'new', GRID_IDS, state.gridMode, GRID_LABELS, GRID_ICONS) };
}

const MATERIAL_LABELS = { solid: 'Solid', simple: 'Simple', procedural: 'Procedural' };
const MATERIAL_ICONS = { solid: 'matSolid', simple: 'matSimple', procedural: 'matProcedural' };

/** Options → Video → Materials: how detailed the block surfaces are, from cheapest to richest (geometry.js MATERIALS). */
function materialsItem(state) {
  const current = MATERIALS.includes(state.materials) ? state.materials : 'procedural';
  return {
    id: 'materials',
    label: `Materials: ${MATERIAL_LABELS[current]}`,
    icon: MATERIAL_ICONS[current],
    dropdown: dropdown(state, 'materials', MATERIALS, current, MATERIAL_LABELS, MATERIAL_ICONS),
  };
}

/** Options → Video: graphics / performance settings. */
function videoItems(state) {
  return [
    viewItem(state),
    background(state),
    materialsItem(state),
    {
      id: 'rendering',
      label: `Rendering: ${state.smoothRendering ? 'Smooth' : 'Blocky'}`,
      icon: state.smoothRendering ? 'renderSmooth' : 'renderBlocky',
      toggle: true,
    },
    { id: 'ao', label: `Ambient Occlusion: ${state.ambientOcclusion ? 'On' : 'Off'}`, icon: state.ambientOcclusion ? 'aoOn' : 'aoOff', toggle: true },
    { id: 'refraction', label: `Refraction: ${state.refraction ? 'On' : 'Off'}`, icon: state.refraction ? 'refractionOn' : 'refractionOff', toggle: true },
    { id: 'fog', label: `Fog: ${state.fog ? 'On' : 'Off'}`, icon: state.fog ? 'fogOn' : 'fogOff', toggle: true },
    {
      id: 'antialias',
      label: `Anti-aliasing: ${state.antialias ? 'On' : 'Off'}`,
      icon: state.antialias ? 'aaOn' : 'aaOff',
      toggle: true,
      ...(state.antialias !== state.antialiasActive && { sub: 'on reload' }), // (fixed when the page loads)
    },
    { id: 'vsync', label: `VSync: ${state.vsync ? 'On' : 'Off'}`, icon: state.vsync ? 'vsyncOn' : 'vsyncOff', toggle: true },
    {
      id: 'xrResolution',
      // (set when an XR session starts: a change shows from the next one)
      label: `XR Resolution: ${Math.round(state.xrResolution * 100)}%${state.xrResolutionActive != null && state.xrResolution > state.xrResolutionActive ? ' (next XR)' : ''}`,
      icon: 'xrResolution',
      slider: { min: XR_RESOLUTION.min, max: XR_RESOLUTION.max, step: XR_RESOLUTION.step, value: state.xrResolution },
    },
  ];
}

/**
 * Options → Accessibility: the Music and Sounds volumes, the page UI's text size, the game's speed, how fast
 * the camera turns, which way each camera orbits (Observer controls, and Creature controls: Normal or Invert),
 * Direction Guides (Creature controls' step lines and dots, aimed Eat / Excrete's; G) and View Internal (creatures'
 * inventories) on / off.
 */
function accessibilityItems(state) {
  const camera = (id, name, invert) => ({ id, label: `${name}: ${invert ? 'Invert' : 'Normal'}`, icon: invert ? 'cameraInvert' : 'cameraNormal', toggle: true });
  const volume = (id, name, v, on, off) => ({
    id,
    label: `${name}: ${v > 0 ? `${Math.round(v * 100)}%` : 'Off'}`,
    icon: v > 0 ? on : off,
    slider: { min: VOLUME.min, max: VOLUME.max, step: VOLUME.step, value: v },
  });
  return [
    volume('music', 'Music', state.musicVolume, 'musicOn', 'musicOff'),
    volume('sound', 'Sounds', state.soundVolume, 'soundOn', 'soundOff'),
    {
      id: 'textSize',
      label: `Text Size: ${Math.round(state.textSize * 100)}%`,
      icon: 'textSize',
      slider: { min: TEXT_SIZE.min, max: TEXT_SIZE.max, step: TEXT_SIZE.step, value: state.textSize },
    },
    {
      id: 'speed',
      label: `Speed: ${state.speed}x${state.speed === 0 ? ' (stopped)' : ''}`,
      icon: 'speed',
      slider: { min: SPEED.min, max: SPEED.max, step: SPEED.step, value: state.speed }, // drawn as a slider, not a button
    },
    {
      id: 'cameraSpeed',
      label: `Camera Speed: ${Math.round(state.cameraSpeed * 100)}%`,
      icon: 'cameraNormal',
      slider: { min: CAMERA_SPEED.min, max: CAMERA_SPEED.max, step: CAMERA_SPEED.step, value: state.cameraSpeed },
    },
    {
      id: 'vibration',
      label: `Vibration: ${state.vibration > 0 ? `${Math.round(state.vibration * 100)}%` : 'Off'}`,
      icon: state.vibration > 0 ? 'vibrationOn' : 'vibrationOff',
      slider: { min: VIBRATION.min, max: VIBRATION.max, step: VIBRATION.step, value: state.vibration },
    },
    camera('observerCamera', 'Observer Camera', state.observerCameraInvert),
    camera('controlCamera', 'Control Camera', state.controlCameraInvert),
    { id: 'directionGuides', label: `Direction Guides: ${state.directionGuides ? 'On' : 'Off'}`, icon: state.directionGuides ? 'guidesOn' : 'guidesOff', toggle: true },
    { id: 'viewInternal', label: `View Internal: ${state.viewInternal ? 'On' : 'Off'}`, icon: state.viewInternal ? 'internalOn' : 'internalOff', toggle: true },
  ];
}

/** Options → File: a new world, or loading / saving one (their own screens; Back returns here). */
function fileItems(state) {
  return [
    newItem(state),
    { id: 'load', label: 'Load', icon: 'load', submenu: true },
    { id: 'save', label: 'Save', icon: 'save', submenu: true },
  ];
}

/**
 * Returns { title, items: [{ id, label, icon, sub?, disabled?, accent?, slider?, submenu?, toggle?, dropdown?, section? }] } for the current
 * menu screen. `submenu`: the button opens another menu screen (drawn with a right arrow at its far right).
 * `dropdown`: { open, options: [{ id, label, icon, selected }] }: the button opens or closes a list of
 * choices beneath it (drawn with a chevron at its far right).
 * `section`: { open, items, table? }: like a dropdown, but what opens beneath the button is more menu
 * entries (indented), and `table` the Controls table of that control schema (id).
 * `toggle`: the button switches a setting (On / Off, or the next choice); Right on the keyboard presses it too.
 * Every submenu lists Back first; renderers draw it at the very top of the panel
 * (above the save-name row). The Options screen itself has none: its gear button closes it.
 */
export function menuModel(state) {
  const { menu, saves, savesError, page } = state;
  if (menu === 'main') {
    // File, Controls, Video and Accessibility open in place, beneath their buttons (one at a time)
    const schema = CONTROL_SCHEMAS[state.controlSchema] ?? CONTROL_SCHEMAS.observer;
    return {
      title: GAME_TITLE,
      items: [
        { id: 'file', label: 'File', icon: 'file', section: { open: state.section === 'file', items: fileItems(state) } },
        { id: 'controls', label: `Controls: ${schema.name}`, icon: 'controls', section: { open: state.section === 'controls', table: schema.id, items: [] } },
        { id: 'video', label: 'Video', icon: 'video', section: { open: state.section === 'video', items: videoItems(state) } },
        { id: 'accessibility', label: 'Accessibility', icon: 'accessibility', section: { open: state.section === 'accessibility', items: accessibilityItems(state) } },
        { id: 'rain', label: `Rain: ${state.rain ? 'On' : 'Off'}`, icon: state.rain ? 'rainOn' : 'rainOff', toggle: true },
        { id: 'debug', label: `Debug: ${state.debugMode ? 'On' : 'Off'}`, icon: 'debug', toggle: true },
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
