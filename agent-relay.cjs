const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const RELAY_URL = 'wss://example.com';
const TOKEN = 'simona-relay-2024';
const LOCAL_BRIDGE = 'http://127.0.0.1:30080';

const userId = process.argv[2];
if (!userId) {
  console.error('用法: node agent-relay.js <userId>');
  process.exit(1);
}

function getMachineId() {
  const machineInfo = os.hostname() + os.platform() + os.arch();
  return crypto.createHash('md5').update(machineInfo).digest('hex');
}

function getDeviceInfo() {
  const idPath = path.join(__dirname, 'device-id.json');
  try {
    if (fs.existsSync(idPath)) {
      return JSON.parse(fs.readFileSync(idPath, 'utf8'));
    }
  } catch (_) {}

  const deviceId = getMachineId().slice(0, 12) + '-' + Math.random().toString(36).slice(2, 6);
  const deviceInfo = { deviceId, deviceName: os.hostname() };
  try {
    fs.writeFileSync(idPath, JSON.stringify(deviceInfo, null, 2));
  } catch (_) {}
  return deviceInfo;
}

const { deviceId, deviceName } = getDeviceInfo();

console.log(`[${new Date().toISOString()}] 启动 Agent 中继客户端`);
console.log(`用户ID: ${userId}`);
console.log(`设备ID: ${deviceId}`);
console.log(`设备名称: ${deviceName}`);
console.log(`中继服务器: ${RELAY_URL}`);
console.log(`本地桥接: ${LOCAL_BRIDGE}`);

function connect() {
  const url = `${RELAY_URL}/api/agent/${userId}/ws?type=agent&userId=${userId}&deviceId=${deviceId}&deviceName=${encodeURIComponent(deviceName)}&token=${TOKEN}`;
  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log(`[${new Date().toISOString()}] 已连接到中继服务器 (设备: ${deviceName})`);
    ws._hbTimer = setTimeout(() => {
      console.log(`[${new Date().toISOString()}] 心跳超时，正在重连...`);
      ws.terminate();
    }, 90000);
  });

  ws.on('ping', () => {
    clearTimeout(ws._hbTimer);
    ws._hbTimer = setTimeout(() => {
      console.log(`[${new Date().toISOString()}] 心跳超时，正在重连...`);
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
        timeout: 25000,
      };

      const req = http.request(url, options, (res) => {
        let firstChunk = true;
        res.on('data', c => {
          const chunkStr = c.toString();
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
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
          } else {
            const response = {
              type: 'http_response_chunk',
              reqId: msg.reqId,
              body: chunkStr,
            };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
          }
        });
        res.on('end', () => {
          if (firstChunk) {
            const response = {
              type: 'http_response',
              streaming: true,
              reqId: msg.reqId,
              status: res.statusCode,
              headers: res.headers,
              body: '',
            };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
          }
          const endMsg = { type: 'http_response_end', reqId: msg.reqId };
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(endMsg));
        });
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
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
          ws.send(JSON.stringify({ type: 'http_response_end', reqId: msg.reqId }));
        }
      });

      if (msg.body) req.write(msg.body);
      req.end();
    } catch (e) {
      console.error('消息处理错误:', e);
    }
  });

  ws.on('close', (code, reason) => {
    clearTimeout(ws._hbTimer);
    const reasonStr = (reason && reason.toString()) || '';
    console.log(`[${new Date().toISOString()}] 连接关闭: ${code} ${reasonStr}`);
    if (code === 4003 && reasonStr.includes('already connected')) {
      console.log('另一实例已连接，本实例退出');
      return;
    }
    console.log('5秒后重连...');
    setTimeout(connect, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket错误:', err.message);
  });
}

connect();
