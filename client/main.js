import * as THREE from 'three';
import { MSG, SPAWN_AREA } from '../shared/constants.js';
import { createTerrain } from './world/Terrain.js';
import { createEnvironment, createLighting, createSky } from './world/Environment.js';
import { LocalPlayer } from './entities/Player.js';
import { RemotePlayer } from './entities/RemotePlayer.js';
import { PlayerControls } from './controls/PlayerControls.js';
import { NetworkClient } from './network.js';
import { ChatBox } from './ui/ChatBox.js';
import { Minimap } from './ui/Minimap.js';
import { HUD } from './ui/HUD.js';

// ---- State ----
let scene, camera, renderer, controls;
let localPlayer = null;
let remotePlayers = new Map();
let network = null;
let chatBox = null;
let minimap = null;
let hud = null;
let clock = new THREE.Clock();
let lastSendTime = 0;
const SEND_RATE = 1000 / 20; // Send position 20 times/sec

// ---- Login ----
const loginScreen = document.getElementById('login-screen');
const gameContainer = document.getElementById('game-container');
const nameInput = document.getElementById('player-name');
const joinBtn = document.getElementById('join-btn');

joinBtn.addEventListener('click', startGame);
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startGame();
});

async function startGame() {
  const name = nameInput.value.trim();
  if (!name) {
    nameInput.style.borderColor = '#ff4444';
    return;
  }

  joinBtn.textContent = 'Connecting...';
  joinBtn.disabled = true;

  try {
    // Initialize rendering
    initRenderer();

    // Connect to server
    network = new NetworkClient();
    const welcomeData = await network.connect(name);

    // Hide login, show game
    loginScreen.style.display = 'none';
    gameContainer.style.display = 'block';

    // Initialize game
    initGame(welcomeData, name);

    // Start game loop
    animate();
  } catch (err) {
    console.error('Failed to connect:', err);
    joinBtn.textContent = 'Enter World';
    joinBtn.disabled = false;
    alert('Could not connect to server. Make sure the server is running.');
  }
}

function initRenderer() {
  const canvas = document.getElementById('game-canvas');

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function initGame(welcomeData, name) {
  scene = new THREE.Scene();

  // World
  createSky(scene);
  createLighting(scene);
  scene.add(createTerrain());
  scene.add(createEnvironment());

  // Local player
  localPlayer = new LocalPlayer(welcomeData.id, name);

  // Random spawn position near origin
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.random() * SPAWN_AREA;
  localPlayer.position.set(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);

  scene.add(localPlayer.mesh);

  // Controls
  const canvas = document.getElementById('game-canvas');
  controls = new PlayerControls(camera, canvas);

  // UI
  chatBox = new ChatBox(network);
  minimap = new Minimap();
  hud = new HUD();

  chatBox.addSystemMessage('Welcome to World of Vibecraft!');
  chatBox.addSystemMessage('Right-click + drag to turn, left-click + drag to orbit camera.');
  chatBox.addSystemMessage('A/D to turn, Q/E to strafe. NumLock for autorun.');
  chatBox.addSystemMessage('Press Enter to chat.');

  // Add existing players from welcome data
  if (welcomeData.players) {
    for (const p of welcomeData.players) {
      if (p.id === welcomeData.id) continue;
      addRemotePlayer(p);
    }
  }

  // Network events
  setupNetworkHandlers();

  // Input
  setupInput();
}

function setupNetworkHandlers() {
  network.on(MSG.PLAYER_JOINED, (data) => {
    addRemotePlayer(data.player);
    chatBox.addSystemMessage(`${data.player.name} has entered the world.`);
  });

  network.on(MSG.PLAYER_LEFT, (data) => {
    const rp = remotePlayers.get(data.id);
    if (rp) {
      chatBox.addSystemMessage(`${rp.name} has left the world.`);
      scene.remove(rp.mesh);
      rp.dispose();
      remotePlayers.delete(data.id);
    }
  });

  network.on(MSG.STATE, (data) => {
    for (const ps of data.players) {
      if (ps.id === localPlayer.id) continue;
      const rp = remotePlayers.get(ps.id);
      if (rp) {
        rp.updateTarget(ps.position, ps.rotation);
      }
    }
  });

  network.on(MSG.CHAT, (data) => {
    chatBox.addMessage(data.name, data.message);
  });
}

function addRemotePlayer(playerData) {
  const rp = new RemotePlayer(
    playerData.id,
    playerData.name,
    playerData.position || { x: 0, y: 0, z: 0 }
  );
  remotePlayers.set(playerData.id, rp);
  scene.add(rp.mesh);
}

function setupInput() {
  document.addEventListener('keydown', (e) => {
    if (chatBox.isOpen) return;
    const key = e.key.toLowerCase();
    localPlayer.setKey(key, true);

    // W also cancels autorun
    if (key === 'w') localPlayer.autorun = false;
  });

  document.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    localPlayer.setKey(key, false);
  });
}

// ---- Game Loop ----
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();

  // Update local player (pass controls so it can read mouse state)
  localPlayer.update(dt, controls);

  // Update camera (pass character yaw and scene for collision)
  controls.update(localPlayer.position, localPlayer.characterYaw, scene);

  // Update remote players
  for (const [, rp] of remotePlayers) {
    rp.update(dt);
  }

  // Send position to server
  if (now - lastSendTime > SEND_RATE) {
    network.sendMove(localPlayer.getState().position, localPlayer.characterYaw);
    lastSendTime = now;
  }

  // Update UI
  hud.update(localPlayer, remotePlayers.size + 1);
  minimap.update(localPlayer, remotePlayers);

  // Render
  renderer.render(scene, camera);
}
