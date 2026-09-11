#!/bin/bash
# Simona 环境初始化脚本 - 在 proot 内 Ubuntu rootfs 中执行
# 所有工具（ripgrep, git, curl, npm, pip3）由 BackendService.kt 的 installVendorBinaries 安装
set -e

echo "=== Simona 环境初始化 ==="

# 设置 PATH
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export DEBIAN_FRONTEND=noninteractive

# 创建必要目录
mkdir -p /root/simona
mkdir -p /root/.node

# Create default .simona.json to suppress "configuration file not found" warnings
echo '{}' > /root/.simona.json 2>/dev/null || true

# 设置 locale
echo "en_US.UTF-8 UTF-8" > /etc/locale.gen 2>/dev/null || true
echo "LANG=en_US.UTF-8" > /etc/default/locale 2>/dev/null || true
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

echo "=== 初始化完成 ==="
