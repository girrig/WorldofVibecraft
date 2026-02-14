export class HUD {
  constructor() {
    this.coordsEl = document.getElementById('hud-coords');
    this.playersEl = document.getElementById('hud-players');
  }

  update(localPlayer, playerCount) {
    const x = Math.round(localPlayer.position.x);
    const y = Math.round(localPlayer.position.y);
    const z = Math.round(localPlayer.position.z);
    this.coordsEl.textContent = `Position: ${x}, ${y}, ${z}`;
    this.playersEl.textContent = `Players online: ${playerCount}`;
  }
}
