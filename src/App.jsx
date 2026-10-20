import { Fragment, useEffect, useRef, useState, useSyncExternalStore, useLayoutEffect } from 'react';
import { Engine } from './game/engine.js';
import { TOOLS } from './game/tools.js';
import { toolIconURL, menuIconURL } from './game/icons.js';
import { menuModel, splitLabel } from './game/menu.js';
import { menuItemIconURL } from './game/menuIcons.js';
import { CONTROL_SCHEMAS, CONTROL_COLUMNS } from './game/controls.js';
import { cellURL } from './game/inputIcons.js';
import { getLogs, getLogVersion } from './game/debugLog.js';
import { claudePrompt } from './game/claudePrompt.js';
import { debugSections } from './game/debugSections.js';

/** How far (px) a press may move before its release no longer counts as a click. */
const DRAG_PX = 6;

export default function App() {
  const hostRef = useRef(null);
  const [engine, setEngine] = useState(null);

  useEffect(() => {
    const e = new Engine(hostRef.current);
    window.__gridGame = e; // handy for debugging in the console
    setEngine(e);
    return () => e.dispose();
  }, []);

  // a drag isn't a click: a press that moves more than DRAG_PX before its release doesn't
  // click the button it's released on (window capture, so it runs before React's handlers)
  useEffect(() => {
    let down = null; // { x, y } of the press, or null once it has moved too far
    const onDown = (e) => (down = e.isPrimary ? { x: e.clientX, y: e.clientY } : down);
    const onMove = (e) => {
      if (down && e.isPrimary && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) down = 'dragged';
    };
    const onClick = (e) => {
      const dragged = down === 'dragged';
      down = null;
      if (dragged && e.detail > 0) {
        // (detail 0: a click from the keyboard, not the pointer)
        e.stopPropagation();
        e.preventDefault();
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('click', onClick, true);
    };
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
  // the page's own HUD and menus: outside XR, and in front of the view in XR: Phone AR
  const flat = !s.inXR || engine.screenUI(s);
  return (
    <>
      {s.screen === 'playing' && flat && <Hud engine={engine} s={s} />}
      {s.screen === 'playing' && !s.inXR && !s.paused && s.gamepadAim && <div className="crosshair" />}
      {engine.isMenuOpen(s) && flat && <MenuScreen engine={engine} s={s} />}
      {s.inXR && !s.handheld && !flat && <div className="xr-note">In XR — take off the headset view to return here.</div>}
      {s.handheld && <CardboardOverlay split={s.phoneStereo} onTap={() => engine.gazeTap()} onExit={() => engine.exitXR()} />}
      <Toast toast={s.toast} />
    </>
  );
}

/** The handheld XR view (phones without WebXR AR): the viewer's divider, tap to click, and a way out. */
function CardboardOverlay({ split, onTap, onExit }) {
  return (
    <div className="cardboard" onClick={onTap}>
      {split && <div className="cardboard-divider" />}
      <button
        className="cardboard-exit"
        aria-label="Exit XR view"
        onClick={(e) => {
          e.stopPropagation();
          onExit();
        }}
      >
        ✕
      </button>
    </div>
  );
}

/** "Name: Value": the name on the left, the value against the right edge. */
function MenuLabel({ text }) {
  const { name, value } = splitLabel(text);
  return (
    <span className="label">
      <span className="name">{name}</span>
      {value && <span className="value">{value}</span>}
    </span>
  );
}

/** What a menu button's right edge shows: an arrow to a submenu, or a dropdown's (or section's) chevron. */
function trailingIcon(it) {
  if (it.submenu) return 'forward';
  const open = (it.dropdown ?? it.section)?.open;
  if (open !== undefined) return open ? 'dropdownOpen' : 'dropdown';
  return null;
}

function blurThen(fn) {
  return (e) => {
    e.currentTarget.blur();
    fn(e);
  };
}

/** Options → Controls: one row per action of control schema `schema` (id), glyphs for each input device. */
function ControlsTable({ schema }) {
  const rows = (CONTROL_SCHEMAS[schema] ?? CONTROL_SCHEMAS.observer).controls;
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
          {rows.map((row) => (
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
    } catch { }
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
  const [labelPos, setLabelPos] = useState(null); // the tool name's place in the bar: { left, top } (px)
  // each panel's size (drag its grip; double-click resets): left grows up / right, right up / left
  const [leftSize, leftGrip] = useHudSize('hudLeft', leftRef, +1);
  const [rightSize, rightGrip] = useHudSize('hudRight', rightRef, -1);
  const wrapRef = useRef(null);
  const label = engine.toolLabel(s);
  // keep the current tool visible when the bar is scrolled (e.g. switching with the keys)
  useEffect(() => {
    slotsRef.current?.querySelector('.slot.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [s.toolIndex]);
  // put the tool name directly below the selected slot, inside the scrolling bar (so it scrolls
  // with the icons; with the panel resized the icons wrap into rows, and it goes under the
  // selected one's row): its place in the bar's content, kept within it at the ends
  const placeLabel = () => {
    const bar = slotsRef.current, lab = labelRef.current;
    const slot = bar?.querySelector('.slot.selected');
    if (!bar || !lab || !slot) return;
    const half = lab.offsetWidth / 2;
    const left = Math.min(Math.max(slot.offsetLeft + slot.offsetWidth / 2, half), bar.scrollWidth - half);
    setLabelPos({ left, top: slot.offsetTop + slot.offsetHeight + 2 });
  };
  useLayoutEffect(placeLabel, [s.toolIndex, label, rightSize.width, rightSize.height]);
  return (
    <>
      <div className="hud-wrap" ref={wrapRef}>
        <div className="hud-row">
          <div className="panel hud hud-left" ref={leftRef} style={leftSize}>
            <ResizeGrip place="grip-top-right" title="Drag to resize (double-click: reset)" {...leftGrip} />
            <div className="hud-header hud-header-left">Game</div>
            {/* laid out like Debug → Performance: muted labels, monospace values, same size */}
            <table className="debug-table hud-stats">
              <tbody>
                <tr><th>Time</th><td>{Engine.formatTime(s.gameTime)}</td></tr>
                <tr><th>Diameter</th><td>{Engine.formatDiameter(s.blockCount)}</td></tr>
              </tbody>
            </table>

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
            <div className="hud-header">{engine.toolsAvailable(s) ? 'Tools' : 'Creature'}</div>
            {engine.toolsAvailable(s) && <div
              className={`slots${rightSize.width ? ' wrap' : ''}`} // resized: the icons wrap into rows
              ref={slotsRef}
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
                  <img src={toolIconURL(t, 96, { materials: s.materials, smooth: s.smoothRendering })} alt={t.label} draggable={false} />
                </button>
              ))}
              {/* the current tool's name, under its slot (scrolls with the icons) */}
              <span ref={labelRef} className="tool-label" style={labelPos ?? undefined}>
                {label}
              </span>
            </div>}
            {/* Creature controls: no toolbar, just who you're controlling */}
            {!engine.toolsAvailable(s) && <div className="hud-label creature-label">{label}</div>}
          </div>
        </div>
      </div>
      {s.debugMode && <DebugPanel engine={engine} />}
    </>
  );
}

/** The Debug dock's width (px; drag its bottom-right corner), and its limits (px, and a fraction of the window). */
const DEBUG_WIDTH = { initial: 280, min: 170, max: 0.7 };
/** …and its height (px; drag its bottom-right corner): at first, and its limits (px; the max leaves a margin of the window). */
const DEBUG_HEIGHT = { initial: 480, min: 120, margin: 32 };

/**
 * A collapsible section of the Debug dock: a header (title, a short `summary` shown while
 * collapsed, and a toggle), then its content. Each section remembers being collapsed in this
 * browser. `grow`: it takes the dock's leftover height (Logging).
 */
function DebugSection({ id, title, summary, grow = false, children }) {
  // shared with the XR debug tablet (debugSections.js)
  const collapsed = useSyncExternalStore(debugSections.subscribe, debugSections.getSnapshot)[id];
  const setCollapsed = () => debugSections.toggle(id);
  return (
    <section className={`debug-section-box${grow && !collapsed ? ' grow' : ''}`}>
      <button className="debug-section-head" onClick={blurThen(setCollapsed)} title={collapsed ? 'Expand' : 'Collapse'}>
        <span className="debug-section">{title}</span>
        {collapsed && summary ? <span className="debug-summary">{summary}</span> : null}
        <span className="debug-arrow">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && <div className="debug-section-body">{children}</div>}
    </section>
  );
}

/**
 * Options → Debug (browser): a panel docked to the window's top-left corner. Performance (FPS and timings), the Inspector (the selected /
 * targeted block's properties), Claude (a placeholder for now) and Logging (the recent console log) stack vertically, each
 * collapsible; Logging takes the leftover height. Resized from its bottom-right corner (width
 * and height; double-click resets). Polls the engine a few times a second rather than every frame.
 */
function DebugPanel({ engine }) {
  const [, setTick] = useState(0);
  const [width, setWidth] = useStoredNumber('debugWidth', DEBUG_WIDTH.initial);
  const [height, setHeight] = useStoredNumber('debugHeight2', DEBUG_HEIGHT.initial);
  const start = useRef({ width, height });
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
    <div className="panel debug-dock" style={{ width, height: Math.min(height, window.innerHeight - DEBUG_HEIGHT.margin) }}>
      <ResizeGrip
        place="grip-bottom-right"
        title="Drag to resize (double-click: reset)"
        onStart={() => (start.current = { width, height })}
        onDrag={(up, right) => {
          setWidth(Math.round(clamp(start.current.width + right, DEBUG_WIDTH.min, window.innerWidth * DEBUG_WIDTH.max)));
          setHeight(Math.round(clamp(start.current.height - up, DEBUG_HEIGHT.min, window.innerHeight - DEBUG_HEIGHT.margin)));
        }}
        onReset={() => {
          setWidth(DEBUG_WIDTH.initial);
          setHeight(DEBUG_HEIGHT.initial);
        }}
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
      {/* Claude: a placeholder for now — not wired to the Claude bridge (claudeBridge.js) yet */}
      <DebugSection id="claude" title="Claude" summary="Not connected">
        <ClaudePrompt />
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

/**
 * Debug → Claude (browser): the reply area (placeholder) and the prompt box. The prompt (shared with
 * the XR debug tablet: claudePrompt.js) can be typed, dictated (microphone button: appended to what's
 * there) and cleared. Send isn't wired to the Claude bridge yet.
 */
function ClaudePrompt() {
  const { prompt, listening, micSupported, speaking, speechSupported } = useSyncExternalStore(claudePrompt.subscribe, claudePrompt.getSnapshot);

  return (
    <>
      <div className="claude-log">
        <div className="log-empty">{claudePrompt.responseText()}</div>
      </div>
      <div className="claude-buttons">
        <button
          className={`btn icon-btn${speaking ? ' speaking' : ''}`}
          onClick={blurThen(() => claudePrompt.toggleSpeech())}
          disabled={!speechSupported}
          title={speechSupported ? (speaking ? 'Stop reading' : 'Read aloud') : 'Reading aloud isn’t supported in this browser'}
        >
          <img src={menuItemIconURL('speak')} alt="Read aloud" draggable={false} />
        </button>
      </div>
      <textarea className="claude-text" rows={2} placeholder="Ask Claude…" value={prompt} onChange={(e) => claudePrompt.setPrompt(e.target.value)} />
      <div className="claude-buttons">
        <button
          className={`btn icon-btn${listening ? ' listening' : ''}`}
          onClick={blurThen(() => claudePrompt.toggleDictation())}
          disabled={!micSupported}
          title={micSupported ? (listening ? 'Stop dictating' : 'Dictate') : 'No dictation in this browser: use the keyboard’s mic'}
        >
          <img src={menuItemIconURL('mic')} alt="Dictate" draggable={false} />
        </button>
        <button className="btn icon-btn" onClick={blurThen(() => claudePrompt.clear())} title="Clear">
          <img src={menuItemIconURL('clear')} alt="Clear" draggable={false} />
        </button>
        <button className="btn send-btn" disabled>Send</button>
      </div>
      {/* XR: focusing this (from the tablet) brings up the headset's system keyboard; what it types goes to the prompt */}
      <textarea
        id="claude-xr-input"
        className="xr-keyboard-field"
        tabIndex={-1}
        aria-hidden="true"
        defaultValue={prompt}
        onInput={(e) => claudePrompt.setPrompt(e.currentTarget.value)}
      />
    </>
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
        <MenuLabel text={it.label} />
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
        aria-expanded={(it.dropdown ?? it.section)?.open}
        onClick={blurThen(() => engine.menuAction(it.id))}
      >
        {it.icon && <img className="menu-icon" src={menuItemIconURL(it.icon)} alt="" draggable={false} />}
        <MenuLabel text={it.label} />
        {it.sub && <span className="sub">{it.sub}</span>}
        {trailingIcon(it) && <img className="menu-icon menu-arrow" src={menuItemIconURL(trailingIcon(it))} alt="" draggable={false} />}
      </button>
    );
  // a dropdown's button, then (when open) its choices, two to a row beneath it; a section's button,
  // then (when open) its Controls table or its entries, indented beneath it
  const renderEntry = (it) =>
    it.section ? (
      <Fragment key={it.id}>
        {renderItem(it)}
        {it.section.open && (
          <div className="menu-section">
            {it.section.table && <ControlsTable schema={it.section.table} />}
            {it.section.items.map(renderEntry)}
          </div>
        )}
      </Fragment>
    ) : it.dropdown ? (
      <Fragment key={it.id}>
        {renderItem(it)}
        {it.dropdown.open && (
          <div className="menu-options" role="listbox">
            {it.dropdown.options.map((option) => (
              <button
                key={option.id}
                className={`btn menu-option${option.selected ? ' selected' : ''}${s.menuFocus === option.id ? ' focused' : ''}`}
                role="option"
                aria-selected={option.selected}
                disabled={option.disabled}
                title={option.title}
                onClick={blurThen(() => engine.menuAction(option.id))}
              >
                {option.icon && <img className="menu-icon" src={menuItemIconURL(option.icon)} alt="" draggable={false} />}
                <span className="option-label">{option.label}</span>
                {option.selected && <img className="menu-icon" src={menuItemIconURL('check')} alt="" draggable={false} />}
              </button>
            ))}
          </div>
        )}
      </Fragment>
    ) : (
      renderItem(it)
    );
  // a leading Back button goes at the very top, above the save-name row
  const back = model.items[0]?.id === 'back' ? model.items[0] : null;
  const rest = (back ? model.items.slice(1) : model.items).filter((it) => !(s.menu === 'save' && it.id === 'savenew'));

  return (
    <div className={`screen-center${s.screen === 'playing' ? ' dim' : ''}`}>
      <div className={`panel menu-panel${s.menu === 'options' && s.section === 'controls' ? ' controls-panel' : ''}`}>
        <h2>{model.title}</h2>
        {back && <div className="menu-items menu-back">{renderItem(back)}</div>}
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
        {rest.length > 0 && <div className="menu-items">{rest.map(renderEntry)}</div>}
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
