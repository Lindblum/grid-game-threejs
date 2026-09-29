import * as THREE from 'three';
import { RANDOM_BLOCKS } from './tools.js';
import { BLOCK, BLOCK_COLORS, blockProps, canBehave, isCreature, isTranslucent, BUFF_TYPES, isSingleCreature } from './blocks.js';
import { NEIGHBOR_DIRS, cellKey, isValidCell, randomCellOnSphere } from './lattice.js';
import { FACE_DIRS, createBlockGeometry, createBlockMaterials } from './geometry.js';
import { BundleBodies } from './bundleBody.js';
import { SOLID_TYPES } from './sim.js';
import { CreatureEyes, orientCreature } from './creature.js';

/**
 * Per-turn animations (block slides, eye turns, vanishing) last this fraction of a turn.
 * The length in seconds is world.stepSeconds, which follows Options → Speed.
 */
export const STEP_FRACTION = 0.75;

/**
 * Steps of the "New" scene, in order (after the Stone at the origin). Each step adds
 * `count` blocks of `type`, seeded as `groups` groups (null = count: every block a seed,
 * straight onto the world, layer by layer) that grow by `distribution` and `growth`. With `count: null` and
 * `shells: n`, the count is taken from the world's empty shell (its cell count), and the step
 * runs `n` times, re-polling the shell each time. `addTo` says where the seeds go: "world"
 * (the default) seeds them in the empty shell around the world, i.e. all the blocks on the
 * board together; "sky" seeds them at random 50 cm from the origin, like rain. See generateNew.
 */
//shellSize(i) = 14 + 24*i + 12*i^2
//shellSize(0) = 1, cumulativeSize(0) = 1
//shellSize(1) = 14, cumulativeSize(1) = 15
//shellSize(2) = 50, cumulativeSize(2) = 65
//shellSize(3) = 110, cumulativeSize(3) = 175
//shellSize(4) = 194, cumulativeSize(4) = 369
//If groups=1, distribution and growth don't matter
//TODO: a "branching" growth rule
/** Recipe `addTo: "sky"`: seeds go at random on the sphere this far from the origin (like rain). */
export const SKY_RADIUS_CM = 50;
/** "sky" seeding gives up on a seed after this many tries landing on taken cells. */
const SKY_TRIES = 50;

export const NEW_SCENE_RECIPE = [
  //Geode
  { type: BLOCK.VOID, groups: null, count: 20, shells: null, distribution: 'uniform', growth: "worm", addTo: "world" },
  { type: BLOCK.VOID, groups: null, count: null, shells: 2, distribution: 'uniform', growth: "uniform", addTo: "world" },
  { type: BLOCK.CRYSTAL, groups: null, count: null, shells: 1, distribution: 'random', growth: "uniform", addTo: "world" },
  { type: BLOCK.STONE, groups: null, count: null, shells: 1, distribution: 'uniform', growth: "uniform", addTo: "world" },
  //Bury geode
  { type: BLOCK.DIRT, groups: null, count: null, shells: 1, distribution: 'uniform', growth: "random", addTo: "world" },
  { type: BLOCK.DIRT, groups: null, count: null, shells: 1, distribution: 'uniform', growth: "uniform", addTo: "world" },
  //Crust
  { type: BLOCK.STONE, count: 5, groups: 30, shells: null, distribution: 'random', growth: "random", addTo: "world" },
  { type: BLOCK.STONE, count: 5, groups: 30, shells: null, distribution: 'uniform', growth: "uniform", addTo: "world" },
  { type: BLOCK.CRYSTAL, count: 20, groups: 5, shells: null, distribution: 'random', growth: "uniform", addTo: "world" },
  { type: BLOCK.STONE, count: 10, groups: 30, shells: null, distribution: 'uniform', growth: "uniform", addTo: "world" },
  //Soil
  { type: BLOCK.DIRT, count: 10, groups: 20, shells: null, distribution: 'random', growth: "random", addTo: "world" },
  { type: BLOCK.STONE, count: 10, groups: 20, shells: null, distribution: 'uniform', growth: "uniform", addTo: "world" },
  { type: BLOCK.WOOD, count: 30, groups: 6, shells: null, distribution: 'random', growth: "tree", addTo: "world" },
  { type: BLOCK.DIRT, count: 10, groups: 30, shells: null, distribution: 'uniform', growth: "uniform", addTo: "world" },
  { type: BLOCK.MOSS, count: 500, groups: 80, shells: null, distribution: 'random', growth: "uniform", addTo: "world" },
  //Water and creatures
  { type: BLOCK.WATER, count: 100, groups: 5, shells: null, distribution: 'random', growth: "random", addTo: "world" },
  { type: BLOCK.CRAWLY, count: 10, groups: 5, shells: null, distribution: 'random', growth: "worm", addTo: "world", addTo: "world" },
  { type: BLOCK.BUZZY, count: 5, groups: 5, shells: null, distribution: 'random', growth: "worm", addTo: "world" },
  { type: BLOCK.SQUIRMY, count: 10, groups: 3, shells: null, distribution: 'random', growth: "random", addTo: "world" },
  //Fog and clouds
  { type: BLOCK.FOG, groups: null, count: null, shells: 1, distribution: 'uniform', growth: "uniform", addTo: "world" },
  { type: BLOCK.NIMBUS, groups: 4, count: 100, shells: null, distribution: 'uniform', growth: "uniform", addTo: "sky" },
];

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

/**
 * Stores the blocks and renders them with one InstancedMesh (used for raycasting), plus
 * a translucent mesh that shares its instance buffers and draws only the see-through
 * blocks (Water, Crystal).
 * Coordinates are integer cm on the BCC lattice; the parent group scales cm -> m.
 */
export class World {
  constructor(parent) {
    this.parent = parent;
    this.geometry = createBlockGeometry();
    this.materials = createBlockMaterials();
    this.translucentMesh = null;
    this.blocks = new Map(); // key -> { x, y, z, type, index }
    this.keysByIndex = [];
    this.anims = new Map(); // key -> { from, to, t0, dur } for sliding blocks
    this.vanishing = new Map(); // block -> { from, dir, t0, dur }: shrinking away, removed at the end
    this.appearing = new Map(); // block -> { from, t0, dur }: growing in from `from` (see appear)
    this.buffed = new Set(); // blocks carrying buffs (b.buffs), counted down each turn (tickBuffs)
    this.crawlies = new Set(); // one-block creatures: Crawlies and Buzzies (also carry .floor and .front, see creature.js)
    // Squirmies: touching Squirmy blocks form one creature, a chain ordered by placement
    // (`born`): the first placed is the head (it has the eyes and the behavior), the last the tail
    this.squirmyBlocks = new Set();
    this.squirmies = []; // [{ segments: [head, …, tail] }], see refreshSquirmies
    this.squirmyOf = new Map(); // Squirmy block -> its squirmy
    this._born = 0;
    this.eyes = new CreatureEyes(parent);
    this.bundleBodies = new BundleBodies(parent, this.materials); // Options → Rendering: Smooth
    this.revision = 0; // bumped whenever blocks are added, removed, moved, retyped or recoloured (see _changed)
    this.stepSeconds = STEP_FRACTION; // length of per-turn animations (s); the engine sets it from the turn length
    this.fogEnabled = true; // Options → Fog (set by the engine): generateNew skips Fog steps when off
    this.turn = 0; // current game turn, set by the engine; stamped on blocks as movedTurn
    this.listeners = new Map(); // event name -> Set of handlers (see on / emit)
    // BlockBundles: same-type groups of connected non-creature blocks (trees are Wood bundles),
    // rebuilt at the end of every turn (sim.js updateBlockBundles). For creatures, and for an
    // up-to-the-moment bundle of any block, see bundleOf().
    this.blockBundles = []; // [{ type, blocks }]
    this.bundleByBlock = new Map(); // block -> its bundle
    this.capacity = 0;
    this.mesh = null;
    this._allocate(1024);
  }

