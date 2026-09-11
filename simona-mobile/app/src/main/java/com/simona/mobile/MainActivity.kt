package com.simona.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.os.Environment
import android.provider.Settings
import android.view.View
import android.webkit.*
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.simona.mobile.service.BackendService
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var waitingThread: Thread? = null
    private val prootManager by lazy { com.simona.mobile.proot.ProotManager(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 崩溃捕获
        val prev = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            try {
                val f = java.io.File(filesDir, "crash.log")
                java.io.FileOutputStream(f, true).use { fos ->
                    val ts = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date())
                    fos.write("\n===== $ts =====\n${android.util.Log.getStackTraceString(throwable)}\n".toByteArray())
                }
            } catch (_: Exception) {}
            prev?.uncaughtException(thread, throwable) ?: android.os.Process.killProcess(android.os.Process.myPid())
        }

        // 检查是否已完成首次设置，且 rootfs 架构与当前设备匹配
        val prefs = getSharedPreferences("simona", MODE_PRIVATE)
        val setupDone = prefs.getBoolean("setup_complete", false)
        if (!setupDone || !prootManager.isArchValid()) {
            if (setupDone && !prootManager.isArchValid()) {
                // 架构不匹配（例如 arm64→x86_64 覆盖安装）：清理旧环境，强制重装
                android.util.Log.w("Simona", "检测到环境架构不匹配，清理并重装")
                prootManager.cleanupForReinstall()
                prefs.edit().putBoolean("setup_complete", false).apply()
            }
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)

        // 请求权限
        requestPermissions()
        requestBatteryOptimization()

        // 重试按钮
        findViewById<Button>(R.id.retryButton).setOnClickListener {
            restartBackend()
        }

        // 启动后端服务
        val serviceIntent = Intent(this, BackendService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(serviceIntent)
        } else {
            startService(serviceIntent)
        }

        // 等待后端就绪
        waitForBackend()
    }

    private fun restartBackend() {
        // 停止旧服务
        stopService(Intent(this, BackendService::class.java))
        // 重置 UI
        findViewById<ProgressBar>(R.id.loadingProgress).visibility = View.VISIBLE
        findViewById<ProgressBar>(R.id.loadingProgress).isIndeterminate = true
        findViewById<Button>(R.id.retryButton).visibility = View.GONE
        findViewById<TextView>(R.id.loadingText).text = "正在启动后端服务..."
        findViewById<View>(R.id.loadingOverlay).visibility = View.VISIBLE
        // 重新启动
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(Intent(this, BackendService::class.java))
        } else {
            startService(Intent(this, BackendService::class.java))
        }
        waitForBackend()
    }

    private fun setupWebView() {
        webView = findViewById(R.id.webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowContentAccess = true
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            loadWithOverviewMode = true
            useWideViewPort = true
            mediaPlaybackRequiresUserGesture = false
            val ua = userAgentString ?: ""
            userAgentString = "$ua SimonaMobile/1.0"
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }

        webView.addJavascriptInterface(SimonaBridge(this), "SimonaBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                findViewById<View>(R.id.loadingOverlay)?.visibility = View.GONE
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val intent = params?.createIntent() ?: Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                }
                startActivityForResult(intent, 0)
                return true
            }
        }

        webView.loadUrl("http://127.0.0.1:30080")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == 0) {
            filePathCallback?.onReceiveValue(
                if (resultCode == RESULT_OK && data?.data != null)
                    arrayOf(data.data!!)
                else
                    null
            )
            filePathCallback = null
        }
    }

    private fun waitForBackend() {
        val loadingOverlay = findViewById<View>(R.id.loadingOverlay)
        val loadingText = findViewById<TextView>(R.id.loadingText)
        val loadingProgress = findViewById<ProgressBar>(R.id.loadingProgress)
        val retryButton = findViewById<Button>(R.id.retryButton)

        loadingOverlay.visibility = View.VISIBLE
        loadingText.text = "正在启动后端服务..."

        waitingThread = Thread {
            var retries = 0
            var lastLogSize = 0L
            val serverLogFile = File(filesDir, "linux/ubuntu/root/simona/server.log")
            val crashLogFile = File(filesDir, "crash.log")

            while (retries < 120) {
                try {
                    val socket = java.net.Socket()
                    socket.connect(java.net.InetSocketAddress("127.0.0.1", 30080), 1000)
                    socket.close()
                    runOnUiThread { setupWebView() }
                    return@Thread
                } catch (_: Exception) {
                    retries++
                    // 每 3 秒检查一次日志文件是否有新内容
                    if (retries % 3 == 0) {
                        try {
                            if (serverLogFile.exists()) {
                                val currentSize = serverLogFile.length()
                                if (currentSize != lastLogSize) {
                                    lastLogSize = currentSize
                                    val lines = serverLogFile.readLines()
                                    val lastLines = lines.takeLast(5).joinToString("\n")
                                    runOnUiThread {
                                        loadingText.text = "等待后端... (${retries}s)\n\n$lastLines"
                                    }
                                }
                            }
                        } catch (_: Exception) {}
                    }
                    try { Thread.sleep(1000) } catch (_: InterruptedException) { break }
                }
            }

            // 超时 — 读取日志并显示到界面
            runOnUiThread {
                loadingProgress.visibility = View.GONE
                val errorInfo = buildString {
                    appendLine("⚠️ 后端启动超时")
                    appendLine()

                    // 读取 server.log（显示完整内容，ScrollView 可滚动查看）
                    try {
                        if (serverLogFile.exists()) {
                            val log = serverLogFile.readText()
                            if (log.isNotBlank()) {
                                appendLine("── 服务器日志（完整）──")
                                val lines = log.lines()
                                val tail = lines.takeLast(200).joinToString("\n")
                                append(tail)
                                appendLine()
                            }
                        } else {
                            appendLine("服务器日志文件不存在")
                            appendLine("预期路径: ${serverLogFile.absolutePath}")
                        }
                    } catch (e: Exception) {
                        appendLine("读取服务器日志失败: ${e.message}")
                    }

                    // 读取 crash.log
                    try {
                        if (crashLogFile.exists()) {
                            val log = crashLogFile.readText()
                            if (log.isNotBlank()) {
                                appendLine()
                                appendLine("── 崩溃日志 ──")
                                append(log.takeLast(1000))
                            }
                        }
                    } catch (e: Exception) {
                        appendLine("读取崩溃日志失败: ${e.message}")
                    }

                    // 检查 rootfs 完整性
                    appendLine()
                    appendLine("── 环境检查 ──")
                    val rootfsDir = File(filesDir, "linux/ubuntu")
                    appendLine("rootfs 存在: ${rootfsDir.exists()}")
                    if (rootfsDir.exists()) {
                        appendLine("rootfs 大小: ${rootfsDir.length()} bytes")
                        val nodeBin = File(rootfsDir, "usr/local/bin/node")
                        appendLine("node 存在: ${nodeBin.exists()}")
                        val serverWrapper = File(rootfsDir, "root/simona/server-wrapper.cjs")
                        appendLine("server-wrapper 存在: ${serverWrapper.exists()}")
                        val distIndex = File(rootfsDir, "root/simona/dist/index.html")
                        appendLine("dist/index.html 存在: ${distIndex.exists()}")
                    }
                }

                loadingText.text = errorInfo
                retryButton.visibility = View.VISIBLE
            }
        }.apply {
            isDaemon = true
            name = "simona-wait-backend"
            start()
        }
    }

    private fun requestPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 100)
            }
        }
        // 存储权限：proot 需要读取手机 /sdcard 作为工作区文件夹
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
            if (checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(arrayOf(
                    Manifest.permission.WRITE_EXTERNAL_STORAGE,
                    Manifest.permission.READ_EXTERNAL_STORAGE
                ), 101)
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            // Android 11+：需要"所有文件访问"权限才能任意访问 /sdcard
            if (!android.os.Environment.isExternalStorageManager()) {
                try {
                    startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                        data = Uri.parse("package:$packageName")
                    })
                } catch (_: Exception) {
                    try {
                        startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                    } catch (_: Exception) {}
                }
            }
        }
    }

    private fun requestBatteryOptimization() {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(packageName)) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
                startActivity(intent)
            }
        } catch (_: Exception) {}
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}

class SimonaBridge(private val activity: MainActivity) {
    @android.webkit.JavascriptInterface
    fun getPlatform(): String = "android"

    @android.webkit.JavascriptInterface
    fun getVersion(): String = "1.0.0"
}