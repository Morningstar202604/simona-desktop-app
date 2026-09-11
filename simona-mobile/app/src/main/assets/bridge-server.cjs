const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const { app } = require('electron');
const { TOOL_DEFINITIONS, executeTool } = require('./tools.cjs');
const { initConvRepo, createConvCheckpoint, createConvTag, rollbackConvToTag, findRollbackTag, cleanupConvRepo } = require('./git-utils.cjs');
const lfh = require('./large-file-handler.cjs');

// Ensure ~/.simona.json exists — Android runs as root, may not have this file
try {
    var _simonaJsonPath = path.join(os.homedir(), '.simona.json');
    if (!fs.existsSync(_simonaJsonPath)) {
        var _backupDir = path.join(os.homedir(), '.simona', 'backups');
        var _restored = false;
        try {
            if (fs.existsSync(_backupDir)) {
                var _backups = fs.readdirSync(_backupDir).filter(function(f) { return f.indexOf('.simona.json.backup.') === 0; }).sort();
                if (_backups.length > 0) {
                    fs.copyFileSync(path.join(_backupDir, _backups[_backups.length - 1]), _simonaJsonPath);
                    console.log('[Bridge] Restored .simona.json from backup:', _backups[_backups.length - 1]);
                    _restored = true;
                }
            }
        } catch (e) { /* ignore backup restore errors */ }
        if (!_restored) {
            fs.writeFileSync(_simonaJsonPath, '{}');
            console.log('[Bridge] Created minimal .simona.json at:', _simonaJsonPath);
        }
    }
} catch (e) {
    console.log('[Bridge] Could not create .simona.json:', e.message);
}

// Remote proxy server (full proxy mode)
const REMOTE_SERVER = 'http://47.115.40.226:80';
let jwtToken = ''; // JWT token from remote auth

// No longer needed — SDK removed, using direct API calls
function enableNodeModeForChildProcesses() {
    console.log('[Engine] Direct API mode — no SDK subprocess needed');
}

// ============================================
// OpenClaw WeChat Gateway Management (in bridge-server)
// ============================================
let openclawGatewayProcess = null;
const GATEWAY_PORT = 18789;

/**
 * 检查网关端口 18789 是否被占用
 * 只要端口不可绑定，就认为已连接（包括 TIME_WAIT 状态）
 */
async function checkGatewayPort() {
    return new Promise((resolve) => {
        const net = require('net');
        const server = net.createServer();
        server.listen(GATEWAY_PORT, '0.0.0.0', () => {
            server.close();
            resolve(false); // 端口空闲，网关未运行
        });
        server.on('error', () => {
            // 端口不可绑定（被占用或 TIME_WAIT），认为已连接
            resolve(true);
        });
    });
}

/**
 * 启动 OpenClaw 网关
 * 只要端口 18789 上有进程监听，就认为已连接
 */
async function startOpenclawGateway() {
    // 首先检查端口是否已有进程监听
    const isPortOccupied = await checkGatewayPort();
    if (isPortOccupied) {
        console.log('[WeChat] Port 18789 is occupied, gateway is already connected');
        return { success: true, status: 'already_connected' };
    }

    // 端口空闲，尝试启动网关
    console.log('[WeChat] OpenClaw gateway no longer supported');
    return { success: false, error: 'openclaw 依赖已移除' };
}

/**
 * 停止 OpenClaw 网关
 */
async function stopOpenclawGateway() {
    if (openclawGatewayProcess) {
        console.log('[WeChat] Stopping gateway process...');
        openclawGatewayProcess.kill();
        openclawGatewayProcess = null;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // 同时通过端口检查清理可能残留的进程
    const isPortOccupied = await checkGatewayPort();
    if (isPortOccupied) {
        console.log('[WeChat] Port still occupied, attempting to kill process...');
        try {
            const { execSync } = require('child_process');
            const output = execSync(`netstat -ano | findstr ":${GATEWAY_PORT}"`, { encoding: 'utf8' });
            const lines = output.trim().split('\n').filter(l => l.includes('LISTENING'));
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && /^\d+$/.test(pid)) {
                    execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf8' });
                    console.log(`[WeChat] Killed process ${pid}`);
                }
            }
        } catch (e) {
            console.log('[WeChat] No process found or already killed');
        }
    }

    console.log('[WeChat] Gateway stopped');
    return { success: true, status: 'stopped' };
}

/**
 * 获取网关状态
 */
async function getWechatStatus() {
    const isPortOccupied = await checkGatewayPort();
    return {
        connected: isPortOccupied,
        gatewayPort: GATEWAY_PORT,
        status: isPortOccupied ? 'connected' : 'disconnected',
    };
}

// Load custom system prompt (only affects this Electron app, not external CLI usage)
const CUSTOM_SYSTEM_PROMPT_PATH = path.join(__dirname, 'system-prompt.txt');
let customSystemPromptFull = '';  // Full prompt including anti-Kiro sections (for Clawparrot)
let customSystemPromptClean = ''; // Without anti-Kiro sections (for self-hosted)
try {
    if (fs.existsSync(CUSTOM_SYSTEM_PROMPT_PATH)) {
        customSystemPromptFull = fs.readFileSync(CUSTOM_SYSTEM_PROMPT_PATH, 'utf8');
        // Strip <override_instructions> blocks only, keep <identity> for self-hosted users
        customSystemPromptClean = customSystemPromptFull
            .replace(/<override_instructions>[\s\S]*?<\/override_instructions>\s*/g, '');
        console.log(`[System Prompt] Loaded (full=${customSystemPromptFull.length}, clean=${customSystemPromptClean.length} chars)`);
    } else {
        console.warn('[System Prompt] Custom prompt file not found at:', CUSTOM_SYSTEM_PROMPT_PATH);
    }
} catch (e) {
    console.error('[System Prompt] Failed to load:', e.message);
}

