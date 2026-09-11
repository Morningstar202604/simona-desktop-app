#!/bin/bash
# Simona 后端启动脚本 - 在 proot 内 Ubuntu rootfs 中执行
# 所有工具（ripgrep, git, curl, npm, pip3）由 BackendService.kt 的 installVendorBinaries 安装
set -e

echo "=== Simona 后端启动 ==="

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="/root"
export USE_BUILTIN_RIPGREP=0
# proot IS a sandbox — skip the engine's root-user safety check for bypassPermissions
export IS_SANDBOX=1

SERVER_DIR="/root/simona"

# 创建引擎路径软链接
# bridge-server 用 path.join(__dirname, '..', 'engine') 解析引擎路径
# __dirname=/root/simona/ → 引擎路径 = /root/engine/
# 但 ensureAssetsUpdated 把文件复制到 /root/simona/engine/
if [ ! -L "/root/engine" ] && [ -d "$SERVER_DIR/engine" ]; then
    echo "创建引擎路径软链接: /root/engine -> $SERVER_DIR/engine"
    ln -sf "$SERVER_DIR/engine" /root/engine
    echo "软链接创建完成"
fi

NODE_BIN="/usr/local/bin/node"
PORT="${PORT:-30080}"
HOST="${HOST:-0.0.0.0}"

# 检查 Node.js
if [ ! -f "$NODE_BIN" ]; then
    echo "错误: Node.js 未找到 ($NODE_BIN)"
    exit 1
fi

echo "Node.js: $($NODE_BIN --version)"
echo "端口: $PORT"
echo "主机: $HOST"

# 启动 bridge-server
if [ -f "$SERVER_DIR/bridge-server.cjs" ]; then
    echo "启动 bridge-server..."
    cd "$SERVER_DIR"
    $NODE_BIN bridge-server.cjs --port $PORT --host $HOST &
    PID=$!
    echo "bridge-server PID: $PID"
    echo $PID > /tmp/bridge-server.pid
    echo "bridge-server 已启动"
else
    echo "警告: bridge-server.cjs 未找到，尝试查找..."
    find /root -name "bridge-server.cjs" -type f 2>/dev/null | head -5
fi

# 启动 engine (Bun) - 如果存在
if command -v bun &> /dev/null; then
    echo "Bun 已安装: $(bun --version)"
    if [ -d "$SERVER_DIR/engine" ]; then
        echo "启动 engine..."
        cd "$SERVER_DIR/engine"
        bun run start &
        echo "engine 已启动"
    fi
else
    echo "Bun 未安装，engine 将不会启动"
fi

echo "=== Simona 后端启动完成 ==="
echo "Web UI: http://$HOST:$PORT"

# 保持进程运行
wait
