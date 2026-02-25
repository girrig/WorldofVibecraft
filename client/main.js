import { Game } from './Game.js';
import { loadTerrain, preloadTerrainTextures } from './world/Terrain.js';
import { loadEnvironment, preloadEnvironmentModels } from './world/Environment.js';
import { preloadPlayerModel } from './entities/PlayerModel.js';

// ---- UI Elements ----
const loginScreen = document.getElementById('login-screen');
const loadingScreen = document.getElementById('loading-screen');
const gameContainer = document.getElementById('game-container');
const nameInput = document.getElementById('player-name');
const joinBtn = document.getElementById('join-btn');
const loadingStatus = document.getElementById('loading-status');
const loadingBar = document.getElementById('loading-bar');
const loadingPercent = document.getElementById('loading-percent');

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

  joinBtn.textContent = 'Loading...';
  joinBtn.disabled = true;

  try {
    // Hide login, show loading screen
    loginScreen.style.display = 'none';
    loadingScreen.style.display = 'flex';

    // Step 1: Load metadata (terrain, environment, player model)
    updateLoadingStatus('Loading world data...', 0);
    await Promise.all([
      loadTerrain().catch((err) => console.warn('Terrain metadata load failed:', err)),
      loadEnvironment().catch((err) => console.warn('Doodad metadata load failed:', err)),
      preloadPlayerModel().catch((err) => console.warn('Model load failed:', err)),
    ]);

    // Step 2: Preload all terrain textures (9 textures, ~20-25MB total)
    updateLoadingStatus('Loading terrain textures...', 0);
    await preloadTerrainTextures((percent) => {
      updateLoadingStatus('Loading terrain textures...', percent);
    });

    // Step 3: Preload most common environment models (top 15)
    updateLoadingStatus('Loading environment...', 0);
    await preloadEnvironmentModels((percent, modelName) => {
      updateLoadingStatus(`Loading environment... ${modelName}`, percent);
    });

    // Step 4: Initialize game (keep loading screen visible)
    updateLoadingStatus('Preparing world...', 95);
    const game = new Game();
    await game.init(name);

    // Final update before revealing game
    updateLoadingStatus('Entering world...', 100);
    await new Promise(resolve => setTimeout(resolve, 100)); // Brief moment to show 100%

    // Now hide loading and show game (scene is fully ready)
    loadingScreen.style.display = 'none';
    gameContainer.style.display = 'block';
  } catch (err) {
    console.error('Failed to start game:', err);
    joinBtn.textContent = 'Enter World';
    joinBtn.disabled = false;
    loginScreen.style.display = 'flex';
    loadingScreen.style.display = 'none';
    gameContainer.style.display = 'none';
    alert('Could not start game. Error: ' + err.message);
  }
}

function updateLoadingStatus(status, percent) {
  loadingStatus.textContent = status;
  loadingBar.style.width = `${percent}%`;
  loadingPercent.textContent = `${percent}%`;
}
