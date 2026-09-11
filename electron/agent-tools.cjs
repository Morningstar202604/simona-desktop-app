/**
 * agent-tools.cjs — Simona 调用其他 AI 智能体的统一入口
 *
 * 原理：每个智能体本质上是"输入任务文本 → 输出结果文本"的 CLI/API。
 * Simona 通过 child_process 调起它们的 CLI，或通过 HTTP 调它们的 API。
 *
 * 前 6 个：CLI 型，完整实现（Simona Code / Codex / Qoder / Cursor / OpenCode / Cline）
 * 后 4 个：API/MCP 型，留好接口（MiniMax / 智谱 GLM / Trae / WorkBuddy）
 *
 * 用法: require('./agent-tools.cjs').invokeAgent(agentName, task)
 */
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

// ── 智能体注册表 ──
// type: 'cli'  → 用 child_process 执行命令
// type: 'api'  → 用 fetch 调 HTTP API（需配置 API Key）
// type: 'mcp'  → 通过 MCP 协议连接（需外部 MCP 配置）

const AGENTS = {
    'simona-code': {
        label: 'Simona Code',
        type: 'cli',
        cmd: 'simona',
        args: (task) => ['-p', task],
        check: (cmd) => `${cmd} --version`,
    },
    'codex': {
        label: 'OpenAI Codex',
        type: 'cli',
        cmd: 'codex',
        args: (task) => ['exec', '--prompt', task],
        check: (cmd) => `${cmd} --version`,
    },
    'qoder': {
        label: 'Qoder CLI (阿里巴巴)',
        type: 'cli',
        cmd: 'qodercli',
        args: (task) => [task],
        check: (cmd) => `${cmd} --version`,
    },
    'cursor': {
        label: 'Cursor',
        type: 'cli',
        cmd: 'cursor',
        args: (task) => ['--command', task],
        check: (cmd) => `${cmd} --version`,
    },
    'opencode': {
        label: 'OpenCode (阿里云百炼)',
        type: 'cli',
        cmd: 'opencode',
        args: (task) => ['run', task],
        check: (cmd) => `${cmd} --version`,
    },
    'cline': {
        label: 'Cline',
        type: 'cli',
        cmd: 'npx',
        args: (task) => ['-y', '@cline/cli', '-p', task],
        check: (cmd) => `${cmd} --version`,
    },

    // ── 后 4 个：API/MCP 型，留接口 ──
    'minimax': {
        label: 'MiniMax',
        type: 'api',
        // OpenAI 兼容接口，需在 Simona 环境配置 MINIMAX_API_KEY
        baseUrl: 'https://api.minimax.chat/v1',
        model: 'MiniMax-M2.5',
        // 需要实现: headers Authorization: Bearer <MINIMAX_API_KEY>
        // 未实现，返回提示
    },
    'zhipu-glm': {
        label: '智谱 GLM',
        type: 'api',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-5',
        // 需要实现: headers Authorization: Bearer <ZHIPU_API_KEY>
    },
    'trae': {
        label: 'Trae (字节跳动)',
        type: 'mcp',
        // 通过 MCP 协议调用 Trae 的 SOLO 模式
        // 未实现完整 MCP 客户端，返回提示
    },
    'workbuddy': {
        label: 'WorkBuddy (腾讯)',
        type: 'mcp',
        // 通过 MCP 协议或腾讯云 API 调用
        // 未实现完整 MCP 客户端，返回提示
    },
};

// ── 执行 CLI 智能体 ──
function runCli(cmd, args, task, timeoutMs) {
    return new Promise((resolve) => {
        const fullCmd = `${cmd} ${args.map(a => `"${a}"`).join(' ')}`;
        console.log(`[Agent-Tools] 执行: ${fullCmd}`);
        const child = exec(fullCmd, {
            cwd: process.cwd(),
            timeout: timeoutMs || 300000, // 默认5分钟
            maxBuffer: 20 * 1024 * 1024,  // 20MB
            encoding: 'utf8',
            env: { ...process.env, LANG: 'en_US.UTF-8' }
        }, (err, stdout, stderr) => {
            let result = '';
            if (stdout) result += stdout;
            if (stderr) result += (result ? '\n' : '') + (err ? `STDERR: ${stderr}` : '');
            if (err && !stdout && !stderr) result = `执行失败: ${err.message}`;
            if (!result) result = '(无输出)';
            // 截断超长输出
            if (result.length > 100000) {
                result = result.slice(0, 50000) + `\n\n... [truncated ${result.length - 100000} chars] ...\n\n` + result.slice(-50000);
            }
            resolve({ content: result, is_error: !!(err && err.code), exitCode: err ? err.code : 0 });
        });
        // 超时强制终止
        child.on('timeout', () => {
            child.kill('SIGKILL');
        });
    });
}

