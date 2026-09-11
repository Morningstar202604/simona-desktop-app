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
let context = null;       // BrowserContext from launchPersistentContext
let page = null;
let loadedProfile = null; // 当前打开的浏览器配置名称 (null = 已关闭)
let browserStarting = false;
let browserStartPromise = null;

// 供 executeBrowserTool() 从 input.profile 设置
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
 * - 开发模式：项目根目录/Chromium/
 * - 打包模式：Electron userData/Chromium/（可写，持久化）
 */
function getChromiumDir() {
    const devPath = path.join(__dirname, '..', 'Chromium');
    if (process.resourcesPath) {
        try {
            const { app } = require('electron');
            return path.join(app.getPath('userData'), 'Chromium');
        } catch (e) {
            // electron 模块不可用时回退
        }
    }
    return devPath;
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
    if (process.resourcesPath) {
        try {
            const { app } = require('electron');
            return path.join(app.getPath('userData'), 'browser-profiles');
        } catch (e) {}
    }
    return path.join(__dirname, '..', 'browser-profiles');
}

// ── 浏览器核心 ──

async function ensureBrowser() {
    const profile = currentProfile || 'default';

    // 复用已有浏览器实例
    if (context && loadedProfile === profile) {
        console.log(`[Browser-Tools] Reusing existing browser instance for profile "${profile}"`);
        const pages = context.pages();
        page = pages.length > 0 ? pages[pages.length - 1] : await context.newPage();
        if (pages.length > 1) {
            await page.bringToFront();
        }
        return page;
    }

    // 切换配置
    if (context) {
        console.log(`[Browser-Tools] Switching profile from "${loadedProfile}" to "${profile}" — closing previous context`);
        await context.close();
        context = null;
        page = null;
        loadedProfile = null;
    }

    // 等已有启动
    if (browserStarting) {
        console.log('[Browser-Tools] Browser launch already in progress, waiting...');
        return browserStartPromise.then(() => page);
    }

    // 启动新浏览器
    browserStarting = true;
    browserStartPromise = (async () => {
        const pw = await ensurePlaywright();
        const userDataDir = path.join(getProfilesBaseDir(), profile);
        try {
            const profilesDir = path.dirname(userDataDir);
            if (!fs.existsSync(profilesDir)) {
                fs.mkdirSync(profilesDir, { recursive: true });
            }

            // 确保 Chromium 可用（不存在则自动下载）
            const chromiumPath = await ensureChromium();

            context = await pw.chromium.launchPersistentContext(userDataDir, {
                executablePath: chromiumPath,
                headless: false,
                args: ['--no-sandbox', '--disable-dev-shm-usage', '--start-maximized'],
                viewport: null
            });
            loadedProfile = profile;
            const pages = context.pages();
            page = pages.length > 0 ? pages[0] : await context.newPage();
            console.log(`[Browser-Tools] Launched persistent context for profile "${profile}" at ${userDataDir}`);
        } catch (e) {
            context = null;
            page = null;
            loadedProfile = null;
            console.error('[Browser-Tools] Failed to launch browser:', e.message);
            throw new Error(`Failed to launch browser: ${e.message}`);
        } finally {
            browserStarting = false;
        }
    })();

    return browserStartPromise.then(() => page);
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
    if (context) {
        await context.close();
    }
    context = null;
    page = null;
    loadedProfile = null;
    currentProfile = 'default';
    return { content: 'Browser closed. Any new browser tool call will open a fresh session with the default profile.' };
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
            default: return { content: `Unknown browser tool: ${name}`, is_error: true };
        }
    } catch (err) {
        return { content: `Browser error: ${err.message}`, is_error: true };
    }
}

module.exports = { executeBrowserTool };