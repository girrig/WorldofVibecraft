import * as THREE from 'three';
import { MSG, SPAWN_AREA, SPAWN_POINT } from '../shared/constants.js';
import { createTerrain } from './world/Terrain.js';
import { createEnvironment, createLighting, createSky } from './world/Environment.js';
import { LocalPlayer } from './entities/Player.js';
import { RemotePlayer } from './entities/RemotePlayer.js';
import { PlayerControls } from './controls/PlayerControls.js';
import { NetworkClient } from './network.js';
import { ChatBox } from './ui/ChatBox.js';
import { Minimap } from './ui/Minimap.js';
import { HUD } from './ui/HUD.js';

const SEND_RATE = 1000 / 20; // Send position 20 times/sec

export class Game {
  constructor() {
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.localPlayer = null;
    this.remotePlayers = new Map();
    this.network = null;
    this.chatBox = null;
    this.minimap = null;
    this.hud = null;
    this.clock = new THREE.Clock();
    this.lastSendTime = 0;
    this.animFrameId = null;
  }

  async init(name) {
    // Initialize rendering
    this.initRenderer();

    // Assets are already preloaded by main.js - just connect to server
    this.network = new NetworkClient();
    const welcomeData = await this.network.connect(name);

    // Initialize game world (async now - waits for environment population)
    await this.initGame(welcomeData, name);

    // Start game loop
    this.animate();
  }

  initRenderer() {
    const canvas = document.getElementById('game-canvas');

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  async initGame(welcomeData, name) {
    this.scene = new THREE.Scene();

    // World
    createSky(this.scene);
    createLighting(this.scene);
    this.scene.add(createTerrain());

    // Wait for environment to be fully populated before continuing
    console.log('Placing environment objects...');
    const envGroup = await createEnvironment();
    this.scene.add(envGroup);
    console.log('Environment ready!');

    // Local player
    this.localPlayer = new LocalPlayer(welcomeData.id, name);

    // Spawn near Northshire Abbey (WoW human start location)
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * SPAWN_AREA;
    this.localPlayer.position.set(
      SPAWN_POINT.x + Math.cos(angle) * dist,
      0,
      SPAWN_POINT.z + Math.sin(angle) * dist
    );

    this.scene.add(this.localPlayer.mesh);

    // Controls
    const canvas = document.getElementById('game-canvas');
    this.controls = new PlayerControls(this.camera, canvas);

    // Force scene graph update (builds acceleration structures for raycasting)
    this.scene.updateMatrixWorld(true);

    // Position camera before shader compilation
    this.controls.update(this.localPlayer.position, this.localPlayer.characterYaw, this.scene, this.localPlayer.mesh);

    // CRITICAL: Compile all shaders AFTER environment is fully populated AND camera is positioned
    // This prevents the "first camera spin" lag spike
    console.log('Compiling shaders...');
    this.renderer.compile(this.scene, this.camera);

    // Render multiple times from different angles to ensure all shaders compiled
    for (let i = 0; i < 8; i++) {
      this.controls.cameraYaw += Math.PI / 4;
      this.controls.update(this.localPlayer.position, this.localPlayer.characterYaw, this.scene, this.localPlayer.mesh);
      this.renderer.render(this.scene, this.camera);
    }
    // Reset camera to original angle
    this.controls.cameraYaw = 0;
    this.controls.update(this.localPlayer.position, this.localPlayer.characterYaw, this.scene, this.localPlayer.mesh);
    console.log('Shaders compiled!');

    // UI
    this.chatBox = new ChatBox(this.network);
    this.minimap = new Minimap();
    this.hud = new HUD();

    this.chatBox.addSystemMessage('Welcome to World of Vibecraft!');
    this.chatBox.addSystemMessage('Right-click + drag to turn, left-click + drag to orbit camera.');
    this.chatBox.addSystemMessage('A/D to turn, Q/E to strafe. NumLock for autorun.');
    this.chatBox.addSystemMessage('Press Enter to chat.');

    // Add existing players from welcome data
    if (welcomeData.players) {
      for (const p of welcomeData.players) {
        if (p.id === welcomeData.id) continue;
        this.addRemotePlayer(p);
      }
    }

    // Network events
    this.setupNetworkHandlers();

    // Input
    this.setupInput();
  }

  setupNetworkHandlers() {
    this.network.on(MSG.PLAYER_JOINED, (data) => {
      this.addRemotePlayer(data.player);
      this.chatBox.addSystemMessage(`${data.player.name} has entered the world.`);
    });

    this.network.on(MSG.PLAYER_LEFT, (data) => {
      const rp = this.remotePlayers.get(data.id);
      if (rp) {
        this.chatBox.addSystemMessage(`${rp.name} has left the world.`);
        this.scene.remove(rp.mesh);
        rp.dispose();
        this.remotePlayers.delete(data.id);
      }
    });

    this.network.on(MSG.STATE, (data) => {
      for (const ps of data.players) {
        if (ps.id === this.localPlayer.id) continue;
        const rp = this.remotePlayers.get(ps.id);
        if (rp) {
          rp.updateTarget(ps.position, ps.rotation);
        }
      }
    });

    this.network.on(MSG.CHAT, (data) => {
      this.chatBox.addMessage(data.name, data.message);
    });
  }

  addRemotePlayer(playerData) {
    const rp = new RemotePlayer(
      playerData.id,
      playerData.name,
      playerData.position || { x: 0, y: 0, z: 0 }
    );
    this.remotePlayers.set(playerData.id, rp);
    this.scene.add(rp.mesh);
  }

  createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'emote-overlay';

    // Walk/Run toggle indicator
    const toggle = document.createElement('span');
    toggle.className = 'emote-key walk-toggle active';
    toggle.innerHTML = '<b>/</b> Run';
    overlay.appendChild(toggle);

    document.getElementById('game-container').appendChild(overlay);
  }

