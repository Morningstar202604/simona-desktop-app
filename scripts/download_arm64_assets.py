# download_arm64_assets.py
# 下载 ARM64 版 rootfs/node/bun 并替换 assets 中的 x86_64 版本
import os, sys, shutil, io, gzip, lzma, tarfile, zipfile, struct, urllib.request, time

ASSETS = r"D:/Python work/软件包/Simona/simona-mobile/app/src/main/assets"
BACKUP = r"D:/Python work/软件包/Simona/backup_assets_x86_64"
TEMP = r"D:/Python work/软件包/Simona/temp"
os.makedirs(BACKUP, exist_ok=True)
os.makedirs(TEMP, exist_ok=True)

print("=" * 60)
print("ARM64 资产下载与替换")
print("=" * 60)

# 1. 备份现有 x86_64 资产
print("\n>>> 1. 备份现有 x86_64 资产到 backup_assets_x86_64/")
for f in ["offline-rootfs.bin", "offline-node.bin", "offline-bun.bin"]:
    src = os.path.join(ASSETS, f)
    dst = os.path.join(BACKUP, f)
    if os.path.exists(src):
        if not os.path.exists(dst):
            shutil.copy2(src, dst)
            print(f"   备份: {f} ({os.path.getsize(dst) / 1048576:.1f} MB)")
        else:
            print(f"   已存在: {f}")
    else:
        print(f"   警告: {f} 不存在!")

# 2. 下载工具函数
AGENT = "SimonaBuild/1.0"
TIMEOUT = 300

