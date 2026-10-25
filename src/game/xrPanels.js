import * as THREE from 'three';
import { TOOLS } from './tools.js';
import { drawToolIcon, roundRect } from './icons.js';
import { drawMenuItemIcon } from './menuIcons.js';
import { CONTROL_SCHEMAS, CONTROL_COLUMNS } from './controls.js';
import { splitLabel } from './menu.js';
import { gridMode } from './lattice.js';
/** The rows of the Controls table of control schema `table` (id). */
const tableRows = (table) => (CONTROL_SCHEMAS[table] ?? CONTROL_SCHEMAS.observer).controls;
import { drawCell, cellWidth } from './inputIcons.js';

/** Every XR panel's thickness: a slab this deep (m, in the world) behind its face (its corners rounded like the face's frame). */
const PANEL_DEPTH_M = 0.01;
const SLAB_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x1c2230, roughness: 0.55, metalness: 0.15, transparent: true, opacity: 0.8, depthWrite: false }); // (slightly see-through)

/** A flat plane textured with a 2D canvas, used for in-world UI panels in XR (with a slab behind it: updateSlab). */
class CanvasPanel {
  constructor(pxW, pxH, widthM) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const heightM = (widthM * pxH) / pxW;
    // (alphaTest: the clear rest of the canvas doesn't write depth, or it would hide or z-fight a
    // panel beside it; front only: from behind, its slab's back shows: updateSlab)
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, alphaTest: 0.01, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), this.material);
    this.mesh.renderOrder = 10;
    this.pxPerM = pxW / widthM; // pixel density (at scale 1): resizing keeps it, so the contents keep their size
    this.dockScale = 1; // its scale docked on a controller (each panel's density × this comes out about the same)
    this.box = null; // the visible panel (canvas px: { x, y, w, h }), set by draw; the rest of the canvas is clear
    this.button = null; // its toggle button (canvas px)
    this.isOpen = false; // open (not just its button): only then is it resizable
    this.limits = null; // the visible panel's size limits (m at scale 1: { minWidth, maxWidth, minHeight, maxHeight })
    this.boxMarginPx = 0; // canvas px around the visible panel (both sides together)
    this.corner = null; // where its resize handle is: 'br' (free: the top left stays put), 'tr' (docked: it stands on its bottom edge) or null (none)
    this.handleHot = false; // its resize handle is pointed at or dragged
  }

  /** Canvas px per mm as seen docked: frames and buttons are drawn to the same mm on every panel. */
  get pxPerMm() {
    return this.pxPerM / this.dockScale / 1000;
  }

  /** The plane's size (m, at scale 1). */
  get width() {
    return this.mesh.geometry.parameters.width;
  }

  get height() {
    return this.mesh.geometry.parameters.height;
  }

  /**
   * Makes the visible panel `widthM` × `heightM` (m at scale 1, within `limits`): a bigger or
   * smaller canvas at the same pixel density, so the contents don't scale.
   */
  resizeBox(widthM, heightM) {
    const L = this.limits;
    if (!L) return;
    const w = THREE.MathUtils.clamp(widthM, L.minWidth, L.maxWidth), h = THREE.MathUtils.clamp(heightM, L.minHeight, L.maxHeight);
    this._setCanvasSize(Math.round(w * this.pxPerM) + this.boxMarginPx, Math.round(h * this.pxPerM) + this.boxMarginPx);
  }

  /** What to remember of its size ({ width, height }: canvas px), and putting it back (see resizeBox). */
  get size() {
    return { width: this.canvas.width, height: this.canvas.height };
  }

  set size({ width, height }) {
    if (Number.isFinite(width) && Number.isFinite(height)) this.resizeBox((width - this.boxMarginPx) / this.pxPerM, (height - this.boxMarginPx) / this.pxPerM);
  }

  /** The canvas `pxW` × `pxH`, the plane to match, keeping its top-left corner where it is. */
  _setCanvasSize(pxW, pxH) {
    if (pxW === this.canvas.width && pxH === this.canvas.height) return;
    const w = pxW / this.pxPerM, h = pxH / this.pxPerM;
    // the plane is centred on the mesh's position
    const shift = new THREE.Vector3((w - this.width) / 2, -(h - this.height) / 2, 0).multiplyScalar(this.mesh.scale.x).applyQuaternion(this.mesh.quaternion);
    this.mesh.position.add(shift);
    this.canvas.width = pxW;
    this.canvas.height = pxH;
    // a texture can't change size once uploaded: a new one for the new canvas
    this.texture.dispose();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material.map = this.texture;
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.PlaneGeometry(w, h);
    this._last = ''; // redraw
  }

  /** The resize handle's square (canvas px across: the same size in metres on every panel). */
  get _gripPx() {
    return Math.round(RESIZE_GRIP_M * this.pxPerM);
  }

  /** Whether `uv` (a ray hit) is on the resize handle (open, with a `corner`). */
  onResizeHandle(uv) {
    const b = this.box, g = this._gripPx;
    if (!this.isOpen || !this.corner || !this.limits || !b) return false;
    const { px, py } = this._px(uv);
    if (px < b.x + b.w - g || px > b.x + b.w) return false;
    return this.corner === 'tr' ? py >= b.y && py <= b.y + g : py >= b.y + b.h - g && py <= b.y + b.h;
  }

  /** The resize handle: diagonal ridges in its corner of the visible panel. */
  _drawResizeHandle(ctx) {
    const b = this.box;
    if (!this.isOpen || !this.corner || !this.limits || !b) return;
    const k = this._gripPx / 64, inset = 14 * k;
    const right = b.x + b.w - inset, cy = this.corner === 'tr' ? b.y + inset : b.y + b.h - inset, dir = this.corner === 'tr' ? 1 : -1;
    ctx.save();
    ctx.strokeStyle = this.handleHot ? '#9cc8ff' : 'rgba(255,255,255,0.4)';
    ctx.lineWidth = (this.handleHot ? 5 : 3) * k;
    ctx.lineCap = 'round';
    for (const d of [18, 32, 46]) {
      ctx.beginPath();
      ctx.moveTo(right - d * k, cy);
      ctx.lineTo(right, cy + dir * d * k);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** `uv` (a ray hit) in canvas px. */
  _px(uv) {
    return { px: uv.x * this.canvas.width, py: (1 - uv.y) * this.canvas.height };
  }

  /** Whether `uv` (a ray hit) is on the visible panel. */
  inBox(uv) {
    const b = this.box;
    if (!b) return false;
    const { px, py } = this._px(uv);
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  }

  /** Whether `uv` is on the toggle button. */
  onToggle(uv) {
    const b = this.button;
    if (!b) return false;
    const { px, py } = this._px(uv);
    return px >= b.x - 8 && px <= b.x + b.w + 8 && py >= b.y - 8 && py <= b.y + b.h + 8;
  }

  /**
   * Call per frame (while shown): the panel's 3D body, a slab PANEL_DEPTH_M deep in the world
   * (whatever the panel's scale) behind the visible panel, its outline the frame's (a rounded
   * rectangle: rounded at the 4 corners, straight front and back edges). Rebuilt only when its
   * size changes.
   */
  updateSlab() {
    const b = this.boxMetres(), s = this.mesh.scale.x || 1;
    const w = b.right - b.left, h = b.top - b.bottom, d = PANEL_DEPTH_M / s;
    if (w <= 0 || h <= 0) return;
    const r = Math.min((FRAME_RADIUS_MM + FRAME_LINE_MM / 2) / 1000 / this.dockScale, w / 2, h / 2); // (the frame's outer corner, in the panel's metres)
    if (!this.slab) {
      this.slab = new THREE.Mesh(new THREE.BufferGeometry(), SLAB_MATERIAL);
      this.slab.raycast = () => {}; // (the face is what's pointed at)
      this.slab.name = 'xr-panel-slab';
      this.mesh.add(this.slab);
      this.slab.renderOrder = this.mesh.renderOrder - 1; // (behind its face: drawn first)
    }
    const key = `${w.toFixed(4)}|${h.toFixed(4)}|${d.toFixed(4)}`;
    if (key !== this._slabKey) {
      this._slabKey = key;
      this.slab.geometry.dispose();
      const shape = new THREE.Shape(), x0 = -w / 2, y0 = -h / 2, x1 = w / 2, y1 = h / 2;
      shape.moveTo(x0 + r, y0);
      shape.lineTo(x1 - r, y0);
      shape.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0);
      shape.lineTo(x1, y1 - r);
      shape.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2);
      shape.lineTo(x0 + r, y1);
      shape.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI);
      shape.lineTo(x0, y0 + r);
      shape.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5);
      this.slab.geometry.dispose();
      this.slab.geometry = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false, curveSegments: 6 });
    }
    this.slab.position.set((b.left + b.right) / 2, (b.top + b.bottom) / 2, -d - 0.0003 / s); // (it runs from -d to just behind the face: no z-fighting)
  }

  /**
   * The visible panel on the plane, in metres from its centre (at scale 1): { left, right, top,
   * bottom }, and `button`: the toggle button's centre (x).
   */
  boxMetres() {
    const { width, height } = this.mesh.geometry.parameters, c = this.canvas;
    const sx = width / c.width, sy = height / c.height;
    const b = this.box ?? { x: 0, y: 0, w: c.width, h: c.height };
    const button = this.button ? this.button.x + this.button.w / 2 : b.x + b.w / 2;
    return { left: -width / 2 + b.x * sx, right: -width / 2 + (b.x + b.w) * sx, top: height / 2 - b.y * sy, bottom: height / 2 - (b.y + b.h) * sy, button: -width / 2 + button * sx };
  }
}

