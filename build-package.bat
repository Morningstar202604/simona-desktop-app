@echo off
chcp 65001 >nul
echo ========================================
echo Simona Desktop App - 完整打包脚本
echo ========================================
echo.

REM 检查是否安装了 Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ 错误: 未检测到 Node.js，请先安装 Node.js 20+ 
    pause
    exit /b 1
)

REM 检查是否安装了 Bun
where bun >nul 2>nul
if %errorlevel% neq 0 (
    echo ⚠️  警告: 未检测到 Bun，将尝试使用 npm 安装引擎依赖
    set USE_BUN=false
) else (
    echo ✅ 检测到 Bun
    set USE_BUN=true
)

echo 📦 开始打包流程...
echo.

REM 步骤1: 清理之前的构建
echo [1/6] 清理之前的构建文件...
if exist "dist" rmdir /s /q "dist"
if exist "release" rmdir /s /q "release"
echo ✅ 清理完成
echo.

REM 步骤2: 安装前端依赖
echo [2/6] 安装前端依赖...
call npm install
if %errorlevel% neq 0 (
    echo ❌ 前端依赖安装失败
    pause
    exit /b 1
)
echo ✅ 前端依赖安装完成
echo.

REM 步骤3: 安装引擎依赖
echo [3/6] 安装引擎依赖...
cd engine
if "%USE_BUN%"=="true" (
    call bun install
) else (
    echo ⚠️  使用 npm 安装引擎依赖（可能需要较长时间）
    call npm install
)
if %errorlevel% neq 0 (
    echo ❌ 引擎依赖安装失败
    cd ..
    pause
    exit /b 1
)
cd ..
echo ✅ 引擎依赖安装完成
echo.

REM 步骤4: 构建前端
echo [4/6] 构建前端应用...
call npx vite build
if %errorlevel% neq 0 (
    echo ❌ 前端构建失败
    pause
    exit /b 1
)
echo ✅ 前端构建完成
echo.

REM 步骤5: 准备打包环境
echo [5/6] 准备打包环境...

REM 检查 Git 便携版 (PortableGit)
if not exist "git\bin\bash.exe" (
    echo ⚠️  Git 便携版不存在，正在提取...
    if exist "extract-git-bundle.bat" (
        call extract-git-bundle.bat
        if %errorlevel% neq 0 (
            echo ❌ Git 提取失败
            pause
            exit /b 1
        )
    ) else (
        echo ❌ extract-git-bundle.bat 不存在
        echo 请先运行 extract-git-bundle.bat 提取 Git 文件
        pause
        exit /b 1
    )
)
echo ✅ Git 已就绪

REM 临时修改 .gitignore 以包含 engine/node_modules
echo 📝 临时调整 .gitignore 配置...
if exist ".gitignore" (
    copy .gitignore .gitignore.backup >nul
    REM 完全删除 .gitignore 文件，让 electron-builder 包含所有文件
    del .gitignore
    echo ✅ .gitignore 已临时移除（将包含所有文件）
)

echo ✅ 打包环境准备完成
echo.

REM 步骤6: 执行 Electron 打包
echo [6/6] 执行 Electron 打包...
call npx electron-builder --win
if %errorlevel% neq 0 (
    echo ❌ Electron 打包失败
    pause
    exit /b 1
)
echo ✅ Electron 打包完成

REM 清理不需要的文件
echo 🧹 清理不需要的文件...

REM 清理 release 目录下的构建调试文件
if exist "release\builder-debug.yml" del /f /q "release\builder-debug.yml"
if exist "release\builder-effective-config.yaml" del /f /q "release\builder-effective-config.yaml"

REM 清理 win-unpacked 中的多余文件
if exist "release\win-unpacked\启动程序.bat" del /f /q "release\win-unpacked\启动程序.bat"
if exist "release\win-unpacked\resources\公网访问-一键启动.bat" del /f /q "release\win-unpacked\resources\公网访问-一键启动.bat"
if exist "release\win-unpacked\resources\engine\.package-lock.json" del /f /q "release\win-unpacked\resources\engine\.package-lock.json"
if exist "release\win-unpacked\resources\engine\package.json" del /f /q "release\win-unpacked\resources\engine\package.json"
if exist "release\win-unpacked\resources\engine\package-lock.json" del /f /q "release\win-unpacked\resources\engine\package-lock.json"

REM 清理多余的语言包（只保留 en-US、zh-CN、zh-TW）
if exist "release\win-unpacked\locales" (
    for %%f in ("release\win-unpacked\locales\*.pak") do (
        if not "%%~nxf"=="en-US.pak" if not "%%~nxf"=="zh-CN.pak" if not "%%~nxf"=="zh-TW.pak" (
            del /f /q "%%f"
        )
    )
)

REM 清理 Chromium 许可证文件
if exist "release\win-unpacked\LICENSES.chromium.html" del /f /q "release\win-unpacked\LICENSES.chromium.html"

echo ✅ 清理完成
echo.

REM 将 win-unpacked 重命名为 Simona
if exist "release\win-unpacked" (
    echo 📝 重命名 win-unpacked 为 Simona...
    if exist "release\Simona" rmdir /s /q "release\Simona"
    rename "release\win-unpacked" "Simona"
    echo ✅ 重命名完成
)
echo.

REM 复制 打包命令.iss 到 release 目录
if exist "打包命令.iss" (
    echo 📝 复制 打包命令.iss 到 release 目录...
    copy /Y "打包命令.iss" "release\打包命令.iss" >nul
    echo ✅ 打包命令.iss 已复制
)
echo.

REM 恢复原始的 .gitignore
if exist ".gitignore.backup" (
    echo 📝 恢复原始 .gitignore...
    move /Y .gitignore.backup .gitignore >nul
    echo ✅ .gitignore 已恢复
)
echo.

echo ========================================
echo 🎉 打包完成！
echo ========================================
echo.
echo 输出目录: release\Simona
echo.
echo 💡 提示:
echo 1. Simona 文件夹包含所有运行所需的文件
echo 2. 直接运行其中的 Simona Desktop.exe 即可启动应用
echo 3. 可以将整个 Simona 文件夹复制到任意位置使用
echo 4. 用户数据存储在 %%APPDATA%%\Simona Desktop 目录
echo.
pause
