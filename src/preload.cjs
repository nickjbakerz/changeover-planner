const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('campDesktop', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  saveSync: (data) => ipcRenderer.sendSync('data:save-sync', data),
  exportBackup: (data) => ipcRenderer.invoke('backup:export', data),
  importBackup: () => ipcRenderer.invoke('backup:import'),
  exportSpreadsheet: (payload) => ipcRenderer.invoke('spreadsheet:export', payload),
  exportPdf: (options) => ipcRenderer.invoke('pdf:export', options),
  openPrintDialog: (options) => ipcRenderer.invoke('print:open-dialog', options),
  setZoom: (percent) => ipcRenderer.invoke('view:set-zoom', percent),
  revealPath: (path) => ipcRenderer.invoke('path:reveal', path)
});
