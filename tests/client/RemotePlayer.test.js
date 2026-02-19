import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('three', () => import('../__mocks__/three.js'));
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { load() {} },
}));
vi.mock('three/addons/utils/SkeletonUtils.js', () => ({
  clone: () => {
    const { Group } = require('../__mocks__/three.js');
    return new Group();
  },
}));

// jsdom doesn't support canvas 2D context — mock it
const mockCtx = {
  fillStyle: '',
  font: '',
  textAlign: '',
  fillText: vi.fn(),
  fillRect: vi.fn(),
  fill: vi.fn(),
  roundRect: vi.fn(),
};
HTMLCanvasElement.prototype.getContext = vi.fn(() => mockCtx);

import { RemotePlayer } from '../../client/entities/RemotePlayer.js';

describe('RemotePlayer', () => {
  let player;

  beforeEach(() => {
    player = new RemotePlayer('remote1', 'RemoteGuy', { x: 10, y: 1, z: 20 });
  });

  describe('constructor', () => {
    it('sets initial position from constructor argument', () => {
      expect(player.currentPos.x).toBe(10);
      expect(player.currentPos.y).toBe(1);
      expect(player.currentPos.z).toBe(20);
    });

    it('stores id and name', () => {
      expect(player.id).toBe('remote1');
      expect(player.name).toBe('RemoteGuy');
    });

    it('has a mesh with position', () => {
      expect(player.mesh).toBeDefined();
      expect(player.mesh.position).toBeDefined();
    });
  });

  describe('updateTarget', () => {
    it('sets new target position', () => {
      player.updateTarget({ x: 50, y: 3, z: -10 }, 2.0);
      expect(player.targetPos.x).toBe(50);
      expect(player.targetPos.y).toBe(3);
      expect(player.targetPos.z).toBe(-10);
    });

    it('sets new target rotation', () => {
      player.updateTarget({ x: 0, y: 0, z: 0 }, 1.5);
      expect(player.targetRot).toBe(1.5);
    });
  });

  describe('update — position interpolation', () => {
    it('moves current position toward target', () => {
      player.updateTarget({ x: 100, y: 0, z: 0 }, 0);
      const startX = player.currentPos.x;

      player.update(0.1);

      expect(player.currentPos.x).toBeGreaterThan(startX);
      expect(player.currentPos.x).toBeLessThan(100);
    });

    it('mesh position tracks current position', () => {
      player.updateTarget({ x: 50, y: 0, z: 50 }, 0);
      player.update(0.1);

      expect(player.mesh.position.x).toBeCloseTo(player.currentPos.x, 5);
      expect(player.mesh.position.z).toBeCloseTo(player.currentPos.z, 5);
    });
  });

  describe('update — rotation interpolation', () => {
    it('rotates toward target', () => {
      player.currentRot = 0;
      player.updateTarget({ x: 10, y: 1, z: 20 }, Math.PI / 2);

      player.update(0.1);

      expect(player.currentRot).toBeGreaterThan(0);
      expect(player.currentRot).toBeLessThan(Math.PI / 2);
    });

    it('wraps rotation correctly around PI boundary', () => {
      player.currentRot = Math.PI - 0.1;
      player.updateTarget({ x: 10, y: 1, z: 20 }, -Math.PI + 0.1);

      player.update(0.1);

      // Should rotate the short way around, not the long way
      // The result should be near PI or -PI, not near 0
      expect(Math.abs(player.currentRot)).toBeGreaterThan(Math.PI / 2);
    });

    it('mesh rotation matches current rotation', () => {
      player.currentRot = 1.5;
      player.updateTarget({ x: 10, y: 1, z: 20 }, 1.5);
      player.update(0.1);
      expect(player.mesh.rotation.y).toBeCloseTo(player.currentRot, 5);
    });
  });

  describe('update — animation detection', () => {
    it('plays Run when moving significantly', () => {
      const spy = vi.spyOn(player, 'playAnimation');

      // Move the target far so there's clear movement
      player.updateTarget({ x: 1000, y: 1, z: 20 }, 0);
      player.update(0.05); // First update sets prevPos

      spy.mockClear();
      player.updateTarget({ x: 1000, y: 1, z: 20 }, 0);
      player.update(0.05); // Second update detects movement delta

      expect(spy).toHaveBeenCalledWith('Run');
    });

    it('plays Stand when stationary', () => {
      // Don't move the target — same position
      player.update(0.05); // First update

      const spy = vi.spyOn(player, 'playAnimation');
      player.update(0.05); // Second update — no movement

      expect(spy).toHaveBeenCalledWith('Stand');
    });
  });

  describe('dispose', () => {
    it('does not throw', () => {
      expect(() => player.dispose()).not.toThrow();
    });
  });
});
