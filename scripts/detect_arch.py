# detect_arch.py — 检测离线资产的 CPU 架构（x86_64 / AArch64）
import io, gzip, tarfile, zipfile, os, struct

BASE = r"D:/Python work/软件包/Simona/simona-mobile/app/src/main/assets"
EM = {0x3e: "x86_64", 0xb7: "AArch64", 0x03: "x86", 0x28: "ARM"}

def arch_of(data):
    if data[:4] == b"\x7fELF":
        return EM.get(struct.unpack("<H", data[18:20])[0], "ELF-other")
    return None

def scan_tar(path, label, filters, want=6):
    try:
        g = gzip.GzipFile(fileobj=open(path, "rb"))
        t = tarfile.open(fileobj=g, mode="r|")
        found = []
        for m in t:
            if not m.isfile():
                continue
            nm = m.name
            if any(k in nm for k in filters):
                f = t.extractfile(m)
                if f:
                    a = arch_of(f.read(24))
                    if a:
                        found.append((nm, a))
                        if len(found) >= want:
                            break
        print(f"{label}: ELF samples = {found if found else 'none'}")
    except Exception as e:
        print(f"{label}: ERR {e!r}")

# bun: zip
zb = os.path.join(BASE, "offline-bun.bin")
z = zipfile.ZipFile(zb)
names = list(z.namelist())
linux = [n for n in names if "linux" in n]
print("BUN zip entries:", len(names))
for n in linux[:12]:
    if n.lower().endswith("bun") or "bun" in n.lower().rsplit("/", 1)[-1]:
        try:
            a = arch_of(z.read(n)[:24])
            if a:
                print("  bun:", n, "->", a)
        except Exception:
            pass
if not linux:
    print("  head:", names[:12])

scan_tar(os.path.join(BASE, "offline-node.bin"), "NODE", ["/bin/", "/lib/", "linux-x64", "linux-arm64", "aarch64", "bin/node"])
scan_tar(os.path.join(BASE, "offline-rootfs.bin"), "ROOTFS", ["/bin/", "/usr/bin/", "x86_64", "aarch64", "ld-linux"], want=4)
scan_tar(os.path.join(BASE, "offline-engine.bin"), "ENGINE", [".so", "/bin/"], want=2)
print("DONE")