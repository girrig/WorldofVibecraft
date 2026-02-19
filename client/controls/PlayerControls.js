import * as THREE from 'three';
import {
  CAMERA_MIN_DISTANCE,
  CAMERA_MAX_DISTANCE,
  CAMERA_DEFAULT_DISTANCE,
  CAMERA_SENSITIVITY,
} from '../../shared/constants.js';

function isChildOf(object, parent) {
  let current = object;
  while (current) {
    if (current === parent) return true;
    current = current.parent;
  }
  return false;
}

export class PlayerControls {
  constructor(camera, canvas) {
    this.camera = camera;
    this.canvas = canvas;

    // Camera and character have INDEPENDENT yaw (WoW-style)
    this.cameraYaw = 0;
    this.cameraPitch = 0.3;
    this.distance = CAMERA_DEFAULT_DISTANCE;

    this.rightMouseDown = false;
    this.leftMouseDown = false;
    this.sensitivity = CAMERA_SENSITIVITY;

    // Track whether both buttons trigger forward movement
    this.bothButtonsForward = false;

    this.setupEvents();
  }

  setupEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.leftMouseDown = true;
      if (e.button === 2) this.rightMouseDown = true;

      // Request pointer lock when either mouse button is held
      if ((e.button === 0 || e.button === 2) && !document.pointerLockElement) {
        this.canvas.requestPointerLock();
      }

      this.bothButtonsForward = this.leftMouseDown && this.rightMouseDown;
    });

    this.canvas.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.leftMouseDown = false;
      if (e.button === 2) this.rightMouseDown = false;

      this.bothButtonsForward = this.leftMouseDown && this.rightMouseDown;

      // Exit pointer lock when no mouse buttons held
      if (!this.leftMouseDown && !this.rightMouseDown && document.pointerLockElement) {
        document.exitPointerLock();
      }
    });

    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Mouse move: different behavior for left vs right click
    document.addEventListener('mousemove', (e) => {
      if (!this.leftMouseDown && !this.rightMouseDown) return;

      const dx = e.movementX * this.sensitivity;
      const dy = e.movementY * this.sensitivity;

      // Both left and right, or just right: rotate camera yaw
      // Character yaw is synced in the game loop
      this.cameraYaw -= dx;
      this.cameraPitch += dy; // Inverted per user preference

      // Left-click only: rotate camera only (character yaw untouched)
      // Right-click (or both): camera yaw is synced to character in game loop

      this.cameraPitch = Math.max(
        -Math.PI / 2 + 0.1,
        Math.min(Math.PI / 2 - 0.1, this.cameraPitch)
      );
    });

    // Scroll to zoom
    this.canvas.addEventListener('wheel', (e) => {
      this.distance += e.deltaY * 0.01;
      this.distance = Math.max(CAMERA_MIN_DISTANCE, Math.min(CAMERA_MAX_DISTANCE, this.distance));
      e.preventDefault();
    }, { passive: false });
  }

  update(playerPosition, characterYaw, scene, localPlayerMesh) {
    const focusPoint = new THREE.Vector3(
      playerPosition.x,
      playerPosition.y + 1.5,
      playerPosition.z
    );

    // Desired camera position from spherical coordinates
    const offset = new THREE.Vector3(
      Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch) * this.distance,
      Math.sin(this.cameraPitch) * this.distance + 1.5,
      Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch) * this.distance
    );

    const desiredPos = focusPoint.clone().add(offset);

    // Camera collision: raycast from focus point toward desired camera position
    if (scene) {
      const dir = desiredPos.clone().sub(focusPoint).normalize();
      const ray = new THREE.Raycaster(focusPoint, dir, 0, this.distance + 1);
      const hits = ray.intersectObjects(scene.children, true);

      // Find nearest hit that isn't the local player's own mesh
      for (const hit of hits) {
        if (localPlayerMesh && isChildOf(hit.object, localPlayerMesh)) continue;
        if (hit.distance < this.distance && hit.distance > 0.5) {
          const collisionPos = focusPoint.clone().add(dir.multiplyScalar(hit.distance - 0.3));
          this.camera.position.copy(collisionPos);
          this.camera.lookAt(focusPoint);
          return;
        }
      }
    }

    this.camera.position.copy(desiredPos);
    this.camera.lookAt(focusPoint);
  }
}
