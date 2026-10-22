import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Engine } from './game/engine.js';
import { TOOLS } from './game/tools.js';
import { toolIconURL } from './game/icons.js';
import { menuModel, splitLabel } from './game/menu.js';
import { menuItemIconURL } from './game/menuIcons.js';
import { CONTROL_SCHEMAS, CONTROL_COLUMNS } from './game/controls.js';
import { cellURL } from './game/inputIcons.js';
import { getLogs } from './game/debugLog.js';
import { claudePrompt } from './game/claudePrompt.js';
import { debugSections } from './game/debugSections.js';
import { playTick } from './game/audio.js';

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
      {/* (the Game panel, Hud: hidden for now) */}
      {s.screen === 'playing' && !s.inXR && !s.paused && s.gamepadAim && <div className="crosshair" />}
      {s.screen === 'playing' && flat && (
        // the left column: Options, and the Debug panel as the next row beneath it
        <div className="side-stack">
          <MenuScreen engine={engine} s={s} />
          {s.debugMode && <DebugPanel engine={engine} />}
        </div>
      )}
      {s.screen === 'playing' && flat && (
        // the right column: the Right panel (who you are: Observer or the creature; the tools)
        <div className="side-stack side-stack-right">
          <RightPanel engine={engine} s={s} />
        </div>
      )}
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

