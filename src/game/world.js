import * as THREE from 'three';
import { BLOCK, BLOCK_COLORS, RANDOM_BLOCKS } from './tools.js';
import { NEIGHBOR_DIRS, cellKey, isValidCell } from './lattice.js';
import { BLOCK_STYLE, FACE_DIRS, createBlockGeometry, createBlockMaterials } from './geometry.js';
import { CRAWLY_SIGHT_RADIUS, SQUIRMY_SIGHT_RADIUS, CrawlyEyes, DEFAULT_CRAWLY_BEHAVIOR, isCrawlyBehavior, orientCrawly } from './crawly.js';

/** Block types drawn with a procedural surface shader instead of flat colour. */
const STYLE_BY_TYPE = {
  [BLOCK.FOG]: BLOCK_STYLE.fog,
  [BLOCK.NIMBUS]: BLOCK_STYLE.nimbus,
  [BLOCK.DIRT]: BLOCK_STYLE.dirt,
  [BLOCK.STONE]: BLOCK_STYLE.stone,
  [BLOCK.WATER]: BLOCK_STYLE.water,
  [BLOCK.MOSS]: BLOCK_STYLE.moss,
  [BLOCK.BERRY]: BLOCK_STYLE.berry,
  [BLOCK.CRAWLY]: BLOCK_STYLE.crawly,
  [BLOCK.SQUIRMY]: BLOCK_STYLE.squirmy,
  [BLOCK.WOOD]: BLOCK_STYLE.wood,
  [BLOCK.CRYSTAL]: BLOCK_STYLE.crystal,
};
/** See-through block types: drawn by the translucent pass, and they don't cast ambient occlusion. */
const TRANSLUCENT_TYPES = new Set([BLOCK.WATER, BLOCK.CRYSTAL, BLOCK.FOG, BLOCK.NIMBUS]);
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
 * runs `n` times, re-polling the shell each time. See generateNew.
 */
