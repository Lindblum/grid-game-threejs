import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Engine } from './game/Engine.js';
import { TOOLS } from './game/tools.js';
import { toolIconURL } from './game/icons.js';
import { menuModel } from './game/menu.js';

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
      {s.screen === 'title' && <TitleScreen engine={engine} s={s} />}
      {s.screen === 'playing' && !s.inXR && <Hud engine={engine} s={s} />}
      {s.screen === 'playing' && !s.inXR && s.paused && <PauseMenu engine={engine} s={s} />}
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

function TitleScreen({ engine, s }) {
  const xrLabel = s.xrSupport === 'immersive-ar' ? 'Enter XR (passthrough)' : s.xrSupport === 'immersive-vr' ? 'Enter VR' : null;
  return (
    <div className="screen-center">
      <div className="panel title-panel">
        <h1>Grid Game</h1>
        <p className="subtitle">Build with truncated octahedra — 14 neighbours per cell.</p>
        <div className="title-buttons">
          <button className="btn accent" onClick={blurThen(() => engine.play())}>Play in browser</button>
          {xrLabel ? (
            <button className="btn" onClick={blurThen(() => engine.enterXR())}>{xrLabel}</button>
          ) : (
            <button className="btn" disabled title="Open this page in a WebXR browser (e.g. Meta Quest Browser) over HTTPS">
              XR not available here
            </button>
          )}
        </div>
        <table className="help">
          <tbody>
            <tr><th></th><th>Browser</th><th>Quest Touch</th></tr>
            <tr><td>Use tool</td><td>Left click</td><td>Right trigger</td></tr>
            <tr><td>Change tool</td><td>← / → (or 1–8)</td><td>Right stick left/right</td></tr>
            <tr><td>Pause</td><td>Esc / Enter</td><td>Left Menu (or Y)</td></tr>
            <tr><td>Look around</td><td>Right-drag, wheel zoom, middle-drag pan</td><td>Walk; left grip drags the build</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Hud({ engine, s }) {
  return (
    <div className="hud-wrap">
      <div className="panel hud">
        <div className="hud-label">
          {TOOLS[s.toolIndex].label}
          <span className="hud-count">{s.blockCount} blocks</span>
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

function PauseMenu({ engine, s }) {
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
    <div className="screen-center dim">
      <div className="panel menu-panel">
        <h2>{model.title}</h2>
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
            <button className="btn accent" onClick={blurThen(doSaveNew)}>Save new</button>
          </div>
        )}
        <div className="menu-items">
          {model.items
            .filter((it) => !(s.menu === 'save' && it.id === 'savenew'))
            .map((it) => (
              <button
                key={it.id}
                className={`btn menu-btn${it.accent ? ' accent' : ''}`}
                disabled={it.disabled}
                onClick={blurThen(() => engine.menuAction(it.id))}
              >
                <span>{it.label}</span>
                {it.sub && <span className="sub">{it.sub}</span>}
              </button>
            ))}
        </div>
        {s.savesError && s.menu !== 'main' && (
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
