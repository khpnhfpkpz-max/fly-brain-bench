/* NEURAL GOD -- procedural textures and environment.

   Everything here is generated at boot, so the scene costs zero extra
   download. That is a deliberate trade: generated noise will never look as
   photographic as a scanned material, but this page already carries ~8 MB of
   connectome and the scene is mostly in shadow. */
import * as THREE from '../../vendor/three/three.module.min.js';

/* Periodic value noise: the lattice wraps at `period`, so every map tiles. */
function hash2(x, y, period, seed) {
  x = ((x % period) + period) % period;
  y = ((y % period) + period) % period;
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const fade = t => t * t * (3 - 2 * t);

function valueNoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = fade(xf), v = fade(yf);
  const a = hash2(xi, yi, period, seed), b = hash2(xi + 1, yi, period, seed);
  const c = hash2(xi, yi + 1, period, seed), d = hash2(xi + 1, yi + 1, period, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x, y, octaves, baseFreq, period, seed) {
  let sum = 0, amp = 1, norm = 0, freq = baseFreq, per = period;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, per, seed + o * 17) * amp;
    norm += amp;
    amp *= 0.5; freq *= 2; per *= 2;
  }
  return sum / norm;
}

/* Height field -> tangent-space normal map, by central differences. */
function normalMapFromHeight(size, height, strength) {
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;        // the ground is seen at grazing angles almost everywhere
  tex.needsUpdate = true;
  return tex;
}

/* Long, low swells crossed with finer chop -- what a shallow pond does. */
export function makeRippleNormal(size = 256) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const swell = Math.sin((u * 3 + v * 1.4) * Math.PI * 2) * 0.5 + 0.5;
      const chop = fbm(u * size, v * size, 3, 0.06, Math.round(size * 0.06), 7);
      h[y * size + x] = swell * 0.35 + chop * 0.65;
    }
  }
  return normalMapFromHeight(size, h, 2.2);
}

/* Coarse pitting for wet rock and the pond floor. */
export function makeGrainNormal(size = 256) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = fbm(x, y, 4, 0.05, Math.round(size * 0.05), 23);
    }
  }
  return normalMapFromHeight(size, h, 3.4);
}

export function makeRoughnessMap(size = 256) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // kept high: this multiplies the material's roughness, and a wet shore
      // that dips much below ~0.75 turns into a sheet of specular glare
      const n = fbm(x, y, 4, 0.04, Math.round(size * 0.04), 91);
      const v = Math.round(192 + n * 63);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/* Soft radial falloff, for the moon halo, the food glow and background bokeh. */
export function makeGlowSprite(size = 128, inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* A tiny scene prefiltered into an environment map: it is what puts a moving
   highlight on the fly's shell and a sky term on the water. PMREMGenerator is
   part of the Three core, so this needs no addon. */
export function buildEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const disposables = [];

  const shell = new THREE.SphereGeometry(12, 16, 12);
  const shellMat = new THREE.MeshBasicMaterial({ color: 0x0a1a22, side: THREE.BackSide });
  envScene.add(new THREE.Mesh(shell, shellMat));
  disposables.push(shell, shellMat);

  const add = (w, h, color, pos) => {
    const geo = new THREE.PlaneGeometry(w, h);
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(...pos);
    mesh.lookAt(0, 0, 0);
    envScene.add(mesh);
    disposables.push(geo, mat);
  };

  add(7, 7, 0xffd8a6, [-5, 4.5, -9]);     // the moon, warm
  add(9, 5, 0x123a4a, [6, 2, -8]);        // cool bounce from the far bank
  add(14, 3, 0x0d2530, [0, -3, 0]);       // dim ground bounce
  add(4, 4, 0x2a6f86, [8, 5, 4]);         // rim fill

  const rt = pmrem.fromScene(envScene, 0.05);
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  return rt.texture;
}
