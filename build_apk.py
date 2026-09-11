# build_apk.py — 重新构建 APK（含 engine 修复）
import subprocess, sys, os, shutil

BASE = r"E:\Simona"
BUILD = os.path.join(BASE, "simona-mobile")
GRADLEW = os.path.join(BUILD, "gradlew.bat")

os.environ["ANDROID_HOME"] = r"E:\Android"
os.environ["JAVA_HOME"] = r"E:\Android\jdk21"

print("GRADLEW:", GRADLEW, "exists:", os.path.exists(GRADLEW))
print("Building APK with engine fix...")

cmd = f'cd /d "{BUILD}" && call "{GRADLEW}" :app:assembleDebug -Pabi=x86_64 --no-daemon'

result = subprocess.run(cmd, shell=True, capture_output=True, timeout=1800)

# 尝试多种编码解码
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
tail = lines[-100:] if len(lines) > 100 else lines
print("--- last 100 lines ---")
for l in tail:
    print(l)

if err.strip():
    print("--- stderr tail ---")
    e_lines = err.splitlines()
    for l in (e_lines[-30:] if len(e_lines) > 30 else e_lines):
        print(l)

apk = os.path.join(BUILD, "app", "build", "outputs", "apk", "debug", "app-debug.apk")
final = os.path.join(BASE, "SimonaMobile-x86_64-v1.0.0-offline.apk")
if os.path.exists(apk) and result.returncode == 0:
    shutil.copy2(apk, final)
    print("=== APK 构建成功 ===")
    print("APK:", final)
    print("size: {:.1f} MB".format(os.path.getsize(final) / 1048576))
else:
    print("=== APK 构建失败或未找到输出 ===")
    print("apk path:", apk)
    print("apk exists:", os.path.exists(apk))