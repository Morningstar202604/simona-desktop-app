package com.simona.mobile

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.simona.mobile.download.AssetDownloader
import com.simona.mobile.proot.ProotManager
import com.simona.mobile.util.TarGzipExtractor
import java.io.*
import java.util.zip.ZipFile
import java.util.zip.ZipEntry

/**
 * 首次设置界面：支持两种模式
 * 1. 离线模式：从 APK 内置资产 (offline-rootfs.bin/offline-node.bin/offline-bun.bin) 解压
 * 2. 网络模式：从镜像源下载（fallback）
 * 参考 DSHA 的 ExtractActivity.java 设计
 */
class SetupActivity : AppCompatActivity() {

    private lateinit var progressBar: ProgressBar
    private lateinit var statusText: TextView
    private lateinit var stepText: TextView
    private lateinit var retryButton: Button
    private lateinit var prootManager: ProotManager
    private lateinit var assetDownloader: AssetDownloader
    private val handler = Handler(Looper.getMainLooper())
    private var isRunning = false

    companion object {
        private val BUNDLE_NAMES = arrayOf(
            "offline-rootfs.tar.gz", "offline-rootfs.tar",
            "offline-rootfs.bin", "offline-rootfs.tgz"
        )
        private val NODE_NAMES = arrayOf(
            "offline-node.tar.gz", "offline-node.bin"
        )
        private val BUN_NAMES = arrayOf(
            "offline-bun.zip", "offline-bun.bin"
        )
        private val ENGINE_NAMES = arrayOf(
            "offline-engine.tar.gz", "offline-engine.bin"
        )
        private val PYTHON_NAMES = arrayOf(
            "offline-python.tar.gz", "offline-python.bin"
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)

        progressBar = findViewById(R.id.setupProgress)
        statusText = findViewById(R.id.setupStatus)
        stepText = findViewById(R.id.setupStep)
        retryButton = findViewById(R.id.retryButton)

        prootManager = ProotManager(this)
        assetDownloader = AssetDownloader(this)

        retryButton.setOnClickListener { startSetup() }

        startSetup()
    }

    private fun startSetup() {
        if (isRunning) return
        isRunning = true
        retryButton.visibility = android.view.View.GONE

        Thread {
            try {
                // 步骤1: 准备 proot 运行时文件
                updateStep(1, 5, "准备 Linux 环境...")
                prootManager.ensureRuntimeFiles()

                // 步骤2: 获取 Ubuntu rootfs（优先 APK 内置包，否则网络下载）
                val archWord = if (prootManager.isArm64) "ARM64" else "X86_64"
                updateStep(2, 5, "准备 Ubuntu 24.04 $archWord 根文件系统...")
                val rootfsFile = File(filesDir, "linux/rootfs.tar.gz")
                val hasOffline = hasOfflineBundle()
                if (hasOffline) {
                    updateStatus("从 APK 内置包提取...")
                    extractOfflineBundle(rootfsFile)
                } else {
                    updateStatus("从镜像源下载...")
                    assetDownloader.downloadWithRetry(
                        AssetDownloader.ROOTFS_URLS,
                        rootfsFile,
                        object : AssetDownloader.DownloadProgress {
                            override fun onProgress(downloaded: Long, total: Long) {
                                val pct = if (total > 0) (downloaded * 100 / total).toInt() else -1
                                updateProgress(pct)
                            }
                        }
                    )
                }

                // 步骤3: 解压 rootfs
                updateStep(3, 5, "解压根文件系统...")
                val rootfsDir = File(filesDir, "linux/ubuntu")
                if (rootfsDir.exists()) deleteRecursive(rootfsDir)
                rootfsDir.mkdirs()
                TarGzipExtractor.extract(rootfsFile, rootfsDir)
                prootManager.setupResolvConf()

                // 步骤4: 安装 Node.js、Bun 与引擎
                updateStep(4, 5, "安装 Node.js 24...")
                installNode(rootfsDir)
                installBun(rootfsDir)

                // 创建手机存储挂载目录（proot bind 目标，供工作区选择器浏览手机文件夹）
                File(rootfsDir, "sdcard").mkdirs()
                File(rootfsDir, "storage").mkdirs()

                // 步骤4.5: 安装 Simona Code 引擎（对话功能依赖 bun + engine）
                updateStatus("安装引擎...")
                installEngine(rootfsDir)

                // 步骤4.5: 安装 Python 3.13
                updateStatus("安装 Python 3.13...")
                installPython(rootfsDir)

                // 步骤4.5: 复制 Simona 服务器文件到 rootfs
                updateStatus("配置 Simona 服务器...")
                copyAssetsToRootfs(rootfsDir)

                // 步骤5: 初始化完成
                updateStep(5, 5, "完成初始化...")
                prootManager.markInstalled()
                prootManager.writeArchMarker()

                // 标记设置完成
                getSharedPreferences("simona", MODE_PRIVATE).edit()
                    .putBoolean("setup_complete", true).apply()

                // 启动主界面
                handler.post {
                    val intent = Intent(this, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                    }
                    startActivity(intent)
                    finish()
                }

            } catch (e: Exception) {
                handler.post {
                    statusText.text = "错误: ${e.message}"
                    retryButton.visibility = android.view.View.VISIBLE
                    isRunning = false
                }
            }
        }.start()
    }

