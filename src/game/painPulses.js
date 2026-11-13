// Pain pulses (needs.js): a soft, blurry glow that swells out of a critter and fades: orange for
// a hunger pang, yellow for a thirst pang, red for hurt (a bite, or a pang with nothing left to
// take). Each follows its block while it slides, and stays where it was if the block is gone.
import * as THREE from 'three';

/** Pulse colours by kind. */
export const PULSE_COLORS = { hunger: '#ff9440', thirst: '#ffd94a', hurt: '#ff2a2a', glow: '#c4ff9e' }; // (glow: a Glowy's light, every turn)
/** How long a pulse lasts (ms), and how wide it grows (cm across: a block is 2 cm). */
const PULSE_MS = 900;
const PULSE_FROM_CM = 2.2;
const PULSE_TO_CM = 5.5;
/** Drawn this far (cm) from the critter's centre toward the camera, so its own body doesn't hide the glow. */
const TOWARD_CAMERA_CM = 1.6;
const _cam = new THREE.Vector3();
/** Peak opacity: soft, not a flash. */
const PULSE_OPACITY = 0.8;

/** A blurry round dot: a radial gradient, white in the middle fading to nothing (tinted per pulse). */
function dotTexture() {
  const size = 64, c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class PainPulses {
  /** `parent`: the world's root (cm units, like the blocks). */
  constructor(parent) {
    this.parent = parent;
    this.texture = dotTexture();
    this.pulses = [];
  }

  /** Starts a pulse of `kind` (PULSE_COLORS) on creature block `block`, at scene time `now` (ms). */
  spawn(world, block, kind, now) {
    const material = new THREE.SpriteMaterial({
      map: this.texture, color: PULSE_COLORS[kind] ?? PULSE_COLORS.hurt, transparent: true, opacity: 0,
      depthWrite: false, // (normal blending: the glow keeps its own colour over any block)
    });
    const sprite = new THREE.Sprite(material);
    sprite.name = 'pain-pulse';
    sprite.renderOrder = 3; // (after the see-through passes)
    sprite.raycast = () => { };
    world.renderedPosition(block, now, sprite.position);
    this.parent.add(sprite);
    this.pulses.push({ sprite, block, t0: now });
  }

  /** Grows, fades and moves the pulses to scene time `now` (ms), in front of the critter as seen from `camera`; call once per frame. */
  update(world, now, camera) {
    if (!this.pulses.length) return;
    if (camera) this.parent.worldToLocal(camera.getWorldPosition(_cam));
    this.pulses = this.pulses.filter((p) => {
      const t = (now - p.t0) / PULSE_MS;
      if (t >= 1 || t < 0) {
        this.parent.remove(p.sprite);
        p.sprite.material.dispose();
        return false;
      }
      if (world.get(p.block.x, p.block.y, p.block.z) === p.block) world.renderedPosition(p.block, now, p.at ??= new THREE.Vector3());
      p.at ??= p.sprite.position.clone();
      p.sprite.position.copy(p.at);
      if (camera) p.sprite.position.addScaledVector(_cam.clone().sub(p.at).normalize(), TOWARD_CAMERA_CM);
      const ease = 1 - (1 - t) * (1 - t); // fast out, slowing
      p.sprite.scale.setScalar(PULSE_FROM_CM + (PULSE_TO_CM - PULSE_FROM_CM) * ease);
      p.sprite.material.opacity = PULSE_OPACITY * (t < 0.2 ? t / 0.2 : ((1 - t) / 0.8) ** 1.5); // swells in quickly, then fades slowly
      return true;
    });
  }

  clear() {
    for (const p of this.pulses) {
      this.parent.remove(p.sprite);
      p.sprite.material.dispose();
    }
    this.pulses = [];
  }
}
