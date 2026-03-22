# Webcoding 一键安装脚本 (Windows PowerShell)
# 用法 (在 PowerShell 中运行):
#   irm https://raw.githubusercontent.com/HsMirage/webcoding/main/install.ps1 | iex
# 或指定安装目录:
#   $env:WEBCODING_DIR = "C:\webcoding"; irm https://raw.githubusercontent.com/HsMirage/webcoding/main/install.ps1 | iex
# 卸载:
#   irm https://raw.githubusercontent.com/HsMirage/webcoding/main/install.ps1 | iex; # 选择菜单 5
#   或: $env:WEBCODING_UNINSTALL=1; irm .../install.ps1 | iex

param([switch]$Uninstall)

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
    } catch {
        return ''
    }
}

function Compare-VersionLt {
    param([string]$a, [string]$b)
    if ($a -eq $b) { return $false }
    $va = [System.Version]"$a.0"
    $vb = [System.Version]"$b.0"
    return $va -lt $vb
}

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

    # 终止运行中的 Webcoding 进程
    $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Path -and $_.Path -like "*node*" -and
        (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine -like "*$INSTALL_DIR*server.js*"
    }
    if ($procs) {
        Write-Info "终止运行中的 Webcoding 进程..."
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }

    # 删除安装目录
    Write-Info '删除安装目录...'
    Remove-Item -Recurse -Force $INSTALL_DIR

    # 从用户 PATH 移除安装目录
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if ($userPath -like "*$INSTALL_DIR*") {
        Write-Info '从用户 PATH 移除安装目录...'
        $newPath = ($userPath -split ';' | Where-Object { $_ -ne $INSTALL_DIR }) -join ';'
        [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
    }

    Write-Host ''
    Write-Success '================================================'
    Write-Success ' Webcoding 已成功卸载！'
    Write-Success '================================================'
    exit 0
}

# 若传入 -Uninstall 参数或环境变量，直接执行卸载
if ($Uninstall -or $env:WEBCODING_UNINSTALL) { Invoke-Uninstall }

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

# ── 检测 AI CLI（非必须，至少需要一个）────────────────────────
$hasClaude = [bool](Get-Command claude -ErrorAction SilentlyContinue)
$hasCodex  = [bool](Get-Command codex  -ErrorAction SilentlyContinue)
if ($hasClaude -and $hasCodex) {
    Write-Success '检测到 Claude CLI 和 Codex CLI'
} elseif ($hasClaude) {
    Write-Warn '仅检测到 Claude CLI（未找到 codex），Codex 功能将不可用'
} elseif ($hasCodex) {
    Write-Warn '仅检测到 Codex CLI（未找到 claude），Claude 功能将不可用'
} else {
    Write-Warn '未检测到 Claude CLI 或 Codex CLI'
    Write-Warn '请至少安装其中一个后再使用:'
    Write-Warn '  Claude CLI : https://docs.anthropic.com/en/docs/claude-code'
    Write-Warn '  Codex CLI  : https://github.com/openai/codex'
}

# ── 安装 / 更新 ────────────────────────────────────────────────
$isUpdate = $false

if (Test-Path (Join-Path $INSTALL_DIR '.git')) {
    $isUpdate = $true

    # 读取本地版本
    $localVer = ''
    $localPkg = Join-Path $INSTALL_DIR 'package.json'
    if (Test-Path $localPkg) {
        $localVer = Get-PackageVersion $localPkg
    }

    # 拉取远端版本
    $remoteVer = ''
    try {
        $remoteJson = (Invoke-WebRequest -Uri "$RAW_BASE/package.json" -UseBasicParsing).Content
        $remoteVer = ($remoteJson | ConvertFrom-Json).version
    } catch {
        Write-Warn '无法获取远端版本信息，跳过版本对比。'
    }

    Write-Host ''
    Write-Host "已检测到现有安装  目录: $INSTALL_DIR" -ForegroundColor White
    if ($localVer)  { Write-Host "  本地版本 : v$localVer"  -ForegroundColor Cyan }
    if ($remoteVer) { Write-Host "  远端版本 : v$remoteVer" -ForegroundColor Cyan }
    Write-Host ''

    # 判断是否有新版本
    $needsUpdate = $false
    if ($localVer -and $remoteVer) {
        if (Compare-VersionLt $localVer $remoteVer) {
            $needsUpdate = $true
            Write-Host "发现新版本 v$remoteVer，当前为 v$localVer" -ForegroundColor Green
        } else {
            Write-Success "已是最新版本 (v$localVer)"
        }
    }

    # 交互式菜单
    Write-Host ''
    Write-Host '请选择操作:' -ForegroundColor White
    if ($needsUpdate) {
        Write-Host "  1) 更新到最新版本 v$remoteVer  [推荐]" -ForegroundColor White
    } else {
        Write-Host '  1) 强制重新拉取最新代码' -ForegroundColor White
    }
    Write-Host '  2) 跳过更新，仅重新安装依赖' -ForegroundColor White
    Write-Host '  3) 跳过更新，直接启动'       -ForegroundColor White
    Write-Host '  4) 退出'                      -ForegroundColor White
    Write-Host '  5) 卸载 Webcoding'            -ForegroundColor White
    Write-Host ''
    $choice = Read-Host '请输入选项 [1-5]'
    if (-not $choice) { $choice = '1' }

    switch ($choice) {
        '1' {
            Write-Info '拉取最新代码...'
            git -C $INSTALL_DIR fetch --depth=1 origin main
            git -C $INSTALL_DIR reset --hard origin/main
        }
        '2' {
            Write-Info '跳过代码更新，重新安装依赖...'
        }
        '3' {
            Write-Info '跳过更新，直接启动...'
            node "$INSTALL_DIR\server.js"
            exit 0
        }
        '4' {
            Write-Info '已退出。'
            exit 0
        }
        '5' {
            Invoke-Uninstall
        }
        default {
            Write-Warn '无效选项，跳过更新。'
        }
    }

} elseif (Test-Path $INSTALL_DIR) {
    Write-Err "目录已存在但不是 git 仓库: $INSTALL_DIR`n请手动删除后重试: Remove-Item -Recurse -Force '$INSTALL_DIR'"
} else {
    Write-Info "克隆仓库到 $INSTALL_DIR ..."
    git clone --depth 1 $REPO $INSTALL_DIR
}

Set-Location $INSTALL_DIR

Write-Info '安装 Node.js 依赖...'
npm install --omit=dev

# ── 写入快捷启动脚本 ───────────────────────────────────────────
$launcherDir  = $INSTALL_DIR
$launcherPath = Join-Path $launcherDir 'webcoding.cmd'

@"
@echo off
node ""$INSTALL_DIR\server.js"" %*
"@ | Set-Content -Encoding ASCII $launcherPath

# 尝试将安装目录加入用户 PATH
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($userPath -notlike "*$INSTALL_DIR*") {
    [Environment]::SetEnvironmentVariable('PATH', "$userPath;$INSTALL_DIR", 'User')
    Write-Warn "已将 $INSTALL_DIR 加入用户 PATH，重新打开终端后生效。"
}

# ── 完成提示 ───────────────────────────────────────────────────
Write-Host ''
Write-Success '================================================'
if ($isUpdate) {
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

# ── 询问是否立即启动 ───────────────────────────────────────────
$startNow = Read-Host '现在立即启动 Webcoding? (Y/n)'
if ($startNow -notmatch '^[Nn]') {
    node "$INSTALL_DIR\server.js"
} else {
    Write-Info "安装完成，稍后运行 'webcoding' 或双击 webcoding.cmd 启动。"
}
