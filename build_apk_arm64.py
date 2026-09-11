# build_apk_arm64.py — 基于当前成功源码构建 ARM64 APK（-Pabi=arm64-v8a）
import subprocess, os, shutil

BASE = r"E:\Simona"
BUILD = os.path.join(BASE, "simona-mobile")
GRADLEW = os.path.join(BUILD, "gradlew.bat")

os.environ["ANDROID_HOME"] = r"E:\Android"
os.environ["JAVA_HOME"] = r"E:\Android\jdk21"

print("Building ARM64 APK (-Pabi=arm64-v8a) ...")
cmd = f'cd /d "{BUILD}" && call "{GRADLEW}" :app:assembleDebug -Pabi=arm64-v8a --no-daemon --no-build-cache'

result = subprocess.run(cmd, shell=True, capture_output=True, timeout=1800)

def decode(data):
    for enc in ("utf-8", "gbk", "gb2312", "latin1"):
        try:
            return data.decode(enc)
        except Exception:
            continue
    return repr(data)

out = decode(result.stdout)
err = decode(result.stderr)
print("=== returncode:", result.returncode)

lines = out.splitlines()
for l in (lines[-120:] if len(lines) > 120 else lines):
    print(l)
if err.strip():
    print("--- stderr tail ---")
    for l in err.splitlines()[-30:]:
        print(l)

apk = os.path.join(BUILD, "app", "build", "outputs", "apk", "debug", "app-debug.apk")
final = os.path.join(BASE, "SimonaMobile-arm64-v1.0.0-offline.apk")
if os.path.exists(apk) and result.returncode == 0:
    shutil.copy2(apk, final)
    print("=== ARM64 APK 构建成功 ===")
    print("APK:", final)
    print("size: {:.1f} MB".format(os.path.getsize(final) / 1048576))
else:
    print("=== APK 构建失败或未找到输出 ===")
    print("apk path:", apk, "exists:", os.path.exists(apk))