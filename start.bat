@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [Webcoding] ERROR: 未找到 Node.js，请先安装 Node.js 22 或更高版本。
    echo https://nodejs.org/
    pause
    exit /b 1
)

if not exist node_modules (
    echo [Webcoding] 正在安装依赖...
    call npm install --omit=dev
    if %errorlevel% neq 0 (
        echo [Webcoding] ERROR: 依赖安装失败。
        pause
        exit /b 1
    )
)

if not exist "deploy\windows\service.ps1" (
    echo [Webcoding] ERROR: 缺少 deploy\windows\service.ps1，请先更新或重新安装。
    pause
    exit /b 1
)

echo [Webcoding] 正在启动持久化后台服务...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows\service.ps1" -Command start -InstallDir "%~dp0"
if %errorlevel% neq 0 (
    echo [Webcoding] ERROR: 启动失败，请查看 logs\server.err.log。
    pause
    exit /b 1
)

echo [Webcoding] 可以关闭此窗口，服务会继续运行。
timeout /t 2 >nul
