import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Engine } from './game/engine.js';
import { TOOLS } from './game/tools.js';
import { toolIconURL } from './game/icons.js';
import { menuModel, splitLabel } from './game/menu.js';
import { menuItemIconURL } from './game/menuIcons.js';
import { CONTROL_SCHEMAS, CONTROL_COLUMNS } from './game/controls.js';
import { cellURL } from './game/inputIcons.js';
import { debugModel } from './game/debugModel.js';
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

/**
 * View Mode → 3D: the UI is drawn once per eye (.eye copies): whatever is scrolled in one copy
 * (a menu, a panel's list) scrolls the same element in the other, found by its place in its copy.
 */
function useMirroredScroll(on) {
  useEffect(() => {
    if (!on) return;
    let mirroring = false;
    const pathIn = (el, root) => {
      const path = [];
      for (let n = el; n && n !== root; n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n));
      return path;
    };
    const follow = (root, path) => path.reduce((n, i) => n?.children[i], root);
    const onScroll = (e) => {
      const el = e.target;
      if (mirroring || !(el instanceof Element)) return;
      const eye = el.closest('.eye');
      if (!eye) return;
      const path = pathIn(el, eye);
      mirroring = true;
      for (const other of document.querySelectorAll('.eye')) {
        if (other === eye) continue;
        const twin = follow(other, path);
        if (twin) {
          twin.scrollTop = el.scrollTop;
          twin.scrollLeft = el.scrollLeft;
        }
      }
      requestAnimationFrame(() => (mirroring = false)); // (the twin's own scroll event, just caused, is ignored)
    };
    document.addEventListener('scroll', onScroll, true); // (scroll doesn't bubble: caught on the way down)
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [on]);
}

function Overlay({ engine }) {
  const s = useSyncExternalStore(engine.subscribe, engine.getState);
  // View Mode → 3D: SBS / Interlaced: the page's UI is drawn for each eye too, a little in front
  // of the screen (see .eye in styles.css)
  const stereo = !s.inXR && (s.screenView === 'sbs' || s.screenView === 'interlaced') ? s.screenView : null;
  useMirroredScroll(!!stereo);
  if (!stereo) return <OverlayView engine={engine} s={s} />;
  return ['left', 'right'].map((eye) => (
    <div key={eye} className={`eye eye-${stereo} eye-${eye}`} style={{ '--row': `${1 / (window.devicePixelRatio || 1)}px` }}>
      <OverlayView engine={engine} s={s} />
    </div>
  ));
}

