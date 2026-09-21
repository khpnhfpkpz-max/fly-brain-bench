/* NEURAL GOD -- bloom, ported from the bench's own point-cloud renderer.

   This is deliberately the same chain as web/js/gl.js: bright pass at the same
   threshold, a tight nine-tap separable gaussian at half resolution, a wide one
   at quarter resolution, mixed 0.40 / 0.72, then the same filmic curve and the
   same vignette. The NEURAL ACTIVITY panel and the world therefore glow with
   one falloff instead of two that merely look similar.

   One difference, and it is a correctness fix rather than a style choice: the
   3D scene is physically lit, so its render target holds linear HDR radiance.
   Tone mapping and the sRGB transfer are applied once here, at the end, rather
   than baked into the source as they are in the point cloud's gamma-space
   pipeline. */
import * as THREE from '../../vendor/three/three.module.min.js';

const QUAD_VS = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BRIGHT_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  gl_FragColor = vec4(c * smoothstep(uThreshold, uThreshold + 0.45, l), 1.0);
}`;

/* separable gaussian, nine taps, radius in texels -- weights as in gl.js */
const BLUR_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
const float W0 = 0.2270270;
const float W1 = 0.1945945;
const float W2 = 0.1216216;
const float W3 = 0.0540540;
const float W4 = 0.0162162;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb * W0;
  c += texture2D(uTex, vUv + uDir * 1.0).rgb * W1;
  c += texture2D(uTex, vUv - uDir * 1.0).rgb * W1;
  c += texture2D(uTex, vUv + uDir * 2.0).rgb * W2;
  c += texture2D(uTex, vUv - uDir * 2.0).rgb * W2;
  c += texture2D(uTex, vUv + uDir * 3.0).rgb * W3;
  c += texture2D(uTex, vUv - uDir * 3.0).rgb * W3;
  c += texture2D(uTex, vUv + uDir * 4.0).rgb * W4;
  c += texture2D(uTex, vUv - uDir * 4.0).rgb * W4;
  gl_FragColor = vec4(c, 1.0);
}`;

const COMPOSITE_FS = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;
uniform sampler2D uBloomA;
uniform sampler2D uBloomB;
uniform float uBloom;
uniform float uExposure;
uniform float uGrain;
uniform float uTime;

/* the same filmic curve the point cloud uses, so a hot core rolls off
   instead of clipping to a white disc */
