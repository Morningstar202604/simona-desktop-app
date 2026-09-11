package com.simona.mobile.util

import android.system.Os
import java.io.*
import java.util.zip.GZIPInputStream

/**
 * 纯 Java/Kotlin 流式 tar/tar.gz 解压器
 * 直接移植自 DSHA 的 TarGzipExtractor.java
 */
object TarGzipExtractor {

    private const val BLOCK = 512

    fun extract(tarball: File, dest: File) = extract(tarball, dest, 0)

    fun extract(tarball: File, dest: File, strip: Int) {
        FileInputStream(tarball).use { raw -> extractAuto(raw, dest, strip) }
    }

    fun extractAuto(raw: InputStream, dest: File, strip: Int) {
        val pin = PushbackInputStream(BufferedInputStream(raw, 1 shl 16), 2)
        val b0 = pin.read()
        val b1 = pin.read()
        if (b0 >= 0) {
            if (b1 >= 0) pin.unread(byteArrayOf(b0.toByte(), b1.toByte()))
            else pin.unread(b0)
        }
        if (b0 == 0x1f && b1 == 0x8b) {
            GZIPInputStream(pin).use { gz -> extractTar(gz, dest, strip) }
        } else {
            extractTar(pin, dest, strip)
        }
    }

    fun extractTar(tar: InputStream, dest: File, strip: Int) {
        val `in` = if (tar is BufferedInputStream) tar else BufferedInputStream(tar, 1 shl 16)
        val header = ByteArray(BLOCK)
        val buf = ByteArray(8192)
        var pendingName: String? = null

        while (true) {
            if (!readFull(`in`, header, BLOCK)) break
            if (isZeroBlock(header)) {
                if (!readFull(`in`, header, BLOCK)) break
                if (isZeroBlock(header)) break
                continue
            }

            var name = parseString(header, 0, 100)
            val size = parseOctal(header, 124, 12)
            val mode = parseOctal(header, 100, 8).toInt()
            val type = header[156].toInt() and 0xFF
            val linkname = parseString(header, 157, 100)

            if (type == 'L'.toInt() || type == 'x'.toInt()) {
                val longData = ByteArray(clampSize(size))
                readFull(`in`, longData, longData.size)
                skipPadding(`in`, size)
                pendingName = if (type == 'L'.toInt()) {
                    parseString(longData, 0, longData.size)
                } else {
                    parsePaxPath(longData)
                }
                continue
            }

            if (pendingName != null) {
                name = pendingName!!
                pendingName = null
            }

            val prefix = parseString(header, 345, 155)
            if (prefix.isNotEmpty()) {
                name = "$prefix/$name"
            }

            var finalName = name
            if (strip > 0) {
                repeat(strip) {
                    val idx = finalName.indexOf('/')
                    if (idx < 0) finalName = ""
                    else finalName = finalName.substring(idx + 1)
                }
                if (finalName.isEmpty()) {
                    skipPadding(`in`, size)
                    continue
                }
            }

            val out = File(dest, finalName)

            when (type) {
                '0'.toInt(), 0, '7'.toInt() -> writeFile(`in`, out, size, mode, buf)
                '5'.toInt() -> {
                    out.mkdirs()
                    skipPadding(`in`, size)
                }
                '2'.toInt() -> {
                    out.parentFile?.mkdirs()
                    try { Os.symlink(linkname, out.absolutePath) } catch (_: Throwable) {}
                    skipPadding(`in`, size)
                }
                '1'.toInt() -> {
                    out.parentFile?.mkdirs()
                    try { Os.link(File(dest, linkname).absolutePath, out.absolutePath) } catch (_: Throwable) {}
                    skipPadding(`in`, size)
                }
                else -> skipPadding(`in`, size)
            }
        }
    }

    private fun writeFile(`in`: InputStream, out: File, size: Long, mode: Int, buf: ByteArray) {
        out.parentFile?.mkdirs()
        // npm 嵌套 node_modules 中，某些 package 可能同时以目录和文件条目出现在 tar 中。
        // 若 out 已存在（如：之前创建了同名目录或 symlink 指向目录），跳过此条目，
        // 避免 FileOutputStream 抛出 EISDIR（Is a directory）异常导致整个解压失败。
        if (out.exists()) {
            skipPadding(`in`, size)
            return
        }
        FileOutputStream(out).use { fos ->
            var remaining = size
            while (remaining > 0) {
                val n = `in`.read(buf, 0, minOf(buf.size.toLong(), remaining).toInt())
                if (n < 0) throw IOException("tar 数据意外结束")
                fos.write(buf, 0, n)
                remaining -= n.toLong()
            }
        }
        try { Os.chmod(out.absolutePath, mode and 0x1ff) } catch (_: Throwable) {}
        skipPadding(`in`, size)
    }

    private fun skipPadding(`in`: InputStream, size: Long) {
        var pad = (BLOCK - (size % BLOCK)) % BLOCK
        var remaining = pad
        while (remaining > 0) {
            val skipped = `in`.skip(remaining)
            if (skipped <= 0) {
                if (`in`.read() < 0) return
                remaining--
            } else {
                remaining -= skipped
            }
        }
    }

    private fun readFull(`in`: InputStream, b: ByteArray, len: Int): Boolean {
        var off = 0
        while (off < len) {
            val n = `in`.read(b, off, len - off)
            if (n < 0) return off == len
            off += n
        }
        return true
    }

    private fun isZeroBlock(b: ByteArray): Boolean {
        for (x in b) if (x != 0.toByte()) return false
        return true
    }

    private fun parseString(b: ByteArray, off: Int, len: Int): String {
        var end = off
        while (end < off + len && b[end] != 0.toByte()) end++
        return String(b, off, end - off, Charsets.UTF_8)
    }

    private fun parseOctal(b: ByteArray, off: Int, len: Int): Long {
        var v = 0L
        for (i in off until off + len) {
            val c = b[i].toInt()
            if (c == 0 || c == ' '.toInt()) continue
            if (c < '0'.toInt() || c > '7'.toInt()) break
            v = v * 8 + (c - '0'.toInt())
        }
        return v
    }

    private fun parsePaxPath(data: ByteArray): String? {
        val s = String(data, Charsets.UTF_8)
        for (line in s.split("\n")) {
            if (line.startsWith("path=")) return line.substring(5)
        }
        return null
    }

    private fun clampSize(size: Long): Int =
        Math.min(size, 64 * 1024).toInt()
}