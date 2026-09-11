const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

// ===== 安卓端适配 =====
// Relay 服务器地址（与桌面端一致）
const RELAY_URL = 'wss://example.com';
const TOKEN = 'simona-relay-2024';
const LOCAL_BRIDGE = 'http://127.0.0.1:30080';

let ws = null;
let reconnectTimer = null;
let checkTimer = null;
let isRunning = false;

// 安卓设备名获取：proot 内 os.hostname() 可能返回不确定的值
// 尝试从 /system/build.prop 读取设备型号，失败则 fallback
function getAndroidDeviceName() {
    // 尝试 1: 环境变量（BackendService 可设置）
    if (process.env.ANDROID_DEVICE_MODEL) {
        return process.env.ANDROID_DEVICE_MODEL;
    }
    // 尝试 2: 读取 build.prop（proot 中 /system 可访问）
    try {
        const buildProp = fs.readFileSync('/system/build.prop', 'utf8');
        const modelMatch = buildProp.match(/^ro\.product\.model=(.+)$/m);
        if (modelMatch) return modelMatch[1].trim();
    } catch (_) {}
    // 尝试 3: os.hostname()
    const hostname = os.hostname();
    if (hostname && hostname !== 'localhost' && hostname.length > 1) {
        return 'Android-' + hostname;
    }
    // 兜底
    return 'Android-Device';
}

function getMachineId() {
    // 安卓端用设备名 + 平台 + 架构生成 machineId
    const machineInfo = getAndroidDeviceName() + os.platform() + os.arch();
    return crypto.createHash('md5').update(machineInfo).digest('hex');
}

function getDeviceInfo(userDataPath) {
    const idPath = path.join(userDataPath, 'device-id.json');
    try {
        if (fs.existsSync(idPath)) {
            return JSON.parse(fs.readFileSync(idPath, 'utf8'));
        }
    } catch (_) {}

    const deviceId = getMachineId().slice(0, 12) + '-' + Math.random().toString(36).slice(2, 6);
    const deviceName = getAndroidDeviceName();
    const deviceInfo = { deviceId, deviceName };
    try {
        fs.writeFileSync(idPath, JSON.stringify(deviceInfo, null, 2));
    } catch (_) {}
    return deviceInfo;
}

function getUserId(userDataPath) {
    const jwtPath = path.join(userDataPath, 'jwt-token.json');
    try {
        if (fs.existsSync(jwtPath)) {
            const data = JSON.parse(fs.readFileSync(jwtPath, 'utf8'));
            if (data.email) {
                return data.email.replace(/@/g, '_').replace(/\./g, '_');
            }
        }
    } catch (_) {}
    return null;
}

