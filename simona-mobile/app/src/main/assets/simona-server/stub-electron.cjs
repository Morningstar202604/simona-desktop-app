// stub-electron.cjs — Mock Electron module for Android
// 不使用 os.homedir() 避免 proot 内卡死
'use strict';

// 模拟 Electron 打包环境：bridge-server 用 path.join(process.resourcesPath, 'engine')
// 定位引擎目录。不设置的话 path.join(undefined,...) 会抛 TypeError。
if (process.resourcesPath === undefined) {
    process.resourcesPath = '/root/simona/resources';
    try {
        const fs = require('fs');
        fs.mkdirSync(process.resourcesPath, { recursive: true });
    } catch (_) {}
}

// 手机环境标记：bridge-server 的 /api/workspace/dirs 在无参数时根据该标记
// 直接列出手机存储根目录（/sdcard），而不是 rootfs 的服务器根目录。
if (process.env.SIMONA_MOBILE !== '1') {
    process.env.SIMONA_MOBILE = '1';
}

// 安卓端默认开启引擎进程池 — 消除每条消息 2-8s 的 bun spawn + 模块加载开销。
// 同一会话第二条及之后的消息复用池化进程，直接写 stdin，秒级响应。
// 如需关闭：设环境变量 SIMONA_ENGINE_POOL=0
if (process.env.SIMONA_ENGINE_POOL === undefined) {
    process.env.SIMONA_ENGINE_POOL = '1';
}

// 用户数据直接存外部存储（/sdcard = /storage/emulated/0，由 proot bind 映射）。
// 这样 simona-desktop.json（会话数据库）、providers.json、settings.json、
// workspace-config.json 等所有用户数据天然持久化：卸载重装 / 关闭重开都不丢失。
const userDataDir = '/sdcard/Simona/.simona';
try { require('fs').mkdirSync(userDataDir, { recursive: true }); } catch (_) {}

const app = {
    getPath: (name) => {
        switch (name) {
            case 'userData': return userDataDir;
            case 'home': return '/root';
            case 'documents': return '/sdcard';
            case 'temp': return '/tmp';
            case 'cache': return userDataDir + '/cache';
            case 'appData': return userDataDir;
            case 'userCache': return userDataDir + '/cache';
            case 'logs': return userDataDir + '/logs';
            case 'downloads': return '/sdcard/Download';
            case 'desktop': return '/sdcard';
            case 'exe': return '/system/bin/app_process';
            case 'module': return userDataDir + '/modules';
            case 'resources': return userDataDir + '/resources';
            default: return userDataDir + '/' + name;
        }
    },
    getName: () => 'Simona',
    getVersion: () => '1.0.0-android',
    isPackaged: false,
    quit: () => { process.exit(0); },
    on: (event, cb) => { if (event === 'ready') setTimeout(cb, 0); },
    whenReady: () => Promise.resolve(),
    getAppPath: () => '/root/simona',
    getLocale: () => 'zh-CN',
    commandLine: { appendArgument: () => {} },
    disableHardwareAcceleration: () => {},
    setAppUserModelId: () => {},
    setPath: () => {},
};

module.exports = { app, BrowserWindow: null, ipcMain: null, dialog: null, Notification: null };