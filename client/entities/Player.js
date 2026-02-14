import * as THREE from 'three';
import { RUN_SPEED, BACKPEDAL_FACTOR, TURN_SPEED } from '../../shared/constants.js';
import { getTerrainHeight } from '../world/Terrain.js';

const PLAYER_COLORS = [
  0x4488ff, 0xff4444, 0x44ff44, 0xffaa00, 0xff44ff,
  0x44ffff, 0xff8844, 0x8844ff, 0x44ff88, 0xff4488,
];

export function getPlayerColor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash) + id.charCodeAt(i);
    hash |= 0;
  }
  return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

export function createPlayerMesh(color = 0x4488ff) {
  const group = new THREE.Group();

  // Body
  const bodyGeo = new THREE.CylinderGeometry(0.35, 0.35, 1.0, 8);
  const bodyMat = new THREE.MeshStandardMaterial({ color });
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.y = 0.9;
  body.castShadow = true;
  group.add(body);

  // Head
  const headGeo = new THREE.SphereGeometry(0.28, 8, 8);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffcc99 });
  const head = new THREE.Mesh(headGeo, headMat);
  head.position.y = 1.65;
  head.castShadow = true;
  group.add(head);

  // Shoulders
  const shoulderGeo = new THREE.BoxGeometry(0.9, 0.2, 0.4);
  const shoulderMat = new THREE.MeshStandardMaterial({ color });
  const shoulders = new THREE.Mesh(shoulderGeo, shoulderMat);
  shoulders.position.y = 1.35;
  shoulders.castShadow = true;
  group.add(shoulders);

  return group;
}

export class LocalPlayer {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.position = new THREE.Vector3(0, 0, 0);
    this.characterYaw = 0; // Direction the character faces (independent of camera)
    this.color = getPlayerColor(id);
    this.mesh = createPlayerMesh(this.color);

    // Movement keys
    this.keys = { w: false, a: false, s: false, d: false, q: false, e: false };

    // Autorun
    this.autorun = false;
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
    let moveX = 0; // Lateral (strafe)
    let moveZ = 0; // Forward/back
    let speed = RUN_SPEED;

    // Forward: W key, autorun, or both-mouse-buttons
    const movingForward = this.keys.w || this.autorun || bothHeld;

    if (movingForward) {
      moveZ -= 1;
    }

    // Backpedal (S) — cancels autorun, reduced speed
    if (this.keys.s) {
      if (this.autorun) {
        this.autorun = false;
      } else if (!movingForward) {
        moveZ += 1;
        speed = RUN_SPEED * BACKPEDAL_FACTOR;
      }
    }

    // Strafe: Q/E always strafe. A/D strafe when right-click held.
    if (this.keys.q || (this.keys.a && rightHeld)) moveX -= 1;
    if (this.keys.e || (this.keys.d && rightHeld)) moveX += 1;

    // Apply movement relative to character facing
    const moveDir = new THREE.Vector3(moveX, 0, moveZ);
    if (moveDir.lengthSq() > 0) {
      moveDir.normalize();
      moveDir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.characterYaw);
      this.position.x += moveDir.x * speed * dt;
      this.position.z += moveDir.z * speed * dt;
    }

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
    // NumLock toggles autorun (use 'numlock' key)
    // Also support 'r' as an autorun toggle for convenience
    if (key === 'numlock' && pressed) {
      this.autorun = !this.autorun;
    }
  }

  cancelAutorun() {
    this.autorun = false;
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
