// Accessibility → View Internal: the items in a creature's inventory, drawn inside it. Every
// block of a creature holds one inventory slot (World.freeSlotFor): food is swallowed into the
// head's and moves a block a turn toward the tail (World.digest). Each item is drawn as a block of its type, at INVENTORY_SCALE, in the
// middle of the body block whose slot holds it (moving with it as it slides). The creature
// itself is drawn 3/4 opaque meanwhile (World.setSeeThrough), so they show through.
//
// The World only keeps each slot's item type, so the items are tracked here, each with the
// place it's drawn: frame to frame, a creature's queue (tail first) loses items off its tail
// end (excreted) and gains them at the other (eaten), the rest keeping their order. An eaten
// item grows in from where its eater is to its slot; an item moved on to another slot (a
// block along, digesting) slides there; an excreted one shrinks away as it moves
// to where the excreted block appears. Each takes a step (World.stepSeconds), eased like
// World.appear.
import * as THREE from 'three';
import { BlockBatch } from './blockBatch.js';
import { BLOCK_COLORS, blockProps } from './blocks.js';

const INVENTORY_SCALE = 0.8;

const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();

const ease = (t) => t * t * (3 - 2 * t); // smoothstep, like World.appear

export class InventoryView {
  /** `parent`: where the items are drawn (the World's parent: lattice cm). */
  constructor(world, parent) {
    this.world = world;
    this.parent = parent;
    this.batches = new Map(); // the World's pass material -> this view's batch drawn with it
    this.geometry = null; // the block shape the batches were made with
    this.queues = new Map(); // creature -> its items, tail first: { type, slot, pos, scale, seed, anim }
    this.leaving = []; // excreted items shrinking away: { type, seed, from, to, t0 }
    // what happened since the last frame: where items were eaten from, and excreted to
    this._eaten = new Map(); // slot block -> the block that ate it
    this._excreted = []; // { by: the tail it left, block: the block it came out as }
    world.on('blockConsumed', ({ by, slot }) => slot && this._eaten.set(slot, by));
    world.on('blockExcreted', ({ by, block }) => this._excreted.push({ by, block }));
  }

  /** The batch items of `type` go in: one per World pass (so they're drawn like the World's own blocks). */
  _batchFor(type) {
    const pass = this.world._batchFor(type);
    let batch = this.batches.get(pass.material);
    if (!batch) {
      batch = new BlockBatch(this.parent, this.world.geometry, pass.material, 'inventory-items', { renderOrder: pass.renderOrder, initialCapacity: 16 });
      this.batches.set(pass.material, batch);
    }
    return batch;
  }

  /** Call every frame: tracks and draws the inventories of `creatures` (none: nothing). */
  update(creatures, now) {
    const world = this.world;
    const dur = world.stepSeconds * 1000;
    const shown = new Set(creatures);
    for (const creature of this.queues.keys()) if (!shown.has(creature)) this.queues.delete(creature);
    for (const creature of creatures) this._track(creature, now);
    this._eaten.clear();
    this._excreted.length = 0;

    if (this.geometry !== world.geometry) {
      // a new grid mode: a new block shape
      for (const batch of this.batches.values()) batch.setBaseGeometry(world.geometry);
      this.geometry = world.geometry;
    }
    for (const batch of this.batches.values()) batch.clear();
    for (const items of this.queues.values()) {
      for (const item of items) {
        // where its slot is drawn (sliding with the body), or on the way there
        world.renderedPosition(item.slot, now, _p);
        const a = item.anim;
        if (a) {
          const e = ease(Math.min(1, (now - a.t0) / dur));
          _p.lerpVectors(a.from, _p, e);
          item.scale = a.fromScale + (INVENTORY_SCALE - a.fromScale) * e;
          if (e >= 1) item.anim = null;
        }
        item.pos.copy(_p);
        this._draw(item.type, item.seed, item.pos, item.scale);
      }
    }
    this.leaving = this.leaving.filter((item) => {
      const t = Math.min(1, (now - item.t0) / dur);
      const e = ease(t);
      this._draw(item.type, item.seed, _p.lerpVectors(item.from, item.to, e), INVENTORY_SCALE * (1 - e));
      return t < 1;
    });
    for (const batch of this.batches.values()) {
      batch.mesh.visible = batch.count > 0;
      batch.dirty();
    }
  }

  /** Brings `creature`'s tracked queue up to date with its slots (see the top of the file). */
  _track(creature, now) {
    const world = this.world;
    const body = world.clusterOf(creature); // head .. tail
    const slots = body.filter((b) => b.inventory && BLOCK_COLORS[b.inventory]).reverse(); // tail first
    const prev = this.queues.get(creature);
    const at = (block) => world.renderedPosition(block, now, new THREE.Vector3());
    const make = (slot, anim = null) => ({
      type: slot.inventory, slot, seed: Math.random() * 40, pos: at(slot), scale: anim ? anim.fromScale : INVENTORY_SCALE, anim,
    });
    if (!prev) {
      // newly shown: its items are already in place
      this.queues.set(creature, slots.map((slot) => make(slot)));
      return;
    }
    // how many left off the tail end: the fewest that leave the rest a match for the front of
    // the queue now (types in order)
    let k = 0;
    const fits = (k) => prev.length - k <= slots.length && prev.slice(k).every((item, i) => item.type === slots[i].inventory);
    while (k < prev.length && !fits(k)) k++;
    // those left: excreted ones shrink away to where they came out (else where they are)
    const excreted = this._excreted.filter((x) => body.includes(x.by) || prev.some((item) => item.slot === x.by));
    prev.slice(0, k).forEach((item, i) => {
      const to = excreted[i] ? at(excreted[i].block) : item.pos.clone();
      this.leaving.push({ type: item.type, seed: item.seed, from: item.pos.clone(), to, t0: now });
    });
    // the rest move on to their slots now (sliding there when that's another one)
    const items = prev.slice(k).map((item, i) => {
      if (item.slot !== slots[i]) {
        item.slot = slots[i];
        item.anim = { from: item.pos.clone(), fromScale: item.scale, t0: now };
      }
      return item;
    });
    // new ones grow in, from whoever ate them to their slot
    for (const slot of slots.slice(items.length)) {
      const eater = this._eaten.get(slot) ?? body[0];
      items.push(make(slot, { from: at(eater), fromScale: 0, t0: now }));
    }
    this.queues.set(creature, items);
  }

  _draw(type, seed, pos, scale) {
    const batch = this._batchFor(type);
    const item = {};
    batch.add(item);
    batch.mesh.setMatrixAt(item.index, _m.compose(pos, _q.identity(), _s.setScalar(Math.max(scale, 1e-4))));
    batch.mesh.setColorAt(item.index, _c.set(BLOCK_COLORS[type]));
    batch.attr('blockStyle').setXYZW(item.index, blockProps(type).style, seed, 0, 0);
    batch.attr('blockTexOrigin').setXYZ(item.index, seed * 7.31, seed * 3.17, seed * 5.53); // (each its own patch of pattern)
    batch.attr('blockMerged').setX(item.index, 0);
    batch.attr('blockSmooth').setX(item.index, 1); // rounded, like an excreted block
  }
}