const RESIZE_GRIP_M = 0.022; // a panel's resize handle: a square this wide in its corner
const PX_TO_M = 0.17 / 1000; // the Control menu's pixel density (the others match it docked: see Engine's XR_PANELS)

const SLOT = 104, SLOT_GAP = 14;

// every panel's frame and toggle button, in mm as seen docked (see CanvasPanel.pxPerMm)
const FRAME_RADIUS_MM = 5.6, FRAME_LINE_MM = 0.6, BUTTON_RADIUS_MM = 2.3, BUTTON_LINE_MM = 0.8, TITLE_MM = 6.8;
/** A panel's title font (beside its toggle button): the same size on every panel. */
const TITLE_FONT = (panel) => `700 ${Math.round(TITLE_MM * panel.pxPerMm)}px system-ui, -apple-system, Segoe UI, sans-serif`;

/**
 * `panel`'s frame round its visible panel `box` (canvas px): the same dark fill, rim and
 * rounding on every panel; `highlight`: a bright rim (held or pointed at).
 */
function panelFrame(ctx, panel, box, highlight = false) {
  const k = panel.pxPerMm, line = FRAME_LINE_MM * k * (highlight ? 2 : 1);
  roundRect(ctx, box.x + line / 2, box.y + line / 2, box.w - line, box.h - line, FRAME_RADIUS_MM * k);
  ctx.fillStyle = 'rgba(18, 22, 30, 0.62)';
  ctx.fill();
  ctx.strokeStyle = highlight ? '#9cc8ff' : 'rgba(255,255,255,0.22)';
  ctx.lineWidth = line;
  ctx.stroke();
}

/**
 * `panel`'s toggle button (top left, like the windowed panels' header buttons): `icon` on it,
 * highlighted while pointed at.
 */
function toggleButton(ctx, panel, icon, hot) {
  const b = panel.button, k = panel.pxPerMm;
  roundRect(ctx, b.x, b.y, b.w, b.h, BUTTON_RADIUS_MM * k);
  ctx.fillStyle = hot ? 'rgba(90, 160, 255, 0.55)' : 'rgba(255,255,255,0.09)';
  ctx.fill();
  if (hot) {
    ctx.strokeStyle = '#9cc8ff';
    ctx.lineWidth = BUTTON_LINE_MM * k;
    ctx.stroke();
  }
  drawMenuItemIcon(ctx, icon, b.x + b.w / 2, b.y + b.h / 2, b.w * 0.66);
}

