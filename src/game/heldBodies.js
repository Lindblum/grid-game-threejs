// XR grab: creatures held in the hands. A grip on a creature takes its body out of the world
// (World.takeBody), so it stops acting and its cells are free, and it's drawn here instead, each
// block where it was relative to the hand, following the hand (the build's own orientation: it
// keeps the shape it has in the grid). Let go, the engine puts it back into the nearest cells
// it fits (World.putBody).
//
// A carried creature shakes in the hand (SHAKE_CM, SHAKE_HZ): it wriggles to get free.
//
// It's drawn as it was in the grid (the look takeBody recorded: colour, pattern, shading): in
// Rendering: Blocky its blocks as instances, side by side; in Smooth as one body, built as
// ClusterBodies builds the world's (its cells welded, or a chain's tube), over stand-in blocks.
// Its eyes, fangs, legs and wings come along (facing as they did), the legs and wings flailing
// (FLAIL_S a step) instead of keeping to the turns.
import * as THREE from 'three';
import { BlockBatch } from './blockBatch.js';
import { ClusterBodies } from './clusterBody.js';
import { CreatureEyes } from './creature.js';
import { BLOCK_COLORS, blockProps } from './blocks.js';

const _m = new THREE.Matrix4();
const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _shake = new THREE.Vector3();

/** A carried creature's shake: how far it moves (cm) and how fast, per axis (Hz; uneven, so it doesn't settle into a pattern). */
const SHAKE_CM = 0.12;
const SHAKE_HZ = [17, 23, 19];
/** A carried creature's legs step (and wings flap) every this many seconds: it flails. */
const FLAIL_S = 0.12;

/** Stand-in blocks' instance indices (blockIndex: kept clear of the dithered block's, uDitherIndex). */
const INDEX_BASE = -100;

export class HeldBodies {
  /** `parent`: where they're drawn (the World's parent: lattice cm). */
  constructor(world, parent) {
    this.world = world;
    this.parent = parent;
    this.batches = new Map(); // the World's pass material -> this view's batch drawn with it
    this.geometry = null; // the block shape the batches were made with
    this.bodies = new ClusterBodies(parent, world.materials); // (only its builders: the bodies are ours)
    this.eyes = new CreatureEyes(parent); // held creatures' eyes, fangs, legs and wings (stand-ins at `held` places)
    this.held = new Map(); // hand -> { records (World.takeBody), offsets (each block from the hand, cm), home (its head's cell), at (the hand, cm), body (Smooth) }
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
    this.release(hand);
    // a stand-in for each block that has eyes (and the rest), facing as it did in the grid
    const eyed = [];
    records.forEach((r, i) => {
      if (!r.eyes) return;
      const c = { type: r.type, index: eyed.length, segmentOf: r.segment ? true : undefined, at: new THREE.Vector3(), i };
      this.eyes.state.set(c, { q: r.eyes.clone(), from: r.eyes.clone(), to: r.eyes.clone(), t0: 0, dur: 0 });
      eyed.push(c);
    });
    this.held.set(hand, { records, offsets, home, at: at.clone(), body: null, eyed });
  }

  /** Lets go of what `hand` holds; returns it (null if nothing). */
  release(hand) {
    const h = this.held.get(hand) ?? null;
    this.held.delete(hand);
    this._dropBody(h);
    for (const c of h?.eyed ?? []) this.eyes.untrack(c);
    return h;
  }

  /** Drops everything held, putting nothing back (the world was replaced: New / Load). */
  clear() {
    for (const h of this.held.values()) this._dropBody(h);
    this.held.clear();
    this.eyes.clear();
  }

  _dropBody(h) {
    if (!h?.body) return;
    this.bodies._dispose(h.body.body);
    h.body = null;
  }

