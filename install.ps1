# Webcoding 一键安装与服务管理脚本 (Windows PowerShell)
#
# 交互安装：
#   $s = irm https://raw.githubusercontent.com/HsMirage/webcoding/main/install.ps1; Invoke-Expression ($s.TrimStart([char]0xFEFF))
# 指定安装目录：
#   $env:WEBCODING_DIR = 'D:\Apps\webcoding'; $s = irm https://raw.githubusercontent.com/HsMirage/webcoding/main/install.ps1; Invoke-Expression ($s.TrimStart([char]0xFEFF))

$ErrorActionPreference = 'Stop'

$REPO = 'https://github.com/HsMirage/webcoding.git'
$RAW_BASE = 'https://raw.githubusercontent.com/HsMirage/webcoding/main'
$SERVICE_SCRIPT_RELATIVE = 'deploy\windows\service.ps1'
$_isPiped = -not [Environment]::UserInteractive -or ($Host.Name -eq 'ConsoleHost' -and $MyInvocation.InvocationName -eq '')

function Write-Info    { param([string]$Message) Write-Host "[Webcoding] $Message" -ForegroundColor Cyan }
function Write-Success { param([string]$Message) Write-Host "[Webcoding] $Message" -ForegroundColor Green }
function Write-Warn    { param([string]$Message) Write-Host "[Webcoding] $Message" -ForegroundColor Yellow }
function Write-Err     { param([string]$Message) Write-Host "[Webcoding] ERROR: $Message" -ForegroundColor Red; Pause-IfNeeded; exit 1 }

function Pause-IfNeeded {
    if ($_isPiped) {
        Write-Host ''
        Write-Host '按 Enter 键退出...' -ForegroundColor Gray
        try { Read-Host | Out-Null } catch { }
    }
}

function Test-DirectoryHasEntries {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    try {
        return $null -ne (Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop | Select-Object -First 1)
    }
    catch { Write-Err "无法读取安装目录: $Path。$($_.Exception.Message)" }
}

function Test-WebcodingDirectory {
    param([string]$Path)
    $packagePath = Join-Path $Path 'package.json'
    if (-not (Test-Path -LiteralPath (Join-Path $Path '.git')) -or -not (Test-Path -LiteralPath $packagePath)) {
        return $false
    }
    try {
        $package = Get-Content -LiteralPath $packagePath -Raw | ConvertFrom-Json
        return $package.name -eq 'webcoding'
    }
    catch { return $false }
}