// the Control menu's layout (px): its header (the eye button, the title), the actions (Eat, Excrete:
// up to two rows), the Tools dropdown, then (open) the tools' well beneath it, indented
// (sizes match Options': its rows are as tall as Options' buttons, its title and text as big, as seen docked)
const RH_PAD = 24, RH_BTN = 60, RH_HEAD = RH_PAD + RH_BTN + 29, RH_ROW = 67, RH_GAP = 11, RH_INDENT = 40, RH_WELL_PAD = 18;
const RH_ROW_RADIUS = 21, RH_ROW_PAD = 21, RH_ICON = 44, RH_TITLE_GAP = 23;
const RH_SLOTS_X = RH_PAD + RH_INDENT + RH_WELL_PAD; // the first tool slot's left
const rhWidth = (perRow) => RH_SLOTS_X + perRow * SLOT + (perRow - 1) * SLOT_GAP + RH_WELL_PAD + RH_PAD;
const rhHeight = (rows) => RH_HEAD + 4 * (RH_ROW + RH_GAP) + 2 * RH_WELL_PAD + rows * SLOT + (rows - 1) * SLOT_GAP + RH_PAD; // (three action rows, the dropdown, the well)
const RH_MIN_PER_ROW = 3, RH_START_PER_ROW = 5; // tools to a row: at least, and at first (roughly square, like the windowed panel)
const RH_FONT = '500 32px system-ui, -apple-system, Segoe UI, sans-serif';

/**
 * Control menu (docked on the right controller at first), like the windowed Control menu: an eye button that
 * shows or hides the rest (hidden: only the button), the title (Observer, or the controlled
 * creature's type), the selected creature's actions when it has any (Eat: the button for it
 * and the blocks it could eat; Excrete: the button and the block that would come out; the
 * trigger on one does it), and, under Observer controls, a Tools dropdown showing the current
 * tool (a message instead, for a moment) that opens the tool selector beneath it, in a dark well.
 * The plane keeps its full size; what isn't drawn is clear. Resizing changes its width (how many
 * tools to a row); its height follows.
 */
export class RightHudPanel extends CanvasPanel {
  constructor() {
    const perRow = RH_START_PER_ROW;
    super(rhWidth(perRow), rhHeight(Math.ceil(TOOLS.length / perRow)), rhWidth(perRow) * PX_TO_M);
    this.mesh.name = 'xr-hud-right';
    this.button = { x: RH_PAD, y: RH_PAD, w: RH_BTN, h: RH_BTN };
    this.perRow = perRow;
    this.limits = { minWidth: rhWidth(RH_MIN_PER_ROW) * PX_TO_M, maxWidth: rhWidth(TOOLS.length) * PX_TO_M, minHeight: 0, maxHeight: Infinity };
    this.rows = []; // the pressable rows drawn last ({ id: 'eat' | 'excrete' | 'tools', x, y, w, h })
    this.slotsY = null; // the tool slots' top, when they're drawn
    this._last = '';
  }

  /** Resized: the width sets how many tools fit in a row (`heightM` doesn't matter: the height follows). */
  resizeBox(widthM) {
    const w = THREE.MathUtils.clamp(widthM, this.limits.minWidth, this.limits.maxWidth) / PX_TO_M;
    this.perRow = THREE.MathUtils.clamp(Math.floor((w - rhWidth(1)) / (SLOT + SLOT_GAP)) + 1, RH_MIN_PER_ROW, TOOLS.length);
    this._setCanvasSize(rhWidth(this.perRow), rhHeight(Math.ceil(TOOLS.length / this.perRow)));
  }

