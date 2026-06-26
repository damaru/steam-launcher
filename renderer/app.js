/* global steamLauncher (injected by preload) */
'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let games = [];
let focusedIndex = 0;
let columns = 1;
let launching = false;

const grid = document.getElementById('grid');
const overlay = document.getElementById('launch-overlay');
const launchName = document.getElementById('launch-name');
const gridContainer = document.getElementById('grid-container');

// ── Clock ─────────────────────────────────────────────────────────────────────
const clock = document.getElementById('clock');

function updateClock() {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  clock.textContent = `${date}  ${time}`;
}

updateClock();
setInterval(updateClock, 1000);

// ── Boot ─────────────────────────────────────────────────────────────────────
async function init() {
  grid.textContent = 'Loading…';
  grid.classList.add('loading');

  games = await window.steamLauncher.getGames();

  grid.classList.remove('loading');
  grid.textContent = '';

  if (games.length === 0) {
    grid.textContent = 'No installed Steam games found.';
    grid.classList.add('loading');
    return;
  }

  renderGrid();
  updateColumns();
  focusCard(0);
}

// ── Render ────────────────────────────────────────────────────────────────────
function renderGrid() {
  grid.innerHTML = '';
  games.forEach((game, i) => {
    const card = document.createElement('div');
    card.className = 'game-card';
    if (game.appid === '__bigpicture__') card.classList.add('bigpicture');
    card.dataset.index = i;

    attachImageWithFallback(card, game);

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = game.name;
    card.appendChild(label);

    // Direct-launch badge (shown after detection)
    if (game.appid !== '__bigpicture__') {
      const badge = document.createElement('div');
      badge.className = 'direct-badge hidden';
      badge.title = 'Launch without Steam';
      badge.textContent = 'DIRECT';
      badge.addEventListener('click', e => {
        e.stopPropagation();
        launchGameDirect(i);
      });
      card.appendChild(badge);

      // Detect in background and show badge if possible
      window.steamLauncher.detectLaunchType(game.appid, game.name).then(info => {
        if (info.native || info.proton) {
          badge.classList.remove('hidden');
          badge.classList.add(info.native ? 'native' : 'proton');
          badge.title = info.native
            ? `Native Linux: ${info.exe?.split('/').pop()}`
            : `Proton: ${info.exe?.split('/').pop()}`;
        }
      });
    }

    card.addEventListener('click', () => launchGameDirect(i));
    card.addEventListener('contextmenu', e => { e.preventDefault(); launchGame(i); });
    grid.appendChild(card);
  });
}

// CDN fallback chain for a given appid
function cdnUrls(appid) {
  return [
    `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_600x900_2x.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/library_600x900.jpg`,
    `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/header.jpg`,
  ];
}

function attachImageWithFallback(card, game) {
  const img = document.createElement('img');
  img.alt = game.name;
  img.draggable = false;

  // Build the full list of URLs to try: local first, then CDN
  const urls = [];
  if (game.imagePath) urls.push(`file://${game.imagePath}`);
  if (game.appid !== '__bigpicture__') urls.push(...cdnUrls(game.appid));

  let idx = 0;
  function tryNext() {
    if (idx >= urls.length) {
      img.replaceWith(noImageEl(game.name));
      return;
    }
    img.src = urls[idx++];
  }
  img.onerror = tryNext;
  tryNext();
  card.appendChild(img);
}

function noImageEl(name) {
  const el = document.createElement('div');
  el.className = 'no-image';
  el.textContent = name;
  return el;
}

// ── Column count ──────────────────────────────────────────────────────────────
function updateColumns() {
  const style = getComputedStyle(document.documentElement);
  const cardW = parseInt(style.getPropertyValue('--card-w'));
  const gap = parseInt(style.getPropertyValue('--gap'));
  const availW = window.innerWidth - 64; // 32px padding each side
  columns = Math.max(1, Math.floor((availW + gap) / (cardW + gap)));
}

window.addEventListener('resize', () => {
  updateColumns();
  scrollToFocused();
});

// ── Focus management ──────────────────────────────────────────────────────────
function focusCard(index) {
  if (index < 0 || index >= games.length) return;

  const prev = grid.querySelector('.game-card.focused');
  if (prev) prev.classList.remove('focused');

  focusedIndex = index;
  const card = grid.querySelector(`.game-card[data-index="${index}"]`);
  if (card) {
    card.classList.add('focused');
    scrollToFocused();
  }
}

function scrollToFocused() {
  const card = grid.querySelector('.game-card.focused');
  if (!card) return;
  const headerH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--header-h'));
  const cardTop = card.offsetTop;
  const cardBot = cardTop + card.offsetHeight;
  const viewTop = gridContainer.scrollTop + headerH;
  const viewBot = gridContainer.scrollTop + gridContainer.clientHeight;

  if (cardTop < viewTop) {
    gridContainer.scrollTop = cardTop - headerH - 12;
  } else if (cardBot > viewBot) {
    gridContainer.scrollTop = cardBot - gridContainer.clientHeight + 12;
  }
}

// ── Launch ────────────────────────────────────────────────────────────────────
async function launchGame(index) {
  if (launching) return;

  const game = games[index];

  // Big Picture: just open Steam, no overlay
  if (game.appid === '__bigpicture__') {
    await window.steamLauncher.launchGame(game.appid);
    return;
  }

  launching = true;
  launchName.textContent = game.name;
  overlay.classList.remove('hidden');

  await window.steamLauncher.launchGame(game.appid);
  // overlay is dismissed by the 'game-exited' event from main process
}

