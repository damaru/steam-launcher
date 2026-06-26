const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync, spawn } = require('child_process');

// Disable xdg-desktop-portal screen/input capture requests that trigger
// "Allow remote desktop control?" popups under GNOME Wayland.
app.commandLine.appendSwitch('disable-features', 'WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform');

const HOME           = process.env.HOME;
const STEAM_DIR      = path.join(HOME, '.local/share/Steam');
const STEAM_APPS     = path.join(STEAM_DIR, 'steamapps');
const LIBRARY_CACHE  = path.join(STEAM_DIR, 'appcache/librarycache');
const COMPAT_DATA    = path.join(STEAM_APPS, 'compatdata');

// ── Direct launch helpers ────────────────────────────────────────────────────

// Filenames that are definitely not the game executable
const EXE_BLACKLIST = /\b(unins|setup|install|uninst|UnityCrashHandler|CrashReport|CrashHandler|dxsetup|vcredist|dotnet|directx|vc_redist|steam_api|steam_api64|start_protected_game|EasyAntiCheat_Setup|EOSSDK|BugReporter)\b/i;

// Prefer these Linux-native binary patterns
const LINUX_PATTERNS = [
  f => /\.bin\.x86_64$/.test(f),
  f => /\.x86_64$/.test(f),
  f => /\.bin\.x86$/.test(f) && !f.endsWith('.exe'),
  f => f.endsWith('.sh') && !EXE_BLACKLIST.test(f),
];

function isLinuxExecutable(filepath) {
  try {
    const stat = fs.statSync(filepath);
    if (!stat.isFile()) return false;
    if (stat.mode & 0o111) return true; // executable bit
    return false;
  } catch { return false; }
}

// Find the best Linux-native executable in a game directory
function findLinuxExe(gameDir, gameName) {
  // BFS up to depth 3
  function walk(dir, depth) {
    if (depth > 3) return null;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return null; }

    // Check for pattern matches at this level first
    for (const pat of LINUX_PATTERNS) {
      const match = entries.find(e => pat(e) && isLinuxExecutable(path.join(dir, e)) && !EXE_BLACKLIST.test(e));
      if (match) return path.join(dir, match);
    }

    // Check for executable matching game name (no extension)
    const nameNorm = gameName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const nameMatch = entries.find(e => {
      if (EXE_BLACKLIST.test(e)) return false;
      const base = path.basename(e, path.extname(e)).toLowerCase().replace(/[^a-z0-9]/g, '');
      return base === nameNorm && isLinuxExecutable(path.join(dir, e)) && !e.endsWith('.exe');
    });
    if (nameMatch) return path.join(dir, nameMatch);

    // Recurse into subdirectories
    for (const e of entries) {
      const sub = path.join(dir, e);
      try { if (fs.statSync(sub).isDirectory()) { const r = walk(sub, depth + 1); if (r) return r; } } catch {}
    }
    return null;
  }
  return walk(gameDir, 0);
}

// Find the primary Windows .exe in a game directory (for Proton games)
function findWindowsExe(gameDir, gameName) {
  const nameNorm = gameName.toLowerCase().replace(/[^a-z0-9]/g, '');
  function walk(dir, depth) {
    if (depth > 3) return null;
    let entries;
    try { entries = fs.readdirSync(dir); } catch { return null; }

    // Prefer exe matching game name
    const named = entries.find(e => {
      if (!e.endsWith('.exe') || EXE_BLACKLIST.test(e)) return false;
      const base = path.basename(e, '.exe').toLowerCase().replace(/[^a-z0-9]/g, '');
      return base === nameNorm;
    });
    if (named) return path.join(dir, named);

    // Any non-blacklisted exe at this level
    const any = entries.find(e => e.endsWith('.exe') && !EXE_BLACKLIST.test(e));
    if (any) return path.join(dir, any);

    for (const e of entries) {
      const sub = path.join(dir, e);
      try { if (fs.statSync(sub).isDirectory()) { const r = walk(sub, depth + 1); if (r) return r; } } catch {}
    }
    return null;
  }
  return walk(gameDir, 0);
}