function Resolve-InstallDirectory {
    $defaultDir = Join-Path $HOME 'webcoding'
    if ($env:WEBCODING_DIR) {
        $value = $env:WEBCODING_DIR
    } elseif (-not [Environment]::UserInteractive) {
        $value = $defaultDir
    } else {
        Write-Host "默认安装/运行目录: $defaultDir" -ForegroundColor Gray
        try { $value = Read-Host '请输入安装/运行目录，直接回车使用默认目录' } catch { $value = '' }
        if (-not $value) { $value = $defaultDir }
    }
    $expanded = [Environment]::ExpandEnvironmentVariables($value)
    if ($expanded -eq '~') { $expanded = $HOME }
    elseif ($expanded.StartsWith('~\') -or $expanded.StartsWith('~/')) {
        $expanded = Join-Path $HOME $expanded.Substring(2)
    }
    try {
        $resolved = [IO.Path]::GetFullPath($expanded)
        if ($resolved.TrimEnd('\') -ieq ([IO.Path]::GetPathRoot($resolved)).TrimEnd('\')) {
            Write-Err '安装目录不能是磁盘根目录。'
        }
        if (Test-Path -LiteralPath $resolved) {
            if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
                Write-Err "安装路径已被文件占用: $resolved"
            }
            if (-not (Test-WebcodingDirectory $resolved) -and (Test-DirectoryHasEntries $resolved)) {
                $nestedDir = Join-Path $resolved 'webcoding'
                if (Test-Path -LiteralPath $nestedDir) {
                    if (-not (Test-Path -LiteralPath $nestedDir -PathType Container)) {
                        Write-Err "建议安装路径已被文件占用: $nestedDir"
                    }
                    if (-not (Test-WebcodingDirectory $nestedDir) -and (Test-DirectoryHasEntries $nestedDir)) {
                        Write-Err "所选目录与其 webcoding 子目录均不是空目录。请重新运行并选择其他目录: $nestedDir"
                    }
                }
                Write-Warn "所选目录不是空目录，将使用子目录: $nestedDir"
                $resolved = $nestedDir
            }
        }
        return $resolved
    }
    catch { Write-Err "安装目录无效: $value" }
}

$INSTALL_DIR = Resolve-InstallDirectory
$SERVICE_SCRIPT = Join-Path $INSTALL_DIR $SERVICE_SCRIPT_RELATIVE
$FALLBACK_SERVICE_SCRIPT = Join-Path $INSTALL_DIR 'logs\webcoding-service.ps1'

function Get-PackageVersion {
    param([string]$JsonPath)
    try { return (Get-Content $JsonPath -Raw | ConvertFrom-Json).version }
    catch { return '' }
}

function Compare-VersionLt {
    param([string]$A, [string]$B)
    if ($A -eq $B) { return $false }
    try {
        return ([Version]("$A.0")) -lt ([Version]("$B.0"))
    } catch { return $false }
}

function Assert-Dependencies {
    Write-Info '检查依赖环境...'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Write-Err '未找到 git。请先安装 git: https://git-scm.com/' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Err '未找到 Node.js。请先安装 Node.js >= 22: https://nodejs.org/' }
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Err '未找到 npm，请确认 Node.js 安装完整。' }
    $nodeVersionOutput = @(& node --version 2>$null)
    if ($LASTEXITCODE -ne 0 -or $nodeVersionOutput.Count -eq 0) {
        Write-Err '无法读取 Node.js 版本，请检查 Node.js 安装是否完整。'
    }
    $nodeVersion = ([string]$nodeVersionOutput[0]).Trim()
    if ($nodeVersion -notmatch '^v?([0-9]+)(?:\.[0-9]+){1,3}$') {
        Write-Err "无法识别 Node.js 版本: $nodeVersion"
    }
    $nodeMajor = [int]$Matches[1]
    if ($nodeMajor -lt 22) {
        Write-Err "Node.js 版本过低 (当前: $nodeVersion)，需要 >= 22。请升级: https://nodejs.org/"
    }
    Write-Success "Node.js $nodeVersion  npm $(npm -v)  git $(git --version) — 全部就绪"

    $agents = @()
    if (Get-Command claude -ErrorAction SilentlyContinue) { $agents += 'Claude' }
    if (Get-Command codex -ErrorAction SilentlyContinue) { $agents += 'Codex' }
    if (Get-Command pi -ErrorAction SilentlyContinue) { $agents += 'Pi' }
    if ($agents.Count -gt 0) { Write-Success "检测到 Agent CLI: $($agents -join ', ')" }
    else { Write-Warn '未检测到 Claude、Codex 或 Pi CLI；安装完成后请至少配置其中一个。' }
}

function Ensure-ServiceScript {
    if (Test-Path $SERVICE_SCRIPT) { return $SERVICE_SCRIPT }
    if (-not (Test-Path (Join-Path $INSTALL_DIR 'server.js'))) {
        Write-Err '未找到 server.js，请先安装 Webcoding。'
    }
    $serviceDir = Split-Path -Parent $FALLBACK_SERVICE_SCRIPT
    if (-not (Test-Path $serviceDir)) { New-Item -ItemType Directory -Path $serviceDir -Force | Out-Null }
    $hasCachedFallback = Test-Path $FALLBACK_SERVICE_SCRIPT
    Write-Warn '当前安装缺少内置 Windows 后台服务脚本，正在获取最新版...'
    try {
        Invoke-WebRequest -Uri "$RAW_BASE/deploy/windows/service.ps1" -UseBasicParsing -OutFile $FALLBACK_SERVICE_SCRIPT
    } catch {
        if (-not $hasCachedFallback) {
            Write-Err "下载 Windows 后台服务脚本失败: $($_.Exception.Message)"
        }
        Write-Warn '无法刷新后台服务脚本，将继续使用本地缓存。'
    }
    return $FALLBACK_SERVICE_SCRIPT
}

function Invoke-ServiceCommand {
    param([ValidateSet('start', 'restart', 'stop', 'status', 'logs', 'uninstall')][string]$Command)
    $script = Ensure-ServiceScript
    $engine = (Get-Process -Id $PID).Path
    & $engine -NoProfile -ExecutionPolicy Bypass -File $script -Command $Command -InstallDir $INSTALL_DIR
    if ($LASTEXITCODE -ne 0) {
        throw "后台服务命令执行失败: $Command"
    }
}

