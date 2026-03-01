import * as THREE from 'three';
import { RUN_SPEED, WALK_FACTOR, BACKPEDAL_FACTOR, TURN_SPEED, GRAVITY, JUMP_VELOCITY, WORLD_SIZE } from '../../shared/constants.js';
import { getTerrainHeight } from '../world/Terrain.js';
import { resolveMovement } from '../world/CollisionSystem.js';
import { getPlayerColor, createPlayerMesh } from './PlayerModel.js';

export { preloadPlayerModel } from './PlayerModel.js';

const FADE_DURATION = 0.2; // seconds for animation crossfade
const LOWER_BODY_TURN_FRACTION = 1.0; // full rotation toward movement direction (matches classic WoW)
const TWIST_SPEED = 40; // near-instant transition (~2-4 frames at 60fps, matches classic WoW)

export class LocalPlayer {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.position = new THREE.Vector3(0, 0, 0);
    this.characterYaw = 0;
    this.color = getPlayerColor(id);

    const { group, mixer, actions, spineBone } = createPlayerMesh(this.color);
    this.mesh = group;
    this.mixer = mixer;
    this.actions = actions;
    this.currentAction = null;
    this.spineBone = spineBone;
    this.currentLowerBodyTurn = 0;

    // Start with idle animation
    this.playAnimation('Stand');

    // Movement keys
    this.keys = { w: false, a: false, s: false, d: false, q: false, e: false, ' ': false };

    // Autorun
    this.autorun = false;

    // Walk/Run toggle (false = run, true = walk)
    this.walkMode = false;

    // Jump state
    this.velocityY = 0;
    this.grounded = true;
    this.airVelocity = null; // locked horizontal velocity while airborne
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

    // Compute world-space velocity from current inputs (used for ground movement + jump takeoff)
    let groundVelX = 0, groundVelZ = 0;
    if (isMoving) {
      const dir = moveDir.clone().normalize();
      dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), this.characterYaw);
      groundVelX = dir.x * speed;
      groundVelZ = dir.z * speed;
    }

    let dx = 0, dz = 0;
    if (this.grounded) {
      dx = groundVelX * dt;
      dz = groundVelZ * dt;
    } else if (this.airVelocity) {
      dx = this.airVelocity.x * dt;
      dz = this.airVelocity.z * dt;
    }
    if (dx !== 0 || dz !== 0) {
      const resolved = resolveMovement(
        this.position.x, this.position.z,
        this.position.x + dx, this.position.z + dz,
        this.position.y
      );
      this.position.x = resolved.x;
      this.position.z = resolved.z;
    }

    // --- Animation state ---
    if (!this.grounded) {
      this.playAnimation('Jump');
    } else if (!isMoving) {
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

    // --- Split body: lower body turns toward diagonal movement direction ---
    // While airborne, freeze the twist at its takeoff value (WoW-style)
    if (this.grounded) {
      let lowerBodyTarget = 0;
      if (isMoving && Math.abs(moveX) > 0) {
        // Forward/backward + strafe: rotate lower body toward actual movement direction
        // When backpedaling, negate angle so legs turn toward the correct diagonal
        const sign = moveZ > 0 ? -1 : 1;
        const localAngle = Math.atan2(moveX, Math.abs(moveZ));
        lowerBodyTarget = sign * -localAngle * LOWER_BODY_TURN_FRACTION;
      }
      this.currentLowerBodyTurn += (lowerBodyTarget - this.currentLowerBodyTurn) * Math.min(1, TWIST_SPEED * dt);
    }

    // Counter-rotate spine so upper body keeps facing character direction
    if (this.spineBone && Math.abs(this.currentLowerBodyTurn) > 0.001) {
      const twistQuat = new THREE.Quaternion();
      twistQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -this.currentLowerBodyTurn);
      this.spineBone.quaternion.multiply(twistQuat);
    }

    // --- Vertical physics ---
    const terrainY = getTerrainHeight(this.position.x, this.position.z);

    if (this.keys[' '] && this.grounded) {
      this.velocityY = JUMP_VELOCITY;
      this.grounded = false;

      // Lock in horizontal velocity at takeoff (WoW-style: no air control)
      if (isMoving) {
        this.airVelocity = new THREE.Vector3(groundVelX, 0, groundVelZ);
      } else {
        this.airVelocity = null; // standing jump, no horizontal movement
      }
    }

    if (!this.grounded) {
      // Velocity-Verlet: exact for constant acceleration
      this.position.y += this.velocityY * dt - 0.5 * GRAVITY * dt * dt;
      this.velocityY -= GRAVITY * dt;

      if (this.position.y <= terrainY) {
        this.position.y = terrainY;
        this.velocityY = 0;
        this.grounded = true;
        this.airVelocity = null;
      }
    } else {
      this.position.y = terrainY;
    }

    // Clamp to world bounds
    const halfWorld = WORLD_SIZE / 2;
    this.position.x = Math.max(-halfWorld, Math.min(halfWorld, this.position.x));
    this.position.z = Math.max(-halfWorld, Math.min(halfWorld, this.position.z));

    // Update mesh
    this.mesh.position.copy(this.position);
    this.mesh.rotation.y = this.characterYaw + this.currentLowerBodyTurn;
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
