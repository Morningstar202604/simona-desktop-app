const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    // Zoom change listener
    onZoomChanged: (callback) => ipcRenderer.on('zoom-changed', (_, factor) => callback(factor)),
    // Platform info
    getPlatform: () => ipcRenderer.invoke('get-platform'),
    getAppPath: () => ipcRenderer.invoke('get-app-path'),

    // File system
    selectDirectory: () => ipcRenderer.invoke('select-directory'),

    // Check if running in Electron
    isElectron: true,

    // Core Functions
    exportWorkspace: (workspaceId, contextMarkdown, defaultFilename) => ipcRenderer.invoke('export-workspace', workspaceId, contextMarkdown, defaultFilename),

    // File explorer: open folder containing a file, or open a folder directly
    showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
    openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

    // Window resize
    resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', width, height),

    // Open external URL in system browser (for OAuth flows etc.)
    openExternal: (url) => ipcRenderer.invoke('open-external', url),

    // Auto-update events
    onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, status) => callback(status)),
    checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
    downloadUpdate: (version) => ipcRenderer.invoke('download-update', version),
    installUpdate: () => ipcRenderer.invoke('install-update'),

    // Environment config management
    envConfigLoad: () => ipcRenderer.invoke('env-config-load'),
    envConfigSave: (config) => ipcRenderer.invoke('env-config-save', config),
    envConfigExport: () => ipcRenderer.invoke('env-config-export'),
    envConfigImport: () => ipcRenderer.invoke('env-config-import'),
    envConfigBackup: () => ipcRenderer.invoke('env-config-backup'),
    envConfigCheckMachine: () => ipcRenderer.invoke('env-config-check-machine'),

    // Right-click context menu
    showContextMenu: (options) => ipcRenderer.invoke('show-context-menu', options),

    // Clipboard: write image from base64
    writeImageToClipboard: (base64Data, mimeType) => ipcRenderer.invoke('clipboard-write-image', base64Data, mimeType),
});
