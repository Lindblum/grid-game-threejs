import * as THREE from 'three';
import { BLOCK_COLORS, BLOCK_STYLE, BLOCK_TYPES, BUFF_TYPES, EGG_SPOT_TYPES, TINT_BUFFS } from './blocks.js';
import { GRID, NEIGHBOR_DIRS } from './lattice.js';
import { PERLIN_PERIOD, VORONOI_BORDER_MAX, VORONOI_PERIOD, createNoiseTexture } from './noiseTexture.js';

/**
 * The block's shape is the active grid mode's cell (grids.js, lattice.js GRID): a truncated
 * octahedron, rhombic dodecahedron, cube or hexagonal prism, with an inradius of 1 cm (a prism:
 * to its sides). GRID.faces are in lattice units; cellFaces gives them in cm.
 */

/** The active grid's cell faces in cm (GRID.faces through GRID.toCm): { type, name, offset, normal, verts, center, inradius, distance }. */
export const cellFaces = () => GRID.cmFaces;

/**
 * Lattice offset to the neighbouring cell across each face, in face order (= the
 * `faceIndex` vertex attribute): the active grid's NEIGHBOR_DIRS (a live binding).
 */
export { NEIGHBOR_DIRS as FACE_DIRS };

/** Most neighbouring cells sharing one corner of a block (a rhombic dodecahedron's 4-face corners). */
const AO_SLOTS = 4;

/**
 * For a corner of the block (lattice units), the FACE_DIRS indices of the neighbouring cells
 * across a face that share it (3 in the truncated octahedron and the cube, 3 or 4 in the
 * rhombic dodecahedron). Used for ambient occlusion: the more of them are filled, the darker
 * the corner.
 */
function cornerNeighbours(v, verts) {
  const out = [];
  NEIGHBOR_DIRS.forEach(([dx, dy, dz], i) => {
    // the neighbour's own copy of the shape contains v if v - d is one of our vertices
    if (verts.some((u) => Math.abs(u.x - (v.x - dx)) + Math.abs(u.y - (v.y - dy)) + Math.abs(u.z - (v.z - dz)) < 1e-6)) out.push(i);
  });
  return out;
}

/**
 * Flat-shaded, indexed BufferGeometry of the active grid's cell, in cm. Each face is fanned
 * from its centre, and every vertex stores which face it belongs to ("faceIndex", see
 * FACE_DIRS) and, for corners, the neighbours sharing that corner ("aoFaces", up to AO_SLOTS FACE_DIRS indices; -1 for none) for ambient occlusion.
 * Within a face every vertex's data is the same wherever it's used, so each face stores its
 * centre and corners once and its triangles index them (a truncated octahedron: 86 vertices
 * instead of 216, so the vertex shader runs about 2.5x less often per block; faces can't
 * share vertices with each other: their normals and face numbers differ).
 */