    /** 检查是否有内置离线包（APK zip 或 assets） */
    private fun hasOfflineBundle(): Boolean {
        try {
            ZipFile(packageCodePath).use { z ->
                for (name in BUNDLE_NAMES) {
                    val e = z.getEntry("assets/$name")
                    if (e != null && !e.isDirectory) return true
                }
            }
        } catch (_: Exception) {}
        for (name in BUNDLE_NAMES) {
            try {
                assets.open(name).close()
                return true
            } catch (_: Exception) {}
        }
        return false
    }

    /** 从 APK 内置包提取 rootfs 到目标文件 */
    private fun extractOfflineBundle(dest: File) {
        dest.parentFile?.mkdirs()

        // 方式1: 从 APK zip 提取（必须在内 use 块内完成流复制，否则 zip 关闭后流也关闭）
        var extracted = false
        try {
            ZipFile(packageCodePath).use { z ->
                for (name in BUNDLE_NAMES) {
                    val e = z.getEntry("assets/$name")
                    if (e != null && !e.isDirectory) {
                        z.getInputStream(e).use { `in` ->
                            FileOutputStream(dest).use { out ->
                                `in`.copyTo(out, bufferSize = 65536)
                            }
                        }
                        extracted = true
                        break
                    }
                }
            }
        } catch (_: Exception) {}
        if (extracted) return

        // 方式2: 从 assets 直接读取（fallback）
        for (name in BUNDLE_NAMES) {
            try {
                assets.open(name).use { `in` ->
                    FileOutputStream(dest).use { out ->
                        `in`.copyTo(out, bufferSize = 65536)
                    }
                }
                return
            } catch (_: Exception) {}
        }

        throw IOException("APK 中未找到离线包")
    }

    /** 安装 Node.js（优先 APK 内置包，否则网络下载） */
    private fun installNode(rootfsDir: File) {
        val nodeDir = File(filesDir, "linux/node")
        if (nodeDir.exists()) deleteRecursive(nodeDir)
        nodeDir.mkdirs()

        val nodeFile = File(filesDir, "linux/node.tar.gz")

        // 尝试从 APK 内置包提取
        var extracted = false
        try {
            ZipFile(packageCodePath).use { z ->
                for (name in NODE_NAMES) {
                    val e = z.getEntry("assets/$name")
                    if (e != null && !e.isDirectory) {
                        updateStatus("从 APK 内置包提取 Node.js...")
                        z.getInputStream(e).use { `in` ->
                            FileOutputStream(nodeFile).use { out ->
                                `in`.copyTo(out, bufferSize = 65536)
                            }
                        }
                        extracted = true
                        break
                    }
                }
            }
        } catch (_: Exception) {}

        if (!extracted) {
            for (name in NODE_NAMES) {
                try {
                    updateStatus("从 APK 内置包提取 Node.js...")
                    assets.open(name).use { `in` ->
                        FileOutputStream(nodeFile).use { out ->
                            `in`.copyTo(out, bufferSize = 65536)
                        }
                    }
                    extracted = true
                    break
                } catch (_: Exception) {}
            }
        }

        if (!extracted) {
            // 网络下载
            updateStatus("下载 Node.js 24...")
            assetDownloader.downloadWithRetry(
                AssetDownloader.NODE_URLS,
                nodeFile,
                object : AssetDownloader.DownloadProgress {
                    override fun onProgress(downloaded: Long, total: Long) {
                        val pct = if (total > 0) (downloaded * 100 / total).toInt() else -1
                        updateProgress(pct)
                    }
                }
            )
        }

        // 解压 Node.js
        updateProgress(-1)
        updateStatus("安装 Node.js...")
        TarGzipExtractor.extract(nodeFile, nodeDir)

        // 将 node 二进制复制到 rootfs
        val nodeBin = nodeDir.listFiles()?.firstOrNull()?.let { File(it, "bin/node") }
        if (nodeBin?.exists() == true) {
            File(rootfsDir, "usr/local/bin/node").apply {
                parentFile?.mkdirs()
                nodeBin.copyTo(this, overwrite = true)
            }
            File(rootfsDir, "usr/local/bin/node").setExecutable(true)
        }
    }