function Install-CommandLauncher {
    $launcherPath = Join-Path $INSTALL_DIR 'webcoding.cmd'
    @'
@echo off
chcp 65001 >nul 2>&1
set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=start"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\windows\service.ps1" -Command "%ACTION%" -InstallDir "%~dp0"
'@ | Set-Content -Encoding ASCII $launcherPath

    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $entries = @($userPath -split ';' | Where-Object { $_ })
    $exists = $entries | Where-Object { $_.TrimEnd('\') -ieq $INSTALL_DIR.TrimEnd('\') }
    if (-not $exists) {
        $newPath = (@($entries) + $INSTALL_DIR) -join ';'
        [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
        Write-Warn "已将 $INSTALL_DIR 加入用户 PATH，重新打开终端后生效。"
    }
    if (($env:PATH -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $INSTALL_DIR.TrimEnd('\')) {
        $env:PATH = "$env:PATH;$INSTALL_DIR"
    }
}

function Remove-ServiceFallback {
    try {
        Stop-ScheduledTask -TaskName 'Webcoding' -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName 'Webcoding' -Confirm:$false -ErrorAction SilentlyContinue
    } catch { }
    try {
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
            $_.CommandLine -and $_.CommandLine.IndexOf((Join-Path $INSTALL_DIR 'server.js'), [StringComparison]::OrdinalIgnoreCase) -ge 0
        } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch { }
}

function Invoke-Uninstall {
    if (-not (Test-Path $INSTALL_DIR)) { Write-Err "未找到安装目录: $INSTALL_DIR，无法卸载。" }
    Write-Warn '即将卸载 Webcoding:'
    Write-Warn "  安装目录 : $INSTALL_DIR"
    Write-Warn '  后台服务 : Windows 计划任务 Webcoding'
    $confirm = Read-Host '确认卸载? 此操作不可撤销 (y/N)'
    if ($confirm -notmatch '^[Yy]') { Write-Info '已取消卸载。'; exit 0 }

    if ((Test-Path $SERVICE_SCRIPT) -or (Test-Path $FALLBACK_SERVICE_SCRIPT)) {
        try { Invoke-ServiceCommand 'uninstall' } catch { Remove-ServiceFallback }
    } else {
        Remove-ServiceFallback
    }

    Write-Info '删除安装目录...'
    Remove-Item -Recurse -Force $INSTALL_DIR
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $newPath = ($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $INSTALL_DIR.TrimEnd('\') }) -join ';'
    [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
    Write-Success 'Webcoding 已成功卸载。'
    Pause-IfNeeded
    exit 0
}

$localVer = ''
$remoteVer = ''
$isInstalled = $false
$localPkg = Join-Path $INSTALL_DIR 'package.json'
if ((Test-Path (Join-Path $INSTALL_DIR '.git')) -and (Test-Path $localPkg)) {
    $isInstalled = $true
    $localVer = Get-PackageVersion $localPkg
}

try {
    $remoteJson = (Invoke-WebRequest -Uri "$RAW_BASE/package.json" -UseBasicParsing).Content
    $remoteVer = ($remoteJson | ConvertFrom-Json).version
} catch {
    Write-Warn '无法获取远端版本信息。'
}

Write-Host ''
if ($isInstalled) {
    Write-Host "  已安装目录 : $INSTALL_DIR" -ForegroundColor White
    if ($localVer) { Write-Host "  本地版本   : v$localVer" -ForegroundColor Cyan }
} else {
    Write-Host "  安装目录   : $INSTALL_DIR（尚未安装）" -ForegroundColor White
}
if ($remoteVer) { Write-Host "  最新版本   : v$remoteVer" -ForegroundColor Cyan }
Write-Host ''

$updateLabel = '更新到最新版'
if ($remoteVer) { $updateLabel = "更新到最新版 v$remoteVer" }
if ($localVer -and $remoteVer -and -not (Compare-VersionLt $localVer $remoteVer)) {
    $updateLabel = '重新拉取最新代码（已是最新版）'
}

Write-Host '请选择操作:' -ForegroundColor White
Write-Host '  1) 安装' -ForegroundColor White
Write-Host '  2) 启动或重启持久化后台服务' -ForegroundColor White
Write-Host "  3) $updateLabel" -ForegroundColor White
Write-Host '  4) 重装依赖' -ForegroundColor White
Write-Host '  5) 停止当前后台服务' -ForegroundColor White
Write-Host '  6) 查看服务状态' -ForegroundColor White
Write-Host '  7) 卸载 Webcoding' -ForegroundColor White
Write-Host '  8) 退出' -ForegroundColor White
Write-Host ''
$choice = Read-Host '请输入选项 [1-8]'
if (-not $choice) { $choice = '1' }

$action = ''
$startAction = 'start'
switch ($choice) {
    '1' { $action = 'install' }
    '2' { $action = 'start'; $startAction = 'restart' }
    '3' { $action = 'update'; $startAction = 'restart' }
    '4' { $action = 'deps' }
    '5' {
        try { Invoke-ServiceCommand 'stop' } catch { Write-Err $_.Exception.Message }
        Pause-IfNeeded
        exit 0
    }
    '6' {
        try { Invoke-ServiceCommand 'status' } catch { Write-Warn $_.Exception.Message }
        Pause-IfNeeded
        exit 0
    }
    '7' { Invoke-Uninstall }
    '8' { Write-Info '已退出。'; Pause-IfNeeded; exit 0 }
    default { Write-Err '无效选项。' }
}

Assert-Dependencies

if ($action -eq 'start') {
    try { Invoke-ServiceCommand $startAction } catch { Write-Err $_.Exception.Message }
    Pause-IfNeeded
    exit 0
}

switch ($action) {
    'install' {
        if ($isInstalled) { Write-Err '已安装。如需覆盖，请选择更新或先卸载。' }
        if ((Test-Path -LiteralPath $INSTALL_DIR) -and (Test-DirectoryHasEntries $INSTALL_DIR)) {
            Write-Err "安装目录不是空目录，已停止以避免覆盖现有文件: $INSTALL_DIR"
        }
        Write-Info "克隆仓库到 $INSTALL_DIR ..."
        $parentDir = Split-Path -Parent $INSTALL_DIR
        if (-not (Test-Path $parentDir)) { New-Item -ItemType Directory -Path $parentDir -Force | Out-Null }
        git clone --depth 1 $REPO $INSTALL_DIR
        if ($LASTEXITCODE -ne 0) { Write-Err "Git 克隆失败。请检查网络与目录权限: $INSTALL_DIR" }
    }
    'update' {
        if (-not (Test-Path (Join-Path $INSTALL_DIR '.git'))) { Write-Err '未找到安装目录，请先安装。' }
        if ($localVer -and $remoteVer -and -not (Compare-VersionLt $localVer $remoteVer)) {
            Write-Warn '当前已是最新版，仍会校准代码、依赖和服务配置。'
        }
        Write-Info '拉取最新代码...'
        git -C $INSTALL_DIR fetch --depth=1 origin main
        if ($LASTEXITCODE -ne 0) { Write-Err 'Git fetch 失败。' }
        git -C $INSTALL_DIR reset --hard origin/main
        if ($LASTEXITCODE -ne 0) { Write-Err 'Git 更新失败。' }
    }
    'deps' {
        if (-not (Test-Path (Join-Path $INSTALL_DIR 'package.json'))) { Write-Err '未找到安装目录，请先安装。' }
    }
}

Write-Info '安装 Node.js 依赖...'
Push-Location $INSTALL_DIR
try {
    npm install --omit=dev
    if ($LASTEXITCODE -ne 0) { Write-Err '依赖安装失败。' }
} finally {
    Pop-Location
}

Ensure-ServiceScript | Out-Null
Install-CommandLauncher

Write-Host ''
Write-Success '================================================'
if ($action -eq 'install') { Write-Success ' Webcoding 安装完成！' }
elseif ($action -eq 'deps') { Write-Success ' Webcoding 依赖与服务配置完成！' }
else { Write-Success ' Webcoding 更新完成！' }
Write-Success '================================================'
Write-Host ''
Write-Host "  安装目录 : $INSTALL_DIR" -ForegroundColor White
Write-Host '  管理命令 : webcoding start | restart | stop | status | logs' -ForegroundColor White
Write-Host '  运行方式 : Windows 计划任务（登录后自动启动，关闭终端不停止）' -ForegroundColor White
Write-Host '  访问地址 : http://localhost:8001' -ForegroundColor White
Write-Host ''

$startNow = Read-Host '现在立即启动持久化后台服务? (Y/n)'
if ($startNow -notmatch '^[Nn]') {
    try { Invoke-ServiceCommand $startAction } catch { Write-Err $_.Exception.Message }
} else {
    Write-Info "稍后运行 '$INSTALL_DIR\webcoding.cmd start' 即可启动。"
}

Pause-IfNeeded
