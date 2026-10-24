// Options → Accessibility → Controller Guide (XR): a label beside each of a controller's
// buttons and sticks saying what it does right now. Each label points, with a thin leader line,
// at its button on the controller's own model (the motion-controllers profile's node for that
// component); the labels stand in a column out to the side of the controller as you see it
// (top to bottom as the buttons sit). Labels with no text are hidden.
import * as THREE from 'three';

/** The components labelled, in the column's order (top to bottom). */
const COMPONENTS = ['y-button', 'b-button', 'x-button', 'a-button', 'xr-standard-thumbstick', 'xr-standard-trigger', 'xr-standard-squeeze'];
const FONT_PX = 40;
const LINE_PX = 50; // a text line's height on the canvas
const PAD_PX = 12;
const CANVAS_W = 512;
const TEXT_M = 0.009; // a text line's height in the world (m)
const OUT_M = 0.07; // the column's distance out from the controller, to its side (m)
const ROW_GAP_M = 0.004; // between the column's labels (m)

const _p = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _at = new THREE.Vector3();

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

  /** Shows `text` (lines split by \n), redrawing only when it changed; anchored at its `side` edge ('left': the label's left edge is at its position). */
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
    const x0 = side === 'left' ? 0 : CANVAS_W - w; // (the box hugs the edge nearest the controller)
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
    this.sprite.center.set(side === 'left' ? 0 : 1, 0.5);
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
   * `camera`: the viewer (labels stand to the controller's side as seen from it).
   */
  update(hands, textsOf, camera) {
    for (const hand of ['left', 'right']) {
      const slot = hands?.[hand];
      const components = slot?.source && slot.model?.motionController?.components;
      if (!components) {
        for (const l of this.labels[hand].values()) l.hide();
        continue;
      }
      const texts = textsOf(hand);
      camera.updateMatrixWorld();
      _right.setFromMatrixColumn(camera.matrixWorld, 0).normalize();
      _up.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
      const side = hand === 'left' ? -1 : 1;
      slot.grip.getWorldPosition(_at);
      const rows = COMPONENTS.filter((id) => texts[id] && components[id]);
      for (const id of COMPONENTS) if (!rows.includes(id)) this.labels[hand].get(id)?.hide();
      // the column: rows stacked by their heights, centred on the controller's height
      for (const id of rows) this._label(hand, id).setText(texts[id], hand === 'left' ? 'right' : 'left');
      const heights = rows.map((id) => this._label(hand, id).sprite.scale.y);
      let y = (heights.reduce((a, h) => a + h, 0) + ROW_GAP_M * (rows.length - 1)) / 2;
      rows.forEach((id, i) => {
        const l = this._label(hand, id), component = components[id];
        y -= heights[i] / 2;
        l.sprite.position.copy(_at).addScaledVector(_right, side * OUT_M).addScaledVector(_up, y);
        y -= heights[i] / 2 + ROW_GAP_M;
        component.guideNode ??= slot.model.getObjectByName(component.rootNodeName);
        if (!component.guideNode) return l.hide();
        component.guideNode.getWorldPosition(_p);
        const pos = l.line.geometry.getAttribute('position');
        pos.setXYZ(0, _p.x, _p.y, _p.z);
        pos.setXYZ(1, l.sprite.position.x, l.sprite.position.y, l.sprite.position.z);
        pos.needsUpdate = true;
        l.sprite.visible = l.line.visible = true;
      });
    }
  }
}
