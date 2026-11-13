// What the page may ask of the app: open a page in the system browser (where the reader is already signed in to
// OpenRouter, ChatGPT and the rest), save a file where the reader chooses, know that it runs inside the app and which
// version it is and fill the screen.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  chooseLibraryFolder: () => ipcRenderer.invoke('storage:choose-folder'),
  openExternal: (url) => ipcRenderer.invoke('open-external', String(url)),
  saveFile: (name, data) => ipcRenderer.invoke('save-file', String(name),   // (a picture: its bytes, from the page's own world)
    Object.prototype.toString.call(data) === '[object ArrayBuffer]' ? data : String(data)),
  version: () => ipcRenderer.invoke('app:version'),
  fullScreen: (on) => ipcRenderer.invoke('window:fullscreen', on),
  onFullScreen: (cb) => { ipcRenderer.on('fullscreen', (_e, on) => cb(on)); },
});
