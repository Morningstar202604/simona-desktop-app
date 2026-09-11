# -*- coding: utf-8 -*-
"""检查 simona-mobile 三个离线包的架构是否匹配 x86_64"""
import io, os, sys, re, zipfile, tarfile, gzip

ASSETS = r'D:\Python work\Simona\simona-mobile\app\src\main\assets'

def elf_machine(blob, label=''):
    if blob[:4] != b'\x7fELF':
        return f'{label} NOT-ELF head={blob[:16].hex()}'
    ei_class = blob[4]
    e_machine = int.from_bytes(blob[18:20], 'little')
    arch = {0x3e: 'x86_64 ✅', 0xb7: 'ARM64 ❌', 0x03: 'i386 (ok-as-loader)', 0x28: 'ARM32 ❌'}.get(e_machine, f'unknown-0x{e_machine:x}')
    cls = '64-bit' if ei_class == 2 else '32-bit'
    return f'{label} ELF class={cls} e_machine=0x{e_machine:x} {arch}'

def check_node_bin():
    path = os.path.join(ASSETS, 'offline-node.bin')
    print(f'\n=== offline-node.bin ({os.path.getsize(path)}) ===')
    with open(path, 'rb') as f:
        data = gzip.decompress(f.read())
    t = tarfile.open(fileobj=io.BytesIO(data), mode='r:*')
    for m in t.getmembers():
        if m.name.endswith('/bin/node'):
            blob = t.extractfile(m).read(64)
            print(f'  成员: {m.name} size={m.size}')
            print(f'  {elf_machine(blob, "node")}')
            break

def check_rootfs_bin():
    path = os.path.join(ASSETS, 'offline-rootfs.bin')
    print(f'\n=== offline-rootfs.bin ({os.path.getsize(path)}) ===')
    with open(path, 'rb') as f:
        data = gzip.decompress(f.read())
    t = tarfile.open(fileobj=io.BytesIO(data), mode='r:*')
    candidates = []
    for m in t.getmembers():
        if m.name.endswith('/bin/bash') or m.name.endswith('/usr/bin/bash'):
            candidates.append(m)
        if len(candidates) >= 2:
            break
    if not candidates:
        # list top dirs
        tops = set(m.name.split('/')[0] for m in t.getmembers())
        print(f'  未找到 bash，顶层目录: {list(tops)[:10]}')
        # find any ELF
        for m in t.getmembers():
            if m.isfile() and m.size > 100000:
                try:
                    blob = t.extractfile(m).read(64)
                    if blob[:4] == b'\x7fELF':
                        print(f'  首个大ELF: {m.name} -> {elf_machine(blob)}')
                        break
                except Exception:
                    pass
    else:
        for c in candidates[:2]:
            blob = t.extractfile(c).read(64)
            print(f'  成员: {c.name} size={c.size}')
            print(f'  {elf_machine(blob, "bash")}')

def check_bun_bin():
    path = os.path.join(ASSETS, 'offline-bun.bin')
    print(f'\n=== offline-bun.bin ({os.path.getsize(path)}) ===')
    z = zipfile.ZipFile(path)
    for n in z.namelist():
        if n.endswith('/bun') or n.endswith('.exe') or 'bun' in n.lower():
            blob = z.read(n)[:64]
            print(f'  成员: {n}')
            print(f'  {elf_machine(blob)}')
            if n.lower().endswith('bun'):
                break

if __name__ == '__main__':
    check_node_bin()
    check_rootfs_bin()
    check_bun_bin()
    print('\n完成')