export function createBlockGeometry() {
  const latticeVerts = GRID.faces.flatMap((f) => f.verts);
  const pos = [], nor = [], face = [], ao = [], index = [];
  // `point` in cm; `lattice`, the same corner in lattice units (to find the cells sharing it)
  const vertex = (point, faceNo, normal, lattice) => {
    pos.push(point.x, point.y, point.z);
    nor.push(normal.x, normal.y, normal.z);
    face.push(faceNo);
    const cn = lattice ? cornerNeighbours(lattice, latticeVerts) : [];
    for (let i = 0; i < AO_SLOTS; i++) ao.push(cn[i] ?? -1);
    return pos.length / 3 - 1;
  };
  GRID.cmFaces.forEach((f, fi) => {
    const centre = vertex(f.center, fi, f.normal, null);
    const ring = f.verts.map((corner, k) => vertex(corner, fi, f.normal, GRID.faces[fi].verts[k]));
    for (let i = 0; i < ring.length; i++) index.push(centre, ring[i], ring[(i + 1) % ring.length]); // same fan, same winding
  });
  const g = new THREE.BufferGeometry();
  g.setIndex(index);
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('faceIndex', new THREE.Float32BufferAttribute(face, 1));
  g.setAttribute('aoFaces', new THREE.Float32BufferAttribute(ao, AO_SLOTS));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Line segments along the edges of the active grid's cell (cm). */
export function createEdgesGeometry() {
  const faces = cellFaces();
  const seen = new Set();
  const pts = [];
  for (const f of faces) {
    for (let i = 0; i < f.verts.length; i++) {
      const a = f.verts[i], b = f.verts[(i + 1) % f.verts.length];
      const k = [a, b].map((v) => v.toArray().map((x) => x.toFixed(3)).join(',')).sort().join('|');
      if (seen.has(k)) continue;
      seen.add(k);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

/** The place highlight is drawn in this fraction of the colour of the block to be placed. */
export const EDGE_SHADE = 0.725;
/** Thickness of the thin highlight lines (the Select tool's wireframes are half this), cm. */
export const EDGE_WIDTH_CM = 0.045;
/** Ambient occlusion: a corner with all its sharing neighbours filled is darkened by this much. */
export const AO_STRENGTH = 0.45;

export { BLOCK_STYLE }; // defined in blocks.js, with the rest of the block properties
/** See-through block types (opacity below 1): their styles are drawn by the translucent pass. */
const TRANSLUCENT = BLOCK_TYPES.filter((t) => t.opacity < 1);
/** Styles drawn by the translucent pass (the rest are opaque). */
export const TRANSLUCENT_STYLES = TRANSLUCENT.map((t) => t.style);

// Noise lookups from the pre-baked 3D texture (see noiseTexture.js): one texture fetch
// each instead of evaluating Perlin (8 gradient hashes) or Voronoi (27 cells) per pixel.
const NOISE_GLSL = `
uniform highp sampler3D uNoiseTex;
// Options → Materials: Simple leaves out the fine detail (FINE(x) is 0, so its texture fetches
// compile away) and sums half the noise octaves
#ifdef SIMPLE_MATERIALS
#define FINE(x) 0.0
#define FBM_OCTAVES 2
#else
#define FINE(x) (x)
#define FBM_OCTAVES 4
#endif
// 3D Perlin noise, ~[-1, 1]; one lattice cell per unit of p
float perlin3(vec3 p) {
  return texture(uNoiseTex, p * ${(1 / PERLIN_PERIOD).toFixed(6)}).r * 2.0 - 1.0;
}
float perlinFbm(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < FBM_OCTAVES; k++) { s += a * perlin3(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// 3D Voronoi: x = distance to the border between the two nearest cells,
// y = random value in [0, 1) for the nearest cell; one cell per unit of p
vec2 voronoi3(vec3 p) {
  vec4 t = texture(uNoiseTex, p * ${(1 / VORONOI_PERIOD).toFixed(6)});
  float border = t.g + t.a / 255.0; // 16-bit border distance: high byte in G, low byte in A
  return vec2(border * ${VORONOI_BORDER_MAX.toFixed(4)}, t.b);
}
// Box-filtered coverage of a line of half-width w around a Voronoi border, for a pixel whose
// footprint spans ±pw in border-distance units: smooth edges up close, and a line thinner
// than a pixel fades out instead of flickering.
float lineCoverage(float d, float w, float pw) {
  pw = max(pw, 1e-4);
  return max(0.0, min(d + pw, w) - max(d - pw, -w)) / (2.0 * pw);
}
// arithmetic hash (no sin), three values in [0, 1) — Dave Hoskins' hash33
vec3 cellHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
`;

// Water surface height: sine bands warped by Perlin noise that stay fixed in the
// block (static waviness) plus Perlin ripples and a travelling wave that move with time.
const WATER_GLSL = `
float waterHeight(vec3 p, float t) {
  float w = perlin3(p * 1.3) * 2.5;
  float still = 0.5 * sin(p.x * 3.1 + p.z * 1.7 + w) + 0.5 * sin(p.y * 2.3 - p.z * 2.9 + w * 0.7);
  float moving = 1.2 * perlin3(p * 2.6 + vec3(0.0, t * 0.45, t * 0.3))
               + 0.25 * sin(dot(p, vec3(0.8, 0.5, -0.6)) * 5.0 - t * 1.8 + w);
  return still * 0.55 + moving * 0.45;
}
`;

// Bump-maps a view-space normal from a scalar height using screen-space derivatives
// (same maths as three.js perturbNormalArb).
const BUMP_GLSL = `
vec3 heightBump(vec3 surfPos, vec3 surfNorm, float h, float scale) {
  vec3 sx = dFdx(surfPos), sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm), r2 = cross(surfNorm, sx);
  float det = dot(sx, r1);
  vec2 dh = vec2(dFdx(h), dFdy(h)) * scale;
  if (scale <= 0.0) return surfNorm; // after the derivatives, so they stay in uniform flow
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

/**
 * The block materials, one per drawing pass: `opaque` (every style except the see-through
 * ones), `cloud` (Fog, Nimbus), `crystal` and `translucent` (Water; both refractive with Procedural), plus the
 * `body…` versions for Rendering: Smooth. Each pass draws its own InstancedMesh holding only
 * its blocks (World batches, blockBatch.js); the vertex shader still drops other styles as a
 * safeguard. All have per-instance colour.
 * `material.userData.dither.value` = instance index (in that material's pass) to draw 50 %
 * see-through with a checkerboard dither (the block targeted by Delete); -1 = none.
 * `uniforms.uTime.value` = seconds, drives the water animation.
 * Instances whose `blockStyle.x` is BLOCK_STYLE.dirt (Perlin noise), BLOCK_STYLE.stone
 * (Perlin-warped Voronoi slabs), BLOCK_STYLE.water (wavy, animated, translucent) or
 * BLOCK_STYLE.moss (Voronoi cushions over soil), BLOCK_STYLE.berry (2D strawberry
 * seed pattern in each face's plane), BLOCK_STYLE.crawly (2D iridescent beetle shell), BLOCK_STYLE.wood
 * (3D growth rings) or BLOCK_STYLE.crystal (faceted, glowing, translucent magenta gem)
 * get a procedural surface tinted by the instance colour; `blockStyle.y` seeds the pattern.
 * `blockStyle.z` = bit mask of faces (bit i = FACE_DIRS[i]) that touch another block of the
 * same translucent type; the translucent pass skips those faces so touching Water (or
 * Crystal) looks like one body.
 * `blockStyle.w` = bit mask of neighbours (bit i = FACE_DIRS[i]) holding an opaque block,
 * for ambient occlusion (`uniforms.uAO.value` 1 = on, 0 = off).
 * `setMaterials(level)` (Options → Materials, see MATERIALS) recompiles them: 'procedural' is
 * all of the above; 'simple' keeps each style's pattern but leaves out its fine grain, half the
 * noise octaves and the bump mapping; 'solid' is plain instance colours (plus Water / Crystal
 * translucency), the procedural code compiled out. The lower levels are for slower GPUs.
 */
export const MATERIALS = ['solid', 'simple', 'procedural'];
/** Crystal refraction (Materials: Procedural; see createBlockMaterials): how much light passes through, its index of refraction, and how thick a gem the light crosses (cm). */
export const CRYSTAL_TRANSMISSION = 0.85;
export const CRYSTAL_IOR = 1.6;
export const CRYSTAL_THICKNESS_CM = 1.6;
/** Water refraction (Materials: Procedural): its index of refraction and how deep a body the light crosses (cm). How much light passes through follows its shader's opacity. */
export const WATER_IOR = 1.33;
export const WATER_THICKNESS_CM = 1.2;
/**
 * Fog and Nimbus scattering (Refraction on, any Materials): what's behind a cloud shows through
 * blurred. Physical transmission with no bending (no thickness) and rough: how rough sets how
 * blurred (the transmission image's mip level; it needs an ior of 1.5 to blur at all).
 */
export const CLOUD_BLUR_ROUGHNESS = 0.3;
/** …and how much more of what's behind a scattering cloud shows than its opacity would let through blended (see the transmission chunk). */
const CLOUD_SCATTER_GAIN = 4;
const CLOUD_IOR = 1.5;

/**
 * The tint flag (blockStyle.z) holds a creature's facing too: flag = tint + FACING_STEP × (code + 1),
 * the tint (a buff's colour, an Egg's spots) below FACING_STEP, and the code a direction in two
 * angles of FACING_STEPS steps each: code = azimuth step × FACING_STEPS + elevation step
 * (facingCode; the shader's FACING_DIR undoes it). Any direction, so a turn can sweep round smoothly.
 */
export const FACING_STEP = 16;
export const FACING_STEPS = 64;

/** The facing code of unit direction `d` (cm; any Vector3-like): its azimuth round +y and elevation, FACING_STEPS steps each. */
export function facingCode(d) {
  const az = Math.atan2(d.z, d.x); // -π .. π
  const el = Math.asin(Math.max(-1, Math.min(1, d.y))); // -π/2 .. π/2
  const a = Math.round(((az + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * FACING_STEPS) % FACING_STEPS;
  const e = Math.min(FACING_STEPS - 1, Math.max(0, Math.round((el / Math.PI + 0.5) * (FACING_STEPS - 1))));
  return a * FACING_STEPS + e;
}

export function createBlockMaterials() {
  const uniforms = {
    uTime: { value: 0 },
    uNoiseTex: { value: createNoiseTexture() },
    uAO: { value: 1 }, // Options → Ambient Occlusion: 1 = on, 0 = off
    uSmoothRendering: { value: 0 }, // Options → Rendering: Smooth = 1: blocks flagged blockMerged are hidden here and drawn as cluster bodies
    uShowFog: { value: 1 }, // Options → Fog: 0 = Fog blocks aren't drawn (they're still there)
  };
  const options = { level: 'procedural' }; // Options → Materials (MATERIALS)
  const opaque = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0 });
  // Water: alpha-blended, or refractive (physical transmission, like Crystal below) with
  // Refraction On and Materials: Procedural (see applyRefraction)
  const waterOptions = { roughness: 0.1, metalness: 0.0, transparent: true, depthWrite: false, ior: WATER_IOR, thickness: WATER_THICKNESS_CM, specularIntensity: 1 };
  const translucent = new THREE.MeshPhysicalMaterial(waterOptions);
  // clouds (Fog, Nimbus) get their own see-through pass, drawn before Water and Crystal and
  // writing depth: they're nearly opaque, so what's behind them is hidden (instead of the
  // later-drawn blocks showing through in front of them), while Water and Crystal in front of
  // a cloud still blend over it
  const cloudOptions = { roughness: CLOUD_BLUR_ROUGHNESS, metalness: 0.0, transparent: true, depthWrite: true, ior: CLOUD_IOR, thickness: 0 }; // (physical: to scatter, see applyRefraction)
  const cloud = new THREE.MeshPhysicalMaterial(cloudOptions);
  // Rendering: Smooth: each cluster drawn as one merged, smoothed mesh (clusterBody.js); ordinary (not
  // instanced) geometry carrying the same attributes per vertex, colour as vertex colour
  const body = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0, vertexColors: true });
  // a body the camera is inside (World.setSeeThrough): dithered all over, its inside faces drawn too
  const bodySeeThrough = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0, vertexColors: true, side: THREE.DoubleSide });
  const bodyTranslucent = new THREE.MeshPhysicalMaterial({ ...waterOptions, vertexColors: true });
  const bodyCloud = new THREE.MeshPhysicalMaterial({ ...cloudOptions, vertexColors: true });
  // …and a depth pre-pass for each (drawn first, by the same mesh: see BlockBatch's depthMaterial
  // and ClusterBodies._bodyMesh): with the depth laid down, the colour pass blends only each
  // pixel's nearest surface, once, so a cloud is the same see-through all over whatever order its
  // triangles come in (blended surface over surface, a rebuilt mesh's new triangle order made its
  // sides flicker). The same shader program as the colour pass (colorWrite is render state), so
  // the depths match exactly.
  // Water too, while it's blended (not refracting: see applyRefraction)
  const translucentDepth = new THREE.MeshPhysicalMaterial({ ...waterOptions, colorWrite: false, depthWrite: true });
  const bodyTranslucentDepth = new THREE.MeshPhysicalMaterial({ ...waterOptions, colorWrite: false, depthWrite: true, vertexColors: true });
  const cloudDepth = new THREE.MeshStandardMaterial({ roughness: 1.0, metalness: 0.0, transparent: true, depthWrite: true, colorWrite: false });
  const bodyCloudDepth = new THREE.MeshStandardMaterial({ roughness: 1.0, metalness: 0.0, transparent: true, depthWrite: true, colorWrite: false, vertexColors: true });
  // Crystal: refractive. Physical transmission: the scene behind is rendered to a texture and
  // seen through the gem, bent by its index of refraction over its thickness (cm, like the
  // lattice) and tinted by its colour; each facet's tilted normal (the Crystal shader) bends
  // it its own way. Transmissive objects get their own render pass after the opaque ones.
  const crystalOptions = { roughness: 0.04, metalness: 0.0, transmission: CRYSTAL_TRANSMISSION, ior: CRYSTAL_IOR, thickness: CRYSTAL_THICKNESS_CM, specularIntensity: 1 };
  const crystal = new THREE.MeshPhysicalMaterial(crystalOptions);
  const bodyCrystal = new THREE.MeshPhysicalMaterial({ ...crystalOptions, vertexColors: true });
  patchBlockShader(opaque, uniforms, options, false);
  patchBlockShader(translucent, uniforms, options, true);
  patchBlockShader(cloud, uniforms, options, true, false, 'cloud');
  patchBlockShader(crystal, uniforms, options, true, false, 'crystal');
  patchBlockShader(body, uniforms, options, false, true);
  patchBlockShader(bodyTranslucent, uniforms, options, true, true);
  patchBlockShader(bodyCloud, uniforms, options, true, true, 'cloud');
  patchBlockShader(translucentDepth, uniforms, options, true);
  patchBlockShader(bodyTranslucentDepth, uniforms, options, true, true);
  patchBlockShader(cloudDepth, uniforms, options, true, false, 'cloud');
  patchBlockShader(bodyCloudDepth, uniforms, options, true, true, 'cloud');
  patchBlockShader(bodyCrystal, uniforms, options, true, true, 'crystal');
  patchBlockShader(bodySeeThrough, uniforms, options, false, true, null, 1);
  // a body seen into (Accessibility → View Internal): dithered to 3/4, front faces only
  const bodyInternal = new THREE.MeshStandardMaterial({ roughness: 0.75, metalness: 0.0, vertexColors: true });
  patchBlockShader(bodyInternal, uniforms, options, false, true, null, 2);
  const all = [opaque, translucent, cloud, crystal, body, bodyTranslucent, bodyCloud, bodyCrystal, bodySeeThrough, bodyInternal, cloudDepth, bodyCloudDepth, translucentDepth, bodyTranslucentDepth];
  // the Delete tool's see-through block: an instance index per material (each pass numbers its
  // own blocks; see World.setDithered); a depth pre-pass shares its colour pass's, so both drop
  // the same pixels
  for (const m of all) m.userData.dither = { value: -1 };
  cloudDepth.userData.dither = cloud.userData.dither;
  bodyCloudDepth.userData.dither = bodyCloud.userData.dither;
  translucentDepth.userData.dither = translucent.userData.dither;
  bodyTranslucentDepth.userData.dither = bodyTranslucent.userData.dither;
  // Options → Refraction: On, Crystal and Water bend the scene behind them (transmission: the
  // opaque scene drawn again, per eye in XR, into a mipmapped image), with Materials: Procedural
  // only; Off, or with Simple / Solid (for slower GPUs), they are simply see-through,
  // alpha-blended at their shader's opacity, which is much cheaper. Fog and Nimbus scatter (what's
  // behind them blurred, from the same image) whenever it's On, whatever the Materials
  let refraction = true;
  const applyRefraction = () => {
    const set = (mats, transmission) => {
      for (const m of mats) {
        const on = transmission > 0;
        if (m.transmission === transmission && m.depthWrite === on) continue;
        m.transmission = transmission;
        m.transparent = !on;
        m.depthWrite = on;
        m.needsUpdate = true; // recompile with / without transmission
      }
    };
    const refracts = refraction && options.level === 'procedural';
    set([crystal, bodyCrystal], refracts ? CRYSTAL_TRANSMISSION : 0);
    set([translucent, bodyTranslucent], refracts ? 1 : 0);
    // refracting Water is drawn whole (writing depth, not blended): no depth pre-pass needed
    translucentDepth.visible = bodyTranslucentDepth.visible = !refracts;
    // clouds: scattering (transmission, not blended) or blended; they write depth either way
    for (const m of [cloud, bodyCloud]) {
      const t = refraction ? 1 : 0;
      if (m.transmission === t) continue;
      m.transmission = t;
      m.transparent = !refraction;
      m.needsUpdate = true;
    }
    cloudDepth.visible = bodyCloudDepth.visible = !refraction; // (scattering, a cloud is drawn whole: no pre-pass)
  };
  const sun = createSunMaterial(uniforms);
  const setMaterials = (level) => {
    if (!MATERIALS.includes(level) || options.level === level) return;
    options.level = level;
    for (const m of all) m.needsUpdate = true; // recompile with SOLID_MATERIALS, SIMPLE_MATERIALS or neither
    setSunLevel(sun, level);
    applyRefraction();
  };
  // Dithered blocks (World.setDithered, setSeeThrough) drop pixels with `discard`, compiled in
  // (DISCARDS) only while something is dithered: a shader that can discard loses the GPU's
  // early depth test (on mobile GPUs like the Quest's, its whole depth pre-pass), so every
  // hidden surface behind the nearest gets shaded in full. The see-through body materials
  // always have it.
  let discards = false;
  const setDiscards = (on) => {
    if (discards === on) return;
    discards = on;
    for (const m of all) {
      m.userData.discards = on;
      m.needsUpdate = true; // (each variant compiled once, then cached)
    }
  };
  const setRefraction = (on) => {
    if (refraction === on) return;
    refraction = on;
    applyRefraction();
  };
  applyRefraction();
  return { opaque, translucent, cloud, crystal, body, bodyTranslucent, bodyCloud, bodyCrystal, bodySeeThrough, bodyInternal, cloudDepth, bodyCloudDepth, translucentDepth, bodyTranslucentDepth, sun, uniforms, setMaterials, setRefraction, setDiscards };
}

/**
 * The sun (the revolving light's ball), unlit, one look per Options → Materials level:
 * 'solid' is plain gold; 'simple' adds limb darkening (a pale-gold centre deepening to orange
 * at the rim) and slow, drifting convection mottling; 'procedural' adds granules (Voronoi
 * cells, warped and drifting), sunspots and flickering bright filaments round the rim.
 * Shares the blocks' uTime and noise texture (`uniforms`, see createBlockMaterials).
 */
function createSunMaterial(uniforms) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uTime, uNoiseTex: uniforms.uNoiseTex },
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;     // the point's direction from the sun's centre (object space)
      varying vec3 vNormalV; // view-space normal
      varying vec3 vViewPos;
      void main() {
        vDir = normalize(position);
        vNormalV = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vDir;
      varying vec3 vNormalV;
      varying vec3 vViewPos;
      ${NOISE_GLSL}
      void main() {
        vec3 col = vec3(1.0, 0.76, 0.18); // gold (sRGB)
        #ifndef SOLID_MATERIALS
          float mu = clamp(dot(normalize(vNormalV), normalize(-vViewPos)), 0.0, 1.0); // 1 facing us, 0 at the rim
          col = mix(vec3(0.93, 0.42, 0.05), vec3(1.0, 0.92, 0.6), pow(mu, 0.55)); // limb darkening
          vec3 p = vDir * 3.0;
          float t = uTime;
          col *= 0.88 + 0.3 * perlinFbm(p * 1.4 + vec3(t * 0.08, -t * 0.05, t * 0.06)); // convection, drifting
          #ifndef SIMPLE_MATERIALS
            vec3 q = p * 2.6 + 0.7 * vec3(perlin3(p + t * 0.1), perlin3(p.yzx - t * 0.07), 0.0);
            col *= mix(0.78, 1.08, smoothstep(0.0, 0.22, voronoi3(q + vec3(0.0, t * 0.04, 0.0)).x)); // granules, dark lanes between
            float spot = perlin3(p * 0.6 + vec3(7.3, t * 0.015, 1.1));
            col *= 1.0 - 0.65 * smoothstep(0.42, 0.58, spot); // sunspots
            float rim = pow(1.0 - mu, 3.0) * (0.55 + 0.45 * perlin3(p * 2.2 + vec3(0.0, t * 0.5, t * 0.3)));
            col += vec3(1.0, 0.62, 0.16) * rim * 0.9; // flickering filaments round the rim
          #endif
        #endif
        gl_FragColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(2.2)), 1.0); // (to linear: the colour-space step below takes it back)
        #include <colorspace_fragment>
      }`,
  });
  setSunLevel(mat, 'procedural');
  return mat;
}

/** The sun material's Materials level (see createSunMaterial): recompiles with its defines. */
function setSunLevel(mat, level) {
  mat.defines = level === 'solid' ? { SOLID_MATERIALS: '' } : level === 'simple' ? { SIMPLE_MATERIALS: '' } : {};
  mat.needsUpdate = true;
}

/**
 * `mergedBody`: a material for merged cluster bodies (MERGED_BODY, see clusterBody.js):
 * the geometry isn't instanced; positions are in cm around the lattice origin, `localPos`
 * is each vertex's place on its own block (so patterns stay per block), `blockIndex` its
 * block's instance index (for the Delete tool's see-through target), and the normals are the
 * smoothed body's: every style is shaded smooth, and the rounded styles (Fog, Nimbus, Crawly,
 * Squirmy) take their "out from the centre" normal from them instead of from the block centre.
 */
/**
 * `subPass` (with `translucentPass`): a see-through pass for one kind only, which the plain
 * translucent pass skips: 'cloud' (CLOUD_PASS: Fog, Nimbus, writing depth) or 'crystal'
 * (CRYSTAL_PASS: refractive Crystal).
 * `seeThrough` (with `mergedBody`): the whole body dithered (SEE_THROUGH, its level: 1 = the
 * camera is inside it, 2 = View Internal). Instances are dithered one by one instead (the
 * blockSeeThrough attribute, the same levels). Either way, with the material double-sided
 * (World.setSeeThrough), only level-1 blocks draw back faces.
 */
function patchBlockShader(mat, uniforms, options, translucentPass, mergedBody = false, subPass = null, seeThrough = 0) {
  const cloudPass = subPass === 'cloud', crystalPass = subPass === 'crystal';
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.uniforms.uDitherIndex = mat.userData.dither; // this material's own (World.setDithered)
    if (translucentPass) shader.defines = { ...shader.defines, TRANSLUCENT_PASS: '' };
    if (cloudPass) shader.defines = { ...shader.defines, CLOUD_PASS: '' };
    if (crystalPass) shader.defines = { ...shader.defines, CRYSTAL_PASS: '' };
    if (mergedBody) shader.defines = { ...shader.defines, MERGED_BODY: '' };
    if (seeThrough) shader.defines = { ...shader.defines, SEE_THROUGH: seeThrough.toFixed(1) };
    if (seeThrough || mat.userData.discards) shader.defines = { ...shader.defines, DISCARDS: '' };
    if (options.level === 'solid') shader.defines = { ...shader.defines, SOLID_MATERIALS: '' };
    if (options.level === 'simple') shader.defines = { ...shader.defines, SIMPLE_MATERIALS: '' };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 faceIndex; // x: the face (FACE_DIRS index); yzw, blocks only: the vertex on a lone block's Smooth rendering shape (addSmoothShape)
        attribute vec4 aoFaces;
        attribute vec4 blockStyle;
        varying float vAO;
        uniform float uDitherIndex;
        uniform float uSmoothRendering;
        uniform float uShowFog;
        #ifdef MERGED_BODY
        attribute vec3 localPos;
        attribute float blockIndex;
        attribute vec3 texOrigin; // its block's texture origin (cm; see blockTexOrigin)
        #else
        // where the block's 3D patterns are sampled from (cm): the cell it was made in, so
        // neighbours share one texture space (no seams in a cluster), kept as it moves (World.add)
        attribute vec3 blockTexOrigin;
        attribute float blockMerged; // Rendering: Smooth: 1 = this block is drawn by a cluster body instead
        attribute float blockSmooth; // 1 = smooth shading (World.setSmooth, e.g. excreted blocks)
        attribute float blockSeeThrough; // 1 = the camera is inside it (or its creature): dithered, inside faces drawn (World.setSeeThrough)
        #endif
        varying float vSeeThrough;
        varying float vSmooth;
        varying float vDither;
        varying float vStyle;
        varying float vTint; // opaque creatures: 1 = drawn in a buff's colour (see World._refreshLook)
        varying vec3 vNoisePos;
        varying vec3 vLatPos; // where it is in the build (lattice cm, shared by all blocks): status glows flow across a body's blocks
        varying vec3 vTexOrigin;
        varying vec3 vLocalNormal;
        varying vec3 vLocalPos;
        varying float vSeed;
        varying mat3 vLocalToView;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef MERGED_BODY
        vDither = abs(blockIndex - uDitherIndex) < 0.5 ? 1.0 : 0.0;
        vec3 blockPos = localPos;
        vTexOrigin = texOrigin;
        vSmooth = 0.0; // bodies are smooth already
        #ifdef SEE_THROUGH
        vSeeThrough = SEE_THROUGH;
        #else
        vSeeThrough = 0.0;
        #endif
        #else
        vSeeThrough = blockSeeThrough;
        vSmooth = blockSmooth * uSmoothRendering; // only with Rendering: Smooth (Blocky keeps every block flat)
        vDither = abs(float(gl_InstanceID) - uDitherIndex) < 0.5 ? 1.0 : 0.0;
        // smooth-shaded, it takes a lone block's rounded shape too (like the body it came from)
        transformed = mix(position, faceIndex.yzw, vSmooth);
        vec3 blockPos = transformed;
        vTexOrigin = blockTexOrigin;
        #endif
        vStyle = blockStyle.x;
        vTint = blockStyle.z; // (for translucent blocks z is their face mask; only opaque styles read vTint)
        // where the 3D patterns are sampled (cm): the block's own position plus its texture
        // origin, so neighbouring blocks continue one pattern, and it stays glued to the block
        // while it slides
        vNoisePos = blockPos + vTexOrigin;
        #ifdef MERGED_BODY
        vLatPos = transformed; // (a body's vertices are in the build's space already)
        #else
        vLatPos = (instanceMatrix * vec4(transformed, 1.0)).xyz; // (the block's place, as drawn: sliding too)
        #endif
        vLocalNormal = normal; // block-local face normal (instances are only translated; bodies: the smooth normal)
        vLocalPos = blockPos;  // block-local position (without the texture origin)
        vSeed = blockStyle.y;
        // block-local directions -> view space (instances are only translated; drop the cm scale)
        {
          mat3 m = mat3(modelViewMatrix);
          vLocalToView = mat3(normalize(m[0]), normalize(m[1]), normalize(m[2]));
        }
        // ambient occlusion: fraction of the cells sharing this corner (3, or 4 at a rhombic
        // dodecahedron's 4-face corners) that are filled (blockStyle.w = neighbour mask,
        // bit i = FACE_DIRS[i]); face centres stay 0
        {
          int occ = int(blockStyle.w + 0.5);
          float n = 0.0, total = 0.0;
          for (int i = 0; i < 4; i++) {
            if (aoFaces[i] < 0.0) continue;
            total += 1.0;
            if (((occ >> int(aoFaces[i] + 0.5)) & 1) == 1) n += 1.0;
          }
          vAO = total > 0.0 ? n / total : 0.0;
        }`
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        // skip instances drawn by the other pass: push every vertex past the far plane
        bool isTranslucent = ${TRANSLUCENT_STYLES.map((s) => `abs(blockStyle.x - ${s.toFixed(1)}) < 0.5`).join(' || ')};
        #ifdef TRANSLUCENT_PASS
        if (!isTranslucent) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        // clouds have a pass of their own (CLOUD_PASS, drawn first and writing depth)
        bool isCloudStyle = abs(blockStyle.x - ${BLOCK_STYLE.fog.toFixed(1)}) < 0.5 || abs(blockStyle.x - ${BLOCK_STYLE.nimbus.toFixed(1)}) < 0.5;
        // …and so does Crystal (CRYSTAL_PASS: refractive)
        bool isCrystalStyle = abs(blockStyle.x - ${BLOCK_STYLE.crystal.toFixed(1)}) < 0.5;
        #ifdef CLOUD_PASS
        if (!isCloudStyle) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        #elif defined(CRYSTAL_PASS)
        if (!isCrystalStyle) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        #else
        if (isCloudStyle || isCrystalStyle) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        #endif
        #ifndef MERGED_BODY
        // also skip faces shared with a block of the same translucent type (no inner walls, less overdraw)
        if (((int(blockStyle.z + 0.5) >> int(faceIndex.x + 0.5)) & 1) == 1) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        #endif
        #else
        if (isTranslucent) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        #endif
        // Options → Fog off: Fog isn't drawn
        if (uShowFog < 0.5 && abs(blockStyle.x - ${BLOCK_STYLE.fog.toFixed(1)}) < 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        // hidden block types (Void) are never drawn
        if (${BLOCK_TYPES.filter((t) => t.hidden).map((t) => `abs(blockStyle.x - ${t.style.toFixed(1)}) < 0.5`).join(' || ') || 'false'}) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        #ifndef MERGED_BODY
        // Rendering: Smooth: blocks drawn by a cluster body instead (clusterBody.js)
        if (uSmoothRendering > 0.5 && blockMerged > 0.5) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
        #endif`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vSeeThrough;
        varying float vSmooth;
        varying float vDither;
        varying float vStyle;
        varying float vTint;
        varying vec3 vNoisePos;
        varying vec3 vLatPos; // where it is in the build (lattice cm, shared by all blocks): status glows flow across a body's blocks
        varying vec3 vTexOrigin;
        varying vec3 vLocalNormal;
        varying vec3 vLocalPos;
        varying float vSeed;
        varying mat3 vLocalToView;
        uniform float uTime;
        uniform float uAO;
        uniform float uSmoothRendering;
        // the tint flag (vTint) without the facing packed above it (FACING_STEP), and the facing's
        // code (facingCode; -1: none) and direction (cm, unit length)
        #define TINT_FLAG int(mod(vTint + 0.5, ${FACING_STEP.toFixed(1)}))
        #define FACING_CODE (int((vTint + 0.5) / ${FACING_STEP.toFixed(1)}) - 1)
        vec3 facingDir(int code) {
          float az = float(code / ${FACING_STEPS}) / ${FACING_STEPS.toFixed(1)} * 6.2831853;
          float el = (float(code - (code / ${FACING_STEPS}) * ${FACING_STEPS}) / ${(FACING_STEPS - 1).toFixed(1)} - 0.5) * 3.1415927;
          return vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
        }
        varying float vAO;
        // wood's ring centres: one in each square this wide (cm): about one per block (a cell is 2 cm
        // across), so each shows its rings round a pith, shared with its neighbours
        #define WOOD_PITH_CM 2.0
        #define WOOD_BLEND 6.0 // how sharply rings round neighbouring piths meet (higher: a tighter seam)
        ${NOISE_GLSL}
        ${WATER_GLSL}
        ${BUMP_GLSL}
        // a buff's glow colour, by a creature's tint flag (TINT_BUFFS: 1 Rockbiter gold, 2 Fertile pink, …)
        const vec3 BUFF_GLOWS[${TINT_BUFFS.length}] = vec3[${TINT_BUFFS.length}](${TINT_BUFFS.map((k) => `vec3(${new THREE.Color(BUFF_TYPES[k].color).toArray().map((v) => v.toFixed(3)).join(', ')})`).join(', ')});
        // an Egg's spot colour, by its tint flag: the creature inside it (EGG_SPOT_TYPES)
        const vec3 EGG_SPOTS[${EGG_SPOT_TYPES.length}] = vec3[${EGG_SPOT_TYPES.length}](${EGG_SPOT_TYPES.map((t) => `vec3(${new THREE.Color(BLOCK_COLORS[t]).toArray().map((v) => v.toFixed(3)).join(', ')})`).join(', ')});
        // a rounded body's "out from the centre" direction: a merged body's smooth normal; a lone
        // block's direction from its centre with Rendering: Smooth, else (Blocky: no exceptions,
        // creatures and clouds too) its flat face normal
        #ifdef MERGED_BODY
        #define BODY_DIR normalize(vLocalNormal)
        #else
        #define BODY_DIR (ROUND_LOOK > 0.5 ? normalize(vLocalPos) : normalize(vLocalNormal))
        #endif`
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        #ifdef DISCARDS
        // 50 % screen-door transparency: drop every other pixel in a checkerboard
        if (vDither > 0.5 && mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0) < 1.0) discard;
        // Accessibility → View Internal (see-through level 2): 3/4 opaque (one pixel in each 2×2
        // square dropped), so its inventory shows inside; front faces only
        if (vSeeThrough > 1.5) {
          vec2 q = mod(floor(gl_FragCoord.xy), 2.0);
          if (q.x + q.y < 0.5) discard;
        }
        // the camera is inside it (level 1): 1/8 opaque (two staggered pixels in each 4×4 square),
        // so you see out; the material is then double-sided (World.setSeeThrough) so its inside
        // faces show, but only these blocks'
        else if (vSeeThrough > 0.5) {
          vec2 q = mod(floor(gl_FragCoord.xy), 4.0);
          if (!(q.x == q.y && mod(q.x, 2.0) < 0.5)) discard; // keeps (0, 0) and (2, 2)
        }
        #ifdef DOUBLE_SIDED
        if ((vSeeThrough < 0.5 || vSeeThrough > 1.5) && !gl_FrontFacing) discard;
        #endif
        #endif`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float surfaceRough = 0.0;
        float bumpH = 0.0;        // height (roughly 0..1 per few mm) for bump mapping
        float bumpStrength = 0.0; // 0 = no bump
        float isShell = 0.0;      // Crawly shell: its view-dependent colour is applied once the normal is known
        float isPearl = 0.0;      // Buzzy: the same shell, pearlescent instead of beetle-iridescent
        float shellPhase = 0.0;
        vec3 shellBase = vec3(0.0);
        vec3 crystalGlow = vec3(0.0); // Crystal inner glow / cloud light scattering, added as emission
        vec3 cloudNormal = vec3(0.0); // Fog / Nimbus: block-local "fluffy" normal, replaces the flat face normal
        // Fog / Nimbus: purely diffuse, no specular highlights or reflections (any Materials mode)
        float specDim = 1.0;     // scales specular light (highlights, reflections); matte styles lower it
        float isCloud = vStyle > ${(BLOCK_STYLE.fog - 0.5).toFixed(1)} && vStyle < ${(BLOCK_STYLE.nimbus + 0.5).toFixed(1)} ? 1.0 : 0.0;
        // Rendering: Smooth (or a block smoothed on its own): soft, rounded bodies (noOutline) skip
        // corner shading; Blocky: every block has it, creatures and clouds too
        #ifdef MERGED_BODY
        #define ROUND_LOOK 1.0
        #else
        #define ROUND_LOOK ((uSmoothRendering > 0.5 || vSmooth > 0.5) ? 1.0 : 0.0)
        #endif
        float noOutline = isCloud * ROUND_LOOK;
        vec3 facetTilt = vec3(0.0);   // Crystal: per-facet normal tilt (block-local), applied with the normal
        #if defined(SOLID_MATERIALS)
          // Options → Materials: Solid — flat instance colour only
          #ifdef TRANSLUCENT_PASS
          // each see-through type at its opacity (blocks.js); Crystal glossy, Fog / Nimbus matte
          ${TRANSLUCENT.map((t) => `if (abs(vStyle - ${t.style.toFixed(1)}) < 0.5) diffuseColor.a = ${t.opacity.toFixed(3)};`).join('\n          ')}
          surfaceRough = vStyle > ${(BLOCK_STYLE.fog - 0.5).toFixed(1)} ? 1.0 : vStyle > ${(BLOCK_STYLE.crystal - 0.5).toFixed(1)} ? 0.04 : 0.08;
          #endif
        #elif defined(TRANSLUCENT_PASS)
        if (vStyle > ${(BLOCK_STYLE.fog - 0.5).toFixed(1)}) {
          // Fog / Nimbus: fluffy, slowly churning cloud. Everything is 3D noise in block space,
          // detailed down to ~1 mm so a single 2 cm block still looks soft:
          //  - "billow" noise (sums of |Perlin|) gives rounded puffs at several sizes
          //  - the normal points out from the block centre (so the block shades like a soft
          //    ball, not flat faces) and is jostled by noise, so light breaks up into lumps
          //  - some of the cloud's own colour is added as glow (light scattering inside it),
          //    which flattens the contrast the way real cloud lighting does
          // Nimbus uses the same shader with its darker colour, plus a heavier, darker bottom.
          vec3 drift = vec3(uTime * 0.05, uTime * 0.02, -uTime * 0.035);
          vec3 q = vNoisePos + drift;
          float billow = perlinFbm(q * 1.1);
          float puffs = abs(perlin3(q * 2.4)) * 0.5 + abs(perlin3(q * 5.1 + 3.7)) * 0.3 + FINE(abs(perlin3(q * 10.7 + 8.1)) * 0.2);
          // puffy shape: the normal (out from the centre, a soft ball) is bent by 3D noise at two
          // sizes, so light breaks up into rounded puffs; Nimbus is lumpier still
          vec3 lump = vec3(perlin3(q * 2.1 + 1.3), perlin3(q * 2.1 + 6.1), perlin3(q * 2.1 + 12.9));
          vec3 lump2 = vec3(FINE(perlin3(q * 4.6 + 2.2)), FINE(perlin3(q * 4.6 + 8.4)), FINE(perlin3(q * 4.6 + 15.1)));
          float isNimbus = vStyle > ${(BLOCK_STYLE.nimbus - 0.5).toFixed(1)} ? 1.0 : 0.0;
          cloudNormal = normalize(BODY_DIR + mix(0.6, 0.9, isNimbus) * lump + mix(0.3, 0.4, isNimbus) * lump2
                                  + 0.25 * isNimbus * normalize(vLocalNormal));
          vec3 base = diffuseColor.rgb;
          vec3 col = base * (0.8 + 0.25 * billow + 0.3 * puffs);
          col *= 0.8 + 0.3 * smoothstep(0.1, 0.6, puffs);       // shadowed crevices between puffs
          if (vStyle > ${(BLOCK_STYLE.nimbus - 0.5).toFixed(1)}) col *= mix(0.72, 1.0, smoothstep(-1.0, 0.6, BODY_DIR.y)); // darker where it faces down (a merged body: its whole underside, not each block's)
          diffuseColor.rgb = col;
          // opacity: a slowly drifting 3D Perlin density field plus the puffs, around 85 %
          // opaque, so the cloud is wispy where the puffs thin out and denser in their cores
          // (edges facing away from the view fade further; see the normal section)
          float density = perlinFbm(vNoisePos * 0.9 + drift * 0.6 + vec3(11.3, 4.7, 7.9));
          diffuseColor.a = clamp(0.85 + 0.35 * density + 0.5 * (puffs - 0.25), 0.62, 1.0);
          surfaceRough = 1.0;
          crystalGlow = col * 0.22;
        } else if (vStyle > ${(BLOCK_STYLE.crystal - 0.5).toFixed(1)}) {
          // Crystal (magenta gem): Voronoi cells are internal facets. Each facet tilts the
          // normal its own way so highlights break up into glints; the colour runs from a pale
          // pink tint to a deep violet shade of the instance colour per facet, with a faint
          // cloudiness and bright lines where facets meet, plus a little inner glow. All tints
          // derive from the instance colour, so recolouring the block recolours the gem.
          vec2 vor = voronoi3(vNoisePos * 1.4);
          // Tilt each facet's normal its own way. Applied directly to the normal (see the
          // normal section), not as a bump, so facet borders are clean edges rather than
          // derivative spikes. The tilt is a smooth function of the cell value: the texture
          // blends that value across a border, which then reads as a narrow bevel, not noise.
          vec3 tilt = 0.35 * vec3(sin(vor.y * 19.0), sin(vor.y * 31.0 + 1.3), sin(vor.y * 43.0 + 2.1));
          vec3 fn = normalize(vLocalNormal);
          facetTilt = tilt - dot(tilt, fn) * fn; // keep the tilt within the face plane
          float cloud = perlinFbm(vNoisePos * 2.0);
          vec3 base = diffuseColor.rgb;
          vec3 pale = mix(base, vec3(1.0), 0.28) * 1.1;     // lighter, slightly whitened tint
          vec3 deep = base * vec3(0.62, 0.45, 0.8);         // deeper, cooler (violet-leaning) shade
          vec3 col = mix(pale, deep, clamp(vor.y * 0.75 + cloud * 0.45, 0.0, 1.0));
          float epw = length(fwidth(vNoisePos)) * 0.6 * 1.4; // pixel footprint in border-distance units
          col += (base * 0.25 + 0.06) * lineCoverage(vor.x, 0.02, epw); // bright facet edges, antialiased
          // surface wear, as a light normal map (bump): a fine grain, and scratches: three sets
          // of thin grooves in their own directions (a plane through the gem meets a
          // face in a straight line), broken into short random runs by noise; each scratch is
          // slightly frosted. Grooves thinner than a pixel fade out instead of shimmering.
          float grain = FINE(perlin3(vNoisePos * 38.0) * 0.6 + perlin3(vNoisePos * 83.0 + 5.1) * 0.4);
          float scratch = 0.0;
          #ifndef SIMPLE_MATERIALS
          for (int k = 0; k < 3; k++) {
            float fk = float(k);
            vec3 dir = normalize(cellHash(vec3(3.7 + fk * 11.3, fk * 5.9, 1.0)) - 0.5 + 1e-3); // (the same for every block: a cluster's scratches run on across it)
            float u = dot(vNoisePos, dir) * (1.7 + fk * 0.9) + perlin3(vNoisePos * 0.7 + fk * 3.3) * 0.6;
            float d = abs(fract(u) - 0.5);                       // distance to the groove, in its own units
            float fw = max(fwidth(u), 1e-4);
            float line = (1.0 - smoothstep(0.0, 0.012 + fw, d)) * clamp(0.02 / fw, 0.0, 1.0);
            float run = smoothstep(0.35, 0.6, perlin3(vNoisePos * vec3(1.3, 1.1, 1.2) + fk * 7.7)); // short, sparse runs
            scratch = max(scratch, line * run);
          }
          #endif
          bumpH = grain * 0.35 - scratch * 0.8;
          bumpStrength = 0.02;
          col += vec3(0.07) * scratch; // frosted scratches catch a little light
          diffuseColor.rgb = col;
          diffuseColor.a = mix(0.82, 0.94, vor.y);
          surfaceRough = mix(0.04, 0.35, scratch); // polished, rougher in the scratches
          crystalGlow = col * 0.12;
        } else {
          bumpH = waterHeight(vNoisePos, uTime);
          bumpStrength = 0.08;
          vec3 base = diffuseColor.rgb;
          float k = smoothstep(-0.8, 0.8, bumpH);
          // deep blue in the troughs, lighter cyan-blue on the swells, bright crests
          vec3 col = mix(base * vec3(0.35, 0.5, 0.7), base * vec3(1.15, 1.25, 1.1) + vec3(0.0, 0.03, 0.04), k);
          col += vec3(0.2, 0.3, 0.35) * smoothstep(0.7, 1.0, bumpH);
          diffuseColor.rgb = col;
          diffuseColor.a = mix(0.4, 0.65, k);
          surfaceRough = 0.08;
        }
        #else
        if (vStyle > 0.5 && vStyle < 1.5) {
          // Dirt
          vec3 p = vNoisePos;
          float clumps = perlinFbm(p * 2.2);                 // large damp/dry patches
          float grain = perlin3(p * 14.0) * 0.6 + perlin3(p * 31.0) * 0.4; // fine soil grain
          // grain, as in Wood and Moss: pores (dark flecks from thresholded fine noise),
          // speckle, and a noise roughness
          float pore = FINE(smoothstep(0.3, 0.75, perlin3(p * 70.0 + 5.3)));
          float speck = FINE(perlin3(p * 55.0 + 1.9));
          float rough = FINE(perlinFbm(p * 6.0 + 7.2));
          // brown over dark brown: blend the instance colour with a darker, warmer shade
          float t = smoothstep(-0.35, 0.35, clumps * 1.2 + grain * 0.35);
          vec3 base = diffuseColor.rgb;
          vec3 darkBrown = base * vec3(0.32, 0.26, 0.22);
          vec3 col = mix(darkBrown, base, t);
          col *= (1.0 - 0.35 * pore) * (1.0 + 0.15 * speck) * (1.0 + 0.2 * rough);
          diffuseColor.rgb = max(col, 0.0);
          // crumbly relief: clumps, soil grain and roughness, pores sunk in
          bumpH = clumps * 0.35 + grain * 0.35 + rough * 0.45 - pore * 0.3;
          bumpStrength = 0.06;
          surfaceRough = 1.0;
          specDim = 0.3; // matte, no sheen
        } else if (vStyle > 1.5 && vStyle < 2.5) {
          vec3 p = vNoisePos;
          // pixel footprint in cm: smooth (it comes from the interpolated position, not from
          // the texture), so the antialiasing below doesn't step from texel to texel
          float px = length(fwidth(p)) * 0.6;
          // Perlin domain warp so the Voronoi slab borders wander like real fractures
          vec3 warp = vec3(perlin3(p * 2.3), perlin3(p * 2.3 + 5.2), perlin3(p * 2.3 + 9.7));
          // second, higher-frequency warp octave adds small zig-zags along each fracture; it
          // fades out once its ~1 mm wiggles get close to pixel size, where they'd only alias
          vec3 jag = vec3(FINE(perlin3(p * 9.0 + 3.1)), FINE(perlin3(p * 9.0 + 7.4)), FINE(perlin3(p * 9.0 + 12.6)));
          float jagAmt = FINE(0.12 * (1.0 - smoothstep(0.02, 0.06, px)));
          vec2 vor = voronoi3(p * 1.7 + warp * 0.5 + jag * jagAmt);
          float cellShade = vor.y;                           // per-slab brightness
          float mottle = perlinFbm(p * 4.0);                 // mineral mottling inside slabs
          float speck = FINE(perlin3(p * 28.0));             // fine grain
          // grain, as in Wood and Moss: pores (dark flecks from thresholded fine noise), a finer
          // speckle, and a noise roughness
          float pore = FINE(smoothstep(0.35, 0.8, perlin3(p * 70.0 + 3.7)));
          float fleck = FINE(perlin3(p * 55.0 + 6.6));
          float rough = FINE(perlinFbm(p * 6.0 + 2.2));
          vec3 base = diffuseColor.rgb;
          vec3 col = base * (0.78 + 0.34 * cellShade);
          col *= vec3(1.0 + 0.04 * (cellShade - 0.5), 1.0, 1.0 - 0.04 * (cellShade - 0.5)); // slight warm/cool shift
          col *= 1.0 + 0.3 * mottle + 0.12 * speck;
          col *= (1.0 - 0.3 * pore) * (1.0 + 0.1 * fleck) * (1.0 + 0.15 * rough);
          // dark cracks along the cell borders: box-filtered over the pixel footprint (border
          // distance changes about 1.7x as fast as position), so edges stay smooth and cracks
          // thinner than a pixel fade instead of breaking up
          float pw = px * 1.7;
          float crack = lineCoverage(vor.x, 0.025, pw);
          float groove = 1.0 - smoothstep(0.0, 0.09 + pw, vor.x); // soft shading beside the crack
          col *= mix(1.0, 0.9, groove);
          col = mix(col, base * 0.6, crack);
          diffuseColor.rgb = max(col, 0.0);
          // relief: slabs raised, fractures sunk, a rough, pitted surface on each slab
          bumpH = (1.0 - groove) * 0.5 + rough * 0.45 + speck * 0.15 - pore * 0.3;
          bumpStrength = 0.06;
          surfaceRough = mix(0.88, 1.0, crack);
          specDim = 0.5; // dull, a little sheen left
        } else if (vStyle > 3.5 && vStyle < 4.5) {
          vec3 p = vNoisePos;
          // Voronoi cells = moss cushions, their borders slightly warped by Perlin noise
          vec3 warp = vec3(perlin3(p * 3.0 + 1.3), perlin3(p * 3.0 + 6.1), perlin3(p * 3.0 + 11.4));
          vec2 vor = voronoi3(p * 2.6 + warp * 0.3);
          float dome = smoothstep(0.0, 0.35, vor.x);         // rounded top, low at the cell borders
          // Perlin coverage: where moss grows vs. bare soil
          float cover = smoothstep(-0.2, 0.15, perlinFbm(p * 1.6) + 0.12);
          float fuzz = FINE(perlin3(p * 24.0) * 0.4 + perlin3(p * 48.0) * 0.35 + perlin3(p * 96.0) * 0.25); // fibrous strands
          // grain, as in Wood: pores (dark flecks from thresholded fine noise), speckle, and a
          // noise roughness that breaks up the cushion tops
          float pore = FINE(smoothstep(0.3, 0.75, perlin3(p * 70.0 + 2.9)));
          float speck = FINE(perlin3(p * 55.0 + 8.1));
          float rough = FINE(perlinFbm(p * 6.0 + 4.4));
          // green over dark brown: soil shows in bare patches, and only faintly in the thin
          // gaps between cushions
          float gap = 1.0 - smoothstep(0.0, 0.04, vor.x + fuzz * 0.02);
          float moss = cover * (1.0 - 0.45 * gap);
          vec3 base = diffuseColor.rgb;
          vec3 green = base * (0.55 + 0.6 * dome) * (1.0 + 0.4 * fuzz);
          green *= (1.0 - 0.35 * pore) * (1.0 + 0.12 * speck) * (1.0 + 0.2 * rough);
          green *= mix(vec3(1.0), vec3(1.3, 1.1, 0.55), vor.y * 0.6); // some cushions yellower
          vec3 soil = vec3(0.08, 0.035, 0.012) * (1.0 + 0.35 * perlin3(p * 18.0));
          diffuseColor.rgb = max(mix(soil, green, moss), 0.0);
          // fine, fuzzy relief on the cushions (strands and grain), none in bare soil
          bumpH = (dome * 0.6 + rough * 0.45 + fuzz * 0.3 - pore * 0.3) * moss;
          bumpStrength = 0.06;
          surfaceRough = 1.0;
          specDim = 0.3; // soft and velvety, barely any sheen

        } else if (vStyle > 4.5 && vStyle < 5.5) {
          // 3D strawberry flesh: green seeds scattered through the block's volume (one per cell
          // of a jittered 3D grid, ~2.8 per cm), each a small egg-shaped grain tilted its own
          // way, so wherever the surface cuts through one it shows as a green oval. Every seed
          // sits in a darker pit; seeds are bumped up and pits down; the red between is mottled,
          // wet and shiny.
          vec3 p = vNoisePos * 2.8;
          vec3 ip = floor(p);
          float r = 1e9;       // distance to the nearest seed, in its own stretched frame
          vec3 sh = vec3(0.0); // that seed's random values
          for (int z = -1; z <= 1; z++)
          for (int y = -1; y <= 1; y++)
          for (int x = -1; x <= 1; x++) {
            vec3 c = ip + vec3(float(x), float(y), float(z));
            vec3 h = cellHash(c + 3.1);
            vec3 d = p - (c + 0.2 + 0.6 * h);                     // from the jittered seed centre
            vec3 axis = normalize(cellHash(c + 9.7) - 0.5 + 1e-4);  // its long axis
            float along = dot(d, axis);
            vec3 perp = d - along * axis;
            // egg shape: longer along its axis, and a little fatter at one end
            float rr = sqrt(dot(perp, perp) * (1.0 + 0.8 * clamp(along * 6.0, 0.0, 1.0)) + along * along * 0.45);
            if (rr < r) { r = rr; sh = h; }
          }
          float seedR = 0.13;
          float afw = max(fwidth(r), 1e-4);
          float seed = 1.0 - smoothstep(seedR - afw, seedR + afw, r);
          float pit = (1.0 - smoothstep(seedR, 0.32, r)) * (1.0 - seed);
          vec3 base = diffuseColor.rgb;
          float mottle = perlin3(vNoisePos * 1.6 + 1.7) * 0.6 + FINE(perlin3(vNoisePos * 4.3 + 4.2) * 0.4);
          vec3 red = base * (0.92 + 0.28 * mottle);
          red *= mix(1.0, 0.55, pit);                                   // shadowed pit around each seed
          vec3 seedCol = mix(vec3(0.22, 0.46, 0.07), vec3(0.5, 0.66, 0.14), sh.z); // deep to yellowish green
          seedCol *= 0.85 + 0.3 * sh.x;
          diffuseColor.rgb = mix(red, seedCol, seed);
          // relief: seeds are little domes, pits dip around them
          bumpH = seed * sqrt(max(0.0, 1.0 - (r * r) / (seedR * seedR))) * 0.6 - pit * 0.9;
          bumpStrength = 0.05;
          surfaceRough = mix(0.14, 0.5, max(seed, pit * 0.5));           // glossy red, matte seeds
        } else if (abs(vStyle - ${BLOCK_STYLE.buzzy.toFixed(1)}) < 0.5) {
          // Buzzy: fuzzy, its dark green banded with wide yellow stripes that ring its body
          // (across its facing: the tint flag's FACING_CODE; none known: across its height).
          // The bands' edges are soft and broken up by the fur, so the yellow blends into the
          // green. Fur: dense fine fibres as noise, felt as a matte, bumpy nap with a soft
          // lighter fringe toward the body's silhouette
          cloudNormal = BODY_DIR;
          noOutline = ROUND_LOOK;
          int fc = FACING_CODE;
          vec3 fwd = fc >= 0 ? facingDir(fc) : vec3(0.0, 1.0, 0.0);
          vec3 p = vNoisePos;
          float fibre = FINE(perlin3(p * 34.0) * 0.55 + perlin3(p * 71.0 + 3.1) * 0.45); // the nap
          float tuft = perlin3(p * 16.0 + 2.3);                                           // little tufts…
          float clump = perlin3(p * 7.0 + 7.7);                                           // …in bigger clumps
          // along the body (cm from the block's centre), wobbled by the fur, in bands ~0.8 cm apart
          float along = dot(vLocalPos, fwd) + 0.16 * clump + 0.08 * tuft + 0.05 * fibre;
          float band = 0.5 + 0.5 * cos(along * 6.2831853 / 0.8 + vSeed * 3.0);
          float yellowAmt = smoothstep(0.22, 0.98, band);                                 // soft stripes, blending into the green (about as much green as yellow)
          vec3 green = diffuseColor.rgb;
          vec3 yellow = vec3(0.95, 0.76, 0.16);
          vec3 col = mix(green, yellow, yellowAmt);
          col = mix(col, mix(green, yellow, 0.5) * 0.95, 0.25 * (1.0 - abs(yellowAmt * 2.0 - 1.0))); // (a greenish-gold where they meet)
          col *= 0.68 + 0.42 * (0.5 + 0.5 * fibre) + 0.14 * tuft + 0.08 * clump;        // the fur's light and shade
          float fringe = pow(1.0 - abs(dot(normalize(vLocalNormal), BODY_DIR)), 2.0);
          col += 0.12 * fringe * mix(green, yellow, yellowAmt);                          // soft, lighter edge
          diffuseColor.rgb = col;
          bumpH = fibre * 0.6 + tuft * 0.35 + clump * 0.2;
          bumpStrength = 0.14;
          surfaceRough = 1.0;
          specDim = 0.25; // fur: hardly any sheen
        } else if ((vStyle > 5.5 && vStyle < 6.5) || abs(vStyle - ${BLOCK_STYLE.glowy.toFixed(1)}) < 0.5) {
          // Crawly and Glowy (Glowy = the pearlescent variant): with Rendering: Smooth, rounded
          // shading like a Squirmy (the normal points out from the block centre, no dark
          // corners). A Glowy also glows: its own light green, breathing slowly (the turn's
          // pulse of light is a sprite: engine.js, painPulses.js)
          isPearl = vStyle > 6.5 ? 1.0 : 0.0;
          if (abs(vStyle - ${BLOCK_STYLE.glowy.toFixed(1)}) < 0.5) crystalGlow = diffuseColor.rgb * (0.32 + 0.12 * sin(uTime * 2.2 + vSeed * 6.0));
          cloudNormal = BODY_DIR;
          noOutline = ROUND_LOOK;
          // 2D beetle shell in each face's plane: a smooth, glossy sheen whose colour drifts
          // in broad noise patches. Only the shading is set here; the iridescent hue depends
          // on the view angle and is added after the normal.
          vec3 n = normalize(vLocalNormal);
          vec3 tu = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 tv = cross(n, tu);
          vec2 uv = vec2(dot(vNoisePos, tu), dot(vNoisePos, tv));
          float patches = perlinFbm(vec3(uv * 1.2, 2.0));
          shellBase = diffuseColor.rgb;
          shellPhase = 0.4 * patches;
          diffuseColor.rgb = vec3(0.95 + 0.05 * patches); // very soft light/dark drift
          isShell = 1.0;
          surfaceRough = 0.18;
        } else if (vStyle > 6.5 && vStyle < 7.5) {
          // 3D wood: tight growth rings around vertical piths scattered through texture space (so
          // a trunk's or a slab's blocks share their rings), wobbled by
          // noise; coarse grain fibres and pores from noise stretched along the trunk (y); matte.
          // End faces show rings, side faces long grain under bark: a bump map of vertical
          // Voronoi plates split by faint cracks, mostly roughened with noise.
          vec3 q = vNoisePos;
          vec3 qs = q * vec3(1.3, 0.35, 1.3);
          vec2 wobble = vec2(perlin3(qs), perlin3(qs + 7.7));
          // the distance to the piths: one in each WOOD_PITH_CM square of texture space (xz), at a
          // random spot in it, so neighbouring blocks share their rings; a smooth minimum of the
          // nearby ones, so where two piths' rings meet they flow round each other (like grain
          // round a knot) instead of meeting in a crease
          vec2 g = (q.xz + wobble * 0.25) / WOOD_PITH_CM, gi = floor(g);
          float near = 0.0;
          for (int i = -1; i <= 1; i++) {
            for (int j = -1; j <= 1; j++) {
              vec2 c = gi + vec2(float(i), float(j));
              near += exp(-WOOD_BLEND * length(g - c - cellHash(vec3(c, 1.7)).xy));
            }
          }
          float pd = max(0.0, -log(near) / WOOD_BLEND);
          float r = pd * WOOD_PITH_CM * 7.0 + perlin3(q * 0.8) * 0.6;
          float ring = fract(r);
          float rfw = fwidth(r);
          // dark latewood band at the end of each ring; fades to average when rings get sub-pixel
          float late = smoothstep(0.55, 0.9, ring) * (1.0 - smoothstep(0.9, 1.0, ring));
          late = mix(late, 0.2, clamp(rfw * 2.0 - 0.5, 0.0, 1.0));
          // grain: long fibres at two scales, fine pores (dark flecks along the grain), speckle
          float fibre = perlin3(q * vec3(16.0, 1.0, 16.0)) * 0.5 + FINE(perlin3(q * vec3(40.0, 2.5, 40.0)) * 0.5);
          float pore = FINE(smoothstep(0.35, 0.75, perlin3(q * vec3(70.0, 5.0, 70.0))));
          float speck = FINE(perlin3(q * 55.0));
          // bark, on the sides (fades out on faces that point along the trunk)
          float side = smoothstep(0.35, 0.8, 1.0 - abs(normalize(vLocalNormal).y));
          vec3 bq = q * vec3(2.4, 0.7, 2.4) + vec3(perlin3(q * 1.7), 0.0, perlin3(q * 1.7 + 3.3)) * 0.35;
          vec2 plates = voronoi3(bq);                             // x: distance to a crack, y: plate id
          float crack = 1.0 - smoothstep(0.01, 0.06, plates.x);   // 1 in a crack (thin)
          float rough = FINE(perlinFbm(q * vec3(6.0, 2.0, 6.0)));
          vec3 base = diffuseColor.rgb;
          vec3 col = mix(base * 1.08, base * vec3(0.5, 0.4, 0.32), late * 0.85);
          col *= 1.0 + 0.32 * fibre;
          col *= 1.0 - 0.3 * pore;
          col *= 1.0 + 0.1 * speck;
          col *= 0.92 + 0.16 * (0.5 + 0.5 * perlin3(q * 0.25));   // tone, varying slowly across the wood
          vec3 bark = col * (0.97 + 0.06 * plates.y) * (1.0 + 0.2 * rough); // plates barely differ
          bark *= mix(1.0, 0.82, crack);                          // faint, slightly shadowed cracks
          col = mix(col, bark, side);
          diffuseColor.rgb = max(col, 0.0);
          // relief: plates raised, cracks sunk, a rough, fibrous surface on top
          bumpH = mix(fibre * 0.25 + pore * -0.3, (1.0 - crack) * 0.2 + rough * 0.45 + fibre * 0.2, side);
          bumpStrength = 0.06;
          surfaceRough = mix(0.86, 0.96, max(late, crack * 0.3));       // matte, dull in cracks and latewood
        } else if (vStyle > ${(BLOCK_STYLE.squirmy - 0.5).toFixed(1)} && vStyle < ${(BLOCK_STYLE.squirmy + 0.5).toFixed(1)}) {
          // Squirmy: wet, shiny, smooth flesh that wiggles. The normal points out from the
          // block centre (a rounded body, no flat faces) and wobbles with slowly drifting 3D
          // noise; ring-like folds ripple along it over time; thin dark veins and paler fatty
          // marbling make it read as meat; a little glow stands in for light under the skin.
          vec3 q = vNoisePos;
          float t = uTime;
          vec3 wig = vec3(perlin3(q * 1.3 + vec3(0.0, t * 0.6, 0.0)),
                          perlin3(q * 1.3 + vec3(5.2, t * 0.6, 1.7)),
                          perlin3(q * 1.3 + vec3(9.4, t * 0.6, 3.3)));
          cloudNormal = normalize(BODY_DIR + 0.45 * wig);
          float band = 0.5 + 0.5 * sin(dot(q, vec3(0.28, 0.93, 0.21)) * 6.0 - t * 3.0 + perlin3(q * 2.0) * 2.0);
          float vein = 1.0 - smoothstep(0.0, 0.08, abs(perlin3(q * 3.2 + wig * 0.3)));
          float marble = perlinFbm(q * 2.1);
          vec3 base = diffuseColor.rgb;
          vec3 col = base * (0.9 + 0.2 * marble) * mix(0.82, 1.08, band);
          col = mix(col, base * vec3(0.55, 0.2, 0.28), vein * 0.55);
          col = mix(col, vec3(1.0, 0.86, 0.86), smoothstep(0.35, 0.7, marble) * 0.25);
          diffuseColor.rgb = col;
          crystalGlow = col * 0.12;
          surfaceRough = 0.22;
          noOutline = ROUND_LOOK;
        } else if (vStyle > ${(BLOCK_STYLE.slither - 0.5).toFixed(1)} && vStyle < ${(BLOCK_STYLE.slither + 0.5).toFixed(1)}) {
          // Slither: a rounded body (the normal points out from the block centre) covered in
          // shiny green scales. The scales are cells of a 3D Voronoi pattern, stretched along
          // the body so they read as rows of overlapping plates: each one domed (raised in
          // the middle, sunk at its edges: the normal is tilted by the slope of that height),
          // darker in the gaps, paler and a little yellower toward its centre, each a slightly
          // different shade, with a faint iridescent sheen. Over it, soft-edged yellow splotches
          // (3D noise patches) blend into the green; the seams stay dark across them.
          vec3 n0 = BODY_DIR;
          vec3 t1 = normalize(cross(n0, abs(n0.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
          vec3 t2 = cross(n0, t1);
          vec3 sp = vNoisePos * vec3(3.4, 2.4, 3.4);  // scale cells, ~3 mm across (in texture space: they run on across the segments)
          float e = 0.03;
          vec2 s0 = voronoi3(sp);
          float h0 = smoothstep(0.0, 0.32, s0.x);
          #ifdef SIMPLE_MATERIALS
          float h1 = h0, h2 = h0; // Simple: the scales aren't domed (no extra lookups for their slope)
          #else
          float h1 = smoothstep(0.0, 0.32, voronoi3(sp + t1 * e).x);
          float h2 = smoothstep(0.0, 0.32, voronoi3(sp + t2 * e).x);
          #endif
          cloudNormal = normalize(n0 - 0.55 * ((h1 - h0) * t1 + (h2 - h0) * t2) / e * 0.1);
          float gap = 1.0 - smoothstep(0.0, 0.07, s0.x);   // 1 in the seams between scales
          vec3 base = diffuseColor.rgb;
          vec3 col = base * (0.86 + 0.28 * s0.y);          // each scale its own shade
          col = mix(col, base * vec3(1.15, 1.25, 0.8) + vec3(0.04, 0.05, 0.0), h0 * 0.45); // paler centres
          // yellow splotches: broad noise patches with soft, blended edges (each scale keeps its shade)
          float splotch = smoothstep(0.08, 0.38, perlinFbm(vNoisePos * 0.9 + vec3(7.3, 1.9, 4.1)));
          vec3 yellow = vec3(0.86, 0.74, 0.16) * (0.86 + 0.28 * s0.y) * mix(0.9, 1.1, h0);
          col = mix(col, yellow, splotch * 0.85);
          col = mix(col, base * vec3(0.18, 0.3, 0.2), gap * 0.8);                            // dark seams
          float sheen = 0.5 + 0.5 * sin(dot(vNoisePos, vec3(2.1, 3.3, 1.7)) + s0.y * 6.2831);
          col += vec3(0.02, 0.06, 0.07) * sheen * h0;      // a faint teal-gold iridescence
          diffuseColor.rgb = col;
          surfaceRough = mix(0.12, 0.6, gap);              // glossy scales, dull seams
          noOutline = ROUND_LOOK;
        } else if (abs(vStyle - ${BLOCK_STYLE.egg.toFixed(1)}) < 0.5) {
          // Egg: a smooth, faintly mottled white shell with blotchy spots (and fine freckles) in
          // the colour of the creature inside (its tint flag: EGG_SPOTS), else speckled brown
          vec3 p = vNoisePos;
          float blot = perlin3(p * 1.5 + vSeed) * 0.75 + perlin3(p * 3.4 + vSeed * 1.7) * 0.25; // (broad: a few big spots to each face)
          float spot = smoothstep(0.1, 0.17, blot);
          float freckle = FINE(smoothstep(0.55, 0.68, perlin3(p * 9.0 + 2.3)));
          int si = TINT_FLAG;
          vec3 spotCol = si > 0 && si <= ${EGG_SPOT_TYPES.length} ? EGG_SPOTS[si - 1] : vec3(0.42, 0.32, 0.22);
          vec3 shellCol = diffuseColor.rgb * (0.94 + 0.06 * perlin3(p * 2.7 + 5.1));
          diffuseColor.rgb = mix(shellCol, spotCol, max(spot, freckle * 0.55));
          crystalGlow = shellCol * 0.18 * (1.0 - max(spot, freckle * 0.55)); // (a chalky white that stays white in dim light)
          bumpH = spot * 0.15 - freckle * 0.1;
          bumpStrength = 0.02;
          surfaceRough = 0.4;  // a soft eggshell sheen
          specDim = 0.6;
          cloudNormal = BODY_DIR; // rounded, like a creature
          noOutline = ROUND_LOOK;
        } else if (abs(vStyle - ${BLOCK_STYLE.leaves.toFixed(1)}) < 0.5) {
          // Leaves: a mass of overlapping leaves. Each warped Voronoi cell is a leaf, lighter
          // toward its middle, its own shade of light green (some yellower), with fine veins
          // running its own way, dark shadowed gaps between the leaves, and a waxy sheen
          vec3 p = vNoisePos;
          vec3 warp = vec3(perlin3(p * 2.5 + 3.1), perlin3(p * 2.5 + 8.7), perlin3(p * 2.5 + 15.2));
          vec2 vor = voronoi3(p * 3.4 + warp * 0.35);
          float leaf = smoothstep(0.0, 0.32, vor.x);                    // its middle raised
          float gap = 1.0 - smoothstep(0.0, 0.06, vor.x);               // shadow between leaves
          float ang = vor.y * 6.2831853;
          vec3 dir = normalize(vec3(cos(ang), sin(ang * 1.7) * 0.6, sin(ang)));
          float vein = FINE(1.0 - smoothstep(0.0, 0.18, abs(sin(dot(p, dir) * 38.0))));
          float speck = FINE(perlin3(p * 40.0 + 5.3));
          vec3 base = diffuseColor.rgb;
          vec3 col = base * (0.62 + 0.5 * leaf) * mix(vec3(1.0), vec3(1.15, 1.12, 0.7), vor.y * 0.7);
          col *= 1.0 + 0.08 * speck;
          col = mix(col, col * vec3(1.18, 1.15, 0.85), 0.5 * vein * leaf);   // paler veins
          col = mix(col, vec3(0.03, 0.08, 0.02), 0.85 * gap);
          diffuseColor.rgb = max(col, 0.0);
          bumpH = leaf * 0.7 + vein * 0.12 + speck * 0.08;
          bumpStrength = 0.07;
          surfaceRough = 0.62;
          specDim = 0.7; // waxy
        } else if (abs(vStyle - ${BLOCK_STYLE.glop.toFixed(1)}) < 0.5 || abs(vStyle - ${BLOCK_STYLE.slop.toFixed(1)}) < 0.5 || abs(vStyle - ${BLOCK_STYLE.plop.toFixed(1)}) < 0.5) {
          // Glop (fauna waste, carrion), Slop (flora waste, compost) and Plop (dung): wet and
          // lumpy. Warped Voronoi lumps, domed and packed close, a dark wet film pooled in the
          // creases and a glossy sheen on top. Glop is raw red, marbled with pink and studded
          // with whitish chunks (fat, gristle); Plop runs from its brown into a dark, liverish
          // brown; Slop is mottled compost, its olive green, brown and gray in patches, with pale
          // fibres of half-rotted plant
          vec3 p = vNoisePos;
          float isSlop = abs(vStyle - ${BLOCK_STYLE.slop.toFixed(1)}) < 0.5 ? 1.0 : 0.0;
          float isGlop = abs(vStyle - ${BLOCK_STYLE.glop.toFixed(1)}) < 0.5 ? 1.0 : 0.0;
          float chunk = 0.0; // Glop's whitish chunks, raised a little
          vec3 warp = vec3(perlin3(p * 2.1 + 3.3), perlin3(p * 2.1 + 8.6), perlin3(p * 2.1 + 14.2));
          vec2 vor = voronoi3(p * 2.3 + warp * 0.55);
          float lump = smoothstep(0.0, 0.42, vor.x);          // domed lumps, low in the creases
          vec2 vor2 = voronoi3(p * 5.2 + warp * 0.8 + 4.1);
          float lump2 = FINE(smoothstep(0.0, 0.3, vor2.x));   // smaller lumps on the big ones
          float crease = 1.0 - smoothstep(0.0, 0.12, vor.x);  // the wet creases between lumps
          float mottle = perlinFbm(p * 1.8);
          float grain = FINE(perlin3(p * 40.0 + 2.7) * 0.6 + perlin3(p * 85.0 + 6.1) * 0.4);
          vec3 base = diffuseColor.rgb;
          vec3 col;
          if (isSlop > 0.5) {
            vec3 brown = vec3(0.30, 0.20, 0.11);
            vec3 gray = vec3(0.36, 0.36, 0.33);
            float tb = smoothstep(-0.25, 0.25, mottle + 0.3 * (vor.y - 0.5));
            float tg = smoothstep(0.15, 0.55, perlinFbm(p * 2.6 + 9.4));
            col = mix(mix(brown, base, tb), gray, tg * 0.7);
            float fibre = FINE(smoothstep(0.82, 0.95, abs(perlin3(p * vec3(9.0, 2.2, 9.0) + 1.7)) * 1.9));
            col = mix(col, vec3(0.62, 0.58, 0.42), fibre * 0.5);
          } else if (isGlop > 0.5) {
            vec3 deep = base * vec3(0.42, 0.2, 0.22);           // dark, clotted red
            col = mix(deep, base * 1.15, smoothstep(-0.3, 0.35, mottle + 0.4 * (vor.y - 0.5)));
            // pink marbling: thin, wandering veins where a warped noise crosses zero
            float vein = 1.0 - smoothstep(0.0, 0.09, abs(perlin3(p * 2.6 + warp * 1.4 + 6.2)));
            col = mix(col, vec3(0.93, 0.52, 0.6), vein * 0.75);
            col = mix(col, vec3(0.9, 0.45, 0.52), smoothstep(0.7, 1.0, lump) * 0.3); // pinker on the lump tops
            // whitish chunks: some of the small lumps, picked by their cell value, pale and creamy
            chunk = smoothstep(0.8, 0.86, vor2.y) * smoothstep(0.02, 0.12, vor2.x);
            col = mix(col, vec3(0.9, 0.85, 0.78) * (0.85 + 0.25 * vor2.x), chunk);
          } else {
            vec3 liver = base * vec3(0.42, 0.3, 0.24);          // Plop: dark brown in the hollows
            col = mix(liver, base * 1.12, smoothstep(-0.3, 0.35, mottle + 0.4 * (vor.y - 0.5)));
            col = mix(col, base * vec3(1.12, 0.98, 0.78), smoothstep(0.75, 1.0, lump) * 0.2); // warmer tops
          }
          col *= 0.62 + 0.38 * lump + 0.1 * lump2;           // shadowed creases
          col *= 1.0 + 0.1 * grain;
          col = mix(col, col * 0.55, crease * 0.6 * (1.0 - chunk)); // dark wet film in the creases
          diffuseColor.rgb = max(col, 0.0);
          bumpH = lump * 0.6 + lump2 * 0.2 + chunk * 0.25;                   // (no fine grain in the relief: on a glossy surface it glitters)
          bumpStrength = 0.05;
          surfaceRough = mix(0.42, 0.3, crease) + 0.15 * (1.0 - isGlop - isSlop); // wet: a soft gloss, wettest in the creases (Plop: drier)
          specDim = 0.75;
        }
        #endif
        if (vSmooth > 0.5) noOutline = 1.0; // smooth-shaded blocks: a rounded look, no dark corners
        // (rounded clouds skip it too: dark corners make them look like tiles)
        diffuseColor.rgb *= 1.0 - uAO * ${AO_STRENGTH.toFixed(3)} * vAO * (1.0 - noOutline); // corners hemmed in by neighbours go darker`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        if (surfaceRough > 0.0) roughnessFactor = surfaceRough;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        // smooth-shaded blocks (World.setSmooth): the normal points out from the block centre;
        // bumps and the style's own normal (clouds, creatures) still go on top
        if (vSmooth > 0.5) normal = normalize(vLocalToView * normalize(vLocalPos));
        #ifndef SOLID_MATERIALS
        #ifndef SIMPLE_MATERIALS
        {
          // bump the normal by the surface height; scale converts the cm-space height
          // gradient to view units so the bumps look the same at any world scale.
          // Evaluated for every style (bumpStrength 0 = unchanged) to keep derivatives uniform.
          float cmToView = (length(dFdx(vViewPosition)) + length(dFdy(vViewPosition)))
                         / max(length(dFdx(vNoisePos)) + length(dFdy(vNoisePos)), 1e-6);
          normal = heightBump(-vViewPosition, normal, bumpH, bumpStrength * cmToView);
        }
        #endif
        // Crystal facets: tilt the normal directly (block-local tilt -> view space)
        if (dot(facetTilt, facetTilt) > 0.0) normal = normalize(normal + vLocalToView * facetTilt);
        // Fog / Nimbus: replace the flat face normal with the fluffy one (block-local -> view)
        if (dot(cloudNormal, cloudNormal) > 0.0) normal = normalize(vLocalToView * cloudNormal);
        #ifdef TRANSLUCENT_PASS
        // clouds: soft edges, thinning where the surface turns away from the view
        if (isCloud > 0.5) diffuseColor.a *= mix(0.75, 1.0, sqrt(clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0)));
        #endif
        if (isShell > 0.5) {
          // thin-film-like iridescence: the hue cycles as the viewing angle changes,
          // biased toward beetle greens, blues and violets plus the instance colour
          float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
          float ph = 1.4 * (1.0 - ndv) + shellPhase;
          vec3 irid = 0.5 + 0.5 * cos(6.2831853 * (ph + vec3(0.0, 0.33, 0.67)));
          irid *= vec3(0.55, 1.0, 1.05);
          vec3 shell = mix(shellBase * 0.5, irid, 0.75) * 0.7;
          // Buzzy: pearlescent — its own colour, with a soft pastel play of colour and a milky
          // sheen that grow toward the glancing edges (like mother-of-pearl)
          float rim = 1.0 - ndv;
          vec3 pearl = shellBase * 1.1 + (irid * 0.35 + 0.1) * rim + vec3(0.55, 0.6, 0.58) * pow(rim, 2.5);
          shell = mix(shell, pearl, isPearl);
          diffuseColor.rgb *= shell; // keeps the soft shading
          metalnessFactor = mix(0.35, 0.15, isPearl); // tints highlights with the shell colour (pearl: softer)
          // a buff with a colour (e.g. Rockbiter gold) leaves the shell as it is and adds a layer
          // of glowing ripples in that colour: bands that travel up over the body, warped by
          // noise, sharpened into thin crests, the whole glow pulsing brighter and dimmer
        }
        {
          // a buff with a colour (Rockbiter gold, Fertile pink) on any creature: its shell stays
          // as it is, under a layer of glowing ripples in that colour, bands that travel up over
          // the body, warped by noise, sharpened into thin crests, the whole glow pulsing
          int ti = TINT_FLAG;
          bool creatureStyle = ${BLOCK_TYPES.filter((t) => t.creature).map((t) => `abs(vStyle - ${t.style.toFixed(1)}) < 0.5`).join(' || ')};
          if (creatureStyle && ti > 0 && ti <= ${TINT_BUFFS.length}) {
            // (in the build's own space, not each block's: one pattern runs on across the body's blocks)
            float wave = vLatPos.y * 4.5 + perlin3(vLatPos * 1.4 + vec3(0.0, uTime * 0.3, 0.0)) * 2.2;
            float crest = pow(0.5 + 0.5 * sin(wave - uTime * 5.0), 6.0);
            float pulse = 0.55 + 0.45 * sin(uTime * 3.2);
            crystalGlow += BUFF_GLOWS[ti - 1] * (0.12 + 1.1 * crest) * pulse;
          }
        }
        #endif
        #ifdef TRANSLUCENT_PASS
        {
          // Fresnel: grazing angles reflect more and look less see-through (not for clouds)
          float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
          diffuseColor.a = mix(diffuseColor.a, max(diffuseColor.a, 0.9), fres * (1.0 - isCloud)); // never less opaque at the rim
        }
        #endif`
      )
      .replace(
        '#include <aomap_fragment>',
        `#include <aomap_fragment>
        if (isCloud > 0.5) {
          // clouds don't reflect: drop all specular light (highlights and environment)
          reflectedLight.directSpecular = vec3(0.0);
          reflectedLight.indirectSpecular = vec3(0.0);
        }
        reflectedLight.directSpecular *= specDim; // matte styles (Moss) dim their highlights…
        reflectedLight.indirectSpecular *= specDim; // …and reflections`
      )
      .replace(
        '#include <transmission_fragment>',
        // refractive Water, and scattering clouds: how much of the scene behind shows through
        // follows the shader's opacity (Water: clear in the troughs, less so on the crests and at
        // grazing angles; a cloud: its thin parts)
        translucentPass && !crystalPass
          ? THREE.ShaderChunk.transmission_fragment.replace(
            'material.transmission = transmission;',
            // (a cloud lets through more than its blended look would: blurred, a little is lost)
            cloudPass ? `material.transmission = transmission * clamp((1.0 - diffuseColor.a) * ${CLOUD_SCATTER_GAIN.toFixed(2)}, 0.0, 0.85);
          material.roughness = ${CLOUD_BLUR_ROUGHNESS.toFixed(3)}; // (how blurred: the cloud's own surface roughness, for its shading, is far rougher)`
              : 'material.transmission = transmission * clamp(1.0 - diffuseColor.a, 0.0, 1.0);',
          )
          : '#include <transmission_fragment>',
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += crystalGlow; // Crystal's inner glow (zero for everything else)`
      );
  };
  mat.customProgramCacheKey = () =>
    `${translucentPass ? (cloudPass ? 'grid-block-cloud' : crystalPass ? 'grid-block-crystal' : 'grid-block-translucent') : 'grid-block-opaque'}${mergedBody ? '-body' : ''}${seeThrough ? `-see${seeThrough}` : ''}${mat.userData.discards ? '-discards' : ''}-${options.level}`;
}
