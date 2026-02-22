import * as THREE from 'three';
import { createPlayerMesh, getPlayerColor } from './Player.js';
import { getTerrainHeight } from '../world/Terrain.js';

const FADE_DURATION = 0.2;
const MOVE_THRESHOLD = 0.01; // Min distance per update to count as moving

export class RemotePlayer {
  constructor(id, name, position) {
    this.id = id;
    this.name = name;
    this.color = getPlayerColor(id);

    const { group, mixer, actions } = createPlayerMesh(this.color);
    this.mesh = group;
    this.mixer = mixer;
    this.actions = actions;
    this.currentAction = null;

    // Position interpolation
    this.currentPos = new THREE.Vector3(position.x, position.y, position.z);
    this.targetPos = new THREE.Vector3(position.x, position.y, position.z);
    this.prevPos = new THREE.Vector3(position.x, position.y, position.z);
    this.currentRot = 0;
    this.targetRot = 0;

    this.mesh.position.copy(this.currentPos);

    // Start idle
    this.playAnimation('Stand');

    // Nameplate
    this.nameplate = this.createNameplate(name);
    this.mesh.add(this.nameplate);
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

  createNameplate(name) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.roundRect(8, 8, 240, 48, 8);
    ctx.fill();

    ctx.font = 'bold 28px Arial';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c9aa71';
    ctx.fillText(name, 128, 42);

    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.y = 2.3;
    sprite.scale.set(2, 0.5, 1);
    return sprite;
  }

  updateTarget(position, rotation) {
    this.targetPos.set(position.x, position.y, position.z);
    this.targetRot = rotation;
  }

  update(dt) {
    // Smooth interpolation toward target position
    const lerpFactor = 1 - Math.pow(0.001, dt);
    this.currentPos.lerp(this.targetPos, lerpFactor);
    this.mesh.position.copy(this.currentPos);

    // Smooth rotation interpolation
    let rotDiff = this.targetRot - this.currentRot;
    while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
    while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
    this.currentRot += rotDiff * lerpFactor;
    this.mesh.rotation.y = this.currentRot;

    // Detect movement for animation
    const dx = this.currentPos.x - this.prevPos.x;
    const dz = this.currentPos.z - this.prevPos.z;
    const moveDist = Math.sqrt(dx * dx + dz * dz);
    this.prevPos.copy(this.currentPos);

    const terrainY = getTerrainHeight(this.currentPos.x, this.currentPos.z);
    const airborne = this.currentPos.y > terrainY + 0.3;

    if (airborne) {
      this.playAnimation('Jump');
    } else if (moveDist > MOVE_THRESHOLD * dt) {
      this.playAnimation('Run');
    } else {
      this.playAnimation('Stand');
    }

    // Update animation mixer
    if (this.mixer) this.mixer.update(dt);
  }

  dispose() {
    if (this.mixer) this.mixer.stopAllAction();
    this.mesh.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    });
  }
}
