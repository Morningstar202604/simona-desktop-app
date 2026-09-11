# fix_engine_full.py — 从头重新打包 engine（包含全部 node_modules/dist/src）
import os, sys, io, re, shutil, tarfile, zipfile, subprocess, time

BASE = r"D:\Python work\软件包\Simona"
ENGINE = os.path.join(BASE, "engine")
ASSETS = os.path.join(BASE, "simona-mobile", "app", "src", "main", "assets")
BUILD = os.path.join(BASE, "simona-mobile")

ASSET_ENGINE_BIN = os.path.join(ASSETS, "offline-engine.bin")
ASSET_ENGINE_GZ = os.path.join(ASSETS, "offline-engine.tar.gz")
ASSET_BUN = os.path.join(ASSETS, "offline-bun.bin")
ASSET_BUN_ZIP = os.path.join(ASSETS, "offline-bun.zip")
BUN_CANDIDATES = [
    os.path.join(BASE, "bun-v1.2.23-linux-x64.zip"),
    os.path.join(BASE, "bun-v1.2.8-linux-x64.zip"),
]

def find_versions(data):
    return sorted(set(m.group().decode() for m in re.finditer(rb"Bun v[\d.]+", data)))

def check_bun_zip(path):
    try:
        z = zipfile.ZipFile(path)
    except:
        return None, "not a zip"
    for n in z.namelist():
        if n.endswith("/bun"):
            b = z.read(n)[:64]
            if b[:4] != b"\x7fELF": continue
            e = int.from_bytes(b[18:20], "little")
            vs = find_versions(z.read(n))
            return (e == 0x3e, vs)
    return None, "no /bun member"

def build_engine_tar():
    """从头创建 engine tar.gz，包含所有所需文件"""
    tar_path = os.path.join(BASE, "offline-engine.full.tar.gz")
    # 要打包的 engine/ 下所有顶层条目
    items = os.listdir(ENGINE)
    skip = {".tscheck", "node_modules.rar", "package-lock.json"}
    include = [i for i in items if i not in skip and not i.startswith(".")]
    print("  engine items to tar:", include)
    total = 0
    with tarfile.open(tar_path, "w:gz") as tar:
        for item in include:
            src = os.path.join(ENGINE, item)
            if not os.path.exists(src):
                print("  skip (missing):", item); continue
            tar.add(src, arcname=item, recursive=True)
            if os.path.isfile(src):
                total += os.path.getsize(src)
            else:
                for dp, dn, fn in os.walk(src):
                    for f in fn:
                        fp = os.path.join(dp, f)
                        if os.path.isfile(fp):
                            total += os.path.getsize(fp)
    print("  tar.gz created: {:.0f} MB".format(os.path.getsize(tar_path) / 1048576))
    print("  estimated uncompressed: {:.0f} MB".format(total / 1048576))
    return tar_path

def verify_tar(tar_path):
    """验证 tar 中的关键文件"""
    checks = {}
    with tarfile.open(tar_path, "r:gz") as t:
        members = t.getmembers()
        names = [m.name for m in members]
        checks["has_cli"] = any(n.endswith("entrypoints/cli.tsx") for n in names)
        checks["total_members"] = len(members)
        for m in members:
            if m.name.endswith("bootstrap/state.ts"):
                blob = t.extractfile(m).read()
                checks["has_isReplBridgeActive"] = b"export function isReplBridgeActive" in blob
                checks["state_member"] = m.name
                break
        checks["has_node_modules"] = any(
            n.startswith("node_modules/") and n.endswith("/package.json") for n in names[:500]
        )
    return checks

