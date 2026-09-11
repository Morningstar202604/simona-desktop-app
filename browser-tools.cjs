/**
 * browser-tools.cjs — Playwright browser automation wrapper for Simona
 * Lazily initializes a headless browser ONLY when a browser tool is called.
 * Integrates with tools.cjs via executeTool.
 *
 * Supports multi-profile persistent sessions via launchPersistentContext().
 * Profile data (cookies, local storage, login state) is preserved in
 * browser-profiles/<name>/ between sessions.
 *
 * Chromium 自动下载机制（v2）：
 * - 打包时不再包含 Chromium 文件夹（缩减体积约 400MB）
 * - 首次使用浏览器工具时，若 Chromium 不存在，自动从远程下载并解压
 * - 下载地址：https://www.example.com/Chromium.zip
 * - 保存位置：dev 模式 → 项目根目录/Chromium/；打包模式 → userData/Chromium/
 */
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { createWriteStream } = require('fs');
let AdmZip = null; // 延迟加载，仅在需要下载时加载

let playwright = null;

// 真多开（multi-profile parallel）：
// 每个 profile 维护一个独立的 BrowserContext 实例，可同时并行打开多个登录环境。
// profile -> { context, page, starting, startPromise }
const browserProfiles = new Map();

// 供 executeBrowserTool() 从 input.profile 设置（当前操作作用于哪个 profile）
let currentProfile = 'default';

const CHROMIUM_DOWNLOAD_URL = 'https://www.example.com/Chromium.zip';

// ── 延迟加载 Playwright ──

async function ensurePlaywright() {
    if (!playwright) {
        try {
            playwright = require('playwright');
        } catch (e) {
            throw new Error(`Playwright module not found. Install it with: npm install playwright`);
        }
    }
    return playwright;
}

// ── Chromium 自动下载机制 ──

/**
 * 获取 Chromium 存储目录
 * - 打包模式：Electron userData/Chromium/（%APPDATA%/Simona Desktop，可写、持久化）
 * - 开发模式：项目根目录/Chromium/
 *
 * 浏览器工具作为 Simona 内置工具，始终由 Electron 主进程执行：
 * - 打包后（asar 内）：process.resourcesPath 存在 → app.getPath('userData')
 * - dev（node 脚本直接 require 测试）：无 resourcesPath → 项目根目录（electron/ 的上一级）
 */
function getAppDataBaseDir() {
    // Electron 进程（打包 & dev 运行时）：用 app.getPath('userData')（%APPDATA%/Simona Desktop）
    if (process.resourcesPath) {
        try {
            const { app } = require('electron');
            return app.getPath('userData');
        } catch (e) {}
    }
    // dev 模式（node 脚本直接 require）：项目根目录（electron/ 的上一级）
    return path.join(__dirname, '..');
}

function getChromiumDir() {
    return path.join(getAppDataBaseDir(), 'Chromium');
}

/**
 * 下载文件（带进度显示）
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = createWriteStream(destPath);
        const dlTimeout = 10 * 60 * 1000; // 10 分钟超时
        let protocol = url.startsWith('https') ? https : http;

        function doDownload(downloadUrl) {
            const req = protocol.get(downloadUrl, { timeout: dlTimeout }, (response) => {
                // 处理重定向
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    file.close();
                    try { fs.unlinkSync(destPath); } catch (e) {}
                    const redirectUrl = new URL(response.headers.location, downloadUrl).toString();
                    protocol = redirectUrl.startsWith('https') ? https : http;
                    doDownload(redirectUrl);
                    return;
                }

                if (response.statusCode !== 200) {
                    file.close();
                    reject(new Error(`下载失败，HTTP ${response.statusCode}`));
                    return;
                }

                const total = parseInt(response.headers['content-length'] || '0', 10);
                let downloaded = 0;
                let lastLog = 0;

                response.on('data', (chunk) => {
                    downloaded += chunk.length;
                    if (total && Date.now() - lastLog > 1000) {
                        lastLog = Date.now();
                        const pct = Math.round((downloaded / total) * 100);
                        process.stdout.write(`\r[Browser-Tools] 下载 Chromium... ${pct}% (${(downloaded/1024/1024).toFixed(1)}MB/${(total/1024/1024).toFixed(1)}MB)`);
                    }
                });

                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    console.log('\n[Browser-Tools] Chromium 下载完成');
                    resolve();
                });
            });

            req.on('error', (err) => {
                file.close();
                reject(err);
            });
            req.on('timeout', () => {
                req.destroy();
                file.close();
                reject(new Error('下载超时'));
            });
        }

        doDownload(url);
    });
}

/**
 * 确保 Chromium 可用 — 不存在则自动下载并解压
 */