function OverlayView({ engine, s }) {
  // the page's own HUD and menus: outside XR, and in front of the view in XR: Phone AR
  const flat = !s.inXR || engine.screenUI(s);
  return (
    <>
      {/* (the Game panel, Hud: hidden for now) */}
      {s.screen === 'playing' && !s.inXR && !s.paused && s.gamepadAim && <div className="crosshair" />}
      {s.screen === 'playing' && flat && (
        // the left column: Options, the Debug panel as the next row beneath it, then the View panel
        <div className="side-stack">
          <MenuScreen engine={engine} s={s} />
          {s.debugMode && <DebugPanel engine={engine} />}
          <ViewPanel engine={engine} s={s} />
        </div>
      )}
      {s.screen === 'playing' && flat && (
        // the right column: the Control menu (who you are: Observer or the creature; the tools)
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
        // (View Mode → 3D: SBS squeezes the page's UI to half width: a screen px is two of its own)
        const el = e.currentTarget;
        from.current = { x: e.clientX, y: e.clientY, sx: el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1 };
        onStart();
      }}
      onPointerMove={(e) => {
        if (from.current) onDrag(from.current.y - e.clientY, (e.clientX - from.current.x) / from.current.sx);
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
 * Resizing for a side panel (Options, Debug, the Control menu): returns [style, grip props].
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
 * One of the Debug panel's sections (debugModel.js), drawn like an Options section: a menu
 * button ("Title: summary", a chevron) that opens its content beneath it, indented. Open or
 * closed is shared with the XR Debug panel (debugSections.js) and remembered in this browser.
 */
function DebugSection({ item, children }) {
  return (
    <>
      <button className="btn menu-btn" aria-expanded={item.section.open} onClick={tickThen(() => debugSections.toggle(item.id.slice(8)))}>
        <img className="menu-icon" src={menuItemIconURL(item.icon)} alt="" draggable={false} />
        <MenuLabel text={item.label} />
        <img className="menu-icon menu-arrow" src={menuItemIconURL(item.section.open ? 'dropdownOpen' : 'dropdown')} alt="" draggable={false} />
      </button>
      {item.section.open && <div className="menu-section debug-section-body">{children}</div>}
    </>
  );
}

/**
 * Options → Debug (browser): a side panel under Options, the next row of the left column. Its
 * terminal button opens and closes it (closed, only the button shows); open, Performance (FPS
 * and timings), the Inspector (the selected / targeted block's properties) and Logging (the
 * recent console log) each open beneath their buttons.
 * Resized from its bottom-right corner (double-click resets). Polls the engine a few times a
 * second rather than every frame.
 */
function DebugPanel({ engine }) {
  const [, setTick] = useState(0);
  const open = !useSyncExternalStore(debugSections.subscribe, debugSections.getSnapshot).panel; // (shared with the XR tablet)
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
      onClick={tickThen(() => debugSections.toggle('panel'))}
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
  const model = debugModel(engine);
  return (
    <aside className="side-panel debug-panel" ref={panelRef} style={size}>
      <ResizeGrip place="grip-bottom-right" title="Drag to resize (double-click: reset)" {...grip} />
      <header className="side-header">
        {button}
        <h2>{model.title}</h2>
      </header>
      <div className="side-body menu-items">
        {model.items.map((it) => (
          <DebugSection key={it.id} item={it}>
            {it.section.rows && (
              <div className="debug-box">
                <table className="debug-table">
                  <tbody>
                    {it.section.rows.map(([k, v]) => (
                      <tr key={k}>
                        <th>{k}</th>
                        <td>{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {it.section.log && (
              <div
                className="debug-log"
                ref={logRef}
                onScroll={(ev) => {
                  const el = ev.currentTarget;
                  stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
                }}
              >
                {it.section.log.length ? (
                  it.section.log.map((entry, i) => (
                    <div key={i} className={`log-${entry.level}`}>
                      <span className="log-time">{entry.t}</span> {entry.text}
                    </div>
                  ))
                ) : (
                  <div className="log-empty">No log output yet</div>
                )}
              </div>
            )}
          </DebugSection>
        ))}
      </div>
    </aside>
  );
}


/** The glyph of the button that does something (inputIcons.js tokens), at the menu's icon height. */
function ActionGlyph({ tokens }) {
  const glyph = cellURL(tokens, 64);
  return <img className="action-glyph" src={glyph.url} style={{ aspectRatio: `${glyph.w} / ${glyph.h}` }} alt="" draggable={false} />;
}

/** An action's name as the Controls dropdown shows it: short (what it's for goes without saying). */
const guideName = (action) => action.replace(/ \((selected creature|pauses)\)$/, '').replace(/^Move selected creature$/, 'Move');

/**
 * What each mouse button / gamepad button does under control schema `schema` (controls.js), as
 * Map token -> action names, from the schema's `device` ('mk' | 'pad') bindings: a binding's
 * buttons count until a "+" (what follows only modifies it), "/" starts another.
 */
function buttonActions(schema, device) {
  const out = new Map();
  for (const row of schema.controls) {
    if (row.action.startsWith('Menu ')) continue; // (in the menus only: not what the button does in play)
    const name = guideName(row.action);
    const g = row[device]?.g ?? [];
    let modifier = false;
    g.forEach((token, i) => {
      if (token === 'sep:+') modifier = true;
      else if (token === 'sep:/') modifier = false;
      else if (!modifier && !token.startsWith('sep:') && !token.startsWith('text:')) {
        const label = g[i + 1] === 'text:×2' ? `${name} (×2)` : name; // (a double-click)
        if (!out.has(token)) out.set(token, []);
        if (!out.get(token).includes(label)) out.get(token).push(label);
      }
    });
  }
  return out;
}

/**
 * A device drawn in the middle of a 300-wide SVG (`shape`), and labels in a column either
 * side, each with a leader line to its button: `anchors` [{ tokens, x, y, side }] (a button,
 * labelled with what its tokens do: `actions`, and its `press` token's after "click:");
 * buttons that do nothing are left out. Each label sits level with its button where it can
 * (its line runs straight across); labels that would overlap are moved apart as a group,
 * centred on their buttons. `side: 'bottom'`: under the drawing (at `below`), its line straight
 * down. The drawing grows to fit.
 */
function LabelledDiagram({ shape, anchors, actions, height: minHeight, below = minHeight, above = 4 }) {
  const W = 300, COL = 92, LINE = 10, PAD = 2, GAP = 3;
  const named = (tokens) => [...new Set(tokens.flatMap((t) => actions.get(t) ?? []))].join(', ');
  const shown = anchors.map((a) => {
    const click = a.press ? named([a.press]) : '';
    return { ...a, text: [named(a.tokens), click && `click: ${click}`].filter(Boolean).join('; ') };
  }).filter((a) => a.text);
  const place = (side) => {
    // top to bottom as the buttons sit; level ones: the one further from the column first (its line passes above)
    const col = shown.filter((a) => a.side === side).sort((a, b) => a.y - b.y || (side === 'left' ? b.x - a.x : a.x - b.x));
    const items = col.map((a) => ({ ...a, h: Math.min(3, Math.ceil(a.text.length / 17)) * LINE + PAD * 2 }));
    // groups of labels that touch, each centred on the mean height of its buttons
    let groups = [];
    for (const a of items) {
      groups.push({ items: [a], h: a.h, mid: a.y });
      for (;;) {
        const g = groups.at(-1), prev = groups.at(-2);
        if (!prev || prev.mid + prev.h / 2 + GAP <= g.mid - g.h / 2) break;
        const merged = [...prev.items, ...g.items];
        const h = merged.reduce((t, b) => t + b.h, 0) + GAP * (merged.length - 1);
        groups.splice(-2, 2, { items: merged, h, mid: merged.reduce((t, b) => t + b.y, 0) / merged.length });
      }
    }
    return groups.flatMap((g) => {
      let y = g.mid - g.h / 2;
      return g.items.map((a) => {
        const ly = y;
        y += a.h + GAP;
        return { ...a, ly };
      });
    });
  };
  const bottom0 = shown.filter((a) => a.side === 'bottom').map((a) => ({ ...a, h: Math.min(3, Math.ceil(a.text.length / 24)) * LINE + PAD * 2, ly: below }));
  const top0 = shown.filter((a) => a.side === 'top').map((a) => ({ ...a, h: LINE + PAD * 2, ly: above }));
  const labels = [...place('left'), ...place('right'), ...bottom0, ...top0];
  const top = Math.min(0, ...labels.map((a) => a.ly - 4));
  const bottom = Math.max(minHeight, ...labels.map((a) => a.ly + a.h + 4));
  return (
    <svg className="cg-diagram" viewBox={`0 ${top} ${W} ${bottom - top}`} role="img">
      {shape}
      {labels.map((a) => {
        const down = a.side === 'bottom', up = a.side === 'top', BW = 130;
        const lx = down || up ? a.x : a.side === 'left' ? COL : W - COL;
        // (a top label stands beside its line's end: left of it, right-aligned, or right of it)
        const fx = up ? (a.align === 'right' ? a.x - 3 - COL : a.x + 3) : down ? Math.min(W - BW, Math.max(0, a.x - BW / 2)) : a.side === 'left' ? 0 : W - COL + 3;
        const cls = up ? (a.align === 'right' ? 'left' : 'right') : a.side;
        return (
          <g key={a.tokens.join()}>
            <line x1={a.x} y1={a.y} x2={lx} y2={down ? a.ly : a.ly + a.h / 2} className="cg-lead" />
            <circle cx={a.x} cy={a.y} r={1.8} className="cg-dot" />
            <foreignObject x={fx} y={a.ly} width={down ? BW : COL - 3} height={a.h}>
              <div className={`cg-label ${cls}`} title={a.text}>{a.text}</div>
            </foreignObject>
          </g>
        );
      })}
    </svg>
  );
}

const MOUSE_SHAPE = (
  <g className="cg-shape">
    <path d="M150 22 C128 22 122 40 122 62 L122 112 C122 136 134 150 150 150 C166 150 178 136 178 112 L178 62 C178 40 172 22 150 22 Z" />
    <path d="M122 70 L178 70 M150 22 L150 70" />
    <rect x="146" y="38" width="8" height="18" rx="4" className="cg-key" />
  </g>
);
const MOUSE_ANCHORS = [
  { tokens: ['mouse:L'], x: 132, y: 40, side: 'left' },
  { tokens: ['mouse:M'], x: 147, y: 54, side: 'left' },
  { tokens: ['mouse:move'], x: 140, y: 118, side: 'left' },
  { tokens: ['mouse:wheel'], x: 153, y: 40, side: 'right' },
  { tokens: ['mouse:R'], x: 168, y: 58, side: 'right' },
];

const PAD_SHAPE = (
  <g className="cg-shape">
    <rect x="108" y="36" width="24" height="9" rx="3" />
    <rect x="168" y="36" width="24" height="9" rx="3" />
    <rect x="104" y="47" width="32" height="7" rx="3" />
    <rect x="164" y="47" width="32" height="7" rx="3" />
    <path d="M118 56 L182 56 C200 56 206 70 210 96 C214 122 208 138 196 138 C186 138 180 126 174 116 L126 116 C120 126 114 138 104 138 C92 138 86 122 90 96 C94 70 100 56 118 56 Z" />
    <circle cx="122" cy="76" r="9" className="cg-key" />
    <circle cx="166" cy="98" r="9" className="cg-key" />
    <path d="M131 92 h6 v4 h4 v6 h-4 v4 h-6 v-4 h-4 v-6 h4 z" className="cg-key" />
    <circle cx="180" cy="68" r="4" className="cg-key" />
    <circle cx="172" cy="76" r="4" className="cg-key" />
    <circle cx="188" cy="76" r="4" className="cg-key" />
    <circle cx="180" cy="84" r="4" className="cg-key" />
    <circle cx="142" cy="72" r="2.6" className="cg-key" />
    <circle cx="158" cy="72" r="2.6" className="cg-key" />
  </g>
);
const PAD_ANCHORS = [
  { tokens: ['pad:LT'], x: 116, y: 40, side: 'left' },
  { tokens: ['pad:LB'], x: 112, y: 50, side: 'left' },
  { tokens: ['pad:view'], x: 142, y: 72, side: 'top', align: 'right' },
  { tokens: ['stick:L:any'], press: 'stick:L:press', x: 122, y: 76, side: 'left' },
  { tokens: ['dpad:any', 'dpad:ud'], x: 134, y: 99, side: 'left' },
  { tokens: ['pad:RT'], x: 184, y: 40, side: 'right' },
  { tokens: ['pad:RB'], x: 188, y: 50, side: 'right' },
  { tokens: ['pad:start'], x: 158, y: 72, side: 'top', align: 'left' },
  { tokens: ['pad:Y'], x: 180, y: 68, side: 'right' },
  { tokens: ['pad:X'], x: 172, y: 76, side: 'right' },
  { tokens: ['pad:B'], x: 188, y: 76, side: 'right' },
  { tokens: ['pad:A'], x: 180, y: 84, side: 'right' },
  { tokens: ['stick:R:any'], press: 'stick:R:press', x: 166, y: 98, side: 'bottom' },
];

/**
 * The Control menu's Controls dropdown (windowed): what the input in use does now, under the
 * current control schema. Mouse and keyboard: the mouse with its buttons labelled, then each
 * key and its action; a gamepad: the gamepad with its buttons labelled.
 */
function ControlsGuide({ s }) {
  const schema = CONTROL_SCHEMAS[s.controlSchema] ?? CONTROL_SCHEMAS.observer;
  if (s.inputDevice === 'pad') return <LabelledDiagram shape={PAD_SHAPE} anchors={PAD_ANCHORS} actions={buttonActions(schema, 'pad')} height={180} below={146} />;
  const keys = schema.controls
    .map((row) => ({ name: guideName(row.action), g: (row.mk?.g ?? []).filter((t) => t.startsWith('key:') || t === 'sep:/') }))
    .filter((k) => !k.name.startsWith('Menu '))
    .filter((k) => k.g.some((t) => t.startsWith('key:')))
    .map((k) => ({ ...k, g: k.g.filter((t, i, a) => t !== 'sep:/' || (i > 0 && i < a.length - 1 && a[i - 1] !== 'sep:/')) }));
  return (
    <>
      <LabelledDiagram shape={MOUSE_SHAPE} anchors={MOUSE_ANCHORS} actions={buttonActions(schema, 'mk')} height={170} />
      <div className="cg-keys">
        {keys.map((k) => (
          <div key={k.name} className="cg-key-row">
            <ActionGlyph tokens={k.g} />
            <span>{k.name}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * The Control menu, in the top-right corner (its XR twin, on the right controller):
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
  const { eat, excrete, mate = [] } = s.actions;
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
  const guide = !s.inXR; // (windowed: its Controls dropdown; in XR, Options → Accessibility → Controller Guide)
  const body = tools || eat.length > 0 || excrete || mate.length > 0 || guide;
  return (
    <aside className="side-panel right-panel" ref={panelRef} style={size}>
      <ResizeGrip place="grip-bottom-left" title="Drag to resize (double-click: reset)" {...grip} />
      <header className={`side-header${body ? '' : ' alone'}`}>
        {eye}
        <h2>{engine.rightHudTitle(s)}</h2>
      </header>
      {body && (
        <div className="side-body menu-items">
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
                    title={t.label}
                    onClick={blurThen(() => engine.selectTool(i))}
                  >
                    <img src={toolIconURL(t, 96, { materials: s.materials, smooth: s.smoothRendering })} alt={t.label} draggable={false} />
                  </button>
                ))}
              </div>
            </div>
          )}
          </>}
          {guide && <>
          {/* the Controls dropdown: what the mouse and keys, or the gamepad, do now */}
          <button className="btn menu-btn action-btn" aria-expanded={!!s.controlsGuideOpen} onClick={tickThen(() => engine.toggleControlsGuideOpen())}>
            <img className="menu-icon" src={menuItemIconURL('controls')} alt="" draggable={false} />
            <span className="label"><span className="name">Controls</span></span>
            <img className="menu-icon menu-arrow" src={menuItemIconURL(s.controlsGuideOpen ? 'dropdownOpen' : 'dropdown')} alt="" draggable={false} />
          </button>
          {s.controlsGuideOpen && (
            <div className="menu-section">
              <div className="debug-box controls-guide">
                <ControlsGuide s={s} />
              </div>
            </div>
          )}
          </>}
          {/* what the selected creature can do now: at the bottom */}
          {eat.length > 0 && action('Consume', glyphs.eat, eat, () => engine.selectedEat())}
          {excrete && action('Excrete', glyphs.excrete, [excrete], () => engine.selectedExcrete())}
          {s.actions.mate?.length > 0 && action('Mate', glyphs.mate, s.actions.mate, () => engine.selectedMate())}
        </div>
      )}
    </aside>
  );
}

/**
 * Options, in the top-left corner: its gear button opens it (pausing the game) and closes it
 * again (resuming); closed, only the gear shows. Load and Save (Options → File) open in it too.
 */
/**
 * The View panel: one button, to switch between the Normal view (the monitor) and XR: HMD Stereo
 * (the headset): it shows the one it switches to. Only where a headset can be used.
 */
function ViewPanel({ engine, s }) {
  if (!s.views.includes('hmd')) return null;
  const label = s.inXR ? 'Normal view' : 'XR: HMD Stereo';
  return (
    <aside className="side-panel collapsed">
      <header className="side-header">
        <button className="btn side-toggle" title={label} aria-label={label} onClick={blurThen(() => engine.toggleHmd())}>
          <img src={menuItemIconURL(s.inXR ? 'monitor' : 'xr')} alt="" draggable={false} />
        </button>
      </header>
    </aside>
  );
}

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
  // moving through the menu with the arrows / D-pad: the focused item scrolls into view
  useEffect(() => {
    panelRef.current?.querySelector('.focused')?.scrollIntoView({ block: 'nearest' });
  }, [s.menuFocus, s.menu, s.section, s.dropdown]);

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