// Resolve which Proton to use for a given appid from config.vdf CompatToolMapping
function resolveProtonPath(appid) {
  let configText;
  try { configText = fs.readFileSync(path.join(STEAM_DIR, 'config/config.vdf'), 'utf8'); } catch { return null; }

  // Find CompatToolMapping entry for this appid
  const appSection = configText.match(new RegExp(`"${appid}"\\s*\\{([^}]+)\\}`, 's'));
  let toolName = appSection ? (appSection[1].match(/"name"\s+"([^"]+)"/) || [])[1] : null;

  // Fallback: default_linux or proton_experimental
  if (!toolName) {
    const defaultMatch = configText.match(/"DefaultPlatformCompatTool"\s+"([^"]+)"/);
    toolName = defaultMatch ? defaultMatch[1] : 'proton_experimental';
  }

  // Map tool name → directory name
  const NAME_MAP = {
    proton_experimental: 'Proton - Experimental',
    proton_hotfix:       'Proton Hotfix',
  };
  // proton_10 → "Proton 10.0", etc.
  const versionMatch = toolName.match(/^proton_(\d+)$/);
  const dirName = versionMatch
    ? `Proton ${versionMatch[1]}.0`
    : (NAME_MAP[toolName] || toolName);

  // Search steamapps/common for that directory
  const dirs = fs.readdirSync(path.join(STEAM_APPS, 'common'));
  const found = dirs.find(d => d.toLowerCase() === dirName.toLowerCase())
             || dirs.find(d => d.toLowerCase().startsWith('proton'));
  return found ? path.join(STEAM_APPS, 'common', found, 'proton') : null;
}

// Direct launch without Steam
async function directLaunch(appid, name, win) {
  // Locate install dir from ACF manifest
  const manifests = fs.readdirSync(STEAM_APPS).filter(f => f.startsWith(`appmanifest_${appid}`));
  if (!manifests.length) return { ok: false, error: 'Manifest not found' };

  // Ensure Steam is running so SteamAPI_Init() succeeds in the game
  await ensureSteamRunning();

  const text = fs.readFileSync(path.join(STEAM_APPS, manifests[0]), 'utf8');
  const installdirMatch = text.match(/"installdir"\s+"([^"]+)"/);
  if (!installdirMatch) return { ok: false, error: 'installdir not found in manifest' };

  const gameDir = path.join(STEAM_APPS, 'common', installdirMatch[1]);

  const linuxExe = findLinuxExe(gameDir, name);

  const env = {
    ...process.env,
    SteamAppId:        appid,
    SteamGameId:       appid,
    SteamOverlayGameId: appid,
    // Suppress Steam overlay and DRM checks where possible
    WINEDLLOVERRIDES:  'steam.exe=b;steamwebhelper.exe=b',
    DXVK_LOG_LEVEL:    'none',
    VKD3D_DEBUG:       'none',
  };

  let child;

  if (linuxExe) {
    // Native Linux binary
    child = spawn(linuxExe, [], {
      cwd: path.dirname(linuxExe),
      env,
      detached: true,
      stdio: 'ignore',
    });
  } else {
    // Proton (Windows exe)
    const windowsExe = findWindowsExe(gameDir, name);
    if (!windowsExe) return { ok: false, error: 'No executable found' };

    const protonScript = resolveProtonPath(appid);
    if (!protonScript || !fs.existsSync(protonScript)) {
      return { ok: false, error: 'Proton not found' };
    }

    const compatDataPath = path.join(COMPAT_DATA, appid);
    // Ensure compat data directory exists
    fs.mkdirSync(compatDataPath, { recursive: true });

    env.STEAM_COMPAT_DATA_PATH         = compatDataPath;
    env.STEAM_COMPAT_CLIENT_INSTALL_PATH = STEAM_DIR;
    env.PROTON_LOG                     = '0';

    child = spawn('python3', [protonScript, 'run', windowsExe], {
      cwd: path.dirname(windowsExe),
      env,
      detached: true,
      stdio: 'ignore',
    });
  }

  child.unref();

  // For direct launches we own the child — watch it directly instead of
  // polling for Steam's reaper (which won't exist in this mode).
  child.on('close', () => {
    win.show();
    win.focus();
    win.moveTop();
    win.webContents.send('game-exited');
  });

  return { ok: true, native: !!linuxExe };
}


