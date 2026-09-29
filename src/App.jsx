import { useEffect, useRef, useState, useSyncExternalStore, useLayoutEffect } from 'react';
import { Engine } from './game/engine.js';
import { TOOLS } from './game/tools.js';
import { toolIconURL, menuIconURL } from './game/icons.js';
import { menuModel } from './game/menu.js';
import { menuItemIconURL } from './game/menuIcons.js';
import { CONTROLS, CONTROL_COLUMNS } from './game/controls.js';
import { cellURL } from './game/inputIcons.js';
import { getLogs, getLogVersion } from './game/debugLog.js';

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
  const slotsRef = useRef(null);
  const labelRef = useRef(null);
  const [labelX, setLabelX] = useState(null);
  const label = engine.toolLabel(s);
  // keep the current tool visible when the bar is scrolled (e.g. switching with the keys)
  useEffect(() => {
    slotsRef.current?.querySelector('.slot.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [s.toolIndex]);
  // put the tool name directly above the selected slot (kept inside the panel)
  const placeLabel = () => {
    const bar = slotsRef.current, lab = labelRef.current;
    const slot = bar?.querySelector('.slot.selected');
    if (!bar || !lab || !slot) return;
    const panel = bar.parentElement;
    const centre = slot.getBoundingClientRect().left + slot.offsetWidth / 2 - panel.getBoundingClientRect().left;
    const half = lab.offsetWidth / 2, pad = 8;
    setLabelX(Math.min(Math.max(centre, half + pad), panel.clientWidth - half - pad));
  };
  useLayoutEffect(placeLabel, [s.toolIndex, label]);
  useEffect(() => {
    window.addEventListener('resize', placeLabel);
    return () => window.removeEventListener('resize', placeLabel);
  });
  return (
    <div className="hud-wrap">
      <div className="hud-row">
      <div className="panel hud hud-left">
        <div className="hud-label hud-time" title="Game time">{Engine.formatTime(s.gameTime)}</div>
        <div className="hud-label hud-diameter" title="Mean Diameter: estimated from the block count">
          {Engine.formatDiameter(s.blockCount)}
        </div>
        <button
          className={`slot menu-slot${s.paused ? ' selected' : ''}`}
          title="Menu (Esc)"
          onClick={blurThen(() => engine.toggleMenu())}
        >
          <img src={menuIconURL()} alt="Menu" draggable={false} />
        </button>
      </div>
      <div className="panel hud hud-right">
        <div className="hud-label tool-label-row">
          <span ref={labelRef} className="tool-label" style={labelX == null ? undefined : { left: labelX }}>
            {label}
          </span>
        </div>
        <div
          className="slots"
          ref={slotsRef}
          onScroll={placeLabel}
          onWheel={(e) => {
            // a plain mouse wheel scrolls the bar sideways
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
          }}
        >
          {TOOLS.map((t, i) => (
            <button
              key={t.id}
              className={`slot${i === s.toolIndex ? ' selected' : ''}`}
              title={`${t.label} (${(i + 1) % 10})`}
              onClick={blurThen(() => engine.selectTool(i))}
            >
              <img src={toolIconURL(t)} alt={t.label} draggable={false} />
            </button>
          ))}
        </div>
      </div>
      </div>
      {s.debugMode && <DebugPanel engine={engine} />}
    </div>
  );
}

/**
 * Options → Debug (browser): the selected / targeted block's properties, and the recent
 * console log. Polls the engine a few times a second rather than re-rendering every frame.
 */
function DebugPanel({ engine }) {
  const [, setTick] = useState(0);
  const logRef = useRef(null);
  const stick = useRef(true); // keep the log scrolled to the bottom unless the user scrolled up
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const info = engine.debugInfo();
  const logs = getLogs(100);
  const version = getLogVersion();
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [version]);
  return (
    <div className="panel debug-panel">
      <div className="debug-props">
        <div className="debug-title">{info.title}</div>
        <table>
          <tbody>
            {info.rows.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div
        className="debug-log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        }}
      >
        {logs.length ? (
          logs.map((e, i) => (
            <div key={i} className={`log-${e.level}`}>
              <span className="log-time">{e.t}</span> {e.text}
            </div>
          ))
        ) : (
          <div className="log-empty">No log output yet</div>
        )}
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

  const renderItem = (it) =>
    it.slider ? (
      <label key={it.id} className={`btn menu-btn menu-slider${s.menuFocus === it.id ? ' focused' : ''}`}>
        {it.icon && <img className="menu-icon" src={menuItemIconURL(it.icon)} alt="" draggable={false} />}
        <span className="label">{it.label}</span>
        <input
          type="range"
          min={it.slider.min}
          max={it.slider.max}
          step={it.slider.step}
          value={it.slider.value}
          onChange={(e) => engine.setSpeed(e.target.value)}
        />
      </label>
    ) : (
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
  );
  // a leading Back button goes at the very top, above the Controls table / save-name row
  const back = model.items[0]?.id === 'back' ? model.items[0] : null;
  const rest = (back ? model.items.slice(1) : model.items).filter((it) => !(s.menu === 'save' && it.id === 'savenew'));

  return (
    <div className={`screen-center${s.screen === 'playing' ? ' dim' : ''}`}>
      <div className={`panel menu-panel${s.menu === 'controls' ? ' controls-panel' : ''}`}>
        <h2>{model.title}</h2>
        {back && <div className="menu-items menu-back">{renderItem(back)}</div>}
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
        {rest.length > 0 && <div className="menu-items">{rest.map(renderItem)}</div>}
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