//shellSize(i) = 14 + 24*i + 12*i^2
//shellSize(0) = 1, cumulativeSize(0) = 1
//shellSize(1) = 14, cumulativeSize(1) = 15
//shellSize(2) = 50, cumulativeSize(2) = 65
//shellSize(3) = 110, cumulativeSize(3) = 175
//shellSize(4) = 194, cumulativeSize(4) = 369
//If groups=1, distribution doesn't matter
//TODO: a "branching" growth rule
export const NEW_SCENE_RECIPE = [
  //Geode
  { type: BLOCK.FOG, groups: 1, count: 20, shells: null, distribution: 'uniform', growth: "worm" },
  { type: BLOCK.FOG, groups: 1, count: null, shells: 2, distribution: 'uniform', growth: "uniform" },
  { type: BLOCK.CRYSTAL, groups: 2, count: 30, shells: null, distribution: 'uniform', growth: "uniform" },
  { type: BLOCK.CRYSTAL, groups: null, count: null, shells: 1, distribution: 'uniform', growth: "random" },
  { type: BLOCK.STONE, groups: null, count: null, shells: 1, distribution: 'uniform', growth: "uniform" },

  { type: BLOCK.DIRT, groups: null, count: null, shells: 1, distribution: 'uniform', growth: "uniform" },

  { type: BLOCK.STONE, count: 50, groups: 1, distribution: 'uniform', growth: "random" },
  { type: BLOCK.STONE, count: 400, groups: 1, distribution: 'uniform', growth: "uniform" },
  { type: BLOCK.CRYSTAL, count: 10, groups: 3, distribution: 'random', growth: "uniform" },
  { type: BLOCK.STONE, count: 300, groups: 1, distribution: 'uniform', growth: "uniform" },
  { type: BLOCK.DIRT, count: 400, groups: 14, distribution: 'uniform', growth: "uniform" },
  { type: BLOCK.DIRT, count: 100, groups: null, distribution: 'uniform' },
  { type: BLOCK.WOOD, count: 20, groups: 5, distribution: 'random' },
  { type: BLOCK.MOSS, count: 200, groups: 20, distribution: 'random' },
  { type: BLOCK.WATER, count: 50, groups: 5, distribution: 'random', growth: "random" },
  { type: BLOCK.CRAWLY, count: 10, groups: 5, distribution: 'random', growth: "worm" },
  { type: BLOCK.SQUIRMY, count: 10, groups: 3, distribution: 'random', growth: "random" },
  { type: BLOCK.FOG, groups: null, count: null, shells: 1, distribution: 'uniform', growth: "uniform" },
  /*
  */
  // { type: BLOCK.NIMBUS, count: 500, groups: null },	//v=1210
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
    this.crawlies = new Set(); // Crawly blocks (also carry .floor and .front, see crawly.js)
    // Squirmies: touching Squirmy blocks form one creature, a chain ordered by placement
    // (`born`): the first placed is the head (it has the eyes and the behavior), the last the tail
    this.squirmyBlocks = new Set();
    this.squirmies = []; // [{ segments: [head, …, tail] }], see refreshSquirmies
    this.squirmyOf = new Map(); // Squirmy block -> its squirmy
    this._born = 0;
    this.eyes = new CrawlyEyes(parent);
    this.stepSeconds = STEP_FRACTION; // length of per-turn animations (s); the engine sets it from the turn length
    this.turn = 0; // current game turn, set by the engine; stamped on blocks as movedTurn
    this.listeners = new Map(); // event name -> Set of handlers (see on / emit)
    // same-type groups of non-creature blocks, rebuilt at the end of every turn (sim.js updateBlockGroups)
    this.blockGroups = []; // [{ type, blocks }]
    this.groupOf = new Map(); // block -> its group
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
   *   'squirmyAte' ({ squirmy, berry }) — a Squirmy (its head) started eating a Berry
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
    orientCrawly(this, c, moveDir);
    if (c.front !== front || c.floor !== floor) this.eyes.track(c, durationS);
  }

  /** Re-derives the floor of every Crawly next to cell (x, y, z). */
  _reorientAround(x, y, z) {
    if (!this.crawlies.size && !this.squirmyBlocks.size) return;
    for (const [dx, dy, dz] of NEIGHBOR_DIRS) {
      const n = this.blocks.get(cellKey(x + dx, y + dy, z + dz));
      if (n && (n.type === BLOCK.CRAWLY || n.isHead)) this._reorient(n);
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
          orientCrawly(this, b);
          this.eyes.track(b, 0);
        } else if (!b.isHead && wasHead) this.eyes.untrack(b);
      });
    }
  }

  /** Snaps every Crawly's orientation and eyes into place with no animation. */
  _settleCrawlies() {
    for (const c of [...this.crawlies, ...this.squirmyBlocks]) {
      if (c.type === BLOCK.SQUIRMY && !c.isHead) continue; // only Squirmy heads have eyes
      orientCrawly(this, c);
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
      if (!b || !TRANSLUCENT_TYPES.has(b.type)) return;
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
        if (n && !TRANSLUCENT_TYPES.has(n.type)) mask |= 1 << i;
      });
      style.setW(b.index, mask);
    };
    update(this.blocks.get(cellKey(x, y, z)));
    for (const [dx, dy, dz] of FACE_DIRS) update(this.blocks.get(cellKey(x + dx, y + dy, z + dz)));
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
    this.geometry.getAttribute('blockStyle').setXYZW(index, STYLE_BY_TYPE[type] ?? BLOCK_STYLE.plain, Math.random() * 40, 0, 0);
    if (TRANSLUCENT_TYPES.has(type)) this._refreshTranslucentAround(x, y, z);
    this._refreshAOAround(x, y, z);
    this.mesh.count = this.blocks.size;
    this._dirty();
    if (type === BLOCK.CRAWLY) {
      b.behavior = DEFAULT_CRAWLY_BEHAVIOR;
      b.sightRadius = CRAWLY_SIGHT_RADIUS;
      this.crawlies.add(b);
      orientCrawly(this, b);
      this.eyes.track(b, 0);
    }
    if (type === BLOCK.SQUIRMY) {
      b.born = this._born++;
      b.behavior = DEFAULT_CRAWLY_BEHAVIOR; // Wander (the head's behavior drives the whole Squirmy)
      b.sightRadius = SQUIRMY_SIGHT_RADIUS; // used while this block is the head
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
      this.keysByIndex[b.index] = lastKey;
    }
    this.keysByIndex.length = last;
    this.blocks.delete(k);
    this.anims.delete(k);
    this.crawlies.delete(b);
    this.eyes.untrack(b);
    if (this.squirmyBlocks.delete(b)) {
      delete b.isHead;
      this.refreshSquirmies();
    }
    this.mesh.count = this.blocks.size;
    if (TRANSLUCENT_TYPES.has(b.type)) this._refreshTranslucentAround(x, y, z);
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
    this.mesh.setColorAt(b.index, _c.set(BLOCK_COLORS[type]));
    const style = this.geometry.getAttribute('blockStyle');
    style.setX(b.index, STYLE_BY_TYPE[type] ?? BLOCK_STYLE.plain);
    style.setZ(b.index, 0);
    if (old === BLOCK.SQUIRMY) {
      this.squirmyBlocks.delete(b);
      this.eyes.untrack(b);
      delete b.isHead;
      this.refreshSquirmies();
    } else if (type === BLOCK.SQUIRMY) {
      b.born = this._born++;
      b.behavior = DEFAULT_CRAWLY_BEHAVIOR;
      b.sightRadius = SQUIRMY_SIGHT_RADIUS;
      this.squirmyBlocks.add(b);
      this.refreshSquirmies();
    }
    if (old === BLOCK.CRAWLY) {
      this.crawlies.delete(b);
      this.eyes.untrack(b);
    } else if (type === BLOCK.CRAWLY) {
      b.behavior = DEFAULT_CRAWLY_BEHAVIOR;
      b.sightRadius = CRAWLY_SIGHT_RADIUS;
      this.crawlies.add(b);
      orientCrawly(this, b);
      this.eyes.track(b, 0);
    }
    if (TRANSLUCENT_TYPES.has(old) || TRANSLUCENT_TYPES.has(type)) {
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
    if (b.type === BLOCK.CRAWLY || b.isHead) {
      this._reorient(b, turnCrawly ? [to.x - fromPos.x, to.y - fromPos.y, to.z - fromPos.z] : null, durationS);
    }
    this._reorientAround(fromPos.x, fromPos.y, fromPos.z);
    this._reorientAround(to.x, to.y, to.z);
    if (TRANSLUCENT_TYPES.has(b.type)) {
      this._refreshTranslucentAround(fromPos.x, fromPos.y, fromPos.z);
      this._refreshTranslucentAround(to.x, to.y, to.z);
    }
    this._refreshAOAround(fromPos.x, fromPos.y, fromPos.z);
    this._refreshAOAround(to.x, to.y, to.z);
    this._dirty();
    return true;
  }

  /** Advances sliding blocks, Crawly eyes and the water animation; call once per frame. */
  updateAnimations(now = performance.now()) {
    this.materials.uniforms.uTime.value = now / 1000;
    const p = new THREE.Vector3();
    this.eyes.update(now, (c, out) => this.renderedPosition(c, now, out));
    if (!this.anims.size && !this.vanishing.size) return;
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
    if (TRANSLUCENT_TYPES.has(b.type)) this._refreshTranslucentAround(b.x, b.y, b.z);
    this.anims.delete(cellKey(b.x, b.y, b.z)); // the vanish animation takes over its matrix
    this.vanishing.set(b, { from: new THREE.Vector3(b.x, b.y, b.z), dir, t0: performance.now(), dur: durationS * 1000 });
    return true;
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
    this.crawlies.clear();
    this.squirmyBlocks.clear();
    this.squirmies = [];
    this.squirmyOf.clear();
    this._born = 0;
    this.eyes.clear();
    this.anims.clear();
    this.vanishing.clear();
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
    const runStep = ({ type, groups: groupCount, distribution = 'random', growth = 'random' }, count) => {
      const pickType = () => (type === 'random' ? RANDOM_BLOCKS[Math.floor(Math.random() * RANDOM_BLOCKS.length)] : type);
      // no groups given: every block is its own seed, straight into the world shell
      const groups = groupCount ?? count;
      // seeds
      const seeds = [];
      for (let i = 0; i < Math.min(groups, count); i++) {
        const c = fromWorldShell();
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

    for (const step of NEW_SCENE_RECIPE) {
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
    }
    this._settleCrawlies();
  }

  toJSON() {
    return {
      format: 'grid-game-save',
      version: 1,
      units: 'cm',
      savedAt: new Date().toISOString(),
      blocks: [...this.blocks.values()].filter((b) => !b.vanishing).map(({ x, y, z, type, front, behavior, heldBehavior, walkTarget, trappedTurns, born }) =>
        type === BLOCK.SQUIRMY
          ? { x, y, z, type, born, behavior: heldBehavior && behavior === 'wait' ? heldBehavior : behavior, ...(front && { front }) }
          : (type === BLOCK.CRAWLY
            ? {
              // a selected Crawly is only waiting because it is selected: save what it will resume
              x, y, z, type, ...(front && { front }), behavior: heldBehavior && behavior === 'wait' ? heldBehavior : behavior,
              ...(walkTarget && { walkTarget: { ...walkTarget } }),
              ...(trappedTurns && { trappedTurns }),
            }
            : { x, y, z, type })),
    };
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
        if (type === BLOCK.CRAWLY && dir && NEIGHBOR_DIRS.some((d) => d.every((v, i) => v === dir[i]))) {
          this.get(x, y, z).front = dir;
        }
        if (type === BLOCK.CRAWLY && isCrawlyBehavior(b.behavior)) this.get(x, y, z).behavior = b.behavior;
        const wt = b.walkTarget;
        if (type === BLOCK.CRAWLY && wt && isValidCell(Number(wt.x), Number(wt.y), Number(wt.z))) {
          this.get(x, y, z).walkTarget = { x: Number(wt.x), y: Number(wt.y), z: Number(wt.z) };
        }
        if (type === BLOCK.CRAWLY && Number(b.trappedTurns) > 0) this.get(x, y, z).trappedTurns = Number(b.trappedTurns);
        if (type === BLOCK.SQUIRMY) {
          // keep the saved order (head .. tail), behavior and facing
          const s = this.get(x, y, z);
          if (Number.isFinite(Number(b.born))) s.born = Number(b.born);
          if (isCrawlyBehavior(b.behavior)) s.behavior = b.behavior;
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
