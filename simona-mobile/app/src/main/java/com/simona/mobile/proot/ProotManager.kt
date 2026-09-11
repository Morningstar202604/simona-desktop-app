package com.simona.mobile.proot

import android.content.Context
import java.io.*

/**
 * ProotManager — Linux 环境管理（PRoot 方案）
 *
 * 参考 DSHA 的 ProotBootstrap.java 设计：
 * proot、loader、libtalloc 伪装成 lib*.so 放入 jniLibs，Android 安装时
 * 自动解压到 nativeLibraryDir。运行时通过 PROOT_LOADER / PROOT_TMP_DIR /
 * LD_LIBRARY_PATH 环境变量引导 proot 找到 loader 与依赖库。
 */
class ProotManager(private val ctx: Context) {

    companion object {
        /** 需要跨卸载持久化的用户数据目录: (外部存储 Simona 相对路径, rootfs 内 guest 路径)。
         *  注意：.simona 目录是核心，包含 simona-desktop.json(会话数据库)、workspace-config.json、
         *  providers.json、settings.json 等全部用户配置与对话历史。 */
        private val PERSISTENT_DIRS = listOf(
            ".simona" to "root/.simona",
            ".config" to "root/.config",
            ".local" to "root/.local",
            ".simona" to "root/.simona",
            ".simona-mem" to "root/.simona-mem",
            "simona/sessions" to "root/simona/sessions",
            "simona/skills" to "root/simona/skills",
            "simona/config" to "root/simona/config",
        )
    }

    private val baseDir = File(ctx.filesDir, "linux")
    val rootfsDir = File(baseDir, "ubuntu")
    private val libDir = File(baseDir, "lib")
    private val tmpDir = File(baseDir, "tmp")
    private val nativeLibDir = ctx.applicationInfo.nativeLibraryDir
    private val markerFile = File(baseDir, ".installed")
    private val archMarkerFile = File(baseDir, ".arch")