def download(url, dest, retries=3):
    """下载文件，带重试和进度"""
    for attempt in range(retries):
        try:
            print(f"  下载: {url}")
            req = urllib.request.Request(url, headers={"User-Agent": AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                total = int(resp.headers.get("Content-Length", 0))
                downloaded = 0
                last_pct = -1
                with open(dest, "wb") as f:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        f.write(chunk)
                        downloaded += len(chunk)
                        if total > 0:
                            pct = int(downloaded * 100 / total)
                            if pct != last_pct and pct % 10 == 0:
                                print(f"   进度: {pct}% ({downloaded / 1048576:.1f}/{total / 1048576:.1f} MB)")
                                last_pct = pct
                print(f"   完成: {downloaded / 1048576:.1f} MB")
                return True
        except Exception as e:
            print(f"   尝试 {attempt+1}/{retries} 失败: {e}")
            if attempt < retries - 1:
                time.sleep(3)
    return False

def elf_machine(data):
    if data[:4] == b"\x7fELF":
        return struct.unpack("<H", data[18:20])[0]
    return None

def verify_elf(path, label, want_machine=0xb7):
    """验证文件中的 ELF 二进制架构"""
    print(f"  验证 {label} 架构...")
    size = os.path.getsize(path)
    if path.endswith(".zip") or path.endswith(".bin") and open(path, "rb").read(4) == b"PK\x03\x04":
        # zip 文件
        z = zipfile.ZipFile(path)
        for n in z.namelist():
            if n.endswith("/bun") or n.endswith("/node"):
                data = z.read(n)[:64]
                m = elf_machine(data)
                if m:
                    name = {0x3e: "x86_64", 0xb7: "AArch64(arm64)", 0x03: "i386", 0x28: "ARM32"}.get(m, hex(m))
                    ok = m == want_machine
                    status = "OK" if ok else "MISMATCH(expected ARM64 0xb7)"
                    print(f"    {n} -> {name} [{status}]")
                    return ok
        print("   未找到 ELF 二进制!")
        return False
    else:
        # gzip tar 文件
        with open(path, "rb") as f:
            if f.read(2) == b"\x1f\x8b":
                f.seek(0)
                data = gzip.decompress(f.read())
            else:
                f.seek(0)
                data = f.read()
        candidates = []
        idx = 0
        while True:
            idx = data.find(b"\x7fELF", idx)
            if idx < 0 or len(candidates) >= 10:
                break
            if idx + 20 <= len(data):
                m = struct.unpack("<H", data[idx+18:idx+20])[0]
                if m not in (0x3e, 0xb7, 0x03, 0x28):
                    idx += 1
                    continue
                candidates.append((idx, m))
                if m == want_machine:
                    break
            idx += 1
        if candidates:
            counts = {}
            for _, m in candidates:
                counts[m] = counts.get(m, 0) + 1
            name = {0x3e: "x86_64", 0xb7: "AArch64(arm64)", 0x03: "i386", 0x28: "ARM32"}
            for m, c in sorted(counts.items(), key=lambda x: -x[1]):
                arch = name.get(m, hex(m))
                status = "OK" if m == want_machine else "MISMATCH(expected ARM64 0xb7)"
                print(f"    ELF {arch}: {c} occurrences [{status}]")
            return any(m == want_machine for _, m in candidates)
        else:
            print("   未找到 ELF 头 (架构无关文件?)")
            return True  # 没有 ELF 的文件视为 OK（如纯 JS）

# 3. 下载 ARM64 rootfs
print("\n>>> 2. 下载 ARM64 rootfs (ubuntu-base-24.04.4-base-arm64)")
rootfs_urls = [
    "https://mirror.nju.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04.4/release/ubuntu-base-24.04.4-base-arm64.tar.gz",
    "https://mirrors.hit.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04.4/release/ubuntu-base-24.04.4-base-arm64.tar.gz",
    "https://mirrors.aliyun.com/ubuntu-cdimage/ubuntu-base/releases/24.04.4/release/ubuntu-base-24.04.4-base-arm64.tar.gz",
    "https://mirrors.tuna.tsinghua.edu.cn/ubuntu-cdimage/ubuntu-base/releases/24.04.4/release/ubuntu-base-24.04.4-base-arm64.tar.gz",
    "https://cdimage.ubuntu.com/ubuntu-base/releases/24.04.4/release/ubuntu-base-24.04.4-base-arm64.tar.gz",
]
rootfs_dest = os.path.join(TEMP, "ubuntu-base-24.04.4-base-arm64.tar.gz")
rootfs_ok = False
for url in rootfs_urls:
    if download(url, rootfs_dest):
        if verify_elf(rootfs_dest, "rootfs", want_machine=0xb7):
            rootfs_ok = True
            break
        else:
            print("  架构验证失败，尝试下一个源...")
            os.remove(rootfs_dest)
    else:
        print("  下载失败，尝试下一个源...")

if rootfs_ok:
    shutil.copy2(rootfs_dest, os.path.join(ASSETS, "offline-rootfs.bin"))
    print(f"  -> 已复制到 assets/offline-rootfs.bin")
else:
    print("  错误: 所有 rootfs 镜像均失败!")
    sys.exit(1)

# 4. 下载 ARM64 node
print("\n>>> 3. 下载 ARM64 node (node-v24.19.0-linux-arm64)")
node_urls = [
    "https://mirrors.huaweicloud.com/nodejs/v24.19.0/node-v24.19.0-linux-arm64.tar.gz",
    "https://npmmirror.com/mirrors/node/v24.19.0/node-v24.19.0-linux-arm64.tar.gz",
    "https://mirrors.aliyun.com/nodejs-release/v24.19.0/node-v24.19.0-linux-arm64.tar.gz",
    "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-arm64.tar.gz",
]
node_dest = os.path.join(TEMP, "node-v24.19.0-linux-arm64.tar.gz")
node_ok = False
for url in node_urls:
    if download(url, node_dest):
        if verify_elf(node_dest, "node", want_machine=0xb7):
            node_ok = True
            break
        else:
            print("  架构验证失败，尝试下一个源...")
            os.remove(node_dest)

# 如果 tar.gz 全部失败，尝试 tar.xz
if not node_ok:
    print("\n>>> tar.gz 源均失败，尝试 tar.xz 源...")
    node_xz_urls = [
        "https://mirrors.huaweicloud.com/nodejs/v24.19.0/node-v24.19.0-linux-arm64.tar.xz",
        "https://npmmirror.com/mirrors/node/v24.19.0/node-v24.19.0-linux-arm64.tar.xz",
        "https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-arm64.tar.xz",
    ]
    node_xz_dest = os.path.join(TEMP, "node-v24.19.0-linux-arm64.tar.xz")
    for url in node_xz_urls:
        if download(url, node_xz_dest):
            print("  转换 tar.xz -> tar.gz ...")
            with open(node_xz_dest, "rb") as f:
                tar_data = lzma.decompress(f.read())
            buf = io.BytesIO()
            with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
                gz.write(tar_data)
            with open(node_dest, "wb") as f:
                f.write(buf.getvalue())
            print(f"  gzip 大小: {os.path.getsize(node_dest) / 1048576:.1f} MB")
            if verify_elf(node_dest, "node(converted)", want_machine=0xb7):
                node_ok = True
                break
            else:
                os.remove(node_dest)

if node_ok:
    shutil.copy2(node_dest, os.path.join(ASSETS, "offline-node.bin"))
    print(f"  -> 已复制到 assets/offline-node.bin")
else:
    print("  错误: 所有 node 镜像均失败!")
    sys.exit(1)

# 5. 下载 ARM64 bun
print("\n>>> 4. 下载 ARM64 bun (bun-linux-aarch64)")
bun_urls = [
    "https://github.com/oven-sh/bun/releases/download/bun-v1.2.8/bun-linux-aarch64.zip",
    "https://mirror.nju.edu.cn/github-release/oven-sh/bun/bun-v1.2.8/bun-linux-aarch64.zip",
]
bun_dest = os.path.join(TEMP, "bun-linux-aarch64.zip")
bun_ok = False
for url in bun_urls:
    if download(url, bun_dest):
        if verify_elf(bun_dest, "bun", want_machine=0xb7):
            bun_ok = True
            break
        else:
            print("  架构验证失败，尝试下一个源...")
            os.remove(bun_dest)

if bun_ok:
    shutil.copy2(bun_dest, os.path.join(ASSETS, "offline-bun.bin"))
    print(f"  -> 已复制到 assets/offline-bun.bin")
else:
    print("  错误: 所有 bun 镜像均失败!")
    sys.exit(1)

# 6. 最终验证
print("\n" + "=" * 60)
print(">>> 5. 最终验证: 所有替换后的资产架构")
print("=" * 60)
for f in ["offline-rootfs.bin", "offline-node.bin", "offline-bun.bin", "offline-engine.bin"]:
    p = os.path.join(ASSETS, f)
    if os.path.exists(p):
        print(f"  {f}: {os.path.getsize(p) / 1048576:.1f} MB")
        verify_elf(p, f, want_machine=0xb7)
    else:
        print(f"  {f}: 不存在!")

print("\n" + "=" * 60)
print("ARM64 资产替换完成!")
print("=" * 60)
print(f"备份: {BACKUP}/")
print(f"Temp: {TEMP}/")
print(f"Assets: {ASSETS}/")