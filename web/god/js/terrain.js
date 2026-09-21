/* NEURAL GOD -- the pond: floor, shallow water, rocks, grass and backdrop.

   All geometry is procedural. The water is a custom shader rather than the
   stock Reflector because it needs the ripple distortion and the fresnel blend
   that sell a shallow pond; the planar reflection it samples is rendered by
   world-view.js into a quarter-resolution target.

   Honest limits: no refraction, no caustics, no screen-space reflection. What
   is here is a mirror plane, animated normals and a tight specular streak. */
import * as THREE from '../../vendor/three/three.module.min.js';
import { makeRippleNormal, makeGrainNormal, makeRoughnessMap, makeGlowSprite } from './env.js';

/* Where the key light comes from. The moon mesh and the directional light
   share this so the specular streak on the water lines up with the disc. */
export const MOON_POS = new THREE.Vector3(-13, 8.5, -24);
export const WATER_LAYER = 1;

function mulberry(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeRockGeometry(seed, detail = 2) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const rnd = mulberry(seed);
  const lobes = [];
  for (let i = 0; i < 7; i++) {
    lobes.push({
      dir: new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize(),
      amp: 0.16 + rnd() * 0.30,
      sharp: 1.5 + rnd() * 3,
    });
  }
  const pos = geo.attributes.position;
  const v = new THREE.Vector3(), dir = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    dir.copy(v).normalize();
    let r = 1;
    for (const l of lobes) r += Math.pow(Math.max(0, dir.dot(l.dir)), l.sharp) * l.amp;
    r -= 0.14 * Math.abs(dir.y);
    v.copy(dir).multiplyScalar(r);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

const WATER_VS = `
uniform mat4 uTextureMatrix;
varying vec4 vReflectUv;
varying vec3 vWorld;
varying vec2 vRipple;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vRipple = wp.xz;
  vReflectUv = uTextureMatrix * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const WATER_FS = `
precision highp float;
uniform sampler2D uReflect;
uniform sampler2D uRipple;
uniform float uTime;
uniform float uReflectStrength;
uniform float uHasReflect;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
varying vec4 vReflectUv;
varying vec3 vWorld;
varying vec2 vRipple;

void main() {
  vec2 uv1 = vRipple * 0.055 + vec2(uTime * 0.013, uTime * 0.009);
  vec2 uv2 = vRipple * 0.125 - vec2(uTime * 0.018, uTime * 0.022);
  vec3 n1 = texture2D(uRipple, uv1).xyz * 2.0 - 1.0;
  vec3 n2 = texture2D(uRipple, uv2).xyz * 2.0 - 1.0;
  vec3 nt = normalize(vec3(n1.xy + n2.xy * 0.7, 2.4));
  vec3 N = normalize(vec3(nt.x, nt.z, nt.y));
  vec3 V = normalize(cameraPosition - vWorld);

  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  fres = clamp(mix(0.05, 1.0, fres), 0.0, 1.0);

  vec2 ruv = vReflectUv.xy / max(vReflectUv.w, 0.0001) + N.xz * 0.04;
  vec3 refl = texture2D(uReflect, clamp(ruv, 0.001, 0.999)).rgb * uHasReflect;

  vec3 H = normalize(uMoonDir + V);
  float ndh = clamp(dot(N, H), 0.0, 1.0);
  float spec = pow(ndh, 260.0) * 1.7;
  float sheen = pow(ndh, 30.0) * 0.09;

  vec3 base = mix(uDeep, uShallow, clamp(N.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 col = base + refl * (uReflectStrength * fres) + uMoonColor * (spec + sheen);
  gl_FragColor = vec4(col, mix(0.60, 0.96, fres));
}`;

const SKY_VS = `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const SKY_FS = `
precision highp float;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uGlow;
uniform vec3 uMoonDir;
varying vec3 vWorld;
void main() {
  vec3 d = normalize(vWorld);
  float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 c = mix(uBottom, uTop, pow(h, 0.7));
  float toMoon = clamp(dot(d, normalize(uMoonDir)), 0.0, 1.0);
  c += uGlow * pow(toMoon, 6.0);
  gl_FragColor = vec4(c, 1.0);
}`;

/* The pond floor's displacement, evaluated on demand so rocks and grass can be
   set down on it. The plane is rotated -90 degrees about X, so its local y maps
   to world -z; this mirrors the vertex loop below exactly. */
function floorHeight(x, z) {
  const ly = -z;
  return Math.sin(x * 0.22) * Math.cos(ly * 0.19) * 0.05
    + Math.sin(x * 0.07 + ly * 0.05) * 0.10
    // the bank is capped, or it becomes a bowl that walls off the sky and moon
    + Math.min(0.85, Math.max(0, (Math.hypot(x, z) - 6.5) * 0.16))
    - 0.14;
}

export function buildScenery(scene, { grassCount = 2400 } = {}) {
  const group = new THREE.Group();
  scene.add(group);

  const rippleMap = makeRippleNormal(256);
  const grainMap = makeGrainNormal(256);
  const roughMap = makeRoughnessMap(256);
  grainMap.repeat.set(14, 14);
  roughMap.repeat.set(9, 9);

  /* ---------------- backdrop ---------------- */
  const skyGeo = new THREE.SphereGeometry(70, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false,
    uniforms: {
      uTop: { value: new THREE.Color(0x030709) },
      uBottom: { value: new THREE.Color(0x0a1c24) },
      uGlow: { value: new THREE.Color(0x2b4a52) },
      uMoonDir: { value: MOON_POS.clone().normalize() },
    },
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  group.add(sky);

  /* ---------------- moon ---------------- */
  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 24, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff0d2 }),
  );
  moon.position.copy(MOON_POS);
  group.add(moon);

  const haloTex = makeGlowSprite(256, 'rgba(255,233,196,0.95)', 'rgba(255,196,120,0)');
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTex, color: 0xffd9a0, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, opacity: 0.55,
  }));
  halo.position.copy(MOON_POS);
  halo.scale.setScalar(10);
  group.add(halo);

  /* ---------------- distant bokeh ---------------- */
  const bokehTex = makeGlowSprite(128, 'rgba(255,255,255,0.9)', 'rgba(255,255,255,0)');
  const bokeh = new THREE.Group();
  const rnd = mulberry(4242);
  for (let i = 0; i < 18; i++) {
    const warm = rnd() < 0.35;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: bokehTex, color: warm ? 0xffc98a : 0x8fe6ff, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.25 + rnd() * 0.45,
    }));
    s.position.set((rnd() - 0.5) * 60, 0.6 + rnd() * 7, -26 - rnd() * 18);
    s.scale.setScalar(0.5 + rnd() * 1.9);
    s.userData.phase = rnd() * Math.PI * 2;
    s.userData.baseY = s.position.y;
    bokeh.add(s);
  }
  group.add(bokeh);

  /* ---------------- pond floor ---------------- */
  const floorGeo = new THREE.PlaneGeometry(80, 80, 72, 72);
  const fp = floorGeo.attributes.position;
  for (let i = 0; i < fp.count; i++) {
    // local y maps to world -z under the rotation applied below
    fp.setZ(i, floorHeight(fp.getX(i), -fp.getY(i)));
  }
  floorGeo.computeVertexNormals();
  const floor = new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({
    color: 0x081418, roughness: 1.0, metalness: 0.0,
    normalMap: grainMap, normalScale: new THREE.Vector2(0.45, 0.45),
    roughnessMap: roughMap, envMapIntensity: 0.25,
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  group.add(floor);

  /* ---------------- water ---------------- */
  const waterMat = new THREE.ShaderMaterial({
    vertexShader: WATER_VS, fragmentShader: WATER_FS,
    transparent: true, depthWrite: false,
    uniforms: {
      uTextureMatrix: { value: new THREE.Matrix4() },
      uReflect: { value: null },
      uRipple: { value: rippleMap },
      uTime: { value: 0 },
      uReflectStrength: { value: 0.34 },
      uHasReflect: { value: 0 },
      uDeep: { value: new THREE.Color(0x02080b) },
      uShallow: { value: new THREE.Color(0x061319) },
      uMoonDir: { value: MOON_POS.clone().normalize() },
      uMoonColor: { value: new THREE.Color(0xffdcae) },
    },
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.012;
  water.layers.set(WATER_LAYER);      // excluded from its own reflection pass
  water.renderOrder = 2;
  group.add(water);

  /* ---------------- rocks ---------------- */
  const rockGeos = [makeRockGeometry(11), makeRockGeometry(29), makeRockGeometry(57), makeRockGeometry(83)];
  const rockMat = new THREE.MeshStandardMaterial({
    color: 0x13202a, roughness: 0.78, metalness: 0.08,
    normalMap: grainMap, normalScale: new THREE.Vector2(1.1, 1.1),
    roughnessMap: roughMap, envMapIntensity: 0.55, flatShading: false,
  });
  const rocks = [];
  const rr = mulberry(777);
  const place = (r, angle, scale, sink) => {
    const x = Math.cos(angle) * r, z = Math.sin(angle) * r;
    const m = new THREE.Mesh(rockGeos[Math.floor(rr() * rockGeos.length)], rockMat);
    m.position.set(x, floorHeight(x, z) - sink * scale, z);
    m.scale.set(scale * (0.8 + rr() * 0.5), scale * (0.6 + rr() * 0.5), scale * (0.8 + rr() * 0.5));
    m.rotation.set(rr() * 0.4, rr() * Math.PI * 2, rr() * 0.4);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m); rocks.push(m);
  };
  for (let i = 0; i < 10; i++) place(5.0 + rr() * 4.5, rr() * Math.PI * 2, 0.26 + rr() * 0.55, 0.35);
  for (let i = 0; i < 8; i++) place(11 + rr() * 11, rr() * Math.PI * 2, 0.9 + rr() * 2.0, 0.30);
  // a low flat stone by the fly, so the food has somewhere to sit
  const foodRock = new THREE.Mesh(rockGeos[1], rockMat);
  foodRock.position.set(0.62, -0.10, 0.34);
  foodRock.scale.set(0.26, 0.13, 0.24);
  foodRock.castShadow = true; foodRock.receiveShadow = true;
  group.add(foodRock);

  /* ---------------- grass ---------------- */
  // a fly is about one unit long, so a blade this tall is knee-high to her
  const blade = new THREE.PlaneGeometry(0.030, 0.26, 1, 4);
  blade.translate(0, 0.13, 0);
  const grassTime = { value: 0 };
  const grassMat = new THREE.MeshStandardMaterial({
    color: 0x16332c, roughness: 0.95, metalness: 0.0,
    side: THREE.DoubleSide, envMapIntensity: 0.35,
  });
  grassMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = grassTime;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       float sway = pow(clamp(uv.y, 0.0, 1.0), 2.0);
       vec4 instOrigin = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
       float phase = instOrigin.x * 0.7 + instOrigin.z * 0.9;
       transformed.x += sin(uTime * 1.5 + phase) * 0.10 * sway;
       transformed.z += cos(uTime * 1.1 + phase * 1.3) * 0.07 * sway;`,
    );
  };
  const grass = new THREE.InstancedMesh(blade, grassMat, grassCount);
  grass.castShadow = false;
  grass.receiveShadow = false;
  const dummy = new THREE.Object3D();
  const gr = mulberry(9182);
  let placed = 0, guard = 0;
  while (placed < grassCount && guard++ < grassCount * 40) {
    // clumps live on the bank, where the floor climbs out of the water
    const ca = gr() * Math.PI * 2, cr = 4.5 + gr() * 11;
    const cx = Math.cos(ca) * cr, cz = Math.sin(ca) * cr;
    const clump = 10 + Math.floor(gr() * 26);
    for (let i = 0; i < clump && placed < grassCount; i++) {
      const a = gr() * Math.PI * 2, rad = gr() * 0.7;
      const x = cx + Math.cos(a) * rad, z = cz + Math.sin(a) * rad;
      if (Math.hypot(x, z) < 3.2) continue;             // keep the fly's floor clear
      dummy.position.set(x, floorHeight(x, z) - 0.02, z);
      dummy.rotation.set((gr() - 0.5) * 0.3, gr() * Math.PI, (gr() - 0.5) * 0.3);
      const s = 0.6 + gr() * 0.8;
      dummy.scale.set(1, s, 1);
      dummy.updateMatrix();
      grass.setMatrixAt(placed++, dummy.matrix);
    }
  }
  grass.count = placed;
  grass.instanceMatrix.needsUpdate = true;
  group.add(grass);
  const placedBlades = placed;          // never draw instances we did not write

  return {
    group, water, waterMat, floor, grass, moon, halo,
    update(t) {
      waterMat.uniforms.uTime.value = t;
      grassTime.value = t;
      for (const s of bokeh.children) {
        s.position.y = s.userData.baseY + Math.sin(t * 0.25 + s.userData.phase) * 0.12;
      }
    },
    setQuality(high) {
      grass.count = high ? placedBlades : Math.min(placedBlades, 700);
      for (const m of rocks) m.castShadow = high;
      floor.receiveShadow = high;
      waterMat.uniforms.uReflectStrength.value = high ? 0.9 : 0.35;
    },
  };
}
