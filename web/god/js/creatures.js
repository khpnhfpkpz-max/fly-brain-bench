/* NEURAL GOD -- the two things in the world that are not scenery.

   Both are procedural. The predator is a stylised spider silhouette rather
   than a detailed model: it is meant to read as a shape in the dark, backlit,
   with eye-shine. It is deliberately NOT a sensory input -- this model has no
   predator-specific channel, so the switch that shows it says so. */
import * as THREE from '../../vendor/three/three.module.min.js';
import { makeGlowSprite } from './env.js';

export function buildFood(scene, position = new THREE.Vector3(0.62, 0.07, 0.34)) {
  const group = new THREE.Group();
  group.position.copy(position);

  const geo = new THREE.IcosahedronGeometry(0.075, 2);
  const p = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const n = 1 + Math.sin(v.x * 34) * 0.06 + Math.cos(v.y * 29) * 0.05 + Math.sin(v.z * 41) * 0.05;
    v.multiplyScalar(n);
    p.setXYZ(i, v.x, v.y * 0.75, v.z);
  }
  geo.computeVertexNormals();

  const blob = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: 0xc9782a, roughness: 0.28, metalness: 0.0,
    emissive: 0xff9c28, emissiveIntensity: 2.6,
  }));
  blob.castShadow = true;
  group.add(blob);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowSprite(128, 'rgba(255,196,110,0.95)', 'rgba(255,140,40,0)'),
    color: 0xffb257, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  halo.scale.setScalar(0.85);
  group.add(halo);

  const light = new THREE.PointLight(0xffa93d, 2.4, 3.2, 2);
  light.position.set(0, 0.06, 0);
  group.add(light);

  group.visible = false;
  scene.add(group);

  return {
    group,
    position: group.position,
    setVisible(v) { group.visible = !!v; },
    update(t) {
      const pulse = 0.9 + Math.sin(t * 1.7) * 0.12;
      blob.material.emissiveIntensity = 2.6 * pulse;
      light.intensity = 2.4 * pulse;
      halo.scale.setScalar(0.85 * pulse);
    },
  };
}

function legSegment(parent, material, length, radius) {
  const geo = new THREE.CylinderGeometry(radius * 0.7, radius, length, 6);
  geo.translate(0, -length / 2, 0);          // pivot at the top joint
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  parent.add(mesh);
  const joint = new THREE.Group();
  joint.position.y = -length;
  parent.add(joint);
  return joint;
}

export function buildPredator(scene, position = new THREE.Vector3(4.8, 0, -4.6)) {
  const group = new THREE.Group();
  group.position.copy(position);
  group.rotation.y = -2.3;                    // turned toward the middle of the pond

  /* Leg geometry sets the ride height: the femur drops 0.92*cos(1.05)=0.46 to a
     raised knee, the tibia drops 1.05*cos(0.15)=1.04 from there, so the feet
     land at about y=0 with the body at 1.50. */
  const RIDE_HEIGHT = 1.50;
  const body = new THREE.Group();
  body.position.y = RIDE_HEIGHT;
  group.add(body);

  const shell = new THREE.MeshStandardMaterial({ color: 0x0b0709, roughness: 0.52, metalness: 0.3 });
  const sphere = new THREE.SphereGeometry(1, 20, 14);

  const abdomen = new THREE.Mesh(sphere, shell);
  abdomen.scale.set(0.62, 0.52, 0.80);
  abdomen.position.set(0, 0.06, -0.62);
  abdomen.castShadow = true;
  body.add(abdomen);

  const thorax = new THREE.Mesh(sphere, shell);
  thorax.scale.set(0.42, 0.34, 0.46);
  thorax.position.set(0, 0, 0.16);
  thorax.castShadow = true;
  body.add(thorax);

  // chelicerae
  for (const side of [-1, 1]) {
    const fang = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.30, 6), shell);
    fang.position.set(side * 0.13, -0.14, 0.52);
    fang.rotation.x = Math.PI * 0.86;
    body.add(fang);
  }

  // eye shine: the one bright thing on it
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2d1a });
  const eyes = [];
  const eyeGeo = new THREE.SphereGeometry(0.045, 8, 6);
  for (const side of [-1, 1]) {
    for (let row = 0; row < 2; row++) {
      const e = new THREE.Mesh(eyeGeo, eyeMat);
      e.position.set(side * (0.10 + row * 0.10), 0.09 - row * 0.07, 0.50 - row * 0.03);
      e.scale.setScalar(row ? 0.75 : 1);
      body.add(e);
      eyes.push(e);
    }
  }
  const eyeLight = new THREE.PointLight(0xff3018, 0.9, 2.4, 2);
  eyeLight.position.set(0, 0.05, 0.55);
  body.add(eyeLight);

  const eyeHalo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowSprite(128, 'rgba(255,90,60,0.9)', 'rgba(255,40,20,0)'),
    color: 0xff4b2a, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.8,
  }));
  eyeHalo.position.set(0, 0.04, 0.52);
  eyeHalo.scale.setScalar(0.9);
  body.add(eyeHalo);

  /* eight legs: femur up to a raised knee, tibia down to the ground --
     the silhouette that says "spider" before any detail is visible */
  const legs = [];
  const spread = [0.95, 0.42, -0.12, -0.68];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.28, 0.02, 0.10 + spread[i] * 0.30);
      hip.rotation.y = side * (0.5 + spread[i] * 0.85);
      hip.rotation.z = side * 1.05;                     // out and up to the knee
      body.add(hip);
      const knee = legSegment(hip, shell, 0.92, 0.055);
      knee.rotation.z = side * -0.90;                   // sharp bend, foot back down
      const foot = legSegment(knee, shell, 1.05, 0.036);
      legs.push({ hip, knee, foot, side, i, phase: (i + (side > 0 ? 0.5 : 0)) * 1.7 });
    }
  }

  group.visible = false;
  scene.add(group);

  return {
    group,
    labelPosition: new THREE.Vector3(position.x, position.y + 2.5, position.z),
    setVisible(v) { group.visible = !!v; },
    update(t) {
      body.position.y = RIDE_HEIGHT + Math.sin(t * 0.8) * 0.035;
      body.rotation.z = Math.sin(t * 0.55) * 0.02;
      const shine = 0.75 + Math.sin(t * 2.3) * 0.25;
      eyeMat.color.setRGB(1, 0.16 * shine, 0.09 * shine);
      eyeLight.intensity = 0.9 * shine;
      eyeHalo.material.opacity = 0.55 + shine * 0.35;
      for (const l of legs) {
        l.hip.rotation.x = Math.sin(t * 0.9 + l.phase) * 0.05;
        l.knee.rotation.x = Math.sin(t * 1.3 + l.phase) * 0.04;
      }
    },
  };
}
