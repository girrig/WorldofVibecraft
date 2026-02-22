import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock three and addons BEFORE importing Player
vi.mock('three', () => import('../__mocks__/three.js'));
vi.mock('three/addons/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class { load() {} },
}));
vi.mock('three/addons/utils/SkeletonUtils.js', () => ({
  clone: (src) => {
    const { Group } = require('../__mocks__/three.js');
    return new Group();
  },
}));

import { LocalPlayer, getPlayerColor } from '../../client/entities/Player.js';
import { RUN_SPEED, WALK_FACTOR, BACKPEDAL_FACTOR, TURN_SPEED, GRAVITY, JUMP_VELOCITY } from '../../shared/constants.js';
import { getTerrainHeight } from '../../client/world/Terrain.js';

// Mock controls object
function createMockControls(overrides = {}) {
  return {
    rightMouseDown: false,
    leftMouseDown: false,
    bothButtonsForward: false,
    cameraYaw: 0,
    ...overrides,
  };
}

describe('getPlayerColor', () => {
  it('returns a number', () => {
    expect(typeof getPlayerColor('abc')).toBe('number');
  });

  it('is deterministic for the same ID', () => {
    expect(getPlayerColor('player1')).toBe(getPlayerColor('player1'));
  });

  it('can produce different colors for different IDs', () => {
    const colors = new Set();
    for (let i = 0; i < 20; i++) {
      colors.add(getPlayerColor(`player_${i}`));
    }
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('LocalPlayer', () => {
  let player;
  const dt = 1 / 60; // 60 FPS frame

  beforeEach(() => {
    player = new LocalPlayer('test123', 'TestPlayer');
  });

  describe('constructor', () => {
    it('initializes position at origin', () => {
      expect(player.position.x).toBe(0);
      expect(player.position.y).toBe(0);
      expect(player.position.z).toBe(0);
    });

    it('initializes all keys as not pressed', () => {
      Object.values(player.keys).forEach(v => expect(v).toBe(false));
    });

    it('starts with autorun off', () => {
      expect(player.autorun).toBe(false);
    });

    it('starts in run mode (not walk)', () => {
      expect(player.walkMode).toBe(false);
    });

    it('stores id and name', () => {
      expect(player.id).toBe('test123');
      expect(player.name).toBe('TestPlayer');
    });

    it('has a mesh group', () => {
      expect(player.mesh).toBeDefined();
      expect(player.mesh.position).toBeDefined();
    });

    it('starts grounded with zero vertical velocity', () => {
      expect(player.grounded).toBe(true);
      expect(player.velocityY).toBe(0);
    });

    it('includes space key in keys', () => {
      expect(player.keys).toHaveProperty(' ');
      expect(player.keys[' ']).toBe(false);
    });
  });

  describe('setKey', () => {
    it('sets known movement keys', () => {
      player.setKey('w', true);
      expect(player.keys.w).toBe(true);
      player.setKey('w', false);
      expect(player.keys.w).toBe(false);
    });

    it('ignores unknown keys', () => {
      player.setKey('x', true);
      expect(player.keys).not.toHaveProperty('x');
    });

    it('toggles autorun on NumLock press', () => {
      expect(player.autorun).toBe(false);
      player.setKey('numlock', true);
      expect(player.autorun).toBe(true);
      player.setKey('numlock', true);
      expect(player.autorun).toBe(false);
    });

    it('does not toggle autorun on NumLock release', () => {
      player.setKey('numlock', true); // on
      player.setKey('numlock', false); // release — should not toggle
      expect(player.autorun).toBe(true);
    });
  });

  describe('getState', () => {
    it('returns position as plain object with x,y,z', () => {
      player.position.x = 10;
      player.position.y = 2;
      player.position.z = -5;
      const state = player.getState();
      expect(state.position).toEqual({ x: 10, y: 2, z: -5 });
    });

    it('returns rotation as number', () => {
      player.characterYaw = 1.5;
      expect(player.getState().rotation).toBe(1.5);
    });
  });

  describe('update — standing still', () => {
    it('does not change x/z position when no keys pressed', () => {
      const startX = player.position.x;
      const startZ = player.position.z;
      player.update(dt, createMockControls());
      expect(player.position.x).toBe(startX);
      expect(player.position.z).toBe(startZ);
    });
  });

  describe('update — forward movement (W key)', () => {
    it('moves player when W is pressed', () => {
      player.setKey('w', true);
      player.update(1.0, createMockControls());
      // With characterYaw=0, forward (-Z in local) should move in -Z world direction
      // After applyAxisAngle with yaw=0, direction stays the same
      const dist = Math.sqrt(player.position.x ** 2 + player.position.z ** 2);
      expect(dist).toBeCloseTo(RUN_SPEED, 1);
    });

    it('moves at run speed by default', () => {
      player.setKey('w', true);
      const bigDt = 1.0;
      player.update(bigDt, createMockControls());
      const dist = Math.sqrt(player.position.x ** 2 + player.position.z ** 2);
      expect(dist).toBeCloseTo(RUN_SPEED * bigDt, 1);
    });

    it('moves at walk speed when walk mode is on', () => {
      player.walkMode = true;
      player.setKey('w', true);
      player.update(1.0, createMockControls());
      const dist = Math.sqrt(player.position.x ** 2 + player.position.z ** 2);
      expect(dist).toBeCloseTo(RUN_SPEED * WALK_FACTOR, 1);
    });
  });

  describe('update — backward movement (S key)', () => {
    it('moves backward at backpedal speed', () => {
      player.setKey('s', true);
      player.update(1.0, createMockControls());
      const dist = Math.sqrt(player.position.x ** 2 + player.position.z ** 2);
      expect(dist).toBeCloseTo(RUN_SPEED * BACKPEDAL_FACTOR, 1);
    });

    it('S key cancels autorun', () => {
      player.autorun = true;
      player.setKey('s', true);
      player.update(dt, createMockControls());
      expect(player.autorun).toBe(false);
    });

    it('S does not move backward while also holding W', () => {
      player.setKey('w', true);
      player.setKey('s', true);
      player.update(1.0, createMockControls());
      // W is forward, S just cancels autorun but doesn't add backward since W is held
      // moveZ = -1 (from W), speed = RUN_SPEED (not backpedal since W dominates)
      const dist = Math.sqrt(player.position.x ** 2 + player.position.z ** 2);
      expect(dist).toBeCloseTo(RUN_SPEED, 1);
    });
  });

  describe('update — keyboard turning (A/D)', () => {
    it('A key turns character left when right-click NOT held', () => {
      const startYaw = player.characterYaw;
      player.setKey('a', true);
      player.update(1.0, createMockControls({ rightMouseDown: false }));
      expect(player.characterYaw).toBeGreaterThan(startYaw);
      expect(player.characterYaw).toBeCloseTo(startYaw + TURN_SPEED, 1);
    });

    it('D key turns character right when right-click NOT held', () => {
      const startYaw = player.characterYaw;
      player.setKey('d', true);
      player.update(1.0, createMockControls({ rightMouseDown: false }));
      expect(player.characterYaw).toBeLessThan(startYaw);
    });

    it('A/D do not turn when right-click IS held (they strafe instead)', () => {
      player.setKey('a', true);
      player.update(dt, createMockControls({ rightMouseDown: true, cameraYaw: 0 }));
      // Character yaw snaps to camera yaw (0), no keyboard turning
      expect(player.characterYaw).toBe(0);
    });
  });

  describe('update — strafing', () => {
    it('Q key strafes left', () => {
      player.setKey('q', true);
      player.update(1.0, createMockControls());
      // moveX = -1, should produce lateral movement
      expect(player.position.x !== 0 || player.position.z !== 0).toBe(true);
    });

    it('E key strafes right', () => {
      player.setKey('e', true);
      player.update(1.0, createMockControls());
      expect(player.position.x !== 0 || player.position.z !== 0).toBe(true);
    });

    it('A + right-click strafes left', () => {
      player.setKey('a', true);
      player.update(1.0, createMockControls({ rightMouseDown: true, cameraYaw: 0 }));
      // With right-click held, A becomes strafe
      const dist = Math.sqrt(player.position.x ** 2 + player.position.z ** 2);
      expect(dist).toBeGreaterThan(0);
    });

    it('D + right-click strafes right', () => {
      player.setKey('d', true);
      player.update(1.0, createMockControls({ rightMouseDown: true, cameraYaw: 0 }));
      const dist = Math.sqrt(player.position.x ** 2 + player.position.z ** 2);
      expect(dist).toBeGreaterThan(0);
    });
  });

  describe('update — autorun', () => {
    it('autorun moves forward without W key', () => {
      player.autorun = true;
      player.update(1.0, createMockControls());
      const dist = Math.sqrt(player.position.x ** 2 + player.position.z ** 2);
      expect(dist).toBeCloseTo(RUN_SPEED, 1);
    });
  });

  describe('update — both-buttons forward', () => {
    it('both mouse buttons triggers forward movement', () => {
      player.update(1.0, createMockControls({ bothButtonsForward: true }));
      const dist = Math.sqrt(player.position.x ** 2 + player.position.z ** 2);
      expect(dist).toBeCloseTo(RUN_SPEED, 1);
    });
  });

  describe('update — diagonal normalization', () => {
    it('diagonal movement is not faster than cardinal', () => {
      // Cardinal: W only
      const cardinalPlayer = new LocalPlayer('c', 'C');
      cardinalPlayer.setKey('w', true);
      cardinalPlayer.update(1.0, createMockControls());
      const cardinalDist = Math.sqrt(cardinalPlayer.position.x ** 2 + cardinalPlayer.position.z ** 2);

      // Diagonal: W + Q
      const diagPlayer = new LocalPlayer('d', 'D');
      diagPlayer.setKey('w', true);
      diagPlayer.setKey('q', true);
      diagPlayer.update(1.0, createMockControls());
      const diagDist = Math.sqrt(diagPlayer.position.x ** 2 + diagPlayer.position.z ** 2);

      expect(diagDist).toBeCloseTo(cardinalDist, 1);
    });
  });

  describe('update — right-click snaps yaw to camera', () => {
    it('character yaw matches camera yaw when right-click held', () => {
      player.characterYaw = 1.0;
      player.update(dt, createMockControls({ rightMouseDown: true, cameraYaw: 2.5 }));
      expect(player.characterYaw).toBe(2.5);
    });
  });

  describe('update — world boundary clamping', () => {
    it('clamps position to ±250 on X axis', () => {
      player.position.x = 300;
      player.update(dt, createMockControls());
      expect(player.position.x).toBeLessThanOrEqual(250);
    });

    it('clamps position to ±250 on Z axis', () => {
      player.position.z = -300;
      player.update(dt, createMockControls());
      expect(player.position.z).toBeGreaterThanOrEqual(-250);
    });
  });

  describe('update — terrain snapping', () => {
    it('Y position matches terrain height after update', () => {
      player.position.x = 10;
      player.position.z = 20;
      player.update(dt, createMockControls());
      // getTerrainHeight formula at (10, 20)
      const expected =
        Math.sin(10 * 0.02) * 1.5 +
        Math.cos(20 * 0.02) * 1.5 +
        Math.sin(10 * 0.05 + 20 * 0.03) * 0.8;
      expect(player.position.y).toBeCloseTo(expected, 5);
    });
  });

  describe('update — animation states', () => {
    it('plays Stand when not moving', () => {
      // Spy on playAnimation
      const spy = vi.spyOn(player, 'playAnimation');
      player.update(dt, createMockControls());
      expect(spy).toHaveBeenCalledWith('Stand');
    });

    it('plays Run when moving forward in run mode', () => {
      player.setKey('w', true);
      const spy = vi.spyOn(player, 'playAnimation');
      player.update(dt, createMockControls());
      expect(spy).toHaveBeenCalledWith('Run');
    });

    it('plays Walk when moving forward in walk mode', () => {
      player.walkMode = true;
      player.setKey('w', true);
      const spy = vi.spyOn(player, 'playAnimation');
      player.update(dt, createMockControls());
      expect(spy).toHaveBeenCalledWith('Walk');
    });

    it('plays WalkBackwards when moving backward', () => {
      player.setKey('s', true);
      const spy = vi.spyOn(player, 'playAnimation');
      player.update(dt, createMockControls());
      expect(spy).toHaveBeenCalledWith('WalkBackwards');
    });

    it('plays Run when only strafing (Q key)', () => {
      player.setKey('q', true);
      const spy = vi.spyOn(player, 'playAnimation');
      player.update(dt, createMockControls());
      expect(spy).toHaveBeenCalledWith('Run');
    });

    it('plays Run when moving forward + strafing', () => {
      player.setKey('w', true);
      player.setKey('q', true);
      const spy = vi.spyOn(player, 'playAnimation');
      player.update(dt, createMockControls());
      expect(spy).toHaveBeenCalledWith('Run');
    });
  });

  describe('update — split body rotation', () => {
    it('forward + strafe left converges to +45° (PI/4)', () => {
      player.setKey('w', true);
      player.setKey('q', true);
      for (let i = 0; i < 30; i++) player.update(dt, createMockControls());
      expect(player.currentLowerBodyTurn).toBeCloseTo(Math.PI / 4, 1);
    });

    it('forward + strafe right converges to -45° (-PI/4)', () => {
      player.setKey('w', true);
      player.setKey('e', true);
      for (let i = 0; i < 30; i++) player.update(dt, createMockControls());
      expect(player.currentLowerBodyTurn).toBeCloseTo(-Math.PI / 4, 1);
    });

    it('pure strafe left converges to +90° (PI/2)', () => {
      player.setKey('q', true);
      for (let i = 0; i < 30; i++) player.update(dt, createMockControls());
      expect(player.currentLowerBodyTurn).toBeCloseTo(Math.PI / 2, 1);
    });

    it('pure strafe right converges to -90° (-PI/2)', () => {
      player.setKey('e', true);
      for (let i = 0; i < 30; i++) player.update(dt, createMockControls());
      expect(player.currentLowerBodyTurn).toBeCloseTo(-Math.PI / 2, 1);
    });

    it('no lower body turn when moving straight forward', () => {
      player.setKey('w', true);
      for (let i = 0; i < 30; i++) player.update(dt, createMockControls());
      expect(player.currentLowerBodyTurn).toBeCloseTo(0, 5);
    });

    it('no lower body turn when backpedaling', () => {
      player.setKey('s', true);
      for (let i = 0; i < 30; i++) player.update(dt, createMockControls());
      expect(player.currentLowerBodyTurn).toBeCloseTo(0, 5);
    });

    it('lower body turn returns to zero when stopping', () => {
      player.setKey('w', true);
      player.setKey('q', true);
      for (let i = 0; i < 30; i++) player.update(dt, createMockControls());
      expect(player.currentLowerBodyTurn).not.toBeCloseTo(0, 2);
      player.setKey('w', false);
      player.setKey('q', false);
      for (let i = 0; i < 60; i++) player.update(dt, createMockControls());
      expect(player.currentLowerBodyTurn).toBeCloseTo(0, 2);
    });

    it('mesh rotation includes lower body offset during diagonal movement', () => {
      player.setKey('w', true);
      player.setKey('q', true);
      for (let i = 0; i < 30; i++) player.update(dt, createMockControls());
      expect(player.mesh.rotation.y).toBeCloseTo(
        player.characterYaw + player.currentLowerBodyTurn, 5
      );
    });
  });

  describe('update — jumping', () => {
    // Player starts at y=0 but terrain at origin is ~1.5, so we must
    // ground the player first before testing jumps.
    function groundPlayer() {
      player.update(dt, createMockControls());
    }

    it('space key initiates jump when grounded', () => {
      groundPlayer();
      player.setKey(' ', true);
      player.update(dt, createMockControls());
      expect(player.grounded).toBe(false);
      expect(player.velocityY).toBeGreaterThan(0);
    });

    it('sets velocityY to JUMP_VELOCITY on jump', () => {
      groundPlayer();
      player.setKey(' ', true);
      player.update(dt, createMockControls());
      // velocityY will have had one frame of gravity applied already
      expect(player.velocityY).toBeCloseTo(JUMP_VELOCITY - GRAVITY * dt, 3);
    });

    it('cannot double jump', () => {
      groundPlayer();
      player.setKey(' ', true);
      player.update(dt, createMockControls());
      const velAfterFirstFrame = player.velocityY;
      player.update(dt, createMockControls());
      // Velocity should decrease due to gravity, not reset to JUMP_VELOCITY
      expect(player.velocityY).toBeLessThan(velAfterFirstFrame);
    });

    it('gravity decreases vertical velocity over time', () => {
      groundPlayer();
      player.setKey(' ', true);
      player.update(dt, createMockControls());
      player.setKey(' ', false);
      const vel1 = player.velocityY;
      player.update(dt, createMockControls());
      const vel2 = player.velocityY;
      expect(vel2).toBeLessThan(vel1);
      expect(vel1 - vel2).toBeCloseTo(GRAVITY * dt, 3);
    });

    it('player rises above terrain while jumping', () => {
      groundPlayer();
      const terrainY = getTerrainHeight(player.position.x, player.position.z);
      player.setKey(' ', true);
      for (let i = 0; i < 10; i++) player.update(dt, createMockControls());
      expect(player.position.y).toBeGreaterThan(terrainY);
    });

    it('player lands back on terrain after jump completes', () => {
      groundPlayer();
      player.setKey(' ', true);
      player.update(dt, createMockControls());
      player.setKey(' ', false);
      // Simulate enough frames for full jump arc (~0.825s at 60fps ≈ 50 frames)
      for (let i = 0; i < 60; i++) player.update(dt, createMockControls());
      expect(player.grounded).toBe(true);
      expect(player.velocityY).toBe(0);
      const terrainY = getTerrainHeight(player.position.x, player.position.z);
      expect(player.position.y).toBeCloseTo(terrainY, 3);
    });

    it('jump peak height matches WoW physics (~1.64 yards)', () => {
      groundPlayer();
      player.setKey(' ', true);
      player.update(dt, createMockControls());
      player.setKey(' ', false);
      let maxHeight = 0;
      for (let i = 0; i < 60; i++) {
        player.update(dt, createMockControls());
        const heightAboveTerrain = player.position.y - getTerrainHeight(player.position.x, player.position.z);
        if (heightAboveTerrain > maxHeight) maxHeight = heightAboveTerrain;
      }
      const expectedPeak = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * GRAVITY);
      expect(maxHeight).toBeCloseTo(expectedPeak, 1);
    });

    it('jump airtime matches WoW physics (~0.825s)', () => {
      groundPlayer();
      player.setKey(' ', true);
      player.update(dt, createMockControls());
      player.setKey(' ', false);
      let frames = 1;
      while (!player.grounded && frames < 120) {
        player.update(dt, createMockControls());
        frames++;
      }
      const airtime = frames * dt;
      const expectedAirtime = (2 * JUMP_VELOCITY) / GRAVITY;
      expect(airtime).toBeCloseTo(expectedAirtime, 1);
    });

    it('allows horizontal movement while airborne (air control)', () => {
      groundPlayer();
      player.setKey(' ', true);
      player.update(dt, createMockControls());
      player.setKey(' ', false);
      player.setKey('w', true);
      const xBefore = player.position.x;
      const zBefore = player.position.z;
      player.update(dt, createMockControls());
      const dist = Math.sqrt(
        (player.position.x - xBefore) ** 2 +
        (player.position.z - zBefore) ** 2
      );
      expect(dist).toBeGreaterThan(0);
      expect(player.grounded).toBe(false);
    });

    it('holding space produces repeated jumps (bunny hop)', () => {
      groundPlayer();
      player.setKey(' ', true);
      // Jump and land (~50 frames), then check we jumped again
      for (let i = 0; i < 60; i++) player.update(dt, createMockControls());
      expect(player.grounded).toBe(false); // immediately jumped again on landing
    });

    it('plays Jump animation when airborne', () => {
      groundPlayer();
      player.setKey(' ', true);
      player.update(dt, createMockControls());
      // Now airborne, next update should play Jump
      const spy = vi.spyOn(player, 'playAnimation');
      player.update(dt, createMockControls());
      expect(spy).toHaveBeenCalledWith('Jump');
    });

    it('plays ground animation after landing', () => {
      groundPlayer();
      player.setKey(' ', true);
      player.update(dt, createMockControls());
      player.setKey(' ', false);
      // Land
      for (let i = 0; i < 60; i++) player.update(dt, createMockControls());
      const spy = vi.spyOn(player, 'playAnimation');
      player.update(dt, createMockControls());
      expect(spy).toHaveBeenCalledWith('Stand');
    });

    it('terrain snapping still works when grounded', () => {
      player.position.x = 10;
      player.position.z = 20;
      player.update(dt, createMockControls());
      expect(player.grounded).toBe(true);
      const expected = getTerrainHeight(player.position.x, player.position.z);
      expect(player.position.y).toBeCloseTo(expected, 5);
    });
  });

  describe('update — mesh sync', () => {
    it('mesh position matches player position after update', () => {
      player.setKey('w', true);
      player.update(1.0, createMockControls());
      expect(player.mesh.position.x).toBeCloseTo(player.position.x, 5);
      expect(player.mesh.position.y).toBeCloseTo(player.position.y, 5);
      expect(player.mesh.position.z).toBeCloseTo(player.position.z, 5);
    });

    it('mesh rotation matches characterYaw when standing still', () => {
      player.characterYaw = 1.5;
      player.update(dt, createMockControls());
      expect(player.mesh.rotation.y).toBeCloseTo(player.characterYaw, 5);
    });
  });
});