  updateWalkToggle() {
    const toggle = document.querySelector('.walk-toggle');
    if (!toggle) return;
    const isWalk = this.localPlayer.walkMode;
    toggle.innerHTML = `<b>/</b> ${isWalk ? 'Walk' : 'Run'}`;
    toggle.classList.toggle('walk-active', isWalk);
  }

  setupInput() {
    this.createOverlay();

    document.addEventListener('keydown', (e) => {
      if (this.chatBox.isOpen) return;
      const key = e.key.toLowerCase();

      // Walk/Run toggle
      if (key === '/') {
        e.preventDefault();
        this.localPlayer.walkMode = !this.localPlayer.walkMode;
        this.updateWalkToggle();
        return;
      }

      if (key === ' ') e.preventDefault();

      this.localPlayer.setKey(key, true);

      // W also cancels autorun
      if (key === 'w') this.localPlayer.autorun = false;
    });

    document.addEventListener('keyup', (e) => {
      const key = e.key.toLowerCase();
      this.localPlayer.setKey(key, false);
    });
  }

  animate() {
    this.animFrameId = requestAnimationFrame(() => this.animate());
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const now = performance.now();

    // Update local player (pass controls so it can read mouse state)
    this.localPlayer.update(dt, this.controls);

    // Update camera (pass character yaw and scene for collision)
    this.controls.update(this.localPlayer.position, this.localPlayer.characterYaw, this.scene, this.localPlayer.mesh);

    // Update remote players
    for (const [, rp] of this.remotePlayers) {
      rp.update(dt);
    }

    // Send position to server
    if (now - this.lastSendTime > SEND_RATE) {
      this.network.sendMove(this.localPlayer.getState().position, this.localPlayer.characterYaw);
      this.lastSendTime = now;
    }

    // Update UI
    this.hud.update(this.localPlayer, this.remotePlayers.size + 1);
    this.minimap.update(this.localPlayer, this.remotePlayers);

    // Render
    this.renderer.render(this.scene, this.camera);
  }

  stop() {
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }
}
