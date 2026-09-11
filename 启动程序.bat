@echo off
chcp 65001 >nul
title Simona Agent Launcher

REM ==========================================
REM Read logged-in email from jwt-token.json
REM ==========================================
set "JWT_FILE=%APPDATA%\simona-desktop\jwt-token.json"
set "USER_EMAIL="

if exist "%JWT_FILE%" (
    for /f "delims=" %%a in ('powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get-email.ps1" "%JWT_FILE%"') do (
        set "USER_EMAIL=%%a"
    )
)

if not defined USER_EMAIL (
    echo [WARN] No logged-in account detected. Please login in Simona client first.
    echo        Or specify manually: startup.bat user@qq.com
    echo.
)

echo [INFO] Starting Simona...
cd /d "%~dp0"

REM Start Electron
start "" cmd /k "chcp 65001 >nul && npx electron ."

REM If email available (from param or auto-detect), start Agent Relay
set "FINAL_EMAIL=%~1"
if not defined FINAL_EMAIL set "FINAL_EMAIL=%USER_EMAIL%"

if defined FINAL_EMAIL (
    echo.
    echo [INFO] Starting Agent Relay (account: %FINAL_EMAIL%)
    
    set "USER_ID=%FINAL_EMAIL:@=_%"
    set "USER_ID=%USER_ID:.=_%"
    
    echo [INFO] Waiting for bridge-server...
    timeout /t 5 /nobreak >nul
    
    echo [INFO] Connecting to relay (UserID: %USER_ID%)...
    start "" cmd /k "chcp 65001 >nul && node agent-relay.cjs %USER_ID%"
) else (
    echo.
    echo [INFO] Electron only, remote control disabled
)

echo.
echo ==========================================
echo   Startup complete
echo ==========================================
pause