async function ensureChromium() {
    const chromiumDir = getChromiumDir();
    const chromeExe = path.join(chromiumDir, 'chrome.exe');

    // 1. 目标位置已存在
    if (fs.existsSync(chromeExe)) {
        return chromeExe;
    }

    // 2. 打包资源路径（开发模式或预装）
    if (process.resourcesPath) {
        const pkgExe = path.join(process.resourcesPath, 'Chromium', 'chrome.exe');
        if (fs.existsSync(pkgExe)) return pkgExe;
    }

    // 3. CWD 路径
    const cwdExe = path.join(process.cwd(), 'Chromium', 'chrome.exe');
    if (fs.existsSync(cwdExe)) return cwdExe;

    // 4. 都不存在 → 下载
    console.log('[Browser-Tools] Chromium 未找到，准备下载...');
    console.log(`[Browser-Tools] 下载地址: ${CHROMIUM_DOWNLOAD_URL}`);
    console.log(`[Browser-Tools] 保存到: ${chromiumDir}`);

    if (!fs.existsSync(chromiumDir)) {
        fs.mkdirSync(chromiumDir, { recursive: true });
    }

    // 延迟加载 AdmZip
    if (!AdmZip) {
        try {
            AdmZip = require('adm-zip');
        } catch (e) {
            throw new Error('adm-zip module not found. Install it with: npm install adm-zip');
        }
    }

    const zipPath = path.join(chromiumDir, 'Chromium.zip');

    try {
        await downloadFile(CHROMIUM_DOWNLOAD_URL, zipPath);
    } catch (err) {
        try { fs.unlinkSync(zipPath); } catch (e) {}
        throw new Error(`Chromium 下载失败: ${err.message}\n请手动下载 ${CHROMIUM_DOWNLOAD_URL} 并解压到 ${chromiumDir}`);
    }

    if (!fs.existsSync(zipPath)) {
        throw new Error('Chromium 下载文件不存在');
    }

    console.log('[Browser-Tools] 正在解压 Chromium...');
    try {
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(chromiumDir, true);
    } catch (err) {
        throw new Error(`Chromium 解压失败: ${err.message}\n压缩包位于: ${zipPath}`);
    }

    // 清理 zip
    try { fs.unlinkSync(zipPath); } catch (e) {}

    // 查找 chrome.exe（可能在子目录中）
    if (fs.existsSync(chromeExe)) {
        console.log('[Browser-Tools] Chromium 已就绪');
        return chromeExe;
    }

    // 子目录查找并整理
    const entries = fs.readdirSync(chromiumDir);
    for (const entry of entries) {
        const fullPath = path.join(chromiumDir, entry);
        if (fs.statSync(fullPath).isDirectory()) {
            const subExe = path.join(fullPath, 'chrome.exe');
            if (fs.existsSync(subExe)) {
                console.log(`[Browser-Tools] 在 "${entry}" 子目录中找到 Chromium，正在整理...`);
                const subEntries = fs.readdirSync(fullPath);
                for (const sub of subEntries) {
                    const src = path.join(fullPath, sub);
                    const dst = path.join(chromiumDir, sub);
                    if (!fs.existsSync(dst)) {
                        fs.renameSync(src, dst);
                    }
                }
                try { fs.rmdirSync(fullPath); } catch (e) {}
                console.log('[Browser-Tools] Chromium 已就绪');
                return chromeExe;
            }
        }
    }

    throw new Error(`Chromium 解压后未找到 chrome.exe，请手动下载 ${CHROMIUM_DOWNLOAD_URL} 并解压到 ${chromiumDir}`);
}

// ── 浏览器配置目录 ──

function getProfilesBaseDir() {
    return path.join(getAppDataBaseDir(), 'browser-profiles');
}

// ── 浏览器核心 ──

