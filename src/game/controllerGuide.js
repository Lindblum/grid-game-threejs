// Options → Accessibility → Controller Guide (XR): a label beside each of a controller's
// buttons, sticks, triggers, grips and menu button saying what it does right now. Each label points,
// with a thin leader line, at the middle of that part on the controller's own model (the
// motion-controllers profile's nodes for it); the labels stand in a column out to the side of the controller as you see it
// (top to bottom as the buttons sit). Labels with no text are hidden.
import * as THREE from 'three';

/** The components labelled, in the column's order (top to bottom). */
const COMPONENTS = ['menu', 'y-button', 'b-button', 'x-button', 'a-button', 'xr-standard-thumbstick', 'xr-standard-trigger', 'xr-standard-squeeze'];
const FONT_PX = 40;
const LINE_PX = 50; // a text line's height on the canvas
const PAD_PX = 12;
const CANVAS_W = 512;
const TEXT_M = 0.009; // a text line's height in the world (m)
const OUT_M = 0.07; // the column's distance out from the controller, to its side (m)
const ROW_GAP_M = 0.004; // between the column's labels (m)
const INNER_M = 0.045; // the inner column's distance from the controller (m): closer, leaving room between the hands
const FRONT_M = 0.07; // the trigger's label: this far in front of it (m), where the controller points
/** Where each component's label goes: 'inner' (the controller's side toward the other hand), 'outer', or 'front' (ahead of it). */
const PLACE = { 'a-button': 'inner', 'b-button': 'inner', 'x-button': 'inner', 'y-button': 'inner', 'xr-standard-squeeze': 'inner', 'xr-standard-trigger': 'front', 'xr-standard-thumbstick': 'outer', menu: 'outer' };

const _p = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _at = new THREE.Vector3();
const _box = new THREE.Box3();

/**
 * Where a component sits on controller model `model`: the centre of its parts' shapes (its root
 * node and its visual responses' nodes, the moving parts), not a node's origin (a part's pivot
 * is often elsewhere); into `out`. Null when the model has none of them.
 */
function componentCentre(model, component, out) {
  if (!component.guideNodes?.length) {
    // (looked for again until found: the components come before the model's shape has loaded)
    const names = [component.rootNodeName, ...Object.values(component.visualResponses ?? {}).flatMap((v) => [v.valueNodeName, v.minNodeName, v.maxNodeName])];
    component.guideNodes = [...new Set(names.filter(Boolean).map((n) => model.getObjectByName(n)).filter(Boolean))];
  }
  _box.makeEmpty();
  for (const node of component.guideNodes) _box.expandByObject(node);
  if (_box.isEmpty()) {
    if (!component.guideNodes.length) return null;
    return component.guideNodes[0].getWorldPosition(out); // (no shape: its origin)
  }
  return _box.getCenter(out);
}

class Label {
  constructor(parent) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = LINE_PX + PAD_PX * 2;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.texture, depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
    this.sprite.renderOrder = 11;
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xe8f2ff, transparent: true, opacity: 0.55, depthTest: false, depthWrite: false }));
    this.line.renderOrder = 10;
    this.line.frustumCulled = false;
    for (const o of [this.sprite, this.line]) {
      o.raycast = () => {};
      o.visible = false;
      parent.add(o);
    }
    this.text = null;
  }

  /** Shows `text` (lines split by \n), redrawing only when it changed; anchored at its `side` edge ('left': the label's left edge is at its position; 'center': its middle). */
  setText(text, side) {
    if (text === this.text && side === this.side) return;
    this.text = text;
    this.side = side;
    const lines = text.split('\n');
    const h = lines.length * LINE_PX + PAD_PX * 2;
    if (this.canvas.height !== h) {
      this.canvas.height = h;
      this.texture.dispose();
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.sprite.material.map = this.texture;
    }
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, CANVAS_W, h);
    ctx.font = `600 ${FONT_PX}px system-ui, sans-serif`;
    const w = Math.min(CANVAS_W, Math.max(...lines.map((l) => ctx.measureText(l).width)) + PAD_PX * 2);
    const x0 = side === 'left' ? 0 : side === 'center' ? (CANVAS_W - w) / 2 : CANVAS_W - w; // (the box hugs the edge nearest the controller)
    ctx.fillStyle = 'rgba(12, 16, 24, 0.78)';
    ctx.beginPath();
    ctx.roundRect(x0, 0, w, h, 14);
    ctx.fill();
    ctx.fillStyle = '#eef3fa';
    ctx.textBaseline = 'middle';
    lines.forEach((l, i) => ctx.fillText(l, x0 + PAD_PX, PAD_PX + LINE_PX * (i + 0.5)));
    this.texture.needsUpdate = true;
    const k = TEXT_M / LINE_PX; // m per canvas px
    this.sprite.scale.set(CANVAS_W * k, h * k, 1);
    this.sprite.center.set(side === 'left' ? 0 : side === 'center' ? 0.5 : 1, 0.5);
  }

  hide() {
    this.sprite.visible = this.line.visible = false;
  }
}

