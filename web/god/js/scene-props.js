/* NEURAL GOD — minimal placeholder world props (food marker, predator shape).

   Deliberately plain geometry: Phase 1 is about the data path (world control
   -> Brain Engine -> decoder -> fly), not art. Visibility only; neither prop
   drives the simulation by itself (see web/god/js/world-control.js for which
   world controls are actually wired to a real sensory population). */
import * as THREE from '../../vendor/three/three.module.min.js';

export function setupSceneProps(scene) {
  const foodMat = new THREE.MeshStandardMaterial({
    color: 0xf2a93b, emissive: 0xf2a93b, emissiveIntensity: 0.55, roughness: 0.4,
  });
  const food = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), foodMat);
  food.position.set(0.55, 0.07, 0.35);
  food.visible = false;
  scene.add(food);

  const predator = new THREE.Group();
  const predMat = new THREE.MeshStandardMaterial({ color: 0x140d10, roughness: 0.85 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.3, 8), predMat);
  body.rotation.x = Math.PI / 2;
  predator.add(body);
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 6), predMat);
    leg.position.set(side * 0.35, -0.3, 0.2);
    leg.rotation.z = side * 0.35;
    predator.add(leg);
  }
  predator.position.set(-2.4, 0.55, -1.8);
  predator.visible = false;
  scene.add(predator);

  return {
    setFoodVisible(v) { food.visible = !!v; },
    setPredatorVisible(v) { predator.visible = !!v; },
  };
}
