// The Debug panel's content, shared by the browser's Debug panel (App.jsx) and the XR one
// (xrPanels.js DebugPanel), as a menu like Options' (menuModel): each section a button
// ("Title: summary", a chevron) whose content opens beneath it: `rows` (a box of key / value
// readouts) or `log` (the recent console log, newest last).
import { debugSections } from './debugSections.js';
import { getLogs, getLogVersion } from './debugLog.js';

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
      section('logging', 'logging', 'Logging', `${logs.length} lines`, { log: logs, logVersion: getLogVersion() }),
    ],
  };
}