function connect(userDataPath) {
    const userId = getUserId(userDataPath);
    if (!userId) {
        console.log('[AgentRelay] No userId (not logged in), will retry later');
        scheduleReconnect(userDataPath, 30000);
        return;
    }

    const { deviceId, deviceName } = getDeviceInfo(userDataPath);

    console.log(`[AgentRelay] Connecting as ${userId} device:${deviceId} (${deviceName})...`);
    const url = `${RELAY_URL}/api/agent/${userId}/ws?type=agent&userId=${userId}&deviceId=${deviceId}&deviceName=${encodeURIComponent(deviceName)}&token=${TOKEN}`;

    try {
        ws = new WebSocket(url);

        ws.on('open', () => {
            console.log(`[AgentRelay] Connected (userId: ${userId}, device: ${deviceName})`);
            isRunning = true;
            ws._hbTimer = setTimeout(() => {
                console.log('[AgentRelay] Heartbeat timeout (no ping from server), reconnecting...');
                ws.terminate();
            }, 90000);
        });

        ws.on('ping', () => {
            clearTimeout(ws._hbTimer);
            ws._hbTimer = setTimeout(() => {
                console.log('[AgentRelay] Heartbeat timeout (no ping from server), reconnecting...');
                ws.terminate();
            }, 90000);
        });

        ws.on('message', async (data) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type !== 'http_request') return;

                const url = `${LOCAL_BRIDGE}${msg.path}`;
                const cleanHeaders = {};
                for (const [k, v] of Object.entries(msg.headers || {})) {
                    if (v !== undefined && v !== null) cleanHeaders[k] = v;
                }
                cleanHeaders.host = new URL(LOCAL_BRIDGE).host;

                const options = {
                    method: msg.method,
                    headers: cleanHeaders,
                    timeout: 600000,  // 10 分钟 — AI 对话流式响应需要足够长时间
                };

                const req = http.request(url, options, (res) => {
                    const ct = (res.headers['content-type'] || '');
                    const isBinary = /^image\//.test(ct) || /^audio\//.test(ct) || /^video\//.test(ct);
                    if (isBinary) {
                        const chunks = [];
                        res.on('data', c => chunks.push(c));
                        res.on('end', () => {
                            const fullBuf = Buffer.concat(chunks);
                            const response = {
                                type: 'http_response',
                                streaming: false,
                                reqId: msg.reqId,
                                status: res.statusCode,
                                headers: { ...res.headers, 'x-content-transfer-encoding': 'base64' },
                                body: fullBuf.toString('base64'),
                            };
                            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'http_response_end', reqId: msg.reqId }));
                        });
                    } else {
                        let firstChunk = true;
                        const decoder = new StringDecoder('utf8');
                        res.on('data', c => {
                            const chunkStr = decoder.write(c);
                            if (chunkStr.length === 0) return;
                            if (firstChunk) {
                                firstChunk = false;
                                const response = {
                                    type: 'http_response',
                                    streaming: true,
                                    reqId: msg.reqId,
                                    status: res.statusCode,
                                    headers: res.headers,
                                    body: chunkStr,
                                };
                                if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                            } else {
                                const response = {
                                    type: 'http_response_chunk',
                                    reqId: msg.reqId,
                                    body: chunkStr,
                                };
                                if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                            }
                        });
                        res.on('end', () => {
                            const tailStr = decoder.end();
                            if (tailStr.length > 0) {
                                if (firstChunk) {
                                    firstChunk = false;
                                    const response = {
                                        type: 'http_response',
                                        streaming: true,
                                        reqId: msg.reqId,
                                        status: res.statusCode,
                                        headers: res.headers,
                                        body: tailStr,
                                    };
                                    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                                } else {
                                    const response = {
                                        type: 'http_response_chunk',
                                        reqId: msg.reqId,
                                        body: tailStr,
                                    };
                                    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                                }
                            }
                            if (firstChunk) {
                                const response = {
                                    type: 'http_response',
                                    streaming: true,
                                    reqId: msg.reqId,
                                    status: res.statusCode,
                                    headers: res.headers,
                                    body: '',
                                };
                                if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
                            }
                            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'http_response_end', reqId: msg.reqId }));
                        });
                    }
                });

                req.on('timeout', () => { req.destroy(); });

                req.on('error', (e) => {
                    const response = {
                        type: 'http_response',
                        streaming: true,
                        reqId: msg.reqId,
                        status: 502,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ error: 'Bridge connection failed: ' + e.message }),
                    };
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify(response));
                        ws.send(JSON.stringify({ type: 'http_response_end', reqId: msg.reqId }));
                    }
                });

                if (msg.body) req.write(msg.body);
                req.end();
            } catch (e) {
                console.error('[AgentRelay] Message handling error:', e.message);
            }
        });

        ws.on('close', (code, reason) => {
            if (!ws) return;
            clearTimeout(ws._hbTimer);
            const reasonStr = (reason && reason.toString()) || '';
            console.log(`[AgentRelay] Connection closed: ${code} ${reasonStr}`);
            isRunning = false;
            ws = null;
            if (code === 4003 && reasonStr.includes('already connected')) {
                console.log('[AgentRelay] Another instance already connected, exiting');
                return;
            }
            scheduleReconnect(userDataPath, 5000);
        });

        ws.on('error', (err) => {
            console.error(`[AgentRelay] WebSocket error: ${err.message}`);
        });
    } catch (err) {
        console.error(`[AgentRelay] Failed to create WebSocket: ${err.message}`);
        isRunning = false;
        ws = null;
        scheduleReconnect(userDataPath, 5000);
    }
}

function scheduleReconnect(userDataPath, delayMs) {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!isRunning) {
            connect(userDataPath);
        }
    }, delayMs);
}

function startAgentRelay(userDataPath) {
    if (!userDataPath) {
        console.error('[AgentRelay] userDataPath is required');
        return;
    }

    console.log('[AgentRelay] Starting agent relay service (Android)...');
    console.log('[AgentRelay] userDataPath:', userDataPath);
    console.log('[AgentRelay] Device name:', getAndroidDeviceName());

    const userId = getUserId(userDataPath);
    if (userId) {
        connect(userDataPath);
    } else {
        console.log('[AgentRelay] No login detected, will check periodically');
    }

    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(() => {
        if (isRunning) return;
        const userId = getUserId(userDataPath);
        if (userId) {
            console.log(`[AgentRelay] Login detected (${userId}), connecting relay...`);
            connect(userDataPath);
        }
    }, 30000);
}

function stopAgentRelay() {
    console.log('[AgentRelay] Stopping agent relay service...');
    isRunning = false;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
    }
    if (ws) {
        try {
            ws.close();
        } catch (_) {}
        ws = null;
    }
    console.log('[AgentRelay] Stopped');
}

module.exports = { startAgentRelay, stopAgentRelay };
