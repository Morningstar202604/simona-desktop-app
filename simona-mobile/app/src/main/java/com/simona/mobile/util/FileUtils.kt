package com.simona.mobile.util

import java.io.*

object FileUtils {

    /** 递归删除文件/目录 */
    fun deleteRecursively(file: File) {
        if (file.isDirectory) {
            file.listFiles()?.forEach { deleteRecursively(it) }
        }
        file.delete()
    }

    /** 复制文件 */
    fun copyFile(src: File, dst: File) {
        dst.parentFile?.mkdirs()
        FileInputStream(src).use { `in` ->
            FileOutputStream(dst).use { out ->
                `in`.copyTo(out)
            }
        }
    }

    /** 复制目录 */
    fun copyDirectory(src: File, dst: File) {
        if (!src.isDirectory) return
        dst.mkdirs()
        src.listFiles()?.forEach { child ->
            val destChild = File(dst, child.name)
            if (child.isDirectory) {
                copyDirectory(child, destChild)
            } else {
                copyFile(child, destChild)
            }
        }
    }

    /** 获取文件扩展名 */
    fun getExtension(fileName: String): String {
        val idx = fileName.lastIndexOf('.')
        return if (idx >= 0) fileName.substring(idx) else ""
    }

    /** 读取文件为字符串 */
    fun readText(file: File): String {
        return file.inputStream().bufferedReader().use { it.readText() }
    }

    /** 写入字符串到文件 */
    fun writeText(file: File, text: String) {
        file.parentFile?.mkdirs()
        file.outputStream().bufferedWriter().use { it.write(text) }
    }

    /** 获取目录大小（字节） */
    fun getDirectorySize(dir: File): Long {
        if (!dir.isDirectory) return dir.length()
        return dir.listFiles()?.sumOf { child ->
            if (child.isDirectory) getDirectorySize(child) else child.length()
        } ?: 0L
    }
}