// ── 检查 CLI 是否已安装 ──
function checkCliInstalled(agent) {
    return new Promise((resolve) => {
        exec(agent.check(agent.cmd), {
            timeout: 10000,
            encoding: 'utf8',
            env: { ...process.env, LANG: 'en_US.UTF-8' }
        }, (err) => {
            resolve(!err);
        });
    });
}

// ── 主入口：调用任意智能体 ──
async function invokeAgent(agentName, task, options) {
    options = options || {};
    const key = (agentName || '').toLowerCase().trim();
    const agent = AGENTS[key];

    if (!agent) {
        const available = Object.keys(AGENTS).join(', ');
        return { content: `未知智能体: "${agentName}"。可用: ${available}`, is_error: true };
    }

    // CLI 型：完整实现
    if (agent.type === 'cli') {
        const installed = await checkCliInstalled(agent);
        if (!installed) {
            return {
                content: `${agent.label} (${agent.cmd}) 未安装。\n请先安装 CLI:\n  ${getInstallHint(key)}`,
                is_error: true
            };
        }
        return runCli(agent.cmd, agent.args(task), task, options.timeout);
    }

    // API 型：留接口（需要 API Key）
    if (agent.type === 'api') {
        const apiKey = process.env[getEnvKeyName(key)] || options.apiKey;
        if (!apiKey) {
            return {
                content: `${agent.label} 需要 API Key。\n请设置环境变量 ${getEnvKeyName(key)}，或在调用时传入 apiKey 参数。\n配置示例:\n  export ${getEnvKeyName(key)}=你的key\n基准地址: ${agent.baseUrl}\n模型: ${agent.model}`,
                is_error: true
            };
        }
        return callOpenAICompatApi(agent, task, apiKey, options);
    }

    // MCP 型：留接口（需要外部 MCP 服务器）
    if (agent.type === 'mcp') {
        return {
            content: `${agent.label} 需要通过 MCP 协议连接。\n可在 Simona Code 的 .mcp.json 中注册对应 MCP 服务器后，改用 MCP 工具调用。\n这是预留接口，当前版本请先安装/配置 MCP。\n\nSimona 原生 CLI 智能体（可直接用）: simona-code, codex, qoder, cursor, opencode, cline`,
            is_error: true
        };
    }

    return { content: `不支持的智能体类型: ${agent.type}`, is_error: true };
}

// ── OpenAI 兼容 API 调用（MiniMax / 智谱通用）──
async function callOpenAICompatApi(agent, task, apiKey, options) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeout || 300000);
        const res = await fetch(`${agent.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: options.model || agent.model,
                messages: [
                    { role: 'user', content: task }
                ],
                temperature: options.temperature || 0.7
            }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const data = await res.json();
        if (!res.ok) {
            return { content: `${agent.label} API 错误 (${res.status}): ${JSON.stringify(data).slice(0, 500)}`, is_error: true };
        }
        const content = data?.choices?.[0]?.message?.content || '(无内容返回)';
        return { content, is_error: false };
    } catch (err) {
        return { content: `${agent.label} 调用失败: ${err.message}`, is_error: true };
    }
}

// ── 工具函数 ──
function getEnvKeyName(agentKey) {
    const map = {
        'minimax': 'MINIMAX_API_KEY',
        'zhipu-glm': 'ZHIPU_API_KEY',
        'trae': 'TRAE_API_KEY',
        'workbuddy': 'WORKBUDDY_API_KEY',
    };
    return map[agentKey] || `${agentKey.toUpperCase()}_API_KEY`;
}

function getInstallHint(agentKey) {
    const hints = {
        'simona-code': '  官方安装: https://docs.simona.com/simona-code',
        'codex': '  npm install -g @openai/codex  (或访问 https://codex.openai.com)',
        'qoder': '  npm install -g @qoder-ai/qodercli  (或 curl 安装脚本)',
        'cursor': '  从官网 https://cursor.com 安装 Cursor 桌面版',
        'opencode': '  npm install -g opencode-ai  (阿里云百炼 OpenCode)',
        'cline': '  npm install -g @cline/cli  (或 VS Code 插件)',
    };
    return hints[agentKey] || `请访问 ${agentKey} 官网安装 CLI`;
}

// ── 列出所有可用智能体 ──
async function listAgents() {
    const lines = [];
    for (const [key, agent] of Object.entries(AGENTS)) {
        const typeLabel = agent.type === 'cli' ? 'CLI' : agent.type === 'api' ? 'API' : 'MCP';
        const status = agent.type === 'cli'
            ? (await checkCliInstalled(agent)) ? '✅ 已安装' : '❌ 未安装'
            : (agent.type === 'api' && process.env[getEnvKeyName(key)]) ? '✅ 已配置Key' : '⏳ 待配置';
        lines.push(`  ${key}: ${agent.label} [${typeLabel}] ${status}`);
    }
    return lines.join('\n');
}

module.exports = { invokeAgent, listAgents, AGENTS };