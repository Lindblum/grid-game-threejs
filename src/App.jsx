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
            {CONTROL_COLUMNS.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CONTROLS.map((row) => (
            <tr key={row.action}>
              <td className="action">{row.action}</td>
              {[row.mk, row.pad, row.xr].map((binding, i) => {
                const img = cellURL(binding.g, 64);
                return (
                  <td key={i} title={binding.t}>
                    <img src={img.url} alt={binding.t} style={{ height: 32, width: img.w / 2 }} draggable={false} />
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

/** A number kept in localStorage (a per-browser preference, e.g. a panel's size); `fallback` when unset or unreadable. */
function useStoredNumber(key, fallback) {
  const [value, setValue] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      return localStorage.getItem(key) != null && Number.isFinite(v) ? v : fallback;
    } catch {
      return fallback;
    }
  });
  const store = (v) => {
    setValue(v);
    try {
      localStorage.setItem(key, String(v));
    } catch {}
  };
  return [value, store];
}

/** HUD panel sizes (px): the panel resizes, its contents keep their size. 0 = automatic. */
const HUD_SIZE = { minWidth: 80, minHeight: 60 };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * A drag grip on a HUD panel's edge or corner (`place`: CSS class for where it sits).
 * `onStart()` is called when a drag begins; `onDrag(up, right)`: how far the pointer has
 * moved since then, in px (up and right positive). Double-click calls `onReset`.
 */
function ResizeGrip({ place, title, onStart, onDrag, onReset }) {
  const from = useRef(null);
  return (
    <div
      className={`resize-grip ${place}`}
      title={title}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        from.current = { x: e.clientX, y: e.clientY };
        onStart();
      }}
      onPointerMove={(e) => {
        if (from.current) onDrag(from.current.y - e.clientY, e.clientX - from.current.x);
      }}
      onPointerUp={() => (from.current = null)}
      onPointerCancel={() => (from.current = null)}
      onDoubleClick={onReset}
    />
  );
}

/**
 * Resizing for a HUD panel (its contents keep their size): returns [style, grip props].
 * Dragging the grip up makes the panel taller; dragging it outward (`outward` = +1 right,
 * -1 left) makes it wider. Double-click goes back to the automatic size.
 */
function useHudSize(key, panelRef, outward) {
  const [width, setWidth] = useStoredNumber(`${key}.width`, 0);
  const [height, setHeight] = useStoredNumber(`${key}.height`, 0);
  const start = useRef(null);
  const grip = {
    onStart: () => (start.current = { width: panelRef.current?.offsetWidth || 100, height: panelRef.current?.offsetHeight || 100 }),
    onDrag: (up, right) => {
      const s0 = start.current;
      if (!s0) return;
      setWidth(Math.round(clamp(s0.width + right * outward, HUD_SIZE.minWidth, window.innerWidth - 32)));
      setHeight(Math.round(clamp(s0.height + up, HUD_SIZE.minHeight, window.innerHeight * 0.6)));
    },
    onReset: () => {
      setWidth(0);
      setHeight(0);
    },
  };
  const style = { ...(width ? { width } : {}), ...(height ? { height } : {}) };
  return [style, grip];
}

function Hud({ engine, s }) {
  const slotsRef = useRef(null);
  const labelRef = useRef(null);
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const [labelX, setLabelX] = useState(null);
  // each panel's size (drag its grip; double-click resets): left grows up / right, right up / left
  const [leftSize, leftGrip] = useHudSize('hudLeft', leftRef, +1);
  const [rightSize, rightGrip] = useHudSize('hudRight', rightRef, -1);
  // the Debug dock stops just above the HUD panels, however big they are
  const wrapRef = useRef(null);
  const [hudHeight, setHudHeight] = useState(0);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const watch = new ResizeObserver(() => setHudHeight(el.offsetHeight));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
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
  useLayoutEffect(placeLabel, [s.toolIndex, label, rightSize.width]);
  useEffect(() => {
    window.addEventListener('resize', placeLabel);
    return () => window.removeEventListener('resize', placeLabel);
  });
  return (
    <>
    <div className="hud-wrap" ref={wrapRef}>
      <div className="hud-row">
      <div className="panel hud hud-left" ref={leftRef} style={leftSize}>
        <ResizeGrip place="grip-top-right" title="Drag to resize (double-click: reset)" {...leftGrip} />
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
      <div className="panel hud hud-right" ref={rightRef} style={rightSize}>
        <ResizeGrip place="grip-top-left" title="Drag to resize (double-click: reset)" {...rightGrip} />
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
              <img src={toolIconURL(t, 96, { procedural: s.proceduralMaterials, smooth: s.smoothRendering })} alt={t.label} draggable={false} />
            </button>
          ))}
        </div>
      </div>
      </div>
    </div>
    {s.debugMode && <DebugPanel engine={engine} bottom={hudHeight + 16 + 10} />}
    </>
  );
}

