package com.simona.mobile.service

import android.app.*
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.provider.Settings
import androidx.core.app.NotificationCompat
import com.simona.mobile.MainActivity
import com.simona.mobile.R
import com.simona.mobile.SimonaApp
import com.simona.mobile.proot.ProotManager
import com.simona.mobile.util.TarGzipExtractor
import java.io.BufferedReader
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit
import java.util.zip.ZipFile

/**
 * 前台服务：保持 Simona 后端在后台运行
 * 所有耗时操作都在后台线程执行，避免阻塞主线程导致 ANR
 */
class BackendService : Service() {

    private val prootManager by lazy { ProotManager(this) }

    companion object {
        const val ACTION_START = "com.simona.mobile.START"
        const val ACTION_STOP = "com.simona.mobile.STOP"
    }

    private var bridgeProcess: Process? = null
    private var keepAliveRunning = false
    private var keepAliveThread: Thread? = null
    private var accessibilityNotified = false

    override fun onCreate() {
        super.onCreate()
        startForeground(SimonaApp.NOTIF_ID, buildNotification("Simona 启动中...", "后端服务正在启动"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopBridge()
                stopKeepAlive()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                startBridge()
                startKeepAlive()
            }
        }
        return START_STICKY
    }

    /** 启动后端：全部在后台线程执行，避免 ANR */
    private fun startBridge() {
        Thread {
            try {
                prootManager.ensureRuntimeFiles()
                val rootfsDir = File(filesDir, "linux/ubuntu")

                // 准备/迁移外部持久化数据到 /storage/emulated/0/Simona/data/。
                // 必须在任何 proot 命令执行前调用：proot 启动时会把该目录 bind 到 rootfs 内路径，
                // 这样才能在 bind 生效前完成首次数据迁移（rootfs 内部目录尚未被外部目录遮蔽）。
                try {
                    preparePersistentData(rootfsDir)
                } catch (e: Exception) {
                    android.util.Log.w("Simona", "外部数据准备失败: ${e.message}")
                }

                // 先确保引擎已安装（不依赖 prootManager.isInstalled()）。
                // 覆盖安装场景：SetupActivity 可能不重新运行 installEngine，
                // 而 prootManager.isInstalled() 可能返回 false，导致 ensureAssetsUpdated 跳过。
                if (rootfsDir.exists()) {
                    ensureEngineInstalled(rootfsDir)
                }

                if (!prootManager.isInstalled()) {
                    updateNotification("Simona 未安装", "请先完成首次设置")
                    return@Thread
                }
                val nodeInRootfs = File(rootfsDir, "usr/local/bin/node")
                val serverWrapper = File(rootfsDir, "root/simona/server-wrapper.cjs")
                val simonaDir = File(rootfsDir, "root/simona")
                val serverLogFile = File(simonaDir, "server.log")
                serverLogFile.parentFile?.mkdirs()

                // 升级检测：若 APK 版本与 rootfs 版本不匹配，尝试更新关键资产（不删除 rootfs）
                try {
                    ensureAssetsUpdated(rootfsDir)
                } catch (e: Exception) {
                    android.util.Log.w("Simona", "资产更新跳过: ${e.message}")
                }

                // 安装内建工具二进制至正确位置（ripgrep、git 等）
                installVendorBinaries(rootfsDir)

                // 预装 APK 生成工具链（方案 B 精简 JDK）：后台自动安装，不阻塞启动
                installApkTools(rootfsDir)

                serverLogFile.appendText("\n=== BackendService 启动 ===\n")
                serverLogFile.appendText("proot 路径: ${prootManager.prootPath()}\n")
                serverLogFile.appendText("rootfs 路径: ${prootManager.rootfsDir.absolutePath}\n")
                serverLogFile.appendText("node 存在: ${nodeInRootfs.exists()} size=${if (nodeInRootfs.exists()) nodeInRootfs.length() else 0}\n")
                serverLogFile.appendText("server-wrapper 存在: ${serverWrapper.exists()}\n")
                serverLogFile.appendText("simona 目录内容:\n")
                simonaDir.listFiles()?.forEach { f ->
                    serverLogFile.appendText("  ${f.name} (${if (f.isDirectory) "dir" else f.length()})\n")
                }

                // 测试1: echo + pwd + ls node
                runProotTest(1, "echo PROOT_TEST_OK && pwd && ls -la /usr/local/bin/node 2>&1", serverLogFile)

                // 测试2: node --version
                runProotTest(2, "NODE_PATH=/root/simona/node_modules /usr/local/bin/node --version 2>&1", serverLogFile)

                // 测试3a: node -e console.log (无 require)
                runProotTest(3, "NODE_PATH=/root/simona/node_modules /usr/local/bin/node -e \"console.log('A_OK');\" 2>&1", serverLogFile)

                // 测试3b: node -e require('fs') (内置模块)
                runProotTest(4, "NODE_PATH=/root/simona/node_modules /usr/local/bin/node -e \"require('fs'); console.log('B_OK');\" 2>&1", serverLogFile)

                // 测试3c: node -e require JSON 文件
                runProotTest(5, "NODE_PATH=/root/simona/node_modules /usr/local/bin/node -e \"require('/root/simona/package.json'); console.log('C_OK');\" 2>&1", serverLogFile)

                // 测试3d: node -e require stub-electron（简化版）
                runProotTest(6, "NODE_PATH=/root/simona/node_modules /usr/local/bin/node -e \"require('/root/simona/stub-electron.cjs'); console.log('D_OK');\" 2>&1", serverLogFile)

                // 测试3e: 运行脚本文件（非 -e）
                runProotTest(7, "NODE_PATH=/root/simona/node_modules /usr/local/bin/node /root/simona/test-basic.cjs 2>&1", serverLogFile)

                // 测试3f: bun --version（验证 bun 真正安装成功）
                runProotTest(8, "/usr/local/bin/bun --version 2>&1", serverLogFile)

                // 测试3g: 引擎是否存在（对话功能所需 cli.tsx）
                runProotTest(9, "ls -la /root/engine/src/entrypoints/cli.tsx /root/engine/.env 2>&1", serverLogFile)

                // 实际启动 bridge-server
                if (nodeInRootfs.exists() && serverWrapper.exists()) {
                    android.util.Log.i("Simona", "启动 bridge-server")
                    serverLogFile.appendText("--- 启动 bridge-server ---\n")
                    val cmd = "NODE_PATH=/root/simona/node_modules /usr/local/bin/node /root/simona/server-wrapper.cjs 2>&1"
                    bridgeProcess = prootManager.execRootfs(cmd)
                    startBridgeLogger(bridgeProcess, serverLogFile)
                    updateNotification("Simona 运行中", "Web UI: http://127.0.0.1:30080")
                    // 检查无障碍服务是否已开启
                    if (!isAccessibilityServiceEnabled()) {
                        notifyAccessibilityDisabled()
                        accessibilityNotified = true
                    }
                } else {
                    val missing = mutableListOf<String>()
                    if (!nodeInRootfs.exists()) missing.add("node")
                    if (!serverWrapper.exists()) missing.add("server-wrapper.cjs")
                    serverLogFile.appendText("后端文件缺失: ${missing.joinToString(", ")}\n")
                    updateNotification("Simona 等待中", "文件缺失: ${missing.joinToString(", ")}")
                }
            } catch (e: Exception) {
                android.util.Log.e("Simona", "启动失败", e)
                try {
                    val logFile = File(filesDir, "linux/ubuntu/root/simona/server.log")
                    logFile.parentFile?.mkdirs()
                    logFile.appendText("=== 启动异常: ${e.message} ===\n")
                } catch (_: Exception) {}
                updateNotification("Simona 启动失败", e.message ?: "未知错误")
            }
        }.apply {
            isDaemon = true
            name = "simona-bridge-start"
            start()
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // 升级资产更新：当 APK 升级后，Android 保留旧 rootfs，SetupActivity 不重新运行。
    // 此处确保新 APK 中的 bun、bridge-server、skills、providers 等关键文件
    // 被复制到 rootfs，避免用户遇到 "spawn bun ENOENT" 或工作区仍指向服务器目录。
    // ═══════════════════════════════════════════════════════════════════
    private fun ensureAssetsUpdated(rootfsDir: File) {
        val simonaDir = File(rootfsDir, "root/simona")
        if (!simonaDir.exists()) return

        // 1. 创建手机存储挂载点（升级场景：旧 rootfs 没有 sdcard/storage 目录）
        File(rootfsDir, "sdcard").mkdirs()
        File(rootfsDir, "storage").mkdirs()
        File(rootfsDir, "root/engine/bin").mkdirs()

        // 2. 确保 bun 已安装（升级场景：旧 APK 的 installBun 只下载不解压）
        ensureBunInstalled(rootfsDir)

        // 2.5 确保引擎已正确解压到 /root/engine
        // （升级场景：旧 APK 可能从未解压 engine，或旧 engine 打包缺少 engine/ 前缀，
        //   导致 /root/engine/src/entrypoints/cli.tsx 缺失 → bun 报 Module not found）
        ensureEngineInstalled(rootfsDir)

        // 3. 从 APK 更新关键服务器文件（升级场景：旧 rootfs 没有 skills/providers/MOBILE 修复）
        try {
            ZipFile(packageCodePath).use { z ->
                val entries = z.entries()
                while (entries.hasMoreElements()) {
                    val e = entries.nextElement()
                    val name = e.name
                    val isSrv = name.startsWith("assets/simona-server/")
                    val isDist = name.startsWith("assets/simona-dist/")
                    if ((isSrv || isDist) && !e.isDirectory) {
                        val base = if (isSrv) "assets/simona-server/" else "assets/simona-dist/"
                        val relPath = name.removePrefix(base)
                        // simona-server -> /root/simona/ ; simona-dist(Web前端) -> /root/simona/dist
                        val dest = if (isSrv) File(simonaDir, relPath)
                                   else File(simonaDir, "dist/" + relPath)
                        // 只更新关键文件，跳过 node_modules（保留已安装的依赖）
                        if (relPath.startsWith("node_modules/") && !relPath.startsWith("node_modules/ws/")) continue
                        // 跳过持久化目录（已软链接到 /sdcard/Simona/data/，避免覆盖用户数据）
                        if (relPath.startsWith("sessions/") ||
                            relPath.startsWith("skills/") ||
                            relPath.startsWith("config/")) continue
                        dest.parentFile?.mkdirs()
                        z.getInputStream(e).use { input ->
                            FileOutputStream(dest).use { out -> input.copyTo(out, bufferSize = 65536) }
                        }
                        // 设置可执行权限（关键文件）
                        if (isSrv && (relPath.endsWith(".cjs") || relPath.endsWith(".js") || relPath.endsWith("bun")))
                            dest.setExecutable(true)
                    }
                }
            }
            android.util.Log.i("Simona", "升级资产更新完成")
        } catch (e: Exception) {
            android.util.Log.e("Simona", "升级资产更新失败", e)
        }
    }

    /**
     * 安装内建工具二进制至正确位置（ripgrep、git）。
     * ensureAssetsUpdated 把文件复制到 /root/simona/...，
     * 但引擎在 /root/engine/... 查找。
     * 此函数将二进制从 /root/simona/ 复制到引擎/PATH 期望的位置并设置可执行权限。
     * 全部内置在 APK 中，零下载。
     */
    private fun installVendorBinaries(rootfsDir: File) {
        try {
            // 1. ripgrep → /root/engine/src/.../vendor/ripgrep/arm64-linux/rg
            for (dir in listOf("src", "dist")) {
                val src = File(rootfsDir, "root/simona/engine/$dir/utils/vendor/ripgrep/arm64-linux/rg")
                val dst = File(rootfsDir, "root/engine/$dir/utils/vendor/ripgrep/arm64-linux/rg")
                if (src.exists()) {
                    dst.parentFile?.mkdirs()
                    src.copyTo(dst, overwrite = true)
                    dst.setExecutable(true)
                    android.util.Log.i("Simona", "ripgrep installed: ${dst.absolutePath} (${dst.length()} bytes)")
                }
            }

            // 2. git → /usr/local/bin/git
            val gitSrc = File(rootfsDir, "root/simona/usr-local-bin/git")
            val gitDst = File(rootfsDir, "usr/local/bin/git")
            if (gitSrc.exists()) {
                gitDst.parentFile?.mkdirs()
                gitSrc.copyTo(gitDst, overwrite = true)
                gitDst.setExecutable(true)
                android.util.Log.i("Simona", "git installed: ${gitDst.absolutePath} (${gitDst.length()} bytes)")
            }

            // 3. curl → /usr/local/bin/curl（静态二进制，零依赖）
            val curlSrc = File(rootfsDir, "root/simona/usr-local-bin/curl")
            val curlDst = File(rootfsDir, "usr/local/bin/curl")
            if (curlSrc.exists()) {
                curlDst.parentFile?.mkdirs()
                curlSrc.copyTo(curlDst, overwrite = true)
                curlDst.setExecutable(true)
                android.util.Log.i("Simona", "curl installed: ${curlDst.absolutePath} (${curlDst.length()} bytes)")
            }

            // 4. npm → /usr/local/bin/npm + /usr/local/lib/node_modules/npm
                        // npm: create shell wrapper scripts (fix require path)
            val npmWrapperSrc = File(rootfsDir, "root/simona/npm_assets/npm-wrapper.sh")
            val npmBinDst = File(rootfsDir, "usr/local/bin/npm")
            if (npmWrapperSrc.exists()) {
                npmBinDst.parentFile?.mkdirs()
                npmWrapperSrc.copyTo(npmBinDst, overwrite = true)
                npmBinDst.setExecutable(true)
                android.util.Log.i("Simona", "npm wrapper created: ${npmBinDst.absolutePath}")
            }
            val npxWrapperSrc = File(rootfsDir, "root/simona/npm_assets/npx-wrapper.sh")
            val npxBinDst = File(rootfsDir, "usr/local/bin/npx")
            if (npxWrapperSrc.exists()) {
                npxBinDst.parentFile?.mkdirs()
                npxWrapperSrc.copyTo(npxBinDst, overwrite = true)
                npxBinDst.setExecutable(true)
                android.util.Log.i("Simona", "npx wrapper created: ${npxBinDst.absolutePath}")
            }
            val npmModSrc = File(rootfsDir, "root/simona/npm_assets/lib/node_modules/npm")
            val npmModDst = File(rootfsDir, "usr/local/lib/node_modules/npm")
            if (npmModSrc.exists()) {
                npmModDst.parentFile?.mkdirs()
                npmModSrc.copyRecursively(npmModDst, overwrite = true)
                android.util.Log.i("Simona", "npm installed: ${npmBinDst.absolutePath}")
            }

            // 5. pip3 to Python site-packages (from tar to avoid Gradle asset issues)
            val pythonVer = "3.13"
            val sitePkg = File(rootfsDir, "usr/local/lib/python$pythonVer/site-packages")
            sitePkg.mkdirs()
            // aapt auto-decompresses .tar.gz to .tar, so we look for pip.tar
            val pipTar = File(rootfsDir, "root/simona/pip_assets/pip.tar")
            if (pipTar.exists()) {
                try {
                    val proc = Runtime.getRuntime().exec(arrayOf(
                        "tar", "xf", pipTar.absolutePath,
                        "-C", sitePkg.absolutePath
                    ))
                    proc.waitFor()
                    val exitCode = proc.exitValue()
                    if (exitCode == 0) {
                        android.util.Log.i("Simona", "pip3 extracted from tar: ${sitePkg.absolutePath}/pip")
                    } else {
                        android.util.Log.e("Simona", "pip3 tar extraction failed: exit=$exitCode")
                    }
                } catch (e: Exception) {
                    android.util.Log.e("Simona", "pip3 tar extraction error", e)
                }
                // Copy dist-info (small files, should work with File ops)
                val pipInfoSrc = File(rootfsDir, "root/simona/pip_assets/pip-26.2.1.dist-info")
                val pipInfoDst = File(sitePkg, "pip-26.2.1.dist-info")
                if (pipInfoSrc.exists()) {
                    pipInfoDst.parentFile?.mkdirs()
                    pipInfoSrc.copyRecursively(pipInfoDst, overwrite = true)
                }
                android.util.Log.i("Simona", "pip3 installed: ${sitePkg.absolutePath}/pip")
            } else {
                // Fallback: try directory copy
                val pipSrc = File(rootfsDir, "root/simona/pip_assets/pip")
                if (pipSrc.exists()) {
                    val pipDst = File(sitePkg, "pip")
                    pipDst.parentFile?.mkdirs()
                    pipSrc.copyRecursively(pipDst, overwrite = true)
                    val pipInfoSrc = File(rootfsDir, "root/simona/pip_assets/pip-26.2.1.dist-info")
                    val pipInfoDst = File(sitePkg, "pip-26.2.1.dist-info")
                    if (pipInfoSrc.exists()) {
                        pipInfoDst.parentFile?.mkdirs()
                        pipInfoSrc.copyRecursively(pipInfoDst, overwrite = true)
                    }
                    android.util.Log.i("Simona", "pip3 installed (fallback): ${pipDst.absolutePath}")
                }
            }            // 6. Python stdlib modules - use tar for reliable directory copy (zipfile/_path etc.)
            val stdlibTar = File(rootfsDir, "root/simona/python-stdlib.tar")
            val pythonLib = File(rootfsDir, "usr/local/lib/python3.13")
            pythonLib.mkdirs()
            if (stdlibTar.exists()) {
                try {
                    val proc = Runtime.getRuntime().exec(arrayOf(
                        "tar", "xf", stdlibTar.absolutePath,
                        "-C", pythonLib.absolutePath
                    ))
                    proc.waitFor()
                    if (proc.exitValue() == 0) {
                        android.util.Log.i("Simona", "Python stdlib extracted from tar: ${pythonLib.absolutePath}")
                    } else {
                        android.util.Log.e("Simona", "Python stdlib tar extraction failed: exit=${proc.exitValue()}")
                    }
                } catch (e: Exception) {
                    android.util.Log.e("Simona", "Python stdlib tar extraction error", e)
                }
            }
            // Fallback: directory copy if tar not available
            val stdlibSrc = File(rootfsDir, "root/simona/python-stdlib")
            if (stdlibSrc.exists() && stdlibSrc.isDirectory) {
                stdlibSrc.listFiles()?.forEach { entry ->
                    val dst = File(pythonLib, entry.name)
                    if (entry.isDirectory) {
                        entry.copyRecursively(dst, overwrite = true)
                    } else {
                        entry.copyTo(dst, overwrite = true)
                    }
                }
            }
            android.util.Log.i("Simona", "Python stdlib modules ready: ${pythonLib.absolutePath}")

            // 7. Fix inspect.py bug: rename buggy inspect.py (has _rewrite_star_unpack) and use working inspect.pyc
            val inspectPy = File(pythonLib, "inspect.py")
            val inspectPyc = File(pythonLib, "inspect.pyc")
            if (inspectPy.exists() && !File(pythonLib, "inspect.py.bak").exists()) {
                inspectPy.renameTo(File(pythonLib, "inspect.py.bak"))
                android.util.Log.i("Simona", "inspect.py renamed to inspect.py.bak (bug fix)")
            }
            val stdlibInspectPyc = File(stdlibSrc, "inspect.pyc")
            if (stdlibInspectPyc.exists() && !inspectPyc.exists()) {
                stdlibInspectPyc.copyTo(inspectPyc, overwrite = true)
                android.util.Log.i("Simona", "inspect.pyc installed from stdlib")
            }
        } catch (e: Exception) {
            android.util.Log.e("Simona", "installVendorBinaries 失败", e)
        }
    }

    /**
     * 预装 APK 生成工具链（方案 B 精简 JDK）。
     * 首次启动时在 rootfs 内通过 proot 执行 setup-apk-tools.sh：
     *   1) apt 安装 openjdk-17-jre-headless（精简 JDK，仅运行时；运行 d8/apksigner 足够，无需编译器）
     *   2) apt 安装 aapt / zipalign（arm64 原生；zipalign 在 noble 无官方包，失败仅警告）
     *   3) 把 APK 内置 android.jar / d8.jar / apksigner.jar 部署到 /usr/local/apk-tools/
     * 幂等：检测 /usr/local/apk-tools/.installed 标记。后台执行，不阻塞 bridge-server 启动。
     */
    private fun installApkTools(rootfsDir: File) {
        try {
            val marker = File(rootfsDir, "usr/local/apk-tools/.installed")
            if (marker.exists()) {
                android.util.Log.i("Simona", "APK 工具链已安装，跳过")
                return
            }
            val script = File(rootfsDir, "root/simona/apk-tools/setup-apk-tools.sh")
            if (!script.exists()) {
                android.util.Log.i("Simona", "setup-apk-tools.sh 未部署（APK 未内置），跳过预装")
                return
            }
            val logFile = File(rootfsDir, "root/simona/server.log")
            Thread {
                try {
                    logFile.appendText("\n--- 预装 APK 构建工具链（精简 JDK）---\n")
                    val p = prootManager.execRootfs("bash /root/simona/apk-tools/setup-apk-tools.sh 2>&1")
                    val (exit, output) = captureOutputWithTimeout(p, 600) // 最多10分钟
                    logFile.appendText("APK 工具链预装 exit=$exit output=$output\n")
                    android.util.Log.i("Simona", "APK 工具链预装 exit=$exit")
                } catch (e: Exception) {
                    android.util.Log.w("Simona", "APK 工具链预装异常: ${e.message}")
                }
            }.apply {
                isDaemon = true
                name = "simona-apk-tools-install"
                start()
            }
        } catch (e: Exception) {
            android.util.Log.w("Simona", "installApkTools 初始化失败: ${e.message}")
        }
    }

    /**
     * 准备/迁移外部持久化数据。数据存放于 /storage/emulated/0/Simona/data/，
     * 由 ProotManager 在每次 proot 启动时通过 -b bind 挂载到 rootfs 内对应路径。
     * 首次启用：把 rootfs 内已有的用户数据复制到外部存储，之后所有读写都直接命中外部存储。
     * 卸载重装：rootfs 被重建但外部存储保留，bind 自动恢复映射 → 数据不丢失。
     */
    private fun preparePersistentData(rootfsDir: File) {
        val extRoot = File("/storage/emulated/0/Simona")
        try {
            extRoot.mkdirs()
            if (!extRoot.isDirectory) {
                android.util.Log.w("Simona", "外部存储不可用，跳过数据持久化")
                return
            }
        } catch (e: Exception) {
            android.util.Log.w("Simona", "外部存储不可用: ${e.message}")
            return
        }

        // 兼容迁移：旧版本（v21 之前）数据存放在 /storage/emulated/0/Simona/data/ 子目录，
        // 若存在则迁移到 Simona/ 根目录下的新位置。幂等，无旧数据则跳过。
        migrateLegacyData()

        val pairs = listOf(
            // 核心：会话数据库 simona-desktop.json 及全部配置位于 /root/.simona/，
            // 包含 conversations/messages/projects/settings/providers 等。
            Pair(File(rootfsDir, "root/.simona"), File(extRoot, ".simona")),
            Pair(File(rootfsDir, "root/.config"), File(extRoot, ".config")),
            Pair(File(rootfsDir, "root/.local"), File(extRoot, ".local")),
            Pair(File(rootfsDir, "root/.simona"), File(extRoot, ".simona")),
            Pair(File(rootfsDir, "root/.simona-mem"), File(extRoot, ".simona-mem")),
            Pair(File(rootfsDir, "root/simona/sessions"), File(extRoot, "simona/sessions")),
            Pair(File(rootfsDir, "root/simona/skills"), File(extRoot, "simona/skills")),
            Pair(File(rootfsDir, "root/simona/config"), File(extRoot, "simona/config")),
        )

        val restored = mutableListOf<String>()
        val synced = mutableListOf<String>()

        for ((src, dst) in pairs) {
            try {
                dst.parentFile?.mkdirs()
                src.parentFile?.mkdirs()

                val dstHasData = dst.exists() && (dst.listFiles()?.isNotEmpty() == true)
                val srcHasData = src.exists() && (src.listFiles()?.isNotEmpty() == true)

                // 外部优先策略：外部存储是权威数据源（用户可见、持续保留）。
                // 场景1：外部有数据 → 恢复进 rootfs，确保 rootfs 内可用，不做反向覆盖。
                if (dstHasData) {
                    try {
                        dst.copyRecursively(src, overwrite = true)
                        restored.add(src.name)
                        android.util.Log.i("Simona", "从外部恢复 ${src.name} → ${src.path}")
                    } catch (e: Exception) {
                        android.util.Log.w("Simona", "恢复 ${src.name} 失败: ${e.message}")
                    }
                } else if (srcHasData) {
                    // 场景2（仅首次）：外部为空、rootfs 有数据 → 迁移到外部。
                    try {
                        src.copyRecursively(dst, overwrite = true)
                        synced.add(src.name)
                    } catch (e: Exception) {
                        android.util.Log.w("Simona", "同步 ${src.name} 到外部失败: ${e.message}")
                    }
                } else {
                    dst.mkdirs()
                }
            } catch (e: Exception) {
                android.util.Log.w("Simona", "准备 ${src.absolutePath} 失败: ${e.message}")
            }
        }

        if (restored.isNotEmpty()) {
            android.util.Log.i("Simona", "已从外部恢复数据: ${restored.joinToString(", ")}")
        }
        if (synced.isNotEmpty()) {
            android.util.Log.i("Simona", "已同步到外部存储: ${synced.joinToString(", ")}")
        }
    }

    /** 将旧版本（v21 之前）存储在 /storage/emulated/0/Simona/data/ 的数据迁移到 Simona/ 根目录。
     *  旧结构：Simona/data/home/.config → 新结构：Simona/.config
     *  旧结构：Simona/data/simona/sessions → 新结构：Simona/simona/sessions
     *  迁移条件：旧目录存在且新目录为空/不存在。幂等操作。 */
    private fun migrateLegacyData() {
        try {
            val oldRoot = File("/storage/emulated/0/Simona/data")
            val newRoot = File("/storage/emulated/0/Simona")
            if (!oldRoot.isDirectory || !newRoot.isDirectory) return

            val mappings = listOf(
                File(oldRoot, "home/.config") to File(newRoot, ".config"),
                File(oldRoot, "home/.local") to File(newRoot, ".local"),
                File(oldRoot, "home/.simona") to File(newRoot, ".simona"),
                File(oldRoot, "home/.simona-mem") to File(newRoot, ".simona-mem"),
                File(oldRoot, "simona/sessions") to File(newRoot, "simona/sessions"),
                File(oldRoot, "simona/skills") to File(newRoot, "simona/skills"),
                File(oldRoot, "simona/config") to File(newRoot, "simona/config"),
            )
            for ((src, dst) in mappings) {
                if (!src.isDirectory) continue
                val hasData = src.listFiles()?.isNotEmpty() == true
                if (!hasData) continue
                val dstHasData = dst.isDirectory && (dst.listFiles()?.isNotEmpty() == true)
                if (dstHasData) continue
                try {
                    dst.parentFile?.mkdirs()
                    src.copyRecursively(dst, overwrite = true)
                    android.util.Log.i("Simona", "迁移旧数据: ${src.path} → ${dst.path}")
                } catch (e: Exception) {
                    android.util.Log.w("Simona", "迁移 ${src.path} 失败: ${e.message}")
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("Simona", "旧数据迁移异常: ${e.message}")
        }
    }

    /** 确保 bun 可执行文件已安装到 rootfs（升级场景：旧 APK 从未安装 bun） */
    private fun ensureBunInstalled(rootfsDir: File) {
        val bunPath = File(rootfsDir, "usr/local/bin/bun")
        if (bunPath.exists() && bunPath.length() > 1000L) return

        android.util.Log.i("Simona", "Bun 未安装，从 APK 提取并安装...")
        val bunFile = File(filesDir, "linux/bun.zip")
        bunFile.parentFile?.mkdirs()

        var extracted = false
        val bunNames = arrayOf("offline-bun.zip", "offline-bun.bin")
        try {
            ZipFile(packageCodePath).use { z ->
                for (name in bunNames) {
                    val e = z.getEntry("assets/$name")
                    if (e != null && !e.isDirectory) {
                        z.getInputStream(e).use { input ->
                            FileOutputStream(bunFile).use { out -> input.copyTo(out, bufferSize = 65536) }
                        }
                        extracted = true
                        break
                    }
                }
            }
        } catch (_: Exception) {}
        if (!extracted) {
            for (name in bunNames) {
                try {
                    assets.open(name).use { input ->
                        FileOutputStream(bunFile).use { out -> input.copyTo(out, bufferSize = 65536) }
                    }
                    extracted = true
                    break
                } catch (_: Exception) {}
            }
        }
        if (!extracted || !bunFile.isFile) {
            android.util.Log.e("Simona", "无法从 APK 提取 bun.zip")
            return
        }

        // 解压 bun.zip 并安装到 rootfs 的三个路径
        val arch = if (prootManager.isArm64) "bun-linux-aarch64" else "bun-linux-x64"
        try {
            ZipFile(bunFile).use { z ->
                for (entry in z.entries()) {
                    if (entry.isDirectory) continue
                    if (entry.name.startsWith("$arch/") && entry.name.endsWith("/bun")) {
                        // /usr/local/bin/bun（PATH 默认包含）
                        bunPath.parentFile?.mkdirs()
                        z.getInputStream(entry).use { input ->
                            FileOutputStream(bunPath).use { out -> input.copyTo(out, bufferSize = 65536) }
                        }
                        bunPath.setExecutable(true)

                        // /root/engine/bin/bun（findBunExe bundled 优先路径）
                        val engineBun = File(rootfsDir, "root/engine/bin/bun")
                        engineBun.parentFile?.mkdirs()
                        z.getInputStream(entry).use { input ->
                            FileOutputStream(engineBun).use { out -> input.copyTo(out, bufferSize = 65536) }
                        }
                        engineBun.setExecutable(true)

                        // /root/.bun/bin/bun（userInstalled 兜底路径）
                        val userBun = File(rootfsDir, "root/.bun/bin/bun")
                        userBun.parentFile?.mkdirs()
                        z.getInputStream(entry).use { input ->
                            FileOutputStream(userBun).use { out -> input.copyTo(out, bufferSize = 65536) }
                        }
                        userBun.setExecutable(true)

                        android.util.Log.i("Simona", "Bun 已安装到 rootfs（升级场景）")
                        return
                    }
                }
                android.util.Log.w("Simona", "bun.zip 中未找到 $arch/bun")
            }
        } catch (e: Exception) {
            android.util.Log.e("Simona", "Bun 安装失败", e)
        }
    }

    /**
     * 确保引擎已正确解压到 /root/engine（升级场景：旧 APK 的 rootfs 可能从未解压 engine，
     * 或旧 engine 打包缺少 engine/ 前缀导致 /root/engine/src/entrypoints/cli.tsx 缺失，
     * 此时 bun 会报 Module not found "/root/engine/src/entrypoints/cli.tsx"）。
     * 若引擎缺失，则从 APK 内置 offline-engine 重新提取并解压（与 SetupActivity.installEngine 一致）。
     */
    private fun ensureEngineInstalled(rootfsDir: File) {
        val engineCli = File(rootfsDir, "root/engine/src/entrypoints/cli.tsx")
        val engineEnv = File(rootfsDir, "root/engine/.env")
        if (engineCli.exists() && engineEnv.exists()) {
            android.util.Log.i("Simona", "引擎已存在: cli=true env=true")
            return
        }
        android.util.Log.i("Simona", "引擎缺失（cli=${engineCli.exists()} env=${engineEnv.exists()}），重新解压...")

        val rootDir = File(rootfsDir, "root")
        rootDir.mkdirs()
        val engineNames = arrayOf("offline-engine.tar.gz", "offline-engine.bin")
        val engineFile = File(filesDir, "linux/engine.tar.gz")
        var success = false

        // 方案1: 将 asset 复制到缓存文件，再从文件解压（最可靠，FileInputStream 不受 AssetInputStream 限制）
        for (name in engineNames) {
            try {
                engineFile.parentFile?.mkdirs()
                android.util.Log.i("Simona", "尝试复制 asset 到文件再解压: $name")
                assets.open(name).use { input ->
                    FileOutputStream(engineFile).use { out -> input.copyTo(out, bufferSize = 65536) }
                }
                if (engineFile.isFile && engineFile.length() > 1000000) {
                    TarGzipExtractor.extract(engineFile, rootDir, 0)
                    success = true
                    android.util.Log.i("Simona", "复制解压成功: $name (${engineFile.length()}b)")
                    break
                }
            } catch (e: Exception) {
                android.util.Log.w("Simona", "复制解压 $name 失败: ${e.message}")
            }
        }

        // 方案1.5: 如果 asset 复制失败但 engineFile 已存在（来自 SetupActivity 的 installEngine），
        // 直接使用已有文件解压，跳过 assets.open 和 ZipFile（设备上可能不可用）
        if (!success && engineFile.isFile && engineFile.length() > 50000000) {
            try {
                android.util.Log.i("Simona", "尝试使用已有的 engine.tar.gz 解压 (${engineFile.length()}b)...")
                TarGzipExtractor.extract(engineFile, rootDir, 0)
                success = true
                android.util.Log.i("Simona", "已有 engine.tar.gz 解压成功")
            } catch (e: Exception) {
                android.util.Log.w("Simona", "已有 engine.tar.gz 解压失败: ${e.message}")
            }
        }

        // 方案2: 从 assets 流式解压（备选，跳过中间文件，但 AssetInputStream 可能有限制）
        if (!success) {
            for (name in engineNames) {
                try {
                    android.util.Log.i("Simona", "尝试从 assets 流式解压: $name")
                    assets.open(name).use { input ->
                        TarGzipExtractor.extractAuto(input, rootDir, 0)
                    }
                    success = true
                    android.util.Log.i("Simona", "流式解压成功: $name")
                    break
                } catch (e: Exception) {
                    android.util.Log.w("Simona", "流式解压 $name 失败: ${e.message}")
                }
            }
        }

        // 方案3: 从 ZipFile 提取到缓存文件再解压（最后的 fallback）
        if (!success) {
            android.util.Log.i("Simona", "尝试从 ZipFile 提取...")
            try {
                ZipFile(packageCodePath).use { z ->
                    for (name in engineNames) {
                        val e = z.getEntry("assets/$name")
                        if (e != null && !e.isDirectory) {
                            android.util.Log.i("Simona", "从 ZipFile 提取: $name")
                            z.getInputStream(e).use { input ->
                                FileOutputStream(engineFile).use { out -> input.copyTo(out, bufferSize = 65536) }
                            }
                            TarGzipExtractor.extract(engineFile, rootDir, 0)
                            success = true
                            android.util.Log.i("Simona", "ZipFile 解压成功: $name")
                            break
                        }
                    }
                }
            } catch (e: Exception) {
                android.util.Log.e("Simona", "ZipFile 提取失败: ${e.message}")
            }
        }

        // 方案4: 使用 proot 中的 busybox tar 解压（完全绕过 TarGzipExtractor 的限制）
        if (!success && engineFile.isFile && engineFile.length() > 50000000) {
            try {
                android.util.Log.i("Simona", "尝试使用 proot busybox tar 解压...")
                val engineInRootfs = File(rootfsDir, "root/engine.tar.gz")
                engineFile.copyTo(engineInRootfs, overwrite = true)
                val p = prootManager.execRootfs("tar -xzf /root/engine.tar.gz -C /root/ 2>&1")
                val (exit, output) = captureOutputWithTimeout(p, 120)
                if (exit == 0) {
                    success = true
                    android.util.Log.i("Simona", "busybox tar 解压成功")
                } else {
                    android.util.Log.w("Simona", "busybox tar 解压失败: exit=$exit output=$output")
                }
                engineInRootfs.delete()
            } catch (e: Exception) {
                android.util.Log.e("Simona", "busybox tar 解压异常", e)
            }
        }

        android.util.Log.i("Simona", "引擎重装结果: cli=${engineCli.exists()} env=${engineEnv.exists()} success=$success")

        // 写入诊断文件，方便 adb 查看
        try {
            File(filesDir, "engine_diag.txt").writeText(
                "ensureEngineInstalled\n" +
                "rootfsDir=${rootfsDir.absolutePath}\n" +
                "engineCli.exists=${engineCli.exists()}\n" +
                "engineEnv.exists=${engineEnv.exists()}\n" +
                "engineFile=${engineFile.absolutePath}\n" +
                "engineFile.exists=${engineFile.isFile}\n" +
                "engineFile.length=${if (engineFile.isFile) engineFile.length() else 0}\n" +
                "success=$success\n")
        } catch (_: Exception) {}

        // 诊断：如果解压后 cli.tsx 还不存在，打印 rootfs 目录结构
        if (!engineCli.exists()) {
            android.util.Log.w("Simona", "引擎文件未找到，检查 rootfs 目录结构...")
            try {
                val p = prootManager.execRootfs("ls -la /root/engine 2>&1 || echo 'ENGINE_DIR_NOT_FOUND'; ls -la /root 2>&1 | head -20")
                val (exit, output) = captureOutputWithTimeout(p, 10)
                android.util.Log.i("Simona-Diag", "rootfs 目录: exit=$exit output=$output")
            } catch (e: Exception) {
                android.util.Log.e("Simona-Diag", "无法检查 rootfs 目录: ${e.message}")
            }
        }
    }

    /** 运行一个 proot 测试命令，带超时，避免永久阻塞 */
    private fun runProotTest(num: Int, cmd: String, logFile: File) {
        logFile.appendText("--- 测试$num: $cmd ---\n")
        try {
            val p = prootManager.execRootfs(cmd)
            val (exit, output) = captureOutputWithTimeout(p, 10)
            logFile.appendText("测试$num exit=$exit output=$output\n")
            android.util.Log.i("Simona-Test", "测试$num: exit=$exit, output=$output")
        } catch (e: Exception) {
            logFile.appendText("测试$num 异常: ${e.message}\n")
        }
    }

    /** 读取进程输出并等待，最多 timeoutSec 秒 */
    private fun captureOutputWithTimeout(p: Process, timeoutSec: Long): Pair<Int, String> {
        val sb = StringBuilder()
        val reader = BufferedReader(p.inputStream.reader())
        val readThread = Thread {
            try {
                reader.forEachLine { line ->
                    if (sb.isNotEmpty()) sb.append(" | ")
                    sb.append(line)
                }
            } catch (_: Exception) {}
        }
        readThread.isDaemon = true
        readThread.start()

        val finished = try {
            p.waitFor(timeoutSec, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
            false
        }

        if (!finished) {
            p.destroyForcibly()
            try { readThread.join(2000) } catch (_: InterruptedException) {}
            return -1 to "$sb [TIMEOUT ${timeoutSec}s]"
        }

        try { readThread.join(2000) } catch (_: InterruptedException) {}
        return p.exitValue() to sb.toString()
    }

    /** 启动日志线程：持续读取 bridge-server 的 stdout/stderr */
    private fun startBridgeLogger(proc: Process?, logFile: File) {
        Thread {
            try {
                proc?.inputStream?.bufferedReader()?.use { reader ->
                    logFile.appendText("=== bridge-server 日志线程 ===\n")
                    reader.forEachLine { line ->
                        logFile.appendText("$line\n")
                        android.util.Log.i("Simona-Bridge", line)
                    }
                    val exitCode = try { proc.exitValue() } catch (_: IllegalThreadStateException) { -1 }
                    logFile.appendText("=== bridge-server 进程退出: exit=$exitCode ===\n")
                }
            } catch (_: Exception) {}
        }.apply {
            isDaemon = true
            name = "simona-bridge-logger"
            start()
        }
    }

    private fun stopBridge() {
        bridgeProcess?.destroyForcibly()
        bridgeProcess = null
    }

    /** 保活监听：TCP 探测 WebUI 端口 */
    private fun startKeepAlive() {
        stopKeepAlive()
        keepAliveRunning = true
        keepAliveThread = Thread {
            while (keepAliveRunning) {
                try {
                    Thread.sleep(15000)
                } catch (_: InterruptedException) {
                    break
                }
                if (!keepAliveRunning) break
                if (!isWebUp()) {
                    android.util.Log.w("Simona", "[保活] WebUI 失联，尝试重启")
                    startBridge()
                }
                // 定期检查无障碍服务状态
                if (!isAccessibilityServiceEnabled() && !accessibilityNotified) {
                    notifyAccessibilityDisabled()
                    accessibilityNotified = true
                } else if (isAccessibilityServiceEnabled()) {
                    accessibilityNotified = false
                }
            }
        }.apply {
            isDaemon = true
            name = "simona-keepalive"
            start()
        }
    }

    private fun stopKeepAlive() {
        keepAliveRunning = false
        keepAliveThread?.interrupt()
        keepAliveThread = null
    }

    private fun isWebUp(): Boolean {
        return try {
            val socket = java.net.Socket()
            socket.connect(java.net.InetSocketAddress("127.0.0.1", 30080), 3000)
            socket.close()
            true
        } catch (_: Exception) {
            false
        }
    }

    override fun onDestroy() {
        stopBridge()
        stopKeepAlive()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** 检查无障碍服务是否已开启 */
    private fun isAccessibilityServiceEnabled(): Boolean {
        val expectedComponent = ComponentName(this, "com.beki.simona.SimonaAutomationService")
        val enabledServices = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        return enabledServices.contains(expectedComponent.flattenToString())
    }

    /** 发送通知提醒用户开启无障碍服务 */
    private fun notifyAccessibilityDisabled() {
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val pendingIntent = PendingIntent.getActivity(
            this, 1001, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, SimonaApp.CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("手机自动化未开启")
            .setContentText("点击开启无障碍服务以使用手机控制功能")
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(1001, notification)
    }

    private fun buildNotification(title: String, text: String): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pi = PendingIntent.getActivity(this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stopIntent = Intent(this, BackendService::class.java).setAction(ACTION_STOP)
        val stopPi = PendingIntent.getService(this, 1, stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        return NotificationCompat.Builder(this, SimonaApp.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pi)
            .setOngoing(true)
            .addAction(0, "停止", stopPi)
            .build()
    }

    private fun updateNotification(title: String, text: String) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(SimonaApp.NOTIF_ID, buildNotification(title, text))
    }
}