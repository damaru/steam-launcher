const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');

// Disable xdg-desktop-portal screen/input capture requests that trigger
// "Allow remote desktop control?" popups under GNOME Wayland.
app.commandLine.appendSwitch('disable-features', 'WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform');
const STEAM_APPS = path.join(process.env.HOME, '.local/share/Steam/steamapps');
const LIBRARY_CACHE = path.join(process.env.HOME, '.local/share/Steam/appcache/librarycache');

// Pre-start Steam silently (tray only) if it isn't already running.
function ensureSteamRunning() {
  try {
    execSync('pgrep -x steam', { stdio: 'ignore' });
    // Already running — nothing to do
  } catch {
    exec('steam -silent', { detached: true, stdio: 'ignore' });
  }
}

const SKIP_KEYWORDS = [
  'steam linux runtime',
  'proton',
  'steamworks',
  'bonus content',
  'soundtrack',
  'redistributable',
  'directx',
  'vcredist',
];

function isGame(name) {
  const lower = name.toLowerCase();
  return !SKIP_KEYWORDS.some(kw => lower.includes(kw));
}

function parseAcf(filepath) {
  const text = fs.readFileSync(filepath, 'utf8');
  const nameMatch = text.match(/"name"\s+"([^"]+)"/);
  const appidMatch = text.match(/"appid"\s+"([^"]+)"/);
  if (!nameMatch || !appidMatch) return null;
  return { name: nameMatch[1], appid: appidMatch[1] };
}

function getGameImage(appid) {
  const dir = path.join(LIBRARY_CACHE, appid);
  if (!fs.existsSync(dir)) return null;

  // Prefer well-known names (portrait cover first)
  const preferred = ['library_600x900.jpg', 'header.jpg', 'library_hero.jpg'];
  for (const fname of preferred) {
    const full = path.join(dir, fname);
    if (fs.existsSync(full)) return full;
  }

  // Fall back to any .jpg in the directory
  const files = fs.readdirSync(dir);
  const jpg = files.find(f => f.endsWith('.jpg'));
  if (jpg) return path.join(dir, jpg);

  return null;
}

function scanGames() {
  let manifests;
  try {
    manifests = fs.readdirSync(STEAM_APPS).filter(f => f.startsWith('appmanifest_') && f.endsWith('.acf'));
  } catch {
    return [];
  }

  const games = [];
  for (const file of manifests) {
    const parsed = parseAcf(path.join(STEAM_APPS, file));
    if (!parsed) continue;
    if (!isGame(parsed.name)) continue;
    const imagePath = getGameImage(parsed.appid);
    games.push({ name: parsed.name, appid: parsed.appid, imagePath });
  }

  games.sort((a, b) => a.name.localeCompare(b.name));

  // Prepend the Big Picture tile
  const steamIcon =
    '/usr/share/icons/hicolor/256x256/apps/steam.png';
  games.unshift({
    name: 'Steam Big Picture',
    appid: '__bigpicture__',
    imagePath: fs.existsSync(steamIcon) ? steamIcon : null,
  });

  return games;
}

// Watch Steam's reaper process — it lives exactly as long as the game runs.
// This works under both X11 and Wayland/cage without needing xdotool.
function watchForGameExit(win) {
  // Step 1: wait for reaper to appear (game starting)
  const POLL_MS = 1500;
  const REAPER_RE = /\/reaper\s/;

  function findReaperPid(cb) {
    exec("pgrep -af '/reaper' 2>/dev/null", (_, stdout) => {
      const line = (stdout || '').split('\n').find(l => REAPER_RE.test(l.trim()));
      cb(line ? line.trim().split(/\s+/)[0] : null);
    });
  }

  let findTimer = null;
  let watchTimer = null;

  findTimer = setInterval(() => {
    findReaperPid(pid => {
      if (!pid) return;
      clearInterval(findTimer);

      // Step 2: wait for that reaper pid to die (game exited)
      watchTimer = setInterval(() => {
        exec(`kill -0 ${pid} 2>/dev/null`, err => {
          if (!err) return; // still alive
          clearInterval(watchTimer);
          // Bring our window back — works under both X11 and Wayland
          win.show();
          win.focus();
          win.moveTop();
          win.webContents.send('game-exited');
        });
      }, POLL_MS);
    });
  }, POLL_MS);

  // Safety: cancel everything after 6 hours
  setTimeout(() => {
    clearInterval(findTimer);
    clearInterval(watchTimer);
  }, 6 * 60 * 60 * 1000);
}

function createWindow() {
  const win = new BrowserWindow({
    fullscreen: true,
    backgroundColor: '#0d0d0d',
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer/index.html'));
  return win;
}

app.whenReady().then(() => {
  ensureSteamRunning();
  const win = createWindow();

  ipcMain.handle('get-games', () => scanGames());

  ipcMain.handle('launch-game', (_, appid) => {
    if (appid === '__bigpicture__') {
      exec('steam -bigpicture');
      return true;
    }
    exec(`steam -applaunch ${appid}`);
    watchForGameExit(win);
    return true;
  });

  ipcMain.handle('quit', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
