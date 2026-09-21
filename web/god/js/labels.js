/* NEURAL GOD -- HTML chips pinned to world positions, as in the mockup.
   Projection only; nothing here reads or reports simulation state. */
import * as THREE from '../../vendor/three/three.module.min.js';

export class SceneLabels {
  constructor(container) {
    this.container = container;
    this.items = new Map();
    this._v = new THREE.Vector3();
  }

  add(id, text, kind = '') {
    const el = document.createElement('div');
    el.className = `scene-label ${kind}`.trim();
    el.innerHTML = '<span class="sl-mark"></span><span class="sl-text"></span>';
    el.querySelector('.sl-text').textContent = text;
    el.style.display = 'none';
    this.container.appendChild(el);
    this.items.set(id, { el, pos: new THREE.Vector3(), visible: false });
  }

  setVisible(id, v) { const it = this.items.get(id); if (it) it.visible = !!v; }
  setPosition(id, vec) { const it = this.items.get(id); if (it) it.pos.copy(vec); }

  update(camera, w, h) {
    for (const it of this.items.values()) {
      if (!it.visible) { it.el.style.display = 'none'; continue; }
      this._v.copy(it.pos).project(camera);
      if (this._v.z > 1) { it.el.style.display = 'none'; continue; }
      const x = (this._v.x * 0.5 + 0.5) * w;
      const y = (-this._v.y * 0.5 + 0.5) * h;
      if (x < -80 || y < -50 || x > w + 80 || y > h + 50) { it.el.style.display = 'none'; continue; }
      it.el.style.display = '';
      it.el.style.transform = `translate(-50%, -100%) translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
    }
  }
}