  /**
   * Call every frame: `handAt(hand)` is the hand's place (cm, in the parent), or null to leave
   * it where it was. `extras`: lone blocks to draw too, [{ type, at (cm) }] (XR: a block tool's
   * touch ball, looking like the block it places).
   */
  update(handAt, extras = []) {
    const world = this.world;
    if (this.geometry !== world.geometry) {
      for (const batch of this.batches.values()) batch.setBaseGeometry(world.geometry);
      this.geometry = world.geometry;
      for (const h of this.held.values()) this._dropBody(h); // (another grid: built again)
    }
    for (const batch of this.batches.values()) batch.clear();
    const smooth = world.clusterBodies.enabled;
    const t = performance.now() / 1000;
    for (const [hand, h] of this.held) {
      const at = handAt(hand);
      if (at) h.at.copy(at);
      const phase = hand === 'left' ? 1.7 : 0; // (two carried at once don't shake in step)
      _shake.set(...SHAKE_HZ.map((hz, k) => Math.sin(2 * Math.PI * hz * t + phase + k * 2.1))).multiplyScalar(SHAKE_CM);
      for (const c of h.eyed) c.at.copy(h.at).add(h.offsets[c.i]).add(_shake);
      if (!smooth) {
        this._dropBody(h);
        h.records.forEach((r, i) => this._draw(r, _p.copy(h.at).add(h.offsets[i]).add(_shake)));
        continue;
      }
      h.body ??= this._buildBody(h.records);
      h.body.positions.forEach((p, i) => p.copy(h.at).add(h.offsets[i]).add(_shake));
      this.bodies._pose(h.body.view, h.body.body, 0);
    }
    for (const { type, at } of extras) this._draw({ type, look: this._lookOf(type) }, at);
    for (const batch of this.batches.values()) {
      batch.mesh.visible = batch.count > 0;
      batch.dirty();
    }
    const ms = t * 1000;
    this.eyes.update(ms, (c, out) => out.copy(c.at), { turn: Math.floor(t / FLAIL_S), flapSeconds: FLAIL_S, stepSeconds: FLAIL_S });
  }

  /** How a new block of `type` looks (as World.add makes it), for _draw: one look per type. */
  _lookOf(type) {
    this._looks ??= new Map();
    let look = this._looks.get(type);
    if (!look) {
      look = { style: [blockProps(type).style, 11.3, 0, 0], color: BLOCK_COLORS[type], texOrigin: [0, 0, 0], smooth: blockProps(type).shadeFlat ? 0 : 1 };
      this._looks.set(type, look);
    }
    return look;
  }

  /** One block of a held body (Rendering: Blocky), drawn at `pos` (cm) as it looked in the grid. */
  _draw(r, pos) {
    const batch = this._batchFor(r.type);
    const item = {};
    batch.add(item);
    const look = r.look;
    batch.mesh.setMatrixAt(item.index, _m.makeTranslation(pos.x, pos.y, pos.z));
    batch.mesh.setColorAt(item.index, _c.set(look.color));
    batch.attr('blockStyle').setXYZW(item.index, look.style[0], look.style[1], look.style[2], 0); // (no dark corners: nothing beside it)
    batch.attr('blockTexOrigin').setXYZ(item.index, ...look.texOrigin);
    batch.attr('blockMerged').setX(item.index, 0);
    batch.attr('blockSmooth').setX(item.index, look.smooth);
  }

  /**
   * A held body's smooth mesh (Rendering: Smooth): stand-in blocks in the cells the records
   * give (head at the origin), linked as a Buzzy's segments or a chain's, and a view of them
   * standing in for the World where ClusterBodies reads one (their looks, where they're drawn).
   */
  _buildBody(records) {
    const blocks = records.map((r, i) => ({ x: r.dx, y: r.dy, z: r.dz, type: r.type, index: INDEX_BASE - i, texOrigin: r.look.texOrigin, look: r.look }));
    const head = blocks[0];
    const segs = blocks.filter((b, i) => records[i].segment);
    if (segs.length) {
      head.segments = segs;
      for (const b of segs) b.segmentOf = head;
    }
    const chain = { segments: blocks };
    const positions = blocks.map(() => new THREE.Vector3());
    const view = {
      squirmyOf: new Map(blocks.map((b) => [b, chain])),
      _style: (b) => ({ getX: () => b.look.style[0], getY: () => b.look.style[1], getZ: () => b.look.style[2], getW: () => 0 }),
      colorOf: (b, out) => out.set(b.look.color),
      renderedPosition: (b, now, out) => out.copy(positions[INDEX_BASE - b.index]),
      edgeVia: () => null, // (no blocks round it to bend about)
    };
    this.bodies._world = view;
    const body = this.bodies._create(blocks);
    this.bodies._refreshLook(view, body);
    return { body, view, positions };
  }
}
