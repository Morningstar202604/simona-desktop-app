/**
 * git-utils.cjs — Git 自动回退工具函数
 *
 * 设计方案：
 * - 工作区目录保持不变（workspacesDir），不创建子目录
 * - 每个对话拥有独立的 git 仓库，存储在 .simona/{convShortId}/.git
 * - 所有仓库共享同一个工作目录（workspacesDir）
 * - 多个对话的 git 操作互不干扰
 */
const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const execAsync = promisify(exec);

// ── 会话文件大小上限（500KB）──
const MAX_SESSION_BYTES = 500 * 1024;

/**
 * 获取会话相关的 .jsonl 文件名列表
 * 优先查找工作区 .simona/ 目录，兼容旧版直接放在工作区根目录
 */
function getSessionFiles(workspacePath, convId) {
    const shortId = (convId || '').split('-')[0] || convId;
    const files = [];
    // 新位置：.simona/ 目录
    const simonaDir = path.join(workspacePath, '.simona');
    if (fs.existsSync(simonaDir)) {
        try {
            const entries = fs.readdirSync(simonaDir);
            for (const name of entries) {
                if (name === convId + '.jsonl' || name === shortId + '.jsonl') {
                    files.push(path.join('.simona', name));
                }
            }
        } catch (_) {}
    }
    // 兼容旧版：工作区根目录
    try {
        const entries = fs.readdirSync(workspacePath);
        for (const name of entries) {
            if (name === convId + '.jsonl' || name === shortId + '.jsonl') {
                if (!files.includes(name)) files.push(name);
            }
        }
    } catch (_) {}
    return files;
}

/**
 * 获取会话文件总大小（字节）
 */
function getSessionFilesSize(workspacePath, convId) {
    let total = 0;
    for (const f of getSessionFiles(workspacePath, convId)) {
        try {
            total += fs.statSync(path.join(workspacePath, f)).size;
        } catch (_) {}
    }
    return total;
}

// ── 查找绑定的 git 可执行文件路径 ──
// 优先使用应用自带的 git（打包模式），其次开发模式下的 git-bundle，最后回退到系统 PATH
let _gitPath = null;

function findGitPath() {
    if (_gitPath) return _gitPath;

    // 1) 打包模式：resources/git/mingw64/bin/git.exe（process.resourcesPath 指向 app.asar 同级的 resources/）
    if (process.resourcesPath) {
        const bundled = path.join(process.resourcesPath, 'git', 'mingw64', 'bin', 'git.exe');
        if (fs.existsSync(bundled)) {
            _gitPath = bundled;
            console.log('[Git] 使用打包自带 git:', _gitPath);
            return _gitPath;
        }
    }

    // 2) 开发模式：git-bundle/mingw64/bin/git.exe（electron/ 的上级目录下）
    const devBundle = path.join(__dirname, '..', 'git-bundle', 'mingw64', 'bin', 'git.exe');
    if (fs.existsSync(devBundle)) {
        _gitPath = devBundle;
        console.log('[Git] 使用开发模式 git-bundle:', _gitPath);
        return _gitPath;
    }

    // 3) 回退到系统 PATH 上的 git
    try {
        execSync('git --version', { stdio: 'ignore', timeout: 5000 });
        _gitPath = 'git';
        console.log('[Git] 使用系统 PATH 上的 git');
        return _gitPath;
    } catch (_) {
        _gitPath = null;
        return null;
    }
}

async function findGitPathAsync() {
    if (_gitPath) return _gitPath;

    // 1) 打包模式
    if (process.resourcesPath) {
        const bundled = path.join(process.resourcesPath, 'git', 'mingw64', 'bin', 'git.exe');
        if (fs.existsSync(bundled)) {
            _gitPath = bundled;
            console.log('[Git] 使用打包自带 git:', _gitPath);
            return _gitPath;
        }
    }

    // 2) 开发模式
    const devBundle = path.join(__dirname, '..', 'git-bundle', 'mingw64', 'bin', 'git.exe');
    if (fs.existsSync(devBundle)) {
        _gitPath = devBundle;
        console.log('[Git] 使用开发模式 git-bundle:', _gitPath);
        return _gitPath;
    }

    // 3) 回退到系统 PATH — 异步检测，不阻塞事件循环
    try {
        await execAsync('git --version', { timeout: 5000 });
        _gitPath = 'git';
        console.log('[Git] 使用系统 PATH 上的 git');
        return _gitPath;
    } catch (_) {
        _gitPath = null;
        return null;
    }
}

/**
 * 获取对话的 git 仓库目录
 * 位于工作区下的 .simona/{convShortId}/ 内
 */
function getGitDir(workspacePath, convId) {
    const shortId = (convId || '').split('-')[0] || convId;
    return path.join(workspacePath, '.simona', shortId, '.git');
}

