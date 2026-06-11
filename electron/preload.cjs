const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workbench', {
  scanCases: () => ipcRenderer.invoke('cases:scan'),
  importDataFolder: () => ipcRenderer.invoke('data:import-folder'),
  onDataImported: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('data:imported', listener);
    return () => ipcRenderer.removeListener('data:imported', listener);
  },
  onDataImportError: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('data:import-error', listener);
    return () => ipcRenderer.removeListener('data:import-error', listener);
  },
  onMenuAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.removeListener('menu:action', listener);
  },
  getCase: (caseId) => ipcRenderer.invoke('cases:get', caseId),
  readDicomFiles: (filePaths) => ipcRenderer.invoke('dicom:read-files', filePaths),
  saveSession: (payload) => ipcRenderer.invoke('sessions:save', payload),
  exportSessions: (format) => ipcRenderer.invoke('sessions:export', format),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  saveDraft: (payload) => ipcRenderer.invoke('drafts:save', payload),
  getDraft: (caseId) => ipcRenderer.invoke('drafts:get', caseId),
  listDrafts: () => ipcRenderer.invoke('drafts:list'),
  deleteDraft: (caseId) => ipcRenderer.invoke('drafts:delete', caseId)
});