    /** 当前设备是否 arm64 架构（决定 proot/rootfs 使用路径） */
    val isArm64: Boolean
        get() = android.os.Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "arm64" }

    /** 当前设备架构标识 */
    private fun currentArchTag(): String = if (isArm64) "arm64" else "x86_64"

    /** 写入架构标记（SetupActivity 安装完成后调用） */
    fun writeArchMarker() {
        try {
            archMarkerFile.parentFile?.mkdirs()
            archMarkerFile.writeText(currentArchTag())
        } catch (_: IOException) {}
    }

    /** 已安装环境是否与当前设备架构匹配（防止 arm64→x86_64 覆盖安装时复用旧 rootfs） */
    fun isArchValid(): Boolean {
        return try {
            archMarkerFile.exists() && archMarkerFile.readText().trim() == currentArchTag()
        } catch (_: IOException) {
            false
        }
    }

    /** 架构不匹配时清理整个 Linux 环境，准备重装 */
    fun cleanupForReinstall() {
        try {
            if (baseDir.exists()) {
                baseDir.listFiles()?.forEach { deleteRecursive(it) }
            }
        } catch (_: Exception) {}
    }

    private fun deleteRecursive(f: File) {
        if (f.isDirectory) {
            f.listFiles()?.forEach { deleteRecursive(it) }
        }
        f.delete()
    }

    fun isInstalled(): Boolean = hasBash()

    fun hasBash(): Boolean =
        File(rootfsDir, "usr/bin/bash").isFile || File(rootfsDir, "bin/bash").isFile

    fun markInstalled() {
        markerFile.parentFile?.mkdirs()
        try {
            FileOutputStream(markerFile).use { o ->
                o.write("installed=${System.currentTimeMillis()}\n".toByteArray())
            }
        } catch (_: IOException) {}
    }

    /** 准备运行时：复制依赖库、创建目录 */
    fun ensureRuntimeFiles() {
        baseDir.mkdirs()
        tmpDir.mkdirs()
        libDir.mkdirs()

        // libtalloc.so.2 (proot 的 NEEDED)
        copyExec(findNativeLib("libtalloc.so"), File(libDir, "libtalloc.so.2"))
        // libandroid-shmem.so
        copyExec(findNativeLib("libandroidshmem.so"), File(libDir, "libandroid-shmem.so"))
    }

    private fun findNativeLib(name: String): File {
        val direct = File(nativeLibDir, name)
        if (direct.isFile) return direct
        val libRoot = File(nativeLibDir).parentFile
        if (libRoot?.isDirectory == true) {
            libRoot.listFiles()?.forEach { sub ->
                if (sub.isDirectory) {
                    val f = File(sub, name)
                    if (f.isFile) return f
                }
            }
        }
        return direct
    }

    fun prootPath(): String =
        findNativeLib("libproot.so").absolutePath

    private fun copyExec(src: File, dst: File) {
        if (src.isFile && !dst.exists()) {
            try {
                FileInputStream(src).use { `in` ->
                    FileOutputStream(dst).use { out ->
                        `in`.copyTo(out)
                    }
                }
                dst.setExecutable(true)
                try {
                    android.system.Os.chmod(dst.absolutePath, 0x1ed)
                } catch (_: Throwable) {}
            } catch (_: IOException) {}
        }
    }

    fun setupResolvConf() {
        val rc = File(rootfsDir, "etc/resolv.conf")
        rc.parentFile?.mkdirs()
        if (rc.exists()) rc.delete()
        try {
            FileOutputStream(rc).use { o ->
                o.write("nameserver 223.5.5.5\nnameserver 119.29.29.29\nnameserver 8.8.8.8\nnameserver 1.1.1.1\n".toByteArray())
            }
        } catch (_: IOException) {}
    }

    /** 在 rootfs 内执行 bash 命令 */
    fun execRootfs(bashCommand: String): Process {
        val argv = mutableListOf(
            prootPath(),
            "--link2symlink", "-L", "--kill-on-exit",
            "-0",
            "--rootfs=${rootfsDir.absolutePath}",
            "--cwd=/root",
            "-b", "/dev",
            "-b", "/dev/urandom:/dev/random",
            "-b", "/proc",
            "-b", "/sys",
            "-b", "/proc/self/fd:/dev/fd",
            // 手机存储挂载：让 rootfs 内 /sdcard 指向 Android 手机存储（工作区必须可选手机文件夹）
            "-b", "/storage:/storage",
            "-b", "/storage/emulated/0:/sdcard"
        )
        // 持久化用户数据 bind：外部存储 Simona/data → rootfs 内路径。
        // 每次 proot 启动自动生效，卸载重装 rootfs 重建后依然指向外部数据 → 数据不丢失。
        argv.addAll(persistentBindArgs())
        argv.add("/bin/bash"); argv.add("-c"); argv.add(bashCommand)
        val pb = ProcessBuilder(*argv.toTypedArray()).redirectErrorStream(true)
        pb.environment().apply {
            put("PROOT_TMP_DIR", tmpDir.absolutePath)
            put("PROOT_LOADER", findNativeLib("libprootloader.so").absolutePath)
            put("PROOT_LOADER_32", findNativeLib("libprootloader32.so").absolutePath)
            put("LD_LIBRARY_PATH", "${libDir.absolutePath}:${File(prootPath()).parent}")
            put("HOME", "/root")
            put("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
            put("TMPDIR", "/tmp")
            put("DEBIAN_FRONTEND", "noninteractive")
        }
        return pb.start()
    }

    /** 生成持久化用户数据的 proot -b 绑定参数（外部 /storage/emulated/0/Simona → rootfs 内路径）。
     *  外部存储不可用时（例如未授予"所有文件访问"权限）返回空列表 → 数据保留在 rootfs 内。 */
    private fun persistentBindArgs(): List<String> {
        val args = mutableListOf<String>()
        try {
            val simonaRoot = File("/storage/emulated/0/Simona")
            if (simonaRoot.isDirectory) {
                for ((rel, guest) in PERSISTENT_DIRS) {
                    val hostDir = File(simonaRoot, rel)
                    hostDir.mkdirs()
                    if (hostDir.isDirectory) {
                        args.add("-b")
                        args.add("${hostDir.absolutePath}:$guest")
                    }
                }
            }
        } catch (_: Exception) {}
        return args
    }

    /** 启动 bridge-server 的快捷方法 */
    fun startBridgeServer(nodePath: String, serverPath: String): Process {
        return execRootfs("$nodePath $serverPath --port 30080 --host 0.0.0.0")
    }

    /** 执行命令并读取输出 */
    fun execAndRead(bashCommand: String): String {
        return try {
            val p = execRootfs(bashCommand)
            val output = p.inputStream.bufferedReader().readText()
            p.waitFor()
            output
        } catch (e: Exception) {
            "ERROR: ${e.javaClass.simpleName}: ${e.message}"
        }
    }

    /** 删除整个环境 */
    fun uninstall() {
        cleanupForReinstall()
    }

    private fun File.deleteRecursively() {
        if (isDirectory) {
            listFiles()?.forEach { it.deleteRecursively() }
        }
        delete()
    }
}