  /**
   * d = { open, title, actions ({ eat: [block types], excrete: block type | null }), glyphs (the
   * input glyphs for them: { eat, excrete }, inputIcons.js tokens), tools (the dropdown shows:
   * Observer controls), toolsOpen (its selector shows), toolIndex, label (the tool's name),
   * message (instead of it, for a moment), style (the icons' look: { materials, smooth }, see
   * drawToolIcon), hover ('toggle', 'eat', 'excrete', 'tools', a tool slot's index, or null) }.
   */
  draw(d) {
    const { open, title, actions = { eat: [], excrete: null, mate: [] }, glyphs, tools, toolsOpen, toolIndex, label, message, style = {}, hover = null } = d;
    const sig = `${open}|${title}|${actions.eat.join(',')}|${actions.excrete}|${(actions.mate ?? []).join(',')}|${tools}|${toolsOpen}|${toolIndex}|${label}|${message || ''}|${style.materials}|${!!style.smooth}|${hover}|${gridMode()}|${this.perRow}|${this.corner}|${this.handleHot}`; // (icons show the grid's block shape)
    if (sig === this._last) return;
    this._last = sig;
    this.isOpen = open;
    const wellRows = Math.ceil(TOOLS.length / this.perRow), wellH = 2 * RH_WELL_PAD + wellRows * SLOT + (wellRows - 1) * SLOT_GAP;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    this.rows = [];
    this.slotsY = null;
    // laid out top to bottom: the Tool dropdown and its well (when open), then what the
    // selected creature can do now (Consume, Excrete) at the bottom
    let y = RH_HEAD;
    const rowAt = (id) => {
      const r = { id, x: RH_PAD, y, w: W - 2 * RH_PAD, h: RH_ROW };
      y += RH_ROW + RH_GAP;
      this.rows.push(r);
      return r;
    };
    const toolsRow = open && tools ? rowAt('tools') : null;
    const wellY = y;
    if (open && tools && toolsOpen) y += wellH + RH_GAP;
    const eatRow = open && actions.eat.length ? rowAt('eat') : null;
    const excreteRow = open && actions.excrete ? rowAt('excrete') : null;
    const mateRow = open && actions.mate?.length ? rowAt('mate') : null;
    // the panel: just the button when hidden, else down to its last row (or the well)
    const panelW = open ? W : RH_BTN + 2 * RH_PAD;
    const panelH = !open ? RH_BTN + 2 * RH_PAD : this.rows.length ? y - RH_GAP + RH_PAD : RH_BTN + 2 * RH_PAD;
    this.box = { x: 0, y: 0, w: panelW, h: Math.min(H, panelH) };
    panelFrame(ctx, this, this.box);
    // the eye button
    const b = this.button;
    // a row: like Options' buttons
    const pressable = (x, y, w, h, hot) => {
      roundRect(ctx, x, y, w, h, RH_ROW_RADIUS);
      ctx.fillStyle = hot ? 'rgba(90, 160, 255, 0.55)' : 'rgba(255,255,255,0.10)';
      ctx.fill();
      if (hot) {
        ctx.strokeStyle = '#9cc8ff';
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    };
    toggleButton(ctx, this, 'eye', hover === 'toggle');
    if (!open) return void (this.texture.needsUpdate = true);
    this._drawResizeHandle(ctx);
    ctx.fillStyle = '#e8ecf2';
    ctx.font = TITLE_FONT(this);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(fit(ctx, title, W - (b.x + b.w + RH_TITLE_GAP) - RH_PAD), b.x + b.w + RH_TITLE_GAP, b.y + b.h / 2);
    // an action: its button's glyph, its name, the blocks it concerns at the right
    const actionRow = (r, name, tokens, types) => {
      const cy = r.y + r.h / 2;
      pressable(r.x, r.y, r.w, r.h, hover === r.id);
      const gh = RH_ICON;
      drawCell(ctx, tokens, r.x + RH_ROW_PAD, cy, gh);
      const gx = r.x + RH_ROW_PAD + cellWidth(ctx, tokens, gh) + 17;
      ctx.font = RH_FONT;
      ctx.fillStyle = '#e8ecf2';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, gx, cy);
      const icon = RH_ICON;
      types.forEach((type, i) => {
        const tool = TOOLS.find((t) => t.block === type) ?? { id: type, block: type };
        drawToolIcon(ctx, tool, r.x + r.w - RH_ROW_PAD - icon / 2 - i * (icon + 8), cy, icon, style);
      });
    };
    if (eatRow) actionRow(eatRow, 'Consume', glyphs.eat, actions.eat);
    if (excreteRow) actionRow(excreteRow, 'Excrete', glyphs.excrete, [actions.excrete]);
    if (mateRow) actionRow(mateRow, 'Mate', glyphs.mate, actions.mate);
    if (toolsRow) {
      // the Tool dropdown: the use-the-tool button's glyph, "Tool", at the right the current tool
      // (its icon left of its name; a message instead, for a moment), the chevron
      const r = toolsRow, cy = r.y + r.h / 2;
      pressable(r.x, r.y, r.w, r.h, hover === 'tools');
      const gh = RH_ICON;
      drawCell(ctx, glyphs.tool, r.x + RH_ROW_PAD, cy, gh);
      const tx = r.x + RH_ROW_PAD + cellWidth(ctx, glyphs.tool, gh) + 17;
      ctx.font = RH_FONT;
      ctx.fillStyle = '#e8ecf2';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('Tool:', tx, cy);
      const chevron = RH_ICON, valueRight = r.x + r.w - RH_ROW_PAD - chevron - 17, icon = RH_ICON;
      const room = valueRight - (tx + ctx.measureText('Tool: ').width);
      ctx.textAlign = 'right';
      ctx.fillStyle = message ? '#ffd166' : '#e8ecf2';
      const text = fit(ctx, message || label, message ? room : room - icon - 10);
      ctx.fillText(text, valueRight, cy);
      if (!message) drawToolIcon(ctx, TOOLS[toolIndex], valueRight - ctx.measureText(text).width - 10 - icon / 2, cy, icon, style);
      drawMenuItemIcon(ctx, toolsOpen ? 'dropdownOpen' : 'dropdown', r.x + r.w - RH_ROW_PAD - chevron / 2, cy, chevron);
    }
    if (toolsRow && toolsOpen) {
      // the selector's well (like Debug's readouts), indented under the dropdown
      const wx = RH_PAD + RH_INDENT, wy = wellY, ww = W - RH_PAD - wx, wh = wellH;
      this.slotsY = wy + RH_WELL_PAD;
      roundRect(ctx, wx, wy, ww, wh, 16);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 2;
      ctx.stroke();
      TOOLS.forEach((t, i) => {
        const x = RH_SLOTS_X + (i % this.perRow) * (SLOT + SLOT_GAP), y = this.slotsY + Math.floor(i / this.perRow) * (SLOT + SLOT_GAP);
        roundRect(ctx, x, y, SLOT, SLOT, 16);
        ctx.fillStyle = i === hover ? 'rgba(90, 160, 255, 0.55)' : i === toolIndex ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)';
        ctx.fill();
        drawToolIcon(ctx, t, x + SLOT / 2, y + SLOT / 2, SLOT * 0.78, style);
        if (i === toolIndex || i === hover) {
          roundRect(ctx, x - 3, y - 3, SLOT + 6, SLOT + 6, 18);
          ctx.strokeStyle = i === hover ? '#9cc8ff' : '#ffffff';
          ctx.lineWidth = 7;
          ctx.stroke();
        }
      });
    }
    this.texture.needsUpdate = true;
  }

  /** uv from a raycast hit -> 'toggle' (the eye button), 'eat' / 'excrete' (an action), 'tools' (the dropdown), the index of the tool slot under it, or null. */
  hitTest(uv) {
    const px = uv.x * this.canvas.width, py = (1 - uv.y) * this.canvas.height;
    const inside = (q, m = 0) => px >= q.x - m && px <= q.x + q.w + m && py >= q.y - m && py <= q.y + q.h + m;
    if (this.onToggle(uv)) return 'toggle';
    const row = this.rows.find((r) => inside(r));
    if (row) return row.id;
    if (this.slotsY == null || py < this.slotsY - SLOT_GAP / 2) return null;
    const col = Math.floor((px - RH_SLOTS_X + SLOT_GAP / 2) / (SLOT + SLOT_GAP)), line = Math.floor((py - this.slotsY + SLOT_GAP / 2) / (SLOT + SLOT_GAP));
    const i = line * this.perRow + col;
    return col >= 0 && col < this.perRow && i >= 0 && i < TOOLS.length ? i : null;
  }
}

const MENU_WIDTH_M = 0.31; // wide enough for the longer Options labels
// an open dropdown's choices: two to a row beneath its button, indented (from xr-music-threejs)
const OPTION_H = 52, OPTION_GAP = 12, OPTION_INDENT = 54, OPTION_ICON = 32, CHECK = 30;
const OPTION_FONT = '400 28px system-ui, -apple-system, Segoe UI, sans-serif';

