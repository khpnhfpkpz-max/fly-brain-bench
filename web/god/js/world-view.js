/* NEURAL GOD -- the world the fly lives in.

   This replaces web/js/fly.js's FlyView for this page only. FlyView renders
   straight to the canvas, which leaves nowhere to put a reflection pass or a
   bloom chain, and it owns a ground plane and grid this scene does not want.
   So the *body* -- FlyRig, the articulated fly with its planted tripod gait --
   is imported unchanged from the shared module, and everything around it
   (renderer, camera, lighting, water, post) is owned here.

   The fly is still driven only by `drive`, the decoder's output. Nothing in
   this file feeds the simulation or reads neural state. */
import * as THREE from '../../vendor/three/three.module.min.js';
import { FlyRig } from '../../js/fly-rig.js';
import { PostChain } from './bloom.js';
import { buildScenery, MOON_POS, WATER_LAYER } from './terrain.js';
import { buildFood, buildPredator } from './creatures.js';
import { buildEnvironment } from './env.js';
import { SceneLabels } from './labels.js';

const CAMERA_MODES = ['free', 'follow', 'orbit'];

export class WorldView {
  constructor(canvas, { labelContainer, quality = 'high' } = {}) {
    this.canvas = canvas;
    this.quality = quality;
    this.mode = 'free';
    this.time = 0;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;   // only used when bloom is off
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x04080b, 1);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x061016, 0.024);
    this.scene.environment = buildEnvironment(this.renderer);

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.05, 200);
    this.camera.layers.enable(WATER_LAYER);
    this.focus = new THREE.Vector3(0, 0.34, 0);
    this.target = this.focus.clone();
    this.yaw = 0.16; this.pitch = 0.22; this.dist = 6.2;
    this.userMoved = false;

    /* ---------------- lights ---------------- */
    const moonDir = MOON_POS.clone().normalize();
    this.key = new THREE.DirectionalLight(0xffd9a8, 1.9);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(1024, 1024);
    Object.assign(this.key.shadow.camera, { left: -3.2, right: 3.2, top: 3.2, bottom: -3.2, near: 0.2, far: 34 });
    this.key.shadow.normalBias = 0.02;
    this.key.shadow.bias = -0.0002;
    this.moonDir = moonDir;
    this.scene.add(this.key, this.key.target);

    this.rim = new THREE.DirectionalLight(0x74d3ff, 0.9);
    this.rim.position.set(7, 3.2, 6);
    this.scene.add(this.rim);

    this.scene.add(new THREE.HemisphereLight(0x1d4356, 0x060f0e, 0.40));

    /* ---------------- world ---------------- */
    this.scenery = buildScenery(this.scene, { grassCount: 1800 });
    this.food = buildFood(this.scene);
    this.predator = buildPredator(this.scene);

    /* ---------------- the fly ---------------- */
    this.rig = new FlyRig();
    this.scene.add(this.rig.root);
    this.rig.root.traverse(o => {
      if (o.castShadow !== undefined) o.castShadow = true;
      const mats = o.material ? [o.material].flat() : [];
      for (const m of mats) {
        if (m.isMeshStandardMaterial) {
          m.envMapIntensity = 1.4;
          m.roughness = Math.max(0.08, m.roughness * 0.78);
        }
      }
    });

    /* ---------------- reflection ---------------- */
    const gl = this.renderer.getContext();
    const floatOk = gl.getExtension('EXT_color_buffer_half_float') || gl.getExtension('EXT_color_buffer_float');
    this.reflectRT = new THREE.WebGLRenderTarget(2, 2, {
      type: floatOk ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: true, stencilBuffer: false,
    });
    this.reflectRT.texture.minFilter = THREE.LinearFilter;
    this.reflectRT.texture.magFilter = THREE.LinearFilter;
    this.reflectRT.texture.generateMipmaps = false;
    this.reflectCam = new THREE.PerspectiveCamera();
    this.textureMatrix = new THREE.Matrix4();
    this.scenery.waterMat.uniforms.uReflect.value = this.reflectRT.texture;

    /* Same chain as the point cloud, but the threshold is not the same number:
       gl.js thresholds gamma-space values, this scene is linear HDR, where 0.55
       is an ordinary lit surface rather than a highlight. 1.15 puts the knee in
       the same visual place -- only the moon, the food and specular streaks
       bloom. The falloff, the two scales and the mix are unchanged. */
    this.post = new PostChain(this.renderer, { threshold: 1.15, strength: 0.72, exposure: 1.15 });

    this.labels = labelContainer ? new SceneLabels(labelContainer) : null;
    if (this.labels) {
      this.labels.add('food', 'Food', 'food');
      this.labels.add('predator', 'Predator', 'predator');
      this.labels.setPosition('food', this.food.position.clone().add(new THREE.Vector3(0, 0.22, 0)));
      this.labels.setPosition('predator', this.predator.labelPosition);
    }

    this._w = 0; this._h = 0;
    this._bind();
    this.setQuality(quality);
  }

  _bind() {
    const c = this.canvas;
    let dragging = false, lx = 0, ly = 0;
    this.handlers = {
      pointerdown: e => {
        if (e.button !== 0) return;
        c.setPointerCapture(e.pointerId);
        dragging = true; lx = e.clientX; ly = e.clientY; this.userMoved = true;
      },
      pointermove: e => {
        if (!dragging) return;
        this.yaw -= (e.clientX - lx) * 0.006;
        this.pitch = Math.max(0.03, Math.min(1.25, this.pitch + (e.clientY - ly) * 0.005));
        lx = e.clientX; ly = e.clientY;
      },
      pointerup: () => { dragging = false; },
      pointercancel: () => { dragging = false; },
      wheel: e => {
        e.preventDefault();
        this.userMoved = true;
        this.dist = Math.max(1.6, Math.min(16, this.dist * Math.exp(e.deltaY * 0.001)));
      },
      dblclick: () => this.resetCamera(),
    };
    for (const [ev, fn] of Object.entries(this.handlers)) c.addEventListener(ev, fn, { passive: false });
  }

  resetCamera() {
    this.yaw = 0.16; this.pitch = 0.22; this.dist = 6.2;
    this.userMoved = false;
  }

  setCameraMode(mode) {
    if (!CAMERA_MODES.includes(mode)) return;
    this.mode = mode;
    if (mode !== 'free') this.userMoved = false;
  }

  setQuality(q) {
    const high = q === 'high';
    this.quality = high ? 'high' : 'low';
    this.renderer.setPixelRatio(high ? Math.min(devicePixelRatio || 1, 1.75) : 1);
    this.renderer.shadowMap.enabled = high;
    this.post.enabled = high;
    this.reflectEnabled = high;
    this.scenery.setQuality(high);
    this.scenery.waterMat.uniforms.uHasReflect.value = high ? 1 : 0;
    this.post.sceneRT.samples = high ? 4 : 0;
    this.post.sceneRT.dispose();
    this._w = 0;                                 // force a resize pass
    this.scene.traverse(o => {
      const mats = o.material ? [o.material].flat() : [];
      for (const m of mats) m.needsUpdate = true;
    });
  }

  setFoodVisible(v) {
    this.food.setVisible(v);
    this.labels?.setVisible('food', v);
  }

  setPredatorVisible(v) {
    this.predator.setVisible(v);
    this.labels?.setVisible('predator', v);
  }

  /* `drive` is the decoder's output, exactly as the bench feeds it. */
  update(drive, dt) {
    this.rig.update(drive, Math.max(0, Math.min(dt, 0.05)));
    // follow a little of the takeoff, or she climbs straight out of frame
    this.target.set(this.rig.root.position.x, 0.34 + this.rig.s.air * 0.55, this.rig.root.position.z);
  }

  _placeCamera(dt) {
    this.focus.lerp(this.target, 1 - Math.exp(-dt * 5));
    if (this.mode === 'orbit') this.yaw += dt * 0.11;
    else if (this.mode === 'follow' && !this.userMoved) {
      const want = this.rig.s.heading + Math.PI;
      let d = ((want - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      this.yaw += d * (1 - Math.exp(-dt * 1.6));
    }
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camera.position.set(
      this.focus.x + Math.sin(this.yaw) * cp * this.dist,
      this.focus.y + sp * this.dist,
      this.focus.z + Math.cos(this.yaw) * cp * this.dist,
    );
    this.camera.lookAt(this.focus);

    this.key.position.copy(this.focus).addScaledVector(this.moonDir, 14);
    this.key.target.position.copy(this.focus);
    this.key.target.updateMatrixWorld();
  }

  _renderReflection() {
    const c = this.camera;
    const r = this.reflectCam;
    r.fov = c.fov; r.aspect = c.aspect; r.near = c.near; r.far = c.far;
    r.position.set(c.position.x, -c.position.y, c.position.z);
    r.up.set(0, 1, 0);
    r.lookAt(this.focus.x, -this.focus.y, this.focus.z);
    r.updateProjectionMatrix();
    r.updateMatrixWorld(true);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(r.projectionMatrix);
    this.textureMatrix.multiply(r.matrixWorldInverse);
    this.scenery.waterMat.uniforms.uTextureMatrix.value.copy(this.textureMatrix);

    // the water is on its own layer, so the reflection camera cannot see it
    const shadows = this.renderer.shadowMap.enabled;
    this.renderer.shadowMap.enabled = false;
    this.renderer.setRenderTarget(this.reflectRT);
    this.renderer.clear();
    this.renderer.render(this.scene, r);
    this.renderer.shadowMap.enabled = shadows;
  }

  draw(dt = 1 / 60) {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.time += dt;

    if (w !== this._w || h !== this._h) {
      this._w = w; this._h = h;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      const dpr = this.renderer.getPixelRatio();
      const bw = Math.max(2, Math.floor(w * dpr)), bh = Math.max(2, Math.floor(h * dpr));
      this.post.setSize(bw, bh);
      this.reflectRT.setSize(Math.max(2, bw >> 2), Math.max(2, bh >> 2));
    }

    this._placeCamera(dt);
    this.scenery.update(this.time);
    this.food.update(this.time);
    this.predator.update(this.time);

    if (this.reflectEnabled) this._renderReflection();

    this.post.renderScene(this.scene, this.camera);
    this.post.composite(this.time);
    this.renderer.setRenderTarget(null);

    this.labels?.update(this.camera, w, h);
  }

  dispose() {
    for (const [ev, fn] of Object.entries(this.handlers)) this.canvas.removeEventListener(ev, fn);
    this.post.dispose();
    this.reflectRT.dispose();
    this.renderer.dispose();
  }
}