async function ensureBrowser() {
    const profile = currentProfile || 'default';
    let entry = browserProfiles.get(profile);

    // 1. 复用该 profile 已启动的实例（不影响其他已打开的 profile —— 真多开关键）
    if (entry && entry.context && !entry.starting) {
        console.log(`[Browser-Tools] Reusing browser instance for profile "${profile}"`);
        const pages = entry.context.pages();
        entry.page = pages.length > 0 ? pages[pages.length - 1] : await entry.context.newPage();
        if (pages.length > 1) {
            await entry.page.bringToFront();
        }
        return entry.page;
    }

    // 2. 该 profile 正在启动中 → 等待启动完成
    if (entry && entry.starting && entry.startPromise) {
        console.log(`[Browser-Tools] Launch already in progress for profile "${profile}", waiting...`);
        return entry.startPromise;
    }

    // 3. 启动该 profile 的新浏览器实例（不关闭其他 profile —— 真多开）
    entry = { context: null, page: null, starting: true, startPromise: null };
    browserProfiles.set(profile, entry);

    entry.startPromise = (async () => {
        const pw = await ensurePlaywright();
        const userDataDir = path.join(getProfilesBaseDir(), profile);
        try {
            const profilesDir = path.dirname(userDataDir);
            if (!fs.existsSync(profilesDir)) {
                fs.mkdirSync(profilesDir, { recursive: true });
            }

            // 确保 Chromium 可用（不存在则自动下载）
            const chromiumPath = await ensureChromium();

            entry.context = await pw.chromium.launchPersistentContext(userDataDir, {
                executablePath: chromiumPath,
                headless: false,
                args: ['--no-sandbox', '--disable-dev-shm-usage', '--start-maximized'],
                viewport: null
            });
            const pages = entry.context.pages();
            entry.page = pages.length > 0 ? pages[0] : await entry.context.newPage();
            console.log(`[Browser-Tools] Launched persistent context for profile "${profile}" at ${userDataDir}`);
            return entry.page;
        } catch (e) {
            browserProfiles.delete(profile);
            console.error(`[Browser-Tools] Failed to launch browser for profile "${profile}":`, e.message);
            throw new Error(`Failed to launch browser: ${e.message}`);
        } finally {
            entry.starting = false;
        }
    })();

    return entry.startPromise;
}

// ── Actions ──

async function actionNavigate(input) {
    const url = input.url;
    if (!url) throw new Error('url is required');
    const p = await ensureBrowser();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: input.timeout || 30000 });
    return { content: `Navigated to ${url}\nTitle: ${await p.title()}\nURL: ${p.url()}` };
}

async function actionClick(input) {
    const p = await ensureBrowser();
    const selector = input.selector;
    if (!selector) throw new Error('selector is required');
    const el = p.locator(selector);
    await el.waitFor({ timeout: input.timeout || 10000 });
    await el.click();
    return { content: `Clicked "${selector}"` };
}

async function actionFill(input) {
    const p = await ensureBrowser();
    const selector = input.selector;
    if (!selector) throw new Error('selector is required');
    if (input.value === undefined) throw new Error('value is required');
    const el = p.locator(selector);
    await el.waitFor({ timeout: input.timeout || 10000 });
    await el.fill(String(input.value));
    return { content: `Filled "${selector}" with "${input.value}"` };
}

async function actionScreenshot(input) {
    const p = await ensureBrowser();
    const ssPath = input.path || `screenshot_${Date.now()}.png`;
    const fullPage = input.fullPage || false;
    await p.screenshot({ path: ssPath, fullPage });
    return { content: `Screenshot saved to ${ssPath}` };
}

async function actionHtml(input) {
    const p = await ensureBrowser();
    const selector = input.selector;
    if (selector) {
        const el = p.locator(selector);
        await el.waitFor({ timeout: input.timeout || 10000 });
        const html = await el.innerHTML();
        return { content: html };
    }
    const html = await p.content();
    if (html.length > 50000) {
        return { content: html.slice(0, 25000) + `\n\n... [truncated ${html.length - 50000} chars] ...\n\n` + html.slice(-25000) };
    }
    return { content: html };
}

async function actionText(input) {
    const p = await ensureBrowser();
    const selector = input.selector;
    if (selector) {
        const el = p.locator(selector);
        await el.waitFor({ timeout: input.timeout || 10000 });
        return { content: await el.innerText() };
    }
    return { content: await p.locator('body').innerText() };
}

async function actionEvaluate(input) {
    const p = await ensureBrowser();
    const script = input.script;
    if (!script) throw new Error('script is required');
    const result = await p.evaluate(script);
    let out;
    try { out = JSON.stringify(result, null, 2); } catch { out = String(result); }
    return { content: out };
}

async function actionScroll(input) {
    const p = await ensureBrowser();
    const direction = input.direction || 'down';
    const amount = input.amount || 500;
    await p.evaluate(([dir, amt]) => {
        const d = dir === 'up' ? -amt : dir === 'left' ? -amt : dir === 'right' ? amt : amt;
        if (dir === 'left' || dir === 'right') {
            window.scrollBy(d, 0);
        } else {
            window.scrollBy(0, d);
        }
    }, [direction, amount]);
    return { content: `Scrolled ${direction} by ${amount}px` };
}

