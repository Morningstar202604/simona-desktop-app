#!/usr/bin/env bash
# Simona Mobile 一键构建脚本
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# 环境变量（可覆盖）
GRADLE_BIN="${GRADLE_BIN:-D:/Android/gradle-8.10.2/bin/gradle}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-D:/Android}"
export ANDROID_HOME="${ANDROID_HOME:-D:/Android}"

echo "=== 第1步: 构建 Simona Web 前端 ==="
cd "$ROOT/.."
npm run build:web
echo "Web 前端构建完成"

echo "=== 第2步: 准备 Android 资产 ==="
cd "$ROOT"
mkdir -p app/src/main/assets/simona-dist
cp -r ../dist/* app/src/main/assets/simona-dist/ 2>/dev/null || echo "警告: dist 目录为空"
cp -r ../electron/*.cjs app/src/main/assets/ 2>/dev/null || true

echo "=== 第3步: 构建 APK ==="
"$GRADLE_BIN" :app:assembleDebug

APK="app/build/outputs/apk/debug/app-debug.apk"
if [ ! -f "$APK" ]; then
    echo "构建失败: 未找到 $APK" >&2
    exit 1
fi

VERSION_NAME="1.0.0"
OUT="SimonaMobile-arm64-v${VERSION_NAME}.apk"
cp "$APK" "$OUT"
echo "=== 构建成功 ==="
echo "原始产物: $ROOT/$APK"
echo "版本命名: $ROOT/$OUT"