/** Two choices to a row, or one when a label wouldn't fit in half the width `w`. */
function optionColumns(ctx, options, w) {
  ctx.font = OPTION_FONT;
  const room = (w - OPTION_GAP) / 2 - 36 - CHECK - 10;
  return options.every((o) => ctx.measureText(o.label).width + (o.icon ? OPTION_ICON + 14 : 0) <= room) ? 2 : 1;
}

/** What a menu button's right edge shows: an arrow to a submenu, or a dropdown's (or section's) chevron. */
function trailingIcon(it) {
  if (it.submenu) return 'forward';
  const open = (it.dropdown ?? it.section)?.open;
  if (open !== undefined) return open ? 'dropdownOpen' : 'dropdown';
  return null;
}

// the menu's buttons: height and gap; the Controls table's header and rows
const BUTTON_H = 70, BUTTON_GAP = 12, TABLE_HEAD = 44, TABLE_ROW = 66;
const tableHeight = (table) => TABLE_HEAD + tableRows(table).length * TABLE_ROW + BUTTON_GAP;

const MENU_PAD = 26, MENU_BTN = 64; // the gear button: inset from the panel's corner, and its size
const MENU_LIMITS = { minWidth: 0.22, maxWidth: 0.6, minHeight: 0.15, maxHeight: 0.85 }; // the visible panel (m, at scale 1)

/**
 * Options for XR, like the windowed Options panel: the gear button (top left) that opens it
 * (pausing) or closes it, the menu's title beside it, then the menu. Closed, only the button
 * shows. Docked on the left controller at first (see Engine's XR panels). Resizing sets its
 * width and how tall it may get; a menu taller than that scrolls (scrollBy).
 */
export class MenuPanel extends CanvasPanel {
  constructor() {
    super(954, 1760, MENU_WIDTH_M); // same pixel density as before (800 px per 0.26 m); tall enough for Options with Controls open
    this.mesh.name = 'xr-menu';
    this.material.depthTest = false;
    this.mesh.renderOrder = 20;
    this.button = { x: 6 + MENU_PAD, y: 6 + MENU_PAD, w: MENU_BTN, h: MENU_BTN };
    this.limits = MENU_LIMITS;
    this.boxMarginPx = 12;
    this.dockScale = 0.5;
    this.scroll = 0; // px the menu is scrolled down
    this.view = null; // where the menu shows (canvas px: { y0, y1 }); out of it is hidden
    this.rects = [];
    this._last = '';
  }

  /** Scrolls the menu `px` down (up when negative), as far as it goes. */
  scrollBy(px) {
    this.scroll = THREE.MathUtils.clamp(this.scroll + px, 0, this.maxScroll ?? 0);
  }

