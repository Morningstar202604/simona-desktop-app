// test-basic.cjs — 简单 Node.js 测试脚本
const fs = require('fs');
const path = require('path');

const logFile = '/root/simona/test-output.txt';
const ts = new Date().toISOString();

function log(msg) {
    try {
        fs.appendFileSync(logFile, `[${ts}] ${msg}\n`);
    } catch (e) {}
    console.log(msg);
}

log('TEST_SCRIPT_START');
log('CWD: ' + process.cwd());
log('HOME: ' + (process.env.HOME || 'NOT_SET'));
log('NODE_PATH: ' + (process.env.NODE_PATH || 'NOT_SET'));
log('NODE_VERSION: ' + process.version);
log('TEST_SCRIPT_END');