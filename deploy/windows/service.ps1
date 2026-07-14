[CmdletBinding()]
param(
    [ValidateSet('start', 'restart', 'stop', 'status', 'logs', 'run', 'uninstall')]
    [string]$Command = 'start',
    [string]$InstallDir = '',
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Webcoding'

function Resolve-InstallDirectory {
    param([string]$Value)
    if (-not $Value) {
        $Value = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    }
    $expanded = [Environment]::ExpandEnvironmentVariables($Value)
    if ($expanded -eq '~') { $expanded = $HOME }
    elseif ($expanded.StartsWith('~\') -or $expanded.StartsWith('~/')) {
        $expanded = Join-Path $HOME $expanded.Substring(2)
    }
    return [IO.Path]::GetFullPath($expanded)
}

$InstallDir = Resolve-InstallDirectory $InstallDir
$ServerPath = Join-Path $InstallDir 'server.js'
$LogDir = Join-Path $InstallDir 'logs'
$LogFile = Join-Path $LogDir 'server.log'
$ErrorLogFile = Join-Path $LogDir 'server.err.log'
$ScriptPath = $MyInvocation.MyCommand.Path

function Write-Info    { param([string]$Message) Write-Host "[Webcoding] $Message" -ForegroundColor Cyan }
function Write-Success { param([string]$Message) Write-Host "[Webcoding] $Message" -ForegroundColor Green }
function Write-Warn    { param([string]$Message) Write-Host "[Webcoding] $Message" -ForegroundColor Yellow }

function Resolve-NodePath {
    param([string]$Preferred)
    if ($Preferred -and (Test-Path $Preferred)) {
        return (Resolve-Path $Preferred).Path
    }
    $commandInfo = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $commandInfo) { $commandInfo = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $commandInfo) {
        throw '未找到 Node.js。请先安装 Node.js 22 或更高版本。'
    }
    return $commandInfo.Source
}

function Get-WebcodingProcesses {
    $targets = @($ServerPath)
    $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    foreach ($action in @($existingTask.Actions)) {
        if ($action.Arguments -match '-InstallDir\s+"([^"]+)"') {
            $targets += (Join-Path $Matches[1] 'server.js')
        }
    }
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object {
        if (-not $_.CommandLine) { return $false }
        foreach ($target in $targets) {
            if ($_.CommandLine.IndexOf($target, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
        }
        return $false
    })
}

function Get-ConfiguredPort {
    if ($env:PORT -and $env:PORT -match '^\d+$') { return [int]$env:PORT }
    $envFile = Join-Path $InstallDir '.env'
    if (Test-Path $envFile) {
        foreach ($line in Get-Content $envFile -ErrorAction SilentlyContinue) {
            if ($line -match '^\s*PORT\s*=\s*["'']?(\d+)') { return [int]$Matches[1] }
        }
    }
    return 8001
}

function Assert-PortAvailable {
    $port = Get-ConfiguredPort
    $listeners = @()
    try {
        $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    } catch { }
    if (-not $listeners) { return }
    $ownedPids = @(Get-WebcodingProcesses | ForEach-Object { [int]$_.ProcessId })
    foreach ($listener in $listeners) {
        if ($ownedPids -notcontains [int]$listener.OwningProcess) {
            throw "端口 $port 已被其他进程占用 (PID: $($listener.OwningProcess))。请先释放端口，或在 $InstallDir\.env 中设置其他 PORT。"
        }
    }
}

function Stop-WebcodingProcesses {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    foreach ($process in Get-WebcodingProcesses) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 300
}

function Register-WebcodingTask {
    if (-not (Test-Path $ServerPath)) {
        throw "未找到 $ServerPath，请先完成安装。"
    }
    if (-not $ScriptPath -or -not (Test-Path $ScriptPath)) {
        throw '无法定位 Windows 服务管理脚本。'
    }
    if (-not (Test-Path $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }

    $node = Resolve-NodePath $NodePath
    $engine = (Get-Process -Id $PID).Path
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$ScriptPath`" -Command run -InstallDir `"$InstallDir`" -NodePath `"$node`""
    $action = New-ScheduledTaskAction -Execute $engine -Argument $arguments -WorkingDirectory $InstallDir
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    return $node
}

function Show-InitialPassword {
    $match = $null
    $authPath = Join-Path $InstallDir 'config\auth.json'
    for ($i = 0; $i -lt 15; $i++) {
        if (Test-Path $authPath) {
            try {
                $auth = Get-Content $authPath -Raw | ConvertFrom-Json
                if ($auth.mustChange -eq $false) { return }
            } catch { }
        }
        if (Test-Path $LogFile) {
            $match = Get-Content $LogFile -ErrorAction SilentlyContinue | Select-String '自动生成初始密码' | Select-Object -Last 1
            if ($match) { break }
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $match) { return }
    $password = ($match.Line -replace '.*自动生成初始密码:[\s]*', '').Trim()
    if (-not $password) { return }
    Write-Host ''
    Write-Success '================================================'
    Write-Success "  初始登录密码: $password"
    Write-Success '  首次登录后将要求修改密码'
    Write-Success '================================================'
    Write-Host ''
}

function Start-WebcodingTask {
    Assert-PortAvailable
    Stop-WebcodingProcesses
    $node = Register-WebcodingTask
    Start-ScheduledTask -TaskName $TaskName

    $running = $false
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 200
        if (Get-WebcodingProcesses) {
            $running = $true
            break
        }
    }
    if (-not $running) {
        $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
        throw "计划任务已创建，但 Webcoding 未能启动。LastTaskResult=$($info.LastTaskResult)。请查看 $ErrorLogFile。"
    }

    $port = Get-ConfiguredPort
    Write-Success "Webcoding 已通过 Windows 计划任务持久化运行，关闭终端不会停止。"
    Write-Success "访问地址: http://localhost:$port"
    Write-Info "Node.js: $node"
    Write-Info "管理命令: webcoding status | webcoding restart | webcoding stop | webcoding logs"
    Show-InitialPassword
}

function Show-WebcodingStatus {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $processes = Get-WebcodingProcesses
    if (-not $task) {
        Write-Warn '后台计划任务尚未注册。'
        return $false
    }
    $taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-Info "计划任务状态: $($task.State)"
    Write-Info "上次结果: $($taskInfo.LastTaskResult)"
    if ($processes) {
        Write-Success "Webcoding 正在运行 (PID: $((@($processes.ProcessId) -join ', ')))"
        Write-Info "日志目录: $LogDir"
        return $true
    }
    Write-Warn '计划任务存在，但 Webcoding 进程当前未运行。'
    Write-Info "错误日志: $ErrorLogFile"
    return $false
}

if ($Command -eq 'run') {
    if (-not (Test-Path $ServerPath)) { throw "未找到 $ServerPath" }
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    $node = Resolve-NodePath $NodePath
    Set-Location $InstallDir
    & $node $ServerPath 1>> $LogFile 2>> $ErrorLogFile
    exit $LASTEXITCODE
}

switch ($Command) {
    'start' { Start-WebcodingTask }
    'restart' { Start-WebcodingTask }
    'stop' {
        Stop-WebcodingProcesses
        Write-Success 'Webcoding 已停止；计划任务仍会在下次登录时自动启动。'
    }
    'status' {
        if (-not (Show-WebcodingStatus)) { exit 1 }
    }
    'logs' {
        if (-not (Test-Path $LogFile)) { Write-Warn "日志文件尚不存在: $LogFile"; exit 1 }
        $logPaths = @($LogFile, $ErrorLogFile) | Where-Object { Test-Path $_ }
        Get-Content $logPaths -Tail 100 -Wait
    }
    'uninstall' {
        Stop-WebcodingProcesses
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Write-Success 'Webcoding 后台计划任务已移除。'
    }
}
