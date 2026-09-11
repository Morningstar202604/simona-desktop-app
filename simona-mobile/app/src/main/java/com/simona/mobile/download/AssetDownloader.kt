package com.simona.mobile.download

import android.content.Context
import com.simona.mobile.util.AppArch
import java.io.*
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

/**
 * 资产下载器：支持多镜像源、断点续传、进度回调
 * 参考 DSHA 的 ProotBootstrap.downloadRootfs() 设计
 */
class AssetDownloader(private val ctx: Context) {

    companion object {
        /** 按设备架构动态选择 rootfs URL（arm64→-base-arm64，x86_64→-base-amd64） */
        val ROOTFS_URLS: Array<String>
            get() {
                val w = if (AppArch.isArm64) "arm64" else "amd64"
                return arrayOf(
                    "https://mirror.nju.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04.4/release/ubuntu-base-24.04.4-base-$w.tar.gz",
                    "https://mirrors.hit.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04.4/release/ubuntu-base-24.04.4-base-$w.tar.gz",
                    "https://mirrors.aliyun.com/ubuntu-cdimage/ubuntu-base/releases/24.04.4/release/ubuntu-base-24.04.4-base-$w.tar.gz",
                    "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04.4/release/ubuntu-base-24.04.4-base-$w.tar.gz",
                    "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04.4/release/ubuntu-base-24.04.4-base-$w.tar.gz"
                )
            }

        /** 按设备架构动态选择 Node.js URL（arm64→linux-arm64，x86_64→linux-x64） */
        val NODE_URLS: Array<String>
            get() {
                val p = AppArch.nodePlatform()
                return arrayOf(
                    "https://mirrors.huaweicloud.com/nodejs/v24.19.0/node-v24.19.0-$p.tar.gz",
                    "https://npmmirror.com/mirrors/node/v24.19.0/node-v24.19.0-$p.tar.gz",
                    "https://mirrors.aliyun.com/nodejs-release/v24.19.0/node-v24.19.0-$p.tar.gz",
                    "https://nodejs.org/dist/v24.19.0/node-v24.19.0-$p.tar.gz"
                )
            }

        /** 按设备架构动态选择 Bun URL（arm64→aarch64，x86_64→x64） */
        val BUN_URLS: Array<String>
            get() {
                val p = AppArch.bunPlatform()
                return arrayOf(
                    "https://github.com/oven-sh/bun/releases/download/bun-v1.2.8/bun-$p.zip",
                    "https://mirror.nju.edu.cn/github-release/oven-sh/bun/bun-v1.2.8/bun-$p.zip"
                )
            }

        val SIMONA_DIST_URLS = arrayOf(
            "https://www.example.com/simona-dist.tar.gz",
            "https://github.com/pretend1111/simona-desktop-app/releases/latest/download/simona-dist.tar.gz"
        )
    }

    interface DownloadProgress {
        fun onProgress(downloaded: Long, total: Long)
    }

    /** 测速单个源 (HEAD 请求) */
    fun probeLatency(url: String, timeoutMs: Int = 6000): Long {
        val start = System.currentTimeMillis()
        return try {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.requestMethod = "HEAD"
            conn.setRequestProperty("User-Agent", "SimonaMobile/1.0")
            val code = conn.responseCode
            conn.disconnect()
            if (code == 200 || code == 206) System.currentTimeMillis() - start else -1
        } catch (_: Exception) {
            -1
        }
    }

    /** 多源并行测速，按速度排序 */
    fun orderBySpeed(urls: Array<String>): Array<String> {
        val latencies = LongArray(urls.size) { -1 }
        val latch = CountDownLatch(urls.size)
        val pool = Executors.newFixedThreadPool(Math.min(8, urls.size))

        urls.forEachIndexed { idx, url ->
            pool.execute {
                try {
                    latencies[idx] = probeLatency(url)
                } finally {
                    latch.countDown()
                }
            }
        }
        latch.await(9000, java.util.concurrent.TimeUnit.MILLISECONDS)
        pool.shutdownNow()

        // 排序
        val indices = urls.indices.sortedBy { latencies[it] }
        val sorted = indices.map { urls[it] }.toTypedArray()
        return sorted
    }

    /** 下载文件（带进度回调，支持断点续传） */
    fun download(url: String, dest: File, progress: DownloadProgress? = null): Unit {
        val existing = if (dest.exists()) dest.length() else 0L
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 45000
        conn.readTimeout = 300000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "SimonaMobile/1.0")
        if (existing > 0) {
            conn.setRequestProperty("Range", "bytes=$existing-")
        }
        conn.connect()

        val code = conn.responseCode
        if (code != 200 && code != 206) throw IOException("HTTP $code for $url")

        val isResume = code == 206
        val contentLen = conn.contentLengthLong
        val totalBytes = if (isResume && contentLen > 0) existing + contentLen else contentLen

        try {
            conn.inputStream.use { input ->
                RandomAccessFile(dest, "rw").use { raf ->
                    if (isResume) raf.seek(existing) else raf.setLength(0)
                    val buf = ByteArray(65536)
                    var downloaded = if (isResume) existing else 0L
                    var lastPct = -1

                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        raf.write(buf, 0, n)
                        downloaded += n

                        progress?.let {
                            if (totalBytes > 0) {
                                val pct = (downloaded * 100 / totalBytes).toInt()
                                if (pct != lastPct) {
                                    lastPct = pct
                                    it.onProgress(downloaded, totalBytes)
                                }
                            }
                        }
                    }
                }
            }
        } finally {
            conn.disconnect()
        }
    }

    /** 带重试的下载：自动测速选最快源，失败后依次尝试其他源 */
    fun downloadWithRetry(
        urls: Array<String>,
        dest: File,
        progress: DownloadProgress? = null
    ): Unit {
        val sortedUrls = orderBySpeed(urls)
        var lastError: Exception? = null

        for (url in sortedUrls) {
            try {
                download(url, dest, progress)
                // 验证文件完整性
                if (dest.length() == 0L) throw IOException("下载文件为空")
                return
            } catch (e: Exception) {
                lastError = e
                android.util.Log.w("Simona", "下载失败: $url - ${e.message}")
                dest.delete()
            }
        }

        throw lastError ?: IOException("所有镜像源均下载失败")
    }

    /** 从 assets 复制文件 */
    fun copyAssetToFile(assetName: String, dest: File) {
        dest.parentFile?.mkdirs()
        try {
            ctx.assets.open(assetName).use { input ->
                FileOutputStream(dest).use { output ->
                    input.copyTo(output)
                }
            }
        } catch (e: IOException) {
            throw IOException("无法复制资产 $assetName: ${e.message}")
        }
    }
}