  /** `model`: the menu (menuModel) when open, else null; `hoverId`: the item pointed at, or 'toggle'. */
  draw(model, hoverId) {
    const sig = JSON.stringify([model, hoverId, Math.round(this.scroll), this.canvas.width, this.canvas.height, this.corner, this.handleHot]);
    if (sig === this._last) return;
    this._last = sig;
    this.isOpen = !!model;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    // Panel is sized to its content, as tall as it may be (the rest of the canvas stays
    // transparent); closed, just the button.
    const bx = this.button.x, bw = W - 2 * bx, top = this.button.y + MENU_BTN + 30; // (the buttons line up with the gear, as on the other panels)
    const closed = 2 * MENU_PAD + MENU_BTN;
    const itemsH = model ? this._itemsHeight(ctx, model.items, bw) : 0;
    this.box = model ? { x: 6, y: 6, w: W - 12, h: Math.min(H - 12, top + itemsH + 34) } : { x: 6, y: 6, w: closed, h: closed };
    this.view = { y0: top - 6, y1: this.box.y + this.box.h - 20 };
    this.maxScroll = Math.max(0, top + itemsH - this.view.y1);
    this.scroll = THREE.MathUtils.clamp(this.scroll, 0, this.maxScroll);
    panelFrame(ctx, this, this.box);
    toggleButton(ctx, this, 'gear', hoverId === 'toggle');
    this.rects = [];
    if (model) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.font = TITLE_FONT(this);
      const tx = this.button.x + MENU_BTN + 24;
      ctx.fillText(fit(ctx, model.title, W - MENU_PAD - tx - this._gripPx), tx, this.button.y + MENU_BTN / 2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, this.view.y0, W, this.view.y1 - this.view.y0);
      ctx.clip();
      this._drawItems(ctx, model.items, bx, top - this.scroll, bw, hoverId);
      ctx.restore();
      if (this.maxScroll > 0) {
        // the scroll bar, at the right: how much shows, and where
        const span = this.view.y1 - this.view.y0, thumb = Math.max(40, (span * span) / (span + this.maxScroll));
        const ty = this.view.y0 + (span - thumb) * (this.scroll / this.maxScroll);
        roundRect(ctx, W - 23, ty, 8, thumb, 4); // (in the margin, right of the buttons)
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fill();
      }
      this._drawResizeHandle(ctx);
    }
    this.texture.needsUpdate = true;
  }

  /** The height of `items` drawn `w` wide: their buttons, open dropdowns' choices and open sections. */
  _itemsHeight(ctx, items, w) {
    return items.reduce((sum, it) => {
      sum += BUTTON_H + BUTTON_GAP;
      if (it.dropdown?.open) {
        const { options } = it.dropdown;
        sum += Math.ceil(options.length / optionColumns(ctx, options, w - OPTION_INDENT)) * (OPTION_H + OPTION_GAP);
      }
      if (it.section?.open) {
        if (it.section.table) sum += tableHeight(it.section.table);
        sum += this._itemsHeight(ctx, it.section.items, w - OPTION_INDENT);
      }
      return sum;
    }, 0);
  }

  /**
   * `items` from (x, y), `w` wide, each followed by its open dropdown's choices, or its open
   * section's Controls table and entries (indented). Returns the next y.
   */
  _drawItems(ctx, items, x, y, w, hoverId) {
    for (const it of items) {
      y = this._drawItem(ctx, it, x, y, w, hoverId);
      if (it.dropdown?.open) y = this._drawOptions(ctx, it.dropdown.options, x + OPTION_INDENT, y, w - OPTION_INDENT, hoverId);
      if (it.section?.open) {
        if (it.section.table) y = this._drawControlsTable(ctx, x + OPTION_INDENT, y, x + w, tableRows(it.section.table)) + BUTTON_GAP;
        y = this._drawItems(ctx, it.section.items, x + OPTION_INDENT, y, w - OPTION_INDENT, hoverId);
      }
    }
    return y;
  }

  /** One menu button at (bx, y), `bw` wide. Returns the next y. */
  _drawItem(ctx, it, bx, y, bw, hoverId) {
    const bh = BUTTON_H;
    const hover = it.id === hoverId && !it.disabled;
    roundRect(ctx, bx, y, bw, bh, 22);
    ctx.fillStyle = it.disabled
      ? 'rgba(255,255,255,0.04)'
      : hover
        ? 'rgba(90, 160, 255, 0.55)'
        : it.accent
          ? 'rgba(90, 160, 255, 0.25)'
          : 'rgba(255,255,255,0.10)';
    ctx.fill();
    if (hover) {
      ctx.strokeStyle = '#9cc8ff';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
    // icon on the left, then the label (left-aligned), optional sub-text on the right
    const iconSize = 46;
    drawMenuItemIcon(ctx, it.icon, bx + 22 + iconSize / 2, y + bh / 2, iconSize, { alpha: it.disabled ? 0.45 : 1 });
    const tx = bx + 22 + iconSize + 18;
    let right = bx + bw - 28;
    const trailing = trailingIcon(it);
    if (trailing) {
      // a submenu: Back's arrow, mirrored; a dropdown or section: a chevron. At the far right, the icons' size
      drawMenuItemIcon(ctx, trailing, bx + bw - 22 - iconSize / 2, y + bh / 2, iconSize, { alpha: it.disabled ? 0.45 : 1 });
      right = bx + bw - 22 - iconSize - 18;
    }
    ctx.textBaseline = 'middle';
    let track = null;
    if (it.slider) {
      // slider: track + knob in the right half; the label gets the left half
      const { min, max, value } = it.slider;
      track = { x0: bx + bw * 0.55, x1: bx + bw - 34, min, max, step: it.slider.step ?? 1 };
      const ty = y + bh / 2;
      const kx = track.x0 + ((value - min) / (max - min)) * (track.x1 - track.x0);
      ctx.lineCap = 'round';
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.moveTo(track.x0, ty); ctx.lineTo(track.x1, ty); ctx.stroke();
      ctx.strokeStyle = '#5aa0ff';
      ctx.beginPath(); ctx.moveTo(track.x0, ty); ctx.lineTo(kx, ty); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(kx, ty, 17, 0, Math.PI * 2); ctx.fill();
      right = track.x0 - 24;
    }
    if (it.sub) {
      ctx.font = '400 24px system-ui, -apple-system, Segoe UI, sans-serif';
      const sub = fit(ctx, it.sub, bw * 0.3);
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(sub, right, y + bh / 2);
      right -= ctx.measureText(sub).width + 24;
    }
    ctx.font = '500 34px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillStyle = it.disabled ? 'rgba(255,255,255,0.4)' : '#ffffff';
    // "Name: Value": the name on the left, the value against the right edge
    const { name, value } = splitLabel(it.label);
    ctx.fillText(fit(ctx, name, right - tx), tx, y + bh / 2);
    if (value) {
      const room = right - tx - ctx.measureText(name).width - 30;
      ctx.textAlign = 'right';
      ctx.fillText(fit(ctx, value, room), right, y + bh / 2);
    }
    ctx.textAlign = 'center';
    if (!it.disabled) this.rects.push({ id: it.id, x: bx, y, w: bw, h: bh, track });
    return y + bh + BUTTON_GAP;
  }

  /**
   * An open dropdown's choices, two to a row from (x, y): the current one lit and ticked, the ones
   * this device can't use dimmed (and not pointable). Returns the next y.
   */
  _drawOptions(ctx, options, x, y, w, hoverId) {
    const cols = optionColumns(ctx, options, w);
    const ow = (w - (cols - 1) * OPTION_GAP) / cols;
    options.forEach((option, i) => {
      const ox = x + (i % cols) * (ow + OPTION_GAP), oy = y + Math.floor(i / cols) * (OPTION_H + OPTION_GAP);
      const hover = option.id === hoverId && !option.disabled;
      ctx.globalAlpha = option.disabled ? 0.4 : 1;
      roundRect(ctx, ox, oy, ow, OPTION_H, 14);
      ctx.fillStyle = hover ? 'rgba(90, 160, 255, 0.55)' : option.selected ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      ctx.fill();
      ctx.strokeStyle = hover ? '#9cc8ff' : option.selected ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = hover ? 4 : 2;
      ctx.stroke();
      let tx = ox + 18;
      if (option.icon) {
        drawMenuItemIcon(ctx, option.icon, tx + OPTION_ICON / 2, oy + OPTION_H / 2, OPTION_ICON, { alpha: ctx.globalAlpha });
        tx += OPTION_ICON + 14;
      }
      if (option.selected) drawMenuItemIcon(ctx, 'check', ox + ow - 18 - CHECK / 2, oy + OPTION_H / 2, CHECK, { alpha: ctx.globalAlpha });
      ctx.font = OPTION_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffffff';
      ctx.fillText(fit(ctx, option.label, ox + ow - 18 - tx - (option.selected ? CHECK + 10 : 0)), tx, oy + OPTION_H / 2);
      ctx.globalAlpha = 1;
      if (!option.disabled) this.rects.push({ id: option.id, x: ox, y: oy, w: ow, h: OPTION_H });
    });
    return y + Math.ceil(options.length / cols) * (OPTION_H + OPTION_GAP);
  }

  /** Options → Controls table, from x0 to x1: Action | Mouse/Keyboard | Gamepad | XR Controller. Returns bottom y. */
  _drawControlsTable(ctx, x0, y0, x1, rows) {
    const headH = TABLE_HEAD, rowH = TABLE_ROW;
    const widths = [178, 200, 188, 194];
    const colX = widths.map((_, i) => x0 + widths.slice(0, i).reduce((a, b) => a + b, 0));
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = '700 18px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(232,236,242,0.65)';
    CONTROL_COLUMNS.forEach((column, i) => ctx.fillText(column, colX[i] + 8, y0 + headH / 2));
    let y = y0 + headH;
    const glyphH = 40;
    rows.forEach((row, r) => {
      if (r % 2 === 0) {
        roundRect(ctx, x0, y + 2, x1 - x0, rowH - 4, 12);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fill();
      }
      ctx.font = '600 21px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(fit(ctx, row.action, widths[0] - 12), colX[0] + 8, y + rowH / 2);
      [row.mk, row.pad, row.xr].forEach((binding, i) => {
        const avail = widths[i + 1] - 12;
        const h = Math.min(glyphH, (glyphH * avail) / Math.max(1, cellWidth(ctx, binding.g, glyphH)));
        drawCell(ctx, binding.g, colX[i + 1] + 8, y + rowH / 2, h);
      });
      y += rowH;
    });
    return y;
  }

  /** uv from a raycast hit -> item id (or null). */
  hitTest(uv) {
    const px = uv.x * this.canvas.width;
    const py = (1 - uv.y) * this.canvas.height;
    if (!this.view || py < this.view.y0 || py > this.view.y1) return null; // (scrolled out of view)
    const r = this.rects.find((r) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h);
    return r ? r.id : null;
  }

  /** For a slider item: the value under uv (clamped to the track, snapped to its step), else null. */
  sliderValueAt(uv, id) {
    const r = this.rects.find((q) => q.id === id);
    if (!r?.track) return null;
    const { x0, x1, min, max, step } = r.track;
    const t = Math.min(1, Math.max(0, (uv.x * this.canvas.width - x0) / (x1 - x0)));
    return Math.round((min + t * (max - min)) / step) * step;
  }

  /** Whether `uv` is over slider item `id`'s track (not its label): what the gaze can set. */
  onSliderTrack(uv, id) {
    const r = this.rects.find((q) => q.id === id);
    return !!r?.track && uv.x * this.canvas.width >= r.track.x0 - 30;
  }

  /** True when `uv` is on the visible panel (not the transparent rest of the canvas). */
  contains(uv) {
    return this.inBox(uv);
  }
}

