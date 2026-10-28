// The Debug panel's content, shared by the browser's Debug panel (App.jsx) and the XR one
// (xrPanels.js DebugPanel), as a menu like Options' (menuModel): each section a button
// ("Title: summary", a chevron) whose content opens beneath it: `rows` (a box of key / value
// readouts) or `log` (the recent console log, newest last).
import { debugSections } from './debugSections.js';
import { getLogs, getLogVersion } from './debugLog.js';

/**
 * Debug → Docking: live tuning of where XR panels dock on a controller (Engine._layoutRow), in
 * the controller's pointing frame (-Z forward, +Y up): the stack's anchor (cm), its rotation
 * (degrees: tilt about X, the top leaning forward when negative; yaw about Y; roll about Z), the
 * gap between stacked panels (mm) and a scale on the panels' docked size. Defaults: as shipped.
 */
export const DOCK_TUNE = Object.freeze({
  x: { label: 'Offset X', unit: 'cm', min: -20, max: 20, step: 0.5, default: 0, icon: 'forward' },
  y: { label: 'Offset Y', unit: 'cm', min: -20, max: 30, step: 0.5, default: 5, icon: 'forward' },
  z: { label: 'Offset Z', unit: 'cm', min: -20, max: 20, step: 0.5, default: 2, icon: 'forward' },
  tilt: { label: 'Tilt', unit: '°', min: -90, max: 90, step: 1, default: (-0.5 * 180) / Math.PI, icon: 'cameraNormal' },
  yaw: { label: 'Yaw', unit: '°', min: -90, max: 90, step: 1, default: 0, icon: 'cameraNormal' },
  roll: { label: 'Roll', unit: '°', min: -90, max: 90, step: 1, default: 0, icon: 'cameraNormal' },
  gap: { label: 'Gap', unit: 'mm', min: 0, max: 30, step: 1, default: 8, icon: 'controls' },
  scale: { label: 'Scale', unit: '×', min: 0.5, max: 2, step: 0.05, default: 1, icon: 'textSize' },
});

const ms = (v, digits) => (v == null ? '—' : `${v.toFixed(digits)} ms`);

/** Debug's menu for `engine`, with up to `logLimit` log lines. { title, items }. */
export function debugModel(engine, logLimit = 1000) {
  const collapsed = debugSections.getSnapshot();
  const info = engine.debugInfo();
  const logs = getLogs(logLimit);
  const fps = engine.fps.toFixed(0);
  const section = (id, icon, title, summary, content) => ({
    id: `section:${id}`,
    icon,
    label: summary ? `${title}: ${summary}` : title,
    section: { open: !collapsed[id], items: [], ...content },
  });
  return {
    title: 'Debug',
    items: [
      section('performance', 'performance', 'Performance', `${fps} FPS`, {
        rows: [
          ['FPS', fps],
          ['Turn', ms(engine.turnMs, 1)],
          ['Anim', ms(engine.animMs, 2)],
          ['Render', ms(engine.renderMs, 2)],
          ['Draws', engine.drawCalls == null ? '—' : String(engine.drawCalls)],
          ['Triangles', engine.triangles == null ? '—' : engine.triangles.toLocaleString()],
        ],
      }),
      section('inspector', 'inspector', 'Inspector', info.title, info.rows.length ? { rows: info.rows.map(([k, v]) => [k, String(v)]) } : {}), // (nothing to inspect: no box)
      section('docking', 'controllerGuideOn', 'Docking', null, dockContent(engine.state.dockTune)),
      section('logging', 'logging', 'Logging', `${logs.length} lines`, { log: logs, logVersion: getLogVersion() }),
    ],
  };
}

/** Debug → Docking's content: the pose as code would write it (to copy into the projects), then a slider per DOCK_TUNE value and Reset. */
function dockContent(tune) {
  const fmt = (v, d) => +v.toFixed(d);
  const rad = (deg) => fmt((deg * Math.PI) / 180, 3);
  return {
    rows: [
      ['Anchor (m)', `(${fmt(tune.x / 100, 3)}, ${fmt(tune.y / 100, 3)}, ${fmt(tune.z / 100, 3)})`],
      ['Rotation (rad)', `X ${rad(tune.tilt)}, Y ${rad(tune.yaw)}, Z ${rad(tune.roll)}`],
      ['Gap / scale', `${fmt(tune.gap / 1000, 4)} m, ×${fmt(tune.scale, 2)}`],
    ],
    items: [
      ...Object.entries(DOCK_TUNE).map(([k, spec]) => ({
        id: `dock:${k}`,
        icon: spec.icon,
        label: `${spec.label}: ${fmt(tune[k], 2)}${spec.unit === '°' || spec.unit === '×' ? '' : ' '}${spec.unit}`,
        slider: { min: spec.min, max: spec.max, step: spec.step, value: tune[k] },
      })),
      { id: 'dock:reset', icon: 'back', label: 'Reset Docking' },
    ],
  };
}
