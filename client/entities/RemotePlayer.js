import * as THREE from 'three';
import { createPlayerMesh, getPlayerColor } from './Player.js';

export class RemotePlayer {
  constructor(id, name, position) {
    this.id = id;
    this.name = name;
    this.color = getPlayerColor(id);
    this.mesh = createPlayerMesh(this.color);

    // Position interpolation
    this.currentPos = new THREE.Vector3(position.x, position.y, position.z);
    this.targetPos = new THREE.Vector3(position.x, position.y, position.z);
    this.currentRot = 0;
    this.targetRot = 0;

    this.mesh.position.copy(this.currentPos);

    // Nameplate
    this.nameplate = this.createNameplate(name);
    this.mesh.add(this.nameplate);
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
    // Handle wrap-around
    while (rotDiff > Math.PI) rotDiff -= Math.PI * 2;
    while (rotDiff < -Math.PI) rotDiff += Math.PI * 2;
    this.currentRot += rotDiff * lerpFactor;
    this.mesh.rotation.y = this.currentRot;
  }

  dispose() {
    this.mesh.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    });
  }
}