async function actionBack(input) {
    const p = await ensureBrowser();
    await p.goBack({ waitUntil: 'domcontentloaded' });
    return { content: `Navigated back to ${p.url()}` };
}

async function actionForward(input) {
    const p = await ensureBrowser();
    await p.goForward({ waitUntil: 'domcontentloaded' });
    return { content: `Navigated forward to ${p.url()}` };
}

async function actionSelect(input) {
    const p = await ensureBrowser();
    const selector = input.selector;
    if (!selector) throw new Error('selector is required');
    const value = input.value;
    if (!value) throw new Error('value is required');
    const el = p.locator(selector);
    await el.waitFor({ timeout: input.timeout || 10000 });
    await el.selectOption(value);
    return { content: `Selected "${value}" in "${selector}"` };
}

async function actionGetUrl(input) {
    const p = await ensureBrowser();
    return { content: `URL: ${p.url()}\nTitle: ${await p.title()}` };
}

async function actionWait(input) {
    const p = await ensureBrowser();
    const ms = input.ms || 1000;
    await p.waitForTimeout(ms);
    return { content: `Waited ${ms}ms` };
}

async function actionClose(input) {
    const target = (input && input.profile) || currentProfile || 'default';

    // 关闭全部 profile（真多开环境一键清理）
    if (target === 'all') {
        const names = [...browserProfiles.keys()];
        for (const name of names) {
            const entry = browserProfiles.get(name);
            if (entry && entry.context) {
                try { await entry.context.close(); } catch (e) {}
            }
        }
        browserProfiles.clear();
        currentProfile = 'default';
        return { content: `Closed all browser profiles: ${names.join(', ') || '(none)'}. Any new browser tool call will open a fresh session with the default profile.` };
    }

    // 关闭指定/当前 profile（不影响其他并行打开的 profile）
    const entry = browserProfiles.get(target);
    if (entry && entry.context) {
        try { await entry.context.close(); } catch (e) {}
    }
    browserProfiles.delete(target);
    if (currentProfile === target) {
        currentProfile = 'default';
    }
    return { content: `Closed browser profile "${target}". Other profiles remain open.` };
}

async function actionStatus(input) {
    if (browserProfiles.size === 0) {
        return { content: 'No browser profiles currently open. Call a browser tool with a "profile" argument to open one.' };
    }
    const lines = [];
    for (const [name, entry] of browserProfiles) {
        if (entry && entry.context && entry.page) {
            let url = '';
            try { url = entry.page.url(); } catch (e) { url = ''; }
            lines.push(`- "${name}": open (${url || 'no page loaded'})`);
        } else if (entry && entry.starting) {
            lines.push(`- "${name}": launching...`);
        } else {
            lines.push(`- "${name}": idle/closed`);
        }
    }
    return { content: `Browser profiles currently open:\n${lines.join('\n')}` };
}

// ── Router ──

async function executeBrowserTool(name, input) {
    input = input || {};
    if (input.profile && typeof input.profile === 'string') {
        currentProfile = input.profile;
    }
    try {
        switch (name) {
            case 'browser_navigate': return await actionNavigate(input);
            case 'browser_click': return await actionClick(input);
            case 'browser_fill': return await actionFill(input);
            case 'browser_screenshot': return await actionScreenshot(input);
            case 'browser_html': return await actionHtml(input);
            case 'browser_text': return await actionText(input);
            case 'browser_evaluate': return await actionEvaluate(input);
            case 'browser_scroll': return await actionScroll(input);
            case 'browser_back': return await actionBack(input);
            case 'browser_forward': return await actionForward(input);
            case 'browser_select': return await actionSelect(input);
            case 'browser_get_url': return await actionGetUrl(input);
            case 'browser_wait': return await actionWait(input);
            case 'browser_close': return await actionClose(input);
            case 'browser_status': return await actionStatus(input);
            default: return { content: `Unknown browser tool: ${name}`, is_error: true };
        }
    } catch (err) {
        return { content: `Browser error: ${err.message}`, is_error: true };
    }
}

// ════════════════════════════════════════════════════════
//  Browser Tool Definitions（单一来源）
//  供 tools.cjs 注册进 executeTool，作为 Simona 内置工具
//  直接随 Simona API 调用使用（无需 MCP server）。
//  所有 profile 相关描述统一为"真多开"语义。
// ════════════════════════════════════════════════════════

const PROFILE_DESC = '浏览器配置名（登录环境）。不同 profile 的 cookies/登录态完全隔离，且支持真多开——多个 profile 的浏览器窗口可同时并行打开、互不影响。用不同名称登录不同账号，如 "account1"、"account2"。默认 "default"。';

