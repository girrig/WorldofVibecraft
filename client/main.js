import { Game } from './Game.js';

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
    const game = new Game();

    // Hide login, show game
    loginScreen.style.display = 'none';
    gameContainer.style.display = 'block';

    await game.init(name);
  } catch (err) {
    console.error('Failed to connect:', err);
    joinBtn.textContent = 'Enter World';
    joinBtn.disabled = false;
    loginScreen.style.display = '';
    gameContainer.style.display = 'none';
    alert('Could not connect to server. Make sure the server is running.');
  }
}