vec3 tone(vec3 c) {
  c = max(vec3(0.0), c);
  return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0);
}
vec3 srgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(0.41666)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
void main() {
  vec3 c = texture2D(uScene, vUv).rgb;
  c += (texture2D(uBloomA, vUv).rgb * 0.40 + texture2D(uBloomB, vUv).rgb * 0.72) * uBloom;
  c = tone(c * uExposure);
  vec2 d = vUv - 0.5;
  c *= 1.0 - dot(d, d) * 0.55;
  c = srgb(c);
  c += (hash(vUv * 1024.0 + fract(uTime)) - 0.5) * uGrain;
  gl_FragColor = vec4(c, 1.0);
}`;

export class PostChain {
  constructor(renderer, { threshold = 0.55, strength = 0.85, exposure = 1.15, grain = 0.012 } = {}) {
    this.renderer = renderer;
    this.enabled = true;
    const type = this._floatType();

    const opts = { type, depthBuffer: true, stencilBuffer: false };
    this.sceneRT = new THREE.WebGLRenderTarget(2, 2, opts);
    const half = { type, depthBuffer: false, stencilBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(2, 2, half);
    this.rtB = new THREE.WebGLRenderTarget(2, 2, half);
    this.rtC = new THREE.WebGLRenderTarget(2, 2, half);
    this.rtD = new THREE.WebGLRenderTarget(2, 2, half);
    for (const rt of [this.sceneRT, this.rtA, this.rtB, this.rtC, this.rtD]) {
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
      rt.texture.generateMipmaps = false;
    }

    const base = { depthTest: false, depthWrite: false };
    this.mBright = new THREE.ShaderMaterial({
      ...base, vertexShader: QUAD_VS, fragmentShader: BRIGHT_FS,
      uniforms: { uTex: { value: null }, uThreshold: { value: threshold } },
    });
    this.mBlur = new THREE.ShaderMaterial({
      ...base, vertexShader: QUAD_VS, fragmentShader: BLUR_FS,
      uniforms: { uTex: { value: null }, uDir: { value: new THREE.Vector2() } },
    });
    this.mComposite = new THREE.ShaderMaterial({
      ...base, vertexShader: QUAD_VS, fragmentShader: COMPOSITE_FS,
      uniforms: {
        uScene: { value: null }, uBloomA: { value: null }, uBloomB: { value: null },
        uBloom: { value: strength }, uExposure: { value: exposure },
        uGrain: { value: grain }, uTime: { value: 0 },
      },
    });

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mBright);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    this.size = { w: 2, h: 2 };
  }

  _floatType() {
    const gl = this.renderer.getContext();
    const ok = gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float');
    return ok ? THREE.HalfFloatType : THREE.UnsignedByteType;
  }

  setSize(w, h) {
    if (w === this.size.w && h === this.size.h) return;
    this.size = { w, h };
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    const qw = Math.max(2, w >> 2), qh = Math.max(2, h >> 2);
    this.sceneRT.setSize(w, h);
    this.rtA.setSize(hw, hh); this.rtB.setSize(hw, hh);
    this.rtC.setSize(qw, qh); this.rtD.setSize(qw, qh);
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(this.quadScene, this.quadCam);
  }

  _blur(src, target, radiusTexels) {
    const w = target.width, h = target.height;
    this.mBlur.uniforms.uTex.value = src.texture;
    this.mBlur.uniforms.uDir.value.set(radiusTexels / w, 0);
    this._pass(this.mBlur, target);
    return target;
  }

  /* Renders `scene` and returns the target it landed in, so the caller can
     keep using it (the reflection pass runs before this). */
  renderScene(scene, camera) {
    this.renderer.setRenderTarget(this.enabled ? this.sceneRT : null);
    this.renderer.clear();
    this.renderer.render(scene, camera);
  }

  composite(timeSec) {
    if (!this.enabled) { this.renderer.setRenderTarget(null); return; }
    const { rtA, rtB, rtC, rtD } = this;

    this.mBright.uniforms.uTex.value = this.sceneRT.texture;
    this._pass(this.mBright, rtA);

    // a tight glow at half resolution...
    this.mBlur.uniforms.uTex.value = rtA.texture;
    this.mBlur.uniforms.uDir.value.set(1.2 / rtA.width, 0);
    this._pass(this.mBlur, rtB);
    this.mBlur.uniforms.uTex.value = rtB.texture;
    this.mBlur.uniforms.uDir.value.set(0, 1.2 / rtA.height);
    this._pass(this.mBlur, rtA);

    // ...and a wide one at quarter resolution, which is what reads as light
    this.mBlur.uniforms.uTex.value = rtA.texture;
    this.mBlur.uniforms.uDir.value.set(2.0 / rtC.width, 0);
    this._pass(this.mBlur, rtC);
    this.mBlur.uniforms.uTex.value = rtC.texture;
    this.mBlur.uniforms.uDir.value.set(0, 2.0 / rtC.height);
    this._pass(this.mBlur, rtD);
    this.mBlur.uniforms.uTex.value = rtD.texture;
    this.mBlur.uniforms.uDir.value.set(3.4 / rtC.width, 0);
    this._pass(this.mBlur, rtC);
    this.mBlur.uniforms.uTex.value = rtC.texture;
    this.mBlur.uniforms.uDir.value.set(0, 3.4 / rtC.height);
    this._pass(this.mBlur, rtD);

    this.mComposite.uniforms.uScene.value = this.sceneRT.texture;
    this.mComposite.uniforms.uBloomA.value = rtA.texture;
    this.mComposite.uniforms.uBloomB.value = rtD.texture;
    this.mComposite.uniforms.uTime.value = timeSec;
    this._pass(this.mComposite, null);
  }

  dispose() {
    for (const rt of [this.sceneRT, this.rtA, this.rtB, this.rtC, this.rtD]) rt.dispose();
    for (const m of [this.mBright, this.mBlur, this.mComposite]) m.dispose();
    this.quad.geometry.dispose();
  }
}
