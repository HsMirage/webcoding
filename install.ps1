# Webcoding 一键安装脚本 (Windows PowerShell)
# 用法 (在 PowerShell 中运行):
#   irm https://raw.githubusercontent.com/HsMirage/webcoding/main/install.ps1 | iex
# 或指定安装目录:
#   $env:WEBCODING_DIR = "C:\webcoding"; irm https://raw.githubusercontent.com/HsMirage/webcoding/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$REPO        = 'https://github.com/HsMirage/webcoding.git'
$RAW_BASE    = 'https://raw.githubusercontent.com/HsMirage/webcoding/main'
$INSTALL_DIR = if ($env:WEBCODING_DIR) { $env:WEBCODING_DIR } else { Join-Path $HOME 'webcoding' }

function Write-Info    { param($msg) Write-Host "[Webcoding] $msg" -ForegroundColor Cyan   }
function Write-Success { param($msg) Write-Host "[Webcoding] $msg" -ForegroundColor Green  }
function Write-Warn    { param($msg) Write-Host "[Webcoding] $msg" -ForegroundColor Yellow }
function Write-Err     { param($msg) Write-Host "[Webcoding] ERROR: $msg" -ForegroundColor Red; exit 1 }

# ── 工具函数 ──────────────────────────────────────────────────
function Get-PackageVersion {
    param([string]$JsonPath)
    try {
        $pkg = Get-Content $JsonPath -Raw | ConvertFrom-Json
        return $pkg.version
    } catch { return '' }
}

function Compare-VersionLt {
    param([string]$a, [string]$b)
    if ($a -eq $b) { return $false }
    try {
        $va = [System.Version]"$a.0"
        $vb = [System.Version]"$b.0"
        return $va -lt $vb
    } catch { return $false }
}

