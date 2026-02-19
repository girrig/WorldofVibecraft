import { describe, it, expect, beforeEach } from 'vitest';
import { HUD } from '../../client/ui/HUD.js';

function setupDOM() {
  const coords = document.createElement('div');
  coords.id = 'hud-coords';
  document.body.appendChild(coords);

  const players = document.createElement('div');
  players.id = 'hud-players';
  document.body.appendChild(players);

  return { coords, players };
}

describe('HUD', () => {
  let hud, coords, players;

  beforeEach(() => {
    document.body.innerHTML = '';
    const dom = setupDOM();
    coords = dom.coords;
    players = dom.players;
    hud = new HUD();
  });

  describe('constructor', () => {
    it('finds DOM elements', () => {
      expect(hud.coordsEl).toBe(coords);
      expect(hud.playersEl).toBe(players);
    });
  });

  describe('update', () => {
    it('displays rounded position', () => {
      hud.update({ position: { x: 10.7, y: 2.3, z: -5.9 } }, 3);
      expect(coords.textContent).toBe('Position: 11, 2, -6');
    });

    it('displays player count', () => {
      hud.update({ position: { x: 0, y: 0, z: 0 } }, 5);
      expect(players.textContent).toBe('Players online: 5');
    });

    it('handles zero position', () => {
      hud.update({ position: { x: 0, y: 0, z: 0 } }, 1);
      expect(coords.textContent).toBe('Position: 0, 0, 0');
    });

    it('updates on each call', () => {
      hud.update({ position: { x: 1, y: 2, z: 3 } }, 1);
      expect(coords.textContent).toContain('1');
      hud.update({ position: { x: 100, y: 200, z: 300 } }, 10);
      expect(coords.textContent).toContain('100');
      expect(players.textContent).toContain('10');
    });
  });
});
