import { describe, it, expect } from 'vitest';
import {
  TICK_RATE, TICK_INTERVAL, WORLD_SIZE, SPAWN_AREA,
  RUN_SPEED, WALK_FACTOR, BACKPEDAL_FACTOR, TURN_SPEED,
  PLAYER_HEIGHT, PLAYER_RADIUS,
  CAMERA_MIN_DISTANCE, CAMERA_MAX_DISTANCE, CAMERA_DEFAULT_DISTANCE, CAMERA_SENSITIVITY,
  SERVER_PORT, WS_PORT, MSG,
} from '../../shared/constants.js';

describe('Game Constants', () => {
  it('tick rate produces correct interval', () => {
    expect(TICK_RATE).toBe(20);
    expect(TICK_INTERVAL).toBe(50);
  });

  it('world size is positive', () => {
    expect(WORLD_SIZE).toBeGreaterThan(0);
  });

  it('spawn area is smaller than world', () => {
    expect(SPAWN_AREA).toBeGreaterThan(0);
    expect(SPAWN_AREA).toBeLessThan(WORLD_SIZE);
  });

  it('movement speeds are positive', () => {
    expect(RUN_SPEED).toBeGreaterThan(0);
    expect(TURN_SPEED).toBeGreaterThan(0);
  });

  it('walk factor slows movement below run speed', () => {
    expect(WALK_FACTOR).toBeGreaterThan(0);
    expect(WALK_FACTOR).toBeLessThan(1);
  });

  it('backpedal factor slows movement below run speed', () => {
    expect(BACKPEDAL_FACTOR).toBeGreaterThan(0);
    expect(BACKPEDAL_FACTOR).toBeLessThan(1);
  });

  it('camera distance constraints are ordered', () => {
    expect(CAMERA_MIN_DISTANCE).toBeGreaterThan(0);
    expect(CAMERA_MIN_DISTANCE).toBeLessThan(CAMERA_DEFAULT_DISTANCE);
    expect(CAMERA_DEFAULT_DISTANCE).toBeLessThan(CAMERA_MAX_DISTANCE);
  });

  it('camera sensitivity is small positive value', () => {
    expect(CAMERA_SENSITIVITY).toBeGreaterThan(0);
    expect(CAMERA_SENSITIVITY).toBeLessThan(1);
  });

  it('player dimensions are positive', () => {
    expect(PLAYER_HEIGHT).toBeGreaterThan(0);
    expect(PLAYER_RADIUS).toBeGreaterThan(0);
  });

  it('MSG enum has all required message types', () => {
    expect(MSG.JOIN).toBeDefined();
    expect(MSG.LEAVE).toBeDefined();
    expect(MSG.MOVE).toBeDefined();
    expect(MSG.CHAT).toBeDefined();
    expect(MSG.WELCOME).toBeDefined();
    expect(MSG.PLAYER_JOINED).toBeDefined();
    expect(MSG.PLAYER_LEFT).toBeDefined();
    expect(MSG.STATE).toBeDefined();
  });

  it('MSG values are unique strings', () => {
    const values = Object.values(MSG);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    values.forEach(v => expect(typeof v).toBe('string'));
  });
});
