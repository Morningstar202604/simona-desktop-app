#!/usr/bin/env node
// server-wrapper-patch.cjs — Simona Android 服务器入口（含远控 relay 集成）
// 在原 server-wrapper.cjs 基础上，于 bridge-server 启动后加入 agent-relay 启动逻辑。
// 用法：替换 simona-mobile/app/src/main/assets/simona-server/server-wrapper.cjs
'use strict';
const path = require('path');
const fs = require('fs');
const Module = require('module');

const serverDir = __dirname;
const logFile = path.join(serverDir, 'server.log');

// 日志输出到文件
function log(msg) {
    const ts = new Date().toISOString();
    try {
        fs.appendFileSync(logFile, `[${ts}] ${msg}\n`);
    } catch (e) {
        // ignore
    }
    console.log(msg);
}

log('=== Simona Android Server (with Agent Relay) starting ===');
log(`Server dir: ${serverDir}`);
log(`Node: ${process.version}`);
log(`Platform: ${process.platform}`);
log(`Arch: ${process.arch}`);

// 确保数据目录存在
const homeDir = process.env.HOME || '/root';
const dataDir = path.join(homeDir, '.simona');
try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(serverDir, 'dist'), { recursive: true });
    log(`Data dir: ${dataDir}`);
} catch (e) {
    log(`WARN: mkdir: ${e.message}`);
}

// 加载 Electron 桩模块 — 拦截所有 require('electron') 调用
const stubElectron = require(path.join(serverDir, 'stub-electron.cjs'));
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === 'electron') return stubElectron;
    if (id === 'playwright') {
        // Playwright 在 Android 上不可用，返回空桩
        return { chromium: null, firefox: null, webkit: null };
    }
    if (id === 'playwright-core') {
        return { chromium: null, firefox: null, webkit: null };
    }
    return originalRequire.apply(this, arguments);
};

// 设置 NODE_PATH 指向服务器 node_modules
const nodeModulesPath = path.join(serverDir, 'node_modules');
if (fs.existsSync(nodeModulesPath)) {
    process.env.NODE_PATH = process.env.NODE_PATH || nodeModulesPath;
    log(`NODE_PATH: ${process.env.NODE_PATH}`);
    // 列出 node_modules 顶层包
    try {
        const pkgs = fs.readdirSync(nodeModulesPath).filter(d => !d.startsWith('.'));
        log(`node_modules packages: ${pkgs.length}`);
    } catch (e) {}
} else {
    log(`WARN: node_modules not found at ${nodeModulesPath}`);
}

// 检查 dist 目录
const distDir = path.join(serverDir, 'dist');
const indexPath = path.join(distDir, 'index.html');
if (fs.existsSync(indexPath)) {
    log(`dist/index.html found: ${fs.statSync(indexPath).size} bytes`);
} else {
    log(`WARN: dist/index.html NOT FOUND at ${indexPath}`);
    log(`dist dir contents: ${fs.existsSync(distDir) ? fs.readdirSync(distDir).join(', ') : 'NOT EXIST'}`);
}

// 切换到服务器目录
process.chdir(serverDir);

// 捕获未捕获异常，写入日志
process.on('uncaughtException', (err) => {
    log(`UNCAUGHT EXCEPTION: ${err.message}`);
    log(`Stack: ${err.stack}`);
    // 不退出，让服务器继续运行
});

process.on('unhandledRejection', (reason) => {
    log(`UNHANDLED REJECTION: ${reason}`);
});

// 启动 bridge-server
try {
    log('Loading bridge-server.cjs...');
    const bridgeServer = require(path.join(serverDir, 'bridge-server.cjs'));
    log('bridge-server.cjs loaded successfully');

    // bridge-server 内部用 path.join(__dirname, '..', 'dist') 定位 Web 前端（= /root/dist）
    // 但 Android 上实际 dist 在 /root/simona/dist，创建符号链接以兼容。
    try {
        const expectedDist = path.join(path.dirname(serverDir), 'dist');   // /root/dist
        const actualDist = path.join(serverDir, 'dist');                    // /root/simona/dist
        if (!fs.existsSync(expectedDist) && fs.existsSync(actualDist)) {
            const rel = path.relative(path.dirname(expectedDist), actualDist); // simona/dist
            fs.symlinkSync(rel, expectedDist, 'dir');
            log(`Symlink: ${expectedDist} -> ${rel}`);
        }
    } catch (e) {
        log(`WARN: dist symlink: ${e.message}`);
    }

    // 调用 initServer() 创建 Express 应用并监听端口
    const server = bridgeServer.initServer();
    server.timeout = 0; // 禁用空闲超时（SSE 流式输出需要）
    server.listen(30080, '0.0.0.0', () => {
        log('Bridge Server running on http://0.0.0.0:30080');
        log('Local access: http://127.0.0.1:30080');

        // ===== Agent Relay 启动 =====
        // bridge-server 监听 30080 后，启动 agent-relay 建立 WebSocket 隧道到 wss://example.com
        // 远控用户通过 relay 服务器转发 HTTP 请求到本地 bridge-server
        try {
            const { startAgentRelay } = require(path.join(serverDir, 'agent-relay-android.cjs'));
            // userDataPath 从 stub-electron 的 app.getPath('userData') 获取
            // = /sdcard/Simona/.simona（与 bridge-server 读取 jwt-token.json 的路径一致）
            const userDataPath = stubElectron.app.getPath('userData');
            startAgentRelay(userDataPath);
            log(`Agent Relay started (userDataPath: ${userDataPath})`);
        } catch (relayErr) {
            log(`WARN: Agent Relay failed to start: ${relayErr.message}`);
            log(`  This is non-fatal — bridge-server continues without relay.`);
            log(`  Check: ws module in node_modules, jwt-token.json in ${stubElectron.app.getPath('userData')}`);
        }
    });
    log('bridge-server initialized');

    // ===== Agent Relay 优雅停止 =====
    // 进程退出时清理 WebSocket 连接
    process.on('SIGTERM', () => {
        log('SIGTERM received, stopping agent relay...');
        try {
            const { stopAgentRelay } = require(path.join(serverDir, 'agent-relay-android.cjs'));
            stopAgentRelay();
        } catch (_) {}
        process.exit(0);
    });

} catch (err) {
    log(`FATAL: Failed to load bridge-server: ${err.message}`);
    log(`Stack: ${err.stack}`);
    process.exit(1);
}