export class ControllerGuide {
  constructor(parent) {
    this.parent = parent;
    this.labels = { left: new Map(), right: new Map() }; // hand -> component id -> Label
  }

  _label(hand, id) {
    let l = this.labels[hand].get(id);
    if (!l) this.labels[hand].set(id, (l = new Label(this.parent)));
    return l;
  }

  /**
   * Per frame. `hands`: { left, right } controller slots (with `model`, the controller's model),
   * or null to hide every label; `textsOf(hand)`: { componentId: text } for what to show;
   * `camera`: the viewer (labels lie in its view: its right and up).
   *
   * Where each label goes (PLACE): A / B / X / Y and the grip in a column on the controller's
   * inner side (toward the other hand), the stick and the menu button in one on its outer side,
   * the trigger out in front (along where the controller points). In a column each label sits
   * level with its part where it can (its line runs straight across); labels that would overlap
   * are moved apart as a group, centred on their parts.
   */
  update(hands, textsOf, camera) {
    camera.updateMatrixWorld();
    _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    _up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    for (const hand of ['left', 'right']) {
      const slot = hands?.[hand];
      const components = slot?.source && slot.model?.motionController?.components;
      if (!components) {
        for (const l of this.labels[hand].values()) l.hide();
        continue;
      }
      const texts = textsOf(hand);
      const outward = hand === 'left' ? -1 : 1; // (the outer side, as you see it)
      slot.grip.getWorldPosition(_at);
      slot.model.updateWorldMatrix(true, true);
      const shown = [];
      for (const id of COMPONENTS) {
        const l = this.labels[hand].get(id);
        const p = texts[id] && components[id] && componentCentre(slot.model, components[id], new THREE.Vector3());
        if (!p) {
          l?.hide();
          continue;
        }
        shown.push({ id, p, place: PLACE[id] ?? 'outer', l: this._label(hand, id) });
      }
      for (const place of ['inner', 'outer']) {
        const side = place === 'outer' ? outward : -outward;
        const col = shown.filter((x) => x.place === place);
        for (const x of col) {
          x.l.setText(texts[x.id], side > 0 ? 'left' : 'right'); // (the box's edge nearest the controller)
          x.h = x.l.sprite.scale.y;
          x.y = _p.copy(x.p).sub(_at).dot(_up); // (its part's height, as you see it)
        }
        col.sort((a, b) => b.y - a.y);
        // groups of labels that would touch, each centred on the mean height of its parts
        const groups = [];
        for (const x of col) {
          groups.push({ items: [x], h: x.h, mid: x.y });
          for (;;) {
            const g = groups.at(-1), prev = groups.at(-2);
            if (!prev || prev.mid - prev.h / 2 - ROW_GAP_M >= g.mid + g.h / 2) break;
            const items = [...prev.items, ...g.items];
            const h = items.reduce((t, it) => t + it.h, 0) + ROW_GAP_M * (items.length - 1);
            groups.splice(-2, 2, { items, h, mid: items.reduce((t, it) => t + it.y, 0) / items.length });
          }
        }
        for (const g of groups) {
          let y = g.mid + g.h / 2;
          for (const x of g.items) {
            y -= x.h / 2;
            x.l.sprite.position.copy(_at).addScaledVector(_right, side * (place === 'inner' ? INNER_M : OUT_M)).addScaledVector(_up, y);
            y -= x.h / 2 + ROW_GAP_M;
          }
        }
      }
      // the trigger's label: out in front of it, where the controller points
      slot.ctrl.updateMatrixWorld();
      const fwd = new THREE.Vector3(0, 0, -1).transformDirection(slot.ctrl.matrixWorld);
      for (const x of shown.filter((it) => it.place === 'front')) {
        x.l.setText(texts[x.id], 'center');
        x.l.sprite.position.copy(x.p).addScaledVector(fwd, FRONT_M);
      }
      for (const { l, p } of shown) {
        const pos = l.line.geometry.getAttribute('position');
        pos.setXYZ(0, p.x, p.y, p.z);
        pos.setXYZ(1, l.sprite.position.x, l.sprite.position.y, l.sprite.position.z);
        pos.needsUpdate = true;
        l.sprite.visible = l.line.visible = true;
      }
    }
  }
}
