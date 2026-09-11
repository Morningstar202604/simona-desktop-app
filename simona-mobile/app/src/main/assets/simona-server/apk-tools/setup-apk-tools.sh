#!/bin/bash
# ============================================================
# setup-apk-tools.sh — Simona APK 构建工具链 预装脚本（方案 B 精简 JDK）
#
# 作用：
#   1) apt 安装「精简 JDK」openjdk-17-jre-headless（仅运行时；
#      用于运行 d8.jar / apksigner.jar，无需编译器，体积更小）
#   2) apt 安装 aapt / zipalign（arm64 原生资源打包/对齐工具）
#   3) 部署 APK 内置的 android.jar / d8.jar / apksigner.jar 到 /usr/local/apk-tools
#   4) 生成 apkbuild 环境脚本
#
# 幂等：检测到 /usr/local/apk-tools/.installed 即跳过。
# 在 proot 内以 root 运行；由 BackendService 首次启动时后台自动调用。
# ============================================================
set -u

TOOLS_DIR="/usr/local/apk-tools"
SRC_DIR="/root/simona/apk-tools"
MARKER="$TOOLS_DIR/.installed"

export DEBIAN_FRONTEND=noninteractive
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

log() { echo "[apk-tools] $*"; }

# 已安装则直接退出
if [ -f "$MARKER" ] && [ -x "$(command -v java)" ]; then
    log "APK 工具链已安装，跳过"
    exit 0
fi

log "=== 开始预装 APK 构建工具链（精简 JDK）==="
log "架构: $(uname -m)"
mkdir -p "$TOOLS_DIR"

# 0) 确认 apt 源可用；失败时切换中科大镜像（国内加速）
if ! apt-get update -qq 2>/dev/null; then
    log "默认 apt 源不可达，切换中科大镜像..."
    cat > /etc/apt/sources.list.d/ubuntu.sources <<'EOF'
Types: deb
URIs: http://mirrors.ustc.edu.cn/ubuntu-ports/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://mirrors.ustc.edu.cn/ubuntu-ports/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
    apt-get update -qq || log "警告：镜像源 update 也失败"
fi

# 1) 精简 JDK：openjdk-17-jre-headless（仅运行时，运行 d8/apksigner）
if ! command -v java >/dev/null 2>&1; then
    log "安装 openjdk-17-jre-headless ..."
    apt-get install -y --no-install-recommends openjdk-17-jre-headless \
        || { log "错误：openjdk-17-jre-headless 安装失败"; exit 1; }
fi
log "java: $(java -version 2>&1 | head -1)"

# 2) 资源打包/对齐工具（arm64 原生）
if ! command -v aapt >/dev/null 2>&1; then
    log "安装 aapt ..."
    apt-get install -y --no-install-recommends aapt || log "警告：aapt 安装失败"
fi
if command -v aapt >/dev/null 2>&1; then
    log "aapt: $(aapt version 2>&1 | head -1)"
fi

if ! command -v zipalign >/dev/null 2>&1; then
    log "安装 zipalign ..."
    apt-get install -y --no-install-recommends zipalign || log "警告：zipalign 安装失败（可后续手动安装）"
fi
if command -v zipalign >/dev/null 2>&1; then
    log "zipalign: 可用"
fi

# 3) 部署 APK 内置 jar（跨架构，纯 Java）
for f in android.jar d8.jar apksigner.jar; do
    if [ -f "$SRC_DIR/$f" ]; then
        cp -f "$SRC_DIR/$f" "$TOOLS_DIR/$f"
        log "已部署 $f ($(du -h "$TOOLS_DIR/$f" 2>/dev/null | cut -f1))"
    else
        log "警告：预置文件缺失 $SRC_DIR/$f"
    fi
done

# 4) 生成 apkbuild 环境脚本（供 bridge-server / 用户调用）
cat > "$TOOLS_DIR/apkbuild.sh" <<'EOF'
#!/bin/bash
# Simona APK 构建工具链环境
# 用法: bash /usr/local/apk-tools/apkbuild.sh
export ANDROID_JAR=/usr/local/apk-tools/android.jar
export D8_JAR=/usr/local/apk-tools/d8.jar
export APKSIGNER_JAR=/usr/local/apk-tools/apksigner.jar
echo "== Simona APK 构建工具链 =="
echo "java      : $(java -version 2>&1 | head -1)"
echo "aapt      : $(aapt version 2>&1 | head -1)"
echo "zipalign  : $(command -v zipalign >/dev/null 2>&1 && echo OK || echo 未安装)"
echo "android.jar: $ANDROID_JAR"
echo "d8.jar     : $D8_JAR"
echo "apksigner  : $APKSIGNER_JAR"
echo
echo "示例（生成 APK）:"
echo '  aapt package -f -M AndroidManifest.xml -S res -I $ANDROID_JAR -F app.apk'
echo '  java -cp $D8_JAR com.android.tools.r8.D8 --output out classes.dex'
echo '  java -jar $APKSIGNER_JAR sign --ks my.keystore --ks-pass pass:xxx app.apk'
EOF
chmod +x "$TOOLS_DIR/apkbuild.sh"

# 5) 标记完成
touch "$MARKER"
log "=== APK 构建工具链预装完成 ==="
log "查看工具链: bash /usr/local/apk-tools/apkbuild.sh"