/**
 * 构建带 --git-dir 和 --work-tree 的 git 命令前缀
 */
function gitCmd(workspacePath, convId, subCmd) {
    const gitDir = getGitDir(workspacePath, convId);
    const gp = findGitPath();
    if (!gp) throw new Error('Git not available');
    return `"${gp}" --git-dir="${gitDir}" --work-tree="${workspacePath}" ${subCmd}`;
}

/**
 * 异步执行 git 命令并返回 stdout（不阻塞事件循环）
 */
async function gitExecAsync(workspacePath, convId, subCmd, options = {}) {
    const gitPath = await findGitPathAsync();
    if (!gitPath) {
        throw new Error('Git not available');
    }
    const gitDir = getGitDir(workspacePath, convId);
    const cmd = `"${gitPath}" --git-dir="${gitDir}" --work-tree="${workspacePath}" ${subCmd}`;
    const opts = { cwd: workspacePath, timeout: 30000, ...options };
    const { stdout } = await execAsync(cmd, opts);
    return (options.encoding === false) ? stdout : (stdout || '');
}

/**
 * 异步检测 git 是否可用（不阻塞事件循环）
 */
async function isGitAvailableAsync() {
    const p = await findGitPathAsync();
    return p !== null;
}

/**
 * 初始化对话的独立 git 仓库（异步，不阻塞事件循环）
 */
async function initConvRepo(workspacePath, convId) {
    try {
        const available = await isGitAvailableAsync();
        if (!available) {
            console.log('[Git] Git not available, skipping init for conv:', convId);
            return false;
        }
    } catch (_) {
        return false;
    }

    const gitDir = getGitDir(workspacePath, convId);
    if (fs.existsSync(gitDir)) {
        console.log('[Git] Repo already exists for conv:', convId);
        return true;
    }

    try {
        const simonaDir = path.dirname(gitDir);
        if (!fs.existsSync(simonaDir)) {
            fs.mkdirSync(simonaDir, { recursive: true });
        }

        await gitExecAsync(workspacePath, convId, 'init -b main', { timeout: 10000 });
        console.log('[Git] Initialized repo for conv:', convId);

        try {
            await gitExecAsync(workspacePath, convId, 'config user.email "simona@local.dev"', { timeout: 5000 });
            await gitExecAsync(workspacePath, convId, 'config user.name "Simona"', { timeout: 5000 });
        } catch (_) {}

        // 默认忽略所有文件，仅追踪明确 force-add 的会话文件
        const excludePath = path.join(gitDir, 'info', 'exclude');
        try {
            let excludeContent = fs.readFileSync(excludePath, 'utf8');
            const needed = ['.simona/', '*', '!.gitignore'];
            const missing = needed.filter(x => !excludeContent.includes(x));
            if (missing.length > 0) {
                fs.writeFileSync(excludePath, excludeContent + '\n' + missing.join('\n') + '\n', 'utf8');
            }
        } catch (_) {}

        // 仅追踪会话相关的 .jsonl 文件，避免将桌面大文件加入仓库
        const sessionFiles = getSessionFiles(workspacePath, convId);
        if (sessionFiles.length > 0) {
            for (const f of sessionFiles) {
                await gitExecAsync(workspacePath, convId, `add --force -- "${f}"`, { timeout: 10000 });
            }
        }
        await gitExecAsync(workspacePath, convId, 'commit -m "[Simona] 初始化" --allow-empty', { timeout: 10000 });
        await gitExecAsync(workspacePath, convId, 'tag init', { timeout: 5000 });
        console.log('[Git] Initial commit and tag created for conv:', convId);

        return true;
    } catch (err) {
        console.error('[Git] Init failed for conv', convId, ':', err.message);
        try { fs.rmSync(path.dirname(gitDir), { recursive: true, force: true }); } catch (_) {}
        return false;
    }
}

/**
 * 创建检查点（异步，不阻塞事件循环）
 */
