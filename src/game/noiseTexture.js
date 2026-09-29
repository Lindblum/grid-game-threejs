// Pre-baked, tileable 3D noise so the block shaders sample a texture instead of
// evaluating Perlin / Voronoi per pixel (much cheaper on mobile GPUs such as the Quest).
//   R = Perlin noise, period PERLIN_PERIOD lattice cells per texture repeat, stored n*0.5+0.5
//   G = Voronoi distance to the nearest cell border (period VORONOI_PERIOD cells, / VORONOI_BORDER_MAX),
//       high byte; A = its low byte. 16-bit precision keeps thin cracks smooth, and since
//       value = G + A / 255 is linear, texture filtering and mipmaps still combine it correctly.
//   B = Voronoi random value of the nearest cell
// The shader side (perlin3 / voronoi3 in geometry.js) undoes these encodings.
import * as THREE from 'three';

export const NOISE_SIZE = 64;
export const PERLIN_PERIOD = 8;
export const VORONOI_PERIOD = 4;
export const VORONOI_BORDER_MAX = 0.8;

/** Small seeded PRNG (mulberry32) so the texture is the same every run. */
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wrap = (i, n) => ((i % n) + n) % n;

function makePerlin(period, seed) {
  const rand = rng(seed);
  const g = new Float32Array(period ** 3 * 3);
  for (let i = 0; i < g.length; i += 3) {
    // random unit vector
    const z = rand() * 2 - 1, a = rand() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    g[i] = r * Math.cos(a);
    g[i + 1] = r * Math.sin(a);
    g[i + 2] = z;
  }
  const corner = (i, j, k, fx, fy, fz) => {
    const o = (wrap(i, period) + period * (wrap(j, period) + period * wrap(k, period))) * 3;
    return g[o] * fx + g[o + 1] * fy + g[o + 2] * fz;
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  return (x, y, z) => {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    const fx = x - i, fy = y - j, fz = z - k;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    return lerp(
      lerp(lerp(corner(i, j, k, fx, fy, fz), corner(i + 1, j, k, fx - 1, fy, fz), u),
        lerp(corner(i, j + 1, k, fx, fy - 1, fz), corner(i + 1, j + 1, k, fx - 1, fy - 1, fz), u), v),
      lerp(lerp(corner(i, j, k + 1, fx, fy, fz - 1), corner(i + 1, j, k + 1, fx - 1, fy, fz - 1), u),
        lerp(corner(i, j + 1, k + 1, fx, fy - 1, fz - 1), corner(i + 1, j + 1, k + 1, fx - 1, fy - 1, fz - 1), u), v),
      w
    );
  };
}

/** Returns (x, y, z) => [border distance, cell random value], tileable with `period`. */
function makeVoronoi(period, seed) {
  const rand = rng(seed);
  const pts = new Float32Array(period ** 3 * 4); // feature point xyz + cell value
  for (let i = 0; i < pts.length; i++) pts[i] = rand();
  return (x, y, z) => {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    const fx = x - i, fy = y - j, fz = z - k;
    let d1 = Infinity, d2 = Infinity, id = 0;
    let r1x = 0, r1y = 0, r1z = 0, r2x = 0, r2y = 0, r2z = 0;
    for (let c = -1; c <= 1; c++) for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
      const o = (wrap(i + a, period) + period * (wrap(j + b, period) + period * wrap(k + c, period))) * 4;
      const rx = a + pts[o] - fx, ry = b + pts[o + 1] - fy, rz = c + pts[o + 2] - fz;
      const d = rx * rx + ry * ry + rz * rz;
      if (d < d1) {
        d2 = d1; r2x = r1x; r2y = r1y; r2z = r1z;
        d1 = d; r1x = rx; r1y = ry; r1z = rz; id = pts[o + 3];
      } else if (d < d2) {
        d2 = d; r2x = rx; r2y = ry; r2z = rz;
      }
    }
    // exact distance to the bisector plane between the two nearest points
    const len = Math.max(Math.hypot(r2x - r1x, r2y - r1y, r2z - r1z), 1e-4);
    return [(d2 - d1) / (2 * len), id];
  };
}

export function createNoiseTexture() {
  const N = NOISE_SIZE;
  const perlin = makePerlin(PERLIN_PERIOD, 1337);
  const voronoi = makeVoronoi(VORONOI_PERIOD, 4242);
  const data = new Uint8Array(N * N * N * 4);
  const toByte = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  let o = 0;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // texel centres, in lattice units of each noise
    const tx = (x + 0.5) / N, ty = (y + 0.5) / N, tz = (z + 0.5) / N;
    const n = perlin(tx * PERLIN_PERIOD, ty * PERLIN_PERIOD, tz * PERLIN_PERIOD);
    const [border, id] = voronoi(tx * VORONOI_PERIOD, ty * VORONOI_PERIOD, tz * VORONOI_PERIOD);
    // border as 16 bits: hi + lo / 255 (in byte units) = v * 255
    const v = Math.max(0, Math.min(1, border / VORONOI_BORDER_MAX)) * 255;
    const hi = Math.min(255, Math.floor(v));
    data[o++] = toByte(n * 0.5 + 0.5);
    data[o++] = hi;
    data[o++] = toByte(id);
    data[o++] = Math.round((v - hi) * 255);
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter; // mipmaps = automatic detail falloff at distance
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
