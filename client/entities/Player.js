import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { RUN_SPEED, WALK_FACTOR, BACKPEDAL_FACTOR, TURN_SPEED } from '../../shared/constants.js';
import { getTerrainHeight } from '../world/Terrain.js';

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
 * Returns { group, mixer, actions } where mixer/actions are null if no skeleton.
 */
export function createPlayerMesh(color = 0x4488ff) {
  const group = new THREE.Group();
  let mixer = null;
  let actions = {};

  if (cachedModel) {
    // SkeletonUtils.clone properly handles skinned meshes
    const model = SkeletonUtils.clone(cachedModel);
    model.rotation.y = Math.PI / 2; // WoW model faces +X, Three.js forward is -Z
    model.traverse((child) => {
      if (child.isMesh) child.castShadow = true;
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

  return { group, mixer, actions };
}

const FADE_DURATION = 0.2; // seconds for animation crossfade

export class LocalPlayer {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.position = new THREE.Vector3(0, 0, 0);
    this.characterYaw = 0;
    this.color = getPlayerColor(id);

    const { group, mixer, actions } = createPlayerMesh(this.color);
    this.mesh = group;
    this.mixer = mixer;
    this.actions = actions;
    this.currentAction = null;

    // Start with idle animation
    this.playAnimation('Stand');

    // Movement keys
    this.keys = { w: false, a: false, s: false, d: false, q: false, e: false };

    // Autorun
    this.autorun = false;

    // Walk/Run toggle (false = run, true = walk)
    this.walkMode = false;
  }

  playAnimation(name) {
    if (!this.mixer || !this.actions[name]) return;
    if (this.currentAction === this.actions[name]) return;

    const newAction = this.actions[name];
    if (this.currentAction) {
      this.currentAction.fadeOut(FADE_DURATION);
    }
    newAction.reset().fadeIn(FADE_DURATION).play();
    this.currentAction = newAction;
  }

  update(dt, controls) {
    const rightHeld = controls.rightMouseDown;
    const bothHeld = controls.bothButtonsForward;

    // --- Keyboard turning (A/D) when right-click NOT held ---
    if (!rightHeld) {
      if (this.keys.a) this.characterYaw += TURN_SPEED * dt;
      if (this.keys.d) this.characterYaw -= TURN_SPEED * dt;
    }

    // --- When right-click is held, character yaw snaps to camera yaw ---
    if (rightHeld) {
      this.characterYaw = controls.cameraYaw;
    }

    // --- Build movement vector ---
    let moveX = 0;
    let moveZ = 0;
    let speed = this.walkMode ? RUN_SPEED * WALK_FACTOR : RUN_SPEED;

    const movingForward = this.keys.w || this.autorun || bothHeld;

    if (movingForward) {
      moveZ -= 1;
    }

    if (this.keys.s) {
      if (this.autorun) {
        this.autorun = false;
      } else if (!movingForward) {
        moveZ += 1;
        speed = RUN_SPEED * BACKPEDAL_FACTOR;
      }
    }

    if (this.keys.q || (this.keys.a && rightHeld)) moveX -= 1;
    if (this.keys.e || (this.keys.d && rightHeld)) moveX += 1;

    // Apply movement relative to character facing
    const moveDir = new THREE.Vector3(moveX, 0, moveZ);
    const isMoving = moveDir.lengthSq() > 0;

    if (isMoving) {
      moveDir.normalize();
      moveDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.characterYaw);
      this.position.x += moveDir.x * speed * dt;
      this.position.z += moveDir.z * speed * dt;
    }

    // --- Animation state ---
    if (!isMoving) {
      this.playAnimation('Stand');
    } else if (moveZ > 0) {
      this.playAnimation('WalkBackwards');
    } else if (this.walkMode) {
      this.playAnimation('Walk');
    } else {
      this.playAnimation('Run');
    }

    // Update animation mixer
    if (this.mixer) this.mixer.update(dt);

    // Snap to terrain
    this.position.y = getTerrainHeight(this.position.x, this.position.z);

    // Clamp to world bounds
    const halfWorld = 250;
    this.position.x = Math.max(-halfWorld, Math.min(halfWorld, this.position.x));
    this.position.z = Math.max(-halfWorld, Math.min(halfWorld, this.position.z));

    // Update mesh
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.characterYaw;
  }

  setKey(key, pressed) {
    if (key in this.keys) {
      this.keys[key] = pressed;
    }
    if (key === 'numlock' && pressed) {
      this.autorun = !this.autorun;
    }
  }

  getState() {
    return {
      position: {
        x: this.position.x,
        y: this.position.y,
        z: this.position.z,
      },
      rotation: this.characterYaw,
    };
  }
}
