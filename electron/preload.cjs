'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vdraw', {
  platform: process.platform,
  isSmoke: process.env.VDRAW_SMOKE === '1',
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    onStateChange: (handler) => {
      const listener = (_event, state) => handler(state);
      ipcRenderer.on('window:state', listener);
      return () => ipcRenderer.removeListener('window:state', listener);
    }
  },
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    onCloseRequest: (handler) => {
      const listener = () => handler();
      ipcRenderer.on('app:close-request', listener);
      return () => ipcRenderer.removeListener('app:close-request', listener);
    },
    respondClose: (shouldClose) => ipcRenderer.invoke('app:close-response', shouldClose)
  },
  file: {
    openDocument: () => ipcRenderer.invoke('file:open-document'),
    openPath: (filePath) => ipcRenderer.invoke('file:open-path', filePath),
    saveDocument: (payload) => ipcRenderer.invoke('file:save-document', payload),
    getSaveDir: () => ipcRenderer.invoke('file:save-dir'),
    openSaveDir: () => ipcRenderer.invoke('file:open-save-dir'),
    exportFile: (payload) => ipcRenderer.invoke('file:export', payload),
    exportPdf: (payload) => ipcRenderer.invoke('file:export-pdf', payload),
    importSvg: () => ipcRenderer.invoke('file:import-svg')
  }
});