    /** 安装 Bun（优先 APK 内置包，否则网络下载） */
    private fun installBun(rootfsDir: File) {
        val bunFile = File(filesDir, "linux/bun.zip")

        // 尝试从 APK 内置包提取
        var extracted = false
        try {
            ZipFile(packageCodePath).use { z ->
                for (name in BUN_NAMES) {
                    val e = z.getEntry("assets/$name")
                    if (e != null && !e.isDirectory) {
                        updateStatus("从 APK 内置包提取 Bun...")
                        z.getInputStream(e).use { `in` ->
                            FileOutputStream(bunFile).use { out ->
                                `in`.copyTo(out, bufferSize = 65536)
                            }
                        }
                        extracted = true
                        break
                    }
                }
            }
        } catch (_: Exception) {}

        if (!extracted) {
            for (name in BUN_NAMES) {
                try {
                    updateStatus("从 APK 内置包提取 Bun...")
                    assets.open(name).use { `in` ->
                        FileOutputStream(bunFile).use { out ->
                            `in`.copyTo(out, bufferSize = 65536)
                        }
                    }
                    extracted = true
                    break
                } catch (_: Exception) {}
            }
        }

        if (!extracted) {
            updateStatus("下载 Bun...")
            assetDownloader.downloadWithRetry(
                AssetDownloader.BUN_URLS,
                bunFile,
                object : AssetDownloader.DownloadProgress {
                    override fun onProgress(downloaded: Long, total: Long) {
                        val pct = if (total > 0) (downloaded * 100 / total).toInt() else -1
                        updateProgress(pct)
                    }
                }
            )
        }

        // 真正解压 bun.zip 并安装 bun 可执行文件到 rootfs（此前只下载不解压 → spawn bun ENOENT）
        installBunBinary(rootfsDir, bunFile)
        updateStatus("Bun 已安装")
    }

