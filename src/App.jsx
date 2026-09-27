import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Engine } from './game/engine.js';
import { TOOLS } from './game/tools.js';
import { toolIconURL, menuIconURL } from './game/icons.js';
import { menuModel } from './game/menu.js';
import { menuItemIconURL } from './game/menuIcons.js';
import { CONTROLS, CONTROL_COLUMNS } from './game/controls.js';
import { cellURL } from './game/inputIcons.js';

export default function App() {
  const hostRef = useRef(null);
  const [engine, setEngine] = useState(null);

  useEffect(() => {
    const e = new Engine(hostRef.current);
    window.__gridGame = e; // handy for debugging in the console
    setEngine(e);
    return () => e.dispose();
  }, []);

  return (
    <div className="app">
      <div ref={hostRef} className="stage" />
      {engine && <Overlay engine={engine} />}
    </div>
  );
}

function Overlay({ engine }) {
  const s = useSyncExternalStore(engine.subscribe, engine.getState);
  return (
    <>
      {s.screen === 'playing' && !s.inXR && <Hud engine={engine} s={s} />}
      {s.screen === 'playing' && !s.inXR && !s.paused && s.gamepadAim && <div className="crosshair" />}
      {engine.isMenuOpen(s) && !s.inXR && <MenuScreen engine={engine} s={s} />}
      {s.inXR && <div className="xr-note">In XR — take off the headset view to return here.</div>}
      <Toast toast={s.toast} />
    </>
  );
}

function blurThen(fn) {
  return (e) => {
    e.currentTarget.blur();
    fn(e);
  };
}

/** Options → Controls: one row per action, glyphs for each input device. */
function ControlsTable() {
  return (
    <div className="controls-scroll">
      <table className="controls">
        <thead>
          <tr>
            {CONTROL_COLUMNS.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CONTROLS.map((row) => (
            <tr key={row.action}>
              <td className="action">{row.action}</td>
              {[row.mk, row.pad, row.xr].map((b, i) => {
                const img = cellURL(b.g, 64);
                return (
                  <td key={i} title={b.t}>
                    <img src={img.url} alt={b.t} style={{ height: 32, width: img.w / 2 }} draggable={false} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Hud({ engine, s }) {
  return (
    <div className="hud-wrap">
      <div className="panel hud hud-left">
        <div className="hud-label hud-time" title="Game time">{Engine.formatTime(s.gameTime)}</div>
        <button
          className={`slot menu-slot${s.paused ? ' selected' : ''}`}
          title="Menu (Esc)"
          onClick={blurThen(() => engine.toggleMenu())}
        >
          <img src={menuIconURL()} alt="Menu" draggable={false} />
        </button>
      </div>
      <div className="panel hud hud-right">
        <div className="hud-label">
          {TOOLS[s.toolIndex].label}
        </div>
        <div className="slots">
          {TOOLS.map((t, i) => (
            <button
              key={t.id}
              className={`slot${i === s.toolIndex ? ' selected' : ''}`}
              title={`${t.label} (${i + 1})`}
              onClick={blurThen(() => engine.selectTool(i))}
            >
              <img src={toolIconURL(t)} alt={t.label} draggable={false} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Start panel (title screen) and pause panel share this component. */
function MenuScreen({ engine, s }) {
  const model = menuModel(s);
  const [name, setName] = useState('');
  const fileRef = useRef(null);

  const doSaveNew = () => engine.menuAction('savenew', name.trim() || undefined);

  const download = () => {
    const blob = new Blob([JSON.stringify(engine.exportJSON(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (name.trim() || 'grid-save').replace(/\.json$/i, '') + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    engine.resume();
  };
  const openFile = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      engine.importJSON(JSON.parse(await f.text()), f.name);
    } catch {
      engine.toast('That file is not valid JSON', 'error');
    }
  };

  return (
    <div className={`screen-center${s.screen === 'playing' ? ' dim' : ''}`}>
      <div className={`panel menu-panel${s.menu === 'controls' ? ' controls-panel' : ''}`}>
        <h2>{model.title}</h2>
        {model.table && <ControlsTable />}
        {s.menu === 'save' && !s.savesError && (
          <div className="save-row">
            <input
              autoFocus
              placeholder="new file name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') doSaveNew();
              }}
            />
            <button className={`btn accent save-new-btn${s.menuFocus === 'savenew' ? ' focused' : ''}`} onClick={blurThen(doSaveNew)}>
              <img className="menu-icon" src={menuItemIconURL('savenew')} alt="" draggable={false} />
              Save new
            </button>
          </div>
        )}
        <div className="menu-items">
          {model.items
            .filter((it) => !(s.menu === 'save' && it.id === 'savenew'))
            .map((it) => (
              <button
                key={it.id}
                className={`btn menu-btn${it.accent ? ' accent' : ''}${s.menuFocus === it.id ? ' focused' : ''}`}
                disabled={it.disabled}
                onClick={blurThen(() => engine.menuAction(it.id))}
              >
                {it.icon && <img className="menu-icon" src={menuItemIconURL(it.icon)} alt="" draggable={false} />}
                <span className="label">{it.label}</span>
                {it.sub && <span className="sub">{it.sub}</span>}
              </button>
            ))}
        </div>
        {s.savesError && (s.menu === 'load' || s.menu === 'save') && (
          <div className="fallback">
            <p>The saves folder is only reachable when running with <code>npm run dev</code>. You can still use a file on this computer:</p>
            {s.menu === 'save' ? (
              <button className="btn accent" onClick={blurThen(download)}>Download .json</button>
            ) : (
              <>
                <button className="btn accent" onClick={blurThen(() => fileRef.current?.click())}>Open .json file…</button>
                <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={openFile} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Toast({ toast }) {
  const [visible, setVisible] = useState(null);
  useEffect(() => {
    if (!toast) return;
    setVisible(toast);
    const t = setTimeout(() => setVisible(null), 2600);
    return () => clearTimeout(t);
  }, [toast?.id]);
  if (!visible) return null;
  return <div className={`toast ${visible.kind}`}>{visible.text}</div>;
}
