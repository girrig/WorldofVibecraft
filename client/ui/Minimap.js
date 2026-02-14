import { WORLD_SIZE } from '../../shared/constants.js';

export class Minimap {
  constructor() {
    this.canvas = document.getElementById('minimap-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.size = 150;
    this.scale = this.size / WORLD_SIZE;
  }

  update(localPlayer, remotePlayers) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.size, this.size);

    // Background
    ctx.fillStyle = 'rgba(30, 60, 30, 0.8)';
    ctx.fillRect(0, 0, this.size, this.size);

    // Grid lines
    ctx.strokeStyle = 'rgba(100, 140, 100, 0.3)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= this.size; i += this.size / 5) {
      ctx.beginPath();
      ctx.moveTo(i, 0);
      ctx.lineTo(i, this.size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, i);
      ctx.lineTo(this.size, i);
      ctx.stroke();
    }

    // Center crosshair (world origin)
    ctx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
    ctx.lineWidth = 1;
    const cx = this.size / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 3, cx);
    ctx.lineTo(cx + 3, cx);
    ctx.moveTo(cx, cx - 3);
    ctx.lineTo(cx, cx + 3);
    ctx.stroke();

    // Draw remote players as dots
    for (const [, rp] of remotePlayers) {
      const px = (rp.currentPos.x + WORLD_SIZE / 2) * this.scale;
      const py = (rp.currentPos.z + WORLD_SIZE / 2) * this.scale;
      ctx.fillStyle = '#' + rp.color.toString(16).padStart(6, '0');
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw local player (larger, with direction indicator)
    const lpx = (localPlayer.position.x + WORLD_SIZE / 2) * this.scale;
    const lpy = (localPlayer.position.z + WORLD_SIZE / 2) * this.scale;

    ctx.fillStyle = '#ffff00';
    ctx.beginPath();
    ctx.arc(lpx, lpy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Direction arrow
    const arrowLen = 6;
    const ax = lpx + Math.sin(localPlayer.rotation) * -arrowLen;
    const ay = lpy + Math.cos(localPlayer.rotation) * -arrowLen;
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(lpx, lpy);
    ctx.lineTo(ax, ay);
    ctx.stroke();
  }
}
