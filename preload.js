const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('steamLauncher', {
  getGames:          () => ipcRenderer.invoke('get-games'),
  launchGame:        (appid) => ipcRenderer.invoke('launch-game', appid),
  directLaunch:      (appid, name) => ipcRenderer.invoke('direct-launch', appid, name),
  detectLaunchType:  (appid, name) => ipcRenderer.invoke('detect-launch-type', appid, name),
  quit:              () => ipcRenderer.invoke('quit'),
  onGameExited:      (cb) => ipcRenderer.on('game-exited', cb),
});
