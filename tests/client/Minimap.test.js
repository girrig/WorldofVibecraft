import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WORLD_SIZE } from '../../shared/constants.js';

// Mock canvas 2D context
const mockCtx = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  fillStyle: '',
  strokeStyle: '',
  lineWidth: 0,
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
};

function setupDOM() {
  const canvas = document.createElement('canvas');
  canvas.id = 'minimap-canvas';
  canvas.getContext = vi.fn(() => mockCtx);
  document.body.appendChild(canvas);
}

import { Minimap } from '../../client/ui/Minimap.js';

describe('Minimap', () => {
  let minimap;

  beforeEach(() => {
    document.body.innerHTML = '';
    setupDOM();
    vi.clearAllMocks();
    minimap = new Minimap();
  });

  describe('constructor', () => {
    it('initializes with size 150', () => {
      expect(minimap.size).toBe(150);
    });

    it('calculates scale from world size', () => {
      expect(minimap.scale).toBe(150 / WORLD_SIZE);
    });

    it('gets canvas context', () => {
      expect(minimap.ctx).toBe(mockCtx);
    });
  });

  describe('update', () => {
    const localPlayer = {
      position: { x: 10, y: 0, z: -20 },
      rotation: 1.0,
    };

    const remotePlayers = new Map([
      ['r1', { currentPos: { x: 50, z: 30 }, color: 0xff0000 }],
      ['r2', { currentPos: { x: -100, z: 80 }, color: 0x00ff00 }],
    ]);

    it('clears the canvas', () => {
      minimap.update(localPlayer, remotePlayers);
      expect(mockCtx.clearRect).toHaveBeenCalledWith(0, 0, 150, 150);
    });

    it('draws background', () => {
      minimap.update(localPlayer, remotePlayers);
      expect(mockCtx.fillRect).toHaveBeenCalled();
    });

    it('draws grid lines', () => {
      minimap.update(localPlayer, remotePlayers);
      // 6 vertical + 6 horizontal grid lines = 12 beginPath calls for grid alone
      expect(mockCtx.beginPath).toHaveBeenCalled();
      expect(mockCtx.stroke).toHaveBeenCalled();
    });

    it('draws remote players', () => {
      minimap.update(localPlayer, remotePlayers);
      // arc is called for each remote player + local player = 3
      expect(mockCtx.arc).toHaveBeenCalledTimes(3);
    });

    it('draws local player with direction arrow', () => {
      minimap.update(localPlayer, remotePlayers);
      // lineTo is called for grid lines, crosshair, and direction arrow
      expect(mockCtx.lineTo).toHaveBeenCalled();
    });

    it('works with empty remote players', () => {
      expect(() => minimap.update(localPlayer, new Map())).not.toThrow();
      // Only local player arc
      expect(mockCtx.arc).toHaveBeenCalledTimes(1);
    });
  });
});
