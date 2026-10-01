import * as THREE from 'three';
import { RANDOM_BLOCKS } from './tools.js';
import { BLOCK, BLOCK_COLORS, BLOCK_TYPES, blockProps, canBehave, isCreature, isTranslucent, BUFF_TYPES, isSingleCreature } from './blocks.js';
import { NEIGHBOR_DIRS, cellKey, isValidCell, randomCellOnSphere } from './lattice.js';
import { FACE_DIRS, createBlockGeometry, createBlockMaterials } from './geometry.js';
import { ClusterBodies } from './clusterBody.js';
import { BlockBatch } from './blockBatch.js';
import { SOLID_TYPES, stepFog, stepGroups, stepSink, stepWater } from './sim.js';
import { CreatureEyes, orientCreature } from './creature.js';

/**
 * Per-turn animations (block slides, eye turns, vanishing) last this fraction of a turn.
 * The length in seconds is world.stepSeconds, which follows Options → Speed.
 */
export const STEP_FRACTION = 0.75;

/**
 * Steps of the "New" scene, in order (after the Stone at the origin). Each step adds
 * `count` blocks of `type`, seeded as `clusters` clusters (null = count: every block a seed,
 * straight onto the world, layer by layer) that grow by `sizeDistribution` and `growth`. With `count: null` and
 * `shells: n`, the count is taken from the world's empty shell (its cell count), and the step
 * runs `n` times, re-polling the shell each time. `addTo` says where the seeds go: "world"
 * (the default) seeds them in the empty shell around the world, i.e. all the blocks on the
 * board together; "sky" seeds them at random 50 cm from the origin, like rain; "previous"
 * seeds them in the empty cells around the blocks the previous template line made. A line with
 * `deleteAll: true` adds nothing: it deletes every block of its `type` from the board (other
 * properties are ignored). See generateNew.
 */
//shellSize(i) = 14 + 24*i + 12*i^2
//shellSize(0) = 1, cumulativeSize(0) = 1
//shellSize(1) = 14, cumulativeSize(1) = 15
//shellSize(2) = 50, cumulativeSize(2) = 65
//shellSize(3) = 110, cumulativeSize(3) = 175
//shellSize(4) = 194, cumulativeSize(4) = 369
//If clusters=1, sizeDistribution doesn't matter
//TODO: a "branching" growth rule
/** Template `addTo: "sky"`: seeds go at random on the sphere this far from the origin (like rain). */
export const SKY_RADIUS_CM = 50;
/** "sky" seeding gives up on a seed after this many tries landing on taken cells. */
const SKY_TRIES = 50;

export const NEW_SCENE_TEMPLATE = [
  //Geode
  { type: BLOCK.VOID, clusters: null, count: 20, shells: null, sizeDistribution: 'uniform', growth: "worm", addTo: "world" },
  { type: BLOCK.VOID, clusters: null, count: null, shells: 2, sizeDistribution: 'uniform', growth: "uniform", addTo: "world" },
  { type: BLOCK.CRYSTAL, clusters: null, count: null, shells: 1, sizeDistribution: 'random', growth: "uniform", addTo: "world" },
  { type: BLOCK.STONE, clusters: null, count: null, shells: 1, sizeDistribution: 'uniform', growth: "uniform", addTo: "world" },
  //Bury geode
  { type: BLOCK.DIRT, clusters: null, count: null, shells: 1, sizeDistribution: 'uniform', growth: "random", addTo: "world" },
  { type: BLOCK.DIRT, clusters: null, count: null, shells: 1, sizeDistribution: 'uniform', growth: "uniform", addTo: "world" },
  //Tunnels
  { type: BLOCK.VOID, clusters: 2, count: 80, shells: null, sizeDistribution: 'uniform', growth: "tree", addTo: "world" },
  //Crust
  { type: BLOCK.STONE, count: 5, clusters: 30, shells: null, sizeDistribution: 'random', growth: "random", addTo: "world" },
  { type: BLOCK.STONE, count: 5, clusters: 30, shells: null, sizeDistribution: 'uniform', growth: "uniform", addTo: "world" },
  { type: BLOCK.CRYSTAL, count: 20, clusters: 5, shells: null, sizeDistribution: 'random', growth: "uniform", addTo: "world" },
  { type: BLOCK.STONE, count: 10, clusters: 30, shells: null, sizeDistribution: 'uniform', growth: "uniform", addTo: "world" },
  //Soil
  { type: BLOCK.DIRT, count: 10, clusters: 20, shells: null, sizeDistribution: 'random', growth: "random", addTo: "world" },
  { type: BLOCK.STONE, count: 10, clusters: 20, shells: null, sizeDistribution: 'uniform', growth: "uniform", addTo: "world" },
  { type: BLOCK.WOOD, count: 30, clusters: 6, shells: null, sizeDistribution: 'random', growth: "tree", addTo: "world" },
  { type: BLOCK.DIRT, count: 10, clusters: 30, shells: null, sizeDistribution: 'uniform', growth: "uniform", addTo: "world" },
  { type: BLOCK.MOSS, count: 500, clusters: 80, shells: null, sizeDistribution: 'random', growth: "uniform", addTo: "world" },
  //Water and creatures
  { type: BLOCK.WATER, count: 100, clusters: 5, shells: null, sizeDistribution: 'random', growth: "random", addTo: "world" },
  { type: BLOCK.CRAWLY, count: 10, clusters: 5, shells: null, sizeDistribution: 'random', growth: "worm", addTo: "world", addTo: "world" },
  { type: BLOCK.BUZZY, count: 5, clusters: 5, shells: null, sizeDistribution: 'random', growth: "worm", addTo: "world" },
  { type: BLOCK.SQUIRMY, count: 10, clusters: 3, shells: null, sizeDistribution: 'random', growth: "random", addTo: "world" },
  { type: BLOCK.VOID, deleteAll: true },
  //Fog and clouds
  { type: BLOCK.FOG, clusters: null, count: null, shells: 2, sizeDistribution: 'uniform', growth: "uniform", addTo: "world" },
  { type: BLOCK.NIMBUS, clusters: 4, count: 100, shells: null, sizeDistribution: 'uniform', growth: "uniform", addTo: "sky" },
];

/** The properties a template line may have (see NEW_SCENE_TEMPLATE). */
const TEMPLATE_KEYS = ['type', 'count', 'clusters', 'shells', 'sizeDistribution', 'growth', 'addTo', 'deleteAll'];

/**
 * A block type named in a template file: its id (as in BLOCK, e.g. "gray"), its key ("STONE",
 * or "BLOCK.STONE" as written in code), its name ("Stone"), or "random"; case doesn't matter.
 * Returns the id, or null.
 */
function templateType(name) {
  if (typeof name !== 'string') return null;
  const s = name.trim().replace(/^BLOCK\./i, '');
  if (s.toLowerCase() === 'random') return 'random';
  if (BLOCK_COLORS[s]) return s;
  if (BLOCK[s.toUpperCase()]) return BLOCK[s.toUpperCase()];
  return BLOCK_TYPES.find((t) => t.name.toLowerCase() === s.toLowerCase() || t.id === s.toLowerCase())?.id ?? null;
}

