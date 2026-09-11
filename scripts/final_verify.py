# final_verify.py — 验证 APK 内 native libs 与 assets 的真实架构
import io, os, sys, zipfile, gzip, struct

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

APK = r"D:\Python work\软件包\Simona\SimonaMobile-arm64-v1.0.0-offline.apk"
ARCH = {0x3e: "x86_64", 0xb7: "ARM64", 0x03: "i386", 0x28: "ARM32"}

def elf_arch(data):
    if data[:4] != b"\x7fELF" or len(data) < 20:
        return None
    m = struct.unpack("<H", data[18:20])[0]
    return ARCH.get(m, "0x%x" % m)

def check_tar_gzip_member(raw, label):
    try:
        g = gzip.GzipFile(fileobj=io.BytesIO(raw))
        data = g.read(1024 * 1024 * 256)  # 最多读 256MB
        hits = {}
        idx = 0
        while True:
            idx = data.find(b"\x7fELF", idx)
            if idx < 0:
                break
            if idx + 20 <= len(data):
                m = struct.unpack("<H", data[idx+18:idx+20])[0]
                hits[m] = hits.get(m, 0) + 1
            idx += 1
        if hits:
            desc = ", ".join(f"{ARCH.get(m,hex(m))}x{m}" for m in sorted(hits)[:5])
            print(f"    {label}: ELF items -> {desc}")
            return 0xb7 in hits
        print(f"    {label}: 未找到 ELF 头 (架构无关?)")
        return True
    except Exception as e:
        print(f"    {label}: 解析失败 {e!r}")
        return False

zf = zipfile.ZipFile(APK)
print("APK:", APK)
print("=" * 60)
print(">> native libs (lib/):")
libs = [n for n in zf.namelist() if n.startswith("lib/") and n.endswith(".so")]
arch_libs = {}
for n in libs:
    a = n.split("/")[1]
    arch_libs.setdefault(a, []).append(n)
for a, names in sorted(arch_libs.items()):
    print(f"  [{a}] {len(names)} libs")
    # 检查第一个 lib 的架构
    first = names[0]
    d = zf.read(first)[:64]
    ea = elf_arch(d)
    print(f"    sample {first.split('/')[-1]} -> {ea}")
if not libs:
    print("  (无 lib/)")
    # 检查 libproot 是否被放置到其他位置
    for n in zf.namelist():
        if "proot" in n.lower():
            print("  found proot in:", n)

print(">> assets (offline):")
for n in ["assets/offline-rootfs.bin", "assets/offline-node.bin", "assets/offline-bun.bin", "assets/offline-engine.bin"]:
    if n in zf.namelist():
        info = zf.getinfo(n)
        print(f"  {n}: {info.file_size/1048576:.1f} MB")
        # 解压前几 MB 检查
        raw = zf.read(n)
        if raw[:4] == b"PK\x03\x04":
            # zip (bun)
            zi = zipfile.ZipFile(io.BytesIO(raw))
            for zn in zi.namelist():
                if zn.endswith("/bun") or zn.endswith("/node"):
                    ea = elf_arch(zi.read(zn)[:64])
                    print(f"    {zn} -> {ea}")
                    break
        else:
            check_tar_gzip_member(raw, n.split("/")[-1])
    else:
        print(f"  {n}: 不在 APK 中!")

zf.close()
print("=" * 60)
print("DONE")