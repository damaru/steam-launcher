const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('steamLauncher', {
  getGames: () => ipcRenderer.invoke('get-games'),
  launchGame: (appid) => ipcRenderer.invoke('launch-game', appid),
  quit: () => ipcRenderer.invoke('quit'),
  onGameExited: (cb) => ipcRenderer.on('game-exited', cb),
});