/**
 * Reads a world template from parsed JSON: an array of lines like NEW_SCENE_TEMPLATE, or an
 * object holding one as `template` (or `lines`). Block types may be written as ids, keys or
 * names (see templateType). Returns { template } (lines ready for generateNew), or { error }
 * when it doesn't look like a template or names an unknown block type.
 */
export function parseTemplate(data) {
  const lines = Array.isArray(data) ? data : Array.isArray(data?.template) ? data.template : Array.isArray(data?.lines) ? data.lines : null;
  if (!lines?.length) return { error: 'not a template (no list of lines)' };
  if (!lines.every((l) => l && typeof l === 'object' && !Array.isArray(l) && 'type' in l && !('x' in l && 'y' in l && 'z' in l))) {
    return { error: 'not a template (every line needs a "type", and no x / y / z)' };
  }
  const template = [];
  for (const [i, l] of lines.entries()) {
    const type = templateType(l.type);
    if (!type) return { error: `line ${i + 1}: unknown block type "${l.type}"` };
    const line = { type };
    for (const k of TEMPLATE_KEYS) if (k !== 'type' && k in l) line[k] = l[k];
    if ('groups' in l && !('clusters' in l)) line.clusters = l.groups; // the old names still work
    if ('distribution' in l && !('sizeDistribution' in l)) line.sizeDistribution = l.distribution;
    template.push(line);
  }
  return { template };
}

/** Whether parsed JSON looks like a save file (World.toJSON): the save format, or a list of blocks with x, y, z and type. */
export function isSaveData(data) {
  if (data?.format === 'grid-game-save') return true;
  const list = Array.isArray(data) ? data : data?.blocks;
  return Array.isArray(list) && list.length > 0 && list.every((block) => block && Number.isFinite(block.x) && Number.isFinite(block.y) && Number.isFinite(block.z) && typeof block.type === 'string');
}

