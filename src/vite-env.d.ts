declare module '*.png';
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.svg';
declare module '*.gif';
declare module '*.ico';

// Injected by vite.config.ts define — value is package.json version at build time
declare const __APP_VERSION__: string;

// Electron API types
interface ElectronAPI {
    // Zoom change listener
    onZoomChanged: (callback: (factor: number) => void) => void;
    // Platform info
    getPlatform: () => Promise<string>;
    getAppPath: () => Promise<string>;
    // File system
    selectDirectory: () => Promise<string | null>;
    // Check if running in Electron
    isElectron: boolean;
    // Core Functions
    exportWorkspace: (workspaceId: string, contextMarkdown: string, defaultFilename: string) => Promise<any>;
    // File explorer
    showItemInFolder: (filePath: string) => Promise<boolean>;
    openFolder: (folderPath: string) => Promise<boolean>;
    // Window resize
    resizeWindow: (width: number, height: number) => Promise<void>;
    // Open external URL
    openExternal: (url: string) => Promise<void>;
    // Auto-update events
    onUpdateStatus: (callback: (status: any) => void) => void;
    checkForUpdate: () => Promise<{ hasUpdate: boolean; currentVersion?: string; latestVersion?: string; downloadUrl?: string; error?: string }>;
    downloadUpdate: (version: string) => Promise<{ success: boolean; filePath?: string; error?: string }>;
    installUpdate: () => Promise<{ success: boolean; filePath?: string; error?: string }>;
    // Environment config management
    envConfigLoad: () => Promise<any>;
    envConfigSave: (config: any) => Promise<{ success: boolean }>;
    envConfigExport: () => Promise<{ success: boolean; path?: string; reason?: string; error?: string }>;
    envConfigImport: () => Promise<{ success: boolean; config?: any; reason?: string; error?: string }>;
    envConfigBackup: () => Promise<{ success: boolean; path?: string }>;
    envConfigCheckMachine: () => Promise<{ isNewMachine: boolean }>;
}

declare global {
    interface Window {
        electronAPI?: ElectronAPI;
    }
}