/**
 * The View panel for XR, like the windowed one: a single button, the monitor, that leaves XR
 * for the Normal view. Docked on the left controller at first (see Engine's XR panels).
 */
export class ViewPanel extends CanvasPanel {
  constructor() {
    const size = 2 * RH_PAD + RH_BTN;
    super(size, size, size * PX_TO_M);
    this.mesh.name = 'xr-view';
    this.button = { x: RH_PAD, y: RH_PAD, w: RH_BTN, h: RH_BTN };
    this.box = { x: 0, y: 0, w: size, h: size };
    this._last = '';
  }

  /** `hot`: the button is pointed at. */
  draw(hot) {
    const sig = `${hot}`;
    if (sig === this._last) return;
    this._last = sig;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    panelFrame(ctx, this, this.box);
    toggleButton(ctx, this, 'monitor', hot);
    this.texture.needsUpdate = true;
  }
}

/** `text` broken into lines no wider than maxW (at word breaks; a long word stays whole). */
function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (line.trim() && ctx.measureText(line + word).width > maxW) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line += word;
    }
    out.push(line);
  }
  return out;
}

function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

/** The debug tablet's pixel density (canvas px per metre): its text is always this size, however big the tablet. */
// (drawn at a lower density than the others' so its text, in smaller px, comes out as big as Options')
const TABLET_TEXT = 1.45;
const TABLET_PX_PER_M = 1000 / 0.34 / TABLET_TEXT;
/** The debug tablet's size (m): at first, and the limits when resizing it (drag its corner handle). */
export const TABLET_SIZE = { width: 0.42, height: 0.44, minWidth: 0.24, minHeight: 0.2, maxWidth: 0.9, maxHeight: 0.8 };
const TABLET_PAD = Math.round(24 / TABLET_TEXT), TABLET_BTN = Math.round(60 / TABLET_TEXT); // the Debug button (as big as the other panels'): inset from the corner, and its size
const LOG_COLORS = { log: '#c9d1dc', info: '#9cc8ff', warn: '#ffd166', error: '#ff8a80' };

/**
 * Debug tablet for XR, like the windowed Debug panel: its button (top left) opens or closes it
 * (closed, only the button shows); open, Performance (FPS and timings), the Inspector
 * (properties of the selected / targeted block), then the recent console log; each
 * section collapses (trigger on its header). Docked (on the left controller at first) or
 * free (see Engine's XR panels), and resized by dragging its corner handle with the trigger:
 * bottom right when free (its top left stays put), top right when docked (it stands on its
 * bottom edge). The panel gets bigger or smaller, its text keeps its size (more or fewer rows
 * and log lines fit).
 */
export class DebugTablet extends CanvasPanel {
  constructor() {
    super(Math.round(TABLET_SIZE.width * TABLET_PX_PER_M), Math.round(TABLET_SIZE.height * TABLET_PX_PER_M), TABLET_SIZE.width);
    this.mesh.name = 'xr-debug-tablet';
    this.mesh.visible = false;
    this.button = { x: TABLET_PAD, y: TABLET_PAD, w: TABLET_BTN, h: TABLET_BTN };
    this.limits = TABLET_SIZE;
    this.dockScale = 0.5;
    this._last = '';
  }

  /** The id of the control under `uv` ('toggle': the Debug button; a section header), else null. */
  hitTest(uv) {
    if (this.onToggle(uv)) return 'toggle';
    if (!this.isOpen) return null;
    const { px, py } = this._px(uv);
    const r = (this.hits ?? []).find((q) => px >= q.x && px <= q.x + q.w && py >= q.y && py <= q.y + q.h);
    return r ? r.id : null;
  }