async function launchGameDirect(index) {
  if (launching) return;

  const game = games[index];
  launching = true;
  launchName.textContent = `${game.name} (direct)`;
  overlay.classList.remove('hidden');

  const result = await window.steamLauncher.directLaunch(game.appid, game.name);
  if (!result.ok) {
    overlay.classList.add('hidden');
    launching = false;
    alert(`Direct launch failed: ${result.error}`);
  }
  // on success, overlay dismissed by 'game-exited'
}

// Dismiss launch overlay when main process detects the game has exited
window.steamLauncher.onGameExited(() => {
  overlay.classList.add('hidden');
  launching = false;
});

// ── Keyboard ──────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (launching) return;
  switch (e.key) {
    case 'ArrowRight': move(1); break;
    case 'ArrowLeft':  move(-1); break;
    case 'ArrowDown':  move(columns); break;
    case 'ArrowUp':    move(-columns); break;
    case 'Enter':      launchGameDirect(focusedIndex); break;
    case ' ':          launchGame(focusedIndex); break;
    case 'Escape':     window.steamLauncher.quit(); break;
  }
});

function move(delta) {
  const next = focusedIndex + delta;
  if (next >= 0 && next < games.length) focusCard(next);
}

// ── Gamepad hint bar ──────────────────────────────────────────────────────────
const hintsEl = document.getElementById('hints');

window.addEventListener('gamepadconnected', () => {
  hintsEl.classList.replace('gamepad-hidden', 'gamepad-visible');
});
window.addEventListener('gamepaddisconnected', () => {
  if (!navigator.getGamepads().some(Boolean))
    hintsEl.classList.replace('gamepad-visible', 'gamepad-hidden');
});

// ── Gamepad ───────────────────────────────────────────────────────────────────
const GAMEPAD = {
  AXIS_LX: 0,
  AXIS_LY: 1,
  BTN_A: 0,         // Cross / A  → direct launch
  BTN_Y: 3,         // Triangle / Y → launch via Steam
  BTN_B: 1,         // Circle / B  (unused)
  BTN_DPAD_UP: 12,
  BTN_DPAD_DOWN: 13,
  BTN_DPAD_LEFT: 14,
  BTN_DPAD_RIGHT: 15,
  BTN_START: 9,
};

const AXIS_DEAD = 0.4;
const REPEAT_DELAY = 300;  // ms before repeat starts
const REPEAT_RATE  = 120;  // ms between repeats

let gpState = {
  up: 0, down: 0, left: 0, right: 0,
  aWasDown: false,
  yWasDown: false,
  startWasDown: false,
};

function gpPressed(btn) {
  if (!btn) return false;
  return typeof btn === 'object' ? btn.pressed : btn === 1;
}

function gamepadTick(now) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const pad = Array.from(pads).find(p => p && p.connected);
  if (!pad || launching) return;

  const ax = pad.axes[GAMEPAD.AXIS_LX] || 0;
  const ay = pad.axes[GAMEPAD.AXIS_LY] || 0;

  const goRight = gpPressed(pad.buttons[GAMEPAD.BTN_DPAD_RIGHT]) || ax > AXIS_DEAD;
  const goLeft  = gpPressed(pad.buttons[GAMEPAD.BTN_DPAD_LEFT])  || ax < -AXIS_DEAD;
  const goDown  = gpPressed(pad.buttons[GAMEPAD.BTN_DPAD_DOWN])  || ay > AXIS_DEAD;
  const goUp    = gpPressed(pad.buttons[GAMEPAD.BTN_DPAD_UP])    || ay < -AXIS_DEAD;

  function tryRepeat(dir, active, delta) {
    if (!active) { gpState[dir] = 0; return; }
    if (gpState[dir] === 0) {
      move(delta);
      gpState[dir] = now + REPEAT_DELAY;
    } else if (now > gpState[dir]) {
      move(delta);
      gpState[dir] = now + REPEAT_RATE;
    }
  }

  tryRepeat('right', goRight, 1);
  tryRepeat('left',  goLeft, -1);
  tryRepeat('down',  goDown, columns);
  tryRepeat('up',    goUp, -columns);

  // A button — direct launch
  const aDown = gpPressed(pad.buttons[GAMEPAD.BTN_A]);
  if (aDown && !gpState.aWasDown) launchGameDirect(focusedIndex);
  gpState.aWasDown = aDown;

  // Y button — launch via Steam
  const yDown = gpPressed(pad.buttons[GAMEPAD.BTN_Y]);
  if (yDown && !gpState.yWasDown) launchGame(focusedIndex);
  gpState.yWasDown = yDown;

  // Start button — quit
  const startDown = gpPressed(pad.buttons[GAMEPAD.BTN_START]);
  if (startDown && !gpState.startWasDown) window.steamLauncher.quit();
  gpState.startWasDown = startDown;
}

function gamepadLoop(ts) {
  gamepadTick(ts);
  requestAnimationFrame(gamepadLoop);
}

window.addEventListener('gamepadconnected', e => {
  console.log('Gamepad connected:', e.gamepad.id);
});

requestAnimationFrame(gamepadLoop);

// ── Start ─────────────────────────────────────────────────────────────────────
init();