/** blurThen, with the menu's click sound (the engine's menu buttons play theirs in menuAction). */
function tickThen(fn) {
  return blurThen((e) => {
    playTick();
    fn(e);
  });
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

/** The bottom-left HUD (Game): the game time and Mean Diameter. */
function Hud({ s }) {
  const leftRef = useRef(null);
  // its size (drag its grip; double-click resets): it grows up / right
  const [leftSize, leftGrip] = useHudSize('hudLeft', leftRef, +1);
  return (
    <>
      <div className="hud-wrap">
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
          </div>
        </div>
      </div>
    </>
  );
}

/** Side panel sizes (px): drag a panel's bottom-right corner; its contents keep their size. 0 = automatic. */
const PANEL_SIZE = { minWidth: 220, minHeight: 120, margin: 24 };

/**
 * Resizing for a side panel (Options, Debug, the Right panel): returns [style, grip props].
 * Dragging the grip down makes it taller, outward (`outward` = +1 right, -1 left) wider;
 * double-click goes back to the automatic size. Remembered in this browser under `key`.
 */
function usePanelSize(key, panelRef, outward = +1) {
  const [width, setWidth] = useStoredNumber(`${key}.width`, 0);
  const [height, setHeight] = useStoredNumber(`${key}.height`, 0);
  const start = useRef(null);
  const grip = {
    onStart: () => (start.current = { width: panelRef.current?.offsetWidth || 300, height: panelRef.current?.offsetHeight || 300 }),
    onDrag: (up, right) => {
      const s0 = start.current;
      if (!s0) return;
      setWidth(Math.round(clamp(s0.width + right * outward, PANEL_SIZE.minWidth, window.innerWidth - PANEL_SIZE.margin)));
      setHeight(Math.round(clamp(s0.height - up, PANEL_SIZE.minHeight, window.innerHeight - PANEL_SIZE.margin)));
    },
    onReset: () => {
      setWidth(0);
      setHeight(0);
    },
  };
  const style = { ...(width ? { width } : {}), ...(height ? { height } : {}) };
  return [style, grip];
}

/**
 * One of the Debug panel's sections, drawn like an Options section: a menu button ("Title:
 * summary", a chevron) that opens its content beneath it, indented. Open or closed is shared
 * with the XR debug tablet (debugSections.js) and remembered in this browser.
 */
function DebugSection({ id, icon, title, summary, children }) {
  const collapsed = useSyncExternalStore(debugSections.subscribe, debugSections.getSnapshot)[id];
  return (
    <>
      <button className="btn menu-btn" aria-expanded={!collapsed} onClick={tickThen(() => debugSections.toggle(id))}>
        <img className="menu-icon" src={menuItemIconURL(icon)} alt="" draggable={false} />
        <MenuLabel text={summary ? `${title}: ${summary}` : title} />
        <img className="menu-icon menu-arrow" src={menuItemIconURL(collapsed ? 'dropdown' : 'dropdownOpen')} alt="" draggable={false} />
      </button>
      {!collapsed && <div className="menu-section debug-section-body">{children}</div>}
    </>
  );
}

/**
 * Options → Debug (browser): a side panel under Options, the next row of the left column. Its
 * terminal button opens and closes it (closed, only the button shows); open, Performance (FPS
 * and timings), the Inspector (the selected / targeted block's properties), Claude (a
 * placeholder for now) and Logging (the recent console log) each open beneath their buttons.
 * Resized from its bottom-right corner (double-click resets). Polls the engine a few times a
 * second rather than every frame.
 */
function DebugPanel({ engine }) {
  const [, setTick] = useState(0);
  const [open, setOpen] = useStoredNumber('debugOpen', 1);
  const panelRef = useRef(null);
  const [size, grip] = usePanelSize('debugPanel', panelRef);
  const logRef = useRef(null);
  const stick = useRef(true); // keep the log scrolled to the bottom unless the user scrolled up
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [open]);
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const button = (
    <button
      className="btn side-toggle"
      title="Debug (` / ~ hides it)"
      aria-label={open ? 'Collapse debug' : 'Debug'}
      aria-expanded={!!open}
      onClick={tickThen(() => setOpen(open ? 0 : 1))}
    >
      <img src={menuItemIconURL('debug')} alt="" draggable={false} />
    </button>
  );
  if (!open) {
    return (
      <aside className="side-panel collapsed">
        <header className="side-header">{button}</header>
      </aside>
    );
  }
  const info = engine.debugInfo();
  const logs = getLogs(1000);
  const ms = (v, digits) => (v == null ? '—' : `${v.toFixed(digits)} ms`);
  return (
    <aside className="side-panel debug-panel" ref={panelRef} style={size}>
      <ResizeGrip place="grip-bottom-right" title="Drag to resize (double-click: reset)" {...grip} />
      <header className="side-header">
        {button}
        <h2>Debug</h2>
      </header>
      <div className="side-body menu-items">
        <DebugSection id="performance" icon="performance" title="Performance" summary={`${engine.fps.toFixed(0)} FPS`}>
          <div className="debug-box">
            <table className="debug-table">
              <tbody>
                <tr><th>FPS</th><td>{engine.fps.toFixed(0)}</td></tr>
                <tr><th>Turn</th><td>{ms(engine.turnMs, 1)}</td></tr>
                <tr><th>Anim</th><td>{ms(engine.animMs, 2)}</td></tr>
                <tr><th>Render</th><td>{ms(engine.renderMs, 2)}</td></tr>
              </tbody>
            </table>
          </div>
        </DebugSection>
        <DebugSection id="inspector" icon="inspector" title="Inspector" summary={info.title}>
          <div className="debug-box">
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
          </div>
        </DebugSection>
        {/* Claude: a placeholder for now — not wired to the Claude bridge (claudeBridge.js) yet */}
        <DebugSection id="claude" icon="claude" title="Claude" summary="Not connected">
          <ClaudePrompt />
        </DebugSection>
        <DebugSection id="logging" icon="logging" title="Logging" summary={`${logs.length} lines`}>
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
    </aside>
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
          onClick={tickThen(() => claudePrompt.toggleSpeech())}
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
          onClick={tickThen(() => claudePrompt.toggleDictation())}
          disabled={!micSupported}
          title={micSupported ? (listening ? 'Stop dictating' : 'Dictate') : 'No dictation in this browser: use the keyboard’s mic'}
        >
          <img src={menuItemIconURL('mic')} alt="Dictate" draggable={false} />
        </button>
        <button className="btn icon-btn" onClick={tickThen(() => claudePrompt.clear())} title="Clear">
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

/** The glyph of the button that does something (inputIcons.js tokens), at the menu's icon height. */
function ActionGlyph({ tokens }) {
  const glyph = cellURL(tokens, 64);
  return <img className="action-glyph" src={glyph.url} style={{ aspectRatio: `${glyph.w} / ${glyph.h}` }} alt="" draggable={false} />;
}

/**
 * The Right panel, in the top-right corner (the XR Right HUD's twin, on the right controller):
 * its eye button shows it or hides all but the button (remembered); its title says who you are,
 * Observer or, under Creature controls, the controlled creature's type; the selected creature's
 * actions, when it has any (Eat: the button for it on the input in use, and the blocks it could
 * eat; Excrete: the button and the block that would come out; clicking one does it); under
 * Observer controls, a Tools dropdown showing the current tool, which opens the tool selector
 * beneath it in a dark well (like the Inspector's). Resized from its bottom-left corner (double-click resets).
 */
function RightPanel({ engine, s }) {
  const open = s.rightHudOpen;
  const panelRef = useRef(null);
  const [size, grip] = usePanelSize('rightPanel', panelRef, -1);
  const eye = (
    <button
      className="btn side-toggle"
      title={open ? 'Hide' : 'Show'}
      aria-label={open ? 'Hide the panel' : 'Show the panel'}
      aria-expanded={!!open}
      onClick={blurThen(() => engine.toggleRightHud())}
    >
      <img src={menuItemIconURL('eye')} alt="" draggable={false} />
    </button>
  );
  if (!open) {
    return (
      <aside className="side-panel collapsed">
        <header className="side-header">{eye}</header>
      </aside>
    );
  }
  const tools = engine.toolsAvailable(s);
  const { eat, excrete } = s.actions;
  const glyphs = Engine.ACTION_GLYPHS[s.inputDevice] ?? Engine.ACTION_GLYPHS.mk;
  const style = { materials: s.materials, smooth: s.smoothRendering };
  const blockIcon = (type) => toolIconURL(TOOLS.find((t) => t.block === type) ?? { id: type, block: type }, 64, style);
  // an action: its button's glyph, its name, the blocks it concerns at the right
  const action = (name, tokens, types, run) => {
    return (
      <button className="btn menu-btn action-btn" onClick={blurThen(run)}>
        <ActionGlyph tokens={tokens} />
        <span className="label"><span className="name">{name}</span></span>
        <span className="action-blocks">
          {types.map((type) => {
            const name = TOOLS.find((t) => t.block === type)?.label ?? type;
            return <img key={type} className="menu-icon" src={blockIcon(type)} alt={name} title={name} draggable={false} />;
          })}
        </span>
      </button>
    );
  };
  const body = tools || eat.length > 0 || excrete;
  return (
    <aside className="side-panel right-panel" ref={panelRef} style={size}>
      <ResizeGrip place="grip-bottom-left" title="Drag to resize (double-click: reset)" {...grip} />
      <header className={`side-header${body ? '' : ' alone'}`}>
        {eye}
        <h2>{engine.rightHudTitle(s)}</h2>
      </header>
      {body && (
        <div className="side-body menu-items">
          {eat.length > 0 && action('Consume', glyphs.eat, eat, () => engine.selectedEat())}
          {excrete && action('Excrete', glyphs.excrete, [excrete], () => engine.selectedExcrete())}
          {tools && <>
          {/* the Tool dropdown: the use-the-tool button's glyph, "Tool", the current tool (its icon, its name) */}
          <button className="btn menu-btn action-btn" aria-expanded={!!s.toolsOpen} onClick={tickThen(() => engine.toggleToolsOpen())}>
            <ActionGlyph tokens={glyphs.tool} />
            <span className="label">
              <span className="name">Tool:</span>
              <span className="value tool-value">
                <img className="menu-icon" src={toolIconURL(TOOLS[s.toolIndex], 64, style)} alt="" draggable={false} />
                {engine.toolLabel(s)}
              </span>
            </span>
            <img className="menu-icon menu-arrow" src={menuItemIconURL(s.toolsOpen ? 'dropdownOpen' : 'dropdown')} alt="" draggable={false} />
          </button>
          {s.toolsOpen && (
            <div className="menu-section">
              <div className="debug-box tool-slots">
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
              </div>
            </div>
          )}
          </>}
        </div>
      )}
    </aside>
  );
}

/**
 * Options, in the top-left corner: its gear button opens it (pausing the game) and closes it
 * again (resuming); closed, only the gear shows. Load and Save (Options → File) open in it too.
 */
function MenuScreen({ engine, s }) {
  const open = engine.isMenuOpen(s);
  const panelRef = useRef(null);
  const [size, grip] = usePanelSize('optionsPanel', panelRef);
  const gear = (
    <button
      className="btn side-toggle"
      title="Options (Esc)"
      aria-label={open ? 'Close options' : 'Options'}
      aria-expanded={open}
      onClick={blurThen(() => engine.toggleMenu())}
    >
      <img src={menuItemIconURL('gear')} alt="" draggable={false} />
    </button>
  );
  if (!open) {
    return (
      <aside className="side-panel collapsed">
        <header className="side-header">{gear}</header>
      </aside>
    );
  }
  return <MenuBody engine={engine} s={s} gear={gear} panelRef={panelRef} size={size} grip={grip} />;
}

function MenuBody({ engine, s, gear, panelRef, size, grip }) {
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
          onChange={(e) => engine._setSlider(it.id, Number(e.target.value))}
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
    <aside className={`side-panel menu-panel${s.menu === 'main' && s.section === 'controls' ? ' controls-panel' : ''}`} ref={panelRef} style={size}>
      <ResizeGrip place="grip-bottom-right" title="Drag to resize (double-click: reset)" {...grip} />
      <header className="side-header">
        {gear}
        <h2>{model.title}</h2>
      </header>
      <div className="side-body">
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
    </aside>
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