# ── 卸载函数 ──────────────────────────────────────────────────
function Invoke-Uninstall {
    if (-not (Test-Path $INSTALL_DIR)) {
        Write-Err "未找到安装目录: $INSTALL_DIR，无法卸载。"
    }
    Write-Warn "即将卸载 Webcoding:"
    Write-Warn "  安装目录 : $INSTALL_DIR"
    Write-Warn "  启动脚本 : $INSTALL_DIR\webcoding.cmd"
    Write-Host ''
    $confirm = Read-Host '确认卸载? 此操作不可撤销 (y/N)'
    if ($confirm -notmatch '^[Yy]') {
        Write-Info '已取消卸载。'
        exit 0
    }
    # 终止进程
    Get-WmiObject Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -like "*$INSTALL_DIR*server.js*"
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    # 删除目录
    Write-Info '删除安装目录...'
    Remove-Item -Recurse -Force $INSTALL_DIR
    # 清理用户 PATH
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if ($userPath -like "*$INSTALL_DIR*") {
        $newPath = ($userPath -split ';' | Where-Object { $_ -ne $INSTALL_DIR }) -join ';'
        [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
        Write-Info '已从用户 PATH 移除安装目录。'
    }
    Write-Host ''
    Write-Success '================================================'
    Write-Success ' Webcoding 已成功卸载！'
    Write-Success '================================================'
    exit 0
}

# ── 检查依赖 ──────────────────────────────────────────────────
Write-Info '检查依赖环境...'
if (-not (Get-Command git  -ErrorAction SilentlyContinue)) { Write-Err '未找到 git。请先安装 git: https://git-scm.com/' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Err '未找到 Node.js。请先安装 Node.js >= 18: https://nodejs.org/' }
if (-not (Get-Command npm  -ErrorAction SilentlyContinue)) { Write-Err '未找到 npm，请确认 Node.js 安装完整。' }
$nodeVer = (node -e 'process.stdout.write(process.versions.node.split(".")[0])' 2>$null)
if ([int]$nodeVer -lt 18) {
    Write-Err "Node.js 版本过低 (当前: $(node -v))，需要 >= 18。请升级: https://nodejs.org/"
}
Write-Success "Node.js $(node -v)  npm $(npm -v)  git $(git --version) — 全部就绪"

# ── 检测 AI CLI ────────────────────────────────────────────────
$hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
$hasCodex  = [bool](Get-Command codex  -ErrorAction SilentlyContinue)
if ($hasClaude -and $hasCodex)    { Write-Success '检测到 Claude CLI 和 Codex CLI' }
elseif ($hasClaude)                { Write-Warn '仅检测到 Claude CLI（未找到 codex），Codex 功能将不可用' }
elseif ($hasCodex)                 { Write-Warn '仅检测到 Codex CLI（未找到 claude），Claude 功能将不可用' }
else {
    Write-Warn '未检测到 Claude CLI 或 Codex CLI'
    Write-Warn '  Claude CLI : https://docs.anthropic.com/en/docs/claude-code'
    Write-Warn '  Codex CLI  : https://github.com/openai/codex'
}

# ── 获取版本信息 ───────────────────────────────────────────────
$localVer   = ''
$remoteVer  = ''
$isInstalled = $false

$localPkg = Join-Path $INSTALL_DIR 'package.json'
if ((Test-Path (Join-Path $INSTALL_DIR '.git')) -and (Test-Path $localPkg)) {
    $isInstalled = $true
    $localVer = Get-PackageVersion $localPkg
}

try {
    $remoteJson = (Invoke-WebRequest -Uri "$RAW_BASE/package.json" -UseBasicParsing).Content
    $remoteVer  = ($remoteJson | ConvertFrom-Json).version
} catch {
    Write-Warn '无法获取远端版本信息。'
}

# ── 显示状态 ───────────────────────────────────────────────────
Write-Host ''
if ($isInstalled) {
    Write-Host "  已安装目录 : $INSTALL_DIR" -ForegroundColor White
    if ($localVer)  { Write-Host "  本地版本   : v$localVer"  -ForegroundColor Cyan }
} else {
    Write-Host "  安装目录   : $INSTALL_DIR（尚未安装）" -ForegroundColor White
}
if ($remoteVer) { Write-Host "  最新版本   : v$remoteVer" -ForegroundColor Cyan }
Write-Host ''

# ── 交互菜单 ───────────────────────────────────────────────────
$updateLabel = '更新到最新版'
if ($remoteVer) { $updateLabel = "更新到最新版 v$remoteVer" }
if ($localVer -and $remoteVer -and -not (Compare-VersionLt $localVer $remoteVer)) {
    $updateLabel = '重新拉取最新代码（已是最新版）'
}

Write-Host '请选择操作:' -ForegroundColor White
Write-Host '  1) 安装'                          -ForegroundColor White
Write-Host '  2) 启动'                          -ForegroundColor White
Write-Host "  3) $updateLabel"                  -ForegroundColor White
Write-Host '  4) 安装依赖'                      -ForegroundColor White
Write-Host '  5) 卸载 Webcoding'               -ForegroundColor White
Write-Host '  6) 退出'                          -ForegroundColor White
Write-Host ''
$choice = Read-Host '请输入选项 [1-6]'
if (-not $choice) { $choice = '1' }

switch ($choice) {
    '1' {
        if ($isInstalled) {
            Write-Warn "已安装，如需重装请先卸载（选项 5）或手动删除: Remove-Item -Recurse -Force '$INSTALL_DIR'"
            exit 0
        }
        Write-Info "克隆仓库到 $INSTALL_DIR ..."
        git clone --depth 1 $REPO $INSTALL_DIR
    }
    '2' {
        $srv = Join-Path $INSTALL_DIR 'server.js'
        if (-not (Test-Path $srv)) { Write-Err '未找到 server.js，请先安装（选项 1）。' }
        Write-Info '启动 Webcoding...'
        node $srv
        exit 0
    }
    '3' {
        if (-not (Test-Path (Join-Path $INSTALL_DIR '.git'))) {
            Write-Err '未找到安装目录，请先安装（选项 1）。'
        }
        Write-Info '拉取最新代码...'
        git -C $INSTALL_DIR fetch --depth=1 origin main
        git -C $INSTALL_DIR reset --hard origin/main
    }
    '4' {
        if (-not (Test-Path $INSTALL_DIR)) { Write-Err '未找到安装目录，请先安装（选项 1）。' }
        Write-Info '安装 Node.js 依赖...'
        Set-Location $INSTALL_DIR
        npm install --omit=dev
        Write-Success '依赖安装完成。'
        exit 0
    }
    '5' { Invoke-Uninstall }
    '6' { Write-Info '已退出。'; exit 0 }
    default { Write-Warn '无效选项，退出。'; exit 1 }
}

# 选项 1/3 后继续：安装依赖 + 写入 launcher
Set-Location $INSTALL_DIR

Write-Info '安装 Node.js 依赖...'
npm install --omit=dev

# ── 写入快捷启动脚本 ───────────────────────────────────────────
$launcherPath = Join-Path $INSTALL_DIR 'webcoding.cmd'
@"
@echo off
node ""$INSTALL_DIR\server.js"" %*
"@ | Set-Content -Encoding ASCII $launcherPath

$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($userPath -notlike "*$INSTALL_DIR*") {
    [Environment]::SetEnvironmentVariable('PATH', "$userPath;$INSTALL_DIR", 'User')
    Write-Warn "已将 $INSTALL_DIR 加入用户 PATH，重新打开终端后生效。"
}

# ── 完成提示 ───────────────────────────────────────────────────
Write-Host ''
Write-Success '================================================'
if ($isInstalled) {
    Write-Success ' Webcoding 更新完成！'
} else {
    Write-Success ' Webcoding 安装完成！'
}
Write-Success '================================================'
Write-Host ''
Write-Host '  启动命令 : webcoding'                       -ForegroundColor White
Write-Host "  或双击   : $INSTALL_DIR\webcoding.cmd"      -ForegroundColor White
Write-Host "  或直接   : node $INSTALL_DIR\server.js"     -ForegroundColor White
Write-Host '  访问地址 : http://localhost:8001'            -ForegroundColor White
Write-Host ''
Write-Info '首次启动时会自动生成登录密码并打印在控制台。'
Write-Host ''

$startNow = Read-Host '现在立即启动 Webcoding? (Y/n)'
if ($startNow -notmatch '^[Nn]') {
    node "$INSTALL_DIR\server.js"
} else {
    Write-Info "稍后运行 'webcoding' 或双击 webcoding.cmd 启动。"
}
