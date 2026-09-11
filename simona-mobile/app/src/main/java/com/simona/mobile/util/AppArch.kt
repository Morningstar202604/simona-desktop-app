package com.simona.mobile.util

import android.os.Build

/**
 * 架构感知工具类：根据设备 ABI 选择 arm64 / x86_64 的资源
 */
object AppArch {

    /** 当前设备是否为 arm64 架构（arm64-v8a 或 arm64） */
    val isArm64: Boolean
        get() = Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "arm64" }

    /** 当前设备 ABI 显示名 */
    val abiName: String
        get() = Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown"

    /** rootfs 目录名（arm64 用 ubuntu，x86_64 用 ubuntu-x64） */
    fun rootfsDirName(): String = if (isArm64) "ubuntu" else "ubuntu-x64"

    /** rootfs 文件名动词（arm64 用 arm64，x86_64 用 amd64） */
    fun rootfsWord(): String = if (isArm64) "arm64" else "amd64"

    /** Node.js 平台字符串 */
    fun nodePlatform(): String = if (isArm64) "linux-arm64" else "linux-x64"

    /** Bun 平台字符串 */
    fun bunPlatform(): String = if (isArm64) "linux-aarch64" else "linux-x64"
}