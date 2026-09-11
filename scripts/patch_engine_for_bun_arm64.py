# patch_engine_for_bun_arm64.py
# 修补 engine 内 parent-proxy.js，将 BlockList.addAddress 替换为 addSubnet
# （Bun v1.2.8 ARM64 上 BlockList.addAddress 未实现，但 addSubnet 可用）
import io, os, sys, tarfile, gzip

ASSETS = r"D:/Python work/软件包/Simona/simona-mobile/app/src/main/assets"
ENGINE = os.path.join(ASSETS, "offline-engine.bin")
TARGET = "engine/node_modules/@simona-ai/sandbox-runtime/dist/sandbox/parent-proxy.js"

print("=== 修补 engine 兼容 Bun ARM64 ===")
print("Engine:", ENGINE, f"({os.path.getsize(ENGINE)/1048576:.1f} MB)")

# 1. 读取原始 engine (gzip tar)
with open(ENGINE, "rb") as f:
    compressed = f.read()
print(f"  压缩大小: {len(compressed)/1048576:.1f} MB")

tar_data = gzip.decompress(compressed)
print(f"  解压大小: {len(tar_data)/1048576:.1f} MB")

# 2. 读取 tar 中的所有成员
tar_in = tarfile.open(fileobj=io.BytesIO(tar_data), mode="r:")
members = list(tar_in.getmembers())
print(f"  tar 条目数: {len(members)}")

# 3. 提取所有文件内容到内存
files = {}
dirs = set()
for m in members:
    if m.isfile() or m.issym() or m.islnk():
        files[m.name] = tar_in.extractfile(m).read() if m.isfile() else None
    elif m.isdir():
        dirs.add(m.name)
        files[m.name] = None
tar_in.close()

# 4. 查找并修补 parent-proxy.js
if TARGET not in files:
    # 尝试模糊匹配
    candidates = [k for k in files if "parent-proxy.js" in k]
    if candidates:
        target_name = candidates[0]
        print(f"  找到: {target_name}")
    else:
        # 搜索所有 js 文件找 addAddress
        for name, data in files.items():
            if data and b"addAddress" in data:
                print(f"  addAddress 出现在: {name}")
        print("  错误: 找不到 parent-proxy.js!")
        sys.exit(1)
else:
    target_name = TARGET

content = files[target_name].decode("utf-8")
print(f"  修补前: {target_name} ({len(content)} bytes)")

# 统计 addAddress 出现次数
count_before = content.count("addAddress")
print(f"  addAddress 出现次数: {count_before}")

# 修补 1: LOOPBACK 块中的 addAddress('::1', 'ipv6') -> addSubnet('::1', 128, 'ipv6')
content = content.replace(
    "bl.addAddress('::1', 'ipv6')",
    "bl.addSubnet('::1', 128, 'ipv6')"
)

# 修补 2: parseNoProxy 中的 addAddress(v, ...) -> addSubnet(v, prefix, ...)
content = content.replace(
    "rules.cidr.addAddress(v, bareFam === 6 ? 'ipv6' : 'ipv4')",
    "rules.cidr.addSubnet(v, bareFam === 6 ? 128 : 32, bareFam === 6 ? 'ipv6' : 'ipv4')"
)

count_after = content.count("addAddress")
print(f"  修补后 addAddress 剩余: {count_after}")
assert count_after == 0, f"还有 {count_after} 个 addAddress 未替换!"

files[target_name] = content.encode("utf-8")

# 5. 重新打包 tar.gz
buf = io.BytesIO()
tar_out = tarfile.open(fileobj=buf, mode="w:gz", compresslevel=9)
for m in members:
    if m.isfile():
        info = tarfile.TarInfo(name=m.name)
        info.size = len(files[m.name])
        info.mtime = int(m.mtime) if m.mtime else 0
        info.mode = m.mode
        info.type = m.type
        info.uid = m.uid
        info.gid = m.gid
        info.uname = m.uname or ""
        info.gname = m.gname or ""
        tar_out.addfile(info, io.BytesIO(files[m.name]))
    elif m.isdir():
        info = tarfile.TarInfo(name=m.name)
        info.type = m.type
        info.mode = m.mode
        info.mtime = int(m.mtime) if m.mtime else 0
        tar_out.addfile(info)
    else:
        # symlink, hardlink
        tar_out.addfile(m)
tar_out.close()

# 6. 写回
new_data = buf.getvalue()
with open(ENGINE, "wb") as f:
    f.write(new_data)

print(f"  新 engine 大小: {len(new_data)/1048576:.1f} MB")

# 7. 验证
with open(ENGINE, "rb") as f:
    verify = gzip.decompress(f.read())
v_in = tarfile.open(fileobj=io.BytesIO(verify), mode="r:")
v_members = v_in.getmembers()
print(f"  验证: tar 条目 {len(v_members)}")

# 读取修补后的文件确认
if target_name in [m.name for m in v_members]:
    v_content = v_in.extractfile(target_name).read().decode("utf-8")
    v_count = v_content.count("addAddress")
    v_subnet = v_content.count("addSubnet")
    print(f"  验证: addAddress={v_count}, addSubnet={v_subnet}")
    assert v_count == 0, f"验证失败: 仍有 {v_count} 个 addAddress!"
    print("  验证: 通过!")

v_in.close()
print("\n=== 修补完成 ===")