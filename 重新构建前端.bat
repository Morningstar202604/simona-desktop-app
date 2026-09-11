@echo off
chcp 65001 >nul
title Simona Desktop - 重新构建前端

echo ========================================
echo   Simona Desktop - 重新构建前端
echo ========================================
echo.
echo 此脚本将重新构建前端以应用认证修复
echo.

echo.
echo [步骤 1] 清理旧的构建...
if exist "dist" rmdir /s /q dist
echo [完成] 旧构建已清理

echo.
echo [步骤 2] 安装依赖...
call npm install
if %errorlevel% neq 0 (
    echo [错误] 依赖安装失败
    exit /b 1
)

echo.
echo [步骤 3] 构建前端...
call npm run build
if %errorlevel% neq 0 (
    echo [错误] 构建失败
    exit /b 1
)

echo.
echo [步骤 4] 验证构建产物...
if exist "dist\index.html" (
    echo [成功] 前端构建完成
) else (
    echo [错误] 构建产物不存在
    exit /b 1
)

echo.
echo ========================================
echo   ✓ 构建完成!
echo ========================================
echo.
echo 修复内容:
echo   1. Auth.tsx - 登录成功后保存 auth_token
echo   2. api.ts - 优化 401 处理逻辑
echo   3. logout() - 清除 logged_in_email
echo.
echo 正在启动应用...
echo.

REM 启动应用
call "启动程序.bat"