// Pre-start Steam silently (tray only) if it isn't already running.
// Returns a Promise that resolves once Steam's pid file exists (i.e. IPC is up).
function ensureSteamRunning() {
  const STEAM_PID_FILE = path.join(HOME, '.steam/steam.pid');

  function isSteamReady() {
    try {
      const pid = parseInt(fs.readFileSync(STEAM_PID_FILE, 'utf8').trim(), 10);
      if (!pid) return false;
      execSync(`kill -0 ${pid} 2>/dev/null`, { stdio: 'ignore' });
      return true;
    } catch { return false; }
  }

  if (isSteamReady()) return Promise.resolve();

  exec('steam -silent', { detached: true, stdio: 'ignore' });

  return new Promise(resolve => {
    const interval = setInterval(() => {
      if (isSteamReady()) {
        clearInterval(interval);
        resolve();
      }
    }, 500);
    // Give up after 15s and launch anyway — some games don't need Steam
    setTimeout(() => { clearInterval(interval); resolve(); }, 15000);
  });
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

  // Preferred image types in priority order (portrait first)
  const preferred = ['library_600x900.jpg', 'library_capsule.jpg', 'header.jpg', 'library_header.jpg', 'library_hero.jpg'];

  // Search top-level dir and one level of subdirectories
  const searchDirs = [dir];
  for (const entry of fs.readdirSync(dir)) {
    const sub = path.join(dir, entry);
    if (fs.statSync(sub).isDirectory()) searchDirs.push(sub);
  }

  for (const name of preferred) {
    for (const d of searchDirs) {
      const full = path.join(d, name);
      if (fs.existsSync(full)) return full;
    }
  }

  // Last resort: any jpg in any searched dir
  for (const d of searchDirs) {
    const jpg = fs.readdirSync(d).find(f => f.endsWith('.jpg'));
    if (jpg) return path.join(d, jpg);
  }

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

app.whenReady().then(async () => {
  await ensureSteamRunning();
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

  ipcMain.handle('direct-launch', (_, appid, name) => {
    if (appid === '__bigpicture__') return { ok: false, error: 'N/A' };
    return directLaunch(appid, name, win);
  });

  // Returns { native: bool, proton: bool, exe: string|null }
  ipcMain.handle('detect-launch-type', (_, appid, name) => {
    try {
      const manifests = fs.readdirSync(STEAM_APPS).filter(f => f.startsWith(`appmanifest_${appid}`));
      if (!manifests.length) return { native: false, proton: false, exe: null };
      const text = fs.readFileSync(path.join(STEAM_APPS, manifests[0]), 'utf8');
      const installdirMatch = text.match(/"installdir"\s+"([^"]+)"/);
      if (!installdirMatch) return { native: false, proton: false, exe: null };
      const gameDir = path.join(STEAM_APPS, 'common', installdirMatch[1]);
      const linuxExe = findLinuxExe(gameDir, name);
      const winExe   = !linuxExe ? findWindowsExe(gameDir, name) : null;
      return { native: !!linuxExe, proton: !!winExe, exe: linuxExe || winExe };
    } catch { return { native: false, proton: false, exe: null }; }
  });

  ipcMain.handle('quit', () => app.quit());
});

app.on('window-all-closed', () => app.quit());
