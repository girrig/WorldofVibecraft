export const TICK_RATE = 20; // Server ticks per second
export const TICK_INTERVAL = 1000 / TICK_RATE;

export const WORLD_SIZE = 500; // World extends from -250 to +250
export const SPAWN_AREA = 20; // Players spawn within this radius of origin

// Movement (WoW-style)
export const RUN_SPEED = 7; // Units per second (forward)
export const WALK_FACTOR = 2.5 / 7;   // Walk = 2.5 yd/s (WoW default)
export const BACKPEDAL_FACTOR = 4.5 / 7; // Backpedal = 4.5 yd/s (WoW default)
export const TURN_SPEED = Math.PI; // 180 degrees per second (keyboard turning)
export const GRAVITY = 19.29110527038574;  // WoW gravity (yards/s²) — from client memory
export const JUMP_VELOCITY = 7.95554;      // WoW jump speed (yards/s) — ~1.64yd height, ~0.825s airtime

export const PLAYER_HEIGHT = 1.8;
export const PLAYER_RADIUS = 0.4;

// Camera
export const CAMERA_MIN_DISTANCE = 1.5;
export const CAMERA_MAX_DISTANCE = 25;
export const CAMERA_DEFAULT_DISTANCE = 8;
export const CAMERA_SENSITIVITY = 0.003;

export const SERVER_PORT = 3001;
export const WS_PORT = 3001;

export const MSG = {
  JOIN: 'join',
  LEAVE: 'leave',
  MOVE: 'move',
  CHAT: 'chat',
  WELCOME: 'welcome',
  PLAYER_JOINED: 'playerJoined',
  PLAYER_LEFT: 'playerLeft',
  STATE: 'state',
};