  /**
   * Game events raised by the simulation, for things outside it (sounds, effects):
   *   'berryGrow' (berry block) — a tree grew a Berry
   *   'crawlyArrived' (crawly)  — a walking Crawly reached its target
   *   'crawlyTrapped' (crawly)  — a Crawly got walled in (Trapped behavior)
   *   'crawlyFreed' (crawly)    — a Trapped Crawly found a gap (back to Wander)
   *   'crawlyDied' ({ crawly, x, y, z }) — a Crawly died (its block is already removed)
   *   'blockConsumed' ({ by, block, sound, slot }) — `by` consumed `block` (see consume)
   *   'blockExcreted' ({ by, block, sound }) — a bundle's tail `by` excreted `block` (see excrete)
   *   'blockBlown' ({ by, block, sound }) — `block` was blown away from `by` (see blow)
   *   'buffAdded' ({ block, type, turns, charges, buff, refreshed }) / 'buffExpired' ({ block, type })
   *   'behaviorChanged' ({ block, from, to }) — a creature's behavior changed (see _watchBehavior)
   * `on` returns a function that removes the handler.
   */
  on(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(fn);
    return () => this.listeners.get(name)?.delete(fn);
  }

  emit(name, data) {
    for (const fn of this.listeners.get(name) ?? []) fn(data);
  }

  /** Re-derives a Crawly's floor/front; revolves its eyes if either changed. */
  _reorient(c, moveDir = null, durationS = this.stepSeconds) {
    const { front, floor } = c;
    orientCreature(this, c, moveDir);
    if (c.front !== front || c.floor !== floor) this.eyes.track(c, durationS);
  }

