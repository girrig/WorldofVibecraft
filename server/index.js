import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import path from 'path';
import { GameWorld } from './GameWorld.js';
import { SERVER_PORT, MSG } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = createServer(app);

// Serve static client files (for production)
app.use(express.static(path.join(__dirname, '..', 'client')));

// WebSocket server
const wss = new WebSocketServer({ server });
const world = new GameWorld();

// Track player IDs by WebSocket
const wsPlayerMap = new WeakMap();

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);

      if (data.type === MSG.JOIN && !playerId) {
        const name = (data.name || 'Unknown').trim().slice(0, 20);
        playerId = world.addPlayer(ws, name);
        wsPlayerMap.set(ws, playerId);
      } else if (playerId) {
        world.handleMessage(playerId, data);
      }
    } catch (err) {
      console.error('Bad message:', err.message);
    }
  });

  ws.on('close', () => {
    if (playerId) {
      world.removePlayer(playerId);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// Start
world.start();
server.listen(SERVER_PORT, () => {
  console.log(`\n  World of Vibecraft server running on http://localhost:${SERVER_PORT}`);
  console.log(`  Waiting for players...\n`);
});