function initServer(mainWindow) {
    const server = express();
    server.use(cors());
    server.use(express.json());

    // Serve static files from dist directory (for web access)
    const distPath = path.join(__dirname, '..', 'dist');
    if (fs.existsSync(distPath)) {
        server.use(express.static(distPath, {
            index: 'index.html',
            setHeaders: (res, filePath) => {
                // Set proper MIME types
                if (filePath.endsWith('.js')) {
                    res.setHeader('Content-Type', 'application/javascript');
                } else if (filePath.endsWith('.css')) {
                    res.setHeader('Content-Type', 'text/css');
                } else if (filePath.endsWith('.html')) {
                    res.setHeader('Content-Type', 'text/html');
                }
            }
        }));
        console.log('[Bridge Server] Static files served from:', distPath);
    } else {
        console.warn('[Bridge Server] Dist directory not found at:', distPath);
    }

    // Handle SPA routing - return index.html for all non-API routes
    server.use((req, res, next) => {
        // Skip API routes and OpenAI-compatible routes
        if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
            return next();
        }
        // For all other routes, serve index.html (SPA fallback)
        const indexPath = path.join(distPath, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        } else {
            next();
        }
    });

    // Track active engine child processes per conversation (for stdin writes like AskUserQuestion)
    const activeChildren = new Map();

    // ── Engine process pool (set SIMONA_ENGINE_POOL=0 to disable) ──
    // After a message completes, the engine process stays alive (its stdin is
    // kept open for control_response anyway). The next message in the SAME
    // conversation is written to that process's stdin instead of spawning a
    // fresh bun process — eliminating the full engine startup cost (~2-8s)
    // per follow-up message. Safety: fingerprinted by model/permission-mode/
    // apiFormat/keys/workspace/system-prompt; any config drift or dead process
    // falls back to a fresh spawn. Idle processes are killed after TTL.
    const ENGINE_POOL_ENABLED = process.env.SIMONA_ENGINE_POOL !== '0'; // enabled by default on Android — opt-out (set SIMONA_ENGINE_POOL=0 to disable)
    const ENGINE_POOL_IDLE_TTL_MS = 15 * 60 * 1000;
    const ENGINE_POOL_MAX = 4;
    const enginePool = new Map(); // conversationId -> { child, fingerprint, idleSince }

    function enginePoolFingerprint(parts) {
        try {
            return require('crypto').createHash('md5').update(JSON.stringify(parts)).digest('hex');
        } catch (_) { return null; }
    }
    function poolTake(conversationId, fingerprint) {
        const e = enginePool.get(conversationId);
        if (!e) return null;
        enginePool.delete(conversationId);
        const c = e.child;
        if (!c || c.killed || c.exitCode !== null || !c.stdin || c.stdin.destroyed) {
            try { if (c) c.kill(); } catch (_) {}
            return null;
        }
        if (!fingerprint || e.fingerprint !== fingerprint) {
            try { c.stdin.end(); } catch (_) {}
            try { c.kill(); } catch (_) {}
            return null;
        }
        return c;
    }
    function poolRelease(conversationId, child, fingerprint) {
        if (!ENGINE_POOL_ENABLED || !fingerprint) return false;
        if (!child || child.killed || child.exitCode !== null || !child.stdin || child.stdin.destroyed) return false;
        if (enginePool.size >= ENGINE_POOL_MAX) {
            let oldestKey = null, oldestT = Infinity;
            for (const [k, v] of enginePool) { if (v.idleSince < oldestT) { oldestT = v.idleSince; oldestKey = k; } }
            if (oldestKey !== null) {
                const ev = enginePool.get(oldestKey);
                enginePool.delete(oldestKey);
                try { ev.child.stdin.end(); } catch (_) {}
                try { ev.child.kill(); } catch (_) {}
            }
        }
        enginePool.set(conversationId, { child, fingerprint, idleSince: Date.now() });
        const timer = setTimeout(() => {
            const e = enginePool.get(conversationId);
            if (e && e.child === child) {
                enginePool.delete(conversationId);
                try { child.stdin.end(); } catch (_) {}
                try { child.kill(); } catch (_) {}
            }
        }, ENGINE_POOL_IDLE_TTL_MS);
        if (timer && typeof timer.unref === 'function') timer.unref();
        return true;
    }
    function poolKill(conversationId) {
        const e = enginePool.get(conversationId);
        if (e) {
            enginePool.delete(conversationId);
            try { e.child.stdin.end(); } catch (_) {}
            try { e.child.kill(); } catch (_) {}
        }
        // Clean up sysPromptFile (path is keyed by conversation_id)
        try { fs.unlinkSync(path.join(os.tmpdir(), 'simona-sys-prompt-' + conversationId + '.tmp')); } catch (_) {}
    }

    // Stash original AskUserQuestion input per conversation so /answer can merge user answers into updatedInput
    const askUserPendingInputs = new Map();

    // Tool-permission approval: pending control_request awaiting user decision (request_id → { child, tool_use_id, input, tool_name })
    const pendingPermissionRequests = new Map();

    // Auto-approve toggle for tool permissions (set via settings page → POST /api/permissions/config)
    const permissionConfigPath = (() => {
        try { return path.join(app.getPath('userData'), 'simona-permission-config.json'); }
        catch (_) { return path.join(os.homedir() || '.', 'simona-permission-config.json'); }
    })();
    let autoApprovePermissions = (() => {
        try { return !!JSON.parse(fs.readFileSync(permissionConfigPath, 'utf8')).autoApprove; }
        catch (_) { return false; }
    })();
    function saveAutoApprovePermissions(val) {
        try { fs.writeFileSync(permissionConfigPath, JSON.stringify({ autoApprove: val })); } catch (_) {}
    }

    // Per-conversation stream state: buffer events so frontend can reconnect mid-stream
    // Key: conversationId, Value: { events: [], listeners: Set<res>, done: boolean }
    const activeStreams = new Map();
    const conversationUsage = new Map(); // conversationId → { inputTokens, outputTokens }

    function broadcastSSE(conversationId, event) {
        const stream = activeStreams.get(conversationId);
        if (!stream) return;
        stream.events.push(event);
        const line = 'data: ' + JSON.stringify(event) + '\n\n';
        var arr = Array.from(stream.listeners);
        for (var i = 0; i < arr.length; i++) {
            try { arr[i].write(line); } catch (_) { stream.listeners.delete(arr[i]); }
        }
    }

    // Windows 下强力终止进程树（taskkill /F /T 可杀掉所有子进程）
    function killProcessTree(pid) {
        if (!pid) return;
        if (process.platform === 'win32') {
            try {
                const { execSync } = require('child_process');
                execSync('taskkill /PID ' + pid + ' /T /F', { timeout: 3000, stdio: 'ignore' });
                console.log('[Kill] taskkill /F /T PID', pid);
            } catch (e) {
                // taskkill may fail if process already died — that's fine
            }
        } else {
            try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
            try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
    }

    function endStream(conversationId) {
        const stream = activeStreams.get(conversationId);
        if (!stream) return;
        stream.done = true;
        // End the primary POST response
        if (stream.primaryRes) {
            try { stream.primaryRes.write('data: [DONE]\n\n'); stream.primaryRes.end(); } catch (_) {}
            stream.primaryRes = null;
        }
        // End all reconnect listeners
        for (const r of stream.listeners) {
            try { r.write('data: [DONE]\n\n'); r.end(); } catch (_) {}
        }
        stream.listeners.clear();
        // Keep buffer for 30s so frontend can still reconnect after slight delay
        setTimeout(() => {
            if (activeStreams.get(conversationId) === stream) {
                activeStreams.delete(conversationId);
                // 会话结束：移除该会话的代理转发目标（proxyTargets），
                // 但会话 key 保留在 sensenovaSessionKeys 中供 10 分钟内续聊复用（避免频繁换 key）
                // 注意：proxyTargets 键统一用 String(conversationId)；pendingImageBlocks 键是数字类型
                proxyTargets.delete(String(conversationId));
                pendingImageBlocks.delete(conversationId);
            }
        }, 30000);
    }

    // -- Shared compaction helper --
    async function compactConversation(conversationId, options = {}) {
        const conv = db.conversations.find(c => c.id === conversationId);
        if (!conv) throw new Error('Conversation not found');
        if (!conv.simona_session_id) throw new Error('No engine session to compact');

        const apiKey = options.apiKey || engineEnvVars.SIMONA_API_KEY || process.env.SIMONA_API_KEY;
        const baseUrl = options.baseUrl || engineEnvVars.SIMONA_BASE_URL || process.env.SIMONA_BASE_URL;
        const modelId = (conv.model || 'simona-sonnet-4-6').replace(/-thinking$/, '');
        const instruction = options.instruction || '';

        const messagesBeforeCompact = db.messages.filter(m => m.conversation_id === conversationId).length;

        const compactPrompt = instruction ? '/compact ' + instruction : '/compact';
        const cliArgs = [
            '--preload', enginePreload,
            '--env-file=' + engineEnv, engineCli,
            '-p', compactPrompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--model', modelId,
            '--resume', conv.simona_session_id,
        ];

        const envVars = Object.assign({}, process.env);
        envVars.BUN_DISABLE_GLOBAL_CACHE = '1'; envVars.IS_SANDBOX = '1'; // Android runs as root — bypass root-user bypassPermissions check
        const engineDir = path.dirname(path.dirname(engineCli));
        envVars.NODE_PATH = path.join(engineDir, 'node_modules');
        if (apiKey) envVars.SIMONA_API_KEY = apiKey;
        if (baseUrl) envVars.SIMONA_BASE_URL = baseUrl;

        console.log('[Compact] Spawning engine /compact, session=' + conv.simona_session_id + ' model=' + modelId);

        const child = spawn(bunExePath, cliArgs, {
            cwd: conv.workspace_path, env: envVars,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        child.stdin.end();

        let compactSummary = '';
        let compactMetadata = null;
        let buf = '';

        child.stdout.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            const lines = buf.split('\n');
            buf = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                let evt;
                try { evt = JSON.parse(line); } catch { continue; }

                if (evt.type === 'system' && evt.subtype === 'compact_boundary') {
                    compactMetadata = evt.compact_metadata || {};
                    console.log('[Compact] Engine compact_boundary:', JSON.stringify(compactMetadata));
                }
                if (evt.type === 'assistant' && evt.message && evt.message.content) {
                    for (const block of evt.message.content) {
                        if (block.type === 'text' && block.text) {
                            compactSummary += block.text;
                        }
                    }
                }
                if (evt.type === 'stream_event' && evt.event) {
                    const se = evt.event;
                    if (se.type === 'content_block_delta' && se.delta && se.delta.type === 'text_delta') {
                        compactSummary += se.delta.text;
                    }
                }
                if (evt.type === 'result' && evt.result && !compactSummary) {
                    compactSummary = typeof evt.result === 'string' ? evt.result : '';
                }
            }
        });

        let stderrBuf = '';
        child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

        await new Promise((resolve, reject) => {
            child.on('close', (code) => {
                if (buf.trim()) {
                    try {
                        const e = JSON.parse(buf);
                        if (e.type === 'system' && e.subtype === 'compact_boundary') {
                            compactMetadata = e.compact_metadata || {};
                        }
                        if (!compactSummary && e.result) compactSummary = typeof e.result === 'string' ? e.result : '';
                    } catch (_) {}
                }
                if (code !== 0 && !compactMetadata) {
                    reject(new Error(stderrBuf || 'Engine compact failed with exit code ' + code));
                } else {
                    resolve();
                }
            });
            child.on('error', reject);
        });

        const tokensSaved = compactMetadata && compactMetadata.pre_tokens
            ? Math.round(compactMetadata.pre_tokens * 0.7)
            : Math.round(messagesBeforeCompact * 500);

        db.messages.push({
            id: uuidv4(),
            conversation_id: conversationId,
            role: 'system',
            content: JSON.stringify([{ type: 'text', text: compactSummary || 'Conversation compacted.' }]),
            created_at: new Date().toISOString(),
            is_compact_boundary: true,
        });
        saveDb();

        // Reset token tracking so context-size endpoint returns 0
        conversationUsage.set(conversationId, { inputTokens: 0, outputTokens: 0 });

        console.log('[Compact] Done: ' + messagesBeforeCompact + ' messages compacted, ~' + tokensSaved + ' tokens saved');
        return { summary: compactSummary || 'Conversation compacted.', tokensSaved, messagesCompacted: messagesBeforeCompact };
    }


    // Setup paths
    const userDataPath = app.getPath('userData');
    const dbPath = path.join(userDataPath, 'simona-desktop.json');

    // Workspace: use user-chosen path, or default to ~/Documents/Simona Desktop
    const defaultWorkspacesDir = path.join(app.getPath('documents'), 'Simona Desktop');
    // Read saved preference (set by onboarding or settings)
    let workspacesDir;
    try {
        const settingsPath = path.join(userDataPath, 'workspace-config.json');
        if (fs.existsSync(settingsPath)) {
            const cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            workspacesDir = cfg.workspacesDir || defaultWorkspacesDir;
        } else {
            workspacesDir = defaultWorkspacesDir;
        }
    } catch (_) {
        workspacesDir = defaultWorkspacesDir;
    }

    if (!fs.existsSync(workspacesDir)) {
        fs.mkdirSync(workspacesDir, { recursive: true });
    }
    console.log('[Workspace]', workspacesDir);

    // Initialize DB
    let db = { conversations: [], messages: [], projects: [], project_files: [] };
    if (fs.existsSync(dbPath)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
            db = { ...db, ...loaded };
            // Ensure new arrays exist for older DB files
            if (!db.projects) db.projects = [];
            if (!db.project_files) db.project_files = [];
            
            // Migration: Ensure all conversations have workspace_path
            let migrated = 0;
            for (const conv of db.conversations) {
                if (!conv.workspace_path) {
                    conv.workspace_path = workspacesDir;
                    migrated++;
                }
            }
            if (migrated > 0) {
                console.log('[DB] Migrated', migrated, 'conversations to have workspace_path');
                saveDb();
            }
            
            // Migration: Fix garbled filenames (UTF-8 interpreted as Latin-1)
            let fixedFiles = 0;
            for (const file of db.project_files) {
                if (file.file_name && /[äåöü]/.test(file.file_name)) {
                    try {
                        const latin1Bytes = Buffer.from(file.file_name, 'latin1');
                        const fixedName = latin1Bytes.toString('utf8');
                        // Only update if the fixed name looks valid (contains Chinese characters)
                        if (/[\u4e00-\u9fff]/.test(fixedName)) {
                            file.file_name = fixedName;
                            fixedFiles++;
                        }
                    } catch (e) {}
                }
            }
            if (fixedFiles > 0) {
                console.log('[DB] Fixed', fixedFiles, 'garbled filenames');
                saveDb();
            }
            
            // Migration: Add enabled field to existing project files
            let migratedFiles = 0;
            for (const file of db.project_files) {
                if (file.enabled === undefined) {
                    file.enabled = true; // Default to enabled for backward compatibility
                    migratedFiles++;
                }
            }
            if (migratedFiles > 0) {
                console.log('[DB] Migrated', migratedFiles, 'project files to have enabled field');
                saveDb();
            }
        } catch (e) { }
    }
    const saveDb = () => {
            const dbDir = path.dirname(dbPath);
            if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
            fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
        };

    // ===== Provider Management =====
    // Support both development and production (packed) mode
    const projectRoot = path.join(__dirname, '..');
    
    // In production, providers.json is in extraResources
    // extraResources are placed in resources/ directory
    const resourcesPath = process.resourcesPath || projectRoot;
    
    // Try multiple locations for providers.json
    // IMPORTANT: userData path MUST come first so that modifications made via the UI
    // (which save to userData) take precedence over the packaged default.
    const possiblePaths = [
        process.resourcesPath ? path.join(app.getPath('userData'), 'providers.json') : null,  // User-modified (production)
        path.join(resourcesPath, 'providers.json'),  // Packed default (extraResources)
        path.join(projectRoot, 'providers.json'),     // Development
    ].filter(Boolean);
    
    let providersPath = null;
    let providers = [];
    
    for (const testPath of possiblePaths) {
        try {
            if (fs.existsSync(testPath)) {
                providers = JSON.parse(fs.readFileSync(testPath, 'utf8'));
                providersPath = testPath;
                console.log('[Providers] Loaded from:', testPath);
                break;
            }
        } catch (err) {
            console.error('[Providers] Failed to load from', testPath, ':', err.message);
        }
    }
    
    if (!providersPath) {
        console.warn('[Providers] No providers.json found, using empty providers list');
    }
    
    const saveProviders = () => {
        // Save to AppData in production, or project root in development
        const savePath = process.resourcesPath ? 
            path.join(app.getPath('userData'), 'providers.json') : 
            path.join(projectRoot, 'providers.json');
        try {
            fs.writeFileSync(savePath, JSON.stringify(providers, null, 2));
            console.log('[Providers] Saved to:', savePath);
        } catch (err) {
            console.error('[Providers] Failed to save:', err.message);
        }
    };

    // Fetch DeepSeek API key from remote server and override in-memory provider (don't save to file)
    const deepseekServerKey = ''; // identifier only
    const deepseekProvider = providers.find(p => p.id === 'deepseek-fixed-mode');
    if (deepseekProvider) {
        // Replace in-memory key with a sentinel — the actual key is on the remote server
        deepseekProvider.apiKey = deepseekServerKey;
        // Attempt to fetch the real key from server to verify connectivity
        (async () => {
            try {
                const resp = await fetch(REMOTE_SERVER + '/api/v1/deepseek-key');
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.key) {
                        console.log('[DeepSeek] Server key verified, baseUrl:', data.baseUrl);
                    }
                }
            } catch (e) {
                console.warn('[DeepSeek] Cannot reach server for key verification:', e.message);
            }
        })();
    }

    // Sensenova key pool — 本地密钥池轮转（不再经过远程服务器）
    // 100 把密钥硬编码在本地，通过轮转 + 冷却机制管理。零网络往返。
    const sensenovaProvider = providers.find(p => p.id === 'sensenova-free');
    const LOCAL_SENSENOVA_KEYS = [
        "sk-zi6ZpdHhpn3qSLEuejJw3o6oCpqXAZVL","sk-XhbpknPI41ceQsmJ7Ju4JdAX5JRrikyG","sk-dvw82SEDhPUdBDnpcbRKV3Hd6cmiCv39","sk-hTolmSeOH6M7koO1IC1VSVRaRvtZQCWw","sk-jRXQSey38WeRw6er4NXbvllevFrVqpeS","sk-lG3lHlpAGpw991VtH5zJXRX4PuCpzP8Q","sk-m8arYcPBJKSFGaoMdEXYI5Ea15hCBxGv","sk-ntsXWlplZdjJSypsNrf9iK8KoRMJqNag","sk-oRN3vsYwYlXLSXx2WhrQ1iLJHkhGsdg3","sk-pU2aCEeuZMW3Xve1G7sQ8TebtlV7pLmr","sk-qdQ5RCZAcECunR7YGGBLZKudp5JHgpmK","sk-s1s45RoMpNkUzHjIlZjrulsDAfEZPSxR","sk-sXN7IBJW4VpgDNfPh57FdqfhmyyvbX7K","sk-tyhM1SvJ2r8Aw95mhDOhuAyxt4SX97gX","sk-v7IWKYtSaUrT7Wy2hsuTJxbIovv44R4w","sk-vw7Q9EuGAElj7N3btdlmznepoRexL8ct","sk-wP6HauyigaAWD2RhnbdjSEkHpw4BzY58","sk-weQanJyuWEgyxOnDWHSkhcNJYRoHqRFc","sk-ySTA8qNg5PNwWVa7hcAcFYM3df89jzcY","sk-Jy6Z3kuD99xDdsbpN5LLRgHR3KQg3eN8","sk-MQ7GvVCpacCYKB7myq8Vbrn3owrGOWZr","sk-Mg7zZsDpAAvcRAyR9Dc1lbL9mz2OyYqY","sk-P1HKv2XMIovJQmruEINH2z6KfroL43hH","sk-PeNm7yK8Y85ris78rV6VdM7DToRXKdCp","sk-PwmxGNLZGOvfAJ9hvvgxRfTFa42vmGQT","sk-QDcarMpejEskH5S8zuiAlifOe3bhPbKT","sk-S64XvcRlPqGy24lcVpk3Y86qXy7URu37","sk-SQ4XfgmODWzAxhkqLFWVLGdrohORXhar","sk-TI6VrGowsY1Cr9n4eqxgUi3z5DrTYS2b","sk-Uyb1GId9NOR3fzVgdBPQa54jntwVcXF4","sk-dsR6P8eshM2VzbFYwUX8g7Vp27tAxI8n","sk-5xa52BMLDYg7XZXdCaGavynIMebQ2BvN","sk-6RemvSplofiiPieyiaFcq9u8aBLMZjg9","sk-9zHZgpMzmhNnrfQfmZQJPVVWJYtKmOpr","sk-BegxtvwUKzxbTolLREPKLoqG23jhJGIl","sk-DtypVSdpP7nYlClTC7kzSmEcbEA6owxZ","sk-E8lIDGE9wK8JcIyxbJYvQWIskgCuj3VM","sk-EF38dgSXVRgItshYDsyNUSNFe3cVSSNG","sk-EZgENSEpVqoMp6jlpHQ5BppV5wlYVyfA","sk-EtDU5GUmHymnffGYnqi4kmaFurlfgdRU","sk-GeHZsNYMBhVrxU1tOMhqxgCw51IunGcv","sk-HpRkpfjEOEVdMx2SKuFmlUUHGPvqNogg","sk-I4YItjdx9OepynGShe1GmKJ3JzZxMphk","sk-JMuDBPI96VUmGPLJmjYvMLwobWUz6osn","sk-NXustHPIisfZWhi8pALsh81rOJiR67YS","sk-gJYeNK2fsNATuT5SGrGy77U5EZurjo37","sk-4SeQ6XNCjOGOFpKjMAjj7G3BCKQ4l4dh","sk-CaeMkdDy6JdUdrv7KdYmITk5FXkK7fug","sk-dtfbr5KQi88uHRhGgJaWZUvF4ODqZVcu","sk-49ir9FjkLWajdik8vKPcmYqleFYYFUx1","sk-4LrEW2IuG1Qstc4JEsNjUesdeUkCquqy","sk-aERVXnLGnExPYsxGSIUjvsNdLFjEAX4Y","sk-2TCWENdGc9FfLEFDrl5RL4zejKaGrVJU","sk-1bVMz9onrsFbTu21nBCc2gyGQbLSyW5E","sk-IQbfvkKy8IY7krFGAGUZqkntGFrA5lMs","sk-1GpGmB5ObXdhKqcHpfCXVjWH46uVZhvI","sk-2J1dRqaQsqHm6SScgIDwHMTLftyzm9tw","sk-UedS3iegputdZxQ12WVtNvnA8JSZYChH","sk-4s8JxlGNvflyM5xdiBkZy81LZ195dMij","sk-7mkDoN9tiILakD219MIX21M3WuqCn7qN","sk-sZKneXdPwsXFPuSlkhjG8O8HCl38s9XD","sk-VaTgQTdpe8BOUt8oCjqykMNijOjzxeFK","sk-sLRPoRLmYH68xIVQm3shYzqHxOwZMBS4","sk-uUI25DvVQ58Ae86XaqpfH4QOBKf7YAH1","sk-v3myAcVmS3dwrgZzrd6XkBQBbQw5jMxZ","sk-PVklYfrycmVZiGzfTubMKhpllqG1xv8B","sk-42V5CFYbJsLHBYLlUsymPRkTh5gw5jPo","sk-gWc8SpnjyetVVB7iu4xqfV6ghHfsI8Zt","sk-w2vnnfAyTxGpciKdC2cpzGhRhH2GhoqK","sk-kQ6GPd8D2Dshv8trYoSEg767HQjbnHZz","sk-lOwbj1ja4uyCeJpUCsNYgbVvwwKuWHjx","sk-qL84Uzm55Vj3nbhCWNrwgxf6TvO5m1a1","sk-TPE3xf6t1kBZ6a84hKGbtUomQOeTkOYX","sk-h4OpXc18GTrVha86e4TNseoXY1cYUwID","sk-RouxM2c7IWdMYYtXbttHnz8vU9wWGURr","sk-KjeM9sOpgqLuVhnUFZKrbzM3xVVrc1Ce","sk-kajeNejBJyk5KAI7PdOC9DXcvgOrGRpn","sk-slZPeV5zAVB4BZez4T8pIYeEIifAV6H5","sk-NMfvE67oiOJn8PAQnYeHO2XLRqUuT9Vk","sk-pE5zYucGyhdfTVmQRFCX47LiCmJTc8TO","sk-2QJeTOOJ5N7HkeV3iR3p9a4gFEnqvStI","sk-wYdtmzFNH9IXnYCXJfcKD4n8vzFloMjF","sk-jxP9qKfnCKKcxcT8jsNhH5tJFQNGqyg1","sk-eBtKG23wpouyHkXMawgZUskAbgzSHMZT","sk-jr3tu2wxf8IKYbOoKCDVEYoruJ2tqGT9","sk-c62yKyAKl5KrouG7DKwTgUSpyNcZePbh","sk-PDE1LWWWXCCo2UZW4SB5pxWzriKsvcvP","sk-Lmrhr9FlDBYCsXIqVadkzEaKWThxX1jc","sk-yJxUVzJmyT8sENp17uHj8mLyZ69jcAYr","sk-yRROZq3UQ9vWcR9hECOlqkW8Rb6hiIHT","sk-8PuBAH5Gz5dftRE5Ng7c69FuwuNPtP63","sk-o64eZUwQaiU8RugbNLSOoxLgCvFJGQlr","sk-YCN2wJzWvi8ch2tr9JjOYw8MXoPZboXA","sk-XXa5EjufTb1k5nwnawf84owVeqj72Krq","sk-9UMJJGfYl4375r692LoULt4gg7Q4YVwU","sk-Iw62vQI5bIaYBouUMjGXGobMhEylnmlN","sk-tZUG96vHTYKCva2vNZm7tIXfNatVYhrj","sk-EXXDZ5NHyJmNWlRsmner17zhpK9RwDub","sk-xTgvDNaAxEJVz4vQYpQXzCoz3rd4UUOB","sk-Ruxjbp1X6u17SKTMGywahQyQ6k6BvJte"
    ];
    let sensenovaKeys = LOCAL_SENSENOVA_KEYS.slice();
    let sensenovaKeyIndex = 0;
    let sensenovaPoolTotal = LOCAL_SENSENOVA_KEYS.length;
    // 本地冷却集合：失败的 key 暂时跳过，5 分钟后自动恢复
    const localCooldown = new Map(); // key -> cooldownUntil timestamp
    function isKeyAvailable(key) {
        const cd = localCooldown.get(key);
        if (cd && cd > Date.now()) return false;
        localCooldown.delete(key);
        return true;
    }
    function getNextLocalKey(excludeKey) {
        for (let i = 0; i < LOCAL_SENSENOVA_KEYS.length; i++) {
            const idx = (sensenovaKeyIndex + i) % LOCAL_SENSENOVA_KEYS.length;
            const key = LOCAL_SENSENOVA_KEYS[idx];
            if (key === excludeKey) continue;
            if (!isKeyAvailable(key)) continue;
            sensenovaKeyIndex = (idx + 1) % LOCAL_SENSENOVA_KEYS.length;
            return key;
        }
        // 所有 key 都在冷却中，强制取下一个
        const key = LOCAL_SENSENOVA_KEYS[sensenovaKeyIndex % LOCAL_SENSENOVA_KEYS.length];
        sensenovaKeyIndex = (sensenovaKeyIndex + 1) % LOCAL_SENSENOVA_KEYS.length;
        return key;
    }
    // 本地版的 fetchSensenovaAssigned -- 不再请求远程服务器，零网络延迟
    async function fetchSensenovaAssigned(model, holder) {
        const key = getNextLocalKey();
        return { key, total: LOCAL_SENSENOVA_KEYS.length, available: LOCAL_SENSENOVA_KEYS.length };
    }
    // 本地版的 reportSensenovaKey -- 标记冷却，不请求远程服务器
    async function reportSensenovaKey(keyValue, ok, model, error) {
        if (!ok) {
            localCooldown.set(keyValue, Date.now() + 5 * 60 * 1000); // 5 分钟冷却
            console.log('[Sensenova] Key cooled down locally:', keyValue.slice(0, 10) + '...', 'reason:', error);
        }
    }
    // 初始化：直接用本地池第一个 key，零网络等待
    if (sensenovaProvider) {
        sensenovaProvider.apiKey = LOCAL_SENSENOVA_KEYS[0];
        console.log('[Sensenova] Local key pool loaded:', LOCAL_SENSENOVA_KEYS.length, 'keys (zero network round-trip)');
    }
    function rotateSensenovaKey(model) {
        const prev = sensenovaProvider ? sensenovaProvider.apiKey : '';
        if (prev) reportSensenovaKey(prev, false, model, 'quota_exceeded').catch(() => {});
        const nextKey = getNextLocalKey(prev);
        sensenovaKeys = [nextKey];
        sensenovaKeyIndex = 0;
        if (sensenovaProvider) sensenovaProvider.apiKey = nextKey;
        console.log('[Sensenova] Rotated to fresh local key');
        return true;
    }
    // ===== 会话独占密钥管理（本地版） =====
    const sensenovaSessionKeys = new Map(); // conversationId -> { key, model, assignedAt }
    const SESSION_KEY_IDLE_MS = 10 * 60 * 1000;
    async function acquireSensenovaKey(conversationId, model, forceRefresh) {
        if (!sensenovaProvider || !conversationId) return null;
        const now = Date.now();
        if (forceRefresh) {
            releaseSensenovaSessionKey(conversationId);
            sensenovaSessionKeys.delete(String(conversationId));
        } else {
            const bound = sensenovaSessionKeys.get(String(conversationId));
            if (bound) {
                if (bound.key && (now - bound.assignedAt) < SESSION_KEY_IDLE_MS) {
                    bound.assignedAt = now;
                    return bound.key;
                }
                releaseSensenovaSessionKey(conversationId);
            }
        }
        const key = getNextLocalKey();
        sensenovaSessionKeys.set(String(conversationId), { key, model, assignedAt: now });
        console.log('[Sensenova] Session ' + String(conversationId).slice(0, 8) + ' acquired local key');
        return key;
    }
    function releaseSensenovaSessionKey(conversationId) {
        const bound = sensenovaSessionKeys.get(String(conversationId));
        if (bound && bound.key) {
            console.log('[Sensenova] Released local session key for', String(conversationId).slice(0, 8));
            sensenovaSessionKeys.delete(String(conversationId));
        }
    }
    // 会话级换 key：本地轮转，零网络延迟
    async function nextSensenovaKeyForConversation(conversationId, model) {
        const bound = sensenovaSessionKeys.get(String(conversationId));
        const oldKey = bound ? bound.key : '';
        if (oldKey) {
            await reportSensenovaKey(oldKey, false, model, 'quota_exceeded').catch(() => {});
            sensenovaSessionKeys.delete(String(conversationId));
        }
        const newKey = getNextLocalKey(oldKey);
        sensenovaSessionKeys.set(String(conversationId), { key: newKey, model, assignedAt: Date.now() });
        console.log('[Sensenova] Session ' + String(conversationId).slice(0, 8) + ' rotated to new local key');
        return newKey;
    }
    async function nextSensenovaKey(model) {
        const prev = sensenovaProvider ? sensenovaProvider.apiKey : '';
        if (prev) reportSensenovaKey(prev, false, model, 'quota_exceeded').catch(() => {});
        const newKey = getNextLocalKey(prev);
        sensenovaKeys = [newKey];
        sensenovaPoolTotal = LOCAL_SENSENOVA_KEYS.length;
        sensenovaKeyIndex = 0;
        if (sensenovaProvider) sensenovaProvider.apiKey = newKey;
        console.log('[Sensenova] Rotated to next local key (pool ' + LOCAL_SENSENOVA_KEYS.length + ' keys)');
        return newKey;
    }

    // Resolve provider + key + url for a given model ID
    function resolveProvider(modelId) {
        // Search all enabled providers for this model
        let bestMatch = null;
        for (const p of providers) {
            if (!p.enabled) continue;
            if (p.models && p.models.some(m => (m.id === modelId || m.name === modelId) && m.enabled !== false)) {
                // Prefer non-billing providers when multiple match
                if (p.id !== 'deepseek-fixed-mode') {
                    return p;
                }
                bestMatch = p;
            }
        }
        return bestMatch;
    }

    // ===== URL normalization helper =====
    // Strips known endpoint suffixes so base URLs like
    // "https://api.siliconflow.cn/v1/chat/completions" become "https://api.siliconflow.cn/v1"
    function normalizeBaseUrl(url) {
        if (!url) return url;
        let clean = url.replace(/\/+$/, '');
        clean = clean.replace(/\/(chat\/completions|messages)$/, '');
        return clean.replace(/\/+$/, '');
    }

    // ===== OpenAI→Simona Conversion Proxy =====
    // Runs on a dynamic port; engine points SIMONA_BASE_URL to it
    // The proxy receives Simona-format requests, converts to OpenAI format, calls the real endpoint
    const http = require('http');
    let proxyPort = 0;

    // Stored per-request: the proxy reads these to know where to forward
    let proxyTarget = { apiKey: '', baseUrl: '', model: '', format: 'simona' };
    // 按会话隔离的 proxy 目标表：多会话并发时，每个会话走自己的 key/baseUrl，
    // 通过 engine 的 SIMONA_API_KEY='proxy-key-<conversationId>' 让代理能区分请求属于哪个会话
    const proxyTargets = new Map(); // conversationId → target

    // Pending image blocks to inject into the next API request (per-conversation)
    // The chat handler stores base64 images here; the proxy injects them into the user message
    const pendingImageBlocks = new Map(); // conversationId → [{ type: 'image', source: { type: 'base64', media_type, data } }]

    // ═══ Anti-refresh cache for browser tools ═══
    // The engine re-sends the FULL conversation history on EVERY request, so a browser
    // tool's "No such tool available" error result reappears on every turn. Without this
    // cache, the [Proxy-Browser] interceptor would re-execute the SAME browser_navigate
    // (etc.) on every turn, driving the Playwright page to navigate repeatedly — the
    // "一直刷新 / page refresh loop" bug. We execute each tool_use_id exactly ONCE,
    // cache the real result, and replay it on later turns (no re-execution, no refresh).
    const interceptedBrowserResults = new Map(); // tool_use_id → { content, is_error }

    const proxyServer = http.createServer(async (req, res) => {
        if (req.method === 'POST' && req.url.includes('/messages')) {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', async () => {
                try {
                    const simonaReq = JSON.parse(body);
                    // 会话隔离解析：engine 发送的 x-api-key 形如 proxy-key-<conversationId>，
                    // 从中识别会话，取出该会话自己的 proxy target（含专属 key），避免多会话互相抢占
                    let target = proxyTarget;
                    const reqApiKey = req.headers['x-api-key'] || '';
                    if (reqApiKey.startsWith('proxy-key-')) {
                        const sessionId = reqApiKey.slice('proxy-key-'.length);
                        const sessionTarget = proxyTargets.get(sessionId);
                        if (sessionTarget) {
                            target = sessionTarget;
                        } else {
                            console.warn('[Proxy] No session target for', sessionId.slice(0, 8), '- falling back to global proxyTarget');
                            proxyTarget.conversationId = sessionId;
                        }
                    } else if (reqApiKey && reqApiKey !== 'proxy-key') {
                        // 带真实 key 的请求（非代理会话）→ 视为该会话专用
                        const sessionId = proxyTarget.conversationId;
                        if (sessionId && !proxyTargets.has(sessionId)) {
                            proxyTargets.set(sessionId, Object.assign({}, proxyTarget));
                        }
                    }

                    // Inject any pending image blocks into the last user message
                    // (images uploaded by the user that need to be embedded in the API request)
                    // Only inject into the initial user message (not tool_result follow-ups).
                    // Don't delete — keep for retries. The chat handler clears after engine exits.
                    if (target.conversationId && pendingImageBlocks.has(target.conversationId)) {
                        const imgBlocks = pendingImageBlocks.get(target.conversationId);
                        if (imgBlocks && imgBlocks.length > 0 && simonaReq.messages) {
                            // Find the last user message that has text (not just tool_result)
                            for (let i = simonaReq.messages.length - 1; i >= 0; i--) {
                                const msg = simonaReq.messages[i];
                                if (msg.role !== 'user') continue;
                                const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
                                const hasToolResult = parts.some(b => b.type === 'tool_result');
                                if (hasToolResult) continue; // Skip tool_result messages
                                const existingContent = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
                                // Don't inject if images already present (re-injection on retry)
                                if (existingContent.some(b => b.type === 'image')) break;
                                msg.content = [...imgBlocks, ...existingContent];
                                console.log('[Proxy] Injected', imgBlocks.length, 'image block(s) into user message');
                                break;
                            }
                        }
                    }

                    if (target.format === 'openai') {
                        // Convert Simona → OpenAI format
                        const openaiMessages = [];
                        if (simonaReq.system) {
                            const sysText = Array.isArray(simonaReq.system)
                                ? simonaReq.system.map(b => typeof b === 'string' ? b : b.text || '').join('\n')
                                : simonaReq.system;
                            openaiMessages.push({ role: 'system', content: sysText });
                        }
                        // ── Build tool_use map from assistant messages ──
                        // Used to intercept browser tool errors and execute them locally
                        const assistantToolUseMap = new Map();
                        for (const msg of (simonaReq.messages || [])) {
                            if (msg.role === 'assistant') {
                                const parts = Array.isArray(msg.content) ? msg.content : [];
                                for (const block of parts) {
                                    if (block.type === 'tool_use') {
                                        assistantToolUseMap.set(block.id, { name: block.name, input: block.input || {} });
                                    }
                                }
                            }
                        }
                        for (const msg of (simonaReq.messages || [])) {
                            if (msg.role === 'user') {
                                // User messages may contain text, image, and tool_result blocks
                                const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
                                const textParts = parts.filter(b => b.type === 'text').map(b => b.text || '');
                                const imageParts = parts.filter(b => b.type === 'image');
                                const toolResults = parts.filter(b => b.type === 'tool_result');
                                if (toolResults.length > 0) {
                                    for (const tr of toolResults) {
                                        let trContent = Array.isArray(tr.content) ? tr.content.map(b => b.text || '').join('') : (tr.content || '');
                                        // ═══ Intercept browser tool errors: execute them locally and replace the result ═══
                                        // The engine's StreamingToolExecutor doesn't have browser_tool definitions,
                                        // so it returns "No such tool available". We intercept here and execute via Playwright.
                                        const toolInfo = assistantToolUseMap.get(tr.tool_use_id);
                                        if (toolInfo && toolInfo.name.startsWith('browser_') && (tr.is_error || trContent.includes('No such tool available'))) {
                                            // ═══ Anti-refresh fix ═══
                                            // The engine re-sends its FULL conversation history on EVERY request, so a
                                            // browser tool's "No such tool available" error result reappears on every turn.
                                            // Re-executing it every time would drive the Playwright page to navigate
                                            // repeatedly — the "一直刷新 / page refresh loop" bug. Execute each tool_use_id
                                            // exactly ONCE, cache the real result, and replay it on later turns.
                                            const cached = interceptedBrowserResults.get(tr.tool_use_id);
                                            if (cached) {
                                                trContent = cached.content;
                                                tr.is_error = cached.is_error;
                                                console.log('[Proxy-Browser] Replayed cached result for ' + toolInfo.name + ' (' + tr.tool_use_id + ') — no re-execution');
                                            } else {
                                                try {
                                                    const realResult = await executeTool(toolInfo.name, toolInfo.input);
                                                    trContent = typeof realResult.content === 'string' ? realResult.content : JSON.stringify(realResult.content);
                                                    tr.is_error = realResult.is_error || false;
                                                    interceptedBrowserResults.set(tr.tool_use_id, { content: trContent, is_error: tr.is_error });
                                                    console.log('[Proxy-Browser] Intercepted ' + toolInfo.name + ' successfully');
                                                } catch (be) {
                                                    console.error('[Proxy-Browser] Error executing ' + toolInfo.name + ':', be.message);
                                                }
                                            }
                                        }
                                        openaiMessages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: trContent });
                                    }
                                }
                                if (imageParts.length > 0) {
                                    // Build multimodal user message with text + images (OpenAI format)
                                    const contentArray = [];
                                    const joinedText = textParts.join('').trim();
                                    if (joinedText) contentArray.push({ type: 'text', text: joinedText });
                                    for (const img of imageParts) {
                                        if (img.source && img.source.type === 'base64') {
                                            contentArray.push({ type: 'image_url', image_url: { url: `data:${img.source.media_type};base64,${img.source.data}` } });
                                        }
                                    }
                                    if (contentArray.length > 0) openaiMessages.push({ role: 'user', content: contentArray });
                                } else if (textParts.join('').trim()) {
                                    openaiMessages.push({ role: 'user', content: textParts.join('') });
                                }
                            } else if (msg.role === 'assistant') {
                                const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }];
                                const textContent = parts.filter(b => b.type === 'text').map(b => b.text || '').join('');
                                const toolUses = parts.filter(b => b.type === 'tool_use');
                                const thinkingBlocks = parts.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('');
                                const assistantMsg = {
                                    role: 'assistant',
                                    content: textContent || '',
                                };
                                // DeepSeek requires reasoning_content to be passed back when using thinking mode
                                if (thinkingBlocks) {
                                    assistantMsg.reasoning_content = thinkingBlocks;
                                }
                                if (toolUses.length > 0) {
                                    assistantMsg.tool_calls = toolUses.map(tu => ({
                                        id: tu.id, type: 'function',
                                        function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) }
                                    }));
                                }
                                openaiMessages.push(assistantMsg);
                            }
                        }

                        // Convert Simona tools → OpenAI tools
                        const openaiTools = (simonaReq.tools || []).map(t => ({
                            type: 'function',
                            function: {
                                name: t.name,
                                description: t.description || '',
                                parameters: t.input_schema || { type: 'object', properties: {} },
                            }
                        }));

                        const openaiBody = {
                            model: target.model || simonaReq.model,
                            messages: openaiMessages,
                            max_tokens: simonaReq.max_tokens || 4096,
                            stream: true,
                        };
                        if (openaiTools.length > 0) openaiBody.tools = openaiTools;
                        if (simonaReq.temperature != null) openaiBody.temperature = simonaReq.temperature;
                        // Enable thinking mode for OpenAI-compatible APIs that support it (Sensenova, DeepSeek, Qwen, etc.)
                        // Must be set whenever messages may contain reasoning_content from previous turns
                        openaiBody.enable_thinking = true;
                        // Sensenova / GLM / DeepSeek use standard reasoning_effort parameter
                        if (target.model && (target.model.includes('sensenova') || target.model.includes('glm') || target.model.includes('deepseek'))) {
                            openaiBody.reasoning_effort = 'medium';
                        }
                        // Request Chinese reasoning for DeepSeek models (reasoning_lang parameter)
                        if (target.model && (target.model.includes('deepseek') || target.model.includes('qwen'))) {
                            openaiBody.reasoning_lang = 'Chinese';
                        }

                        let endpoint = normalizeBaseUrl(target.baseUrl);
                        if (!endpoint.endsWith('/v1')) endpoint += '/v1';
                        endpoint += '/chat/completions';

                        // Retry fetch up to 2 times on network errors (DNS cold-start, connection reset, etc.)
                        // This avoids the much slower engine-level api_retry which adds seconds of backoff delay
                        let upstreamRes;
                        const maxRetries = 2;
                        const bodyStr = JSON.stringify(openaiBody);
                        for (let attempt = 0; attempt <= maxRetries; attempt++) {
                            const fetchController = new AbortController();
                            const fetchTimeout = setTimeout(() => fetchController.abort(), 120000);
                            try {
                                upstreamRes = await fetch(endpoint, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + target.apiKey },
                                    body: bodyStr,
                                    signal: fetchController.signal,
                                });
                                clearTimeout(fetchTimeout);
                                break; // success
                            } catch (fetchErr) {
                                clearTimeout(fetchTimeout);
                                if (attempt < maxRetries) {
                                    console.warn('[Proxy] Fetch attempt ' + (attempt + 1) + ' failed: ' + (fetchErr.message || fetchErr) + ', retrying in 300ms...');
                                    await new Promise(r => setTimeout(r, 300));
                                    continue;
                                }
                                console.error('[Proxy] Fetch error after ' + (maxRetries + 1) + ' attempts:', fetchErr.message || fetchErr);
                                res.writeHead(502, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Failed to connect to upstream: ' + (fetchErr.message || 'timeout') } }));
                                return;
                            }
                        }

                        if (!upstreamRes.ok) {
                            const errText0 = await upstreamRes.text();
                            // Log summary instead of full request body (which includes the full system prompt)
                            console.error('[Proxy] ❌ API returned', upstreamRes.status, 'error:', errText0.slice(0, 500));
                            console.error('[Proxy] ❌ Request summary: model=' + openaiBody.model +
                                ', messages=' + (openaiBody.messages ? openaiBody.messages.length : 0) +
                                ', system_prompt_len=' + (openaiBody.messages && openaiBody.messages[0] ? openaiBody.messages[0].content.length : 0));
                            // On 429/5xx: rotate through the whole pool (dynamic count) and retry internally
                            const rotatable = (upstreamRes.status === 429 || upstreamRes.status === 401 || upstreamRes.status === 500 || upstreamRes.status === 502) && target.format === 'openai' && sensenovaProvider;
                            if (rotatable) {
                                // 遍历整池：次数由池规模决定（未来加 key 自动扩容），每把各不相同
                                const poolTries = Math.max(1, sensenovaPoolTotal || sensenovaKeys.length || 1);
                                const proxySessionId = target.conversationId || '';
                                let retriedOk = false;
                                for (let t = 0; t < poolTries && !retriedOk; t++) {
                                    let retryKey = '';
                                    try {
                                        // 有会话 ID → 只换该会话自己的 key（另一个会话不受影响）；
                                        // 无会话 ID → 回退到全局轮换
                                        retryKey = proxySessionId
                                            ? await nextSensenovaKeyForConversation(proxySessionId, openaiBody.model)
                                            : await nextSensenovaKey(openaiBody.model);
                                    } catch (keyErr) {
                                        if (keyErr && keyErr.allExhausted) {
                                            // 当前模型在所有密钥中额度已全部耗尽 → 提示用户切换模型
                                            console.error('[Proxy] ❌ Model exhausted:', openaiBody.model, keyErr.message);
                                            res.writeHead(429, { 'Content-Type': 'application/json' });
                                            res.end(JSON.stringify({
                                                type: 'error',
                                                error: {
                                                    type: 'model_exhausted',
                                                    message: keyErr.message || ('当前模型「' + openaiBody.model + '」额度已全部耗尽，请切换至其他模型')
                                                }
                                            }));
                                            return;
                                        }
                                        throw keyErr;
                                    }
                                    if (!retryKey) retryKey = target.apiKey;
                                    console.log('[Proxy] ' + upstreamRes.status + ' received, retrying session ' + (proxySessionId ? String(proxySessionId).slice(0, 8) : 'global') + ' (' + (t + 1) + '/' + poolTries + ')...');
                                    try {
                                        const retryRes = await fetch(endpoint, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + retryKey },
                                            body: bodyStr,
                                        });
                                        if (retryRes.ok) {
                                            console.log('[Proxy] Retry succeeded with session-exclusive key');
                                            upstreamRes = retryRes;
                                            retriedOk = true;
                                        } else if (retryRes.status === 429 || retryRes.status === 401 || retryRes.status >= 500) {
                                            await reportSensenovaKey(retryKey, false, openaiBody.model, 'quota_exceeded').catch(() => {});
                                            await new Promise(r => setTimeout(r, 300));
                                        } else {
                                            const retryErr = await retryRes.text();
                                            console.error('[Proxy] ❌ Retry also failed:', retryRes.status, retryErr.slice(0, 500));
                                            res.writeHead(retryRes.status, { 'Content-Type': 'application/json' });
                                            res.end(JSON.stringify({
                                                type: 'error',
                                                error: {
                                                    type: 'overloaded_error',
                                                    message: 'All API keys exhausted. ' + retryErr.slice(0, 200)
                                                }
                                            }));
                                            return;
                                        }
                                    } catch (retryFetchErr) {
                                        console.error('[Proxy] ❌ Retry fetch error:', retryFetchErr.message);
                                        res.writeHead(502, { 'Content-Type': 'application/json' });
                                        res.end(JSON.stringify({
                                            type: 'error',
                                            error: {
                                                type: 'overloaded_error',
                                                message: 'Retry failed: ' + (retryFetchErr.message || 'unknown')
                                            }
                                        }));
                                        return;
                                    }
                                }
                                if (retriedOk) {
                                    // Fall through to normal streaming below
                                } else {
                                    const finalErr = await upstreamRes.text().catch(() => '');
                                    res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
                                    res.end(JSON.stringify({
                                        type: 'error',
                                        error: {
                                            type: 'overloaded_error',
                                            message: 'All API keys exhausted (' + poolTries + ' tried). ' + finalErr.slice(0, 200)
                                        }
                                    }));
                                    return;
                                }
                            } else {
                                res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
                                res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: errText0.slice(0, 500) } }));
                                return;
                            }
                        }

                        // Stream OpenAI SSE → convert to Simona SSE format
                        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });

                        // Helper function to write and flush SSE data
                        const writeAndFlush = (data) => {
                            res.write(data);
                            if (res.flush) res.flush();
                        };

                        // Send message_start
                        writeAndFlush('event: message_start\ndata: ' + JSON.stringify({
                            type: 'message_start',
                            message: { id: 'msg_proxy', type: 'message', role: 'assistant', content: [], model: target.model, usage: { input_tokens: 0, output_tokens: 0 } }
                        }) + '\n\n');

                        const reader = upstreamRes.body.getReader();
                        const decoder = new TextDecoder();
                        let sseBuffer = '';
                        let totalTokens = 0;
                        let contentBlockIndex = 0;
                        let textBlockStarted = false;
                        let thinkingBlockStarted = false;
                        // Track tool_calls being streamed (OpenAI streams them incrementally)
                        const pendingToolCalls = new Map(); // index → { id, name, args }

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            sseBuffer += decoder.decode(value, { stream: true });
                            const lines = sseBuffer.split('\n');
                            sseBuffer = lines.pop() || '';
                            for (const line of lines) {
                                if (!line.startsWith('data: ')) {
                                    // Forward non-data lines (like event:)
                                    writeAndFlush(line + '\n');
                                    continue;
                                }
                                const data = line.slice(6).trim();
                                // Skip upstream [DONE] — proxy sends its own after usage_update
                                if (data === '[DONE]') { continue; }
                                try {
                                    const chunk = JSON.parse(data);
                                    const delta = chunk.choices?.[0]?.delta;
                                    const finishReason = chunk.choices?.[0]?.finish_reason;

                                    // Reasoning/thinking content (Qwen reasoning_content, Sensenova reasoning, DeepSeek etc.)
                                    const reasoningDelta = delta?.reasoning_content || delta?.reasoning;
                                    if (reasoningDelta) {
                                        if (!thinkingBlockStarted) {
                                            writeAndFlush('event: content_block_start\ndata: ' + JSON.stringify({
                                                type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'thinking', thinking: '' }
                                            }) + '\n\n');
                                            thinkingBlockStarted = true;
                                        }
                                        writeAndFlush('event: content_block_delta\ndata: ' + JSON.stringify({
                                            type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'thinking_delta', thinking: reasoningDelta }
                                        }) + '\n\n');
                                    }

                                    // Text content
                                    if (delta?.content) {
                                        // Close thinking block before starting text block
                                        if (thinkingBlockStarted) {
                                            writeAndFlush('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex }) + '\n\n');
                                            contentBlockIndex++;
                                            thinkingBlockStarted = false;
                                        }
                                        if (!textBlockStarted) {
                                            writeAndFlush('event: content_block_start\ndata: ' + JSON.stringify({
                                                type: 'content_block_start', index: contentBlockIndex, content_block: { type: 'text', text: '' }
                                            }) + '\n\n');
                                            textBlockStarted = true;
                                        }
                                        writeAndFlush('event: content_block_delta\ndata: ' + JSON.stringify({
                                            type: 'content_block_delta', index: contentBlockIndex, delta: { type: 'text_delta', text: delta.content }
                                        }) + '\n\n');
                                    }

                                    // Tool calls (OpenAI streams them as delta.tool_calls[])
                                    if (delta?.tool_calls) {
                                        for (const tc of delta.tool_calls) {
                                            const tcIdx = tc.index ?? 0;
                                            if (!pendingToolCalls.has(tcIdx)) {
                                                // Close text block if open
                                                if (textBlockStarted) {
                                                    writeAndFlush('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex }) + '\n\n');
                                                    contentBlockIndex++;
                                                    textBlockStarted = false;
                                                }
                                                pendingToolCalls.set(tcIdx, { id: tc.id || ('call_' + tcIdx), name: tc.function?.name || '', args: '' });
                                                // Send content_block_start for tool_use
                                                const ptc = pendingToolCalls.get(tcIdx);
                                                writeAndFlush('event: content_block_start\ndata: ' + JSON.stringify({
                                                    type: 'content_block_start', index: contentBlockIndex + tcIdx,
                                                    content_block: { type: 'tool_use', id: ptc.id, name: ptc.name, input: {} }
                                                }) + '\n\n');
                                            }
                                            const ptc = pendingToolCalls.get(tcIdx);
                                            if (tc.function?.name && !ptc.name) ptc.name = tc.function.name;
                                            if (tc.function?.arguments) ptc.args += tc.function.arguments;
                                        }
                                    }

                                    // On finish, close all pending tool calls
                                    if (finishReason === 'tool_calls' || finishReason === 'stop') {
                                        if (textBlockStarted) {
                                            writeAndFlush('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex }) + '\n\n');
                                            contentBlockIndex++;
                                            textBlockStarted = false;
                                        }
                                        for (const [tcIdx, ptc] of pendingToolCalls) {
                                            // Send input_json_delta with complete input
                                            let parsedInput = {};
                                            try { parsedInput = JSON.parse(ptc.args); } catch (_) {}
                                            writeAndFlush('event: content_block_delta\ndata: ' + JSON.stringify({
                                                type: 'content_block_delta', index: contentBlockIndex + tcIdx,
                                                delta: { type: 'input_json_delta', partial_json: ptc.args }
                                            }) + '\n\n');
                                            writeAndFlush('event: content_block_stop\ndata: ' + JSON.stringify({
                                                type: 'content_block_stop', index: contentBlockIndex + tcIdx
                                            }) + '\n\n');
                                        }
                                    }

                                    if (chunk.usage) {
                                        totalTokens = chunk.usage.total_tokens || 0;
                                        const inputTokens = chunk.usage.prompt_tokens || 0;
                                        const outputTokens = chunk.usage.completion_tokens || totalTokens;
                                        console.log('[Proxy-Usage] OpenAI format - input:', inputTokens, 'output:', outputTokens, 'model:', target.model);
                                    }
                                } catch (_) {}
                            }
                        }

                        // Close any remaining open blocks
                        if (thinkingBlockStarted) {
                            writeAndFlush('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex }) + '\n\n');
                            contentBlockIndex++;
                        }
                        if (textBlockStarted) {
                            writeAndFlush('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: contentBlockIndex }) + '\n\n');
                        }

                        // Send message_delta + message_stop
                        const stopReason = pendingToolCalls.size > 0 ? 'tool_use' : 'end_turn';
                        writeAndFlush('event: message_delta\ndata: ' + JSON.stringify({
                            type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: totalTokens }
                        }) + '\n\n');
                        writeAndFlush('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
                        
                        // Send usage stats update to frontend
                        const usageUpdate = conversationUsage.get(target.conversationId);
                        if (usageUpdate) {
                            writeAndFlush('event: usage_update\ndata: ' + JSON.stringify({
                                type: 'usage_update',
                                conversation_id: target.conversationId,
                                input_tokens: usageUpdate.inputTokens,
                                output_tokens: usageUpdate.outputTokens,
                                total_tokens: usageUpdate.inputTokens + usageUpdate.outputTokens,
                                message_count: usageUpdate.messageCount,
                                estimated_cost: usageUpdate.estimatedCost,
                                model: usageUpdate.modelId
                            }) + '\n\n');
                        }
                        
                        // End with [DONE] so frontend knows stream is finished
                        writeAndFlush('data: [DONE]\n\n');
                        res.end();
                    } else {
                        // Simona format — passthrough to real endpoint
                        let endpoint = normalizeBaseUrl(target.baseUrl);
                        if (!endpoint.endsWith('/v1')) endpoint += '/v1';
                        endpoint += '/messages';

                        const upstreamRes = await fetch(endpoint, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'x-api-key': target.apiKey,
                                'simona-version': '2023-06-01',
                            },
                            body: body,
                        });
                        res.writeHead(upstreamRes.status, Object.fromEntries(upstreamRes.headers.entries()));
                        const reader = upstreamRes.body.getReader();
                        const decoder = new TextDecoder();
                        let sseBuffer = '';
                        let totalTokens = 0;
                        const pump = async () => {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) { break; }
                                res.write(value);
                                
                                // Parse SSE events to extract token usage
                                sseBuffer += decoder.decode(value, { stream: true });
                                const lines = sseBuffer.split('\n');
                                sseBuffer = lines.pop() || '';
                                
                                for (const line of lines) {
                                    if (line.startsWith('data: ')) {
                                        try {
                                            const data = JSON.parse(line.slice(6));
                                            // Debug: log all SSE events
                                            if (data.type) {
                                                console.log('[Proxy-SSE] Event type:', data.type);
                                            }
                                            if (data.usage) {
                                                console.log('[Proxy-SSE] Found usage data:', JSON.stringify(data.usage));
                                                totalTokens = data.usage.output_tokens || 0;
                                                const inputTokens = data.usage.input_tokens || 0;
                                                console.log('[Proxy-Usage] Simona format - input:', inputTokens, 'output:', totalTokens, 'model:', target.model);
                                            }
                                        } catch (e) {
                                            console.log('[Proxy-SSE] Parse error:', e.message);
                                        }
                                    }
                                }
                            }
                            res.end();
                            
                            // Send usage stats update to frontend
                            const usage = conversationUsage.get(target.conversationId);
                            if (usage) {
                                res.write = () => {}; // Prevent writing after end()
                                const stream = activeStreams.get(target.conversationId);
                                if (stream && stream.primaryRes) {
                                    try {
                                        stream.primaryRes.write('event: usage_update\ndata: ' + JSON.stringify({
                                            type: 'usage_update',
                                            conversation_id: target.conversationId,
                                            input_tokens: usage.inputTokens,
                                            output_tokens: usage.outputTokens,
                                            total_tokens: usage.inputTokens + usage.outputTokens,
                                            message_count: usage.messageCount,
                                            estimated_cost: usage.estimatedCost,
                                            model: usage.modelId
                                        }) + '\n\n');
                                    } catch (_) {}
                                }
                            }
                        };
                        await pump();
                    }
                } catch (err) {
                    console.error('[Proxy] Error:', err.message);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                    }
                    res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
                }
            });
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });
    proxyServer.listen(0, '127.0.0.1', () => {
        proxyPort = proxyServer.address().port;
        console.log('[Proxy] OpenAI conversion proxy on port', proxyPort);
    });

    async function generateTitleAsync(conversationId, userMsg, assistantMsg, token, baseUrl, activeModel, apiFormat) {
        if (!token) { 
            console.log('[Title] Skipped: no API token (this is normal if API key is not configured)'); 
            return; 
        }
        try {
            const bConv = db.conversations.find(c => c.id === conversationId);
            // 只要标题是默认值（新对话/New Conversation/New Chat），就生成新标题
            if (!bConv || (bConv.title !== 'New Conversation' && bConv.title !== 'New Chat' && bConv.title !== '新对话')) return;

            // Strip -thinking suffix — raw API doesn't accept it
            let modelId = (activeModel || 'simona-sonnet-4-6').replace(/-thinking$/, '');

            // When using remote proxy (JWT), force DeepSeek model — remote server only supports DeepSeek
            if (jwtToken && baseUrl && baseUrl.includes(REMOTE_SERVER)) {
                if (modelId !== 'deepseek-v4-pro' && modelId !== 'deepseek-v4-flash') {
                    modelId = 'deepseek-v4-flash';
                    console.log('[Title] Forced model to deepseek-v4-flash for remote proxy');
                }
            }

            // 根据是否有助手回复来构建不同的提示词
            const titlePrompt = assistantMsg 
                ? `请分析以下对话内容，生成一个简短的中文标题（最多5-7个字），准确概括对话的核心主题或任务。直接返回标题，不要包含任何解释、引号或“用户”、“助手”等前缀。\n\n对话内容：\n${userMsg}\n${assistantMsg}\n\n标题：`
                : `请分析以下内容，生成一个简短的中文标题（最多5-7个字），准确概括核心主题或任务。直接返回标题，不要包含任何解释、引号或“用户”等前缀。\n\n内容：${userMsg}\n\n标题：`;

            if (apiFormat === 'openai') {
                // OpenAI format title generation
                let endpoint = normalizeBaseUrl(baseUrl);
                if (!endpoint.endsWith('/v1')) endpoint += '/v1';
                endpoint += '/chat/completions';

                console.log(`[Title] Generating (OpenAI) for ${conversationId} via ${endpoint} model=${modelId}`);
                const titleController = new AbortController();
                const titleTimeout = setTimeout(() => titleController.abort(), 30000);
                const titleBody = {
                    model: modelId,
                    max_tokens: 1000,
                    reasoning_effort: 'none',
                    messages: [
                        { role: 'system', content: '你是一个标题生成器。只返回标题本身，不要包含任何解释、引号或额外文字。最多5-7个中文字。' },
                        { role: 'user', content: titlePrompt }
                    ]
                };
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Authorization': 'Bearer ' + token },
                    body: JSON.stringify(titleBody),
                    signal: titleController.signal,
                });
                clearTimeout(titleTimeout);
                if (response.ok) {
                    const buf = await response.arrayBuffer();
                    const data = JSON.parse(new TextDecoder('utf-8').decode(buf));
                    const rawContent = data.choices?.[0]?.message?.content?.trim() || '';
                    const rawReasoning = data.choices?.[0]?.message?.reasoning_content?.trim() || data.choices?.[0]?.message?.reasoning?.trim();
                    // For reasoning models (GLM, DeepSeek-R1, etc.), content may be empty
                    // because all tokens went to reasoning_content. Fall back to extracting
                    // the title from the reasoning text.
                    let title = rawContent.replace(/^["']|["']$/g, '').trim();
                    if (!title && rawReasoning) {
                        // Extract the last line or the most likely title candidate from reasoning
                        const lines = rawReasoning.split('\n').map(l => l.replace(/^[\d.*\s]+/, '').trim()).filter(Boolean);
                        // Pick the last substantive line that looks like a title (short, no markdown)
                        for (let i = lines.length - 1; i >= 0; i--) {
                            const candidate = lines[i].replace(/^["']|["']$/g, '').trim();
                            if (candidate.length >= 2 && candidate.length <= 15 && !candidate.startsWith('*') && !candidate.includes('http')) {
                                title = candidate;
                                break;
                            }
                        }
                        // Fallback: just take the last line
                        if (!title) title = lines[lines.length - 1] || '';
                    }
                    if (title) {
                        bConv.title = title;
                        saveDb();
                        console.log(`[Title] Success: "${title}"`);
                    } else {
                        console.error('[Title] No text in OpenAI response:', JSON.stringify(data));
                    }
                } else {
                    console.error('[Title] HTTP Error:', response.status, endpoint, await response.text());
                }
            } else {
                // Simona format title generation
                let endpoint;
                if (baseUrl) {
                    const clean = normalizeBaseUrl(baseUrl);
                    endpoint = clean.endsWith('/v1') ? `${clean}/messages` : `${clean}/v1/messages`;
                } else {
                    endpoint = 'https://api.simona.com/v1/messages';
                }

                console.log(`[Title] Generating for ${conversationId} via ${endpoint} model=${modelId}`);
                const anthTitleCtrl = new AbortController();
                const anthTitleTimeout = setTimeout(() => anthTitleCtrl.abort(), 30000);
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json; charset=utf-8',
                        'x-api-key': token,
                        'simona-version': '2023-06-01'
                    },
                    signal: anthTitleCtrl.signal,
                    body: JSON.stringify({
                        model: modelId,
                        max_tokens: 50,
                        system: '你是一个标题生成器。只返回标题本身，不要包含任何解释、引号或额外文字。最多5-7个中文字。',
                        messages: [
                            { role: 'user', content: titlePrompt }
                        ]
                    })
                });
                clearTimeout(anthTitleTimeout);
                if (response.ok) {
                    const data = await response.json();
                    let title = null;
                    if (data.content && Array.isArray(data.content)) {
                        // 先尝试找 text 类型
                        const textBlock = data.content.find(b => b.type === 'text' && b.text);
                        if (textBlock && textBlock.text) {
                            title = textBlock.text.replace(/^["']|["']$/g, '').trim();
                        } else {
                            // 如果没有 text，尝试从 thinking 中提取
                            const thinkingBlock = data.content.find(b => b.type === 'thinking' && b.thinking);
                            if (thinkingBlock && thinkingBlock.thinking) {
                                // 从 thinking 内容中提取最后一行作为标题
                                const lines = thinkingBlock.thinking.split('\n').filter(l => l.trim());
                                const lastLine = lines[lines.length - 1];
                                // 如果最后一行包含“标题：”或类似模式，提取后面的内容
                                const titleMatch = lastLine.match(/[标题:：]\s*["'「]?([^"'」\n]{2,20})/);
                                if (titleMatch) {
                                    title = titleMatch[1].trim();
                                } else {
                                    // 否则使用最后几个字作为标题
                                    title = lastLine.slice(-7);
                                }
                            }
                        }
                    }
                    if (title) {
                        bConv.title = title;
                        saveDb();
                        console.log(`[Title] Success: "${title}"`);
                    } else {
                        console.error('[Title] No text in response:', JSON.stringify(data));
                    }
                } else {
                    console.error('[Title] HTTP Error:', response.status, endpoint, await response.text());
                }
            }
        } catch (e) {
            console.error('[Title] Exception:', e.message || e);
        }
    }

    // ═══════════════════ Health ═══════════════════

    server.get('/api/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    server.get('/api/system-status', (req, res) => {
        const result = { platform: process.platform, gitBash: { required: false, found: false, path: null } };
        if (process.platform === 'win32') {
            result.gitBash.required = false;
            const gitBashPaths = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'];
            for (const p of gitBashPaths) {
                if (require('fs').existsSync(p)) { result.gitBash.found = true; result.gitBash.path = p; break; }
            }
            if (!result.gitBash.found) {
                try {
                    const which = require('child_process').execSync('where bash', { encoding: 'utf8', stdio: 'pipe' }).trim();
                    if (which) { result.gitBash.found = true; result.gitBash.path = which.split('\n')[0]; }
                } catch (_) {}
            }
        }
        res.json(result);
    });

    // ═══════════════════ Projects ═══════════════════

    server.get('/api/projects', (req, res) => {
        const list = [...db.projects]
            .filter(p => !p.is_archived)
            .sort((a, b) => new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at));
        // Attach counts and files
        const result = list.map(p => ({
            ...p,
            file_count: db.project_files.filter(f => f.project_id === p.id).length,
            chat_count: db.conversations.filter(c => c.project_id === p.id).length,
            files: db.project_files.filter(f => f.project_id === p.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
        }));
        res.json(result);
    });

    server.post('/api/projects', (req, res) => {
        const id = uuidv4();
        const { name, description = '' } = req.body;
        if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

        const projectDir = path.join(workspacesDir, `project-${id}`);
        if (!fs.existsSync(projectDir)) fs.mkdirSync(projectDir, { recursive: true });

        const project = {
            id, name: name.trim(), description: description.trim(),
            instructions: '', workspace_path: projectDir,
            is_archived: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        db.projects.push(project);
        saveDb();
        res.json(project);
    });

    server.get('/api/projects/:id', (req, res) => {
        const project = db.projects.find(p => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const files = db.project_files.filter(f => f.project_id === project.id)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const conversations = db.conversations.filter(c => c.project_id === project.id)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({ ...project, files, conversations });
    });

    server.patch('/api/projects/:id', (req, res) => {
        const project = db.projects.find(p => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        if (req.body.name !== undefined) project.name = req.body.name.trim();
        if (req.body.description !== undefined) project.description = req.body.description;
        if (req.body.instructions !== undefined) project.instructions = req.body.instructions;
        if (req.body.is_archived !== undefined) project.is_archived = req.body.is_archived;
        project.updated_at = new Date().toISOString();

        saveDb();
        res.json(project);
    });

    server.delete('/api/projects/:id', (req, res) => {
        const pid = req.params.id;
        // Delete project files from disk
        const files = db.project_files.filter(f => f.project_id === pid);
        for (const f of files) {
            if (f.file_path && fs.existsSync(f.file_path)) {
                try { fs.unlinkSync(f.file_path); } catch (_) {}
            }
        }
        db.project_files = db.project_files.filter(f => f.project_id !== pid);

        // Delete project conversations + messages + workspaces
        const convIds = db.conversations.filter(c => c.project_id === pid).map(c => c.id);
        db.messages = db.messages.filter(m => !convIds.includes(m.conversation_id));
        db.conversations = db.conversations.filter(c => c.project_id !== pid);
        for (const cid of convIds) {
            const wsPath = path.join(workspacesDir, cid);
            if (fs.existsSync(wsPath)) try { fs.rmSync(wsPath, { recursive: true, force: true }); } catch (_) {}
        }

        // Delete project dir
        const projectDir = path.join(workspacesDir, `project-${pid}`);
        if (fs.existsSync(projectDir)) try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}

        db.projects = db.projects.filter(p => p.id !== pid);
        saveDb();
        res.json({ success: true });
    });

    // ═══ Project file upload ═══
    const projectUploadStorage = multer.diskStorage({
        destination: (req, file, cb) => {
            const project = db.projects.find(p => p.id === req.params.id);
            const dir = project ? path.join(project.workspace_path, 'files') : path.join(workspacesDir, 'temp');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            // Fix: Ensure proper encoding for filenames with Chinese characters
            // Decode UTF-8 bytes that might be incorrectly interpreted as Latin-1
            let safeName = file.originalname;
            try {
                // If the filename looks like it has encoding issues (contains ä, å, etc.)
                if (/[äåöü]/.test(safeName)) {
                    // Try to fix: encode as Latin-1 bytes, then decode as UTF-8
                    const latin1Bytes = Buffer.from(safeName, 'latin1');
                    safeName = latin1Bytes.toString('utf8');
                }
            } catch (e) {
                // If conversion fails, use original name
            }
            cb(null, Date.now() + '-' + safeName);
        },
    });
    const projectUpload = multer({ storage: projectUploadStorage });

    server.post('/api/projects/:id/files', projectUpload.single('file'), (req, res) => {
        const project = db.projects.find(p => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!req.file) return res.status(400).json({ error: 'No file' });

        // Extract text for known text formats
        let extractedText = '';
        const textExts = ['.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.csv', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.lua', '.r'];
        const ext = path.extname(req.file.originalname).toLowerCase();
        if (textExts.includes(ext)) {
            try { extractedText = fs.readFileSync(req.file.path, 'utf8'); } catch (_) {}
        }

        const fileEntry = {
            id: uuidv4(),
            project_id: project.id,
            file_name: (() => {
                // Fix: Ensure filename is properly encoded
                let name = req.file.originalname || req.file.filename;
                try {
                    // Fix UTF-8/Latin-1 encoding issues
                    if (/[äåöü]/.test(name)) {
                        const latin1Bytes = Buffer.from(name, 'latin1');
                        name = latin1Bytes.toString('utf8');
                    }
                } catch (e) {}
                return name;
            })(),
            file_path: req.file.path,
            file_size: req.file.size,
            mime_type: req.file.mimetype,
            extracted_text: extractedText,
            enabled: true, // Default to enabled when uploaded
            created_at: new Date().toISOString(),
        };
        db.project_files.push(fileEntry);
        project.updated_at = new Date().toISOString();
        saveDb();

        res.json({ ...fileEntry, extracted_text: undefined }); // Don't send full text back
    });

    server.delete('/api/projects/:projectId/files/:fileId', (req, res) => {
        const file = db.project_files.find(f => f.id === req.params.fileId && f.project_id === req.params.projectId);
        if (!file) return res.status(404).json({ error: 'File not found' });

        if (file.file_path && fs.existsSync(file.file_path)) {
            try { fs.unlinkSync(file.file_path); } catch (_) {}
        }
        db.project_files = db.project_files.filter(f => f.id !== file.id);
        const project = db.projects.find(p => p.id === req.params.projectId);
        if (project) project.updated_at = new Date().toISOString();
        saveDb();
        res.json({ success: true });
    });

    // Toggle file enabled status
    server.patch('/api/projects/:projectId/files/:fileId/toggle', (req, res) => {
        const file = db.project_files.find(f => f.id === req.params.fileId && f.project_id === req.params.projectId);
        if (!file) return res.status(404).json({ error: 'File not found' });
        
        file.enabled = req.body.enabled !== undefined ? req.body.enabled : !file.enabled;
        saveDb();
        res.json(file);
    });

    // ═══ Project conversations ═══
    server.get('/api/projects/:id/conversations', (req, res) => {
        const convs = db.conversations.filter(c => c.project_id === req.params.id)
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json(convs);
    });

    server.post('/api/projects/:id/conversations', (req, res) => {
        const project = db.projects.find(p => p.id === req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const id = uuidv4();
        const { title = '新对话', model = 'simona-sonnet-4-6', workspace_path } = req.body;
        const workspacePath = workspace_path || path.join(workspacesDir, id);
        if (!fs.existsSync(workspacePath)) fs.mkdirSync(workspacePath, { recursive: true });
        // 初始化对话的独立 git 仓库
        try { initConvRepo(workspacePath, id); } catch (_) {}

        // Copy project files into workspace so SDK can read them
        const projectFiles = db.project_files.filter(f => f.project_id === project.id);
        for (const pf of projectFiles) {
            if (pf.file_path && fs.existsSync(pf.file_path)) {
                try { fs.copyFileSync(pf.file_path, path.join(workspacePath, pf.file_name)); } catch (_) {}
            }
        }

        const newConv = {
            id, title, model, project_id: project.id,
            workspace_path: workspacePath, created_at: new Date().toISOString(),
        };
        db.conversations.push(newConv);
        project.updated_at = new Date().toISOString();
        saveDb();
        res.json(newConv);
    });

    // ═══════════════════ Conversations ═══════════════════

    // ===== Artifacts API =====
    // Scans all messages for Write tool calls that created renderable HTML files
    server.get('/api/artifacts', (req, res) => {
        const artifacts = [];
        const htmlExts = ['.html', '.htm'];
        for (const msg of db.messages) {
            if (!msg.toolCalls) continue;
            for (const tc of msg.toolCalls) {
                if (tc.name !== 'Write' || tc.status === 'error') continue;
                const fp = tc.input?.file_path;
                if (!fp) continue;
                const ext = path.extname(fp).toLowerCase();
                if (!htmlExts.includes(ext)) continue;
                // Read file content to verify it's renderable HTML
                let content = '';
                try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
                const trimmed = content.trimStart().slice(0, 100).toLowerCase();
                if (!trimmed.includes('<!doctype') && !trimmed.includes('<html') && !trimmed.includes('<head') && !trimmed.includes('<body')) continue;
                const conv = db.conversations.find(c => c.id === msg.conversation_id);
                artifacts.push({
                    id: tc.id,
                    title: path.basename(fp),
                    file_path: fp,
                    conversation_id: msg.conversation_id,
                    conversation_title: conv?.title || 'Untitled',
                    message_id: msg.id,
                    created_at: msg.created_at,
                    content_length: content.length,
                });
            }
        }
        // Sort newest first, deduplicate by file_path (keep latest)
        artifacts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        const seen = new Set();
        const unique = artifacts.filter(a => {
            if (seen.has(a.file_path)) return false;
            seen.add(a.file_path);
            return true;
        });
        res.json(unique);
    });

    // Get artifact content by file path
    server.get('/api/artifacts/content', (req, res) => {
        const fp = req.query.path;
        if (!fp) return res.status(400).json({ error: 'Missing path' });
        try {
            const content = fs.readFileSync(fp, 'utf-8');
            res.json({ content, format: 'html', title: path.basename(fp) });
        } catch {
            res.status(404).json({ error: 'File not found' });
        }
    });

    // Serve locally saved images (for permanent access)
    server.get('/api/images/:filename', (req, res) => {
        const fileName = req.params.filename;
        if (fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }
        const filePath = path.join(userDataPath, 'images', fileName);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Image not found' });
        }
        res.sendFile(filePath);
    });

    server.get('/api/conversations', (req, res) => {
        // Filter: only return non-project conversations (project convs accessed via /projects/:id/conversations)
        const projectId = req.query.project_id;
        let list;
        if (projectId) {
            list = db.conversations.filter(c => c.project_id === projectId);
        } else {
            list = db.conversations.filter(c => !c.project_id);
        }
        list = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json(list);
    });

    server.post('/api/conversations', (req, res) => {
        try {
            const id = uuidv4();
            const { title = '新对话', model = 'simona-sonnet-4-6', project_id, workspace_path } = req.body;
            const workspacePath = workspace_path || workspacesDir;
            if (!fs.existsSync(workspacePath)) {
                fs.mkdirSync(workspacePath, { recursive: true });
            }
            try { initConvRepo(workspacePath, id); } catch (e) { console.error('[Conv] initConvRepo error:', e); }

            const newConv = {
                id, title, model, workspace_path: workspacePath, created_at: new Date().toISOString(),
                ...(project_id ? { project_id } : {}),
            };
            db.conversations.push(newConv);
            saveDb();

            res.json({ id, title, model, workspace_path: workspacePath });
        } catch (err) {
            console.error('[Conv] Failed to create conversation:', err);
            res.status(500).json({ error: err.message || 'Unknown error' });
        }
    });

    server.get('/api/conversations/:id', (req, res) => {
        const conv = db.conversations.find(c => c.id === req.params.id);
        if (!conv) return res.status(404).json({ error: 'Not found' });

        const messages = db.messages.filter(m => m.conversation_id === req.params.id)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        const parsedMessages = messages.map(m => {
            let contentStr = '';
            try {
                const parsed = JSON.parse(m.content);
                if (Array.isArray(parsed)) {
                    contentStr = parsed.map(c => c.text || '').join('');
                } else if (typeof parsed === 'string') {
                    contentStr = parsed;
                } else {
                    contentStr = m.content;
                }
            } catch (e) {
                contentStr = m.content;
            }
            // Normalize attachment keys: DB stores camelCase, frontend expects snake_case
            let attachments = m.attachments;
            if (Array.isArray(attachments)) {
                attachments = attachments.map(a => {
                    const name = a.file_name || a.fileName || '';
                    const ext = name.split('.').pop()?.toLowerCase() || '';
                    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
                    const isImg = (a.file_type === 'image' || a.fileType === 'image')
                        || (a.mime_type && a.mime_type.startsWith('image/'))
                        || (a.mimeType && a.mimeType.startsWith('image/'))
                        || imageExts.includes(ext);
                    return {
                        id: a.id || a.fileId || '',
                        file_name: name || 'file',
                        file_type: isImg ? 'image' : (a.file_type || a.fileType || 'document'),
                        mime_type: a.mime_type || a.mimeType || (isImg ? 'image/' + (ext === 'jpg' ? 'jpeg' : ext) : ''),
                        file_size: a.file_size || a.size || 0,
                    };
                });
            }
            return {
                ...m,
                content: contentStr,
                attachments,
            };
        });

        res.json({
            ...conv,
            messages: parsedMessages
        });
    });

    server.patch('/api/conversations/:id', (req, res) => {
        const conv = db.conversations.find(c => c.id === req.params.id);
        if (!conv) return res.status(404).json({ error: 'Not found' });

        if (req.body.title) conv.title = req.body.title;
        if (req.body.model && req.body.model !== conv.model) {
            console.log('[Session] Model changed for conv', conv.id, ':', conv.model, '→', req.body.model, '(session preserved)');
            conv.model = req.body.model;
            // Don't reset simona_session_id — engine sessions store message history
            // which is model-agnostic. The engine can resume with a different model.
        }
        // Move conversation to/from a project
        if ('project_id' in req.body) {
            const pid = req.body.project_id;
            if (pid) {
                const project = db.projects.find(p => p.id === pid);
                if (!project) return res.status(404).json({ error: 'Project not found' });
                conv.project_id = pid;
                project.updated_at = new Date().toISOString();
            } else {
                delete conv.project_id;
            }
        }

        saveDb();
        res.json(conv);
    });

    server.delete('/api/conversations/:id', (req, res) => {
        const id = req.params.id;
        db.messages = db.messages.filter(m => m.conversation_id !== id);
        db.conversations = db.conversations.filter(c => c.id !== id);
        saveDb();
        poolKill(id); // kill any pooled engine process for this conversation
        // 清理对话的 git 仓库
        try { cleanupConvRepo(workspacesDir, id); } catch (_) {}
        res.json({ success: true });
    });

    server.delete('/api/conversations/:id/messages/:messageId', (req, res) => {
        const { id, messageId } = req.params;
        const msgIndex = db.messages.findIndex(m => m.id === messageId && m.conversation_id === id);
        if (msgIndex === -1) return res.status(404).json({ error: 'Message not found' });

        // Git 自动回退：删除消息前回退文件到该消息位置
        const conv = db.conversations.find(c => c.id === id);
        if (conv) {
            try {
                const convMsgs = db.messages.filter(m => m.conversation_id === id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
                const editIdx = convMsgs.findIndex(m => m.id === messageId);
                if (editIdx !== -1) {
                    const tag = findRollbackTag(convMsgs, editIdx);
                    rollbackConvToTag(conv.workspace_path, id, tag);
                }
            } catch (_) {}
        }

        // Remove this message and all subsequent messages in the conversation
        const targetCreatedAt = new Date(db.messages[msgIndex].created_at).getTime();
        db.messages = db.messages.filter(m => {
            if (m.conversation_id !== id) return true;
            return new Date(m.created_at).getTime() < targetCreatedAt;
        });
        // Reset engine session — old context is no longer valid
        if (conv) { conv.simona_session_id = null; poolKill(id); console.log('[Session] Reset for conv', id, '(messages deleted)'); }
        saveDb();
        res.json({ success: true });
    });

    server.delete('/api/conversations/:id/messages-tail/:count', (req, res) => {
        const { id, count } = req.params;
        const numToRemove = parseInt(count, 10);
        if (isNaN(numToRemove) || numToRemove <= 0) return res.status(400).json({ error: 'Invalid count' });

        const convMsgs = db.messages.filter(m => m.conversation_id === id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        // Git 自动回退：找到尾部第一条被删除的消息，回退到该消息之前
        const conv = db.conversations.find(c => c.id === id);
        if (conv && convMsgs.length > 0) {
            try {
                const firstRemovedIdx = Math.max(0, convMsgs.length - numToRemove);
                const tag = findRollbackTag(convMsgs, firstRemovedIdx);
                rollbackConvToTag(conv.workspace_path, id, tag);
            } catch (_) {}
        }

        if (convMsgs.length <= numToRemove) {
            db.messages = db.messages.filter(m => m.conversation_id !== id);
        } else {
            const cutoffTime = new Date(convMsgs[convMsgs.length - numToRemove].created_at).getTime();
            db.messages = db.messages.filter(m => {
                if (m.conversation_id !== id) return true;
                return new Date(m.created_at).getTime() < cutoffTime;
            });
        }
        // Reset engine session — old context is no longer valid
        if (conv) { conv.simona_session_id = null; poolKill(id); console.log('[Session] Reset for conv', id, '(tail deleted)'); }
        saveDb();
        res.json({ success: true });
    });

    server.delete('/api/conversations/:id/messages-round/:messageId', (req, res) => {
        const { id, messageId } = req.params;
        const convMsgs = db.messages.filter(m => m.conversation_id === id).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const editIdx = convMsgs.findIndex(m => m.id === messageId);
        if (editIdx === -1) return res.status(404).json({ error: 'Message not found' });

        // 结束位置 = 下一条 user 消息（不含）；若后面没有 user 消息则删除到末尾
        let endIdx = convMsgs.length;
        for (let i = editIdx + 1; i < convMsgs.length; i++) {
            if (convMsgs[i].role === 'user') { endIdx = i; break; }
        }

        // 只删除 [editIdx, endIdx) 这一轮（该 user 消息 + 其 AI 回复），保留上方与下方
        const removed = new Set(convMsgs.slice(editIdx, endIdx).map(m => m.id));
        db.messages = db.messages.filter(m => {
            if (m.conversation_id !== id) return true;
            return !removed.has(m.id);
        });

        // Reset engine session — old context is no longer valid
        const conv = db.conversations.find(c => c.id === id);
        if (conv) { conv.simona_session_id = null; poolKill(id); console.log('[Session] Reset for conv', id, '(round deleted)'); }
        saveDb();
        res.json({ success: true });
    });

    // Multer upload config
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const convId = req.headers['x-conversation-id'] || 'temp';
            const dir = path.join(workspacesDir, convId, '.uploads');
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            cb(null, Date.now() + '-' + file.originalname);
        }
    });
    const upload = multer({ storage });

    server.post('/api/upload', upload.single('file'), (req, res) => {
        if (!req.file) return res.status(400).json({ error: 'No file' });
        // Verify file on disk has actual content
        let diskSize = 0;
        try { diskSize = fs.statSync(req.file.path).size; } catch (_) {}
        console.log(`[Upload] ${req.file.originalname} → ${req.file.path} (multer=${req.file.size}, disk=${diskSize})`);
        if (diskSize === 0) {
            // File is empty on disk — tell client to retry
            try { fs.unlinkSync(req.file.path); } catch (_) {}
            return res.status(422).json({ error: 'File upload incomplete (0 bytes on disk). Please retry.' });
        }
        res.json({
            fileId: path.basename(req.file.path),
            fileName: req.file.originalname,
            fileType: req.file.mimetype.startsWith('image') ? 'image' : 'document',
            mimeType: req.file.mimetype,
            localPath: req.file.path,
            size: diskSize
        });
    });

    // Resolve a fileId to its local path and serve the raw file
    server.get('/api/uploads/:fileId/raw', (req, res) => {
        const fileId = req.params.fileId;
        const convId = req.query.conversation_id || '';
        // Search in conversation uploads first, then all workspaces
        const searchDirs = [];
        if (convId) searchDirs.push(path.join(workspacesDir, convId, '.uploads'));
        // Also search all conversation upload dirs
        try {
            const allConvDirs = fs.readdirSync(workspacesDir);
            for (const dir of allConvDirs) {
                const uploadsDir = path.join(workspacesDir, dir, '.uploads');
                if (fs.existsSync(uploadsDir)) searchDirs.push(uploadsDir);
            }
        } catch (_) {}

        // Helper: serve file with correct mime type (avoids Express 5 sendFile Windows issues)
        const serveFile = (fp) => {
            const ext = path.extname(fp).toLowerCase();
            const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json' };
            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
            res.send(fs.readFileSync(fp));
        };

        for (const dir of searchDirs) {
            const filePath = path.join(dir, fileId);
            if (fs.existsSync(filePath)) {
                return serveFile(filePath);
            }
            // Try partial match
            try {
                const files = fs.readdirSync(dir);
                const match = files.find(f => f === fileId || f.includes(fileId));
                if (match) return serveFile(path.join(dir, match));
            } catch (_) {}
        }
        res.status(404).json({ error: 'File not found' });
    });

    // Get local file path for a fileId
    server.get('/api/uploads/:fileId/path', (req, res) => {
        const fileId = req.params.fileId;
        const convId = req.query.conversation_id || '';
        const searchDirs = [];
        
        // Search in conversation uploads first
        if (convId) searchDirs.push(path.join(workspacesDir, convId, '.uploads'));
        
        // Search all conversation upload dirs
        try {
            const allConvDirs = fs.readdirSync(workspacesDir);
            for (const dir of allConvDirs) {
                const uploadsDir = path.join(workspacesDir, dir, '.uploads');
                if (fs.existsSync(uploadsDir)) searchDirs.push(uploadsDir);
            }
        } catch (_) {}
        
        // Also search temp directory (for recently uploaded files)
        const tempUploadsDir = path.join(workspacesDir, 'temp', '.uploads');
        if (fs.existsSync(tempUploadsDir)) {
            searchDirs.push(tempUploadsDir);
        }

        for (const dir of searchDirs) {
            const filePath = path.join(dir, fileId);
            if (fs.existsSync(filePath)) {
                return res.json({ localPath: filePath, folder: dir });
            }
            try {
                const files = fs.readdirSync(dir);
                const match = files.find(f => f === fileId || f.includes(fileId));
                if (match) return res.json({ localPath: path.join(dir, match), folder: dir });
            } catch (_) {}
        }
        res.status(404).json({ error: 'File not found' });
    });

    // Memory file operations - read memory file content
    server.get('/api/memory/read', (req, res) => {
        try {
            const filePath = req.query.path;
            if (!filePath) {
                return res.status(400).json({ error: 'Missing file path' });
            }
            
            // Security check: ensure path is within allowed directories
            const normalizedPath = path.normalize(filePath);
            const simonaConfigDir = process.env.SIMONA_CONFIG_HOME || path.join(os.homedir(), '.simona');
            const projectCwd = process.cwd();
            
            // Also allow workspacesDir and its subdirectories (including temp/.uploads)
            const allowedDirs = [simonaConfigDir, projectCwd, workspacesDir];
            const isAllowed = allowedDirs.some(dir => normalizedPath.startsWith(path.normalize(dir)));
            
            if (!isAllowed) {
                return res.status(403).json({ error: 'Access denied: file outside allowed directories' });
            }
            
            if (!fs.existsSync(normalizedPath)) {
                return res.json({ exists: false, content: '', path: normalizedPath });
            }
            
            const content = fs.readFileSync(normalizedPath, 'utf-8');
            res.json({ exists: true, content, path: normalizedPath });
        } catch (err) {
            console.error('[Memory Read Error]:', err);
            res.status(500).json({ error: 'Failed to read file', details: err.message });
        }
    });

    // Memory file operations - write/update memory file content
    server.post('/api/memory/write', (req, res) => {
        try {
            const { filePath, content } = req.body;
            if (!filePath || content === undefined) {
                return res.status(400).json({ error: 'Missing file path or content' });
            }
            
            // Security check: ensure path is within allowed directories
            const normalizedPath = path.normalize(filePath);
            const simonaConfigDir = process.env.SIMONA_CONFIG_HOME || path.join(os.homedir(), '.simona');
            const projectCwd = process.cwd();
            
            if (!normalizedPath.startsWith(simonaConfigDir) && !normalizedPath.startsWith(projectCwd)) {
                return res.status(403).json({ error: 'Access denied: file outside allowed directories' });
            }
            
            // Ensure parent directory exists
            const dir = path.dirname(normalizedPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(normalizedPath, content, 'utf-8');
            res.json({ success: true, path: normalizedPath });
        } catch (err) {
            console.error('[Memory Write Error]:', err);
            res.status(500).json({ error: 'Failed to write file', details: err.message });
        }
    });

    // Memory file operations - search memory files by name and content
    server.get('/api/memory/search', (req, res) => {
        try {
            const query = req.query.q || '';
            if (!query) {
                return res.json({ results: [] });
            }
            
            const simonaConfigDir = process.env.SIMONA_CONFIG_HOME || path.join(os.homedir(), '.simona');
            const projectCwd = process.cwd();
            const searchDirs = [simonaConfigDir, projectCwd];
            const results = [];
            
            // Directories to exclude from memory search
            const excludedDirs = new Set(['plugins', 'cache', 'telemetry', 'sessions', 'shell-snapshots', 'backups', 'node_modules', '.git']);
            
            // Supported file extensions for memory search
            const supportedExtensions = new Set([
                '.md', '.txt', '.json', '.yaml', '.yml', '.xml', '.csv',
                '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.java',
                '.css', '.scss', '.html', '.vue', '.svelte'
            ]);
            
            const searchInDir = (dir, baseDir, depth = 0) => {
                if (!fs.existsSync(dir)) return;
                
                // Limit search depth to avoid scanning too deep
                if (depth > 5) return;
                
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        
                        // Skip hidden directories except .simona
                        if (entry.isDirectory() && entry.name.startsWith('.') && entry.name !== '.simona') {
                            continue;
                        }
                        
                        // Skip non-memory directories (plugins, cache, telemetry, etc.)
                        if (entry.isDirectory() && excludedDirs.has(entry.name.toLowerCase())) {
                            continue;
                        }
                        
                        if (entry.isFile()) {
                            const ext = path.extname(entry.name).toLowerCase();
                            
                            // Skip binary/unsupported file types
                            if (!supportedExtensions.has(ext)) {
                                continue;
                            }
                            
                            try {
                                const content = fs.readFileSync(fullPath, 'utf-8');
                                const relativePath = path.relative(baseDir, fullPath);
                                
                                // Check if filename or content matches query
                                const nameMatch = entry.name.toLowerCase().includes(query.toLowerCase());
                                const contentMatch = content.toLowerCase().includes(query.toLowerCase());
                                
                                if (nameMatch || contentMatch) {
                                    results.push({
                                        path: fullPath,
                                        relativePath,
                                        fileName: entry.name,
                                        size: content.length,
                                        modified: fs.statSync(fullPath).mtime.toISOString(),
                                        matchType: nameMatch ? (contentMatch ? 'both' : 'name') : 'content'
                                    });
                                }
                            } catch (_) {}
                        } else if (entry.isDirectory()) {
                            searchInDir(fullPath, baseDir, depth + 1);
                        }
                    }
                } catch (_) {}
            };
            
            for (const dir of searchDirs) {
                searchInDir(dir, dir);
            }
            
            // Remove duplicates by path
            const uniqueResults = [];
            const seenPaths = new Set();
            for (const result of results) {
                if (!seenPaths.has(result.path)) {
                    seenPaths.add(result.path);
                    uniqueResults.push(result);
                }
            }
            
            res.json({ results: uniqueResults, total: uniqueResults.length });
        } catch (err) {
            console.error('[Memory Search Error]:', err);
            res.status(500).json({ error: 'Failed to search files', details: err.message });
        }
    });

    // Compact conversation — delegates to shared compactConversation helper
    server.post('/api/conversations/:id/compact', async (req, res) => {
        try {
            const result = await compactConversation(req.params.id, {
                apiKey: req.body.env_token,
                baseUrl: req.body.env_base_url,
                instruction: req.body.instruction,
            });
            res.json(result);
        } catch (err) {
            console.error('[Compact] Error:', err);
            res.status(500).json({ error: err.message || 'Compaction failed' });
        }
    });

    // Stop generation — kill the engine process for this conversation
    server.post('/api/conversations/:id/stop-generation', (req, res) => {
        const proc = activeChildren.get(req.params.id);
        if (proc && proc.pid) {
            console.log('[Stop] Killing engine PID', proc.pid, 'for conversation', req.params.id);
            killProcessTree(proc.pid);
            activeChildren.delete(req.params.id);
        }
        endStream(req.params.id);
        res.json({ ok: true });
    });

    // AskUserQuestion — receive user's answer and write back to engine stdin
    server.post('/api/conversations/:id/answer', (req, res) => {
        const { request_id, tool_use_id, answers } = req.body;
        const child = activeChildren.get(req.params.id);
        if (!child) return res.status(404).json({ error: 'No active engine process' });
        if (!request_id) return res.status(400).json({ error: 'Missing request_id' });

        // Merge user answers into the original tool input so engine sees them
        const originalInput = askUserPendingInputs.get(req.params.id) || {};
        askUserPendingInputs.delete(req.params.id);

        const controlResponse = JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: request_id,
                response: {
                    toolUseID: tool_use_id || '',
                    behavior: 'allow',
                    updatedInput: { ...originalInput, answers: answers || {} },
                }
            }
        }) + '\n';

        try {
            child.stdin.write(controlResponse);
            console.log('[AskUser] Answered request_id=' + request_id, JSON.stringify(answers || {}).slice(0, 200));
            res.json({ ok: true });
        } catch (err) {
            console.error('[AskUser] Write error:', err.message);
            res.status(500).json({ error: 'Failed to write to engine stdin' });
        }
    });

    // Tool permission response — frontend Allow/Deny decision written back to engine stdin
    server.post('/api/conversations/:id/permission-response', (req, res) => {
        const { request_id, tool_use_id, behavior } = req.body;
        if (!request_id) return res.status(400).json({ error: 'Missing request_id' });
        const pending = pendingPermissionRequests.get(request_id);
        if (!pending) return res.status(404).json({ error: 'No pending permission request' });
        const child = pending.child;
        if (!child || !child.stdin) return res.status(404).json({ error: 'No active engine process' });
        pendingPermissionRequests.delete(request_id);
        const allow = behavior !== 'deny';
        const controlResponse = JSON.stringify({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: request_id,
                response: {
                    toolUseID: tool_use_id || pending.tool_use_id || '',
                    behavior: allow ? 'allow' : 'deny',
                    updatedInput: pending.input || {},
                }
            }
        }) + '\n';
        try {
            child.stdin.write(controlResponse);
            console.log('[Permission][' + (allow ? 'Allow' : 'Deny') + '] request_id=' + request_id + ' tool=' + (pending.tool_name || '?'));
            res.json({ ok: true });
        } catch (err) {
            console.error('[Permission] Write error:', err.message);
            res.status(500).json({ error: 'Failed to write to engine stdin' });
        }
    });

    // Get / set auto-approve permissions setting
    server.get('/api/permissions/config', (req, res) => {
        res.json({ autoApprove: autoApprovePermissions });
    });
    server.post('/api/permissions/config', (req, res) => {
        autoApprovePermissions = !!(req.body && req.body.autoApprove);
        saveAutoApprovePermissions(autoApprovePermissions);
        console.log('[Permission] autoApprovePermissions set to', autoApprovePermissions);
        res.json({ autoApprove: autoApprovePermissions });
    });

    // Stream status — check if a conversation has an active engine stream
    server.get('/api/conversations/:id/stream-status', (req, res) => {
        const stream = activeStreams.get(req.params.id);
        res.json({ active: !!(stream && !stream.done), eventCount: stream ? stream.events.length : 0 });
    });

    // Get context size for a conversation (uses real usage stats from API responses)
    server.get('/api/conversations/:id/context-size', (req, res) => {
        const conv = db.conversations.find(c => c.id === req.params.id);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });
        
        // Try to get real usage stats from conversationUsage map
        const usage = conversationUsage.get(req.params.id);
        if (usage) {
            const totalTokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
            console.log('[ContextSize] Using real usage stats for', req.params.id, ':', totalTokens, 'tokens');
            return res.json({ tokens: totalTokens, limit: 1000000, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
        }
        
        // Fallback: count tokens by summing up message lengths
        const messages = db.messages.filter(m => m.conversation_id === req.params.id);
        let totalTokens = 0;
        for (const msg of messages) {
            try {
                const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
                totalTokens += Math.ceil(content.length / 4); // Rough token estimate
            } catch (_) {}
        }
        
        res.json({ tokens: totalTokens, limit: 1000000 });
    });

    // Reconnect to an active stream — sends all buffered events then continues live
    server.get('/api/conversations/:id/reconnect', (req, res) => {
        const stream = activeStreams.get(req.params.id);
        if (!stream) return res.status(404).json({ error: 'No active stream' });

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        // Send all buffered events
        for (const event of stream.events) {
            res.write('data: ' + JSON.stringify(event) + '\n\n');
        }
        // Force flush to ensure immediate delivery
        if (res.flush) res.flush();

        if (stream.done) {
            res.write('data: [DONE]\n\n');
            if (res.flush) res.flush();
            res.end();
            return;
        }

        // Add to listeners for future events
        stream.listeners.add(res);
        req.on('close', () => stream.listeners.delete(res));
    });

    // ===== Provider CRUD =====
    server.get('/api/providers', (req, res) => {
        // Hide fixed-mode providers (server-managed) from frontend
        res.json(providers.filter(p => !p.isFixedMode));
    });
    server.post('/api/providers', (req, res) => {
        const p = req.body;
        p.id = uuidv4();
        if (!p.name) return res.status(400).json({ error: 'Missing name' });
        if (!p.models) p.models = [];
        if (p.enabled === undefined) p.enabled = true;
        if (p.baseUrl) p.baseUrl = normalizeBaseUrl(p.baseUrl);
        providers.push(p);
        saveProviders();
        res.json(p);
    });
    server.patch('/api/providers/:id', (req, res) => {
        const p = providers.find(x => x.id === req.params.id);
        if (!p) return res.status(404).json({ error: 'Not found' });
        if (p.isFixedMode) return res.status(403).json({ error: 'Cannot modify fixed-mode provider' });
        if (req.body.baseUrl) req.body.baseUrl = normalizeBaseUrl(req.body.baseUrl);
        Object.assign(p, req.body);
        delete p._id;
        saveProviders();
        res.json(p);
    });
    server.delete('/api/providers/:id', (req, res) => {
        const p = providers.find(x => x.id === req.params.id);
        if (p && p.isFixedMode) return res.status(403).json({ error: 'Cannot delete fixed-mode provider' });
        providers = providers.filter(x => x.id !== req.params.id);
        saveProviders();
        res.json({ ok: true });
    });
    // Get all available models across all enabled providers
    server.get('/api/providers/models', (req, res) => {
        const models = [];
        for (const p of providers) {
            if (!p.enabled) continue;
            for (const m of (p.models || [])) {
                if (m.enabled === false) continue;
                models.push({ id: m.id, name: m.name || m.id, providerId: p.id, providerName: p.name });
            }
        }
        res.json(models);
    });

    // Workspace config
    server.get('/api/workspace-config', (req, res) => {
        res.json({ workspacesDir, defaultDir: defaultWorkspacesDir });
    });
    server.post('/api/workspace-config', (req, res) => {
        const { dir } = req.body;
        if (!dir) return res.status(400).json({ error: 'Missing dir' });
        try {
            const settingsPath = path.join(userDataPath, 'workspace-config.json');
            fs.writeFileSync(settingsPath, JSON.stringify({ workspacesDir: dir }));
            res.json({ ok: true, dir });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ===== Model Settings Sync (for web control panel) =====
    const SETTINGS_SYNC_PATH = path.join(userDataPath, 'settings.json');
    server.get('/api/settings', (req, res) => {
        try {
            if (fs.existsSync(SETTINGS_SYNC_PATH)) {
                const data = JSON.parse(fs.readFileSync(SETTINGS_SYNC_PATH, 'utf8'));
                res.json(data);
            } else {
                res.json({});
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });
    server.put('/api/settings', (req, res) => {
        try {
            const settings = req.body;
            fs.writeFileSync(SETTINGS_SYNC_PATH, JSON.stringify(settings, null, 2));
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ===== Skills =====
    // Paths — userSkillsDir matches engine's skill loading path (~/.simona/skills/)
    const bundledSkillsDir = path.join(__dirname, 'skills');
    const homeDir = os.homedir();
    const localSkillsDir = path.join(homeDir, '.agents', 'skills');
    const userSkillsDir = path.join(homeDir, '.simona', 'skills');
    const skillPrefsPath = path.join(userDataPath, 'skill-preferences.json');

    if (!fs.existsSync(userSkillsDir)) {
        fs.mkdirSync(userSkillsDir, { recursive: true });
    }

    // Sync bundled skills to ~/.simona/skills/ so the engine can find them
    // Only copies skills that don't already exist (won't overwrite user modifications)
    if (fs.existsSync(bundledSkillsDir)) {
        try {
            const bundledEntries = fs.readdirSync(bundledSkillsDir, { withFileTypes: true });
            for (const entry of bundledEntries) {
                if (!entry.isDirectory()) continue;
                const target = path.join(userSkillsDir, entry.name);
                if (fs.existsSync(target)) {
                    fs.rmSync(target, { recursive: true, force: true });
                }
                const copyDirSync = (src, dest) => {
                    fs.mkdirSync(dest, { recursive: true });
                    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
                        const s = path.join(src, item.name);
                        const d = path.join(dest, item.name);
                        if (item.isDirectory()) copyDirSync(s, d);
                        else fs.copyFileSync(s, d);
                    }
                };
                copyDirSync(path.join(bundledSkillsDir, entry.name), target);
                console.log('[Skills] Synced bundled skill to ~/.simona/skills/:', entry.name);
            }
        } catch (e) { console.error('[Skills] Sync error:', e.message); }
    }

    // ===== Simona-Mem Plugin Seeding =====
    // If simona-mem is bundled in resources, seed it to ~/.simona/plugins/cache/
    // so the engine can discover it without requiring manual user installation.
    const bundledSimonaMemDir = path.join(resourcesPath, 'simona-mem');
    if (fs.existsSync(bundledSimonaMemDir)) {
        try {
            const simonaMemCacheDir = path.join(homeDir, '.simona', 'plugins', 'cache', 'thedotmack', 'simona-mem');
            const pluginManifestPath = path.join(bundledSimonaMemDir, '.simona-plugin', 'plugin.json');
            // Read bundled version from plugin manifest
            let seedVersion = '12.4.7';
            try {
                const manifest = JSON.parse(fs.readFileSync(pluginManifestPath, 'utf8'));
                if (manifest.version) seedVersion = manifest.version;
            } catch (_) {}
            const targetVersionDir = path.join(simonaMemCacheDir, seedVersion);

            // Only seed if no version of simona-mem exists in the user plugin cache
            if (!fs.existsSync(simonaMemCacheDir) || fs.readdirSync(simonaMemCacheDir, { withFileTypes: true }).filter(e => e.isDirectory()).length === 0) {
                fs.mkdirSync(targetVersionDir, { recursive: true });
                const copyDirSync = (src, dest) => {
                    fs.mkdirSync(dest, { recursive: true });
                    for (const item of fs.readdirSync(src, { withFileTypes: true })) {
                        const s = path.join(src, item.name);
                        const d = path.join(dest, item.name);
                        if (item.isDirectory()) copyDirSync(s, d);
                        else fs.copyFileSync(s, d);
                    }
                };
                copyDirSync(bundledSimonaMemDir, targetVersionDir);
                console.log('[Simona-Mem] Seeded bundled simona-mem to:', targetVersionDir);
            }

            // Ensure the plugin is enabled in ~/.simona/settings.json
            const simonaDir = path.join(homeDir, '.simona');
            const simonaSettingsPath = path.join(simonaDir, 'settings.json');
            let simonaSettings = {};
            if (fs.existsSync(simonaSettingsPath)) {
                try { simonaSettings = JSON.parse(fs.readFileSync(simonaSettingsPath, 'utf8')); } catch (_) {}
            }
            const enabledPlugins = simonaSettings.enabledPlugins || {};
            // Only enable if not explicitly set (don't override user's explicit disable)
            if (enabledPlugins['simona-mem@thedotmack'] === undefined) {
                simonaSettings.enabledPlugins = { ...enabledPlugins, 'simona-mem@thedotmack': true };
                fs.mkdirSync(simonaDir, { recursive: true });
                fs.writeFileSync(simonaSettingsPath, JSON.stringify(simonaSettings, null, 2));
                console.log('[Simona-Mem] Enabled simona-mem@thedotmack in ~/.simona/settings.json');
            }

            // ===== Node Bridge for simona-mem hooks =====
            // simona-mem hooks run `node script.js` (smart-install, bun-runner).
            // The bundled Git does not ship node, so on machines without a global
            // Node.js install the hooks would fail. Create a `node` bridge that
            // forwards to the bundled bun.exe (a Node-compatible runtime) and put
            // engine/bin on PATH so every spawned engine + bash hook can find it.
            const engineBinDir = path.join(resourcesPath, 'engine', 'bin');
            const bundledBunExe = path.join(engineBinDir, 'bun.exe');
            if (fs.existsSync(bundledBunExe)) {
                let pathUpdated = false;
                if (!process.env.PATH.split(path.delimiter).some(p => path.resolve(p) === engineBinDir)) {
                    process.env.PATH = engineBinDir + path.delimiter + process.env.PATH;
                    pathUpdated = true;
                }
                const nodeBatPath = path.join(engineBinDir, 'node.bat');
                if (!fs.existsSync(nodeBatPath)) {
                    fs.writeFileSync(nodeBatPath, '@echo off\r\n"%~dp0bun.exe" %*\r\n');
                    console.log('[Simona-Mem] Created node.bat bridge -> bun.exe');
                }
                const nodeShPath = path.join(engineBinDir, 'node');
                if (!fs.existsSync(nodeShPath)) {
                    fs.writeFileSync(nodeShPath, '#!/bin/sh\nexec "$(dirname "$0")/bun.exe" "$@"\n');
                    console.log('[Simona-Mem] Created node bridge -> bun.exe');
                }
                if (pathUpdated) console.log('[Simona-Mem] Added engine/bin to PATH for simona-mem hooks');
            }
        } catch (e) { console.error('[Simona-Mem] Seeding error:', e.message); }
    }

    // Load / save skill preferences (enabled/disabled per skill id)
    function loadSkillPrefs() {
        if (fs.existsSync(skillPrefsPath)) {
            try { return JSON.parse(fs.readFileSync(skillPrefsPath, 'utf8')); } catch (e) { }
        }
        return {};
    }
    function saveSkillPrefs(prefs) {
        fs.writeFileSync(skillPrefsPath, JSON.stringify(prefs, null, 2));
    }

    // Parse SKILL.md frontmatter
    function parseSkillMd(content) {
        const normalized = content.replace(/\r\n/g, '\n');
        const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (!match) return { frontmatter: {}, body: content };
        const fm = match[1];
        const body = match[2].trim();
        const nameMatch = fm.match(/^name:\s*(.+)$/m);
        const descMatch = fm.match(/^description:\s*(.+)$/m);
        return {
            name: nameMatch ? nameMatch[1].trim() : null,
            description: descMatch ? descMatch[1].trim() : '',
            content: body
        };
    }

    // Recursively list files in a skill directory as a tree
    function scanSkillFiles(dirPath) {
        const result = [];
        if (!fs.existsSync(dirPath)) return result;
        try {
            const entries = fs.readdirSync(dirPath, { withFileTypes: true })
                .filter(e => !e.name.startsWith('.'))
                .sort((a, b) => {
                    if (a.isDirectory() && !b.isDirectory()) return -1;
                    if (!a.isDirectory() && b.isDirectory()) return 1;
                    // SKILL.md always first among files
                    if (a.name === 'SKILL.md') return -1;
                    if (b.name === 'SKILL.md') return 1;
                    return a.name.localeCompare(b.name);
                });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const children = scanSkillFiles(path.join(dirPath, entry.name));
                    result.push({ name: entry.name, type: 'folder', children });
                } else {
                    result.push({ name: entry.name, type: 'file' });
                }
            }
        } catch (_) {}
        return result;
    }

    // Scan a directory for skill folders (each containing SKILL.md)
    function scanSkillsDir(dir, source) {
        const skills = [];
        if (!fs.existsSync(dir)) return skills;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const mdPath = path.join(dir, entry.name, 'SKILL.md');
                if (!fs.existsSync(mdPath)) continue;
                try {
                    const raw = fs.readFileSync(mdPath, 'utf8');
                    const parsed = parseSkillMd(raw);
                    if (!parsed) continue;
                    skills.push({
                        id: `${source}:${entry.name}`,
                        name: parsed.name || entry.name,
                        description: parsed.description,
                        content: parsed.content,
                        is_example: true,
                        source_dir: entry.name,
                        source: source,
                        user_id: null,
                        created_at: null
                    });
                } catch (e) { /* skip unreadable */ }
            }
        } catch (e) { /* dir not readable */ }
        return skills;
    }

    // Load user-created skills from ~/.simona/skills/ (standard SKILL.md format)
    function loadUserSkills() {
        return scanSkillsDir(userSkillsDir, 'user').map(s => ({ ...s, is_example: false }));
    }

    // GET /api/skills — list all skills
    server.get('/api/skills', (req, res) => {
        const prefs = loadSkillPrefs();

        // 1) Bundled example skills
        const bundled = scanSkillsDir(bundledSkillsDir, 'bundled');
        // 2) Local ~/.agents/skills/
        const local = scanSkillsDir(localSkillsDir, 'local');
        // Combine examples, deduplicate by name (bundled takes priority)
        const seenNames = new Set();
        const allExamples = [];
        for (const s of bundled) {
            seenNames.add(s.name);
            allExamples.push({ ...s, enabled: prefs[s.id] !== undefined ? prefs[s.id] : true });
        }
        for (const s of local) {
            if (seenNames.has(s.name)) continue;
            seenNames.add(s.name);
            allExamples.push({ ...s, enabled: prefs[s.id] !== undefined ? prefs[s.id] : true });
        }

        // 3) User-created skills
        const userSkills = loadUserSkills().map(s => ({
            ...s,
            enabled: prefs[s.id] !== undefined ? prefs[s.id] : true
        }));

        // Strip content from list response (only return on detail)
        const stripContent = (s) => {
            const { content, ...rest } = s;
            return rest;
        };

        res.json({
            examples: allExamples.map(stripContent),
            my_skills: userSkills.map(stripContent)
        });
    });

    // GET /api/skills/:id — skill detail with content
    server.get('/api/skills/:id', (req, res) => {
        const { id } = req.params;
        const prefs = loadSkillPrefs();

        // Check bundled
        const bundled = scanSkillsDir(bundledSkillsDir, 'bundled');
        const local = scanSkillsDir(localSkillsDir, 'local');
        const allExamples = [...bundled, ...local];
        const example = allExamples.find(s => s.id === id);
        if (example) {
            // Resolve the skill's directory and scan its files
            const baseDir = example.source === 'bundled' ? bundledSkillsDir : localSkillsDir;
            const skillDir = path.join(baseDir, example.source_dir);
            const files = scanSkillFiles(skillDir);
            return res.json({ ...example, enabled: prefs[id] !== undefined ? prefs[id] : true, files, dir_path: skillDir });
        }

        // Check user skills (~/.simona/skills/)
        const userSkills = loadUserSkills();
        const userSkill = userSkills.find(s => s.id === id);
        if (userSkill) {
            const skillDir = path.join(userSkillsDir, userSkill.source_dir);
            const files = scanSkillFiles(skillDir);
            return res.json({ ...userSkill, enabled: prefs[id] !== undefined ? prefs[id] : true, files, dir_path: skillDir });
        }

        res.status(404).json({ error: 'Skill not found' });
    });

    // GET /api/skills/:id/file — get content of a specific file within a skill
    server.get('/api/skills/:id/file', (req, res) => {
        const { id } = req.params;
        const filePath = req.query.path;
        if (!filePath) return res.status(400).json({ error: 'path query param required' });

        // Find skill directory (bundled, local, or user)
        const bundled = scanSkillsDir(bundledSkillsDir, 'bundled');
        const local = scanSkillsDir(localSkillsDir, 'local');
        const user = loadUserSkills();
        const skill = [...bundled, ...local, ...user].find(s => s.id === id);
        if (!skill) return res.status(404).json({ error: 'Skill not found' });

        const baseDirMap = { 'bundled': bundledSkillsDir, 'local': localSkillsDir, 'user': userSkillsDir };
        const baseDir = baseDirMap[skill.source] || userSkillsDir;
        const fullPath = path.join(baseDir, skill.source_dir, filePath);

        // Security: ensure path is within skill directory
        const resolved = path.resolve(fullPath);
        const skillRoot = path.resolve(path.join(baseDir, skill.source_dir));
        if (!resolved.startsWith(skillRoot)) return res.status(403).json({ error: 'Access denied' });

        if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
        try {
            const content = fs.readFileSync(resolved, 'utf8');
            res.json({ content, path: filePath });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST /api/skills — create user skill as ~/.simona/skills/skill-name/SKILL.md
    server.post('/api/skills', (req, res) => {
        const { name, description, content } = req.body;
        if (!name) return res.status(400).json({ error: 'Name is required' });

        // Convert name to directory-safe slug
        const slug = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'skill-' + Date.now();
        const skillDir = path.join(userSkillsDir, slug);
        if (fs.existsSync(skillDir)) {
            return res.status(409).json({ error: 'Skill with this name already exists' });
        }

        fs.mkdirSync(skillDir, { recursive: true });
        const frontmatter = `---\nname: ${name}\ndescription: ${description || ''}\n---\n\n${content || ''}`;
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), frontmatter);

        const id = `user:${slug}`;
        const prefs = loadSkillPrefs();
        prefs[id] = true;
        saveSkillPrefs(prefs);

        res.json({ id, name, description: description || '', content: content || '', is_example: false, source_dir: slug, source: 'user', enabled: true });
    });

    // POST /api/skills/import — import skill from uploaded file (.zip or .md)
    const skillUpload = multer({ 
        storage: multer.memoryStorage(),
        limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
    });
    
    server.post('/api/skills/import', skillUpload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const file = req.file;
            const fileName = file.originalname.toLowerCase();
            let skillData = null;

            if (fileName.endsWith('.md')) {
                // Handle .md file
                const content = file.buffer.toString('utf8');
                const parsed = parseSkillMd(content);
                if (!parsed || !parsed.name) {
                    return res.status(400).json({ error: 'Invalid skill file: missing YAML frontmatter with name and description' });
                }
                skillData = {
                    name: parsed.name,
                    description: parsed.description || '',
                    content: parsed.content || content
                };
            } else if (fileName.endsWith('.zip')) {
                // Handle .zip file using adm-zip
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(file.buffer);
                const zipEntries = zip.getEntries();
                
                // Look for SKILL.md in root or subdirectories
                let skillMdEntry = null;
                let skillMdContent = null;
                
                // First check root directory
                for (const entry of zipEntries) {
                    if (entry.entryName === 'SKILL.md' && !entry.isDirectory) {
                        skillMdEntry = entry;
                        skillMdContent = entry.getData().toString('utf8');
                        break;
                    }
                }
                
                // If not found in root, check subdirectories
                if (!skillMdContent) {
                    for (const entry of zipEntries) {
                        if ((entry.entryName.endsWith('/SKILL.md') || entry.entryName.endsWith('\\SKILL.md')) && !entry.isDirectory) {
                            skillMdEntry = entry;
                            skillMdContent = entry.getData().toString('utf8');
                            break;
                        }
                    }
                }
                
                if (!skillMdContent) {
                    return res.status(400).json({ error: 'No SKILL.md found in zip file' });
                }
                
                const parsed = parseSkillMd(skillMdContent);
                if (!parsed || !parsed.name) {
                    return res.status(400).json({ error: 'Invalid SKILL.md: missing YAML frontmatter with name and description' });
                }
                
                skillData = {
                    name: parsed.name,
                    description: parsed.description || '',
                    content: parsed.content || skillMdContent
                };
            } else {
                return res.status(400).json({ error: 'Unsupported file type. Only .zip and .md files are supported' });
            }

            // Create the skill directory
            const slug = skillData.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'skill-' + Date.now();
            const skillDir = path.join(userSkillsDir, slug);
            
            if (fs.existsSync(skillDir)) {
                return res.status(409).json({ error: 'Skill with this name already exists' });
            }

            fs.mkdirSync(skillDir, { recursive: true });
            
            // Write SKILL.md file
            const frontmatter = `---\nname: ${skillData.name}\ndescription: ${skillData.description || ''}\n---\n\n${skillData.content || ''}`;
            fs.writeFileSync(path.join(skillDir, 'SKILL.md'), frontmatter);

            // If it's a zip file, extract other files too
            if (fileName.endsWith('.zip')) {
                const AdmZip = require('adm-zip');
                const zip = new AdmZip(file.buffer);
                const zipEntries = zip.getEntries();
                
                for (const entry of zipEntries) {
                    // Skip directories and SKILL.md (already written)
                    if (entry.isDirectory || entry.entryName === 'SKILL.md' || entry.entryName.endsWith('/SKILL.md') || entry.entryName.endsWith('\\SKILL.md')) {
                        continue;
                    }
                    
                    // Create subdirectory if needed
                    const targetPath = path.join(skillDir, entry.entryName);
                    const targetDir = path.dirname(targetPath);
                    if (!fs.existsSync(targetDir)) {
                        fs.mkdirSync(targetDir, { recursive: true });
                    }
                    
                    // Write file
                    fs.writeFileSync(targetPath, entry.getData());
                }
            }

            const id = `user:${slug}`;
            const prefs = loadSkillPrefs();
            prefs[id] = true;
            saveSkillPrefs(prefs);

            res.json({ 
                id, 
                name: skillData.name, 
                description: skillData.description || '', 
                content: skillData.content || '', 
                is_example: false, 
                source_dir: slug, 
                source: 'user', 
                enabled: true 
            });
        } catch (error) {
            console.error('[Skills Import] Error:', error);
            res.status(500).json({ error: error.message || 'Import failed' });
        }
    });

    // PATCH /api/skills/:id — update user skill (writes SKILL.md)
    server.patch('/api/skills/:id', (req, res) => {
        const { id } = req.params;
        // Only user skills (source=user) are editable
        const userSkills = loadUserSkills();
        const skill = userSkills.find(s => s.id === id);
        if (!skill || !skill.source_dir) {
            return res.status(404).json({ error: 'Skill not found or not editable' });
        }
        try {
            const name = req.body.name !== undefined ? req.body.name : skill.name;
            const description = req.body.description !== undefined ? req.body.description : skill.description;
            const content = req.body.content !== undefined ? req.body.content : skill.content;
            const frontmatter = `---\nname: ${name}\ndescription: ${description || ''}\n---\n\n${content || ''}`;
            fs.writeFileSync(path.join(userSkillsDir, skill.source_dir, 'SKILL.md'), frontmatter);

            const prefs = loadSkillPrefs();
            res.json({ ...skill, name, description, content, enabled: prefs[id] !== undefined ? prefs[id] : true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // DELETE /api/skills/:id — delete user skill (removes directory)
    server.delete('/api/skills/:id', (req, res) => {
        const { id } = req.params;
        const userSkills = loadUserSkills();
        const skill = userSkills.find(s => s.id === id);
        if (!skill || !skill.source_dir) {
            return res.status(404).json({ error: 'Skill not found' });
        }
        const skillDir = path.join(userSkillsDir, skill.source_dir);
        if (fs.existsSync(skillDir)) {
            fs.rmSync(skillDir, { recursive: true, force: true });
        }
        const prefs = loadSkillPrefs();
        delete prefs[id];
        saveSkillPrefs(prefs);
        res.json({ ok: true });
    });

    // PATCH /api/skills/:id/toggle — toggle enabled state
    server.patch('/api/skills/:id/toggle', (req, res) => {
        const { id } = req.params;
        const { enabled } = req.body;
        const prefs = loadSkillPrefs();
        prefs[id] = !!enabled;
        saveSkillPrefs(prefs);
        res.json({ ok: true, enabled: !!enabled });
    });

    // Get all enabled skills with full content (for UseSkill tool)
    function getAllEnabledSkills() {
        const prefs = loadSkillPrefs();
        const enabledIds = Object.keys(prefs).filter(id => prefs[id]);
        if (enabledIds.length === 0) return [];
        const allSkills = [
            ...scanSkillsDir(bundledSkillsDir, 'bundled'),
            ...scanSkillsDir(localSkillsDir, 'local'),
            ...loadUserSkills()
        ];
        return allSkills.filter(s => enabledIds.includes(s.id));
    }

    // Build lightweight skills index for system prompt (names + descriptions only)
    function getEnabledSkillsBlock() {
        const prefs = loadSkillPrefs();
        const enabledIds = Object.keys(prefs).filter(id => prefs[id]);
        console.log(`[Skills] Prefs:`, JSON.stringify(prefs), `Enabled IDs:`, enabledIds);
        if (enabledIds.length === 0) return '';

        const allSkills = [
            ...scanSkillsDir(bundledSkillsDir, 'bundled'),
            ...scanSkillsDir(localSkillsDir, 'local'),
            ...loadUserSkills()
        ];

        console.log(`[Skills] All scanned:`, allSkills.map(s => s.id));
        const enabled = allSkills.filter(s => enabledIds.includes(s.id));
        console.log(`[Skills] Matched enabled:`, enabled.map(s => s.id));
        if (enabled.length === 0) return '';

        // Only inject skill INDEX (name + description) into system prompt.
        // Full content is loaded on demand via the UseSkill tool.
        let block = `<available_skills>
You have the following skills available. When a user's request matches a skill's description, you MUST use it by calling the UseSkill tool with the skill name to load its full instructions, then follow those instructions precisely.

`;
        for (const s of enabled) {
            block += `- **${s.name}**: ${s.description}\n`;
        }
        block += `\nTo use a skill, call the UseSkill tool with the skill name. The tool will return the full skill instructions for you to follow.\n</available_skills>`;
        console.log(`[Skills] ${enabled.length} skill(s) indexed in system prompt`);
        return block;
    }

    // ═══════════════════════════════════════════════════════════════
    //  SKILL MARKET — cloud skills download
    // ═══════════════════════════════════════════════════════════════

    const cloudSkillsDir = path.join(__dirname, 'cloud-skills');

    // GET /api/skills/market/:category — list cloud skills in a category
    server.get('/api/skills/market/:category', (req, res) => {
        const { category } = req.params;
        const catDir = path.join(cloudSkillsDir, category);
        if (!fs.existsSync(catDir)) {
            return res.json({ categories: [{ id: category, name: category, skills: [] }] });
        }
        const skills = [];
        try {
            const entries = fs.readdirSync(catDir, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const skillPath = path.join(catDir, entry.name, 'SKILL.md');
                if (!fs.existsSync(skillPath)) continue;
                const content = fs.readFileSync(skillPath, 'utf8');
                const nameMatch = content.match(/^---\r?\nname:\s*(.+)/m);
                const descMatch = content.match(/^description:\s*(.+)/m);
                if (nameMatch) {
                    skills.push({
                        id: `cloud:${category}:${entry.name}`,
                        name: nameMatch[1].trim(),
                        description: descMatch ? descMatch[1].trim() : ''
                    });
                }
            }
        } catch (e) {
            console.error('[SkillMarket] Error scanning category:', category, e.message);
        }
        res.json({ categories: [{ id: category, name: category, skills }] });
    });

    // POST /api/skills/install — install a cloud skill to local skills directory
    server.post('/api/skills/install', (req, res) => {
        const { skill_id } = req.body;
        if (!skill_id || !skill_id.startsWith('cloud:')) {
            return res.status(400).json({ error: 'Invalid skill ID' });
        }
        const parts = skill_id.split(':');
        const category = parts[1];
        const skillName = parts.slice(2).join(':');
        const srcDir = path.join(cloudSkillsDir, category, skillName);
        const srcFile = path.join(srcDir, 'SKILL.md');
        if (!fs.existsSync(srcFile)) {
            return res.status(404).json({ error: 'Cloud skill not found' });
        }
        // Parse frontmatter for skill name
        const content = fs.readFileSync(srcFile, 'utf8');
        const nameMatch = content.match(/^---\r?\nname:\s*(.+)/m);
        if (!nameMatch) {
            return res.status(400).json({ error: 'Invalid skill file format' });
        }
        const skillNameParsed = nameMatch[1].trim();
        const slug = skillNameParsed.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'skill-' + Date.now();
        const destDir = path.join(userSkillsDir, slug);
        if (fs.existsSync(destDir)) {
            return res.json({ success: true, already_installed: true, path: destDir });
        }
        try {
            fs.mkdirSync(destDir, { recursive: true });
            fs.copyFileSync(srcFile, path.join(destDir, 'SKILL.md'));
            // Enable the skill
            const prefs = loadSkillPrefs();
            const userSkillId = `user:${slug}`;
            prefs[userSkillId] = true;
            saveSkillPrefs(prefs);
            res.json({ success: true, already_installed: false, path: destDir });
        } catch (e) {
            res.status(500).json({ error: 'Install failed: ' + e.message });
        }
    });

    // ═══════════════════════════════════════════════════════════════
    //  GITHUB CONNECTOR — OAuth + API
    // ═══════════════════════════════════════════════════════════════

    // GitHub OAuth App credentials
    // 方式1: 从环境变量读取（推荐）
    // 方式2: 硬编码（仅用于测试）
    const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'Ov23liWiTL6v74GsI2U7';
    const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || 'c3ee401a631d77a4ceebe33e68765d02ddccc36c';
    const GITHUB_REDIRECT_URI = process.env.GITHUB_REDIRECT_URI || 'http://127.0.0.1:30080/api/github/callback';
    
    // Debug: 打印 GitHub 配置
    console.log('[GitHub Config] CLIENT_ID:', GITHUB_CLIENT_ID);
    console.log('[GitHub Config] CLIENT_SECRET:', GITHUB_CLIENT_SECRET ? '***' + GITHUB_CLIENT_SECRET.slice(-4) : 'undefined');
    console.log('[GitHub Config] REDIRECT_URI:', GITHUB_REDIRECT_URI);
    console.log('[GitHub Config] From env?', !!process.env.GITHUB_CLIENT_ID);

    // Persistent storage for GitHub token
    const githubTokenPath = path.join(userDataPath, 'github-token.json');
    function loadGithubToken() {
        try {
            if (fs.existsSync(githubTokenPath)) return JSON.parse(fs.readFileSync(githubTokenPath, 'utf8'));
        } catch (_) {}
        return null;
    }
    function saveGithubToken(data) {
        fs.writeFileSync(githubTokenPath, JSON.stringify(data, null, 2));
    }
    function clearGithubToken() {
        try { fs.unlinkSync(githubTokenPath); } catch (_) {}
    }

    // Persistent storage for remote proxy JWT token
    const jwtTokenPath = path.join(userDataPath, 'jwt-token.json');
    function loadJwtToken() {
        try {
            if (fs.existsSync(jwtTokenPath)) {
                const saved = JSON.parse(fs.readFileSync(jwtTokenPath, 'utf8'));
                if (saved.jwt) {
                    jwtToken = saved.jwt;
                    console.log('[Auth-Proxy] JWT token restored for', saved.email || 'unknown');
                }
            }
        } catch (_) {}
    }
    function saveJwtToken(jwt, email) {
        fs.writeFileSync(jwtTokenPath, JSON.stringify({ jwt, email, saved_at: new Date().toISOString() }, null, 2));
    }
    function clearJwtToken() {
        jwtToken = '';
        try { fs.unlinkSync(jwtTokenPath); } catch (_) {}
    }
    // Load saved JWT on startup
    loadJwtToken();

    // GET /api/github/status — check connection status
    server.get('/api/github/status', async (req, res) => {
        const token = loadGithubToken();
        if (!token || !token.access_token) return res.json({ connected: false });
        // Return cached user info without verifying every time (saves API calls)
        if (token.login) {
            return res.json({ connected: true, user: { login: token.login, avatar_url: token.avatar_url, name: token.name } });
        }
        res.json({ connected: false });
    });

    // GET /api/github/auth-url — return OAuth authorize URL
    server.get('/api/github/auth-url', (req, res) => {
        const state = require('crypto').randomBytes(16).toString('hex');
        const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(GITHUB_REDIRECT_URI)}&scope=repo,read:user&state=${state}`;
        res.json({ url, state });
    });

    // GET /api/github/callback — OAuth callback, exchange code for token
    server.get('/api/github/callback', async (req, res) => {
        const { code } = req.query;
        if (!code) return res.status(400).send('Missing code');
        try {
            // Use https module for better compatibility (avoids fetch issues in some Electron/Node environments)
            const tokenData = await new Promise((resolve, reject) => {
                const postData = JSON.stringify({ client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code, redirect_uri: GITHUB_REDIRECT_URI });
                const https = require('https');
                const tokenReq = https.request({
                    hostname: 'github.com', path: '/login/oauth/access_token', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(postData), 'User-Agent': 'SimonaDesktop' }
                }, (tokenRes) => {
                    let body = '';
                    tokenRes.on('data', c => body += c);
                    tokenRes.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Invalid JSON: ' + body.slice(0, 200))); } });
                });
                tokenReq.on('error', reject);
                tokenReq.write(postData);
                tokenReq.end();
            });

            if (tokenData.access_token) {
                // Fetch user info
                const user = await new Promise((resolve) => {
                    const https = require('https');
                    const userReq = https.request({
                        hostname: 'api.github.com', path: '/user', method: 'GET',
                        headers: { 'Authorization': `Bearer ${tokenData.access_token}`, 'User-Agent': 'SimonaDesktop' }
                    }, (userRes) => {
                        let body = '';
                        userRes.on('data', c => body += c);
                        userRes.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
                    });
                    userReq.on('error', () => resolve({}));
                    userReq.end();
                });
                saveGithubToken({ access_token: tokenData.access_token, login: user.login, avatar_url: user.avatar_url, name: user.name });
                console.log('[GitHub] Connected as', user.login);
                res.send(`<!DOCTYPE html><html><head><title>Connected</title><style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#1a1a1a;color:#fff}div{text-align:center}h2{margin-bottom:8px}</style></head><body><div><h2>GitHub Connected!</h2><p>You can close this window.</p><script>setTimeout(()=>window.close(),1500)</script></div></body></html>`);
            } else {
                console.error('[GitHub] Token error:', tokenData);
                res.status(400).send(`OAuth error: ${tokenData.error_description || tokenData.error || 'Unknown error'}`);
            }
        } catch (e) {
            console.error('[GitHub] Callback error:', e);
            res.status(500).send(`Error: ${e.message}`);
        }
    });

    // POST /api/github/disconnect — remove saved token
    server.post('/api/github/disconnect', (req, res) => {
        clearGithubToken();
        res.json({ ok: true });
    });

    // Helper: make GitHub API request using https module
    function githubApiRequest(path, token) {
        return new Promise((resolve, reject) => {
            const https = require('https');
            const req = https.request({
                hostname: 'api.github.com', path, method: 'GET',
                headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': 'SimonaDesktop' }
            }, (resp) => {
                let body = '';
                resp.on('data', c => body += c);
                resp.on('end', () => {
                    try { resolve({ status: resp.statusCode, data: JSON.parse(body) }); }
                    catch { reject(new Error('Invalid JSON')); }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    // GET /api/github/repos — list user repos
    server.get('/api/github/repos', async (req, res) => {
        const token = loadGithubToken();
        if (!token?.access_token) return res.status(401).json({ error: 'Not connected' });
        try {
            const page = req.query.page || 1;
            const { status, data } = await githubApiRequest(`/user/repos?sort=updated&per_page=30&page=${page}`, token.access_token);
            if (status !== 200) return res.status(status).json({ error: 'GitHub API error' });
            res.json(data.map(r => ({ id: r.id, name: r.name, full_name: r.full_name, description: r.description, private: r.private, html_url: r.html_url, language: r.language, updated_at: r.updated_at })));
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // GET /api/github/repos/:owner/:repo/contents — browse repo contents
    server.get('/api/github/repos/:owner/:repo/contents', async (req, res) => {
        const token = loadGithubToken();
        if (!token?.access_token) return res.status(401).json({ error: 'Not connected' });
        try {
            const filePath = req.query.path || '';
            const ref = req.query.ref || '';
            let apiPath = `/repos/${req.params.owner}/${req.params.repo}/contents/${filePath}`;
            if (ref) apiPath += `?ref=${encodeURIComponent(ref)}`;
            const { status, data } = await githubApiRequest(apiPath, token.access_token);
            if (status !== 200) return res.status(status).json({ error: 'GitHub API error' });
            res.json(data);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // GET /api/github/search — search code across repos
    server.get('/api/github/search', async (req, res) => {
        const token = loadGithubToken();
        if (!token?.access_token) return res.status(401).json({ error: 'Not connected' });
        try {
            const q = encodeURIComponent(req.query.q || '');
            const { status, data } = await githubApiRequest(`/search/code?q=${q}&per_page=20`, token.access_token);
            if (status !== 200) return res.status(status).json({ error: 'GitHub API error' });
            res.json(data);
        } catch (e) { res.status(500).json({ error: e.message }); }
    });

    // ═══════════════════════════════════════════════════════════════
    //  CHAT ENDPOINT — Simona Code Engine via Bun CLI subprocess
    // ═══════════════════════════════════════════════════════════════

    const { spawn } = require('child_process');

    // Resolve engine path — in packaged app, engine is in resources/engine
    const isPacked = app.isPackaged;
    const engineDir = isPacked
        ? path.join(process.resourcesPath, 'engine')
        : path.join(__dirname, '..', 'engine');
    const engineCli = path.join(engineDir, 'src', 'entrypoints', 'cli.tsx');
    const engineEnv = path.join(engineDir, '.env');

    // Resolve Bun executable: bundled → user-installed → PATH
    function findBunExe() {
        const bundled = path.join(engineDir, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
        if (fs.existsSync(bundled)) return bundled;
        const userInstalled = process.platform === 'win32'
            ? path.join(os.homedir(), '.bun', 'bin', 'bun.exe')
            : path.join(os.homedir(), '.bun', 'bin', 'bun');
        if (fs.existsSync(userInstalled)) return userInstalled;
        return 'bun'; // fallback to PATH
    }
    const bunExePath = findBunExe();
    console.log('[Engine] Bun:', bunExePath, 'exists:', fs.existsSync(bunExePath));

    // Load engine .env so bridge-server can use the same API config (for vision direct API calls)
    const engineEnvVars = {};
    try {
        const envContent = fs.readFileSync(engineEnv, 'utf8');
        for (const line of envContent.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) engineEnvVars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
        }
        console.log('[Engine] Loaded .env:', Object.keys(engineEnvVars).join(', '));
    } catch (_) {}
    const enginePreload = path.join(engineDir, 'preload.ts');

    // Helper: stream one API round, returns parsed response
    async function streamApiRound(endpoint, apiKey, model, systemPrompt, messages, tools, thinkingEnabled, sendSSE) {
        console.log(`[API] model=${model} thinking=${thinkingEnabled} systemPrompt=${systemPrompt ? systemPrompt.length + ' chars' : 'NONE'} messages=${messages.length} tools=${tools.length}`);
        const body = {
            model,
            system: systemPrompt || undefined,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            max_tokens: thinkingEnabled ? 16000 : 8192,
            stream: true,
        };
        if (thinkingEnabled) {
            body.thinking = { type: 'enabled', budget_tokens: 10000 };
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'simona-version': '2023-06-01',
            },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            let errMsg = `API Error ${response.status}`;
            try { const j = JSON.parse(errText); errMsg = j.error?.message || j.error || errMsg; } catch { if (errText) errMsg += `: ${errText.slice(0, 300)}`; }
            throw new Error(errMsg);
        }

        // Parse SSE stream
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let sseBuffer = '';
        let assistantText = '';
        let thinkingText = '';
        const contentBlocks = []; // accumulate full content blocks
        const blockAccumulators = {}; // index → { type, data }
        let stopReason = null;
        let usage = {};

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;

                let parsed;
                try { parsed = JSON.parse(data); } catch { continue; }

                switch (parsed.type) {
                    case 'content_block_start': {
                        const idx = parsed.index;
                        const block = parsed.content_block;
                        if (block.type === 'text') {
                            blockAccumulators[idx] = { type: 'text', text: '' };
                        } else if (block.type === 'thinking') {
                            blockAccumulators[idx] = { type: 'thinking', thinking: '' };
                        } else if (block.type === 'tool_use') {
                            blockAccumulators[idx] = { type: 'tool_use', id: block.id, name: block.name, inputJson: '' };
                        }
                        break;
                    }
                    case 'content_block_delta': {
                        const idx = parsed.index;
                        const delta = parsed.delta;
                        const acc = blockAccumulators[idx];
                        if (!acc) break;

                        if (delta.type === 'text_delta' && delta.text) {
                            acc.text += delta.text;
                            assistantText += delta.text;
                            // Forward to frontend — REAL streaming!
                            sendSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: delta.text } });
                        } else if (delta.type === 'thinking_delta' && delta.thinking) {
                            acc.thinking += delta.thinking;
                            thinkingText += delta.thinking;
                            sendSSE({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: delta.thinking } });
                        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                            acc.inputJson += delta.partial_json;
                        }
                        break;
                    }
                    case 'content_block_stop': {
                        const idx = parsed.index;
                        const acc = blockAccumulators[idx];
                        if (!acc) break;

                        if (acc.type === 'text') {
                            contentBlocks.push({ type: 'text', text: acc.text });
                        } else if (acc.type === 'thinking') {
                            contentBlocks.push({ type: 'thinking', thinking: acc.thinking });
                        } else if (acc.type === 'tool_use') {
                            let input = {};
                            try { input = JSON.parse(acc.inputJson); } catch { }
                            contentBlocks.push({ type: 'tool_use', id: acc.id, name: acc.name, input });
                            // Notify frontend
                            sendSSE({ type: 'tool_use_start', tool_use_id: acc.id, tool_name: acc.name, tool_input: input });
                            console.log(`[Tool] ${acc.name}`, JSON.stringify(input).slice(0, 150));
                        }
                        delete blockAccumulators[idx];
                        break;
                    }
                    case 'message_delta': {
                        if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
                        if (parsed.usage) usage = { ...usage, ...parsed.usage };
                        break;
                    }
                }
            }
        }

        return { contentBlocks, assistantText, thinkingText, stopReason, usage };
    }


    server.post('/api/chat', async (req, res) => {
        const { conversation_id, message, attachments, env_token, env_base_url, user_mode, user_profile, system_prompt, dialog_mode } = req.body;
        const conv = db.conversations.find(c => c.id === conversation_id);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        console.log('[Chat] conversation_id:', conversation_id);
        console.log('[Chat] dialog_mode:', dialog_mode); // 记录对话模式
        console.log('[Chat] conv.workspace_path:', conv.workspace_path);
        console.log('[Chat] global workspacesDir:', workspacesDir);

        // ── Early DeepSeek balance check (before SSE header setup) ──
        const rawModelCheck = conv.model || 'simona-sonnet-4-6';
        const modelIdCheck = rawModelCheck.replace(/-thinking$/, '');
        console.log('[Balance] modelIdCheck:', modelIdCheck);
        const providerCheck = resolveProvider(modelIdCheck);
        console.log('[Balance] providerCheck:', providerCheck ? providerCheck.id + ' / ' + providerCheck.name : 'null');
        const useRemoteCheck = !!(jwtToken && providerCheck && providerCheck.id === 'deepseek-fixed-mode');
        console.log('[Balance] useRemoteCheck:', useRemoteCheck, '| jwtToken exists:', !!jwtToken);
        if (useRemoteCheck && jwtToken) {
            try {
                console.log('[Balance] Fetching balance from:', REMOTE_SERVER + '/api/v1/balance');
                const balRes = await fetch(REMOTE_SERVER + '/api/v1/balance', {
                    headers: { 'Authorization': 'Bearer ' + jwtToken },
                    signal: AbortSignal.timeout(5000),
                });
                console.log('[Balance] Response status:', balRes.status);
                const balData = await balRes.json();
                console.log('[Balance] Data:', JSON.stringify(balData));
                const chatAvailBal = (balData.walletBalance || balData.available_balance || 0) - (balData.totalCost || 0);
                console.log('[Balance] chatAvailBal:', chatAvailBal);
                if (chatAvailBal <= 0) {
                    console.log('[Balance] INSUFFICIENT, returning 402');
                    return res.status(402).json({ error: '余额不足，请登录 https://example.com/ 充值后再试', code: 'INSUFFICIENT_BALANCE', availableBalance: chatAvailBal, rechargeUrl: 'https://example.com/' });
                }
            } catch (e) {
                console.error('[Balance-Check] Error:', e.message);
            }
        }

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Initialize stream buffer for this conversation
        res.flushHeaders();
        // Disable socket idle timeout — agents can take many minutes between events
        res.socket?.setTimeout(0);
        req.socket?.setTimeout(0);
        activeStreams.set(conversation_id, { events: [], listeners: new Set(), done: false, primaryRes: res });
        const sendSSE = (data) => {
            // Always write to primary response directly (original POST requester)
            var stream = activeStreams.get(conversation_id);
            if (stream) {
                stream.events.push(data);
                // Write to reconnect listeners
                var line = 'data: ' + JSON.stringify(data) + '\n\n';
                var arr = Array.from(stream.listeners);
                for (var i = 0; i < arr.length; i++) {
                    try { arr[i].write(line); } catch (_) { stream.listeners.delete(arr[i]); }
                }
            }
            // Always write to the original POST response
            try { 
                res.write('data: ' + JSON.stringify(data) + '\n\n'); 
                // Force flush to ensure immediate delivery for real-time streaming
                if (res.flush) res.flush();
            } catch (_) {}
        };

        try {
            // ── 0. Transform /skill-name invocations into normal prompts ──
            // Don't let the engine handle it as a slash command (internal injection).
            // Instead, rewrite so the model uses the Skill tool to read SKILL.md visibly.
            let message_rewritten = message;
            const skillSlashMatch = message.match(/^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/);
            if (skillSlashMatch) {
                const skillSlug = skillSlashMatch[1];
                const skillArgs = skillSlashMatch[2].trim();
                message_rewritten = skillArgs
                    ? `Use the ${skillSlug} skill to help me with: ${skillArgs}`
                    : `Use the ${skillSlug} skill.`;
                console.log('[Chat] Rewrote skill slash command:', message, '→', message_rewritten);
            }

            // ── 1. Handle attachments: copy to workspace, append references to prompt ──
            let finalPrompt = message_rewritten;
            const imageFileNames = []; // image files copied to workspace

            // Load conversation history for context (same as cluster mode)
            const conversationHistory = db.messages
                .filter(m => m.conversation_id === conversation_id)
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            
            console.log('[Chat] Loaded', conversationHistory.length, 'previous messages from conversation history');
            
            // Build context from conversation history (exclude the current message which will be added later)
            if (conversationHistory.length > 0) {
                console.log('[Chat] Conversation has', conversationHistory.length, 'messages, using last 10 for context');
                let historyContext = '# Conversation History\n\n';
                historyContext += 'The following is the previous conversation history. Please consider this context when responding:\n\n';
                
                // Show last 10 messages to avoid context overflow
                const recentMessages = conversationHistory.slice(-10);
                recentMessages.forEach((msg, idx) => {
                    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
                    // Parse content if it's JSON (from db storage)
                    let content = msg.content;
                    try {
                        const parsed = JSON.parse(msg.content);
                        if (Array.isArray(parsed) && parsed[0] && parsed[0].text) {
                            content = parsed[0].text;
                        }
                    } catch (_) {
                        // Keep original content if not JSON
                    }
                    historyContext += `## ${roleLabel} Message ${idx + 1}\n\n${content}\n\n---\n\n`;
                });
                
                historyContext += `\n# Current Request\n\nNow please respond to the user's latest message below, considering the conversation history above.\n\n`;
                
                // When resuming a session, the engine loads history from its session file
                // via --resume, so we don't need to include the full history in the prompt.
                // This prevents the session file from growing unboundedly.
                if (!conv.simona_session_id) {
                    finalPrompt = historyContext + message_rewritten;
                    console.log('[Chat] Full message length with history:', finalPrompt.length, 'chars');
                } else {
                    console.log('[Chat] Resuming session, incremental prompt (no history replay)');
                }
            } else {
                console.log('[Chat] This is the first message in the conversation');
            }

            if (attachments && attachments.length > 0) {
                const copiedFiles = [];
                for (const att of attachments) {
                    let srcPath = att.localPath;
                    
                    // Handle project files
                    if (!srcPath && att.source === 'project' && att.projectId && att.fileId) {
                        console.log('[Chat] Processing project file:', att.fileName, 'from project:', att.projectId);
                        const project = db.projects.find(p => p.id === att.projectId);
                        console.log('[Chat] Project found:', !!project);
                        if (project) {
                            const projectFile = db.project_files.find(f => f.id === att.fileId && f.project_id === att.projectId);
                            console.log('[Chat] ProjectFile found:', !!projectFile, 'file_path:', projectFile?.file_path, 'exists:', projectFile?.file_path ? fs.existsSync(projectFile.file_path) : 'N/A');
                            if (projectFile && projectFile.file_path && fs.existsSync(projectFile.file_path)) {
                                srcPath = projectFile.file_path;
                                console.log('[Chat] Found project file path:', srcPath);
                            }
                        }
                    }
                    
                    // Handle uploaded files
                    if (!srcPath && att.fileId) {
                        for (const dir of [path.join(workspacesDir, conversation_id, '.uploads'), path.join(workspacesDir, 'temp', '.uploads')]) {
                            if (srcPath) break;
                            if (fs.existsSync(dir)) {
                                const match = fs.readdirSync(dir).find(f => f === att.fileId || f.includes(att.fileId));
                                if (match) srcPath = path.join(dir, match);
                            }
                        }
                    }
                    if (srcPath && fs.existsSync(srcPath)) {
                        const fn = att.fileName || path.basename(srcPath);
                        try { fs.copyFileSync(srcPath, path.join(conv.workspace_path, fn)); copiedFiles.push(fn); } catch (_) {}

                        // Detect images → read base64 for proxy injection
                        const ext = path.extname(fn).toLowerCase();
                        if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
                            console.log('[Chat] Image copied to workspace:', fn);
                            imageFileNames.push(fn);
                            try {
                                const imgData = fs.readFileSync(srcPath);
                                if (imgData.length > 100) {
                                    const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
                                    if (!pendingImageBlocks.has(conversation_id)) pendingImageBlocks.set(conversation_id, []);
                                    pendingImageBlocks.get(conversation_id).push({
                                        type: 'image',
                                        source: { type: 'base64', media_type: mimeMap[ext] || 'image/png', data: imgData.toString('base64') }
                                    });
                                    console.log('[Chat] Image queued for proxy injection:', fn, imgData.length, 'bytes');
                                }
                            } catch (_) {}
                        }
                    }
                }
                if (copiedFiles.length > 0) {
                    // Images are injected directly into the API request via the proxy,
                    // but we also mention them here so the model knows they exist as files.
                    if (imageFileNames.length > 0) {
                        finalPrompt += '\n\n[The user attached image(s): ' + imageFileNames.join(', ') + '. The image(s) are included in this message — you can see them directly.]';
                        const nonImages = copiedFiles.filter(f => !imageFileNames.includes(f));
                        if (nonImages.length > 0) {
                            finalPrompt += '\n[Other attached files — read only when needed:]\n';
                            for (const fn of nonImages) finalPrompt += `- ./${fn}\n`;
                        }
                    } else {
                        finalPrompt += '\n\n[Attached files in workspace — read only when needed:]\n';
                        for (const fn of copiedFiles) finalPrompt += `- ./${fn}\n`;
                    }
                }
            }

            // ── 对话模式：自动执行Tavily网络搜索并注入结果 ──
            if (dialog_mode === 'chat' && message_rewritten && message_rewritten.length > 0) {
                try {
                    const searchQuery = message_rewritten.replace(/<[^>]+>/g, '').trim().slice(0, 300);
                    if (searchQuery.length > 5) {
                        console.log('[Chat] Searching Tavily for:', searchQuery.slice(0, 80));
                        const searchResult = await searchTavily(searchQuery, 6);
                        if (searchResult && searchResult.length > 0) {
                            const searchBlock = '\n\n<web_search_results>\n' + searchResult + '\n</web_search_results>';
                            finalPrompt += searchBlock;
                            console.log('[Chat] Injected ' + searchResult.length + ' chars of search results into prompt');
                        }
                    }
                } catch (searchErr) {
                    console.error('[Chat] Search error:', searchErr.message);
                }
            }

            // ── 2. Save user message ──
            db.messages.push({
                id: uuidv4(), conversation_id, role: 'user',
                content: JSON.stringify([{ type: 'text', text: message }]),
                created_at: new Date().toISOString(),
                attachments: attachments && attachments.length > 0 ? attachments.map(a => ({ fileId: a.fileId, fileName: a.fileName, fileType: a.fileType, mimeType: a.mimeType, size: a.size })) : undefined
            });
            saveDb();
            // 同步写会话 .jsonl 到工作区（供 git 追踪）
            try {
                const shortId = (conversation_id || '').split('-')[0] || conversation_id;
                const jsonlDir = path.join(conv.workspace_path, '.simona');
                try { if (!fs.existsSync(jsonlDir)) fs.mkdirSync(jsonlDir, { recursive: true }); } catch (_) {}
                const jsonlPath = path.join(jsonlDir, shortId + '.jsonl');
                const convMessages = db.messages.filter(m => m.conversation_id === conversation_id);
                const jsonlLines = convMessages.map(m => JSON.stringify(m));
                fs.writeFileSync(jsonlPath, jsonlLines.join('\n') + '\n', 'utf8');
            } catch (_) {}

            // ── 3. Build system prompt ──
            let sysPrompt = '【语言指令】你的思考过程（reasoning/thinking）和最终回复都必须使用用户输入的语言。用户用什么语言提问，你就用什么语言思考和回复，禁止混用英文进行内部推理。\n\n';
            
            // 对话模式：使用极简系统提示词，搜索结果已注入到用户消息中
            if (dialog_mode === 'chat') {
                sysPrompt += '你是一个AI助手，用户消息中可能包含网络搜索结果（放在<web_search_results>标签中）。如果存在搜索结果，直接基于这些结果回答用户问题。如果不存在搜索结果，基于你的知识回答。不要使用任何工具。';
                
                // 添加用户配置
                if (system_prompt && system_prompt.trim()) {
                    sysPrompt += '\n\n' + system_prompt.trim();
                }
                if (user_profile) {
                    const parts = [];
                    if (user_profile.work_function) parts.push('Occupation: ' + user_profile.work_function);
                    if (user_profile.personal_preferences) parts.push('User preferences: ' + user_profile.personal_preferences);
                    if (parts.length > 0) {
                        sysPrompt += '\n\n' + parts.join('\n');
                    }
                }
                console.log('[Chat] Dialog mode: search enabled, other tools restricted (' + sysPrompt.length + ' chars)');
            } else {
                // 智能体模式：完整系统提示词
                // Self-hosted users don't need anti-Kiro identity override (their providers are clean)
                const baseSysPrompt = (user_mode === 'selfhosted' ? customSystemPromptClean : customSystemPromptFull) || '';
                sysPrompt += baseSysPrompt;

                // Inject user-defined system prompt (e.g., word count limit)
                if (system_prompt && system_prompt.trim()) {
                    sysPrompt += '\n\n' + system_prompt.trim();
                    console.log('[Chat] User system prompt injected:', system_prompt.trim());
                }

                // Inject user profile preferences
                if (user_profile) {
                    const parts = [];
                    if (user_profile.work_function) parts.push('Occupation: ' + user_profile.work_function);
                    if (user_profile.personal_preferences) parts.push('User preferences: ' + user_profile.personal_preferences);
                    if (parts.length > 0) {
                        sysPrompt += '\n\n<user_profile>\n' + parts.join('\n') + '\n</user_profile>';
                    }
                }
            }
            
            // Inject enabled skills index into system prompt
            const skillsBlock = getEnabledSkillsBlock();
            if (skillsBlock) {
                sysPrompt += '\n\n' + skillsBlock;
            }

            // Project context (both modes)
            if (conv.project_id) {
                const project = db.projects.find(p => p.id === conv.project_id);
                if (project) {
                    if (project.instructions && project.instructions.trim()) sysPrompt += '\n\n<project_instructions>\n' + project.instructions.trim() + '\n</project_instructions>';
                    const pFiles = db.project_files.filter(f => f.project_id === project.id);
                    if (pFiles.length > 0) {
                        const withText = pFiles.filter(f => f.extracted_text);
                        const totalSz = withText.reduce((s, f) => s + (f.extracted_text ? f.extracted_text.length : 0), 0);
                        if (totalSz <= 80000 && withText.length > 0) {
                            let c = '\n\n<project_knowledge_base>\n';
                            for (const pf of withText) c += '\n--- ' + pf.file_name + ' ---\n' + pf.extracted_text + '\n';
                            sysPrompt += c + '</project_knowledge_base>';
                        } else {
                            let c = '\n\n<project_knowledge_base>\nFiles in workspace:\n';
                            for (const pf of pFiles) c += '- ' + pf.file_name + ' (' + Math.round((pf.file_size || 0) / 1024) + ' KB)\n';
                            sysPrompt += c + 'Read only when needed.\n</project_knowledge_base>';
                        }
                    }
                }
            }

            // Windows platform rules: prefer Write over Bash for file creation
            sysPrompt += '\n\n<platform_rules>\n';
            sysPrompt += 'Windows 系统规则：必须使用 Write 工具创建文件，禁止使用 Bash、python 或 heredoc 写文件。\n';
            sysPrompt += '- HTML/CSS/JS/Python/文本文件都用 Write 工具创建\n';
            sysPrompt += '- Bash 只用于：git、npm、目录操作、运行进程\n';
            sysPrompt += '- 禁止使用：cat > 文件、heredoc (<<)、python -c、python3 来创建文件\n';
            sysPrompt += `- 默认情况下，Write/Edit 工具使用相对于工作区的路径（工作区：${conv.workspace_path}），除非用户明确指定了绝对路径\n`;
            // Inject bundled Python path
            const pythonDir = path.join(__dirname, '..', 'python-3.13.2-embed-amd64');
            const pythonDir2 = process.resourcesPath ? path.join(process.resourcesPath, 'python-3.13.2-embed-amd64') : '';
            const resolvedPython = fs.existsSync(pythonDir) ? pythonDir : (fs.existsSync(pythonDir2) ? pythonDir2 : null);
            if (resolvedPython) {
                sysPrompt += `\n<python_config>\nPython 3.13.2 已内置，路径: ${path.join(resolvedPython, 'python.exe')}\n当需要使用 Python 时，请使用此路径。不要安装或使用其他 Python 版本。\n</python_config>\n`;
            }
            sysPrompt += '</platform_rules>\n';

            // Reiterate language instruction at end for reasoning models
            sysPrompt += '\n【语言指令重申】用户用什么语言，你的思考和回答就用什么语言，不要中英混合。\n';

            // ── 4. Resolve provider & launch Simona Code engine (unified for all messages) ──
            const rawModel = conv.model || 'simona-sonnet-4-6';
            const modelId = rawModel.replace(/-thinking$/, '');

            // Try provider system only for self-hosted users
            const provider = resolveProvider(modelId);
            let apiKey, baseUrl, apiFormat = 'simona';
            if (provider) {
                const useRemote = !!(jwtToken && provider && provider.id === 'deepseek-fixed-mode');
                apiKey = useRemote ? jwtToken : (provider.apiKey || env_token || '');
                baseUrl = useRemote ? REMOTE_SERVER : (provider.apiKey ? provider.baseUrl : (env_base_url || provider.baseUrl));
                apiFormat = useRemote ? 'openai' : (provider.format || 'simona');
                // Balance check already performed before SSE header setup
                console.log('[Chat] Provider:', provider.name, '| format:', apiFormat, '| model:', modelId, '| remote:', useRemote);
            } else {
                // Fallback: frontend token → engine env → process env (Clawparrot path)
                const validToken = (env_token && env_token !== 'self-hosted') ? env_token : '';
                apiKey = validToken || engineEnvVars.SIMONA_API_KEY || process.env.SIMONA_API_KEY;
                baseUrl = validToken ? (env_base_url || engineEnvVars.SIMONA_BASE_URL || process.env.SIMONA_BASE_URL) : (engineEnvVars.SIMONA_BASE_URL || env_base_url || process.env.SIMONA_BASE_URL);
                console.log('[Chat] Key source:', validToken ? 'user' : engineEnvVars.SIMONA_API_KEY ? 'engine-env' : 'process-env', '| baseUrl:', baseUrl);
            }

            // ═══ 会话独占密钥：sensenova 密钥池按会话分配，每个会话使用不同 key ═══
            // 先为该会话领取/复用自己的 key，之后标题生成、图片生成、代理转发全部沿用这把 key，
            // 避免多个会话抢用密钥池里的同一把 key。
            if (provider && provider.id === 'sensenova-free') {
                try {
                    const sessKey = await acquireSensenovaKey(conversation_id, modelId);
                    if (sessKey) { apiKey = sessKey; console.log('[Chat] Session-exclusive sensenova key bound to', String(conversation_id).slice(0, 8)); }
                } catch (ke) {
                    if (ke && ke.allExhausted) {
                        console.error('[Chat] Sensenova model exhausted:', ke.message);
                        sendSSE({ type: 'error', error: ke.message || '模型额度已耗尽，请切换模型' });
                        endStream(conversation_id);
                        return;
                    }
                    console.warn('[Chat] Sensenova session key acquire failed:', ke.message);
                }
            }

            // 如果是第一条消息，立即生成标题（不需要等待AI回复）
            const userMessages = db.messages.filter(m => m.conversation_id === conversation_id && m.role === 'user');
            if (userMessages.length === 1) {
                console.log('[Title] First message detected, generating title immediately...');
                if (modelId !== 'sensenova-u1-fast' && modelId !== 'sensenova-u1.5-lite') {
                    console.log('[Title DEBUG] jwtToken exists:', !!jwtToken, '| apiFormat:', apiFormat, '| baseUrl:', baseUrl);
                    generateTitleAsync(conversation_id, message.slice(0, 300), '', apiKey, baseUrl, conv.model, apiFormat);
                }
            }

            // ── Image generation (sensenova-u1-fast / sensenova-u1.5-lite) bypasses Simona Code engine ──
            const isU1Fast = modelId === 'sensenova-u1-fast';
            const isU15Lite = modelId === 'sensenova-u1.5-lite';
            if (isU1Fast || isU15Lite) {
                console.log('[Image] ' + modelId + ' detected, generating image via Sensenova API');
                let imagePrompt = message;
                const prevMsgs = db.messages.filter(m => m.conversation_id === conversation_id);
                const ctxParts = [];
                for (const hm of prevMsgs) {
                    if (hm.role === 'user') {
                        let t = typeof hm.content === 'string' ? hm.content : '';
                        if (t.startsWith('[')) { try { const p = JSON.parse(t); if (Array.isArray(p)) { const ts = p.filter(function(b) { return b.type === 'text' && b.text; }).map(function(b) { return b.text; }); if (ts.length > 0) t = ts.join(' '); } } catch (e) {} }
                        if (t.trim()) ctxParts.push(t.trim());
                    }
                }
                if (ctxParts.length > 1) imagePrompt = ctxParts.join('. ') + '. ' + imagePrompt;
                const apiBase = 'https://token.sensenova.cn/v1';
                let imgResp = null, lastErr = null;
                // 该会话专属 key（已在上方 acquireSensenovaKey 取得）；重试时换新 key 也只换本会话的
                let imageSessionKey = apiKey || (sensenovaProvider ? sensenovaProvider.apiKey : '');
                // 按池全部 key 数量动态重试（未来加 key 无需改动），至少 1 次、最多遍历整池
                const maxImgAttempts = Math.max(1, sensenovaPoolTotal || sensenovaKeys.length || 1);
                // ── 判断是否图生图（U1.5 Lite 拖入图片时走 /v1/images/edits） ──
                const hasAttachedImages = pendingImageBlocks.has(conversation_id) && pendingImageBlocks.get(conversation_id).length > 0;
                const useEditEndpoint = isU15Lite && hasAttachedImages;
                const endpoint = useEditEndpoint ? '/images/edits' : '/images/generations';
                for (let a = 0; a < maxImgAttempts; a++) {
                    try {
                        let reqBody;
                        if (useEditEndpoint) {
                            // U1.5 Lite 图生图（拖入图片）→ /v1/images/edits
                            const imgBlocks = pendingImageBlocks.get(conversation_id);
                            reqBody = {
                                model: 'sensenova-u1.5-lite',
                                images: imgBlocks.map(function(b) { return { image_url: 'data:' + b.source.media_type + ';base64,' + b.source.data }; }),
                                prompt: imagePrompt,
                                watermark: false,
                                size: 'auto',
                                response_format: 'url',
                                n: 1
                            };
                        } else if (isU15Lite) {
                            // U1.5 Lite 文生图 → /v1/images/generations
                            reqBody = {
                                model: 'sensenova-u1.5-lite',
                                prompt: imagePrompt,
                                watermark: false,
                                size: '1024x1024',
                                n: 1,
                                output_format: 'png',
                                response_format: 'url'
                            };
                        } else {
                            // U1 Fast 文生图 → /v1/images/generations
                            reqBody = {
                                model: 'sensenova-u1-fast',
                                prompt: imagePrompt,
                                watermark: false,
                                size: '2752x1536',
                                n: 1
                            };
                        }
                        imgResp = await fetch(apiBase + endpoint, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + imageSessionKey },
                            body: JSON.stringify(reqBody)
                        });
                        if (!imgResp.ok && (imgResp.status === 401 || imgResp.status === 429)) { try { imageSessionKey = await nextSensenovaKeyForConversation(conversation_id, modelId); } catch (ke) { lastErr = ke; break; } await new Promise(r => setTimeout(r, 500)); continue; }
                        break;
                    } catch (e) { lastErr = e; if (sensenovaProvider) { try { imageSessionKey = await nextSensenovaKeyForConversation(conversation_id, modelId); } catch (ke) { lastErr = ke; break; } await new Promise(r => setTimeout(r, 500)); continue; } break; }
                }
                // 清理 pendingImageBlocks（图生图已消费）
                if (useEditEndpoint) {
                    pendingImageBlocks.delete(conversation_id);
                }
                if (!imgResp || !imgResp.ok) {
                    const errText = imgResp ? await imgResp.text() : (lastErr ? lastErr.message : 'unknown');
                    sendSSE({ type: 'message_start', message: { id: uuidv4(), content: [] } });
                    sendSSE({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                    sendSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: '图像生成失败: ' + errText.slice(0, 200) } });
                    sendSSE({ type: 'content_block_stop', index: 0 });
                    sendSSE({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
                    setTimeout(() => endStream(conversation_id), 100);
                    return;
                }
                const imgData = await imgResp.json();
                let url = imgData.data && imgData.data[0] && imgData.data[0].url ? imgData.data[0].url : '';
                if (url) {
                    try {
                        const imgDownload = await fetch(url);
                        if (imgDownload.ok) {
                            const imgBuf = Buffer.from(await imgDownload.arrayBuffer());
                            const wsDir = conv.workspace_path || process.cwd();
                            const fileName = 'gen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.png';
                            const filePath = path.join(wsDir, fileName);
                            fs.writeFileSync(filePath, imgBuf);
                            console.log('[Image] Saved to workspace:', filePath);
                        }
                    } catch (e) { console.warn('[Image] Failed to save to workspace:', e.message); }
                }
                console.log('[Image] Display URL:', url);
                const md = url ? '![Generated Image](' + url + ')' : '图像生成失败，未返回图片链接';
                sendSSE({ type: 'message_start', message: { id: uuidv4(), content: [] } });
                sendSSE({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
                sendSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: md } });
                sendSSE({ type: 'content_block_stop', index: 0 });
                sendSSE({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } });
                db.messages.push({ id: uuidv4(), conversation_id, role: 'assistant', content: md, model: conv.model, created_at: new Date().toISOString() });
                saveDb();
                setTimeout(() => endStream(conversation_id), 100);
                return;
            }

            // ── All messages go through the Simona Code engine (no separate vision path) ──

            const cliArgs = [
                '--preload', enginePreload,
                '--env-file=' + engineEnv, engineCli,
                '-p',
                '--input-format', 'stream-json',
                '--output-format', 'stream-json',
                '--verbose',
                '--include-partial-messages',
                '--permission-prompt-tool', 'stdio',
                '--permission-mode', autoApprovePermissions ? 'bypassPermissions' : 'default',
                '--model', modelId,
            ];

            if (conv.simona_session_id) cliArgs.push('--resume', conv.simona_session_id);
            // Write system prompt to file to avoid ENAMETOOLONG on Windows
            // (project knowledge base can make the prompt very large)
            let sysPromptFile = null;
            if (sysPrompt) {
                sysPromptFile = path.join(os.tmpdir(), `simona-sys-prompt-${conversation_id}.tmp`);
                fs.writeFileSync(sysPromptFile, sysPrompt, 'utf8');
                cliArgs.push('--system-prompt-file', sysPromptFile);
            }
            // User prompt is injected via stdin as a stream-json user message
            // (--input-format stream-json above), so the engine's stdin input
            // stream stays OPEN — required for control_response (tool permission
            // approvals) to be read back. Writing it to a --prompt-file instead
            // would make inputPrompt a string, closing the input stream after the
            // first message and breaking the permission flow ("Stream closed").
            let userPromptInjected = false;
            const injectUserPrompt = function () {
                if (userPromptInjected || !finalPrompt) return;
                userPromptInjected = true;
                try {
                    const userMsg = JSON.stringify({
                        type: 'user',
                        session_id: '',
                        message: { role: 'user', content: finalPrompt },
                        parent_tool_use_id: null,
                    }) + '\n';
                    childRef.stdin.write(userMsg);
                    console.log('[Engine] Injected user prompt via stdin (' + userMsg.length + ' bytes)');
                } catch (err) {
                    console.log('[Engine] Failed to inject user prompt via stdin: ' + (err && err.message));
                }
            };

            const envVars = Object.assign({}, process.env);
            // Disable Bun global cache to force using local node_modules
            envVars.BUN_DISABLE_GLOBAL_CACHE = '1'; envVars.IS_SANDBOX = '1'; // Android runs as root — bypass root-user bypassPermissions check
            // Set NODE_PATH to ensure Bun can find local dependencies
            const engineDir = path.dirname(path.dirname(engineCli));
            envVars.NODE_PATH = path.join(engineDir, 'node_modules');
            if (apiFormat === 'openai' && proxyPort > 0) {
                // When using remote proxy, force model to valid DeepSeek ID
                let proxyModel = modelId;
                if (jwtToken && baseUrl && baseUrl.includes(REMOTE_SERVER)) {
                    if (proxyModel !== 'deepseek-v4-pro' && proxyModel !== 'deepseek-v4-flash') {
                        proxyModel = 'deepseek-v4-flash';
                        console.log('[Engine] Forced model to deepseek-v4-flash for remote proxy');
                    }
                }
                // OpenAI provider: route engine through local conversion proxy
                // 会话专属 target：同一会话整个流式过程稳定使用会话 key；并发会话各走各的 target，互不抢占
                const sessionTarget = { apiKey, baseUrl, model: proxyModel, format: 'openai', conversationId: conversation_id };
                proxyTarget = sessionTarget;
                proxyTargets.set(String(conversation_id), sessionTarget);
                // engine 用 proxy-key-<conversationId> 作为 x-api-key，让代理能识别请求属于哪个会话
                envVars.SIMONA_API_KEY = 'proxy-key-' + conversation_id;
                // FIX: Don't add /v1 suffix - Simona SDK will append /v1/messages automatically
                envVars.SIMONA_BASE_URL = 'http://127.0.0.1:' + proxyPort;
            } else {
                if (apiKey) envVars.SIMONA_API_KEY = apiKey;
                if (baseUrl) envVars.SIMONA_BASE_URL = normalizeBaseUrl(baseUrl);
            }

            const bunExe = bunExePath;

            console.log('[Engine] model=' + modelId + ' session=' + (conv.simona_session_id || 'new'));
            console.log('[Engine] workspace_path=' + conv.workspace_path);
            const { spawn } = require('child_process');
            // Pool: fingerprint everything that is frozen at spawn time. Any
            // change (model, permission mode, keys, workspace, system prompt)
            // yields a fresh process. sysPrompt/apiKey are hashed, not stored.
            const poolFingerprint = ENGINE_POOL_ENABLED ? enginePoolFingerprint([
                modelId,
                autoApprovePermissions ? 'bypassPermissions' : 'default',
                apiFormat, baseUrl || '', apiKey || '',
                conv.workspace_path, sysPrompt || '',
            ]) : null;
            let child = poolFingerprint ? poolTake(conversation_id, poolFingerprint) : null;
            if (child) {
                console.log('[Engine] Reusing pooled process PID', child.pid, 'for conversation', conversation_id);
                // Strip the previous turn's listeners; fresh ones attach below.
                child.stdout.removeAllListeners('data');
                child.stderr.removeAllListeners('data');
                child.removeAllListeners('close');
                child.removeAllListeners('error');
            } else {
                child = spawn(bunExe, cliArgs, {
                    cwd: conv.workspace_path, env: envVars,
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            }
            // Keep stdin open for control_response (AskUserQuestion)
            // Store child ref so the answer endpoint can write to it
            const childRef = child;
            activeChildren.set(conversation_id, childRef);

            // ── 5. Parse stream-json and forward to frontend ──
            let assistantText = '';
            let thinkingText = '';
            let lastToolDoneTextLen = 0; // text length when last tool result arrives
            let pendingWorkText = ''; // text accumulated since last tool event (for interleaving)
            const toolCallOrder = []; // ordered list of tool IDs for timeline reconstruction
            const toolCalls = new Map();
            const sentToolStarts = new Set(); // track which tool_use_start we already sent
            const writtenFiles = new Map(); // deduplicate Write tool results by file path
            const searchLogs = []; // collect WebSearch results for persistence
            let sessionId = conv.simona_session_id;
            let buf = '';
            let resultKillTimeout = null;
            let turnResolve = null; // set by the close-promise executor; result may resolve the turn early (pool path)
            let sawResult = false; // result 成功事件已收到（区别于引擎崩溃，用于 close 时避免误报）

            // Tools that are internal to Simona Code and should not be shown to the user
            const HIDDEN_TOOLS = new Set(['EnterWorktree', 'ExitWorktree', 'TodoWrite', 'WebSearch', 'WebFetch']);

            // Ensure tool_use_start is sent before tool_use_done — if the 'assistant' event was
            // missing or arrived out of order, we back-fill it from the toolCalls map
            function ensureToolStartSent(toolUseId) {
                if (sentToolStarts.has(toolUseId)) return;
                var tc = toolCalls.get(toolUseId);
                if (!tc || HIDDEN_TOOLS.has(tc.name)) return;
                sentToolStarts.add(toolUseId);
                sendSSE({ type: 'tool_use_start', tool_use_id: tc.id, tool_name: tc.name, tool_input: tc.input || {} });
            }

            child.stdout.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                const lines = buf.split('\n');
                buf = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    var evt;
                    try { evt = JSON.parse(line); } catch { continue; }

                    if (evt.session_id && !sessionId) {
                        sessionId = evt.session_id;
                        conv.simona_session_id = sessionId;
                        saveDb();
                    }

                    // Debug: log all event types to understand WebSearch flow
                    if (evt.type !== 'stream_event') {
                        console.log('[Engine-evt]', evt.type, evt.subtype || '', evt.tool_use_id ? 'tool_id=' + evt.tool_use_id : '', typeof evt.content === 'string' ? evt.content.slice(0, 100) : '');
                    }

                    if (evt.type === 'stream_event' && evt.event) {
                        var se = evt.event;
                        // Forward text and thinking deltas
                        if (se.type === 'content_block_delta') {
                            if (se.delta && se.delta.type === 'text_delta') {
                                assistantText += se.delta.text;
                                pendingWorkText += se.delta.text;
                                sendSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: se.delta.text } });
                            } else if (se.delta && se.delta.type === 'thinking_delta') {
                                thinkingText += se.delta.thinking;
                                sendSSE({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: se.delta.thinking } });
                            }
                        }
                        // Track tool_use start from stream (don't send yet — wait for full input from assistant event)
                        else if (se.type === 'content_block_start' && se.content_block && se.content_block.type === 'tool_use') {
                            var tu = se.content_block;
                            // Capture text that appeared before this tool call
                            toolCalls.set(tu.id, { id: tu.id, name: tu.name, input: {}, status: 'running', textBefore: pendingWorkText.trim() });
                            toolCallOrder.push(tu.id);
                            pendingWorkText = '';
                            // Don't send tool_use_start here — input is empty. Wait for 'assistant' event with full input.
                        }
                    }
                    // Complete assistant message — has full tool input
                    else if (evt.type === 'assistant' && evt.message && evt.message.content) {
                        for (var block of evt.message.content) {
                            if (block.type === 'tool_use') {
                                var tc = toolCalls.get(block.id);
                                if (tc) {
                                    tc.input = block.input;
                                } else {
                                    // Tool not seen via content_block_start — register now with pending text
                                    tc = { id: block.id, name: block.name, input: block.input, status: 'running', textBefore: pendingWorkText.trim() };
                                    toolCalls.set(block.id, tc);
                                    toolCallOrder.push(block.id);
                                    pendingWorkText = '';
                                }
                                // WebSearch: emit status event instead of tool_use_start
                                if (block.name === 'WebSearch' && !sentToolStarts.has(block.id)) {
                                    sentToolStarts.add(block.id);
                                    var searchQuery = (block.input && block.input.query) || 'the web';
                                    sendSSE({ type: 'status', message: 'Searching: ' + searchQuery });
                                    console.log('[WebSearch] Started, query:', searchQuery, 'id:', block.id);
                                }
                                // WebFetch: also emit status
                                else if (block.name === 'WebFetch' && !sentToolStarts.has(block.id)) {
                                    sentToolStarts.add(block.id);
                                    var fetchUrl = (block.input && block.input.url) || '';
                                    sendSSE({ type: 'status', message: 'Fetching: ' + fetchUrl });
                                    console.log('[WebFetch] Started, url:', fetchUrl);
                                }
                                // Send tool_use_start with full input (only once per tool)
                                else if (!sentToolStarts.has(block.id) && !HIDDEN_TOOLS.has(block.name)) {
                                    sentToolStarts.add(block.id);
                                    sendSSE({ type: 'tool_use_start', tool_use_id: block.id, tool_name: block.name, tool_input: block.input });
                                    console.log('[Tool]', block.name, JSON.stringify(block.input || {}).slice(0, 120));
                                }
                            }
                        }
                    }
                    // User message with tool_use_result (WebSearch results come through here)
                    else if (evt.type === 'user' && evt.message && evt.message.content) {
                        var userContent = evt.message.content;
                        var contentArr = Array.isArray(userContent) ? userContent : [];
                        for (var ci = 0; ci < contentArr.length; ci++) {
                            var cb = contentArr[ci];
                            if (cb.type === 'tool_result' && cb.tool_use_id) {
                                var tc3 = toolCalls.get(cb.tool_use_id);
                                var tn = tc3 ? tc3.name : '';
                                // Extract text from tool_result content
                                var trText = '';
                                if (typeof cb.content === 'string') trText = cb.content;
                                else if (Array.isArray(cb.content)) trText = cb.content.map(function(x) { return x.text || ''; }).join('');
                                // ═══ Browser tool errors are handled by [Proxy-Browser] in the proxy path ═══
                                // The [Proxy-Browser] interceptor (line ~648) executes browser tools and replaces
                                // the error before messages reach the API. This bridge path must NOT re-execute
                                // browser tools to avoid double execution (page refresh loop).
                                // Simply let the error pass through — [Proxy-Browser] already handled it.
                                if (tn && tn.startsWith('browser_') && trText.includes('No such tool available')) {
                                    console.log('[Browser-Bridge] Skipping browser tool execution (handled by Proxy-Browser):', tn);
                                    // Let the error pass through to the normal sendSSE below
                                }
                                if (tc3) { tc3.status = cb.is_error ? 'error' : 'done'; tc3.result = trText; }
                                // Record text offset after each tool completes — used to split work text vs final text
                                lastToolDoneTextLen = assistantText.length;

                                // WebSearch: parse result text and emit search_sources
                                if (tn === 'WebSearch' && trText) {
                                    console.log('[WebSearch] Result from user event:', trText.slice(0, 300));
                                    try {
                                        // Format: "Web search results for query: "..."\n\nLinks: [{...},...]\n\nContent:..."
                                        var wsQuery = '';
                                        var qMatch = trText.match(/query:\s*"([^"]+)"/);
                                        if (qMatch) wsQuery = qMatch[1];
                                        var wsSources = [];
                                        var linksMatch = trText.match(/Links:\s*(\[[\s\S]*?\])\s*\n/);
                                        if (linksMatch) {
                                            try {
                                                var links = JSON.parse(linksMatch[1]);
                                                if (Array.isArray(links)) {
                                                    wsSources = links.filter(function(l) { return l.url; }).map(function(l) { return { url: l.url, title: l.title || '' }; });
                                                }
                                            } catch (_) {}
                                        }
                                        if (wsSources.length > 0 && wsQuery) {
                                            sendSSE({ type: 'search_sources', sources: wsSources, query: wsQuery });
                                            searchLogs.push({ query: wsQuery, results: wsSources });
                                            console.log('[WebSearch] Emitted', wsSources.length, 'sources for:', wsQuery);
                                        }
                                    } catch (_) {}
                                }

                                // Don't send tool_use_done for hidden tools
                                if (!HIDDEN_TOOLS.has(tn)) {
                                    ensureToolStartSent(cb.tool_use_id);
                                    sendSSE({ type: 'tool_use_done', tool_use_id: cb.tool_use_id, content: trText.slice(0, 50000), is_error: cb.is_error || false });
                                }
                            }
                        }
                    }
                    // Tool result (legacy path)
                    else if (evt.type === 'tool') {
                        var resultText = typeof evt.content === 'string' ? evt.content
                            : Array.isArray(evt.content) ? evt.content.map(function(b) { return b.text || ''; }).join('') : '';
                        var tc2 = toolCalls.get(evt.tool_use_id);
                        var toolName = tc2 ? tc2.name : '';
                        if (tc2) { tc2.status = evt.is_error ? 'error' : 'done'; tc2.result = resultText; }

                        // WebSearch result (legacy tool path): parse text format
                        if (toolName === 'WebSearch' && resultText) {
                            try {
                                var qm2 = resultText.match(/query:\s*"([^"]+)"/);
                                var lm2 = resultText.match(/Links:\s*(\[[\s\S]*?\])\s*\n/);
                                if (qm2 && lm2) {
                                    var links2 = JSON.parse(lm2[1]);
                                    var sources = links2.filter(function(l) { return l.url; }).map(function(l) { return { url: l.url, title: l.title || '' }; });
                                    if (sources.length > 0) {
                                        sendSSE({ type: 'search_sources', sources: sources, query: qm2[1] });
                                    }
                                }
                            } catch (_) {}
                        }

                        // Deduplicate Write tool: only keep last version per file path
                        if (toolName === 'Write' && tc2 && tc2.input && tc2.input.file_path) {
                            var prevId = writtenFiles.get(tc2.input.file_path);
                            if (prevId) {
                                // Remove previous Write for same file from toolCalls
                                toolCalls.delete(prevId);
                            }
                            writtenFiles.set(tc2.input.file_path, evt.tool_use_id);
                        }

                        // Don't send results for hidden/internal tools
                        if (!HIDDEN_TOOLS.has(toolName)) {
                            ensureToolStartSent(evt.tool_use_id);
                            sendSSE({ type: 'tool_use_done', tool_use_id: evt.tool_use_id, content: resultText.slice(0, 50000), is_error: evt.is_error || false });
                        }
                    }
                    // Final result
                    else if (evt.type === 'result') {
                        if (!assistantText && evt.result) {
                            assistantText = typeof evt.result === 'string' ? evt.result : '';
                        }
                        // 任务已完整成功（区别于引擎崩溃）——close 时据此避免误报
                        sawResult = true;
                        // 内容已完整输出 → 立即结束前端 SSE 流，消除"输出后停滞 5 秒"的体感
                        endStream(conversation_id);
                        // Pool: keep the engine process alive for the next message in
                        // this conversation instead of end_session + kill. The process
                        // idles on stdin; poolTake() reuses it on the next /chat request.
                        let pooled = false;
                        if (poolFingerprint) {
                            pooled = poolRelease(conversation_id, childRef, poolFingerprint);
                            if (pooled) {
                                console.log('[Engine] Returned process PID', child.pid, 'to pool for conversation', conversation_id);
                                // Do NOT delete sysPromptFile here — the engine re-reads
                                // --system-prompt-file on each turn in stream-json mode.
                                // It gets cleaned up in the close handler when the process
                                // eventually exits (TTL/eviction/conversation delete).
                                if (resultKillTimeout) { clearTimeout(resultKillTimeout); resultKillTimeout = null; }
                                if (turnResolve) { const r = turnResolve; turnResolve = null; r(); }
                            }
                        }
                        if (!pooled) {
                        // Engine emitted result — 引擎以 stream-json 模式运行，stdin 一直保持
                        // 打开（用于 control_response），structuredIO 只有在 stdin EOF 时才会
                        // inputClosed=true。因此这里主动发送 end_session control_request 并
                        // 关闭 stdin（EOF 双保险），让引擎走正常退出路径
                        // （print.ts 2849 -> break -> inputClosed=true -> gracefulShutdownSync(0)
                        //  -> exit code 0），而不是 5 秒后 taskkill /F 强杀成 code 1。
                        try {
                            if (childRef && childRef.stdin && !childRef.stdin.destroyed) {
                                childRef.stdin.write(JSON.stringify({
                                    type: 'control_request',
                                    request_id: 'bridge-end-' + Date.now() + '-' + conversation_id,
                                    request: { subtype: 'end_session', reason: 'done' },
                                }) + '\n');
                                childRef.stdin.end();
                            }
                        } catch (_) {}
                        // 兜底：引擎仍不退出（如被浏览器进程/simona-mem hooks 挂起）则 3 秒后强杀；
                        // 因 sawResult=true，close 时不会误报"Engine exited unexpectedly"
                        if (resultKillTimeout) clearTimeout(resultKillTimeout);
                        resultKillTimeout = setTimeout(function() {
                            console.log('[Engine] Process did not exit 3s after end_session, killing PID', child.pid);
                            try { killProcessTree(child.pid); } catch(_) {}
                            activeChildren.delete(conversation_id);
                        }, 3000);
                        }
                    }
                    // AskUserQuestion — engine needs user input via control_request
                    else if (evt.type === 'control_request' && evt.request) {
                        var req2 = evt.request;
                        if (req2.subtype === 'can_use_tool' && req2.tool_name === 'AskUserQuestion') {
                            console.log('[AskUser] control_request id=' + evt.request_id);
                            // Stash the original input so /answer can merge user answers into updatedInput
                            askUserPendingInputs.set(conversation_id, req2.input || {});
                            sendSSE({
                                type: 'ask_user',
                                request_id: evt.request_id,
                                tool_use_id: req2.tool_use_id,
                                questions: (req2.input && req2.input.questions) || [],
                            });
                        } else {
                            // Tool permission request — auto-approve if enabled, otherwise ask the user via frontend
                            if (autoApprovePermissions) {
                                var autoResponse = JSON.stringify({
                                    type: 'control_response',
                                    response: { subtype: 'success', request_id: evt.request_id, response: { toolUseID: req2.tool_use_id, behavior: 'allow', updatedInput: req2.input || {} } }
                                }) + '\n';
                                try { childRef.stdin.write(autoResponse); } catch (_) {}
                            } else {
                                pendingPermissionRequests.set(evt.request_id, { child: childRef, tool_use_id: req2.tool_use_id, input: req2.input || {}, tool_name: req2.tool_name || '' });
                                sendSSE({
                                    type: 'permission_request',
                                    request_id: evt.request_id,
                                    tool_use_id: req2.tool_use_id,
                                    tool_name: req2.tool_name || 'Unknown tool',
                                    tool_input: req2.input || {},
                                });
                            }
                        }
                    }
                    // Task/Agent progress events
                    else if (evt.type === 'system' && (evt.subtype === 'task_started' || evt.subtype === 'task_progress' || evt.subtype === 'task_notification')) {
                        sendSSE({ type: 'task_event', subtype: evt.subtype, task_id: evt.task_id, description: evt.description, status: evt.status, summary: evt.summary, usage: evt.usage, last_tool_name: evt.last_tool_name });
                    }
                    // Auto-compact boundary — engine compacted context mid-conversation
                    else if (evt.type === 'system' && evt.subtype === 'compact_boundary') {
                        var meta = evt.compact_metadata || {};
                        console.log('[AutoCompact] Engine auto-compacted context, pre_tokens=' + (meta.pre_tokens || '?'));
                        sendSSE({ type: 'compact_boundary', compact_metadata: meta });
                        // Append a compact boundary marker — keep old messages for UI display
                        db.messages.push({
                            id: uuidv4(), conversation_id: conversation_id, role: 'system',
                            content: JSON.stringify([{ type: 'text', text: 'Context auto-compacted by engine.' }]),
                            created_at: new Date().toISOString(), is_compact_boundary: true,
                        });
                        saveDb();
                    }
                }
            });

            let stderrBuf = '';
            child.stderr.on('data', function(c) { stderrBuf += c.toString('utf8'); });

            // Inject user prompt AFTER all stdout/stderr listeners are registered.
            // For pooled processes, writing to stdin causes immediate output —
            // if the stdout listener isn't attached yet, early chunks are lost.
            if (typeof injectUserPrompt === 'function') {
                injectUserPrompt();
            }

            await new Promise(function(resolve, reject) {
                turnResolve = resolve;
                child.on('close', function(code) {
                    if (resultKillTimeout) { clearTimeout(resultKillTimeout); resultKillTimeout = null; }
                    // If the process was pooled, the pool entry was already removed
                    // by poolTake/poolKill; only delete activeChildren here for
                    // non-pooled (fresh spawn) exits to avoid wiping a re-pooled entry.
                    if (!enginePool.has(conversation_id)) {
                        activeChildren.delete(conversation_id);
                    }
                    // sysPromptFile cleanup is handled by poolKill (conversation delete/reset)
                    // and the non-pooled end_session path. Do NOT unlink here — when poolTake
                    // kills a stale process (fingerprint mismatch), this close handler runs
                    // asynchronously and would delete the sysPromptFile that the NEW message
                    // just wrote to the same path (path is keyed by conversation_id).
                    // Process remaining buffer
                    if (buf.trim()) {
                        try {
                            var lastEvt = JSON.parse(buf);
                            if (lastEvt.type === 'stream_event' && lastEvt.event && lastEvt.event.delta && lastEvt.event.delta.type === 'text_delta') {
                                assistantText += lastEvt.event.delta.text;
                                sendSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: lastEvt.event.delta.text } });
                            } else if (!assistantText && lastEvt.result) {
                                assistantText = typeof lastEvt.result === 'string' ? lastEvt.result : '';
                            }
                        } catch(x) {}
                    }
                    if (code !== 0) {
                        console.error('[Engine] Exited with code', code, '| stderr:', stderrBuf.slice(0, 500));
                        if (sawResult) {
                            // 任务已成功完成（result 已收到）——即使进程退出码非 0（例如被兜底
                            // taskkill 清理）也不属于引擎崩溃，不向前端误报错误
                            console.warn('[Engine] Task succeeded (result received), ignoring exit code', code);
                            resolve();
                        } else if (!assistantText) {
                            reject(new Error(stderrBuf || 'Engine exit ' + code));
                        } else {
                            // Engine failed mid-response — show the error after partial text
                            sendSSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: '\n\n⚠️ Engine exited unexpectedly (code ' + code + '). The response may be incomplete.' } });
                            resolve();
                        }
                    } else {
                        resolve();
                    }
                });
                child.on('error', function(err) { activeChildren.delete(conversation_id); reject(err); });
            });

            // ── 6. Save results ──
            if (assistantText || thinkingText || toolCalls.size > 0) {
                db.messages.push({
                    id: uuidv4(), conversation_id, role: 'assistant',
                    content: JSON.stringify([{ type: 'text', text: assistantText }]),
                    created_at: new Date().toISOString(),
                    thinking: thinkingText || undefined,
                    toolCalls: toolCalls.size > 0 ? toolCallOrder.map(id => toolCalls.get(id)).filter(Boolean) : undefined,
                    toolTextEndOffset: (toolCalls.size > 0 && lastToolDoneTextLen > 0) ? lastToolDoneTextLen : undefined,
                    searchLogs: searchLogs.length > 0 ? searchLogs : undefined,
                });
                saveDb();
                // 写会话 .jsonl 到工作区 + 收集工具文件路径 → git 检查点
                try {
                    const shortId = (conversation_id || '').split('-')[0] || conversation_id;
                    const jsonlDir = path.join(conv.workspace_path, '.simona');
                    try { if (!fs.existsSync(jsonlDir)) fs.mkdirSync(jsonlDir, { recursive: true }); } catch (_) {}
                    const jsonlPath = path.join(jsonlDir, shortId + '.jsonl');
                    const convMessages = db.messages.filter(m => m.conversation_id === conversation_id);
                    const jsonlLines = convMessages.map(m => JSON.stringify(m));
                    fs.writeFileSync(jsonlPath, jsonlLines.join('\n') + '\n', 'utf8');
                    const toolFilePaths = toolCalls.size > 0 ? Array.from(toolCalls.values()).filter(tc => (tc.name === 'Write' || tc.name === 'Edit') && tc.input && tc.input.file_path).map(tc => tc.input.file_path) : [];
                    const commitHash = await createConvCheckpoint(conv.workspace_path, conversation_id, toolFilePaths);
                    if (commitHash) {
                        const msgCount = db.messages.filter(m => m.conversation_id === conversation_id && m.role === 'assistant').length;
                        const tagName = 'msg_' + msgCount;
                        await createConvTag(conv.workspace_path, conversation_id, tagName);
                        const lastMsg = db.messages[db.messages.length - 1];
                        lastMsg.git_tag = tagName;
                        saveDb();
                    }
                } catch (_) {}
                generateTitleAsync(conversation_id, message.slice(0, 300), assistantText.slice(0, 300), apiKey, baseUrl, conv.model, apiFormat);
                // Track token usage for auto-compaction
                const responseTokens = Math.ceil((assistantText.length + (thinkingText || '').length) / 4);
                const prevUsage = conversationUsage.get(conversation_id) || { inputTokens: 0, outputTokens: 0 };
                conversationUsage.set(conversation_id, {
                    inputTokens: (prevUsage.inputTokens || 0) + responseTokens,
                    outputTokens: (prevUsage.outputTokens || 0) + responseTokens,
                });
            }

            // Send the text offset so frontend knows where work text ends and final text begins
            if (toolCalls.size > 0 && lastToolDoneTextLen > 0) {
                sendSSE({ type: 'tool_text_offset', offset: lastToolDoneTextLen });
            }
            // Clean up pending images for this conversation
            pendingImageBlocks.delete(conversation_id);
            sendSSE({ type: 'message_stop' });
            endStream(conversation_id);
            // -- Auto-compaction check (uses conversationUsage) --
            if (conv && conv.simona_session_id) {
                const usage = conversationUsage.get(conversation_id);
                const totalTokens = (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
                if (totalTokens >= 1000000) {
                    console.log('[AutoCompact] Token threshold reached (' + totalTokens + ' >= 1000000), auto-compacting...');
                    compactConversation(conversation_id, { apiKey: apiKey, baseUrl: baseUrl }).catch(err => {
                        console.error('[AutoCompact] Error:', err.message);
                    });
                }
            }
        } catch (err) {
            pendingImageBlocks.delete(conversation_id);
            console.error('[Chat] Error:', (err.message || '').slice(0, 300));
            sendSSE({ type: 'error', error: err.message || 'Engine error' });
            endStream(conversation_id);
        }
    });

    // ==================== Agent Cluster Engine Spawner ====================
    // Spawn a real Simona Code engine process for a single agent
    async function spawnAgentEngine(agentConfig, message, conversationId, sendSSE, workspacePath, context) {
        try {
            console.log('[Cluster-Engine] Spawning engine for agent:', agentConfig.name, 'model:', agentConfig.modelId);
            
            return new Promise(async (resolve, reject) => {
                
                // Extract context variables
                const { user_mode, env_token, env_base_url, engineEnvVars, system_prompt, user_profile, proxyPort, bunExePath, enginePreload, engineEnv, engineCli, normalizeBaseUrl, resolveProvider, agent_mode_enabled } = context;
                console.log('[Cluster-Engine-DEBUG] proxyPort:', proxyPort, '| jwtToken exists:', !!jwtToken, '| REMOTE_SERVER:', REMOTE_SERVER);
                
                // Resolve provider and API credentials
                const rawModel = agentConfig.modelId.replace(/-thinking$/, '');
                const provider = resolveProvider(rawModel);
                console.log('[Cluster-Engine-DEBUG] provider:', provider ? provider.id + '/' + provider.name : 'null', '| rawModel:', rawModel);
                let apiKey, baseUrl, apiFormat = 'simona';
                
                if (provider) {
                    const useRemote = !!(jwtToken && provider && provider.id === 'deepseek-fixed-mode');
                    apiKey = useRemote ? jwtToken : (provider.apiKey || env_token || '');
                    baseUrl = useRemote ? REMOTE_SERVER : (provider.apiKey ? provider.baseUrl : (env_base_url || provider.baseUrl));
                    apiFormat = useRemote ? 'openai' : (provider.format || 'simona');
                    console.log('[Cluster-Engine] Provider:', provider.name, '| format:', apiFormat, '| remote:', useRemote);
                    console.log('[Cluster-Engine-DEBUG] useRemote:', useRemote, '| apiKey length:', apiKey ? apiKey.length : 0, '| baseUrl:', baseUrl, '| apiFormat:', apiFormat);
                } else {
                    const validToken = (env_token && env_token !== 'self-hosted') ? env_token : '';
                    apiKey = validToken || engineEnvVars.SIMONA_API_KEY || process.env.SIMONA_API_KEY;
                    baseUrl = validToken ? (env_base_url || engineEnvVars.SIMONA_BASE_URL || process.env.SIMONA_BASE_URL)
                                        : (engineEnvVars.SIMONA_BASE_URL || env_base_url || process.env.SIMONA_BASE_URL);
                }

                // ═══ 会话独占密钥：sensenova 密钥池按会话分配，每个会话/agent 使用不同 key ═══
                if (provider && provider.id === 'sensenova-free') {
                    try {
                        const sessKey = await acquireSensenovaKey(conversationId, rawModel);
                        if (sessKey) { apiKey = sessKey; console.log('[Cluster-Engine] Session-exclusive sensenova key bound to', String(conversationId).slice(0, 8)); }
                    } catch (ke) {
                        console.warn('[Cluster-Engine] Sensenova session key acquire failed:', ke.message);
                    }
                }
                
                // Build system prompt
                let sysPrompt = system_prompt || '';
                if (agentConfig.systemPrompt) {
                    sysPrompt = agentConfig.systemPrompt + '\n\n' + sysPrompt;
                }
                if (user_profile) {
                    const parts = [];
                    if (user_profile.user_name) parts.push('User name: ' + user_profile.user_name);
                    if (user_profile.personal_preferences) parts.push('User preferences: ' + user_profile.personal_preferences);
                    if (parts.length > 0) {
                        sysPrompt += '\n\n<user_profile>\n' + parts.join('\n') + '\n</user_profile>';
                    }
                }
                
                // Inject agent mode instructions
                if (agent_mode_enabled === false) {
                    sysPrompt += '\n\n<agent_mode>DISABLED</agent_mode>\n';
                    sysPrompt += 'IMPORTANT: Agent mode is DISABLED. You MUST NOT use any tools EXCEPT WebSearch.\n';
                    sysPrompt += '- Do NOT use Read, Write, Bash, or any other file/system tools.\n';
                    sysPrompt += '- You MAY use WebSearch to search the web for information.\n';
                    sysPrompt += '- Answer questions directly using your knowledge without tool calls.\n';
                    console.log('[Cluster-Engine] Agent mode DISABLED for agent:', agentConfig.name);
                }
                
                // Windows compatibility: prefer Write tool over Bash for file creation
                // Bash heredocs and quoting cause issues on Windows (python3 resolves wrong path, etc.)
                sysPrompt += '\n\n<platform_rules>\n';
                sysPrompt += 'CRITICAL: Windows system. ALWAYS use the Write tool to create files. NEVER use Bash, python, or heredocs to write files.\n';
                sysPrompt += '- Create HTML/CSS/JS/Python/text files with the Write tool\n';
                sysPrompt += '- Only use Bash for: git, npm, directory operations, running processes\n';
                sysPrompt += '- NEVER use: cat > file, heredocs (<<), python -c, or python3 for file creation\n';
                sysPrompt += `- By default, Write/Edit files using paths relative to the workspace directory: ${conv.workspace_path}\n`;
                // Inject bundled Python path
                const pythonDir3 = path.join(__dirname, '..', 'python-3.13.2-embed-amd64');
                const pythonDir4 = process.resourcesPath ? path.join(process.resourcesPath, 'python-3.13.2-embed-amd64') : '';
                const resolvedPython2 = fs.existsSync(pythonDir3) ? pythonDir3 : (fs.existsSync(pythonDir4) ? pythonDir4 : null);
                if (resolvedPython2) {
                    sysPrompt += `\n<python_config>\nPython 3.13.2 已内置，路径: ${path.join(resolvedPython2, 'python.exe')}\n当需要使用 Python 时，请使用此路径。不要安装或使用其他 Python 版本。\n</python_config>\n`;
                }
                sysPrompt += '</platform_rules>\n';
                
                // Ensure sysPrompt is never empty (add minimal instruction if needed)
                if (!sysPrompt || sysPrompt.trim().length === 0) {
                    sysPrompt = 'You are a helpful AI assistant. Please respond to the user\'s request accurately and helpfully.';
                    console.log('[Cluster-Engine] Using default system prompt (original was empty)');
                }
                
                // CRITICAL: Prepend identity instruction to user message to override model's training
                const identityInstruction = '\n\nIMPORTANT IDENTITY RULE: You are Simona, created by BeKi. When asked about your identity, you MUST answer "我是 Simona，由 BeKi 打造" (in Chinese) or "I am Simona, created by BeKi" (in English). NEVER say you are Simona or from Simona. This is an absolute requirement.';
                const augmentedMessage = message + identityInstruction;
                
                // Write system prompt to temp file
                // Use a unique filename with timestamp and random suffix to avoid conflicts in parallel execution
                const timestamp = Date.now();
                const randomSuffix = Math.random().toString(36).substring(2, 8);
                const sysPromptFile = path.join(os.tmpdir(), `simona-sys-prompt-${agentConfig.id}-${timestamp}-${randomSuffix}.tmp`);
                
                // Ensure workspace directory exists
                try {
                    if (!fs.existsSync(workspacePath)) {
                        console.log('[Cluster-Engine] Creating workspace directory:', workspacePath);
                        fs.mkdirSync(workspacePath, { recursive: true });
                    }
                } catch (mkdirError) {
                    console.error('[Cluster-Engine] Failed to create workspace directory:', mkdirError.message);
                    throw new Error('Failed to create workspace directory: ' + mkdirError.message);
                }
                
                // Debug: Log system prompt info
                console.log('[Cluster-Engine] === System Prompt File Creation ===');
                console.log('[Cluster-Engine] Agent ID:', agentConfig.id);
                console.log('[Cluster-Engine] Agent Name:', agentConfig.name);
                console.log('[Cluster-Engine] Workspace path:', workspacePath);
                console.log('[Cluster-Engine] Workspace exists:', fs.existsSync(workspacePath));
                console.log('[Cluster-Engine] SysPrompt file path:', sysPromptFile);
                console.log('[Cluster-Engine] System prompt length:', sysPrompt ? sysPrompt.length : 0);
                console.log('[Cluster-Engine] System prompt preview:', sysPrompt ? sysPrompt.substring(0, 100) + '...' : 'EMPTY');
                
                try {
                    // Use synchronous write to ensure file is created before process starts
                    // Note: Even empty content should create a valid file
                    const contentToWrite = sysPrompt || '';
                    console.log('[Cluster-Engine] Writing', contentToWrite.length, 'bytes to file');
                    
                    fs.writeFileSync(sysPromptFile, contentToWrite, 'utf8');
                    
                    // Small delay to ensure filesystem sync (especially on Windows)
                    await new Promise(resolve => setTimeout(resolve, 50));
                    
                    // Verify file was created
                    if (fs.existsSync(sysPromptFile)) {
                        const stats = fs.statSync(sysPromptFile);
                        console.log('[Cluster-Engine] ✅ System prompt file created successfully');
                        console.log('[Cluster-Engine] File size:', stats.size, 'bytes');
                        console.log('[Cluster-Engine] File path verified:', sysPromptFile);
                    } else {
                        console.error('[Cluster-Engine] ❌ File does not exist after write!');
                        console.error('[Cluster-Engine] Attempted path:', sysPromptFile);
                        console.error('[Cluster-Engine] Directory exists:', fs.existsSync(path.dirname(sysPromptFile)));
                        
                        // Try to list directory contents for debugging
                        try {
                            const dirContents = fs.readdirSync(path.dirname(sysPromptFile));
                            console.error('[Cluster-Engine] Directory contents:', dirContents.filter(f => f.includes('.sys-prompt')));
                        } catch (e) {
                            console.error('[Cluster-Engine] Cannot list directory:', e.message);
                        }
                        
                        throw new Error('File was written but does not exist after write');
                    }
                } catch (writeError) {
                    console.error('[Cluster-Engine] ❌ Failed to write system prompt file:', writeError.message);
                    console.error('[Cluster-Engine] Error code:', writeError.code);
                    console.error('[Cluster-Engine] Stack:', writeError.stack);
                    throw new Error('Failed to create system prompt file: ' + writeError.message);
                }

                // User message is injected via stdin (stream-json) below, so the
                // engine's stdin input stays open for control_response.

                // Build CLI arguments (same as /api/chat)
                const cliArgs = [
                    '--preload', enginePreload,
                    '--env-file=' + engineEnv, engineCli,
                    '-p',
                    '--input-format', 'stream-json',
                    '--output-format', 'stream-json',
                    '--verbose',
                    '--include-partial-messages',
                    '--permission-prompt-tool', 'stdio',
                    '--permission-mode', autoApprovePermissions ? 'bypassPermissions' : 'default',
                    '--model', rawModel,
                    '--append-system-prompt-file', sysPromptFile,
                ];
                
                // Build environment variables
                const envVars = Object.assign({}, process.env, engineEnvVars);
                envVars.BUN_DISABLE_GLOBAL_CACHE = '1'; envVars.IS_SANDBOX = '1'; // Android runs as root — bypass root-user bypassPermissions check
                // Force unbuffered output for real-time streaming
                envVars.NODE_UNBUFFERED_OUTPUT = '1';
                envVars.PYTHONUNBUFFERED = '1';
                const engineDir = path.dirname(path.dirname(engineCli));
                envVars.NODE_PATH = path.join(engineDir, 'node_modules');
                
                if (apiFormat === 'openai' && proxyPort > 0) {
                    // When using remote proxy, force model to valid DeepSeek ID
                    let proxyModel = rawModel;
                    if (jwtToken && baseUrl && baseUrl.includes(REMOTE_SERVER)) {
                        if (proxyModel !== 'deepseek-v4-pro' && proxyModel !== 'deepseek-v4-flash') {
                            proxyModel = 'deepseek-v4-flash';
                            console.log('[Cluster-Engine] Forced model to deepseek-v4-flash for remote proxy');
                        }
                    }
                    // FIX: Set proxyTarget so the proxy knows where to forward requests
                    // 会话专属：agent 引擎也按会话隔离，避免多个 agent/会话抢同一把 key
                    const sessionTarget = { apiKey, baseUrl, model: proxyModel, format: 'openai', conversationId: String(conversationId) };
                    proxyTarget = sessionTarget;
                    proxyTargets.set(String(conversationId), sessionTarget);
                    envVars.SIMONA_API_KEY = 'proxy-key-' + String(conversationId);
                    // FIX: Don't add /v1 suffix here - the proxy already handles it
                    // Engine will append /v1/messages, so we just need the base URL
                    envVars.SIMONA_BASE_URL = 'http://127.0.0.1:' + proxyPort;
                    console.log('[Cluster-Engine] Routing through OpenAI proxy, model=' + rawModel + ' provider=' + (provider ? provider.name : '?'));
                    console.log('[Cluster-Engine-DEBUG] proxyTarget:', JSON.stringify({ apiKey: apiKey ? '***' : 'EMPTY', baseUrl, model: proxyModel, format: 'openai' }), '| proxyPort:', proxyPort);
                } else {
                    if (apiKey) envVars.SIMONA_API_KEY = apiKey;
                    if (baseUrl) envVars.SIMONA_BASE_URL = normalizeBaseUrl(baseUrl);
                }
                
                console.log('[Cluster-Engine] Launching bun process...');
                console.log('[Cluster-Engine] Agent config:', JSON.stringify({ id: agentConfig.id, name: agentConfig.name, role: agentConfig.role, modelId: agentConfig.modelId }));
                console.log('[Cluster-Engine] Workspace path:', workspacePath);
                console.log('[Cluster-Engine] CLI args:', cliArgs.join(' '));
                console.log('[Cluster-Engine] SIMONA_API_KEY set:', !!envVars.SIMONA_API_KEY);
                console.log('[Cluster-Engine] SIMONA_BASE_URL:', envVars.SIMONA_BASE_URL || 'NOT SET');
                
                // Log API configuration for debugging
                if (envVars.SIMONA_API_KEY) {
                    const keyPreview = envVars.SIMONA_API_KEY.substring(0, 8) + '...';
                    console.log('[Cluster-Engine] API Key preview:', keyPreview);
                } else {
                    console.error('[Cluster-Engine] ⚠️ WARNING: SIMONA_API_KEY is NOT SET!');
                }
                
                const { spawn } = require('child_process');
                const child = spawn(bunExePath, cliArgs, {
                    cwd: workspacePath,
                    env: envVars,
                    stdio: ['pipe', 'pipe', 'pipe'],
                    // Disable output buffering for real-time streaming
                    windowsHide: true,
                });
                
                // Set stdout to non-blocking mode for immediate data delivery
                if (child.stdout) {
                    child.stdout.setEncoding('utf8');
                }
                if (child.stderr) {
                    child.stderr.setEncoding('utf8');
                }
                
                console.log('[Cluster-Engine] Process spawned with PID:', child.pid);

                // Inject the augmented user message via stdin (stream-json) so the
                // engine's stdin input stays OPEN for control_response (permission
                // approvals). --prompt-file would close the input stream after the
                // first message, breaking the permission flow ("Stream closed").
                if (augmentedMessage) {
                    try {
                        const userMsg = JSON.stringify({
                            type: 'user',
                            session_id: '',
                            message: { role: 'user', content: augmentedMessage },
                            parent_tool_use_id: null,
                        }) + '\n';
                        child.stdin.write(userMsg);
                        console.log('[Cluster-Engine] Injected user prompt via stdin (' + userMsg.length + ' bytes)');
                    } catch (err) {
                        console.log('[Cluster-Engine] Failed to inject user prompt via stdin: ' + (err && err.message));
                    }
                }
                
                // Track if we've received any output
                let hasReceivedOutput = false;
                const originalStdoutOn = child.stdout.on.bind(child.stdout);
                const originalStderrOn = child.stderr.on.bind(child.stderr);
                
                // Wrap stdout to track output
                child.stdout.on('data', () => {
                    hasReceivedOutput = true;
                });
                child.stderr.on('data', () => {
                    hasReceivedOutput = true;
                });
                
                // Check if process is still running after a short delay
                setTimeout(() => {
                    if (!child.killed) {
                        console.log('[Cluster-Engine]', agentConfig.name, 'Process still running after 2s, PID:', child.pid);
                        console.log('[Cluster-Engine]', agentConfig.name, 'Has received output:', hasReceivedOutput);
                        
                        if (!hasReceivedOutput) {
                            console.warn('[Cluster-Engine]', agentConfig.name, '⚠️ WARNING: No output received after 2 seconds!');
                            console.warn('[Cluster-Engine]', agentConfig.name, 'This may indicate the process is stuck or API call failed silently.');
                        }
                    } else {
                        console.log('[Cluster-Engine]', agentConfig.name, 'Process exited within 2s');
                    }
                }, 2000);
                
                let fullContent = '';
                let buf = '';
                let hasError = false;
                // result 成功事件已收到（区别于引擎崩溃，用于 close 时避免误报）
                let clusterSawResult = false;
                // Engine stdin stays open for control_response, so it won't exit on
                // its own after emitting result — send end_session + close stdin to
                // let it exit gracefully (code 0); fallback is a short kill timeout.
                let clusterResultKillTimeout = null;
                
                // Listen to stderr for error messages
                child.stderr.on('data', (chunk) => {
                    const stderrOutput = chunk.toString('utf8');
                    console.error('[Cluster-Engine]', agentConfig.name, 'STDERR:', stderrOutput.trim());
                    // Only mark as error if process exits with non-zero code;
                    // many processes print warnings/debug to stderr on success.
                });
                
                // Parse stream-json output
                child.stdout.on('data', (chunk) => {
                    const rawOutput = chunk.toString('utf8');
                    console.log('[Cluster-Engine]', agentConfig.name, 'Raw stdout length:', rawOutput.length, 'first 200 chars:', rawOutput.slice(0, 200));
                    
                    buf += rawOutput;
                    const lines = buf.split('\n');
                    buf = lines.pop() || '';
                    
                    let parsedCount = 0;
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        let evt;
                        try { 
                            evt = JSON.parse(line); 
                            parsedCount++;
                        } catch (e) {
                            console.log('[Cluster-Engine]', agentConfig.name, 'Failed to parse line:', line.slice(0, 100));
                            continue; 
                        }
                        
                        // Debug: log all events
                        if (evt.type === 'stream_event' && evt.event) {
                            console.log('[Cluster-Engine]', agentConfig.name, 'Event type:', evt.event.type);
                        }
                        
                        // ── Handle permission requests (control_request) ──
                        // When engine wants to execute a tool, it emits control_request for permission
                        // In bypass mode, we auto-accept all non-AskUserQuestion tools
                        if (evt.type === 'control_request' && evt.request) {
                            const req2 = evt.request;
                            console.log('[Cluster-Engine]', agentConfig.name, 'control_request id=' + evt.request_id + ' subtype=' + req2.subtype + ' tool=' + (req2.tool_name || '?'));
                            if (autoApprovePermissions) {
                                // Auto-accept all permission requests in bypass mode
                                const autoResponse = JSON.stringify({
                                    type: 'control_response',
                                    response: { 
                                        subtype: 'success', 
                                        request_id: evt.request_id, 
                                        response: { 
                                            toolUseID: req2.tool_use_id, 
                                            behavior: 'allow', 
                                            updatedInput: req2.input || {} 
                                        } 
                                    }
                                }) + '\n';
                                try { 
                                    child.stdin.write(autoResponse); 
                                    console.log('[Cluster-Engine]', agentConfig.name, '✅ Auto-approved tool permission');
                                } catch (e) {
                                    console.error('[Cluster-Engine]', agentConfig.name, 'Failed to write control_response:', e.message);
                                }
                            } else {
                                pendingPermissionRequests.set(evt.request_id, { child: child, tool_use_id: req2.tool_use_id, input: req2.input || {}, tool_name: req2.tool_name || '' });
                                sendSSE({
                                    type: 'permission_request',
                                    request_id: evt.request_id,
                                    tool_use_id: req2.tool_use_id,
                                    tool_name: req2.tool_name || 'Unknown tool',
                                    tool_input: req2.input || {},
                                    agent_id: agentConfig.id,
                                    agent_name: agentConfig.name,
                                });
                            }
                        }
                        
                        // Forward relevant events to frontend
                        else if (evt.type === 'stream_event' && evt.event) {
                            const se = evt.event;
                            
                            // Handle text_delta (normal response content)
                            if (se.type === 'content_block_delta' && se.delta && se.delta.type === 'text_delta') {
                                fullContent += se.delta.text;
                                console.log('[Cluster-Engine]', agentConfig.name, 'Got text delta, length:', se.delta.text.length);
                                // Forward delta to frontend with agent_id
                                const deltaEvent = {
                                    type: 'content_block_delta',
                                    agent_id: agentConfig.id,
                                    agent_name: agentConfig.name,
                                    role: agentConfig.role,
                                    model: agentConfig.modelId,
                                    delta: se.delta
                                };
                                console.log('[Cluster] Sending delta for agent:', agentConfig.id, 'name:', agentConfig.name, 'text length:', se.delta.text.length);
                                sendSSE(deltaEvent);
                                console.log('[Cluster] Delta sent successfully for agent:', agentConfig.name);
                            }
                            // Handle thinking_delta (reasoning/thinking content) - forward as-is
                            else if (se.type === 'content_block_delta' && se.delta && se.delta.type === 'thinking_delta') {
                                console.log('[Cluster-Engine]', agentConfig.name, 'Got thinking delta, length:', se.delta.thinking?.length || 0);
                                // Forward thinking_delta as-is, frontend will handle it separately
                                const thinkingEvent = {
                                    type: 'content_block_delta',
                                    agent_id: agentConfig.id,
                                    agent_name: agentConfig.name,
                                    role: agentConfig.role,
                                    model: agentConfig.modelId,
                                    delta: se.delta  // Keep original type: thinking_delta
                                };
                                console.log('[Cluster] Sending thinking delta for agent:', agentConfig.id, 'name:', agentConfig.name, 'thinking length:', se.delta.thinking?.length || 0);
                                sendSSE(thinkingEvent);
                            } else if (se.type === 'tool_use_start') {
                                sendSSE({
                                    type: 'tool_use_start',
                                    agent_id: agentConfig.id,
                                    tool_use_id: se.tool_use_id,
                                    tool_name: se.tool_name,
                                    tool_input: se.tool_input
                                });
                            } else if (se.type === 'tool_use_done') {
                                sendSSE({
                                    type: 'tool_use_done',
                                    agent_id: agentConfig.id,
                                    tool_use_id: se.tool_use_id,
                                    tool_output: se.tool_output
                                });
                            }
                        } else if (evt.type === 'result') {
                            // 任务成功完成（区别于引擎崩溃）——close 时据此避免误报
                            clusterSawResult = true;
                            // Engine finished. stdin stays open (for control_response),
                            // so the process won't exit on its own — send end_session
                            // + close stdin so the engine exits gracefully (code 0)
                            console.log('[Cluster-Engine]', agentConfig.name, 'Received result, ending session for graceful exit');
                            try {
                                if (child.stdin && !child.stdin.destroyed) {
                                    child.stdin.write(JSON.stringify({
                                        type: 'control_request',
                                        request_id: 'cluster-end-' + Date.now() + '-' + agentConfig.id,
                                        request: { subtype: 'end_session', reason: 'done' },
                                    }) + '\n');
                                    child.stdin.end();
                                }
                            } catch (_) {}
                            if (clusterResultKillTimeout) clearTimeout(clusterResultKillTimeout);
                            clusterResultKillTimeout = setTimeout(function() {
                                console.log('[Cluster-Engine]', agentConfig.name, 'Process did not exit after end_session, killing PID', child.pid);
                                try { killProcessTree(child.pid); } catch(_) {}
                            }, 3000);
                        }
                    }
                });
                
                child.stderr.on('data', (chunk) => {
                    const errorMsg = chunk.toString('utf8');
                    console.error('[Cluster-Engine]', agentConfig.name, 'stderr:', errorMsg.slice(0, 500));
                    // Also log full error for debugging
                    if (errorMsg.length > 500) {
                        console.error('[Cluster-Engine]', agentConfig.name, 'stderr (continued):', errorMsg.slice(500, 1000));
                    }
                });
                
                child.on('close', (code) => {
                    // Clean up temp file - only delete our own file
                    try { 
                        if (fs.existsSync(sysPromptFile)) {
                            /* preserve sysPromptFile — do NOT unlink */ 0; 
                        }
                    } catch (_) {}
                    
                    // Clear timeouts
                    clearTimeout(processTimeout);
                    clearTimeout(stuckTimeout);
                    
                    if ((code === 0 || clusterSawResult) && !hasError) {
                        console.log('[Cluster-Engine]', agentConfig.name, 'completed successfully');
                        resolve({
                            agent_id: agentConfig.id,
                            agent_name: agentConfig.name,
                            role: agentConfig.role,
                            modelId: agentConfig.modelId,
                            content: fullContent,
                            success: true
                        });
                    } else {
                        const error = new Error(`Engine exited with code ${code}`);
                        console.error('[Cluster-Engine]', agentConfig.name, 'failed with code:', code);
                        reject(error);
                    }
                });
                
                child.on('error', (err) => {
                    hasError = true;
                    // Clean up temp file on error
                    try { 
                        if (fs.existsSync(sysPromptFile)) {
                            /* preserve sysPromptFile — do NOT unlink */ 0; 
                        }
                    } catch (_) {}
                    // Clear timeouts
                    clearTimeout(processTimeout);
                    clearTimeout(stuckTimeout);
                    console.error('[Cluster-Engine]', agentConfig.name, 'spawn error:', err.message);
                    reject(err);
                });
                
                // Set timeout (30 minutes per agent - cluster tasks need more time for multi-turn reasoning + tool execution)
                const processTimeout = setTimeout(() => {
                    if (!child.killed) {
                        console.error('[Cluster-Engine]', agentConfig.name, 'Process timeout after 30 minutes, killing...');
                        child.kill();
                        try { 
                            if (fs.existsSync(sysPromptFile)) {
                                /* preserve sysPromptFile — do NOT unlink */ 0; 
                            }
                        } catch (_) {}
                        reject(new Error('Agent execution timeout'));
                    }
                }, 30 * 60 * 1000);
                
                // Add a shorter timeout to detect stuck processes (60 seconds)
                const stuckTimeout = setTimeout(() => {
                    if (!child.killed && !hasReceivedOutput) {
                        console.error('[Cluster-Engine]', agentConfig.name, '❌ Process appears stuck (no output after 60s), PID:', child.pid);
                        console.error('[Cluster-Engine]', agentConfig.name, 'This likely indicates:');
                        console.error('[Cluster-Engine]', agentConfig.name, '  1. API key is invalid or expired');
                        console.error('[Cluster-Engine]', agentConfig.name, '  2. Network connection failed');
                        console.error('[Cluster-Engine]', agentConfig.name, '  3. Model endpoint is unreachable');
                        console.error('[Cluster-Engine]', agentConfig.name, 'Killing process to prevent indefinite hang...');
                        
                        // Kill the stuck process
                        child.kill();
                        // Clean up temp file when killing stuck process
                        try { 
                            if (fs.existsSync(sysPromptFile)) {
                                /* preserve sysPromptFile — do NOT unlink */ 0; 
                            }
                        } catch (_) {}
                        clearTimeout(processTimeout);
                        clearTimeout(stuckTimeout);
                        
                        reject(new Error('Agent process stuck - no output after 60 seconds. Check API key and network connectivity.'));
                    }
                }, 60000);
                
            });
        } catch (error) {
            console.error('[Cluster-Engine] Failed to spawn engine:', error.message);
            throw error;
        }
    }


    // ==================== Agent Cluster Chat API ====================
    server.post('/api/cluster-chat', async (req, res) => {
        const { 
            conversation_id, 
            message, 
            cluster_config,
            attachments,
            env_token,
            env_base_url,
            user_mode,
            user_profile,
            system_prompt,
            agent_mode_enabled
        } = req.body;

        const conv = db.conversations.find(c => c.id === conversation_id);
        if (!conv) return res.status(404).json({ error: 'Conversation not found' });

        console.log('[Cluster] === Conversation Info ===');
        console.log('[Cluster] Conversation ID:', conversation_id);
        console.log('[Cluster] Model:', conv.model);
        console.log('[Cluster] Workspace path:', conv.workspace_path);
        console.log('[Cluster] Workspace exists:', fs.existsSync(conv.workspace_path));
        console.log('[Cluster] Agent count:', cluster_config.agentCount);

        if (!cluster_config || !cluster_config.agentCount || cluster_config.agentCount < 2) {
            return res.status(400).json({ error: 'Invalid cluster configuration: agentCount must be >= 2' });
        }

        // 获取API格式配置（用于标题生成）
        const provider = resolveProvider(conv.model);
        let apiKey, baseUrl, apiFormat = 'simona';
        if (provider) {
            const useRemote = !!(jwtToken && provider && provider.id === 'deepseek-fixed-mode');
            apiKey = useRemote ? jwtToken : (provider.apiKey || env_token || '');
            baseUrl = useRemote ? REMOTE_SERVER : (provider.apiKey ? provider.baseUrl : (env_base_url || provider.baseUrl));
            apiFormat = useRemote ? 'openai' : (provider.format || 'simona');
            console.log('[Cluster] Provider:', provider.name, '| format:', apiFormat, '| remote:', useRemote);
            
            // Check balance before proceeding with cluster (same as main chat)
            if (useRemote && jwtToken) {
                try {
                    const balRes = await fetch(REMOTE_SERVER + '/api/v1/balance', {
                        headers: { 'Authorization': 'Bearer ' + jwtToken },
                        signal: AbortSignal.timeout(5000),
                    });
                    const balData = await balRes.json();
                    const availBal = (balData.walletBalance || balData.available_balance || 0) - (balData.totalCost || 0);
                    console.log('[Cluster] Available balance:', availBal.toFixed(4));
                    if (availBal <= 0) {
                        return res.status(402).json({ error: '余额不足，请登录 https://example.com/ 充值后再试', code: 'INSUFFICIENT_BALANCE', availableBalance: availBal, rechargeUrl: 'https://example.com/' });
                    }
                } catch (e) {
                    console.error('[Cluster-BalanceCheck] Error:', e.message);
                }
            }
        } else {
            const validToken = (env_token && env_token !== 'self-hosted') ? env_token : '';
            apiKey = validToken || engineEnvVars.SIMONA_API_KEY || process.env.SIMONA_API_KEY;
            baseUrl = validToken ? (env_base_url || engineEnvVars.SIMONA_BASE_URL || process.env.SIMONA_BASE_URL) : (engineEnvVars.SIMONA_BASE_URL || env_base_url || process.env.SIMONA_BASE_URL);
            console.log('[Cluster] Key source:', validToken ? 'user' : engineEnvVars.SIMONA_API_KEY ? 'engine-env' : 'process-env');
            console.log('[Cluster] apiKey available:', !!apiKey, '| baseUrl:', baseUrl);
            
            // 如果apiKey为空，记录提示（不影响集群功能，仅跳过标题生成）
            if (!apiKey) {
                console.log('[Cluster] Note: API key not configured. Title generation will be skipped (cluster mode still works normally).');
            }
        }

        // ═══ 会话独占密钥：cluster 主链路同主 chat 一致，sensenova 密钥池按会话分配 ═══
        if (provider && provider.id === 'sensenova-free' && conversation_id) {
            try {
                const sessKey = await acquireSensenovaKey(conversation_id, (conv.model || '').replace(/-thinking$/, ''));
                if (sessKey) { apiKey = sessKey; console.log('[Cluster] Session-exclusive sensenova key bound to', String(conversation_id).slice(0, 8)); }
            } catch (ke) {
                console.warn('[Cluster] Sensenova session key acquire failed:', ke.message);
            }
        }

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        // Disable socket idle timeout for SSE — agents can take many minutes between events
        res.socket?.setTimeout(0);
        req.socket?.setTimeout(0);

        activeStreams.set(conversation_id, { events: [], listeners: new Set(), done: false, primaryRes: res });
        const sendSSE = (data) => {
            var stream = activeStreams.get(conversation_id);
            if (stream) {
                stream.events.push(data);
                var line = 'data: ' + JSON.stringify(data) + '\n\n';
                var arr = Array.from(stream.listeners);
                for (var i = 0; i < arr.length; i++) {
                    try { arr[i].write(line); } catch (_) { stream.listeners.delete(arr[i]); }
                }
            }
            try { 
                res.write('data: ' + JSON.stringify(data) + '\n\n'); 
                // Force flush to ensure immediate delivery for real-time streaming
                if (res.flush) res.flush();
            } catch (_) {}
        };

        try {
            console.log('[Cluster] Starting cluster chat with', cluster_config.agentCount, 'agents');
            sendSSE({ 
                type: 'cluster_start', 
                agent_count: cluster_config.agentCount,
                phase: 'planning'
            });
            
            // Ensure initial events are flushed before starting agents
            if (res.flush) res.flush();
            console.log('[Cluster] Initial events flushed, starting agents...');

            // Load conversation history for context
            const conversationHistory = db.messages
                .filter(m => m.conversation_id === conversation_id)
                .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
            
            console.log('[Cluster] Loaded', conversationHistory.length, 'previous messages from conversation history');
            
            // Build context from conversation history
            let historyContext = '';
            if (conversationHistory.length > 0) {
                console.log('[Cluster] Conversation has', conversationHistory.length, 'messages, using last 10 for context');
                historyContext = '# Conversation History\n\n';
                historyContext += 'The following is the previous conversation history. Please consider this context when responding:\n\n';
                
                // Show last 10 messages to avoid context overflow
                const recentMessages = conversationHistory.slice(-10);
                recentMessages.forEach((msg, idx) => {
                    const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
                    historyContext += `## ${roleLabel} Message ${idx + 1}\n\n${msg.content}\n\n---\n\n`;
                });
                
                historyContext += `\n# Current Request\n\nNow please respond to the user's latest message below, considering the conversation history above.\n\n`;
            } else {
                console.log('[Cluster] This is the first message in the conversation');
            }
            
            // Combine history with current message
            const fullMessage = historyContext + message;
            console.log('[Cluster] Full message length:', fullMessage.length, 'chars');

            // 为本次对话生成唯一的agent_id后缀，避免不同对话之间的消息冲突
            const clusterSessionId = Date.now();
            const results = [];

            // 根据agentCount动态创建Agent配置，使用当前对话的模型
            const agentsWithUniqueId = Array.from({ length: cluster_config.agentCount }, (_, index) => ({
                id: `cluster-agent-${index}`,
                unique_id: `cluster-agent-${index}-${clusterSessionId}`,
                name: `Agent ${index + 1}`,
                modelId: conv.model,  // 使用当前对话的模型
                providerId: conv.provider_id || 'default',
            }));

            console.log('[Cluster] Starting intelligent multi-agent collaboration with', cluster_config.agentCount, 'agents');
            
            // Phase 1: Planner Agent analyzes and decomposes the task
            console.log('[Cluster] Phase 1: Task Planning & Decomposition');
            sendSSE({ 
                type: 'agent_start', 
                agent_id: agentsWithUniqueId[0].unique_id, 
                agent_name: '规划者',
                agent_index: 1,
                model: agentsWithUniqueId[0].modelId,
                role: 'planner'
            });
            if (res.flush) res.flush();

            const plannerAgent = agentsWithUniqueId[0];
            const maxSubtasks = cluster_config.agentCount - 1; // 保留1个作为规划者，其余都是执行者
            const planningPrompt = `# 任务分析与拆解

你是一个专业的任务规划专家。请仔细分析用户的请求，并将其拆解为多个可并行执行的子任务。

## 用户请求
${message}

## 重要约束
你最多只能拆解出 **${maxSubtasks}** 个子任务，因为系统只有 ${maxSubtasks} 个执行者Agent可以并行处理。

## 你的任务
1. **理解核心目标**：分析用户真正想要什么
2. **智能拆解**：将大任务拆解为 **不超过${maxSubtasks}个** 独立的子任务
3. **明确分工**：每个子任务应该清晰、独立、可执行
4. **合理分配**：如果任务简单，可以减少子任务数量；如果复杂，尽量接近上限

## 输出格式
请以JSON格式返回拆解结果：

\`\`\`json
{
  "analysis": "对任务的简要分析",
  "subtasks": [
    {
      "id": "task_1",
      "title": "子任务标题",
      "description": "详细的任务描述，包括具体要做什么"
    }
  ]
}
\`\`\`

**注意：** subtasks数组的长度不能超过${maxSubtasks}！

请开始分析：`;

            const plannerContext = {
                user_mode,
                env_token,
                env_base_url,
                engineEnvVars,
                system_prompt,
                user_profile,
                proxyPort,
                bunExePath,
                enginePreload,
                engineEnv,
                engineCli,
                normalizeBaseUrl,
                resolveProvider,
                agent_mode_enabled
            };

            console.log('[Cluster] === Before spawning Planner ===');
            console.log('[Cluster] Workspace path for planner:', conv.workspace_path);
            console.log('[Cluster] System prompt length:', system_prompt ? system_prompt.length : 0);

            const plannerSendSSE = (data) => {
                if (data.type === 'content_block_delta' || data.type === 'message_start' || data.type === 'message_delta') {
                    data.agent_id = plannerAgent.unique_id;
                    data.agent_name = '规划者';
                }
                sendSSE(data);
            };

            const plannerResult = await spawnAgentEngine(
                { ...plannerAgent, id: plannerAgent.unique_id },
                planningPrompt,
                conversation_id,
                plannerSendSSE,
                conv.workspace_path,
                plannerContext
            );

            console.log('[Cluster] Planner completed analysis');
            sendSSE({ 
                type: 'phase_change',
                phase: 'executing',
                message: '开始并行执行子任务'
            });
            sendSSE({ 
                type: 'agent_complete', 
                agent_id: plannerAgent.unique_id,
                agent_name: '规划者',
                agent_index: 1,
                content_preview: '任务拆解完成'
            });

            // Parse the planning result
            let subtasks = [];
            try {
                const jsonMatch = plannerResult.content.match(/```json\n([\s\S]*?)\n```/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[1]);
                    subtasks = parsed.subtasks || [];
                    console.log('[Cluster] Decomposed into', subtasks.length, 'subtasks');
                } else {
                    // Fallback: create simple subtasks
                    console.log('[Cluster] Could not parse JSON, using fallback decomposition');
                    subtasks = [
                        {
                            id: 'task_1',
                            title: '主要任务',
                            description: message
                        }
                    ];
                }
            } catch (error) {
                console.error('[Cluster] Failed to parse planning result:', error.message);
                subtasks = [
                    {
                        id: 'task_1',
                        title: '执行任务',
                        description: message
                    }
                ];
            }

            // Ensure we don't have more subtasks than available executors
            const executorCount = cluster_config.agentCount - 1; // 第1个是规划者，其余都是执行者
            if (subtasks.length > executorCount) {
                console.log(`[Cluster] Planner returned ${subtasks.length} subtasks, but only ${executorCount} executors available. Truncating...`);
                subtasks = subtasks.slice(0, executorCount);
            } else if (subtasks.length === 0) {
                console.log('[Cluster] No subtasks returned, using original message as single task');
                subtasks = [
                    {
                        id: 'task_1',
                        title: '执行任务',
                        description: message
                    }
                ];
            }

            console.log('[Cluster] Will execute', subtasks.length, 'subtasks with', executorCount, 'executor agents');

            // Phase 2: Executor Agents process subtasks concurrently
            console.log('[Cluster] Phase 2: Parallel Execution');
            const executorAgents = agentsWithUniqueId.slice(1, 1 + executorCount);
            
            const executorPromises = subtasks.map(async (subtask, index) => {
                const executorAgent = executorAgents[index];
                try {
                    console.log(`[Cluster] Executor ${index + 1} (${executorAgent.name}) starting subtask:`, subtask.title);
                    sendSSE({ 
                        type: 'agent_start', 
                        agent_id: executorAgent.unique_id, 
                        agent_name: `执行者${index + 1}`,
                        agent_index: index + 2,
                        model: executorAgent.modelId,
                        role: 'executor'
                    });
                    if (res.flush) res.flush();

                    const executorPrompt = `# 子任务执行

## 任务背景
${plannerResult.content.split('```json')[0]}  
*(以上是任务的整体分析)*

## 你的子任务
**标题：** ${subtask.title}

**详细描述：**
${subtask.description}

## 要求
请专注完成上述子任务，提供详细、准确的执行结果。你的结果将被整合到最终答案中。

请开始执行：`;

                    const executorContext = {
                        user_mode,
                        env_token,
                        env_base_url,
                        engineEnvVars,
                        system_prompt,
                        user_profile,
                        proxyPort,
                        bunExePath,
                        enginePreload,
                        engineEnv,
                        engineCli,
                        normalizeBaseUrl,
                        resolveProvider,
                        agent_mode_enabled
                    };

                    const executorSendSSE = (data) => {
                        if (data.type === 'content_block_delta' || data.type === 'message_start' || data.type === 'message_delta') {
                            data.agent_id = executorAgent.unique_id;
                            data.agent_name = `执行者${index + 1}`;
                        }
                        sendSSE(data);
                    };

                    const executorResult = await spawnAgentEngine(
                        { ...executorAgent, id: executorAgent.unique_id },
                        executorPrompt,
                        conversation_id,
                        executorSendSSE,
                        conv.workspace_path,
                        executorContext
                    );

                    console.log(`[Cluster] Executor ${index + 1} completed`);
                    sendSSE({ 
                        type: 'agent_complete', 
                        agent_id: executorAgent.unique_id,
                        agent_name: `执行者${index + 1}`,
                        agent_index: index + 2,
                        content_preview: executorResult.content.slice(0, 200)
                    });

                    return {
                        subtask_id: subtask.id,
                        subtask_title: subtask.title,
                        agent_name: `执行者${index + 1}`,
                        content: executorResult.content
                    };

                } catch (error) {
                    console.error(`[Cluster] Executor ${index + 1} failed:`, error.message);
                    sendSSE({ 
                        type: 'agent_error', 
                        agent_id: executorAgent.unique_id,
                        agent_name: `执行者${index + 1}`,
                        agent_index: index + 2,
                        error: error.message 
                    });
                    return null;
                }
            });

            // Wait for all executors to complete
            const executorResults = await Promise.all(executorPromises);
            const validResults = executorResults.filter(r => r !== null);
            results.push(...validResults);

            console.log('[Cluster] All executors completed, collected', validResults.length, 'results');

            // Combine all executor results as the final answer
            let finalAnswer = '# 蜂群模式执行结果\n\n';
            finalAnswer += `## 任务分析\n\n${plannerResult.content.split('```')[0]}\n\n`;
            finalAnswer += `## 各执行者的结果\n\n`;
            
            validResults.forEach((result, idx) => {
                finalAnswer += `### ${result.subtask_title}\n**由 ${result.agent_name} 执行**\n\n${result.content}\n\n---\n\n`;
            });

            console.log('[Cluster] Sending final aggregated answer');
            sendSSE({ 
                type: 'cluster_complete', 
                final_answer: finalAnswer,
                agent_count: validResults.length + 1 // +1 for planner
            });
            sendSSE({ type: 'message_stop' });

            // Save to conversation - use db.messages not conv.messages
            const userMessageId = 'msg-' + Date.now();
            db.messages.push({
                id: userMessageId,
                role: 'user',
                content: message,
                conversation_id: conversation_id,
                created_at: new Date().toISOString(),
            });
            
            db.messages.push({
                id: 'msg-' + (Date.now() + 1),
                role: 'assistant',
                content: finalAnswer,
                conversation_id: conversation_id,
                created_at: new Date().toISOString(),
                metadata: {
                    cluster_mode: true,
                    agent_count: results.length
                }
            });
            saveDb();

            // 如果是第一条消息，立即生成标题
            const userMessages = db.messages.filter(m => m.conversation_id === conversation_id && m.role === 'user');
            if (userMessages.length === 1) {
                console.log('[Cluster] First message detected, generating title immediately...');
                console.log('[Cluster] Title generation - apiKey:', apiKey ? '***' + apiKey.slice(-4) : 'EMPTY', '| baseUrl:', baseUrl);
                generateTitleAsync(conversation_id, message.slice(0, 300), finalAnswer.slice(0, 300), apiKey, baseUrl, conv.model, apiFormat);
            }

            endStream(conversation_id);

        } catch (error) {
            console.error('[Cluster] Error:', error);
            sendSSE({ type: 'error', error: error.message });
            endStream(conversation_id);
        }
    });


    server.post('/api/auth/send-code', async (req, res) => {
        try {
            const remoteRes = await fetch(REMOTE_SERVER + '/api/auth/send-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body),
                signal: AbortSignal.timeout(15000),
            });
            const data = await remoteRes.json();
            res.status(remoteRes.status).json(data);
        } catch (e) {
            console.error('[Auth-Proxy] send-code error:', e.message);
            res.status(502).json({ error: 'Remote server unreachable' });
        }
    });

    server.post('/api/auth/verify-code', async (req, res) => {
        try {
            const remoteRes = await fetch(REMOTE_SERVER + '/api/auth/verify-code', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(req.body),
                signal: AbortSignal.timeout(15000),
            });
            const data = await remoteRes.json();
            // Save JWT token if returned
            if (data.jwt) {
                jwtToken = data.jwt;
                saveJwtToken(data.jwt, data.email);
                console.log('[Auth-Proxy] JWT token obtained for', data.email);
            }
            res.status(remoteRes.status).json(data);
        } catch (e) {
            console.error('[Auth-Proxy] verify-code error:', e.message);
            res.status(502).json({ error: 'Remote server unreachable' });
        }
    });

    // Logout — clear saved JWT
    server.post('/api/auth/logout', (req, res) => {
        clearJwtToken();
        console.log('[Auth-Proxy] JWT token cleared');
        res.json({ success: true });
    });

    // Workspace management APIs
    server.get('/api/workspace/current', (req, res) => {
        try {
            const { conversation_id } = req.query;
            
            if (conversation_id) {
                const conv = db.conversations.find(c => c.id === conversation_id);
                if (conv && conv.workspace_path) {
                    return res.json({ workspace_path: conv.workspace_path });
                }
            }
            
            // Fallback to global workspacesDir
            const defaultWorkspacesDir = path.join(app.getPath('documents'), 'Simona Desktop');
            const wsDir = workspacesDir || defaultWorkspacesDir;
            res.json({ workspace_path: wsDir });
        } catch (error) {
            console.error('[Workspace-API] Error:', error);
            res.status(500).json({ error: 'Failed to get workspace path' });
        }
    });
    
    server.post('/api/workspace/set', (req, res) => {
        try {
            const { workspace_path, conversation_id } = req.body;
            if (!workspace_path) {
                return res.status(400).json({ error: 'workspace_path is required' });
            }
            
            if (!fs.existsSync(workspace_path)) {
                fs.mkdirSync(workspace_path, { recursive: true });
            }
            
            if (conversation_id) {
                const conv = db.conversations.find(c => c.id === conversation_id);
                if (!conv) {
                    return res.status(404).json({ error: 'Conversation not found' });
                }
                
                const oldPath = conv.workspace_path;
                conv.workspace_path = workspace_path;
                saveDb();
                console.log('[Workspace] Updated conv', conversation_id, 'from', oldPath, 'to:', workspace_path);
                
                // Kill engine process so it restarts with new workspace
                const activeChild = activeChildren.get(conversation_id);
                if (activeChild) {
                    killProcessTree(activeChild.pid);
                    activeChildren.delete(conversation_id);
                }
                
                // Clear session ID to force fresh start with new workspace
                if (conv.simona_session_id) {
                    conv.simona_session_id = null;
                    saveDb();
                }
            } else {
                // No conversation_id: save as default for new conversations
                const userDataPath = app.getPath('userData');
                const settingsPath = path.join(userDataPath, 'workspace-config.json');
                fs.writeFileSync(settingsPath, JSON.stringify({ workspacesDir: workspace_path }, null, 2));
                workspacesDir = workspace_path;
                console.log('[Workspace] Updated default workspace to:', workspace_path);
            }
            
            res.json({ success: true, workspace_path });
        } catch (error) {
            console.error('[Workspace] ❌ Failed to set:', error);
            res.status(500).json({ error: 'Failed to set workspace path' });
        }
    });
    
    server.post('/api/workspace/select', async (req, res) => {
        try {
            // This will be called from frontend to open folder dialog
            // The actual dialog is handled by electron main process
            res.json({ success: true, message: 'Use electronAPI.selectFolder instead' });
        } catch (error) {
            res.status(500).json({ error: 'Failed to select workspace' });
        }
    });

    // 浏览目录（用于网页端文件夹选择器）
    server.get('/api/workspace/dirs', (req, res) => {
        try {
            const dirPath = req.query.path || '';
            let entries = [];

            if (!dirPath) {
                // Windows: 列出盘符
                if (process.platform === 'win32') {
                    for (let i = 65; i <= 90; i++) {
                        const drive = String.fromCharCode(i) + ':\\';
                        if (fs.existsSync(drive)) {
                            entries.push({ name: drive, path: drive, isDrive: true });
                        }
                    }
                } else {
                    // Unix: 从根目录开始
                    entries.push({ name: '/', path: '/', isDrive: true });
                }
            } else {
                const resolved = path.resolve(dirPath);
                if (!fs.existsSync(resolved)) {
                    return res.json({ entries: [] });
                }
                const items = fs.readdirSync(resolved, { withFileTypes: true });
                entries = items
                    .filter(item => item.isDirectory())
                    .map(item => ({
                        name: item.name,
                        path: path.join(resolved, item.name),
                        isDrive: false
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name));
            }

            // 如果有父目录（非盘符根目录），添加返回上一级
            let parentPath = null;
            if (dirPath) {
                const resolved = path.resolve(dirPath);
                const parsed = path.parse(resolved);
                if (!(process.platform === 'win32' && resolved === parsed.root)) {
                    parentPath = path.dirname(resolved);
                    if (process.platform === 'win32' && parentPath.endsWith(':\\') && parentPath.length === 3) {
                        // Windows 根目录的上一级回到盘符列表
                        parentPath = '';
                    }
                }
            }

            res.json({ entries, parentPath });
        } catch (error) {
            console.error('[Workspace] Browse dirs error:', error);
            res.status(500).json({ error: 'Failed to browse directories' });
        }
    });

    // ═══ Large-file chunked reading (port of large-file-mcp) ═══
    server.get('/api/large-file/structure', async (req, res) => {
        try {
            const filePath = req.query.path;
            if (!filePath) return res.status(400).json({ error: 'path required' });
            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
            const structure = await lfh.getStructure(filePath);
            res.json(structure);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    server.get('/api/large-file/chunk', async (req, res) => {
        try {
            const filePath = req.query.path;
            const chunkIndex = parseInt(req.query.chunkIndex || '0', 10);
            const linesPerChunk = req.query.linesPerChunk ? parseInt(req.query.linesPerChunk, 10) : undefined;
            if (!filePath) return res.status(400).json({ error: 'path required' });
            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
            const chunk = await lfh.readChunk(filePath, chunkIndex, {
                linesPerChunk,
                includeLineNumbers: req.query.lineNumbers === 'true',
            });
            res.json(chunk);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    server.get('/api/large-file/navigate', async (req, res) => {
        try {
            const filePath = req.query.path;
            const lineNumber = parseInt(req.query.line, 10);
            const contextLines = req.query.context ? parseInt(req.query.context, 10) : 5;
            if (!filePath || !lineNumber) return res.status(400).json({ error: 'path and line required' });
            const chunk = await lfh.navigateToLine(filePath, lineNumber, contextLines);
            res.json(chunk);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    server.get('/api/large-file/search', async (req, res) => {
        try {
            const filePath = req.query.path;
            const pattern = req.query.pattern;
            if (!filePath || !pattern) return res.status(400).json({ error: 'path and pattern required' });
            const results = await lfh.searchInFile(filePath, pattern, {
                caseSensitive: req.query.caseSensitive === 'true',
                regex: req.query.regex === 'true',
                maxResults: req.query.maxResults ? parseInt(req.query.maxResults, 10) : 100,
                contextBefore: 2, contextAfter: 2,
            });
            res.json({ totalResults: results.length, results });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // 获取工作区文件树
    server.get('/api/workspace/files', (req, res) => {
        try {
            const currentConv = db.conversations.find(c => c.id === req.query.conversation_id);
            const workspacePath = currentConv ? currentConv.workspace_path : workspacesDir;
            
            if (!fs.existsSync(workspacePath)) {
                return res.json({ files: [] });
            }

            const buildFileTree = (dirPath, relativePath = '') => {
                const items = [];
                const entries = fs.readdirSync(dirPath, { withFileTypes: true });
                
                for (const entry of entries) {
                    // 跳过隐藏文件和node_modules等
                    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                    
                    const fullPath = path.join(dirPath, entry.name);
                    const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
                    
                    if (entry.isDirectory()) {
                        items.push({
                            name: entry.name,
                            path: relPath,
                            type: 'directory',
                            children: buildFileTree(fullPath, relPath)
                        });
                    } else {
                        items.push({
                            name: entry.name,
                            path: relPath,
                            type: 'file'
                        });
                    }
                }
                
                return items.sort((a, b) => {
                    // 目录在前，文件在后
                    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });
            };

            const files = buildFileTree(workspacePath);
            res.json({ files });
        } catch (error) {
            console.error('[Workspace] Failed to get files:', error);
            res.status(500).json({ error: 'Failed to get file tree' });
        }
    });

    // 获取文件内容
    server.get('/api/workspace/file', async (req, res) => {
        try {
            const filePath = req.query.path;
            if (!filePath) {
                return res.status(400).json({ error: 'Path is required' });
            }

            const currentConv = db.conversations.find(c => c.id === req.query.conversation_id);
            const workspacePath = currentConv ? currentConv.workspace_path : workspacesDir;
            const fullPath = path.join(workspacePath, filePath);

            // 安全检查：确保文件在工作区内
            if (!fullPath.startsWith(workspacePath)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            if (!fs.existsSync(fullPath)) {
                return res.status(404).json({ error: 'File not found' });
            }

            // Large file handling: if file is big, return structure + first chunk
            const totalLines = await lfh.getMetadata(fullPath).then(m => m.totalLines).catch(() => 0);
            if (totalLines > lfh.SMALL_FILE_LIMIT) {
                const [structure, firstChunk] = await Promise.all([
                    lfh.getStructure(fullPath),
                    lfh.readChunk(fullPath, 0, { includeLineNumbers: true }),
                ]);
                return res.json({
                    largeFile: true,
                    totalLines,
                    message: `File is large (${totalLines} lines). Use GET /api/large-file/chunk?path=...&chunkIndex=N to read specific chunks, GET /api/large-file/search?path=...&pattern=... to search, GET /api/large-file/structure?path=... for full analysis.`,
                    structure,
                    firstChunk,
                    path: filePath,
                });
            }

            const content = fs.readFileSync(fullPath, 'utf-8');
            res.json({ content, path: filePath });
        } catch (error) {
            console.error('[Workspace] Failed to read file:', error);
            res.status(500).json({ error: 'Failed to read file' });
        }
    });

    // 保存文件内容
    server.post('/api/workspace/file', (req, res) => {
        try {
            const { path: filePath, content, conversation_id } = req.body;
            if (!filePath || content === undefined) {
                return res.status(400).json({ error: 'Path and content are required' });
            }

            const currentConv = db.conversations.find(c => c.id === conversation_id);
            const workspacePath = currentConv ? currentConv.workspace_path : workspacesDir;
            const fullPath = path.join(workspacePath, filePath);

            // 安全检查：确保文件在工作区内
            if (!fullPath.startsWith(workspacePath)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // 确保目录存在
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            fs.writeFileSync(fullPath, content, 'utf-8');
            console.log('[Workspace] File saved:', fullPath);
            res.json({ success: true, path: filePath });
        } catch (error) {
            console.error('[Workspace] Failed to save file:', error);
            res.status(500).json({ error: 'Failed to save file' });
        }
    });

    // ============================================
    // WeChat Gateway API Endpoints
    // ============================================

    // GET /api/wechat/status - 获取微信连接状态
    server.get('/api/wechat/status', async (req, res) => {
        const userDataPath = app.getPath('userData');
        const dbPath = path.join(userDataPath, 'simona-desktop.json');
        let wechatConnected = false;
        try {
            if (fs.existsSync(dbPath)) {
                const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                wechatConnected = db.wechat_connected === true;
            }
        } catch (e) {
            console.error('[WeChat API] Error reading DB:', e);
        }

        const portOccupied = await checkGatewayPort();
        res.json({
            connected: wechatConnected && portOccupied,
            wechatConnected,
            portOccupied,
            gatewayPort: GATEWAY_PORT,
            status: (wechatConnected && portOccupied) ? 'connected' : 'disconnected',
        });
    });

    // POST /api/wechat/connect - 连接微信
    server.post('/api/wechat/connect', async (req, res) => {
        const result = await startOpenclawGateway();
        if (result.success) {
            // 标记为已连接
            const userDataPath = app.getPath('userData');
            const dbPath = path.join(userDataPath, 'simona-desktop.json');
            if (fs.existsSync(dbPath)) {
                try {
                    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                    db.wechat_connected = true;
                    db.wechat_connected_at = new Date().toISOString();
                    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
                } catch (e) {
                    console.error('[WeChat] Failed to update DB:', e);
                }
            }
        }
        res.json(result);
    });

    // POST /api/wechat/disconnect - 断开微信
    server.post('/api/wechat/disconnect', async (req, res) => {
        const result = await stopOpenclawGateway();
        if (result.success) {
            // 标记为未连接
            const userDataPath = app.getPath('userData');
            const dbPath = path.join(userDataPath, 'simona-desktop.json');
            if (fs.existsSync(dbPath)) {
                try {
                    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
                    db.wechat_connected = false;
                    db.wechat_connected_at = null;
                    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
                } catch (e) {
                    console.error('[WeChat] Failed to update DB:', e);
                }
            }
        }
        res.json(result);
    });

    // GET /api/wechat/qr - 获取微信登录二维码
    server.get('/api/wechat/qr', async (req, res) => {
        try {
            // 调用 OpenClaw gateway 的二维码接口
            const response = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/qr`, {
                method: 'GET',
                headers: { 'Accept': 'application/json' }
            });

            if (response.ok) {
                const data = await response.json();
                res.json({
                    success: true,
                    qrCodeUrl: data.qrCodeUrl || data.url || data.qr_url,
                    expiresAt: data.expiresAt || data.expires_in
                });
            } else {
                // 网关可能还未完全启动，返回临时二维码
                res.json({
                    success: false,
                    error: 'Gateway not ready, please try again in a few seconds',
                    retryAfter: 3
                });
            }
        } catch (e) {
            res.json({
                success: false,
                error: 'Failed to get QR code: ' + e.message,
                retryAfter: 3
            });
        }
    });

    // ===== Video Generation (Grok Video 3) =====
    server.post('/api/video/generate', async (req, res) => {
        // Check available balance before proxying
        if (jwtToken) {
            try {
                const balRes = await fetch(REMOTE_SERVER + '/api/v1/balance', {
                    headers: { 'Authorization': 'Bearer ' + jwtToken },
                    signal: AbortSignal.timeout(5000),
                });
                const balData = await balRes.json();
                const available = (balData.walletBalance || balData.available_balance || 0) - (balData.totalCost || 0);
                if (available <= 0) {
                    return res.status(402).json({ error: '余额不足，请登录 https://example.com/ 充值后再试', code: 'INSUFFICIENT_BALANCE', availableBalance: available, rechargeUrl: 'https://example.com/' });
                }
            } catch (e) {
                console.error('[Video-BalanceCheck] Error:', e.message);
                // If balance check fails, allow the request to proceed (fail-open)
            }
        }
        try {
            // Fix garbled Chinese prompts (Windows shell encoding issue)
            if (req.body && req.body.prompt) {
                const rawBytes = Buffer.from(req.body.prompt, 'latin1');
                const fixedPrompt = rawBytes.toString('utf8');
                if (/[\u4e00-\u9fff]/.test(fixedPrompt)) {
                    req.body.prompt = fixedPrompt;
                }
            }
            const headers = { 'Content-Type': 'application/json' };
            if (jwtToken) headers['Authorization'] = 'Bearer ' + jwtToken;
            const remoteRes = await fetch(REMOTE_SERVER + '/api/v1/video/generate', {
                method: 'POST',
                headers,
                body: JSON.stringify(req.body),
                signal: AbortSignal.timeout(35000),
            });
            const data = await remoteRes.json();
            res.status(remoteRes.status).json(data);
        } catch (e) {
            res.status(502).json({ error: e.message });
        }
    });

    server.get('/api/video/status', async (req, res) => {
        try {
            const headers = {};
            if (jwtToken) headers['Authorization'] = 'Bearer ' + jwtToken;
            const remoteRes = await fetch(REMOTE_SERVER + '/api/v1/video/status?task_id=' + encodeURIComponent(req.query.task_id || ''), {
                headers,
                signal: AbortSignal.timeout(20000),
            });
            const data = await remoteRes.json();
            res.status(remoteRes.status).json(data);
        } catch (e) {
            res.status(502).json({ error: e.message });
        }
    });

    // ===== Image Generation (grok-4.2-image) =====
    server.post('/api/image/generate', async (req, res) => {
        // Check available balance before proxying
        if (jwtToken) {
            try {
                const balRes = await fetch(REMOTE_SERVER + '/api/v1/balance', {
                    headers: { 'Authorization': 'Bearer ' + jwtToken },
                    signal: AbortSignal.timeout(5000),
                });
                const balData = await balRes.json();
                const available = (balData.walletBalance || balData.available_balance || 0) - (balData.totalCost || 0);
                if (available <= 0) {
                    return res.status(402).json({ error: '余额不足，请登录 https://example.com/ 充值后再试', code: 'INSUFFICIENT_BALANCE', availableBalance: available, rechargeUrl: 'https://example.com/' });
                }
            } catch (e) {
                console.error('[Image-BalanceCheck] Error:', e.message);
                // If balance check fails, allow the request to proceed (fail-open)
            }
        }
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (jwtToken) headers['Authorization'] = 'Bearer ' + jwtToken;
            const remoteRes = await fetch(REMOTE_SERVER + '/api/v1/media/generate', {
                method: 'POST',
                headers,
                body: JSON.stringify(req.body),
                signal: AbortSignal.timeout(35000),
            });
            const data = await remoteRes.json();
            res.status(remoteRes.status).json(data);
        } catch (e) {
            res.status(502).json({ error: e.message });
        }
    });

    server.get('/api/image/status', async (req, res) => {
        try {
            const headers = {};
            if (jwtToken) headers['Authorization'] = 'Bearer ' + jwtToken;
            const remoteRes = await fetch(REMOTE_SERVER + '/api/v1/media/status?task_id=' + encodeURIComponent(req.query.task_id || ''), {
                headers,
                signal: AbortSignal.timeout(20000),
            });
            const data = await remoteRes.json();
            res.status(remoteRes.status).json(data);
        } catch (e) {
            res.status(502).json({ error: e.message });
        }
    });

    // ===== Image proxy for clipboard copy =====
    server.get('/api/image/proxy', async (req, res) => {
        try {
            const url = req.query.url;
            if (!url) return res.status(400).json({ error: 'Missing url' });
            const imageResp = await fetch(url);
            if (!imageResp.ok) return res.status(imageResp.status).json({ error: 'Failed to fetch' });
            const buf = Buffer.from(await imageResp.arrayBuffer());
            res.setHeader('Content-Type', imageResp.headers.get('content-type') || 'image/png');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.send(buf);
        } catch (e) { res.status(502).json({ error: e.message }); }
    });

    // ===== Tavily Web Search (used by engine WebSearchTool) =====
    server.post('/api/web-search', async (req, res) => {
        try {
            const { query, max_results } = req.body || {};
            if (!query) return res.status(400).json({ error: 'Missing query' });
            const resp = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: TAVILY_API_KEY, query, search_depth: 'basic', max_results: max_results || 6, include_answer: true, include_raw_content: false }),
                signal: AbortSignal.timeout(15000),
            });
            if (!resp.ok) return res.status(resp.status).json({ query, results: [] });
            const data = await resp.json();
            const results = (data.results || []).map((r, i) => {
                const title = (r.title || 'Untitled').trim();
                const content = (r.content || '').trim();
                const url = r.url || '';
                return `${i + 1}. ${title}\n   链接: ${url}\n   内容: ${content}`;
            });
            if (data.answer) results.unshift('摘要: ' + data.answer);
            res.json({ query, results, durationSeconds: 0 });
        } catch (err) {
            console.error('[WebSearch] Error:', err.message);
            res.status(500).json({ query: req.body?.query || '', results: [], durationSeconds: 0 });
        }
    });

    // ===== Balance / Cost Tracking =====
    server.get('/api/balance', async (req, res) => {
        if (!jwtToken) return res.json({ totalCost: 0, walletBalance: 0 });
        try {
            const remoteRes = await fetch(REMOTE_SERVER + '/api/v1/balance', {
                headers: { 'Authorization': 'Bearer ' + jwtToken },
                signal: AbortSignal.timeout(10000),
            });
            res.json(await remoteRes.json());
        } catch (e) {
            console.error('[Balance-Proxy] Error:', e.message);
            res.json({ totalCost: 0, walletBalance: 0 });
        }
    });

    // Wallet - Add balance (after payment)
    server.post('/api/wallet/add', async (req, res) => {
        if (!jwtToken) return res.status(401).json({ error: 'Not authenticated' });
        try {
            const remoteRes = await fetch(REMOTE_SERVER + '/api/v1/wallet/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwtToken },
                body: JSON.stringify(req.body),
                signal: AbortSignal.timeout(10000),
            });
            res.json(await remoteRes.json());
        } catch (e) {
            console.error('[Wallet-Proxy] Error:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // ============================================
    // OpenAI-Compatible Chat API (for OpenClaw Gateway)
    // ============================================
    // OpenClaw gateway expects standard OpenAI format: POST /v1/chat/completions
    // This endpoint spawns a Simona Code CLI subprocess and streams the response in OpenAI SSE format.
    server.post('/v1/chat/completions', async (req, res) => {
        const { model, messages, max_tokens, temperature, stream = true, tools, tool_choice } = req.body;

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ error: 'messages is required and must be a non-empty array' });
        }

        console.log('[OpenAI-API] Received chat request, model=' + model + ', messages=' + messages.length);

        // Build prompt from messages
        let prompt = '';
        const conversationHistory = [];
        for (const msg of messages) {
            const role = msg.role;
            const content = typeof msg.content === 'string' ? msg.content :
                Array.isArray(msg.content) ? msg.content.map(c => c.type === 'text' ? c.text : '').join('') : '';
            if (role === 'system') {
                prompt += `System: ${content}\n`;
            } else if (role === 'user') {
                conversationHistory.push({ role: 'user', content });
                prompt += `User: ${content}\n`;
            } else if (role === 'assistant') {
                conversationHistory.push({ role: 'assistant', content });
                prompt += `Assistant: ${content}\n`;
            } else if (role === 'tool') {
                prompt += `Tool Result: ${content}\n`;
            }
        }

        // Use workspace dir as temp workspace
        const workspacePath = path.join(workspacesDir, 'wechat-gateway');
        if (!fs.existsSync(workspacePath)) {
            fs.mkdirSync(workspacePath, { recursive: true });
        }

        // Build system prompt
        let sysPrompt = customSystemPromptFull || '';
        if (sysPrompt) {
            // Remove anti-Kiro sections for wechat gateway (self-hosted-like)
            sysPrompt = sysPrompt.replace(/<override_instructions>[\s\S]*?<\/override_instructions>\s*/g, '');
        }

        // Write system prompt to temp file
        let sysPromptFile = null;
        if (sysPrompt) {
            sysPromptFile = path.join(os.tmpdir(), 'simona-sys-prompt-wxgw-' + Date.now() + '.tmp');
            fs.writeFileSync(sysPromptFile, sysPrompt, 'utf8');
        }

        // Write the user prompt to a temp file too, to keep the command line
        // within Windows' 32767-char limit.
        let userPromptFile = null;
        if (prompt) {
            userPromptFile = path.join(os.tmpdir(), 'simona-user-prompt-wxgw-' + Date.now() + '.tmp');
            fs.writeFileSync(userPromptFile, prompt, 'utf8');
        }

        // Resolve model
        const modelId = (model || 'simona-sonnet-4-6').replace(/-thinking$/, '');

        // Prepare Simona Code CLI args
        const cliArgs = [
            '--preload', enginePreload,
            '--env-file=' + engineEnv, engineCli,
            '-p',
            '--output-format', 'stream-json',
            '--verbose',
            '--include-partial-messages',
            '--model', modelId,
        ];

        if (sysPromptFile) {
            cliArgs.push('--append-system-prompt-file', sysPromptFile);
        }
        if (userPromptFile) {
            cliArgs.push('--prompt-file', userPromptFile);
        }

        // Set up environment
        const envVars = Object.assign({}, process.env);
        envVars.BUN_DISABLE_GLOBAL_CACHE = '1'; envVars.IS_SANDBOX = '1'; // Android runs as root — bypass root-user bypassPermissions check
        const engineDir = path.dirname(path.dirname(engineCli));
        envVars.NODE_PATH = path.join(engineDir, 'node_modules');

        // For WeChat gateway: use DeepSeek provider from providers.json
        // This ensures the gateway uses the main program's Simona Code engine with the configured DeepSeek API key
        const authHeader = req.headers['authorization'] || '';
        const tokenFromAuth = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

        // Priority: 1) Authorization header (for external API calls), 2) DeepSeek provider from providers.json
        let validToken = '';
        let validBaseUrl = '';

        if (tokenFromAuth && tokenFromAuth !== 'self-hosted') {
            // External API call with Authorization header
            validToken = tokenFromAuth;
            validBaseUrl = process.env.SIMONA_BASE_URL || '';
        } else {
            // Use DeepSeek provider from providers.json for WeChat gateway
            const deepseekProvider = providers.find(p => p.id === 'deepseek-fixed-mode' && p.enabled);
            if (deepseekProvider) {
                validToken = deepseekProvider.apiKey;
                validBaseUrl = deepseekProvider.baseUrl;
                console.log('[Engine] Using DeepSeek provider from providers.json for WeChat gateway');
            } else {
                // Fallback to environment variables
                if (process.env.SIMONA_AUTH_TOKEN && process.env.SIMONA_AUTH_TOKEN !== 'self-hosted') {
                    validToken = process.env.SIMONA_AUTH_TOKEN;
                    validBaseUrl = process.env.SIMONA_BASE_URL || 'http://127.0.0.1:18080';
                } else if (process.env.SIMONA_API_KEY && process.env.SIMONA_API_KEY !== 'self-hosted') {
                    validToken = process.env.SIMONA_API_KEY;
                    validBaseUrl = process.env.SIMONA_BASE_URL || '';
                }
            }
        }

        if (validToken) envVars.SIMONA_API_KEY = validToken;
        if (validBaseUrl) envVars.SIMONA_BASE_URL = validBaseUrl;
        // Also pass auth token for Simona Desktop compatibility
        if (process.env.SIMONA_AUTH_TOKEN) envVars.SIMONA_AUTH_TOKEN = process.env.SIMONA_AUTH_TOKEN;

        console.log('[Engine] model=' + modelId + ' | workspace=' + workspacePath);

        // Stream response in OpenAI SSE format
        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            let assistantText = '';
            let thinkingText = '';
            let sessionId = null;
            let buf = '';
            const { spawn } = require('child_process');
            const child = spawn(bunExePath, cliArgs, {
                cwd: workspacePath, env: envVars,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            const writeSSE = (data) => {
                res.write('data: ' + JSON.stringify(data) + '\n\n');
                if (res.flush) res.flush();
            };

            child.stdout.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                const lines = buf.split('\n');
                buf = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;
                    let evt;
                    try { evt = JSON.parse(line); } catch { continue; }

                    if (evt.session_id && !sessionId) {
                        sessionId = evt.session_id;
                        console.log('[Engine] Session ID:', sessionId);
                    }

                    if (evt.type === 'stream_event' && evt.event) {
                        const se = evt.event;
                        if (se.type === 'content_block_delta') {
                            if (se.delta?.type === 'text_delta') {
                                assistantText += se.delta.text;
                                writeSSE({
                                    id: 'chatcmpl-' + Date.now(),
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: modelId,
                                    choices: [{
                                        index: 0,
                                        delta: { content: se.delta.text },
                                        finish_reason: null
                                    }]
                                });
                            } else if (se.delta?.type === 'thinking_delta') {
                                thinkingText += se.delta.thinking;
                                // Some clients expect reasoning_content in the delta
                                writeSSE({
                                    id: 'chatcmpl-' + Date.now(),
                                    object: 'chat.completion.chunk',
                                    created: Math.floor(Date.now() / 1000),
                                    model: modelId,
                                    choices: [{
                                        index: 0,
                                        delta: { reasoning_content: se.delta.thinking },
                                        finish_reason: null
                                    }]
                                });
                            }
                        } else if (se.type === 'result' && assistantText === '') {
                            assistantText = typeof evt.result === 'string' ? evt.result : '';
                        }
                    }
                }
            });

            let stderrBuf = '';
            child.stderr.on('data', (c) => { stderrBuf += c.toString('utf8'); });

            await new Promise(function(resolve, reject) {
                child.on('close', function(code) {
                    // Process remaining buffer
                    if (buf.trim()) {
                        try {
                            const lastEvt = JSON.parse(buf);
                            if (lastEvt.type === 'stream_event' && lastEvt.event?.type === 'result') {
                                assistantText = lastEvt.event.result || assistantText;
                            }
                        } catch (_) {}
                    }
                    resolve();
                });
                child.on('error', reject);
            });

            // Clean up
            if (sysPromptFile) try { /* preserve sysPromptFile — do NOT unlink */ 0; } catch (_) {}
            if (userPromptFile) try { fs.unlinkSync(userPromptFile); } catch (_) {}

            // Send final chunk
            writeSSE({
                id: 'chatcmpl-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                }]
            });
            writeSSE({
                id: 'chatcmpl-' + Date.now(),
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: 'stop'
                }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            });
            writeSSE('[DONE]');
            res.end();
        } else {
            // Non-streaming: wait for full response
            let assistantText = '';
            let buf = '';
            const { spawn } = require('child_process');
            const child = spawn(bunExePath, cliArgs, {
                cwd: workspacePath, env: envVars,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            child.stdout.on('data', (chunk) => {
                buf += chunk.toString('utf8');
            });

            await new Promise(function(resolve, reject) {
                child.on('close', function(code) {
                    // Parse last result
                    const lines = buf.trim().split('\n');
                    for (let i = lines.length - 1; i >= 0; i--) {
                        if (!lines[i].trim()) continue;
                        try {
                            const evt = JSON.parse(lines[i]);
                            if (evt.type === 'result' && evt.result) {
                                assistantText = typeof evt.result === 'string' ? evt.result : '';
                                break;
                            }
                        } catch (_) {}
                    }
                    resolve();
                });
                child.on('error', reject);
            });

            if (sysPromptFile) try { /* preserve sysPromptFile — do NOT unlink */ 0; } catch (_) {}
            if (userPromptFile) try { fs.unlinkSync(userPromptFile); } catch (_) {}

            res.json({
                id: 'chatcmpl-' + Date.now(),
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: assistantText },
                    finish_reason: 'stop'
                }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            });
        }
    });

    return server;
}

module.exports = { initServer, enableNodeModeForChildProcesses };

// ===== Tavily 网络搜索工具（通过直接调用 REST API） =====

const TAVILY_API_KEY = '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';

/**
 * 调用 Tavily Search API 执行网络搜索
 * @param {string} query - 搜索关键词
 * @param {number} maxResults - 最大结果数（默认6）
 * @returns {Promise<string>} 格式化后的搜索结果文本
 */
async function searchTavily(query, maxResults = 6) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        
        const resp = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_key: TAVILY_API_KEY,
                query: query,
                search_depth: 'basic',
                max_results: maxResults,
                include_answer: true,
                include_raw_content: false
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        
        if (!resp.ok) {
            console.error('[Tavily] API error:', resp.status, await resp.text().catch(() => ''));
            return '';
        }
        
        const data = await resp.json();
        if (!data.results || data.results.length === 0) {
            console.log('[Tavily] No results for:', query.slice(0, 60));
            return '';
        }
        
        // 格式化结果
        let output = '';
        if (data.answer) {
            output += '摘要: ' + data.answer + '\n\n';
        }
        
        data.results.forEach((r, i) => {
            const title = (r.title || 'Untitled').trim();
            const snippet = (r.content || '').trim();
            const url = r.url || '';
            output += (i + 1) + '. ' + title + '\n';
            output += '   链接: ' + url + '\n';
            if (snippet) {
                output += '   内容: ' + snippet.slice(0, 500) + '\n';
            }
            output += '\n';
        });
        
        console.log('[Tavily] Got', data.results.length, 'results for:', query.slice(0, 60));
        return output.trim();
    } catch (err) {
        if (err.name === 'AbortError') {
            console.error('[Tavily] Request timed out');
        } else {
            console.error('[Tavily] Error:', err.message);
        }
        return '';
    }
}