    /** 从 bun.zip 解压 bun 二进制，安装到 rootfs 的 /usr/local/bin/bun 及引擎目录 */
    private fun installBunBinary(rootfsDir: File, bunZip: File) {
        val arch = if (prootManager.isArm64) "bun-linux-aarch64" else "bun-linux-x64"
        if (!bunZip.isFile || bunZip.length() < 1000L) {
            android.util.Log.w("Simona", "bun.zip 无效，跳过安装")
            return
        }
        try {
            java.util.zip.ZipFile(bunZip).use { z ->
                for (entry in z.entries()) {
                    if (entry.isDirectory) continue
                    if (entry.name.startsWith("$arch/") && entry.name.endsWith("/bun")) {
                        // 1) /usr/local/bin/bun（proot PATH 默认包含）
                        val targetBun = File(rootfsDir, "usr/local/bin/bun")
                        targetBun.parentFile?.mkdirs()
                        z.getInputStream(entry).use { input ->
                            FileOutputStream(targetBun).use { out -> input.copyTo(out, bufferSize = 65536) }
                        }
                        targetBun.setExecutable(true)

                        // 2) /root/engine/bin/bun（bridge-server findBunExe() 优先查找引擎目录）
                        val engineBun = File(rootfsDir, "root/engine/bin/bun")
                        engineBun.parentFile?.mkdirs()
                        z.getInputStream(entry).use { input ->
                            FileOutputStream(engineBun).use { out -> input.copyTo(out, bufferSize = 65536) }
                        }
                        engineBun.setExecutable(true)

                        // 3) /root/.bun/bin/bun（findBunExe() 的 user-installed 兜底）
                        val userBun = File(rootfsDir, "root/.bun/bin/bun")
                        userBun.parentFile?.mkdirs()
                        z.getInputStream(entry).use { input ->
                            FileOutputStream(userBun).use { out -> input.copyTo(out, bufferSize = 65536) }
                        }
                        userBun.setExecutable(true)

                        android.util.Log.i("Simona", "Bun 已安装: ${targetBun.absolutePath} (${targetBun.length()} bytes)")
                        return
                    }
                }
                android.util.Log.w("Simona", "bun.zip 中未找到 $arch/bun 条目")
            }
        } catch (e: Exception) {
            android.util.Log.e("Simona", "安装 Bun 失败", e)
        }
    }

    /** 安装 Simona Code 引擎（从 APK 内置 offline-engine 解压到 /root/engine） */
    private fun installEngine(rootfsDir: File) {
        val engineFile = File(filesDir, "linux/engine.tar.gz")
        var extracted = false
        try {
            ZipFile(packageCodePath).use { z ->
                for (name in ENGINE_NAMES) {
                    val e = z.getEntry("assets/$name")
                    if (e != null && !e.isDirectory) {
                        updateStatus("从 APK 内置包提取引擎...")
                        z.getInputStream(e).use { input ->
                            FileOutputStream(engineFile).use { out -> input.copyTo(out, bufferSize = 65536) }
                        }
                        extracted = true
                        break
                    }
                }
            }
        } catch (_: Exception) {}
        if (!extracted) {
            for (name in ENGINE_NAMES) {
                try {
                    updateStatus("从 APK 内置包提取引擎...")
                    assets.open(name).use { input ->
                        FileOutputStream(engineFile).use { out -> input.copyTo(out, bufferSize = 65536) }
                    }
                    extracted = true
                    break
                } catch (_: Exception) {}
            }
        }
        if (!extracted || !engineFile.isFile) {
            android.util.Log.e("Simona", "未找到内置引擎包，对话功能将不可用")
            updateStatus("引擎缺失，对话功能可能不可用")
            return
        }
        updateStatus("解压引擎...")
        // tar 顶层是 engine/，strip=0 解压到 /root → /root/engine（bridge-server 预期路径）
        val rootDir = File(rootfsDir, "root")
        rootDir.mkdirs()
        try {
            TarGzipExtractor.extract(engineFile, rootDir, 0)
        } catch (e: Exception) {
            android.util.Log.e("Simona", "解压引擎失败", e)
            updateStatus("引擎解压失败: ${e.message}")
            return
        }
        val engineCli = File(rootfsDir, "root/engine/src/entrypoints/cli.tsx")
        val engineEnv = File(rootfsDir, "root/engine/.env")
        android.util.Log.i("Simona", "引擎安装完成: cli=${engineCli.exists()} env=${engineEnv.exists()}")
        updateStatus("引擎已安装")
    }

