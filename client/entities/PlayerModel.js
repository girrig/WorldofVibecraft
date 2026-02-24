import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const PLAYER_COLORS = [
  0x4488ff, 0xff4444, 0x44ff44, 0xffaa00, 0xff44ff,
  0x44ffff, 0xff8844, 0x8844ff, 0x44ff88, 0xff4488,
];

// Cached loaded model and animations
let cachedModel = null;
let cachedAnimations = [];
let modelLoading = null;

export function preloadPlayerModel() {
  if (modelLoading) return modelLoading;
  modelLoading = new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.load(
      '/assets/models/human_male.glb',
      (gltf) => {
        cachedModel = gltf.scene;
        cachedAnimations = gltf.animations || [];
        cachedModel.traverse((child) => {
          if (child.isMesh) child.castShadow = true;
        });
        console.log(`Model loaded: ${cachedAnimations.length} animations:`, cachedAnimations.map(a => a.name));
        resolve(cachedModel);
      },
      undefined,
      reject
    );
  });
  return modelLoading;
}

export function getPlayerColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

/**
 * Create a player mesh with optional animation support.
 * Returns { group, mixer, actions, spineBone } where mixer/actions are null if no skeleton.
 */
export function createPlayerMesh(color = 0x4488ff) {
  const group = new THREE.Group();
  let mixer = null;
  let actions = {};
  let spineBone = null;

  if (cachedModel) {
    // SkeletonUtils.clone properly handles skinned meshes
    const model = SkeletonUtils.clone(cachedModel);
    model.rotation.y = Math.PI / 2; // WoW model faces +X, Three.js forward is -Z
    model.traverse((child) => {
      if (child.isMesh) child.castShadow = true;
      // Bone_2 = WoW key_bone_id 4 (SpineLow / "Upper Body")
      if (child.isBone && child.name === 'Bone_2') spineBone = child;
    });
    group.add(model);

    // Set up animation mixer if we have animations
    if (cachedAnimations.length > 0) {
      mixer = new THREE.AnimationMixer(model);
      for (const clip of cachedAnimations) {
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat);
        actions[clip.name] = action;
      }
    }
  } else {
    // Fallback placeholder while model loads
    const bodyGeo = new THREE.CylinderGeometry(0.35, 0.35, 1.0, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ color });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.9;
    body.castShadow = true;
    group.add(body);

    const headGeo = new THREE.SphereGeometry(0.28, 8, 8);
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffcc99 });
    const head = new THREE.Mesh(headGeo, headMat);
    head.position.y = 1.65;
    head.castShadow = true;
    group.add(head);

    const shoulderGeo = new THREE.BoxGeometry(0.9, 0.2, 0.4);
    const shoulderMat = new THREE.MeshStandardMaterial({ color });
    const shoulders = new THREE.Mesh(shoulderGeo, shoulderMat);
    shoulders.position.y = 1.35;
    shoulders.castShadow = true;
    group.add(shoulders);
  }

  return { group, mixer, actions, spineBone };
}