const _m = new THREE.Matrix4();
const EMPTY_SET = new Set();
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
    this.geometry = createBlockGeometry(); // the block's shape, shared by every batch
    this.materials = createBlockMaterials();
    this.blocks = new Map(); // key -> { x, y, z, type, batch, index }
    this.anims = new Map(); // key -> { from, to, t0, dur } for sliding blocks
    this.vanishing = new Map(); // block -> { from, dir, t0, dur }: shrinking away, removed at the end
    this.appearing = new Map(); // block -> { from, t0, dur }: growing in from `from` (see appear)
    this.buffed = new Set(); // blocks carrying buffs (b.buffs), counted down each turn (tickBuffs)
    this.soloCreatures = new Set(); // one-block creatures that act: Crawlies and Buzzies (also carry .floor and .front, see creature.js)
    // Squirmies: touching Squirmy blocks form one creature, a chain ordered by placement
    // (`born`): the first placed is the head (it has the eyes and the behavior), the last the tail
    this.squirmyBlocks = new Set();
    this.squirmies = []; // [{ segments: [head, …, tail] }], see refreshSquirmies
    this.squirmyOf = new Map(); // Squirmy block -> its squirmy
    this._born = 0;
    this.eyes = new CreatureEyes(parent);
    this.byType = new Map(); // block type -> Set of its blocks (see ofType)
    // cells whose contents changed (flat x, y, z; see _logChange): lets rules that are stuck
    // (e.g. Fog that can't fall) skip turns when nothing near them changed (sim.js stillIdle).
    // idleMarks[rule] = where in the log that rule last found itself stuck (null: not stuck)
    this.changeLog = [];
    this.idleMarks = {};
    this._refreshCells = new Map(); // cell key -> [x, y, z]: face / corner masks to redo (see _flushRefresh)
    this.clusterBodies = new ClusterBodies(parent, this.materials); // Options → Rendering: Smooth
    this.revision = 0; // bumped whenever blocks are added, removed, moved, retyped or recoloured (see _changed)
    this.stepSeconds = STEP_FRACTION; // length of per-turn animations (s); the engine sets it from the turn length
    this.fogEnabled = true; // Options → Fog (set by the engine): generateNew skips Fog steps when off
    this.turn = 0; // current game turn, set by the engine; stamped on blocks as movedTurn
    this.listeners = new Map(); // event name -> Set of handlers (see on / emit)
    // clusters: same-type groups of connected non-creature blocks (trees are Wood clusters),
    // rebuilt at the end of every turn (sim.js updateClusters). For creatures, and for an
    // up-to-the-moment cluster of any block, see clusterOf().
    this.clusters = []; // [{ type, blocks }]
    this.clusterByBlock = new Map(); // block -> its cluster
    // one instanced mesh per drawing pass, each holding only that pass's blocks (blockBatch.js):
    // solid blocks; clouds (Fog, Nimbus: see-through, writing depth, drawn first); Crystal
    // (refractive); Water (see-through, drawn last). A block's `batch` is where it's drawn.
    const batch = (material, name, opts) => new BlockBatch(parent, this.geometry, material, name, opts);
    this.batches = {
      opaque: batch(this.materials.opaque, 'blocks', { initialCapacity: 1024 }),
      cloud: batch(this.materials.cloud, 'cloud-blocks', { renderOrder: 1, initialCapacity: 1024 }),
      crystal: batch(this.materials.crystal, 'crystal-blocks', { initialCapacity: 128 }),
      water: batch(this.materials.translucent, 'translucent-blocks', { renderOrder: 2, initialCapacity: 256 }),
    };
    this._batchList = Object.values(this.batches);
    // which materials draw each batch's blocks (their own mesh, and cluster bodies in Smooth rendering)
    this._batchMaterials = new Map([
      [this.batches.opaque, [this.materials.opaque, this.materials.body]],
      [this.batches.cloud, [this.materials.cloud, this.materials.bodyCloud]],
      [this.batches.crystal, [this.materials.crystal, this.materials.bodyCrystal]],
      [this.batches.water, [this.materials.translucent, this.materials.bodyTranslucent]],
    ]);
  }

  /** The batch (drawing pass) blocks of `type` go in. */
  _batchFor(type) {
    if (type === BLOCK.FOG || type === BLOCK.NIMBUS) return this.batches.cloud;
    if (type === BLOCK.CRYSTAL) return this.batches.crystal;
    return isTranslucent(type) ? this.batches.water : this.batches.opaque;
  }

  /** Block `block`'s instance matrix (where and how big it's drawn). */
  _setMatrix(block, m) {
    block.batch.mesh.setMatrixAt(block.index, m);
  }

  /** Block `block`'s per-instance style attribute (style, seed, face mask / tint, AO mask; read at b.index). */
  _style(block) {
    return block.batch.attr('blockStyle');
  }

  /** Block `block`'s drawn colour, into `out`. */
  colorOf(block, out) {
    return block.batch.mesh.getColorAt(block.index, out);
  }

  /** Rendering: Smooth: clears every block's "drawn by a cluster body" flag (see ClusterBodies). */
  clearMergedFlags() {
    for (const batch of this._batchList) {
      const a = batch.attr('blockMerged');
      a.array.fill(0);
      a.needsUpdate = true;
    }
  }

  /** Rendering: Smooth: `block` is drawn by a cluster body (its instance is hidden). */
  setMergedFlag(block, on = true) {
    const flags = block.batch.attr('blockMerged');
    flags.array[block.index] = on ? 1 : 0;
    flags.needsUpdate = true;
  }

  /** The meshes to pick blocks from (one per batch); see blockAtHit. */
  get pickMeshes() {
    return this._batchList.map((batch) => batch.mesh);
  }

  /** The block a raycast hit on one of the pickMeshes landed on. */
  blockAtHit(hit) {
    return hit?.object?.userData.batch?.blocks[hit.instanceId];
  }

  /**
   * Game events raised by the simulation, for things outside it (sounds, effects):
   *   'berryGrow' (berry block) — a tree grew a Berry
   *   'creatureArrived' (creature)  — a walking creature reached its target
   *   'creatureTrapped' (creature)  — a creature got walled in (Trapped behavior)
   *   'creatureFreed' (creature)    — a Trapped creature found a gap (back to Wander)
   *   'creatureDied' ({ creature, x, y, z }) — a creature died (its block is already removed)
   *   'blockConsumed' ({ by, block, sound, slot }) — `by` consumed `block` (see consume)
   *   'blockExcreted' ({ by, block, sound }) — a cluster's tail `by` excreted `block` (see excrete)
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
    if (this._quiet) return; // settling a new scene: no sounds or log lines
    for (const fn of this.listeners.get(name) ?? []) fn(data);
  }

  /** Re-derives a creature's floor/front; revolves its eyes if either changed. */
  _reorient(creature, moveDir = null, durationS = this.stepSeconds) {
    const { front, floor } = creature;
    orientCreature(this, creature, moveDir);
    if (creature.front !== front || creature.floor !== floor) this.eyes.track(creature, durationS);
  }

  /** Re-derives the floor of every creature next to cell (x, y, z). */
  _reorientAround(x, y, z) {
    if (!this.soloCreatures.size && !this.squirmyBlocks.size) return;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const n = this.blocks.get(cellKey(x + dx, y + dy, z + dz));
      if (n && (isSingleCreature(n.type) || n.isHead)) this._reorient(n);
    }
  }

  /**
   * Re-clusters Squirmy blocks into Squirmies: touching Squirmy blocks form one chain, ordered
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
      segments.forEach((block, i) => {
        this.squirmyOf.set(block, sq);
        const wasHead = !!block.isHead;
        block.isHead = i === 0;
        block.isTail = i === segments.length - 1;
        if (block.isHead && !wasHead) {
          orientCreature(this, block);
          this.eyes.track(block, 0);
        } else if (!block.isHead && wasHead) this.eyes.untrack(block);
      });
    }
  }

  /** Snaps every creature's orientation and eyes into place with no animation. */
  _settleCreatures() {
    for (const c of [...this.soloCreatures, ...this.squirmyBlocks]) {
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
    this._queueRefresh(x, y, z);
  }

  /**
   * Recomputes the ambient-occlusion neighbour mask (blockStyle.w) of the block at
   * (x, y, z), if any, and of every block next to it: bit i set = the neighbour across
   * face i holds a block that occludes (anything but see-through Water and Crystal).
   */
  _refreshAOAround(x, y, z) {
    this._queueRefresh(x, y, z);
  }

  /** Queues the face / corner masks of the block at (x, y, z) and its neighbours to be redone. */
  _queueRefresh(x, y, z) {
    const k = cellKey(x, y, z);
    if (!this._refreshCells.has(k)) this._refreshCells.set(k, [x, y, z]);
  }

  /**
   * Redoes the queued masks, each affected block once (a falling group or a Fog cluster moves
   * hundreds of blocks in a turn, and their neighbourhoods overlap): the translucent face mask
   * (blockStyle.z) and the ambient-occlusion mask (blockStyle.w). Called before drawing
   * (updateAnimations).
   */
  _flushRefresh() {
    if (!this._refreshCells.size) return;
    const todo = new Set();
    for (const [x, y, z] of this._refreshCells.values()) {
      const b = this.blocks.get(cellKey(x, y, z));
      if (b) todo.add(b);
      for (const [dx, dy, dz] of FACE_DIRS) {
        const n = this.blocks.get(cellKey(x + dx, y + dy, z + dz));
        if (n) todo.add(n);
      }
    }
    this._refreshCells.clear();
    for (const b of todo) {
      const style = this._style(b);
      const see = isTranslucent(b.type);
      let ao = 0, faces = 0;
      for (let i = 0; i < FACE_DIRS.length; i++) {
        const [dx, dy, dz] = FACE_DIRS[i];
        const n = this.blocks.get(cellKey(b.x + dx, b.y + dy, b.z + dz));
        if (!n) continue;
        if (!isTranslucent(n.type)) ao |= 1 << i;
        // a vanishing block is on its way out: it shows all its faces, and its neighbours
        // show the faces they shared with it
        if (see && !b.vanishing && n.type === b.type && !n.vanishing) faces |= 1 << i;
      }
      style.setW(b.index, ao);
      if (see) style.setZ(b.index, faces);
    }
    for (const batch of this._batchList) batch.attr('blockStyle').needsUpdate = true;
  }

  /** Adds `block` to the per-type index as `type`. */
  _indexType(block, type) {
    let set = this.byType.get(type);
    if (!set) this.byType.set(type, (set = new Set()));
    set.add(block);
  }

  /** Every block of `type` (a live Set: don't change it while iterating over it). */
  ofType(type) {
    return this.byType.get(type) ?? EMPTY_SET;
  }

  /** Cell (x, y, z)'s contents changed: noted in the change log (see changeLog). */
  _logChange(x, y, z) {
    this.changeLog.push(x, y, z);
  }

  /**
   * Drops the change log entries every rule stuck at a mark has already seen (call once a
   * turn; the log only needs to reach back to the oldest mark).
   */
  trimChangeLog() {
    const marks = Object.values(this.idleMarks).filter((m) => m != null);
    const keep = marks.length ? Math.min(...marks) : this.changeLog.length;
    if (keep <= 0) return;
    this.changeLog.splice(0, keep);
    for (const k of Object.keys(this.idleMarks)) if (this.idleMarks[k] != null) this.idleMarks[k] -= keep;
  }

  /**
   * A block's cluster, right now: a Squirmy's whole chain (head .. tail), a one-block creature on its
   * own, or else every block of the same type connected to it, nearest first (so a tree is
   * its connected Wood, listed outward from `block`).
   */
  clusterOf(block) {
    if (block.type === BLOCK.SQUIRMY) return [...(this.squirmyOf.get(block)?.segments ?? [block])];
    const head = block.segmentOf ?? block; // a Buzzy with body segments: head, then its segments
    if (head.segments?.length) return [head, ...head.segments];
    if (isCreature(block.type)) return [block];
    const seen = new Set([block]);
    const list = [block];
    for (let i = 0; i < list.length; i++) {
      for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
        const n = this.blocks.get(cellKey(list[i].x + dx, list[i].y + dy, list[i].z + dz));
        if (n && n.type === block.type && !seen.has(n)) {
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
   * pass items along their cluster, into its last empty slot (a Squirmy's toward the tail, a
   * tree's furthest from the drinking block); other blocks keep them in their own slot.
   */
  freeSlotFor(a) {
    if (a.type === BLOCK.WOOD || isCreature(a.type)) {
      const cluster = this.clusterOf(a);
      for (let i = cluster.length - 1; i >= 0; i--) if (!cluster[i].inventory) return cluster[i];
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
   * cluster `cluster` (e.g. clusterOf(creature), or a falling group) blows `block` away:
   * `block` shrinks to nothing while drifting away from the cluster's block nearest to it
   * (vanish), then is dropped from the board; the sound `sound` plays ('blockBlown' event; the
   * engine plays it). Like consume, but nothing is kept. Returns false if `block` is gone or
   * already vanishing.
   */
  blow(cluster, block, sound) {
    if (!block || block.vanishing || this.blocks.get(cellKey(block.x, block.y, block.z)) !== block || !cluster.length) return false;
    let from = cluster[0], best = Infinity;
    for (const a of cluster) {
      const d = (a.x - block.x) ** 2 + (a.y - block.y) ** 2 + (a.z - block.z) ** 2;
      if (d < best) {
        best = d;
        from = a;
      }
    }
    if (!this.vanish(block, from)) return false;
    this.emit('blockBlown', { by: from, block: block, sound });
    return true;
  }

  /**
   * Makes creature `block`'s `behavior` a watched property: any change to it, from anywhere
   * (the sim, the Select tool, buttons, …), emits 'behaviorChanged' ({ block, from, to }).
   * Its first value (when the creature is placed or loaded) isn't reported.
   */
  _watchBehavior(block) {
    if (Object.getOwnPropertyDescriptor(block, 'behavior')?.get) return;
    let value = block.behavior;
    Object.defineProperty(block, 'behavior', {
      enumerable: true,
      configurable: true,
      get: () => value,
      set: (v) => {
        if (v === value) return;
        const from = value;
        value = v;
        if (from !== undefined) this.emit('behaviorChanged', { block: block, from, to: v });
      },
    });
  }

  // ---------------------------------------------------------------- buffs

  /**
   * Gives `block` buff `type` (BUFF_TYPES) for `turns` turns (null: permanent) and
   * `charges` uses (null: unlimited). If it already has it, the longer of each limit is kept
   * (no limit beats any). Its look updates (a buff's colour).
   */
  addBuff(block, type, turns = null, charges = null) {
    turns ??= null;
    charges ??= null;
    if (!BUFF_TYPES[type] || (turns !== null && !(turns > 0)) || (charges !== null && !(charges > 0))) return;
    block.buffs ??= [];
    const longer = (a, other) => (a === null || other === null ? null : Math.max(a, other));
    let x = block.buffs.find((y) => y.type === type);
    const refreshed = !!x;
    if (x) {
      x.turns = longer(x.turns, turns);
      x.charges = longer(x.charges, charges);
    } else block.buffs.push((x = { type, turns, charges }));
    this.buffed.add(block);
    this._refreshLook(block);
    this.emit('buffAdded', { block: block, type, turns: x.turns, charges: x.charges, buff: x, refreshed });
  }

  /**
   * Creature `block` just ate a block of `foodType`: each of its buffs with charges whose
   * priorityDiet includes that food uses one up; one at 0 charges expires.
   */
  useBuffCharges(block, foodType) {
    if (!block.buffs?.length) return;
    let spent = false;
    for (const x of block.buffs) {
      if (x.charges == null || !BUFF_TYPES[x.type]?.priorityDiet?.includes(foodType)) continue;
      x.charges--;
      spent = true;
      this.emit('buffChargeUsed', { block: block, type: x.type, charges: x.charges });
    }
    if (spent) this._dropExpiredBuffs(block);
  }

  /** Removes `block`'s buffs that ran out (0 turns or 0 charges), with events and its look. */
  _dropExpiredBuffs(block) {
    const gone = (x) => (x.turns !== null && x.turns <= 0) || (x.charges !== null && x.charges <= 0);
    const before = block.buffs.length;
    for (const x of block.buffs) if (gone(x)) this.emit('buffExpired', { block: block, type: x.type });
    block.buffs = block.buffs.filter((x) => !gone(x));
    if (!block.buffs.length) {
      delete block.buffs;
      this.buffed.delete(block);
    }
    if ((block.buffs?.length ?? 0) !== before) this._refreshLook(block);
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
   * A block's look with its buffs: it keeps its type's colour; while it has a buff with a
   * colour (e.g. Rockbiter's gold), the shader's tint flag (blockStyle.z, unused by opaque
   * blocks otherwise) adds pulsing glowing ripples in that colour over a creature's shell.
   */
  _refreshLook(block) {
    const tint = block.buffs?.map((x) => BUFF_TYPES[x.type]).find((x) => x?.color);
    block.batch.mesh.setColorAt(block.index, _c.set(BLOCK_COLORS[block.type]));
    if (!isTranslucent(block.type)) this._style(block).setZ(block.index, tint ? 1 : 0);
    this._logChange(block.x, block.y, block.z); // (Smooth rendering: its body's colours)
    this._dirty();
    this._changed();
  }

  /** Where `block` is drawn right now (mid-slide while it is moving), in cm. */
  renderedPosition(block, now, out) {
    const a = this.anims.get(cellKey(block.x, block.y, block.z));
    if (!a) return out.set(block.x, block.y, block.z);
    const t = Math.min(1, (now - a.t0) / a.dur);
    return out.lerpVectors(a.from, a.to, t * t * (3 - 2 * t)); // smoothstep ease in/out
  }

  _dirty() {
    for (const batch of this._batchList) batch.dirty();
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

  /** Draw this block 50 % see-through (dithered); pass null to clear. Only its own pass fades it. */
  setDithered(block) {
    for (const [batch, materials] of this._batchMaterials) {
      const v = block && block.batch === batch ? block.index : -1;
      for (const m of materials) m.userData.dither.value = v;
    }
  }

  add(x, y, z, type) {
    if (!isValidCell(x, y, z) || !BLOCK_COLORS[type]) return false;
    const k = cellKey(x, y, z);
    if (this.blocks.has(k)) return false;
    const b = { x, y, z, type };
    this.blocks.set(k, b);
    this._batchFor(type).add(b); // sets b.batch, b.index
    this._indexType(b, type);
    this._logChange(x, y, z);
    this._setMatrix(b, _m.makeTranslation(x, y, z));
    b.batch.mesh.setColorAt(b.index, _c.set(BLOCK_COLORS[type]));
    this._style(b).setXYZW(b.index, blockProps(type).style, Math.random() * 40, 0, 0);
    b.batch.attr('blockMerged').setX(b.index, 0);
    this._writeSmooth(b);
    if (isTranslucent(type)) this._refreshTranslucentAround(x, y, z);
    this._refreshAOAround(x, y, z);
    this._dirty();
    this._changed();
    if (isSingleCreature(type)) {
      this._watchBehavior(b);
      b.behavior = blockProps(b.type).defaultBehavior;
      b.sightRadius = blockProps(b.type).sightRadius;
      this.soloCreatures.add(b);
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
    b.batch.remove(b); // (its batch's last block moves into its slot)
    this.blocks.delete(k);
    this.byType.get(b.type)?.delete(b);
    this._logChange(x, y, z);
    this.anims.delete(k);
    this.soloCreatures.delete(b);
    this.eyes.untrack(b);
    this.buffed.delete(b);
    if (b.segmentOf) {
      // a body segment is gone: the ones behind it break off as creatures of their own
      const segs = b.segmentOf.segments;
      const cut = segs.splice(segs.indexOf(b));
      if (!segs.length) delete b.segmentOf.segments;
      delete b.segmentOf;
      for (const s of cut.slice(1)) this._releaseSegment(s);
    }
    if (b.segments?.length) {
      // the head is gone: its segments become creatures of their own
      for (const s of b.segments) this._releaseSegment(s);
      delete b.segments;
    }
    if (this.squirmyBlocks.delete(b)) {
      delete b.isHead;
      this.refreshSquirmies();
    }
    this._changed();
    if (isTranslucent(b.type)) this._refreshTranslucentAround(x, y, z);
    this._refreshAOAround(x, y, z);
    this._dirty();
    this._reorientAround(x, y, z);
    return true;
  }

  /**
   * Changes a block's type in place (same cell, index and pattern seed), updating its
   * colour, shader style, creature tracking, translucent face masks, ambient occlusion and
   * neighbouring creatures' floors.
   */
  setType(block, type) {
    if (!BLOCK_COLORS[type] || block.type === type || this.blocks.get(cellKey(block.x, block.y, block.z)) !== block) return false;
    const old = block.type;
    block.type = type;
    this.byType.get(old)?.delete(block);
    this._indexType(block, type);
    this._logChange(block.x, block.y, block.z);
    delete block.buffs; // buffs belong to what the block was
    this.buffed.delete(block);
    this._changed();
    const target = this._batchFor(type);
    if (target !== block.batch) {
      // drawn by another pass now: move it to that batch (same place, size and pattern seed)
      block.batch.mesh.getMatrixAt(block.index, _m);
      const seed = this._style(block).getY(block.index);
      block.batch.remove(block);
      target.add(block);
      this._setMatrix(block, _m);
      this._style(block).setXYZW(block.index, 0, seed, 0, 0);
      block.batch.attr('blockMerged').setX(block.index, 0);
      this._writeSmooth(block);
      this._refreshAOAround(block.x, block.y, block.z); // its masks are redone in the new batch
    }
    if (block.shadeSmooth && blockProps(type).shadeFlat) this.setSmooth(block, false);
    block.batch.mesh.setColorAt(block.index, _c.set(BLOCK_COLORS[type]));
    const style = this._style(block);
    style.setX(block.index, blockProps(type).style);
    style.setZ(block.index, 0);
    if (old === BLOCK.SQUIRMY) {
      this.squirmyBlocks.delete(block);
      this.eyes.untrack(block);
      delete block.isHead;
      this.refreshSquirmies();
    } else if (type === BLOCK.SQUIRMY) {
      block.born = this._born++;
      this._watchBehavior(block);
      block.behavior = blockProps(block.type).defaultBehavior;
      block.sightRadius = blockProps(block.type).sightRadius;
      this.squirmyBlocks.add(block);
      this.refreshSquirmies();
    }
    if (isSingleCreature(old)) {
      this.soloCreatures.delete(block);
      this.eyes.untrack(block);
    } else if (isSingleCreature(type)) {
      this._watchBehavior(block);
      block.behavior = blockProps(block.type).defaultBehavior;
      block.sightRadius = blockProps(block.type).sightRadius;
      this.soloCreatures.add(block);
      orientCreature(this, block);
      this.eyes.track(block, 0);
    }
    if (isTranslucent(old) || isTranslucent(type)) {
      this._refreshTranslucentAround(block.x, block.y, block.z);
      this._refreshAOAround(block.x, block.y, block.z); // see-through blocks don't occlude, others do
    }
    this._dirty();
    this._reorientAround(block.x, block.y, block.z);
    return true;
  }

  /**
   * Moves several blocks at once, each to a neighbouring cell given in `moves`
   * ([[block, { x, y, z }], …]): a target may be a cell another of them is leaving, so blocks
   * can swap places (a Crawly sinking through Water). All slide over `durationS`, like move.
   * Returns false (moving nothing) if a target is taken by a block that isn't moving.
   */
  relocate(moves, durationS = this.stepSeconds) {
    const leaving = new Set(moves.map(([block]) => cellKey(block.x, block.y, block.z)));
    for (const [, to] of moves) {
      const tk = cellKey(to.x, to.y, to.z);
      if (!isValidCell(to.x, to.y, to.z) || (this.blocks.has(tk) && !leaving.has(tk))) return false;
    }
    const froms = moves.map(([block]) => new THREE.Vector3(block.x, block.y, block.z));
    for (const [b] of moves) {
      const k = cellKey(b.x, b.y, b.z);
      this.blocks.delete(k);
      this.anims.delete(k);
    }
    const t0 = performance.now();
    moves.forEach(([block, to], i) => {
      block.x = to.x;
      block.y = to.y;
      block.z = to.z;
      const tk = cellKey(to.x, to.y, to.z);
      this.blocks.set(tk, block);
      block.movedTurn = this.turn;
      this.anims.set(tk, { from: froms[i], to: new THREE.Vector3(to.x, to.y, to.z), t0, dur: durationS * 1000 });
      this._logChange(froms[i].x, froms[i].y, froms[i].z);
      this._logChange(to.x, to.y, to.z);
    });
    moves.forEach(([block, to], i) => {
      const f = froms[i];
      if (isSingleCreature(block.type) || block.isHead) this._reorient(block, null, durationS); // carried: facing kept, floor re-derived
      this._reorientAround(f.x, f.y, f.z);
      this._reorientAround(to.x, to.y, to.z);
      this._refreshAOAround(f.x, f.y, f.z); // (also redoes see-through face masks)
      this._refreshAOAround(to.x, to.y, to.z);
    });
    this._dirty();
    this._changed();
    return true;
  }

  /**
   * Moves a block to an empty neighbouring cell. The data moves immediately; the
   * rendered block slides there over `durationS` seconds (see updateAnimations).
   * `turnCreature: false` keeps a creature's front unchanged (it was carried, not walking).
   */
  move(from, to, durationS = this.stepSeconds, { turnCreature = true } = {}) {
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
    this._logChange(fromPos.x, fromPos.y, fromPos.z);
    this._logChange(to.x, to.y, to.z);
    b.movedTurn = this.turn; // lets rules tell settled blocks from moving ones
    this.anims.set(tk, { from: fromPos, to: new THREE.Vector3(to.x, to.y, to.z), t0: performance.now(), dur: durationS * 1000 });
    // a creature now faces the way it moved (unless it was carried, e.g. by a falling group);
    // its old and new neighbours may change floors
    if (isSingleCreature(b.type) || b.isHead) {
      this._reorient(b, turnCreature ? [to.x - fromPos.x, to.y - fromPos.y, to.z - fromPos.z] : null, durationS);
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
    // body segments follow: each steps into the cell the one ahead of it just left
    if (b.segments?.length) {
      let prev = { x: fromPos.x, y: fromPos.y, z: fromPos.z };
      for (const seg of b.segments) {
        const here = { x: seg.x, y: seg.y, z: seg.z };
        this.move(seg, prev, durationS);
        prev = here;
      }
    }
    return true;
  }

  /**
   * Segmented creatures (a Buzzy that ate a Berry): `head` grows one more body segment, a
   * block of its type in an empty cell next to its tail, preferably straight behind it; it
   * grows in from the tail. A segment isn't a creature of its own (it isn't in `soloCreatures`,
   * doesn't act and has no eyes, but has wings and legs): `seg.segmentOf` is its head, and
   * `head.segments` lists them from the head back. Whenever the head moves, the segments
   * follow (move). Returns the new segment, or null if there's no room.
   */
  growSegment(head) {
    const chain = [head, ...(head.segments ?? [])];
    const tail = chain[chain.length - 1], prev = chain[chain.length - 2];
    const behind = prev
      ? new THREE.Vector3(tail.x - prev.x, tail.y - prev.y, tail.z - prev.z)
      : tail.front ? new THREE.Vector3(...tail.front).negate() : new THREE.Vector3();
    let cell = null, best = -Infinity;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const x = tail.x + dx, y = tail.y + dy, z = tail.z + dz;
      if (this.blocks.has(cellKey(x, y, z))) continue;
      const score = behind.lengthSq() ? behind.dot(new THREE.Vector3(dx, dy, dz).normalize()) : Math.random();
      if (score > best) {
        best = score;
        cell = { x, y, z };
      }
    }
    if (!cell || !this.add(cell.x, cell.y, cell.z, head.type)) return null;
    const seg = this.get(cell.x, cell.y, cell.z);
    this._attachSegment(head, seg);
    if (tail.front) seg.front = tail.front; // facing along the body
    this.eyes.track(seg, 0);
    this.appear(seg, tail);
    return seg;
  }

  /** Makes block `seg` (of head's type) the last body segment of `head`. */
  _attachSegment(head, seg) {
    this.soloCreatures.delete(seg); // it follows the head, it doesn't act
    seg.segmentOf = head;
    (head.segments ??= []).push(seg);
    this._logChange(seg.x, seg.y, seg.z); // its cluster is now the head's
    this._changed();
  }

  /** A body segment breaks off (its head or a segment ahead of it is gone): it becomes a creature of its own. */
  _releaseSegment(seg) {
    delete seg.segmentOf;
    if (this.blocks.get(cellKey(seg.x, seg.y, seg.z)) !== seg) return;
    this._logChange(seg.x, seg.y, seg.z); // a cluster of its own now
    this._changed();
    this.soloCreatures.add(seg);
    orientCreature(this, seg);
    this.eyes.track(seg, 0);
  }

  /**
   * Options → Rendering: Smooth (on) draws each cluster as one merged, smoothed,
   * smooth-shaded body (clusterBody.js); Blocky (off) draws every block on its own.
   */
  setSmoothRendering(on) {
    this.materials.uniforms.uSmoothRendering.value = on ? 1 : 0;
    this.clusterBodies.setEnabled(on);
  }

  /**
   * Smooth shading for `block` (`block.shadeSmooth`): rounded normals (out from the block
   * centre) and no face outlines, like a creature, while Options → Rendering is Smooth
   * (Blocky draws it flat like any block). Ignored for shadeFlat types (Crystal).
   */
  setSmooth(block, on) {
    on = on && !blockProps(block.type).shadeFlat;
    if (on) block.shadeSmooth = true;
    else delete block.shadeSmooth;
    this._writeSmooth(block);
    this._dirty();
  }

  _writeSmooth(block) {
    block.batch.attr('blockSmooth').setX(block.index, block.shadeSmooth ? 1 : 0);
  }

  /** Something about the blocks changed (cells, types, looks): Smooth rendering's bodies get rebuilt. */
  _changed() {
    this.revision++;
  }

  /** Advances sliding blocks, creature eyes and the water animation; call once per frame. */
  updateAnimations(now = performance.now()) {
    this._flushRefresh(); // face / corner masks changed by this turn's adds, moves and removals
    this.materials.uniforms.uTime.value = now / 1000;
    const p = new THREE.Vector3();
    this.eyes.update(now, (creature, out) => this.renderedPosition(creature, now, out), { turn: this.turn, flapSeconds: this.stepSeconds * 0.5, stepSeconds: this.stepSeconds, sizeOf: (creature) => this.drawnScale(creature, now) });
    this.clusterBodies.update(this, now);
    if (!this.anims.size && !this.vanishing.size && !this.appearing.size) return;
    for (const [k, a] of this.anims) {
      const b = this.blocks.get(k);
      if (!b) {
        this.anims.delete(k);
        continue;
      }
      this.renderedPosition(b, now, p);
      this._setMatrix(b, _m.makeTranslation(p.x, p.y, p.z));
      if (now - a.t0 >= a.dur) this.anims.delete(k);
    }
    this._updateVanishing(now);
    this._updateAppearing(now);
    this._dirty();
  }

  /**
   * Plays a "cleared away" animation on `block`: over `durationS` it shrinks to nothing
   * while drifting `distanceCm` directly away from block / point `other` (or toward it,
   * with `toward: true`), then it is removed (and 'blockVanished' is emitted). Until then it
   * stays in the world, flagged `block.vanishing`, so rules can skip it. Returns false if it is
   * already vanishing.
   */
  vanish(block, other, { durationS = this.stepSeconds, distanceCm = 1, toward = false } = {}) {
    if (block.vanishing || this.blocks.get(cellKey(block.x, block.y, block.z)) !== block) return false;
    block.vanishing = true;
    this._logChange(block.x, block.y, block.z);
    const dir = new THREE.Vector3(block.x - other.x, block.y - other.y, block.z - other.z);
    if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
    dir.normalize().multiplyScalar(toward ? -distanceCm : distanceCm);
    if (isTranslucent(block.type)) this._refreshTranslucentAround(block.x, block.y, block.z);
    this.anims.delete(cellKey(block.x, block.y, block.z)); // the vanish animation takes over its matrix
    this._changed(); // shrinks away on the instanced mesh, not in a cluster body
    this.vanishing.set(block, { from: new THREE.Vector3(block.x, block.y, block.z), dir, t0: performance.now(), dur: durationS * 1000 });
    return true;
  }

  /**
   * Plays an "arriving" animation on `block` (already in the world, in its cell): over
   * `durationS` it moves from point `from` (cm) into its cell while growing from nothing to
   * full size. The reverse of vanish.
   */
  appear(block, from, { durationS = this.stepSeconds } = {}) {
    this.anims.delete(cellKey(block.x, block.y, block.z));
    this._logChange(block.x, block.y, block.z);
    this._changed(); // grows in on the instanced mesh, joins its cluster body once there
    this.appearing.set(block, { from: new THREE.Vector3(from.x, from.y, from.z), t0: performance.now(), dur: durationS * 1000 });
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
      this._setMatrix(b, _m.compose(pos, noRot, scale));
      if (t >= 1) {
        this.appearing.delete(b);
        this._logChange(b.x, b.y, b.z); // grown in: it joins its cluster body
        this._changed();
      }
    }
    for (const batch of this._batchList) batch.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * cluster `cluster` (ordered head .. tail, e.g. World.clusterOf) excretes the item in its
   * tail's inventory slot: a block of that type is created in an empty cell next to the tail,
   * preferably directly behind it (continuing the line from the segment before the tail, or,
   * for a one-block creature, opposite its front), the slot is emptied, the remaining items
   * move along the queue toward the tail (packed at the tail end, order kept), and the new
   * block grows in from the tail to its cell (appear) while the sound `sound` plays
   * ('blockExcreted' event; the engine plays it). `cell` ({ x, y, z }, optional) picks the cell
   * instead (a Nimbus raining straight down). Returns the new block, or null if the tail's slot
   * is empty or it has no empty neighbouring cell (or `cell` is taken).
   */
  excrete(cluster, sound, { cell: into = null } = {}) {
    const tail = cluster[cluster.length - 1];
    if (!tail?.inventory) return null;
    // "behind": away from the segment before the tail, or opposite a lone creature's front
    const prev = cluster[cluster.length - 2];
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
    const items = cluster.map((block) => block.inventory).filter(Boolean);
    cluster.forEach((block, i) => (block.inventory = items[i - (cluster.length - items.length)] ?? null));
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

  /**
   * How big block `block` is drawn right now, 0..1: shrinking away (vanish) or growing in
   * (appear), else 1. Creature eyes, wings and legs follow it.
   */
  drawnScale(block, now) {
    const v = this.vanishing.get(block) ?? this.appearing.get(block);
    if (!v) return 1;
    const t = Math.min(1, Math.max(0, (now - v.t0) / v.dur));
    const e = t * t * (3 - 2 * t);
    return this.vanishing.has(block) ? 1 - e : e;
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
      this._setMatrix(b, _m.compose(pos, noRot, scale));
    }
  }

  clear() {
    this.buffed.clear();
    this.soloCreatures.clear();
    this.squirmyBlocks.clear();
    this.squirmies = [];
    this.squirmyOf.clear();
    this._born = 0;
    this.eyes.clear();
    this.anims.clear();
    this.vanishing.clear();
    this.appearing.clear();
    this.blocks.clear();
    this.byType.clear();
    this.changeLog.length = 0;
    this.idleMarks = {};
    this._refreshCells.clear();
    for (const batch of this._batchList) batch.clear();
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
   * "New" scene: a Stone at the origin, then each line of `template` (default
   * NEW_SCENE_TEMPLATE; see parseTemplate for one loaded from a file) in order.
   *
   * The world shell is the layer of empty cells next to the world. It is used up cell by cell
   * (in random order) and only recalculated once every cell in it is filled, so the world
   * grows a layer at a time. For each step:
   *  - `addTo` picks where its seeds go:
   *     "world" (default): the world shell, around all the blocks on the board together
   *     "sky": random cells on the sphere SKY_RADIUS_CM (50 cm) from the origin, like rain
   *     "previous": the empty shell of the clusters the previous template line made (its
   *                blocks still on the board), in random order; with none, "world" is used
   *  - `clusters: null` means `clusters = count`: every block is a seed, so all `count` blocks go
   *    straight into world-shell cells and nothing is left to grow.
   *  - otherwise, `clusters` seed blocks go into world-shell cells; seeds that touch are
   *    joined into one cluster. The remaining `count - clusters` blocks grow those clusters.
   *    `sizeDistribution` picks which cluster gets each block:
   *     "random":  a random group
   *     "uniform": clusters take turns, so they end up similar in size
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
  generateNew(template = NEW_SCENE_TEMPLATE) {
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
    /** Runs one template step, adding `count` blocks. */
    /** Where a step's seeds go (`addTo`): a function returning the next seed cell, or null. */
    const fromSky = () => {
      for (let i = 0; i < SKY_TRIES; i++) {
        const c = randomCellOnSphere(SKY_RADIUS_CM);
        if (!this.has(c.x, c.y, c.z) && isValidCell(c.x, c.y, c.z)) return [c.x, c.y, c.z];
      }
      return null;
    };
    // "previous": the blocks the previous template line made, and the current line's shell of them
    let prevMade = [];
    let madeNow = [];
    let prevShell = null;
    const fromPrevious = () => {
      prevShell ??= this._shellOf(prevMade.filter((block) => this.blocks.get(cellKey(block.x, block.y, block.z)) === block));
      return this._takeFrom(prevShell); // used up: no more seeds this way
    };
    const seedSource = (addTo) => {
      if (addTo === 'sky') return fromSky; // random cells SKY_RADIUS_CM from the origin, like rain
      if (addTo === 'previous') {
        if (prevMade.length) return fromPrevious; // around what the previous line made
        console.warn('Template: addTo "previous", but the previous line made no blocks: using "world"');
        return fromWorldShell;
      }
      if (addTo !== 'world') console.warn(`Template: unknown addTo "${addTo}", using "world"`);
      return fromWorldShell; // "world": the empty shell around all the blocks on the board
    };
    const runStep = ({ type, clusters: clusterCount, sizeDistribution = 'random', growth = 'random', addTo = 'world' }, count) => {
      const nextSeedCell = seedSource(addTo);
      const pickType = () => (type === 'random' ? RANDOM_BLOCKS[Math.floor(Math.random() * RANDOM_BLOCKS.length)] : type);
      // no cluster count given: every block is its own seed, straight into the world shell
      const seedCount = clusterCount ?? count;
      // seeds
      const seeds = [];
      for (let i = 0; i < Math.min(seedCount, count); i++) {
        const c = nextSeedCell();
        if (!c) break;
        if (this.add(...c, pickType())) {
          seeds.push(this.get(...c));
          madeNow.push(this.get(...c));
        }
      }
      // seeds that touch each other join into one cluster
      const unclustered = new Set(seeds);
      const clusters = [];
      for (const seed of seeds) {
        if (!unclustered.has(seed)) continue;
        unclustered.delete(seed);
        const members = [seed];
        for (let i = 0; i < members.length; i++) {
          for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
            const n = this.get(members[i].x + dx, members[i].y + dy, members[i].z + dz);
            if (n && unclustered.has(n)) {
              unclustered.delete(n);
              members.push(n);
            }
          }
        }
        clusters.push({ members, shell: [] });
      }
      // grow the clusters
      let left = count - seeds.length;
      let next = 0; // sizeDistribution "uniform": whose turn it is
      while (left > 0 && clusters.length) {
        // sizeDistribution: which cluster gets the next block
        const i = sizeDistribution === 'uniform' ? next % clusters.length : Math.floor(Math.random() * clusters.length);
        const g = clusters[i];
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
          clusters.splice(i, 1); // boxed in: this group can't grow
          continue;
        }
        if (this.add(...c, pickType())) {
          g.members.push(this.get(...c));
          madeNow.push(this.get(...c));
          left--;
        }
        next = i + 1;
      }
    };

    template.forEach((step, line) => {
      // what this line makes becomes "previous" for the next one (a skipped or deleteAll line makes nothing)
      prevMade = madeNow;
      madeNow = [];
      prevShell = null;
      if (step.type === BLOCK.FOG && !this.fogEnabled) return; // Options → Fog is off
      if (step.deleteAll) {
        // clear every block of its type off the board (e.g. scaffolding laid by earlier lines)
        const gone = [...this.ofType(step.type)];
        for (const b of gone) this.remove(b.x, b.y, b.z);
        console.log(`Template ${line + 1}/${template.length}: deleted all ${blockProps(step.type).name} ×${gone.length} → ${this.blocks.size} blocks`);
        return;
      }
      const before = this.blocks.size;
      if (step.count == null && step.shells != null) {
        // shells mode: the count is the size of the world's current empty shell, and the step
        // runs that way once per shell (with clusters: null, that lays exactly `shells` layers).
        // A fraction fills that part of one more shell: shells 1.5 = a full layer, then half the
        // next (its cells picked at random)
        const whole = Math.floor(step.shells), part = step.shells - whole;
        for (let s = 0; s < Math.ceil(step.shells); s++) {
          worldShell = this._shellOf(); // poll the empty shell now
          if (!worldShell.length) break;
          runStep(step, Math.round(worldShell.length * (s < whole ? 1 : part)));
        }
      } else {
        runStep(step, step.count ?? 0);
      }
      if ('groups' in step || 'distribution' in step) console.warn(`Template line ${line + 1}: "groups" / "distribution" are now "clusters" / "sizeDistribution"`);
      const { type, clusters = null, count = null, shells = null, sizeDistribution = 'random', growth = 'random', addTo = 'world' } = step;
      console.log(
        `Template ${line + 1}/${template.length}: ${blockProps(type).name} ×${this.blocks.size - before} ` +
        `(count ${count ?? '—'}, shells ${shells ?? '—'}, clusters ${clusters ?? 'each block'}, ` +
        `sizeDistribution ${sizeDistribution}, growth ${growth}, addTo ${addTo}) → ${this.blocks.size} blocks`
      );
    });
    // Void only holds cells open while the template runs: clear it all out now
    const voids = [...this.blocks.values()].filter((block) => block.type === BLOCK.VOID);
    for (const b of voids) this.remove(b.x, b.y, b.z);
    if (voids.length) console.log(`Template done: removed ${voids.length} Void blocks → ${this.blocks.size} blocks`);
    this._settleFalls(); // loose chunks and Fog drop into place, and Water flows, before play starts
    this._settleCreatures();
  }

  /**
   * Lets every block that can fall (detached groups, Fog clusters) fall, and Water flow, until nothing moves,
   * all at once: no time passes and nothing animates. Clouds blown aside by falling blocks
   * are removed straight away instead of shrinking. Stops after `maxPasses` passes.
   */
  _settleFalls(maxPasses = 2000) {
    this._quiet = true;
    let passes = 0, steps = 0;
    try {
      for (; passes < maxPasses; passes++) {
        const moved = stepGroups(this);
        for (const b of stepWater(this, moved)) moved.add(b); // Water flows until it pools
        for (const b of stepSink(this, moved)) moved.add(b); // …and sinkable creatures sink through it
        for (const b of stepFog(this, moved)) moved.add(b);
        let blown = 0;
        for (const b of [...this.vanishing.keys()]) {
          this.vanishing.delete(b);
          if (this.remove(b.x, b.y, b.z)) blown++;
        }
        steps += moved.size;
        if (!moved.size && !blown) break;
      }
    } finally {
      this._quiet = false;
    }
    // no slides: every block sits in its cell right away
    for (const k of this.anims.keys()) {
      const b = this.blocks.get(k);
      if (b) this._setMatrix(b, _m.makeTranslation(b.x, b.y, b.z));
    }
    this.anims.clear();
    this._dirty();
    console.log(`Settled: ${steps} block moves in ${passes} passes → ${this.blocks.size} blocks`);
  }

  toJSON() {
    return {
      format: 'grid-game-save',
      version: 1,
      units: 'cm',
      savedAt: new Date().toISOString(),
      blocks: [...this.blocks.values()]
        .filter((block) => !block.vanishing)
        .map((block) => ({
          ...this._saveBlock(block),
          ...(block.inventory && { inventory: block.inventory }),
          ...(block.shadeSmooth && { smooth: true }),
          ...(block.segments?.length && { segments: block.segments.map((s) => [s.x, s.y, s.z]) }),
          ...(block.buffs?.length && { buffs: block.buffs.map(({ type, turns, charges }) => ({ type, turns, charges })) }),
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
    const chains = []; // [head, saved segment cells]: linked once every block is in
    for (const b of list) {
      const x = Number(b.x), y = Number(b.y), z = Number(b.z);
      const type = b.type ?? b.color;
      if (this.add(x, y, z, type)) {
        loaded++;
        // restore which way a creature was facing (its floor is re-derived below) and its behavior
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
        if (Array.isArray(b.segments)) chains.push([this.get(x, y, z), b.segments]);
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
    for (const [head, cells] of chains) {
      for (const c of cells) {
        const s = Array.isArray(c) && this.get(Number(c[0]), Number(c[1]), Number(c[2]));
        if (s && s !== head && s.type === head.type && !s.segmentOf && !s.segments) this._attachSegment(head, s);
      }
    }
    this._born = Math.max(this._born, ...[...this.squirmyBlocks].map((s) => s.born + 1));
    for (const s of this.squirmyBlocks) delete s.isHead; // re-derive heads from the loaded order
    this.refreshSquirmies();
    this._settleCreatures();
    return { loaded, skipped };
  }
}