const BROWSER_TOOL_DEFINITIONS = [
    {
        name: 'browser_navigate',
        description: 'Navigate the browser to a URL. Opens a browser if not already open. Only use when the user explicitly asks for browser automation (contains "浏览器" keyword).',
        input_schema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'The URL to navigate to' },
                timeout: { type: 'number', description: 'Navigation timeout in ms. Default: 30000' },
                profile: { type: 'string', description: PROFILE_DESC }
            },
            required: ['url']
        }
    },
    {
        name: 'browser_click',
        description: 'Click an element on the current page identified by CSS selector. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector for the element to click' },
                timeout: { type: 'number', description: 'Wait timeout in ms. Default: 10000' },
                profile: { type: 'string', description: PROFILE_DESC }
            },
            required: ['selector']
        }
    },
    {
        name: 'browser_fill',
        description: 'Fill an input field with text. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector for the input element' },
                value: { type: 'string', description: 'Text to fill in' },
                timeout: { type: 'number', description: 'Wait timeout in ms. Default: 10000' },
                profile: { type: 'string', description: PROFILE_DESC }
            },
            required: ['selector', 'value']
        }
    },
    {
        name: 'browser_screenshot',
        description: 'Take a screenshot of the current page. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path to save screenshot. Default: screenshot_<timestamp>.png' },
                fullPage: { type: 'boolean', description: 'Capture full page (scrolling). Default: false' },
                profile: { type: 'string', description: PROFILE_DESC }
            }
        }
    },
    {
        name: 'browser_html',
        description: 'Get the HTML content of the page (or a specific element). Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector. If omitted, returns full page HTML.' },
                timeout: { type: 'number', description: 'Wait timeout in ms. Default: 10000' },
                profile: { type: 'string', description: PROFILE_DESC }
            }
        }
    },
    {
        name: 'browser_text',
        description: 'Get the visible text content of the page (or a specific element). Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector. If omitted, returns body text.' },
                timeout: { type: 'number', description: 'Wait timeout in ms. Default: 10000' },
                profile: { type: 'string', description: PROFILE_DESC }
            }
        }
    },
    {
        name: 'browser_evaluate',
        description: 'Execute JavaScript code in the browser page context. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                script: { type: 'string', description: 'JavaScript code to execute' },
                profile: { type: 'string', description: PROFILE_DESC }
            },
            required: ['script']
        }
    },
    {
        name: 'browser_scroll',
        description: 'Scroll the page in a direction. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                direction: { type: 'string', description: 'Direction to scroll: up, down, left, right. Default: down', enum: ['up', 'down', 'left', 'right'] },
                amount: { type: 'number', description: 'Pixels to scroll. Default: 500' },
                profile: { type: 'string', description: PROFILE_DESC }
            }
        }
    },
    {
        name: 'browser_back',
        description: 'Go back to the previous page. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                profile: { type: 'string', description: PROFILE_DESC }
            }
        }
    },
    {
        name: 'browser_forward',
        description: 'Go forward to the next page. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                profile: { type: 'string', description: PROFILE_DESC }
            }
        }
    },
    {
        name: 'browser_select',
        description: 'Select an option from a dropdown/select element. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector for the select element' },
                value: { type: 'string', description: 'Value to select' },
                timeout: { type: 'number', description: 'Wait timeout in ms. Default: 10000' },
                profile: { type: 'string', description: PROFILE_DESC }
            },
            required: ['selector', 'value']
        }
    },
    {
        name: 'browser_get_url',
        description: 'Get the current page URL and title. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                profile: { type: 'string', description: PROFILE_DESC }
            }
        }
    },
    {
        name: 'browser_wait',
        description: 'Wait for a specified time in milliseconds. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                ms: { type: 'number', description: 'Milliseconds to wait. Default: 1000' },
                profile: { type: 'string', description: PROFILE_DESC }
            }
        }
    },
    {
        name: 'browser_close',
        description: 'Close a browser profile. Pass profile: "all" to close every open profile. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                profile: { type: 'string', description: 'Browser profile to close. If omitted, closes the current/default session. Use "all" to close every parallel profile.' }
            }
        }
    },
    {
        name: 'browser_status',
        description: 'List all currently open browser profiles and their status (which login environments have open windows and their URLs). Useful to verify multi-profile multi-open state. Only use when the user explicitly asks for browser automation.',
        input_schema: {
            type: 'object',
            properties: {
                profile: { type: 'string', description: 'Optional. If provided, shows only this profile.' }
            }
        }
    }
];

module.exports = { executeBrowserTool, BROWSER_TOOL_DEFINITIONS };