    /** 安装 Python 3.13（从 APK 内置 offline-python 解压到 rootfs /usr/local） */
    private fun installPython(rootfsDir: File) {
        val pythonFile = File(filesDir, "linux/python.tar.gz")
        var extracted = false
        try {
            ZipFile(packageCodePath).use { z ->
                for (name in PYTHON_NAMES) {
                    val e = z.getEntry("assets/$name")
                    if (e != null && !e.isDirectory) {
                        updateStatus("从 APK 内置包提取 Python...")
                        z.getInputStream(e).use { input ->
                            FileOutputStream(pythonFile).use { out -> input.copyTo(out, bufferSize = 65536) }
                        }
                        extracted = true
                        break
                    }
                }
            }
        } catch (_: Exception) {}
        if (!extracted) {
            for (name in PYTHON_NAMES) {
                try {
                    updateStatus("从 APK 内置包提取 Python...")
                    assets.open(name).use { input ->
                        FileOutputStream(pythonFile).use { out -> input.copyTo(out, bufferSize = 65536) }
                    }
                    extracted = true
                    break
                } catch (_: Exception) {}
            }
        }
        if (!extracted || !pythonFile.isFile) {
            android.util.Log.e("Simona", "未找到内置 Python 包，Python 功能将不可用")
            updateStatus("Python 缺失，可能影响部分功能")
            return
        }
        updateStatus("安装 Python 3.13...")
        // tar 顶层是 python/，strip=1 解压到 /usr/local → /usr/local/bin/python3, /usr/local/lib/python3.13/
        val usrLocal = File(rootfsDir, "usr/local")
        usrLocal.mkdirs()
        try {
            TarGzipExtractor.extract(pythonFile, usrLocal, 1)
        } catch (e: Exception) {
            android.util.Log.e("Simona", "解压 Python 失败", e)
            updateStatus("Python 安装失败: ${e.message}")
            return
        }
        val pythonBin = File(rootfsDir, "usr/local/bin/python3")
        android.util.Log.i("Simona", "Python 安装完成: bin=${pythonBin.exists()} (${pythonBin.length()} bytes)")
        updateStatus("Python 已安装")
    }

    private fun updateStep(current: Int, total: Int, text: String) {
        handler.post {
            stepText.text = "步骤 $current/$total"
            statusText.text = text
            progressBar.max = total
            progressBar.progress = current
        }
    }

    private fun updateStatus(text: String) {
        handler.post { statusText.text = text }
    }

    private fun updateProgress(percent: Int) {
        handler.post {
            if (percent >= 0) {
                progressBar.isIndeterminate = false
                progressBar.progress = percent
            } else {
                progressBar.isIndeterminate = true
            }
        }
    }

    /** 从 APK 资产复制目录到 rootfs */
    private fun copyAssetsToRootfs(rootfsDir: File) {
        val simonaDir = File(rootfsDir, "root/simona")
        simonaDir.mkdirs()

        // 复制 simona-server/ 到 /root/simona/（含 bridge-server.cjs + node_modules）
        copyAssetDir("assets/simona-server", simonaDir)
        // 复制 simona-dist/ 到 /root/dist/（Web 前端，bridge-server 通过 __dirname/../dist 定位）
        // 注意：PRoot 的 --link2symlink 会阻止运行时符号链接创建，所以直接复制到目标路径
        copyAssetDir("assets/simona-dist", File(rootfsDir, "root/dist"))

        // 设置可执行权限
        File(simonaDir, "server-wrapper.cjs").setExecutable(true)
        File(simonaDir, "stub-electron.cjs").setExecutable(true)

        android.util.Log.i("Simona", "服务器文件已复制到: ${simonaDir.absolutePath}")
    }

    /** 从 APK ZipFile 提取整个资产目录到目标目录 */
    private fun copyAssetDir(prefix: String, targetDir: File) {
        targetDir.mkdirs()
        var count = 0
        try {
            ZipFile(packageCodePath).use { z ->
                val entries = z.entries()
                while (entries.hasMoreElements()) {
                    val e = entries.nextElement()
                    if (e.name.startsWith("$prefix/") && !e.isDirectory) {
                        val relPath = e.name.removePrefix("$prefix/")
                        val outFile = File(targetDir, relPath)
                        outFile.parentFile?.mkdirs()
                        z.getInputStream(e).use { input ->
                            FileOutputStream(outFile).use { output ->
                                input.copyTo(output, bufferSize = 65536)
                            }
                        }
                        count++
                    }
                }
            }
        } catch (e: Exception) {
            throw IOException("复制资产目录 $prefix 失败: ${e.message}", e)
        }
        android.util.Log.i("Simona", "已复制 $count 个文件: $prefix → ${targetDir.absolutePath}")
    }

    private fun deleteRecursive(f: File) {
        if (f.isDirectory) {
            f.listFiles()?.forEach { deleteRecursive(it) }
        }
        f.delete()
    }
}