  /**
   * The same content as the browser's Debug dock, top to bottom: Performance, Inspector and
   * Logging, each under a header the trigger collapses or expands (shared with the dock).
   * Logging takes the leftover height. d = { info: { title, rows }, perf: [[label, text]], logs,
   * logVersion, highlight (grabbed or pointed at: brighter rim), collapsed: { performance, … },
   * hover: id under the ray, open (closed: just the Debug button) }.
   */
  draw(d) {
    const { info, perf, logs, logVersion, highlight, collapsed, hover, open = true } = d;
    const sig = JSON.stringify([info, perf, logVersion, highlight, collapsed, hover, open, this.corner, this.handleHot, this.canvas.width, this.canvas.height]);
    if (sig === this._last) return;
    this._last = sig;
    this.isOpen = open;
    const corner = this.corner;
    const { ctx } = this;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const closed = 2 * TABLET_PAD + TABLET_BTN;
    this.box = open ? { x: 0, y: 0, w: W, h: H } : { x: 0, y: 0, w: closed, h: closed };
    panelFrame(ctx, this, this.box, highlight);
    toggleButton(ctx, this, 'debug', hover === 'toggle');
    if (!open) return void (this.texture.needsUpdate = true);

    const sans = (size, weight = 400) => `${weight} ${size}px system-ui, -apple-system, Segoe UI, sans-serif`;
    const mono = (size, weight = 400) => `${weight} ${size}px ui-monospace, Consolas, monospace`;
    const PAD = 32, IN = 40; // left edge of headers / of content
    const HEAD = 42, ROW = 30, LINE = 26;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffffff';
    ctx.font = TITLE_FONT(this);
    const titleX = TABLET_PAD + TABLET_BTN + 16, headY = TABLET_PAD + TABLET_BTN / 2;
    ctx.fillText('Debug', titleX, headY);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = sans(22);
    const hintRight = W - PAD - (corner === 'tr' ? this._gripPx : 0);
    ctx.fillText(fit(ctx, 'grip: move · double-tap grip: dock', hintRight - titleX - 120), hintRight, headY);
    ctx.textAlign = 'left';
    this.hits = [];

    /** A section header (y: its top); returns the top of its content. */
    const header = (id, title, summary, y) => {
      const hot = hover === `section:${id}`;
      if (hot) {
        roundRect(ctx, PAD - 10, y, W - 2 * PAD + 20, HEAD, 10);
        ctx.fillStyle = 'rgba(90, 160, 255, 0.2)';
        ctx.fill();
      }
      const cy = y + HEAD / 2;
      ctx.font = sans(20, 700);
      ctx.fillStyle = hot ? '#ffffff' : 'rgba(255,255,255,0.5)';
      const label = title.toUpperCase();
      ctx.fillText(label, PAD, cy);
      const lw = ctx.measureText(label).width;
      ctx.textAlign = 'right';
      ctx.fillText(collapsed[id] ? '▸' : '▾', W - PAD, cy);
      ctx.textAlign = 'left';
      if (collapsed[id] && summary) {
        ctx.font = mono(20);
        ctx.fillStyle = '#e8ecf2';
        ctx.fillText(fit(ctx, summary, W - 2 * PAD - lw - 60), PAD + lw + 16, cy);
      }
      this.hits.push({ id: `section:${id}`, x: PAD - 10, y, w: W - 2 * PAD + 20, h: HEAD });
      return y + HEAD + 4;
    };
    const kv = (k, v, x, y, valueX, maxW) => {
      ctx.font = mono(22, 600);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(fit(ctx, k, valueX - x - 12), x, y);
      ctx.font = mono(22);
      ctx.fillStyle = '#e8ecf2';
      ctx.fillText(fit(ctx, String(v), maxW), valueX, y);
    };
    const box = (x, y, w, h, r, fill, stroke) => {
      roundRect(ctx, x, y, w, h, r);
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    };

    // heights of what goes below the Inspector, so its rows stop in time
    const below = HEAD + 14 + (collapsed.logging ? 0 : 4 * LINE + 12);

    // Performance: two columns when the tablet is wide enough
    let y = header('performance', 'Performance', perf[0] ? `${perf[0][1]} FPS` : '', TABLET_PAD + TABLET_BTN + 20);
    if (!collapsed.performance) {
      const cols = W >= 700 ? 2 : 1;
      perf.forEach(([k, v], i) => {
        const col = i % cols, line = Math.floor(i / cols);
        const x0 = col * (W / 2) + IN;
        kv(k, v, x0, y + ROW / 2 + line * ROW, x0 + 110, W / cols - 150);
      });
      y += Math.ceil(perf.length / cols) * ROW + 8;
    }

    // Inspector: as many rows as fit, leaving room for Logging
    y = header('inspector', 'Inspector', info.title, y + 6);
    if (!collapsed.inspector) {
      ctx.font = sans(26, 600);
      ctx.fillStyle = '#e8ecf2';
      ctx.fillText(fit(ctx, info.title, W - 2 * PAD), PAD, y + 18);
      y += 38;
      const valueX = Math.min(270, W * 0.4);
      const rowsFit = Math.max(0, Math.floor((H - 24 - below - y) / ROW));
      const shown = info.rows.length > rowsFit ? Math.max(0, rowsFit - 1) : info.rows.length;
      for (const [k, v] of info.rows.slice(0, shown)) {
        kv(k, v, IN, y + ROW / 2, valueX, W - valueX - IN);
        y += ROW;
      }
      if (info.rows.length > shown) {
        ctx.font = sans(20);
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        ctx.fillText(`… ${info.rows.length - shown} more (make the tablet taller)`, IN, y + ROW / 2);
        y += ROW;
      }
    }

    // Logging: newest at the bottom, filling the rest
    y = header('logging', 'Logging', `${logs.length} lines`, y + 10);
    if (!collapsed.logging) {
      box(PAD, y, W - 2 * PAD, H - 24 - y, 12, 'rgba(0,0,0,0.3)');
      const fitLines = Math.max(0, Math.floor((H - 30 - y) / LINE));
      ctx.font = mono(19);
      logs.slice(-fitLines).forEach((e, i) => {
        ctx.fillStyle = LOG_COLORS[e.level] ?? LOG_COLORS.log;
        ctx.fillText(fit(ctx, `${e.t} ${e.text}`, W - 2 * PAD - 24 - this._gripPx * 0.5), PAD + 12, y + LINE / 2 + 4 + i * LINE);
      });
      if (!logs.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText('No log output yet', PAD + 12, y + LINE / 2 + 4);
      }
    }

    this._drawResizeHandle(ctx);
    this.texture.needsUpdate = true;
  }
}
