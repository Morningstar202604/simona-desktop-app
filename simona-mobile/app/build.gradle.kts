import java.util.zip.ZipFile

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 目标 ABI（通过 -Pabi=x86_64 或 -Pabi=arm64-v8a 控制；默认 arm64-v8a）
val targetAbi = (project.findProperty("abi") as? String) ?: "arm64-v8a"

// 离线资产检查（参考 DSHA 设计：把 rootfs/Node.js/Bun 打包进 APK）
val offlineGz = file("src/main/assets/offline-rootfs.tar.gz")
val offlineBin = file("src/main/assets/offline-rootfs.bin")
val offlineNodeGz = file("src/main/assets/offline-node.tar.gz")
val offlineNodeBin = file("src/main/assets/offline-node.bin")
val offlineBunZip = file("src/main/assets/offline-bun.zip")
val offlineBunBin = file("src/main/assets/offline-bun.bin")
val offlineEngineGz = file("src/main/assets/offline-engine.tar.gz")
val offlineEngineBin = file("src/main/assets/offline-engine.bin")

// aapt 会把 .tar.gz 自动解压成 .tar。打进 APK 前改名为 .bin。
tasks.register("protectOfflineBundle") {
    doLast {
        fun protect(tarGz: File, bin: File) {
            if (tarGz.exists()) {
                bin.delete()
                if (!tarGz.renameTo(bin)) {
                    throw GradleException("无法把 ${tarGz.name} 改名为 .bin")
                }
                println("已保护: ${tarGz.name} → ${bin.name}")
            }
        }
        protect(offlineGz, offlineBin)
        protect(offlineNodeGz, offlineNodeBin)
        protect(offlineBunZip, offlineBunBin)
        protect(offlineEngineGz, offlineEngineBin)
    }
}
tasks.configureEach {
    if (name == "preBuild" || name == "preDebugBuild") {
        dependsOn("protectOfflineBundle")
    }
}

android {
    namespace = "com.simona.mobile"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.simona.mobile"
        minSdk = 29
        targetSdk = 33
        versionCode = 3
        versionName = "1.1.0"
        ndk {
            abiFilters += targetAbi
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
        jniLibs {
            useLegacyPackaging = true
            // 仅排除 32 位 ABI，保留 x86_64（x86_64 版 proot 需要）
            excludes += listOf("**/x86/**", "**/armeabi/**", "**/armeabi-v7a/**")
        }
    }

    androidResources {
        noCompress += listOf("gz", "xz")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.webkit:webkit:1.9.0")
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
}

afterEvaluate {
    val verify = tasks.register("verifyArm64Apk") {
        doLast {
            val apk = file("build/outputs/apk/debug/app-debug.apk")
            if (!apk.isFile) {
                throw GradleException("找不到 $apk")
            }
            val libs = mutableListOf<String>()
            val assets = mutableListOf<String>()
            val zf = ZipFile(apk)
            try {
                val entries = zf.entries()
                while (entries.hasMoreElements()) {
                    val e = entries.nextElement()
                    if (e.name.startsWith("lib/") && e.name.endsWith(".so")) {
                        libs += e.name
                    }
                    if (e.name.contains("offline") || e.name.contains("rootfs") || e.name.startsWith("assets/")) {
                        assets += "${e.name} size=${e.size}"
                    }
                }
            } finally {
                zf.close()
            }
            println("===== APK native libs =====")
            libs.forEach { println("  $it") }
            println("===== APK assets =====")
            assets.forEach { println("  $it") }
            if (libs.isEmpty()) {
                throw GradleException("APK 里没有 lib/*.so")
            }
            if (!libs.any { it.startsWith("lib/$targetAbi/") }) {
                throw GradleException("APK 不含 lib/$targetAbi/")
            }
        }
    }
    tasks.matching { it.name == "assembleDebug" }.configureEach {
        finalizedBy(verify)
    }
}