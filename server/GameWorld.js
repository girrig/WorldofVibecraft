import { TICK_INTERVAL, MSG } from '../shared/constants.js';
import crypto from 'crypto';

export class GameWorld {
  constructor() {
    this.players = new Map(); // id -> { id, name, ws, position, rotation }
    this.tickInterval = null;
  }

  start() {
    this.tickInterval = setInterval(() => this.tick(), TICK_INTERVAL);
    console.log(`Game world running at ${1000 / TICK_INTERVAL} ticks/sec`);
  }

  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
    }
  }

  addPlayer(ws, name) {
    const id = crypto.randomUUID().slice(0, 8);
    const player = {
      id,
      name,
      ws,
      position: { x: 0, y: 0, z: 0 },
      rotation: 0,
    };
    this.players.set(id, player);

    // Send welcome to the new player
    this.sendTo(ws, {
      type: MSG.WELCOME,
      id,
      players: this.getPlayersData(),
    });

    // Broadcast join to everyone else
    this.broadcast({
      type: MSG.PLAYER_JOINED,
      player: { id, name, position: player.position },
    }, id);

    console.log(`Player "${name}" joined (${id}). Total: ${this.players.size}`);
    return id;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;

    this.players.delete(id);

    this.broadcast({
      type: MSG.PLAYER_LEFT,
      id,
    });

    console.log(`Player "${player.name}" left (${id}). Total: ${this.players.size}`);
  }

  handleMessage(id, data) {
    const player = this.players.get(id);
    if (!player) return;

    switch (data.type) {
      case MSG.MOVE:
        player.position = data.position;
        player.rotation = data.rotation;
        break;

      case MSG.CHAT:
        if (data.message && data.message.trim()) {
          this.broadcast({
            type: MSG.CHAT,
            playerId: id,
            name: player.name,
            message: data.message.trim().slice(0, 200),
          });
        }
        break;
    }
  }

  tick() {
    // Broadcast world state to all players
    const state = {
      type: MSG.STATE,
      players: this.getPlayersData(),
    };

    const msg = JSON.stringify(state);
    for (const [, player] of this.players) {
      if (player.ws.readyState === 1) { // WebSocket.OPEN
        player.ws.send(msg);
      }
    }
  }

  getPlayersData() {
    const data = [];
    for (const [, p] of this.players) {
      data.push({
        id: p.id,
        name: p.name,
        position: p.position,
        rotation: p.rotation,
      });
    }
    return data;
  }

  sendTo(ws, data) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify(data));
    }
  }

  broadcast(data, excludeId = null) {
    const msg = JSON.stringify(data);
    for (const [id, player] of this.players) {
      if (id !== excludeId && player.ws.readyState === 1) {
        player.ws.send(msg);
      }
    }
  }
}