/** The Debug dock's width (px; drag its right edge), and its limits (px, and a fraction of the window). */
const DEBUG_WIDTH = { initial: 280, min: 170, max: 0.7 };

/**
 * A collapsible section of the Debug dock: a header (title, a short `summary` shown while
 * collapsed, and a toggle), then its content. Each section remembers being collapsed in this
 * browser. `grow`: it takes the dock's leftover height (Logging).
 */
function DebugSection({ id, title, summary, grow = false, children }) {
  const [collapsed, setCollapsed] = useStoredNumber(`debugCollapsed.${id}`, 0);
  return (
    <section className={`debug-section-box${grow && !collapsed ? ' grow' : ''}`}>
      <button className="debug-section-head" onClick={blurThen(() => setCollapsed(collapsed ? 0 : 1))} title={collapsed ? 'Expand' : 'Collapse'}>
        <span className="debug-section">{title}</span>
        {collapsed && summary ? <span className="debug-summary">{summary}</span> : null}
        <span className="debug-arrow">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && <div className="debug-section-body">{children}</div>}
    </section>
  );
}

/**
 * Options → Debug (browser): a dock on the left edge, from the top of the window down to just
 * above the HUD (`bottom`, px). Performance (FPS and timings), the Inspector (the selected /
 * targeted block's properties) and Logging (the recent console log) stack vertically, each
 * collapsible; Logging takes the leftover height. Resized by width only (drag its right edge;
 * double-click resets). Polls the engine a few times a second rather than every frame.
 */
function DebugPanel({ engine, bottom }) {
  const [, setTick] = useState(0);
  const [width, setWidth] = useStoredNumber('debugWidth', DEBUG_WIDTH.initial);
  const startWidth = useRef(width);
  const logRef = useRef(null);
  const stick = useRef(true); // keep the log scrolled to the bottom unless the user scrolled up
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const info = engine.debugInfo();
  const logs = getLogs(1000);
  const version = getLogVersion();
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const ms = (v, digits) => (v == null ? '—' : `${v.toFixed(digits)} ms`);
  return (
    <div className="panel debug-dock" style={{ width, bottom }}>
      <ResizeGrip
        place="grip-right-edge"
        title="Drag to resize (double-click: reset)"
        onStart={() => (startWidth.current = width)}
        onDrag={(up, right) => setWidth(Math.round(clamp(startWidth.current + right, DEBUG_WIDTH.min, window.innerWidth * DEBUG_WIDTH.max)))}
        onReset={() => setWidth(DEBUG_WIDTH.initial)}
      />
      <DebugSection id="performance" title="Performance" summary={`${engine.fps.toFixed(0)} FPS`}>
        <table className="debug-table">
          <tbody>
            <tr><th>FPS</th><td>{engine.fps.toFixed(0)}</td></tr>
            <tr><th>Turn</th><td>{ms(engine.turnMs, 1)}</td></tr>
            <tr><th>Anim</th><td>{ms(engine.animMs, 2)}</td></tr>
            <tr><th>Render</th><td>{ms(engine.renderMs, 2)}</td></tr>
          </tbody>
        </table>
      </DebugSection>
      <DebugSection id="inspector" title="Inspector" summary={info.title}>
        <div className="debug-title">{info.title}</div>
        <table className="debug-table">
          <tbody>
            {info.rows.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DebugSection>
      <DebugSection id="logging" title="Logging" summary={`${logs.length} lines`} grow>
        <div
          className="debug-log"
          ref={logRef}
          onScroll={(ev) => {
            const el = ev.currentTarget;
            stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
          }}
        >
          {logs.length ? (
            logs.map((entry, i) => (
              <div key={i} className={`log-${entry.level}`}>
                <span className="log-time">{entry.t}</span> {entry.text}
              </div>
            ))
          ) : (
            <div className="log-empty">No log output yet</div>
          )}
        </div>
      </DebugSection>
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
    e.target.value = ''; // the same file can be picked again
    if (f) engine.openDroppedFile(f); // a save file loads; a template builds a new world
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
