// XR grab: creatures held in the hands. A grip on a creature takes its body out of the world
// (World.takeBody), so it stops acting and its cells are free, and it's drawn here instead, each
// block where it was relative to the hand, following the hand (the build's own orientation: it
// keeps the shape it has in the grid). Let go, the engine puts it back into the nearest cells
// it fits (World.putBody).
//
// A carried creature shakes in the hand (SHAKE_CM, SHAKE_HZ): it wriggles to get free.
//
// Its blocks are drawn like lone blocks of their type (as InventoryView draws items):
// smooth-shaded, so in Rendering: Smooth rounded; shadeFlat types stay flat.
import * as THREE from 'three';
import { BlockBatch } from './blockBatch.js';
import { BLOCK_COLORS, blockProps } from './blocks.js';

const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _shake = new THREE.Vector3();

/** A carried creature's shake: how far it moves (cm) and how fast, per axis (Hz; uneven, so it doesn't settle into a pattern). */
const SHAKE_CM = 0.12;
const SHAKE_HZ = [17, 23, 19];

export class HeldBodies {
  /** `parent`: where they're drawn (the World's parent: lattice cm). */
  constructor(world, parent) {
    this.world = world;
    this.parent = parent;
    this.batches = new Map(); // the World's pass material -> this view's batch drawn with it
    this.geometry = null; // the block shape the batches were made with
    this.held = new Map(); // hand -> { records (World.takeBody), offsets (each block from the hand, cm), seeds, home (its head's cell), at (the hand, cm) }
  }

  _batchFor(type) {
    const pass = this.world._batchFor(type);
    let batch = this.batches.get(pass.material);
    if (!batch) {
      batch = new BlockBatch(this.parent, this.world.geometry, pass.material, 'held-creatures', { renderOrder: pass.renderOrder, initialCapacity: 16 });
      this.batches.set(pass.material, batch);
    }
    return batch;
  }

  /** `hand` now holds a body: `records` from World.takeBody, `offsets` its blocks from the hand (cm), `home` the cell its head left, `at` the hand (cm). */
  hold(hand, records, offsets, home, at) {
    this.held.set(hand, { records, offsets, seeds: records.map(() => Math.random() * 40), home, at: at.clone() });
  }

  /** Lets go of what `hand` holds; returns it (null if nothing). */
  release(hand) {
    const h = this.held.get(hand) ?? null;
    this.held.delete(hand);
    return h;
  }

  /** Drops everything held, putting nothing back (the world was replaced: New / Load). */
  clear() {
    this.held.clear();
  }

  /** Call every frame: `handAt(hand)` is the hand's place (cm, in the parent), or null to leave it where it was. */
  update(handAt) {
    const world = this.world;
    if (this.geometry !== world.geometry) {
      for (const batch of this.batches.values()) batch.setBaseGeometry(world.geometry);
      this.geometry = world.geometry;
    }
    for (const batch of this.batches.values()) batch.clear();
    const t = performance.now() / 1000;
    for (const [hand, h] of this.held) {
      const at = handAt(hand);
      if (at) h.at.copy(at);
      const phase = hand === 'left' ? 1.7 : 0; // (two carried at once don't shake in step)
      _shake.set(...SHAKE_HZ.map((hz, k) => Math.sin(2 * Math.PI * hz * t + phase + k * 2.1))).multiplyScalar(SHAKE_CM);
      h.records.forEach((r, i) => this._draw(r.type, h.seeds[i], _p.copy(h.at).add(h.offsets[i]).add(_shake)));
    }
    for (const batch of this.batches.values()) {
      batch.mesh.visible = batch.count > 0;
      batch.dirty();
    }
  }

  _draw(type, seed, pos) {
    const batch = this._batchFor(type);
    const item = {};
    batch.add(item);
    batch.mesh.setMatrixAt(item.index, _m.makeTranslation(pos.x, pos.y, pos.z));
    batch.mesh.setColorAt(item.index, _c.set(BLOCK_COLORS[type]));
    batch.attr('blockStyle').setXYZW(item.index, blockProps(type).style, seed, 0, 0);
    batch.attr('blockTexOrigin').setXYZ(item.index, seed * 7.31, seed * 3.17, seed * 5.53);
    batch.attr('blockMerged').setX(item.index, 0);
    batch.attr('blockSmooth').setX(item.index, blockProps(type).shadeFlat ? 0 : 1);
  }
}
