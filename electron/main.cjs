const { app, BrowserWindow, ipcMain, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { once } = require('events');
const archiver = require('archiver');
const { autoUpdater } = require('electron-updater');
const EnvConfigManager = require('./env-config-manager.cjs');
// Load build-time secrets before requiring bridge-server so they're available on process.env.
// secrets.json is gitignored — populated by CI at build time from GitHub Actions secrets.
// In dev just export the env vars in your shell (or put them in this file locally).
try {
    const secretsPath = path.join(__dirname, 'secrets.json');
    if (fs.existsSync(secretsPath)) {
        const s = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
        for (const [k, v] of Object.entries(s)) {
            if (!process.env[k]) process.env[k] = String(v);
        }
    }
} catch (_) {}

// Initialize environment config manager
const envConfigManager = new EnvConfigManager();
let currentConfig = envConfigManager.loadConfig();

// Check if this is a new machine and handle migration
if (envConfigManager.isNewMachine()) {
    console.log('[EnvConfig] 检测到新机器，正在处理配置迁移...');
    // Create backup of current config
    envConfigManager.createBackup();
    // Update machine ID
    envConfigManager.updateMachineId();
    console.log('[EnvConfig] 配置迁移完成');
}

// ── Bundled runtime: python (pip) ──
// Inject the bundled portable python into PATH so every engine
// bash/cmd subprocess can run `pip`, `python` on machines that have
// neither installed. Node.js is intentionally NOT bundled — the engine
// ships bun.exe which already covers the Node ecosystem (bun / bunx).
function setupBundledToolsPath() {
    try {
        const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
        const dirs = [
            path.join(base, 'python-3.13.2-embed-amd64'),             // python.exe / pythonw.exe
            path.join(base, 'python-3.13.2-embed-amd64', 'Scripts'),  // pip.exe & co
        ];
        const existing = (process.env.PATH || '').split(path.delimiter).map(p => path.resolve(p));
        const added = [];
        for (const dir of dirs) {
            const resolved = path.resolve(dir);
            if (fs.existsSync(resolved) && !existing.includes(resolved)) {
                process.env.PATH = resolved + path.delimiter + process.env.PATH;
                added.push(resolved);
            }
        }
        if (added.length) console.log('[Tools] Bundled runtimes on PATH:', added.join(' ; '));
    } catch (e) {
        console.warn('[Tools] Failed to set bundled runtime PATH:', e && e.message);
    }
}
setupBundledToolsPath();

const { initServer, enableNodeModeForChildProcesses } = require('./bridge-server.cjs');

// Fix Chinese garbled text in Windows console by switching to UTF-8 code page
if (process.platform === 'win32') {
    try { require('child_process').execSync('chcp 65001', { stdio: 'ignore' }); } catch (_) {}
    process.stdout.setEncoding?.('utf8');
    process.stderr.setEncoding?.('utf8');
    
    // Set Git Bash path for Simona Code
    // Priority: 1. Bundled Git, 2. System Git, 3. Common locations
    const bundledGitPath = path.join(process.resourcesPath || __dirname, '..', 'resources', 'git', 'bin', 'bash.exe');
    
    if (!process.env.SIMONA_CODE_GIT_BASH_PATH) {
        // First priority: Use bundled Git
        if (fs.existsSync(bundledGitPath)) {
            process.env.SIMONA_CODE_GIT_BASH_PATH = bundledGitPath;
            console.log('[Git Bash] Using bundled Git:', bundledGitPath);
        } else {
            // Second priority: Check common installation locations
            const gitBashPaths = [
                'C:\\Program Files\\Git\\bin\\bash.exe',
                'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
                path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
                path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
            ];
            
            let found = false;
            for (const bashPath of gitBashPaths) {
                if (fs.existsSync(bashPath)) {
                    process.env.SIMONA_CODE_GIT_BASH_PATH = bashPath;
                    console.log('[Git Bash] Found system Git at:', bashPath);
                    found = true;
                    break;
                }
            }
            
            if (!found) {
                console.warn('[Git Bash] NOT FOUND! Simona Code may not work properly.');
                console.warn('[Git Bash] Please install Git for Windows from https://git-scm.com/downloads/win');
            }
        }
    } else {
        console.log('[Git Bash] Using configured path:', process.env.SIMONA_CODE_GIT_BASH_PATH);
    }
}

// Squirrel startup handler removed — using NSIS installer, not Squirrel

let mainWindow;

const isDev = process.env.NODE_ENV === 'development';

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1150,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        // Platform-specific window chrome
        ...(process.platform === 'darwin'
            ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 } }
            : {
                titleBarStyle: 'hidden',
                titleBarOverlay: {
                    color: '#00000000',
                    symbolColor: '#808080',
                    height: 44
                }
            }),
        icon: path.join(__dirname, '..', 'public', process.platform === 'win32' ? 'favicon.ico' : 'favicon.png'),
        backgroundColor: '#F8F8F6',
        show: false, // Show after ready-to-show to prevent flash
    });

    // Reset zoom to default on startup & register zoom shortcuts
    mainWindow.once('ready-to-show', () => {
        mainWindow.webContents.setZoomFactor(1.0);
        mainWindow.show();
    });

    // Zoom keyboard shortcuts — Electron doesn't handle Ctrl+= (plus) by default on some layouts
    const TITLE_BAR_BASE_HEIGHT = 44;
    const applyZoom = (factor) => {
        const wc = mainWindow.webContents;
        wc.setZoomFactor(factor);
        // Keep native title bar overlay at consistent visual size regardless of zoom
        if (process.platform !== 'darwin') {
            try {
                mainWindow.setTitleBarOverlay({
                    color: '#00000000',
                    symbolColor: '#808080',
                    height: Math.round(TITLE_BAR_BASE_HEIGHT * factor),
                });
            } catch (_) {}
        }
        // Notify renderer so CSS can compensate
        wc.send('zoom-changed', factor);
    };

    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (!input.control && !input.meta) return;
        const wc = mainWindow.webContents;
        const current = wc.getZoomFactor();
        if (input.key === '=' || input.key === '+') {
            event.preventDefault();
            applyZoom(Math.min(+(current + 0.1).toFixed(1), 2.0));
        } else if (input.key === '-') {
            event.preventDefault();
            applyZoom(Math.max(+(current - 0.1).toFixed(1), 0.5));
        } else if (input.key === '0') {
            event.preventDefault();
            applyZoom(1.0);
        }
    });

    if (isDev) {
        // In development, load from Vite dev server
        mainWindow.loadURL('http://localhost:3000');
    } else {
        // In production, load the built files
        mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    }
    
    // mainWindow.webContents.openDevTools();

    // Open all external links in the system browser, not in the app
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http://') || url.startsWith('https://')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });
    mainWindow.webContents.on('will-navigate', (event, url) => {
        // Allow hash navigation (file:// with #) and localhost dev server
        if (url.startsWith('file://') || url.startsWith('http://localhost')) return;
        event.preventDefault();
        shell.openExternal(url);
    });

    mainWindow.webContents.on('console-message', (event, { level, message, line, sourceId }) => {
        if (level >= 2) {
            try { require('fs').appendFileSync(require('path').join(require('electron').app.getPath('userData'), 'frontend-error.log'), `[Frontend Error] ${message} at ${sourceId}:${line}\n`); } catch (_) {}
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    // macOS: clear quarantine flags on bundled bun binary. Downloaded .dmg/.zip
    // files get Apple's com.apple.quarantine xattr, and since our bun binary is
    // unsigned, Gatekeeper silently blocks execution — the engine subprocess just
    // exits immediately with no output. This one-liner strips the flag so bun can
    // run. Safe to call every launch (no-op if already cleared or on non-Mac).
    if (process.platform === 'darwin') {
        try {
            const engineBin = path.join(app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'), 'engine', 'bin');
            require('child_process').execSync(`xattr -cr "${engineBin}" 2>/dev/null || true`, { stdio: 'ignore' });
        } catch (_) {}
    }

    // Start Bridge Server
    const server = initServer();
    server.listen(30080, '0.0.0.0', () => {
        console.log('Bridge Server running on http://0.0.0.0:30080');
        console.log('Local access: http://127.0.0.1:30080');
    });
    server.timeout = 0; // Disable idle timeout for SSE streaming

    // Auto-start Agent Relay for public network access
    // This replaces the need for running agent-relay.cjs separately via startup.bat
    const { startAgentRelay } = require('./agent-relay.cjs');
    startAgentRelay(app.getPath('userData'));

    createWindow();

    // No SDK subprocess needed — using direct API calls
    enableNodeModeForChildProcesses();

    // Auto-update - DISABLED
    // if (!isDev) {
    //     autoUpdater.setFeedURL({
    //         provider: 'generic',
    //         url: 'https://clawparrot.com/updates',
    //     });
    //     autoUpdater.autoDownload = true;
    //     autoUpdater.autoInstallOnAppQuit = true;
    //     autoUpdater.logger = console;

    //     autoUpdater.on('update-available', (info) => {
    //         console.log('[Update] New version available:', info.version);
    //         if (mainWindow) {
    //             mainWindow.webContents.send('update-status', { type: 'available', version: info.version });
    //         }
    //     });

    //     autoUpdater.on('download-progress', (progress) => {
    //         if (mainWindow) {
    //             mainWindow.webContents.send('update-status', { type: 'progress', percent: Math.round(progress.percent) });
    //         }
    //     });

    //     autoUpdater.on('update-downloaded', (info) => {
    //         console.log('[Update] Downloaded:', info.version);
    //         if (mainWindow) {
    //             mainWindow.webContents.send('update-status', { type: 'downloaded', version: info.version });
    //         }
    //     });

    //     autoUpdater.on('error', (err) => {
    //         console.error('[Update] Error:', err.message);
    //         if (mainWindow) {
    //             mainWindow.webContents.send('update-status', { type: 'error', message: err.message });
    //         }
    //     });

    //     autoUpdater.on('update-not-available', (info) => {
    //         console.log('[Update] Already up-to-date:', info.version);
    //     });

    //     const doCheck = () => {
    //         console.log('[Update] Checking for updates...');
    //         autoUpdater.checkForUpdates().catch(err => {
    //             console.error('[Update] Check failed:', err.message);
    //         });
    //     };
    //     setTimeout(doCheck, 15000);
    //     setInterval(doCheck, 10 * 60 * 1000);
    // }

    app.on('activate', () => {
        // macOS: re-create window when dock icon clicked
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Clean up agent relay when app is about to quit
app.on('before-quit', () => {
    try {
        const { stopAgentRelay } = require('./agent-relay.cjs');
        stopAgentRelay();
    } catch (_) {}
});

// IPC Handlers for future bridge communication
ipcMain.handle('get-app-path', () => app.getPath('userData'));
ipcMain.handle('get-platform', () => process.platform);

// ─── 自定义更新检查与下载（更新源 https://www.example.com/Simona-X.Y.Z.exe） ───
let downloadedUpdatePath = null; // 已下载的安装包路径

// 简易 semver 比较：a > b 返回 1，a < b 返回 -1，相等返回 0
function compareVersions(a, b) {
    const pa = String(a || '').trim().split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').trim().split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

// 检查更新：抓取官网首页，扫描 Simona-X.Y.Z.exe 链接，取最高版本与当前版本比较
ipcMain.handle('check-for-update', async () => {
    const currentVersion = app.getVersion();
    const UPDATE_HOST = 'https://www.example.com';
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const resp = await fetch(`${UPDATE_HOST}/`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) return { hasUpdate: false, currentVersion, error: 'HTTP ' + resp.status };
        const html = await resp.text();
        const versions = Array.from(html.matchAll(/Simona-(\d+\.\d+\.\d+)\.exe/g), m => m[1]);
        const uniq = Array.from(new Set(versions));
        if (uniq.length === 0) return { hasUpdate: false, currentVersion, error: '未在官网找到安装包链接' };
        let latest = uniq[0];
        for (const v of uniq) if (compareVersions(v, latest) > 0) latest = v;
        const hasUpdate = compareVersions(latest, currentVersion) > 0;
        console.log('[Update] current=' + currentVersion + ' latest=' + latest + ' hasUpdate=' + hasUpdate);
        return {
            hasUpdate,
            currentVersion,
            latestVersion: latest,
            downloadUrl: `${UPDATE_HOST}/Simona-${latest}.exe`,
        };
    } catch (err) {
        console.error('[Update] Check failed:', err.message);
        return { hasUpdate: false, currentVersion, error: err.message };
    }
});

// 下载更新：流式下载到系统下载目录，通过 update-status 推送进度
ipcMain.handle('download-update', async (event, version) => {
    const UPDATE_HOST = 'https://www.example.com';
    const url = `${UPDATE_HOST}/Simona-${version}.exe`;
    const destPath = path.join(app.getPath('downloads'), `Simona-${version}.exe`);
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60 * 60 * 1000);
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const total = parseInt(resp.headers.get('content-length') || '0', 10) || 0;
        const fileStream = fs.createWriteStream(destPath);
        const reader = resp.body.getReader();
        let received = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            if (mainWindow) {
                const percent = total > 0 ? Math.round((received / total) * 100) : 0;
                mainWindow.webContents.send('update-status', { type: 'progress', percent, version });
            }
            // 背压控制：避免大安装包下载时内存占用过高
            if (!fileStream.write(Buffer.from(value))) {
                await once(fileStream, 'drain');
            }
        }
        await new Promise((resolve, reject) => {
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
            fileStream.end();
        });
        downloadedUpdatePath = destPath;
        console.log('[Update] Downloaded to:', destPath);
        if (mainWindow) {
            mainWindow.webContents.send('update-status', { type: 'downloaded', version, filePath: destPath });
        }
        return { success: true, filePath: destPath };
    } catch (err) {
        console.error('[Update] Download failed:', err.message);
        if (mainWindow) mainWindow.webContents.send('update-status', { type: 'error', message: err.message });
        return { success: false, error: err.message };
    }
});

// 安装更新：直接运行已下载的 Inno Setup 安装包（安装器会自行关闭旧版本并覆盖安装）
ipcMain.handle('install-update', async () => {
    if (!downloadedUpdatePath || !fs.existsSync(downloadedUpdatePath)) {
        return { success: false, error: '未找到已下载的安装包' };
    }
    const result = await shell.openPath(downloadedUpdatePath);
    if (result) return { success: false, error: result };
    return { success: true, filePath: downloadedUpdatePath };
});
ipcMain.handle('open-external', (_, url) => { const { shell } = require('electron'); shell.openExternal(url); });
ipcMain.handle('resize-window', (_, width, height) => {
    if (mainWindow) {
        mainWindow.setSize(width, height);
        mainWindow.center();
    }
});

// Open the folder containing the given file path in system explorer
// Returns true if opened, false if file/folder not found
const recentlyOpenedFolders = new Map(); // path → timestamp, prevents duplicate opens
ipcMain.handle('show-item-in-folder', (event, filePath) => {
    if (!filePath || !fs.existsSync(filePath)) return false;
    // Deduplicate: ignore if same folder was opened within last 2 seconds
    const folder = path.dirname(filePath);
    const now = Date.now();
    const lastOpened = recentlyOpenedFolders.get(folder);
    if (lastOpened && now - lastOpened < 2000) return true;
    recentlyOpenedFolders.set(folder, now);
    // Cleanup old entries
    for (const [k, v] of recentlyOpenedFolders) {
        if (now - v > 5000) recentlyOpenedFolders.delete(k);
    }
    shell.showItemInFolder(filePath);
    return true;
});

// Open a folder directly in system explorer
const recentlyOpenedDirs = new Map();
ipcMain.handle('open-folder', (event, folderPath) => {
    if (!folderPath || !fs.existsSync(folderPath)) return false;
    const now = Date.now();
    const lastOpened = recentlyOpenedDirs.get(folderPath);
    if (lastOpened && now - lastOpened < 2000) return true;
    recentlyOpenedDirs.set(folderPath, now);
    for (const [k, v] of recentlyOpenedDirs) {
        if (now - v > 5000) recentlyOpenedDirs.delete(k);
    }
    shell.openPath(folderPath);
    return true;
});

ipcMain.handle('select-directory', async () => {
    console.log('[Electron] select-directory called');
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
    });
    console.log('[Electron] select-directory result:', result);
    if (result.canceled) {
        console.log('[Electron] User canceled selection');
        return null;
    }
    console.log('[Electron] Returning path:', result.filePaths[0]);
    return result.filePaths[0];
});

ipcMain.handle('export-workspace', async (event, workspaceId, contextMarkdown, defaultFilename) => {
    try {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: '导出模型对话工作空间',
            defaultPath: defaultFilename,
            filters: [
                { name: 'Zip Archives', extensions: ['zip'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (result.canceled || !result.filePath) {
            return { success: false, reason: 'canceled' };
        }

        const zipDest = result.filePath;
        const workspacePath = path.join(app.getPath('userData'), 'workspaces', workspaceId);

        // 确保对应的 workspace 目录存在 (即使之前因为没有发生过相关文件操作而没创建)
        if (!fs.existsSync(workspacePath)) {
            fs.mkdirSync(workspacePath, { recursive: true });
        }

        // 把前段归集的完整文本上下文放进去一起归档
        fs.writeFileSync(path.join(workspacePath, 'chat_context.md'), contextMarkdown || '', 'utf-8');

        // 执行异步 zip 打包保存
        return await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipDest);
            const archive = archiver('zip', {
                zlib: { level: 9 } // Sets the compression level.
            });

            output.on('close', () => {
                resolve({ success: true, path: zipDest, size: archive.pointer() });
            });

            archive.on('error', (err) => {
                reject(err);
            });

            archive.pipe(output);

            // 将整个文件夹里的所有文件平摊塞入这个压缩包里 (不用多套一层文件夹壳)
            archive.directory(workspacePath, false);

            archive.finalize();
        });
    } catch (err) {
        console.error("Export Workspace Failed:", err);
        throw err;
    }
});

// Environment config management IPC handlers
ipcMain.handle('env-config-load', () => {
    currentConfig = envConfigManager.loadConfig();
    return currentConfig;
});

ipcMain.handle('env-config-save', (event, config) => {
    const success = envConfigManager.saveConfig(config);
    if (success) {
        currentConfig = config;
    }
    return { success };
});

ipcMain.handle('env-config-export', async (event) => {
    try {
        const result = await dialog.showSaveDialog(mainWindow, {
            title: '导出环境配置',
            defaultPath: 'simona-desktop-env.env',
            filters: [
                { name: 'Environment Files', extensions: ['env'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (result.canceled || !result.filePath) {
            return { success: false, reason: 'canceled' };
        }

        const envContent = envConfigManager.exportToEnvFormat(currentConfig);
        fs.writeFileSync(result.filePath, envContent, 'utf8');
        return { success: true, path: result.filePath };
    } catch (err) {
        console.error('Export env config failed:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('env-config-import', async (event) => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: '导入环境配置',
            properties: ['openFile'],
            filters: [
                { name: 'Environment Files', extensions: ['env'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });

        if (result.canceled || result.filePaths.length === 0) {
            return { success: false, reason: 'canceled' };
        }

        const importedConfig = envConfigManager.importFromEnvFile(result.filePaths[0]);
        if (importedConfig) {
            currentConfig = importedConfig;
            return { success: true, config: importedConfig };
        } else {
            return { success: false, error: '导入失败' };
        }
    } catch (err) {
        console.error('Import env config failed:', err);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('env-config-backup', () => {
    const backupPath = envConfigManager.createBackup();
    return { success: !!backupPath, path: backupPath };
});

ipcMain.handle('env-config-check-machine', () => {
    return { isNewMachine: envConfigManager.isNewMachine() };
});

// 剪贴板 IPC handlers
ipcMain.handle('clipboard-read', () => {
    const { clipboard } = require('electron');
    return clipboard.readText();
});

ipcMain.handle('clipboard-write', (event, text) => {
    const { clipboard } = require('electron');
    clipboard.writeText(text);
    return true;
});

// Write image to clipboard via base64
ipcMain.handle('clipboard-write-image', (event, base64Data, mimeType) => {
    const { clipboard, nativeImage } = require('electron');
    const imgBuffer = Buffer.from(base64Data, 'base64');
    const image = nativeImage.createFromBuffer(imgBuffer);
    clipboard.writeImage(image);
    return true;
});

// 右键菜单 IPC handler
ipcMain.handle('show-context-menu', async (event, options) => {
    const { text, isEditable, x, y } = options || {};
    console.log('[ContextMenu] Called with:', { text: text?.substring(0, 50), isEditable, x, y });
    
    try {
        // 使用 BrowserWindow 的 contextualMenu 属性
        const { Menu, clipboard } = require('electron');
        
        // 构建菜单项
        const menuItems = [];
        
        // 可编辑时显示复制、剪切、粘贴、全选
        if (isEditable) {
            // 复制
            menuItems.push({
                label: '复制',
                accelerator: 'CmdOrCtrl+C',
                click: () => {
                    if (text) {
                        clipboard.writeText(text);
                        console.log('[ContextMenu] Copy clicked, text length:', text.length);
                    }
                    event.sender.send('context-menu-action', { action: 'copy', text });
                }
            });
            
            // 剪切
            menuItems.push({
                label: '剪切',
                accelerator: 'CmdOrCtrl+X',
                click: () => {
                    if (text) {
                        clipboard.writeText(text);
                    }
                    event.sender.send('context-menu-action', { action: 'cut', text });
                }
            });
            
            // 粘贴
            menuItems.push({
                label: '粘贴',
                accelerator: 'CmdOrCtrl+V',
                click: () => {
                    const pasted = clipboard.readText();
                    console.log('[ContextMenu] Paste clicked, clipboard length:', pasted.length);
                    event.sender.send('context-menu-action', { action: 'paste', text: pasted });
                }
            });
            
            // 全选
            menuItems.push({
                label: '全选',
                accelerator: 'CmdOrCtrl+A',
                click: () => {
                    event.sender.send('context-menu-action', { action: 'selectAll' });
                }
            });
            
            // 搜索功能（仅当有选中文本时）
            if (text && text.trim()) {
                menuItems.push({ type: 'separator' });
                menuItems.push({
                    label: '用 Google 搜索 "' + (text.trim().length > 25 ? text.trim().substring(0, 25) + '...' : text.trim()) + '"',
                    click: () => {
                        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(text.trim())}`;
                        shell.openExternal(searchUrl);
                    }
                });
            }
        }
        
        // 如果菜单为空，添加一个粘贴选项
        if (menuItems.length === 0) {
            menuItems.push({
                label: '粘贴',
                accelerator: 'CmdOrCtrl+V',
                click: () => {
                    const pasted = clipboard.readText();
                    event.sender.send('context-menu-action', { action: 'paste', text: pasted });
                }
            });
        }
        
        const menu = Menu.buildFromTemplate(menuItems);
        
        // 使用 popup 方法显示菜单
        if (mainWindow) {
            menu.popup({
                window: mainWindow,
                callback: () => {
                    console.log('[ContextMenu] Menu closed');
                }
            });
            console.log('[ContextMenu] Menu shown successfully');
        } else {
            console.error('[ContextMenu] mainWindow is null');
        }
        
        return { success: true };
    } catch (err) {
        console.error('[ContextMenu] Error:', err);
        return { success: false, error: err.message };
    }
});
