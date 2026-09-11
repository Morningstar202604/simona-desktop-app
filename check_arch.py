# 检查离线包内部的二进制架构（ELF e_machine）
import os, gzip, tarfile, zipfile, io

BASE = r"D:\Python work\Simona\simona-mobile\app\src\main\assets"

ARCH = {0x3e: "x86_64 (amd64)", 0xb7: "aarch64 (arm64)", 0x03: "i386 (x86)", 0x28: "arm32"}

def elf_arch(data: bytes):
    if data[:4] == b"\x7fELF":
        if len(data) >= 20:
            m = int.from_bytes(data[18:20], "little")
            return ARCH.get(m, hex(m))
        return "ELF(too short)"
    return "-"

def inspect_gzip_tar(path):
    print(f"=== {os.path.basename(path)} (gzip tar) ===")
    try:
        with gzip.open(path, "rb") as f:
            raw = f.read()
        print(f"  decompressed size: {len(raw)} bytes")
    except Exception as e:
        print(f"  gzip decompress error: {e}")
        return None
    # 扫描 ELF 头
    candidates = {}
    idx = 0
    while True:
        idx = raw.find(b"\x7fELF", idx)
        if idx < 0:
            break
        # 检查 e_machine
        if idx + 20 <= len(raw):
            m = int.from_bytes(raw[idx+18:idx+20], "little")
            arch = ARCH.get(m, hex(m))
            candidates.setdefault(arch, []).append(idx)
            if len(candidates) > 8:
                break
        idx += 1
    if candidates:
        for a, offs in sorted(candidates.items(), key=lambda kv: -len(kv[1])):
            print(f"  ELF e_machine {a}: {len(offs)} occurrences (e.g. offset {offs[0]})")
    else:
        print("  NO ELF header found inside decompressed tar!")

def inspect_zip(path):
    print(f"=== {os.path.basename(path)} (zip) ===")
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            print(f"  total entries: {len(names)}")
            # 找 bun/bunx 或 node 二进制
            for target in ("/bin/bun", "/bin/bun.exe", "/bin/node"):
                for n in names:
                    if n.endswith(target):
                        data = z.read(n)
                        print(f"  {n}: {len(data)} bytes, ELF={elf_arch(data[:64])}")
                        return
            # 否则找任意第一个有大文件的
            for n in names:
                if "bin" in n.lower() and not n.endswith("/"):
                    info = z.getinfo(n)
                    if info.file_size > 1000000:
                        print(f"  {n}: {info.file_size} bytes (bin candidate)")
            print("  no direct ELF bin matched; first entries:", names[:5])
    except Exception as e:
        print(f"  zip error: {e}")

for f in ["offline-rootfs.bin", "offline-node.bin", "offline-bun.bin"]:
    p = os.path.join(BASE, f)
    if not os.path.exists(p):
        print(f"{f}: NOT FOUND")
        continue
    print(f"{f}: {os.path.getsize(p)} bytes on disk")
    with open(p, "rb") as fh:
        magic = fh.read(4)
    print(f"  magic: {magic.hex()} {'(gzip)' if magic[:2]==b'\\x1f\\x8b' else '(zip PK)' if magic[:2]==b'PK' else '(other)'}")
    if magic[:2] == b"\x1f\x8b":
        inspect_gzip_tar(p)
    elif magic[:2] == b"PK":
        inspect_zip(p)
    else:
        print("  unsupported format")
    print()