def main():
    print("=" * 64)
    print("fix_engine_full.py — 从头重新打包完整 engine")
    print("=" * 64)

    # 1. 检查 engine/ 目录
    print("\n[1/5] Check engine source...")
    st = os.path.join(ENGINE, "src", "bootstrap", "state.ts")
    if os.path.exists(st):
        s = open(st, encoding="utf-8").read()
        has_export = "export function isReplBridgeActive" in s
        print("  state.ts has isReplBridgeActive:", has_export)
    cli = os.path.join(ENGINE, "src", "entrypoints", "cli.tsx")
    print("  cli.tsx exists:", os.path.exists(cli))
    nm = os.path.join(ENGINE, "node_modules")
    if os.path.exists(nm):
        nms = os.listdir(nm)
        print("  node_modules entries:", len(nms))
    else:
        print("  FATAL: no node_modules!"); sys.exit(1)

    # 2. 从头打包 engine
    print("\n[2/5] Build fresh engine tar.gz...")
    t0 = time.time()
    tar_path = build_engine_tar()
    print("  time: {:.0f}s".format(time.time() - t0))

    # 3. 验证
    print("\n[3/5] Verify tar contents...")
    v = verify_tar(tar_path)
    print("  members:", v["total_members"])
    print("  cli.tsx:", v["has_cli"])
    print("  isReplBridgeActive:", v.get("has_isReplBridgeActive", False))
    print("  state member:", v.get("state_member", "NOT FOUND"))
    print("  node_modules/package.json:", v.get("has_node_modules", False))
    if not v["has_cli"] or not v.get("has_isReplBridgeActive"):
        print("  FATAL: tar verification failed"); sys.exit(1)

    # 4. 替换 assets
    print("\n[4/5] Replace assets/offline-engine.bin ...")
    old_bak = ASSET_ENGINE_BIN + ".bak2"
    if os.path.exists(ASSET_ENGINE_BIN):
        if not os.path.exists(old_bak):
            shutil.copy2(ASSET_ENGINE_BIN, old_bak)
            print("  backup old ->", os.path.basename(old_bak))
    # 删掉 .tar.gz 避免 protectOfflineBundle 覆盖 .bin
    if os.path.exists(ASSET_ENGINE_GZ):
        os.remove(ASSET_ENGINE_GZ)
        print("  removed", os.path.basename(ASSET_ENGINE_GZ))
    shutil.copy2(tar_path, ASSET_ENGINE_BIN)
    print("  -> assets/offline-engine.bin: {:.1f} MB".format(os.path.getsize(ASSET_ENGINE_BIN) / 1048576))

    # 也检查 bun 资源
    print("\n  --- bun check ---")
    if os.path.exists(ASSET_BUN):
        bb = open(ASSET_BUN, "rb").read()
        print("  offline-bun.bin: {}b zip={} versions={}".format(
            len(bb), bb[:4] == b"PK\x03\x04", find_versions(bb)))
    else:
        print("  WARN: no offline-bun.bin, need to restore from .bak or select candidate")

    # 5. 重建 APK
    print("\n[5/5] Rebuild APK (-Pabi=x86_64)...")
    gradlew = os.path.join(BUILD, "gradlew.bat")
    cmd = '"{}" :app:assembleDebug -Pabi=x86_64 --no-daemon'.format(gradlew)
    print("  running:", cmd)
    r = subprocess.run(cmd, cwd=BUILD, shell=True, capture_output=True, text=True, timeout=1800)
    print("  returncode:", r.returncode)
    for ln in (r.stdout or "").splitlines():
        if "BUILD" in ln or "FAIL" in ln or "error:" in ln or "ERROR" in ln:
            print("  " + ln)
    apk = os.path.join(BUILD, "app", "build", "outputs", "apk", "debug", "app-debug.apk")
    dst = os.path.join(BASE, "SimonaMobile-x86_64-v1.0.0-offline.apk")
    if os.path.exists(apk):
        shutil.copy2(apk, dst)
        print("\n[OK] APK ->", dst)
        print("      size: {:.1f} MB".format(os.path.getsize(dst) / 1048576))
        # 验证 APK 内 engine
        z = zipfile.ZipFile(dst)
        for n in z.namelist():
            if n.startswith("assets/offline-engine."):
                raw = z.read(n)
                try:
                    t = tarfile.open(fileobj=io.BytesIO(__import__("gzip").decompress(raw)), mode="r:*")
                    has_cli = any(m.name.endswith("cli.tsx") for m in t.getmembers())
                    has_export = False
                    for m in t.getmembers():
                        if m.name.endswith("state.ts"):
                            has_export = b"isReplBridgeActive" in t.extractfile(m).read()
                            break
                    print("  APK {}: {}b, has_cli={}, has_export={}".format(n, len(raw), has_cli, has_export))
                except Exception as e:
                    print("  APK {} extract err: {}".format(n, e))
            if n.startswith("assets/offline-bun."):
                d = z.read(n)
                print("  APK {}: {}b zip={} versions={}".format(n, len(d), d[:4]==b"PK\x03\x04", find_versions(d)))
    else:
        print("\n[FAIL] APK not built:", apk)

    print("\n" + "=" * 64)
    print("NEXT STEPS (MUST FRESH INSTALL):")
    print("  adb uninstall com.simona.mobile")
    print('  adb install -r "{}"'.format(dst))
    print("=" * 64)

if __name__ == "__main__":
    main()