  /** Re-derives the floor of every Crawly next to cell (x, y, z). */
  _reorientAround(x, y, z) {
    if (!this.crawlies.size && !this.squirmyBlocks.size) return;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const n = this.blocks.get(cellKey(x + dx, y + dy, z + dz));
      if (n && (isSingleCreature(n.type) || n.isHead)) this._reorient(n);
    }
  }

  /**
   * Re-bundles Squirmy blocks into Squirmies: touching Squirmy blocks form one chain, ordered
   * by `born` (placement order), so the first placed is the head and the last the tail. The
   * head carries the eyes; a block that stops being a head loses them.
   */
  refreshSquirmies() {
    const seen = new Set();
    this.squirmies = [];
    this.squirmyOf.clear();
    for (const start of this.squirmyBlocks) {
      if (seen.has(start)) continue;
      seen.add(start);
      const segments = [start];
      for (let i = 0; i < segments.length; i++) {
        for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
          const n = this.blocks.get(cellKey(segments[i].x + dx, segments[i].y + dy, segments[i].z + dz));
          if (n && n.type === BLOCK.SQUIRMY && !seen.has(n)) {
            seen.add(n);
            segments.push(n);
          }
        }
      }
      segments.sort((a, b) => a.born - b.born);
      const sq = { segments };
      this.squirmies.push(sq);
      segments.forEach((b, i) => {
        this.squirmyOf.set(b, sq);
        const wasHead = !!b.isHead;
        b.isHead = i === 0;
        b.isTail = i === segments.length - 1;
        if (b.isHead && !wasHead) {
          orientCreature(this, b);
          this.eyes.track(b, 0);
        } else if (!b.isHead && wasHead) this.eyes.untrack(b);
      });
    }
  }

  /** Snaps every Crawly's orientation and eyes into place with no animation. */
  _settleCrawlies() {
    for (const c of [...this.crawlies, ...this.squirmyBlocks]) {
      if (c.type === BLOCK.SQUIRMY && !c.isHead) continue; // only Squirmy heads have eyes
      orientCreature(this, c);
      this.eyes.track(c, 0);
    }
  }

  /**
   * Recomputes the face mask (blockStyle.z) of the translucent block (Water, Crystal) at
   * (x, y, z), if any, and of every translucent block next to it: bit i set = face i touches
   * a block of the same type, so that shared face is skipped (touching blocks look like one).
   */
  _refreshTranslucentAround(x, y, z) {
    const style = this.geometry.getAttribute('blockStyle');
    const update = (b) => {
      if (!b || !isTranslucent(b.type)) return;
      // a vanishing block is on its way out: it shows all its faces, and its neighbours
      // show the faces they shared with it
      let mask = 0;
      if (!b.vanishing) {
        FACE_DIRS.forEach(([dx, dy, dz], i) => {
          const n = this.blocks.get(cellKey(b.x + dx, b.y + dy, b.z + dz));
          if (n?.type === b.type && !n.vanishing) mask |= 1 << i;
        });
      }
      style.setZ(b.index, mask);
    };
    update(this.blocks.get(cellKey(x, y, z)));
    for (const [dx, dy, dz] of FACE_DIRS) update(this.blocks.get(cellKey(x + dx, y + dy, z + dz)));
  }

  /**
   * Recomputes the ambient-occlusion neighbour mask (blockStyle.w) of the block at
   * (x, y, z), if any, and of every block next to it: bit i set = the neighbour across
   * face i holds a block that occludes (anything but see-through Water and Crystal).
   */
  _refreshAOAround(x, y, z) {
    const style = this.geometry.getAttribute('blockStyle');
    const update = (b) => {
      if (!b) return;
      let mask = 0;
      FACE_DIRS.forEach(([dx, dy, dz], i) => {
        const n = this.blocks.get(cellKey(b.x + dx, b.y + dy, b.z + dz));
        if (n && !isTranslucent(n.type)) mask |= 1 << i;
      });
      style.setW(b.index, mask);
    };
    update(this.blocks.get(cellKey(x, y, z)));
    for (const [dx, dy, dz] of FACE_DIRS) update(this.blocks.get(cellKey(x + dx, y + dy, z + dz)));
  }

  /**
   * A block's BlockBundle, right now: a Squirmy's whole chain (head .. tail), a Crawly on its
   * own, or else every block of the same type connected to it, nearest first (so a tree is
   * its connected Wood, listed outward from `b`).
   */
  bundleOf(b) {
    if (b.type === BLOCK.SQUIRMY) return [...(this.squirmyOf.get(b)?.segments ?? [b])];
    if (isCreature(b.type)) return [b];
    const seen = new Set([b]);
    const list = [b];
    for (let i = 0; i < list.length; i++) {
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const n = this.blocks.get(cellKey(list[i].x + dx, list[i].y + dy, list[i].z + dz));
        if (n && n.type === b.type && !seen.has(n)) {
          seen.add(n);
          list.push(n);
        }
      }
    }
    return list;
  }

  /**
   * The inventory slot an item consumed by block `a` would go into, or null if none is free.
   * Every block has one slot (`b.inventory`: a block type, or empty). Wood and creatures
   * pass items along their bundle, into its last empty slot (a Squirmy's toward the tail, a
   * tree's furthest from the drinking block); other blocks keep them in their own slot.
   */
  freeSlotFor(a) {
    if (a.type === BLOCK.WOOD || isCreature(a.type)) {
      const bundle = this.bundleOf(a);
      for (let i = bundle.length - 1; i >= 0; i--) if (!bundle[i].inventory) return bundle[i];
      return null;
    }
    return a.inventory ? null : a;
  }

  /**
   * Block `a` consumes block `b`: `b` shrinks away as it drifts toward `a` (vanish), the
   * sound `sound` plays ('blockConsumed' event; the engine plays it), and `b`'s type goes
   * into an inventory slot (freeSlotFor). With `instant`, `b` is removed at once instead of
   * animating (when something is about to take its cell). Returns the block whose slot now
   * holds it, or null (doing nothing) if there is no free slot, or `b` is gone or already
   * vanishing.
   */
  consume(a, b, sound, { instant = false } = {}) {
    if (!a || !b || b.vanishing || this.blocks.get(cellKey(b.x, b.y, b.z)) !== b) return null;
    const slot = this.freeSlotFor(a);
    if (!slot) return null;
    slot.inventory = b.type;
    if (instant) this.remove(b.x, b.y, b.z);
    else {
      // it shrinks away as a lone block: keep it rounded (Rendering: Smooth), as it was in its body
      this.setSmooth(b, true);
      this.vanish(b, a, { toward: true });
    }
    this.emit('blockConsumed', { by: a, block: b, sound, slot });
    return slot;
  }

  /**
   * BlockBundle `bundle` (e.g. bundleOf(creature), or a falling group) blows block `b` away:
   * `b` shrinks to nothing while drifting away from the bundle's block nearest to it
   * (vanish), then is dropped from the board; the sound `sound` plays ('blockBlown' event; the
   * engine plays it). Like consume, but nothing is kept. Returns false if `b` is gone or
   * already vanishing.
   */
  blow(bundle, b, sound) {
    if (!b || b.vanishing || this.blocks.get(cellKey(b.x, b.y, b.z)) !== b || !bundle.length) return false;
    let from = bundle[0], best = Infinity;
    for (const a of bundle) {
      const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
      if (d < best) {
        best = d;
        from = a;
      }
    }
    if (!this.vanish(b, from)) return false;
    this.emit('blockBlown', { by: from, block: b, sound });
    return true;
  }

  /**
   * Makes creature block `b`'s `behavior` a watched property: any change to it, from anywhere
   * (the sim, the Select tool, buttons, …), emits 'behaviorChanged' ({ block, from, to }).
   * Its first value (when the creature is placed or loaded) isn't reported.
   */
  _watchBehavior(b) {
    if (Object.getOwnPropertyDescriptor(b, 'behavior')?.get) return;
    let value = b.behavior;
    Object.defineProperty(b, 'behavior', {
      enumerable: true,
      configurable: true,
      get: () => value,
      set: (v) => {
        if (v === value) return;
        const from = value;
        value = v;
        if (from !== undefined) this.emit('behaviorChanged', { block: b, from, to: v });
      },
    });
  }

  // ---------------------------------------------------------------- buffs

  /**
   * Gives block `b` buff `type` (BUFF_TYPES) for `turns` turns (null: permanent) and
   * `charges` uses (null: unlimited). If it already has it, the longer of each limit is kept
   * (no limit beats any). Its look updates (a buff's colour).
   */
  addBuff(b, type, turns = null, charges = null) {
    turns ??= null;
    charges ??= null;
    if (!BUFF_TYPES[type] || (turns !== null && !(turns > 0)) || (charges !== null && !(charges > 0))) return;
    b.buffs ??= [];
    const longer = (a, c) => (a === null || c === null ? null : Math.max(a, c));
    let x = b.buffs.find((y) => y.type === type);
    const refreshed = !!x;
    if (x) {
      x.turns = longer(x.turns, turns);
      x.charges = longer(x.charges, charges);
    } else b.buffs.push((x = { type, turns, charges }));
    this.buffed.add(b);
    this._refreshLook(b);
    this.emit('buffAdded', { block: b, type, turns: x.turns, charges: x.charges, buff: x, refreshed });
  }

  /**
   * Creature `b` just ate a block of `foodType`: each of its buffs with charges whose
   * priorityDiet includes that food uses one up; one at 0 charges expires.
   */
  useBuffCharges(b, foodType) {
    if (!b.buffs?.length) return;
    let spent = false;
    for (const x of b.buffs) {
      if (x.charges == null || !BUFF_TYPES[x.type]?.priorityDiet?.includes(foodType)) continue;
      x.charges--;
      spent = true;
      this.emit('buffChargeUsed', { block: b, type: x.type, charges: x.charges });
    }
    if (spent) this._dropExpiredBuffs(b);
  }

  /** Removes block `b`'s buffs that ran out (0 turns or 0 charges), with events and its look. */
  _dropExpiredBuffs(b) {
    const gone = (x) => (x.turns !== null && x.turns <= 0) || (x.charges !== null && x.charges <= 0);
    const before = b.buffs.length;
    for (const x of b.buffs) if (gone(x)) this.emit('buffExpired', { block: b, type: x.type });
    b.buffs = b.buffs.filter((x) => !gone(x));
    if (!b.buffs.length) {
      delete b.buffs;
      this.buffed.delete(b);
    }
    if ((b.buffs?.length ?? 0) !== before) this._refreshLook(b);
  }

  /** Counts every timed buff down by one turn; expired ones are removed and the block's look restored. */
  tickBuffs() {
    for (const b of [...this.buffed]) {
      if (this.blocks.get(cellKey(b.x, b.y, b.z)) !== b || !b.buffs?.length) {
        this.buffed.delete(b);
        continue;
      }
      for (const x of b.buffs) if (x.turns !== null) x.turns--;
      this._dropExpiredBuffs(b);
    }
  }

  /**
   * A block's colour: a buff's colour while it has one (e.g. Rockbiter's gold), otherwise its
   * type's. The shader's tint flag (blockStyle.z, unused by opaque blocks otherwise) turns a
   * creature's shell to that colour.
   */
  _refreshLook(b) {
    const tint = b.buffs?.map((x) => BUFF_TYPES[x.type]).find((x) => x?.color);
    this.mesh.setColorAt(b.index, _c.set(tint?.color ?? BLOCK_COLORS[b.type]));
    if (!isTranslucent(b.type)) this.geometry.getAttribute('blockStyle').setZ(b.index, tint ? 1 : 0);
    this._dirty();
    this._changed();
  }

  /** Where block `b` is drawn right now (mid-slide while it is moving), in cm. */
  renderedPosition(b, now, out) {
    const a = this.anims.get(cellKey(b.x, b.y, b.z));
    if (!a) return out.set(b.x, b.y, b.z);
    const t = Math.min(1, (now - a.t0) / a.dur);
    return out.lerpVectors(a.from, a.to, t * t * (3 - 2 * t)); // smoothstep ease in/out
  }

  _allocate(capacity) {
    const old = this.mesh;
    const mesh = new THREE.InstancedMesh(this.geometry, this.materials.opaque, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.name = 'blocks';
    // make sure the colour buffer exists
    mesh.setColorAt(0, _c.set('#ffffff'));
    // per-instance (style, seed, translucent face mask, AO neighbour mask) for the block shader; lives on the shared geometry
    const oldStyle = this.geometry.getAttribute('blockStyle');
    const style = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    style.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('blockStyle', style);
    // per-instance Smooth rendering flag: 1 = drawn by a bundle body instead (rewritten by BundleBodies)
    const merged = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    merged.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('blockMerged', merged);
    this.revision = (this.revision ?? 0) + 1;
    // per-instance smooth shading flag (b.shadeSmooth, e.g. excreted blocks; see _writeSmooth)
    const smooth = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    smooth.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('blockSmooth', smooth);
    for (const b of this.blocks.values()) smooth.setX(b.index, b.shadeSmooth ? 1 : 0);
    if (old) {
      for (let i = 0; i < old.count; i++) {
        old.getMatrixAt(i, _m);
        mesh.setMatrixAt(i, _m);
        old.getColorAt(i, _c);
        mesh.setColorAt(i, _c);
        style.setXYZW(i, oldStyle.getX(i), oldStyle.getY(i), oldStyle.getZ(i), oldStyle.getW(i));
      }
      mesh.count = old.count;
      this.parent.remove(old);
      old.dispose();
    }
    if (this.translucentMesh) {
      this.parent.remove(this.translucentMesh);
      this.translucentMesh.dispose();
    }
    // same instances, translucent material (Water, Crystal); raycasts go through `mesh` only
    const translucent = new THREE.InstancedMesh(this.geometry, this.materials.translucent, capacity);
    translucent.instanceMatrix = mesh.instanceMatrix;
    translucent.instanceColor = mesh.instanceColor;
    translucent.frustumCulled = false;
    translucent.name = 'translucent-blocks';
    translucent.raycast = () => { };
    this.parent.add(mesh);
    this.parent.add(translucent);
    this.mesh = mesh;
    this.translucentMesh = translucent;
    this.capacity = capacity;
    this._dirty();
  }

  _dirty() {
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.geometry.getAttribute('blockStyle').needsUpdate = true;
    this.geometry.getAttribute('blockSmooth').needsUpdate = true;
    this.translucentMesh.count = this.mesh.count;
    this.mesh.boundingSphere = null;
    this.mesh.boundingBox = null;
  }

  get size() {
    return this.blocks.size;
  }

  has(x, y, z) {
    return this.blocks.has(cellKey(x, y, z));
  }

  get(x, y, z) {
    return this.blocks.get(cellKey(x, y, z));
  }

  /** Draw this block 50 % see-through (dithered); pass null to clear. */
  setDithered(block) {
    this.materials.uniforms.uDitherIndex.value = block ? block.index : -1;
  }

  blockAtIndex(i) {
    const k = this.keysByIndex[i];
    return k ? this.blocks.get(k) : undefined;
  }

  add(x, y, z, type) {
    if (!isValidCell(x, y, z) || !BLOCK_COLORS[type]) return false;
    const k = cellKey(x, y, z);
    if (this.blocks.has(k)) return false;
    if (this.blocks.size >= this.capacity) this._allocate(this.capacity * 2);
    const index = this.blocks.size;
    const b = { x, y, z, type, index };
    this.blocks.set(k, b);
    this.keysByIndex[index] = k;
    _m.makeTranslation(x, y, z);
    this.mesh.setMatrixAt(index, _m);
    this.mesh.setColorAt(index, _c.set(BLOCK_COLORS[type]));
    this.geometry.getAttribute('blockStyle').setXYZW(index, blockProps(type).style, Math.random() * 40, 0, 0);
    this._writeSmooth(b);
    if (isTranslucent(type)) this._refreshTranslucentAround(x, y, z);
    this._refreshAOAround(x, y, z);
    this.mesh.count = this.blocks.size;
    this._dirty();
    this._changed();
    if (isSingleCreature(type)) {
      this._watchBehavior(b);
      b.behavior = blockProps(b.type).defaultBehavior;
      b.sightRadius = blockProps(b.type).sightRadius;
      this.crawlies.add(b);
      orientCreature(this, b);
      this.eyes.track(b, 0);
    }
    if (type === BLOCK.SQUIRMY) {
      b.born = this._born++;
      this._watchBehavior(b);
      b.behavior = blockProps(b.type).defaultBehavior; // Wander (the head's behavior drives the whole Squirmy)
      b.sightRadius = blockProps(b.type).sightRadius; // used while this block is the head
      this.squirmyBlocks.add(b);
      this.refreshSquirmies();
    }
    this._reorientAround(x, y, z);
    return true;
  }

  remove(x, y, z) {
    const k = cellKey(x, y, z);
    const b = this.blocks.get(k);
    if (!b) return false;
    const last = this.blocks.size - 1;
    if (b.index !== last) {
      // move the last instance into the freed slot
      const lastKey = this.keysByIndex[last];
      const lb = this.blocks.get(lastKey);
      this.mesh.getMatrixAt(last, _m);
      this.mesh.setMatrixAt(b.index, _m);
      this.mesh.getColorAt(last, _c);
      this.mesh.setColorAt(b.index, _c);
      const style = this.geometry.getAttribute('blockStyle');
      style.setXYZW(b.index, style.getX(last), style.getY(last), style.getZ(last), style.getW(last));
      lb.index = b.index;
      this._writeSmooth(lb);
      this.keysByIndex[b.index] = lastKey;
    }
    this.keysByIndex.length = last;
    this.blocks.delete(k);
    this.anims.delete(k);
    this.crawlies.delete(b);
    this.eyes.untrack(b);
    this.buffed.delete(b);
    if (this.squirmyBlocks.delete(b)) {
      delete b.isHead;
      this.refreshSquirmies();
    }
    this.mesh.count = this.blocks.size;
    this._changed();
    if (isTranslucent(b.type)) this._refreshTranslucentAround(x, y, z);
    this._refreshAOAround(x, y, z);
    this._dirty();
    this._reorientAround(x, y, z);
    return true;
  }

  /**
   * Changes a block's type in place (same cell, index and pattern seed), updating its
   * colour, shader style, Crawly tracking, translucent face masks, ambient occlusion and
   * neighbouring Crawly floors.
   */
  setType(b, type) {
    if (!BLOCK_COLORS[type] || b.type === type || this.blocks.get(cellKey(b.x, b.y, b.z)) !== b) return false;
    const old = b.type;
    b.type = type;
    delete b.buffs; // buffs belong to what the block was
    this.buffed.delete(b);
    this._changed();
    if (b.shadeSmooth && blockProps(type).shadeFlat) this.setSmooth(b, false);
    this.mesh.setColorAt(b.index, _c.set(BLOCK_COLORS[type]));
    const style = this.geometry.getAttribute('blockStyle');
    style.setX(b.index, blockProps(type).style);
    style.setZ(b.index, 0);
    if (old === BLOCK.SQUIRMY) {
      this.squirmyBlocks.delete(b);
      this.eyes.untrack(b);
      delete b.isHead;
      this.refreshSquirmies();
    } else if (type === BLOCK.SQUIRMY) {
      b.born = this._born++;
      this._watchBehavior(b);
      b.behavior = blockProps(b.type).defaultBehavior;
      b.sightRadius = blockProps(b.type).sightRadius;
      this.squirmyBlocks.add(b);
      this.refreshSquirmies();
    }
    if (isSingleCreature(old)) {
      this.crawlies.delete(b);
      this.eyes.untrack(b);
    } else if (isSingleCreature(type)) {
      this._watchBehavior(b);
      b.behavior = blockProps(b.type).defaultBehavior;
      b.sightRadius = blockProps(b.type).sightRadius;
      this.crawlies.add(b);
      orientCreature(this, b);
      this.eyes.track(b, 0);
    }
    if (isTranslucent(old) || isTranslucent(type)) {
      this._refreshTranslucentAround(b.x, b.y, b.z);
      this._refreshAOAround(b.x, b.y, b.z); // see-through blocks don't occlude, others do
    }
    this._dirty();
    this._reorientAround(b.x, b.y, b.z);
    return true;
  }

  /**
   * Moves a block to an empty neighbouring cell. The data moves immediately; the
   * rendered block slides there over `durationS` seconds (see updateAnimations).
   * `turnCrawly: false` keeps a Crawly's front unchanged (it was carried, not walking).
   */
  move(from, to, durationS = this.stepSeconds, { turnCrawly = true } = {}) {
    const k = cellKey(from.x, from.y, from.z);
    const b = this.blocks.get(k);
    const tk = cellKey(to.x, to.y, to.z);
    if (!b || this.blocks.has(tk) || !isValidCell(to.x, to.y, to.z)) return false;
    this.blocks.delete(k);
    const fromPos = new THREE.Vector3(b.x, b.y, b.z);
    b.x = to.x;
    b.y = to.y;
    b.z = to.z;
    this.blocks.set(tk, b);
    this.keysByIndex[b.index] = tk;
    b.movedTurn = this.turn; // lets rules tell settled blocks from moving ones
    this.anims.set(tk, { from: fromPos, to: new THREE.Vector3(to.x, to.y, to.z), t0: performance.now(), dur: durationS * 1000 });
    // a Crawly now faces the way it moved (unless it was carried, e.g. by a falling group);
    // its old and new neighbours may change floors
    if (isSingleCreature(b.type) || b.isHead) {
      this._reorient(b, turnCrawly ? [to.x - fromPos.x, to.y - fromPos.y, to.z - fromPos.z] : null, durationS);
    }
    this._reorientAround(fromPos.x, fromPos.y, fromPos.z);
    this._reorientAround(to.x, to.y, to.z);
    if (isTranslucent(b.type)) {
      this._refreshTranslucentAround(fromPos.x, fromPos.y, fromPos.z);
      this._refreshTranslucentAround(to.x, to.y, to.z);
    }
    this._refreshAOAround(fromPos.x, fromPos.y, fromPos.z);
    this._refreshAOAround(to.x, to.y, to.z);
    this._dirty();
    this._changed();
    return true;
  }

  /**
   * Options → Rendering: Smooth (on) draws each BlockBundle as one merged, smoothed,
   * smooth-shaded body (bundleBody.js); Blocky (off) draws every block on its own.
   */
  setSmoothRendering(on) {
    this.materials.uniforms.uSmoothRendering.value = on ? 1 : 0;
    this.bundleBodies.setEnabled(on);
  }

  /**
   * Smooth shading for block `b` (`b.shadeSmooth`): rounded normals (out from the block
   * centre) and no face outlines, like a creature, while Options → Rendering is Smooth
   * (Blocky draws it flat like any block). Ignored for shadeFlat types (Crystal).
   */
  setSmooth(b, on) {
    on = on && !blockProps(b.type).shadeFlat;
    if (on) b.shadeSmooth = true;
    else delete b.shadeSmooth;
    this._writeSmooth(b);
    this._dirty();
  }

  _writeSmooth(b) {
    this.geometry.getAttribute('blockSmooth').setX(b.index, b.shadeSmooth ? 1 : 0);
  }

  /** Something about the blocks changed (cells, types, looks): Smooth rendering's bodies get rebuilt. */
  _changed() {
    this.revision++;
  }

  /** Advances sliding blocks, Crawly eyes and the water animation; call once per frame. */
  updateAnimations(now = performance.now()) {
    this.materials.uniforms.uTime.value = now / 1000;
    const p = new THREE.Vector3();
    this.eyes.update(now, (c, out) => this.renderedPosition(c, now, out), { turn: this.turn, flapSeconds: this.stepSeconds * 0.5, stepSeconds: this.stepSeconds });
    this.bundleBodies.update(this, now);
    if (!this.anims.size && !this.vanishing.size && !this.appearing.size) return;
    for (const [k, a] of this.anims) {
      const b = this.blocks.get(k);
      if (!b) {
        this.anims.delete(k);
        continue;
      }
      this.renderedPosition(b, now, p);
      this.mesh.setMatrixAt(b.index, _m.makeTranslation(p.x, p.y, p.z));
      if (now - a.t0 >= a.dur) this.anims.delete(k);
    }
    this._updateVanishing(now);
    this._updateAppearing(now);
    this._dirty();
  }

  /**
   * Plays a "cleared away" animation on block `b`: over `durationS` it shrinks to nothing
   * while drifting `distanceCm` directly away from block / point `other` (or toward it,
   * with `toward: true`), then it is removed (and 'blockVanished' is emitted). Until then it
   * stays in the world, flagged `b.vanishing`, so rules can skip it. Returns false if it is
   * already vanishing.
   */
  vanish(b, other, { durationS = this.stepSeconds, distanceCm = 1, toward = false } = {}) {
    if (b.vanishing || this.blocks.get(cellKey(b.x, b.y, b.z)) !== b) return false;
    b.vanishing = true;
    const dir = new THREE.Vector3(b.x - other.x, b.y - other.y, b.z - other.z);
    if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
    dir.normalize().multiplyScalar(toward ? -distanceCm : distanceCm);
    if (isTranslucent(b.type)) this._refreshTranslucentAround(b.x, b.y, b.z);
    this.anims.delete(cellKey(b.x, b.y, b.z)); // the vanish animation takes over its matrix
    this._changed(); // shrinks away on the instanced mesh, not in a bundle body
    this.vanishing.set(b, { from: new THREE.Vector3(b.x, b.y, b.z), dir, t0: performance.now(), dur: durationS * 1000 });
    return true;
  }

  /**
   * Plays an "arriving" animation on block `b` (already in the world, in its cell): over
   * `durationS` it moves from point `from` (cm) into its cell while growing from nothing to
   * full size. The reverse of vanish.
   */
  appear(b, from, { durationS = this.stepSeconds } = {}) {
    this.anims.delete(cellKey(b.x, b.y, b.z));
    this._changed(); // grows in on the instanced mesh, joins its bundle body once there
    this.appearing.set(b, { from: new THREE.Vector3(from.x, from.y, from.z), t0: performance.now(), dur: durationS * 1000 });
    this._updateAppearing(performance.now()); // start at size 0, not full size for a frame
  }

  _updateAppearing(now) {
    const pos = new THREE.Vector3(), scale = new THREE.Vector3(), noRot = new THREE.Quaternion();
    for (const [b, a] of this.appearing) {
      if (this.blocks.get(cellKey(b.x, b.y, b.z)) !== b || this.anims.has(cellKey(b.x, b.y, b.z))) {
        this.appearing.delete(b); // removed, or moved on (a slide takes over its matrix)
        continue;
      }
      const t = Math.min(1, (now - a.t0) / a.dur);
      const e = t * t * (3 - 2 * t); // smoothstep ease in/out
      pos.set(b.x, b.y, b.z).sub(a.from).multiplyScalar(e).add(a.from);
      scale.setScalar(Math.max(e, 1e-4));
      this.mesh.setMatrixAt(b.index, _m.compose(pos, noRot, scale));
      if (t >= 1) {
        this.appearing.delete(b);
        this._changed();
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * BlockBundle `bundle` (ordered head .. tail, e.g. World.bundleOf) excretes the item in its
   * tail's inventory slot: a block of that type is created in an empty cell next to the tail,
   * preferably directly behind it (continuing the line from the segment before the tail, or,
   * for a one-block creature, opposite its front), the slot is emptied, the remaining items
   * move along the queue toward the tail (packed at the tail end, order kept), and the new
   * block grows in from the tail to its cell (appear) while the sound `sound` plays
   * ('blockExcreted' event; the engine plays it). `cell` ({ x, y, z }, optional) picks the cell
   * instead (a Nimbus raining straight down). Returns the new block, or null if the tail's slot
   * is empty or it has no empty neighbouring cell (or `cell` is taken).
   */
  excrete(bundle, sound, { cell: into = null } = {}) {
    const tail = bundle[bundle.length - 1];
    if (!tail?.inventory) return null;
    // "behind": away from the segment before the tail, or opposite a lone creature's front
    const prev = bundle[bundle.length - 2];
    const behind = prev
      ? new THREE.Vector3(tail.x - prev.x, tail.y - prev.y, tail.z - prev.z)
      : tail.front ? new THREE.Vector3(...tail.front).negate() : new THREE.Vector3();
    let cell = into && !this.blocks.has(cellKey(into.x, into.y, into.z)) ? into : null, best = -Infinity;
    if (!into) for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const x = tail.x + dx, y = tail.y + dy, z = tail.z + dz;
      if (this.blocks.has(cellKey(x, y, z))) continue;
      const score = behind.lengthSq() ? behind.dot(new THREE.Vector3(dx, dy, dz).normalize()) : Math.random();
      if (score > best) {
        best = score;
        cell = { x, y, z };
      }
    }
    if (!cell) return null;
    const type = tail.inventory;
    tail.inventory = null;
    // the rest of the items move along the queue toward the tail
    const items = bundle.map((b) => b.inventory).filter(Boolean);
    bundle.forEach((b, i) => (b.inventory = items[i - (bundle.length - items.length)] ?? null));
    if (!this.add(cell.x, cell.y, cell.z, type)) {
      tail.inventory = type; // couldn't place it after all: undo (the queue keeps its new order)
      return null;
    }
    const made = this.get(cell.x, cell.y, cell.z);
    this.setSmooth(made, true); // excreted blocks are smooth-shaded (unless their type is shadeFlat)
    this.appear(made, tail);
    this.emit('blockExcreted', { by: tail, block: made, sound });
    return made;
  }

  _updateVanishing(now) {
    const pos = new THREE.Vector3(), scale = new THREE.Vector3(), noRot = new THREE.Quaternion();
    for (const [b, v] of this.vanishing) {
      if (this.blocks.get(cellKey(b.x, b.y, b.z)) !== b) {
        this.vanishing.delete(b); // removed some other way meanwhile
        continue;
      }
      const t = Math.min(1, (now - v.t0) / v.dur);
      if (t >= 1) {
        this.vanishing.delete(b);
        this.remove(b.x, b.y, b.z);
        this.emit('blockVanished', b);
        continue;
      }
      const e = t * t * (3 - 2 * t); // smoothstep ease in/out
      pos.copy(v.from).addScaledVector(v.dir, e);
      scale.setScalar(Math.max(1 - e, 1e-4));
      this.mesh.setMatrixAt(b.index, _m.compose(pos, noRot, scale));
    }
  }

  clear() {
    this.buffed.clear();
    this.crawlies.clear();
    this.squirmyBlocks.clear();
    this.squirmies = [];
    this.squirmyOf.clear();
    this._born = 0;
    this.eyes.clear();
    this.anims.clear();
    this.vanishing.clear();
    this.appearing.clear();
    this.blocks.clear();
    this.keysByIndex.length = 0;
    this.mesh.count = 0;
    this._dirty();
  }

  /** Empty cells next to any of `blocks` (default: every block), in random order. */
  _shellOf(blocks = this.blocks.values()) {
    const out = new Map();
    for (const b of blocks) {
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const x = b.x + dx, y = b.y + dy, z = b.z + dz;
        const k = cellKey(x, y, z);
        if (!this.blocks.has(k) && !out.has(k)) out.set(k, [x, y, z]);
      }
    }
    const cells = [...out.values()];
    for (let i = cells.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    return cells;
  }

  /**
   * "tree" growth: polls the group's empty shell and picks a random cell of it that touches
   * exactly one block of the group's type and no other solid block (SOLID_TYPES: Stone, Dirt,
   * Moss, Wood, Berry), so the group branches out into open space without closing loops,
   * clumping, or growing along the ground or into other blocks of its type; null if there is
   * none.
   */
  _treeCell(members) {
    const type = members[0].type;
    const maxSolid = SOLID_TYPES.has(type) ? 1 : 0; // a solid type's parent block counts as the one
    for (const [x, y, z] of this._shellOf(members)) { // shuffled: the first match is a random one
      let same = 0, solid = 0;
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const n = this.get(x + dx, y + dy, z + dz);
        if (!n) continue;
        if (n.type === type) same++;
        if (SOLID_TYPES.has(n.type)) solid++;
        if (same > 1 || solid > maxSolid) break;
      }
      if (same === 1 && solid <= maxSolid) return [x, y, z];
    }
    return null;
  }

  /**
   * "worm" growth: an empty cell next to the group's most recently added block that touches
   * no other block of the group, so the group extends as a one-block-thick tube. If the
   * newest block has no such cell, the one before it is tried, and so on back. A random
   * cell among the matches; null if the group can't grow this way.
   */
  _wormCell(members) {
    const inGroup = new Set(members);
    for (let k = members.length - 1; k >= 0; k--) {
      const anchor = members[k];
      const cells = [];
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const x = anchor.x + dx, y = anchor.y + dy, z = anchor.z + dz;
        if (this.has(x, y, z)) continue;
        const touchesOther = NEIGHBOR_DIRS.some(([ex, ey, ez]) => {
          const n = this.get(x + ex, y + ey, z + ez);
          return n && n !== anchor && inGroup.has(n);
        });
        if (!touchesOther) cells.push([x, y, z]);
      }
      if (cells.length) return cells[Math.floor(Math.random() * cells.length)];
    }
    return null;
  }

  /**
   * "up" growth: the empty cell next to the group's most recently added block that is nearest
   * to the point directly "up" from it, one block (2 cm) away from the origin (gravity pulls
   * toward the origin; a block at the origin uses +y). Ties are broken at random. If the
   * newest block has no empty neighbour, the one before it is tried, and so on back; null if
   * the group can't grow.
   */
  _upCell(members) {
    for (let k = members.length - 1; k >= 0; k--) {
      const b = members[k];
      const len = Math.hypot(b.x, b.y, b.z);
      const [ux, uy, uz] = len > 0 ? [b.x / len, b.y / len, b.z / len] : [0, 1, 0];
      const tx = b.x + 2 * ux, ty = b.y + 2 * uy, tz = b.z + 2 * uz; // the cell straight up
      let best = [], bestD = Infinity;
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const x = b.x + dx, y = b.y + dy, z = b.z + dz;
        if (this.has(x, y, z) || !isValidCell(x, y, z)) continue;
        const d = (x - tx) ** 2 + (y - ty) ** 2 + (z - tz) ** 2;
        if (d < bestD - 1e-9) {
          bestD = d;
          best = [[x, y, z]];
        } else if (Math.abs(d - bestD) <= 1e-9) best.push([x, y, z]);
      }
      if (best.length) return best[Math.floor(Math.random() * best.length)];
    }
    return null;
  }

  /** Takes the next still-empty cell from a shuffled shell (cells filled meanwhile are skipped). */
  _takeFrom(shell) {
    while (shell.length) {
      const c = shell.pop();
      if (!this.has(...c)) return c;
    }
    return null;
  }

  /**
   * "New" scene: a Stone at the origin, then each NEW_SCENE_RECIPE step in order.
   *
   * The world shell is the layer of empty cells next to the world. It is used up cell by cell
   * (in random order) and only recalculated once every cell in it is filled, so the world
   * grows a layer at a time. For each step:
   *  - `addTo` picks where its seeds go:
   *     "world" (default): the world shell, around all the blocks on the board together
   *     "sky": random cells on the sphere SKY_RADIUS_CM (50 cm) from the origin, like rain
   *  - `groups: null` means `groups = count`: every block is a seed, so all `count` blocks go
   *    straight into world-shell cells and nothing is left to grow.
   *  - otherwise, `groups` seed blocks go into world-shell cells; seeds that touch are
   *    bundled into one group. The remaining `count - groups` blocks grow those groups.
   *    `distribution` picks which group gets each block:
   *     "random":  a random group
   *     "uniform": groups take turns, so they end up similar in size
   *    `growth` picks where in that group's shell (its empty neighbouring cells) it goes:
   *     "random":  any cell of the group's current shell, refreshed after every block, so
   *                new blocks can attach to ones just added (lumpy, spreading growth)
   *     "uniform": the group fills its whole shell before the shell is refreshed, so it
   *                grows in even layers (roundish)
   *     "worm":    next to the group's newest block and touching no other block of the group
   *                (falling back to the block before, and so on): a winding tube
   *     "up":      the empty cell next to the group's newest block nearest to the cell straight
   *                up from it (away from the origin; falling back to the block before, and so
   *                on): a column rising outward
   *     "tree":    a random cell of the group's (freshly polled) shell that touches exactly one
   *                block of its type and no other solid block: branches that never touch each
   *                other or the ground
   *    A group with no empty cells around it stops growing; the others carry on.
   */
  generateNew() {
    this.clear();
    this.add(0, 0, 0, BLOCK.STONE);
    let worldShell = [];
    const fromWorldShell = () => {
      let c = this._takeFrom(worldShell);
      if (!c) {
        worldShell = this._shellOf(); // layer used up: the next layer out
        c = this._takeFrom(worldShell);
      }
      return c;
    };
    /** Runs one recipe step, adding `count` blocks. */
    /** Where a step's seeds go (`addTo`): a function returning the next seed cell, or null. */
    const fromSky = () => {
      for (let i = 0; i < SKY_TRIES; i++) {
        const c = randomCellOnSphere(SKY_RADIUS_CM);
        if (!this.has(c.x, c.y, c.z) && isValidCell(c.x, c.y, c.z)) return [c.x, c.y, c.z];
      }
      return null;
    };
    const seedSource = (addTo) => {
      if (addTo === 'sky') return fromSky; // random cells SKY_RADIUS_CM from the origin, like rain
      if (addTo !== 'world') console.warn(`NEW_SCENE_RECIPE: unknown addTo "${addTo}", using "world"`);
      return fromWorldShell; // "world": the empty shell around all the blocks on the board
    };
    const runStep = ({ type, groups: groupCount, distribution = 'random', growth = 'random', addTo = 'world' }, count) => {
      const nextSeedCell = seedSource(addTo);
      const pickType = () => (type === 'random' ? RANDOM_BLOCKS[Math.floor(Math.random() * RANDOM_BLOCKS.length)] : type);
      // no groups given: every block is its own seed, straight into the world shell
      const groups = groupCount ?? count;
      // seeds
      const seeds = [];
      for (let i = 0; i < Math.min(groups, count); i++) {
        const c = nextSeedCell();
        if (!c) break;
        if (this.add(...c, pickType())) seeds.push(this.get(...c));
      }
      // bundle seeds that touch each other into groups
      const unbundled = new Set(seeds);
      const bundles = [];
      for (const seed of seeds) {
        if (!unbundled.has(seed)) continue;
        unbundled.delete(seed);
        const members = [seed];
        for (let i = 0; i < members.length; i++) {
          for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
            const n = this.get(members[i].x + dx, members[i].y + dy, members[i].z + dz);
            if (n && unbundled.has(n)) {
              unbundled.delete(n);
              members.push(n);
            }
          }
        }
        bundles.push({ members, shell: [] });
      }
      // grow the groups
      let left = count - seeds.length;
      let next = 0; // distribution "uniform": whose turn it is
      while (left > 0 && bundles.length) {
        // distribution: which group gets the next block
        const i = distribution === 'uniform' ? next % bundles.length : Math.floor(Math.random() * bundles.length);
        const g = bundles[i];
        // growth: when that group's fillable shell is refreshed
        let c;
        if (growth === 'worm') {
          c = this._wormCell(g.members);
        } else if (growth === 'up') {
          c = this._upCell(g.members);
        } else if (growth === 'tree') {
          c = this._treeCell(g.members);
        } else if (growth === 'uniform') {
          c = this._takeFrom(g.shell); // fill the current shell first…
          if (!c) {
            g.shell = this._shellOf(g.members); // …then move on to the next layer
            c = this._takeFrom(g.shell);
          }
        } else {
          c = this._takeFrom(this._shellOf(g.members)); // fresh shell after every block
        }
        if (!c) {
          bundles.splice(i, 1); // boxed in: this group can't grow
          continue;
        }
        if (this.add(...c, pickType())) {
          g.members.push(this.get(...c));
          left--;
        }
        next = i + 1;
      }
    };

    NEW_SCENE_RECIPE.forEach((step, line) => {
      if (step.type === BLOCK.FOG && !this.fogEnabled) return; // Options → Fog is off
      const before = this.blocks.size;
      if (step.count == null && step.shells != null) {
        // shells mode: the count is the size of the world's current empty shell, and the step
        // runs that way `shells` times (with groups: null, that lays exactly `shells` layers)
        for (let s = 0; s < step.shells; s++) {
          worldShell = this._shellOf(); // poll the empty shell now
          if (!worldShell.length) break;
          runStep(step, worldShell.length);
        }
      } else {
        runStep(step, step.count ?? 0);
      }
      const { type, groups = null, count = null, shells = null, distribution = 'random', growth = 'random', addTo = 'world' } = step;
      console.log(
        `Recipe ${line + 1}/${NEW_SCENE_RECIPE.length}: ${blockProps(type).name} ×${this.blocks.size - before} ` +
        `(count ${count ?? '—'}, shells ${shells ?? '—'}, groups ${groups ?? 'each block'}, ` +
        `distribution ${distribution}, growth ${growth}, addTo ${addTo}) → ${this.blocks.size} blocks`
      );
    });
    // Void only holds cells open while the recipe runs: clear it all out now
    const voids = [...this.blocks.values()].filter((b) => b.type === BLOCK.VOID);
    for (const b of voids) this.remove(b.x, b.y, b.z);
    if (voids.length) console.log(`Recipe done: removed ${voids.length} Void blocks → ${this.blocks.size} blocks`);
    this._settleCrawlies();
  }

  toJSON() {
    return {
      format: 'grid-game-save',
      version: 1,
      units: 'cm',
      savedAt: new Date().toISOString(),
      blocks: [...this.blocks.values()]
        .filter((b) => !b.vanishing)
        .map((b) => ({
          ...this._saveBlock(b),
          ...(b.inventory && { inventory: b.inventory }),
          ...(b.shadeSmooth && { smooth: true }),
          ...(b.buffs?.length && { buffs: b.buffs.map(({ type, turns, charges }) => ({ type, turns, charges })) }),
        })),
    };
  }

  /** One block's saved fields (creatures also save facing, behavior, and so on). */
  _saveBlock({ x, y, z, type, front, behavior, heldBehavior, walkTarget, trappedTurns, born, isAssignedBehavior }) {
    // a selected creature is only waiting because it is selected: save what it will resume
    const saved = heldBehavior && behavior === 'wait' ? heldBehavior : behavior;
    // only a walk the player gave outlasts the selection (and so a reload)
    const assigned = isAssignedBehavior && saved === 'walk' ? { assigned: true } : {};
    if (type === BLOCK.SQUIRMY) return { x, y, z, type, born, behavior: saved, ...(front && { front }), ...assigned };
    if (isSingleCreature(type)) {
      return {
        x, y, z, type, ...(front && { front }), behavior: saved,
        ...(walkTarget && { walkTarget: { ...walkTarget } }),
        ...(trappedTurns && { trappedTurns }),
        ...assigned,
      };
    }
    return { x, y, z, type };
  }

  /** Clears the scene and loads blocks. Returns { loaded, skipped }. */
  fromJSON(data) {
    const list = Array.isArray(data) ? data : data?.blocks;
    if (!Array.isArray(list)) throw new Error('Save file has no "blocks" array');
    this.clear();
    let loaded = 0, skipped = 0;
    for (const b of list) {
      const x = Number(b.x), y = Number(b.y), z = Number(b.z);
      const type = b.type ?? b.color;
      if (this.add(x, y, z, type)) {
        loaded++;
        // restore which way a Crawly was facing (its floor is re-derived below) and its behavior
        const dir = Array.isArray(b.front) && b.front.map(Number);
        if (isSingleCreature(type) && dir && NEIGHBOR_DIRS.some((d) => d.every((v, i) => v === dir[i]))) {
          this.get(x, y, z).front = dir;
        }
        if (isSingleCreature(type) && canBehave(type, b.behavior)) this.get(x, y, z).behavior = b.behavior;
        const wt = b.walkTarget;
        if (isSingleCreature(type) && wt && isValidCell(Number(wt.x), Number(wt.y), Number(wt.z))) {
          this.get(x, y, z).walkTarget = { x: Number(wt.x), y: Number(wt.y), z: Number(wt.z) };
        }
        if (isSingleCreature(type) && Number(b.trappedTurns) > 0) this.get(x, y, z).trappedTurns = Number(b.trappedTurns);
        if (BLOCK_COLORS[b.inventory]) this.get(x, y, z).inventory = b.inventory;
        if (b.smooth === true) this.setSmooth(this.get(x, y, z), true);
        for (const bf of Array.isArray(b.buffs) ? b.buffs : []) {
          // turns / charges: null (or left out) = no limit
          const limit = (v) => (v == null ? null : Number(v));
          if (BUFF_TYPES[bf?.type]) this.addBuff(this.get(x, y, z), bf.type, limit(bf.turns), limit(bf.charges));
        }
        if (b.assigned === true && isCreature(type)) this.get(x, y, z).isAssignedBehavior = true;
        if (type === BLOCK.SQUIRMY) {
          // keep the saved order (head .. tail), behavior and facing
          const s = this.get(x, y, z);
          if (Number.isFinite(Number(b.born))) s.born = Number(b.born);
          if (canBehave(type, b.behavior)) s.behavior = b.behavior;
          if (dir && NEIGHBOR_DIRS.some((d) => d.every((v, i) => v === dir[i]))) s.front = dir;
        }
      } else skipped++;
    }
    this._born = Math.max(this._born, ...[...this.squirmyBlocks].map((s) => s.born + 1));
    for (const s of this.squirmyBlocks) delete s.isHead; // re-derive heads from the loaded order
    this.refreshSquirmies();
    this._settleCrawlies();
    return { loaded, skipped };
  }
}