async function createConvCheckpoint(workspacePath, convId, toolFiles = []) {
    try {
        if (!(await isGitAvailableAsync())) return null;
    } catch (_) { return null; }
    if (!fs.existsSync(getGitDir(workspacePath, convId))) return null;

    try {
        // 超限检查：如果会话文件超过上限，跳过检查点
        const totalSize = getSessionFilesSize(workspacePath, convId);
        if (totalSize > MAX_SESSION_BYTES) {
            console.log('[Git] Session files exceed', MAX_SESSION_BYTES, 'bytes (' + totalSize + '), skipping checkpoint for conv:', convId);
            return null;
        }

        // force-add 会话相关的 .jsonl 文件
        const sessionFiles = getSessionFiles(workspacePath, convId);
        for (const f of sessionFiles) {
            await gitExecAsync(workspacePath, convId, `add --force -- "${f}"`, { timeout: 10000 });
        }

        // force-add AI 工具调用创建/修改的文件
        for (const fp of toolFiles) {
            try {
                const relPath = path.relative(workspacePath, fp);
                if (relPath && !relPath.startsWith('..') && !path.isAbsolute(relPath)) {
                    // 文件在工作区内 → 直接追踪
                    await gitExecAsync(workspacePath, convId, `add --force -- "${relPath}"`, { timeout: 10000 });
                } else if (fs.existsSync(fp)) {
                    // 文件在工作区外 → 复制到工作区再追踪（限制 5MB）
                    const stat = fs.statSync(fp);
                    if (stat.size > 5 * 1024 * 1024) continue;
                    const destName = path.basename(fp);
                    const destPath = path.join(workspacePath, destName);
                    fs.copyFileSync(fp, destPath);
                    console.log('[Git] Copied external file to workspace:', destName);
                    await gitExecAsync(workspacePath, convId, `add --force -- "${destName}"`, { timeout: 10000 });
                }
            } catch (_) {}
        }

        const status = (await gitExecAsync(workspacePath, convId, 'status --porcelain', { timeout: 5000 })).trim();
        if (!status) {
            const hash = (await gitExecAsync(workspacePath, convId, 'rev-parse HEAD', { timeout: 5000 })).trim();
            return hash;
        }

        await gitExecAsync(workspacePath, convId, 'commit -m "[Simona] 自动检查点"', { timeout: 30000 });
        const hash = (await gitExecAsync(workspacePath, convId, 'rev-parse HEAD', { timeout: 5000 })).trim();
        console.log('[Git] Checkpoint for conv', convId, ':', hash.slice(0, 8));
        return hash;
    } catch (err) {
        console.error('[Git] Checkpoint failed for conv', convId, ':', err.message);
        return null;
    }
}

/**
 * 创建标签（异步，不阻塞事件循环）
 */
async function createConvTag(workspacePath, convId, tagName) {
    try {
        if (!(await isGitAvailableAsync())) return false;
    } catch (_) { return false; }
    if (!fs.existsSync(getGitDir(workspacePath, convId))) return false;

    try {
        try {
            await gitExecAsync(workspacePath, convId, `tag -d ${tagName} 2>nul`, { timeout: 5000 });
        } catch (_) {}

        await gitExecAsync(workspacePath, convId, `tag ${tagName}`, { timeout: 5000 });
        console.log('[Git] Tag for conv', convId, ':', tagName);
        return true;
    } catch (err) {
        console.error('[Git] Tag failed for conv', convId, ':', err.message);
        return false;
    }
}

/**
 * 回退到指定标签状态（异步，不阻塞事件循环）
 */
async function rollbackConvToTag(workspacePath, convId, tagName) {
    try {
        if (!(await isGitAvailableAsync())) return false;
    } catch (_) { return false; }
    if (!fs.existsSync(getGitDir(workspacePath, convId))) return false;

    try {
        try {
            await gitExecAsync(workspacePath, convId, `rev-parse --verify ${tagName}`, { timeout: 5000 });
        } catch (_) {
            console.warn('[Git] Tag', tagName, 'not found for conv', convId, '- skipping rollback');
            return false;
        }

        await gitExecAsync(workspacePath, convId, `reset --hard ${tagName}`, { timeout: 30000 });
        // 重置后仅恢复追踪的 .jsonl 文件，不清除其他文件
        console.log('[Git] Rolled back conv', convId, 'to tag:', tagName);
        return true;
    } catch (err) {
        console.error('[Git] Rollback failed for conv', convId, ':', err.message);
        return false;
    }
}

/**
 * 清理对话的 git 仓库
 */
function cleanupConvRepo(workspacePath, convId) {
    const gitDir = getGitDir(workspacePath, convId);
    const repoDir = path.dirname(gitDir);
    if (fs.existsSync(repoDir)) {
        try {
            fs.rmSync(repoDir, { recursive: true, force: true });
            console.log('[Git] Cleaned up repo for conv:', convId);
        } catch (err) {
            console.error('[Git] Cleanup failed for conv', convId, ':', err.message);
        }
    }
}

/**
 * 查找要回退到的标签
 * 从指定消息索引向前查找最近的助手消息的 git_tag
 */
function findRollbackTag(messages, editedMsgIndex) {
    for (let i = editedMsgIndex - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.git_tag) {
            return msg.git_tag;
        }
    }
    return 'init';
}

module.exports = {
    initConvRepo,
    createConvCheckpoint,
    createConvTag,
    rollbackConvToTag,
    cleanupConvRepo,
    findRollbackTag,
};
