param(
    [switch]$Install,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host "用法：powershell.exe -ExecutionPolicy Bypass -File .\scripts\dev-start.ps1 [-Install]"
    Write-Host ""
    Write-Host "说明："
    Write-Host "- 默认启动本地后端和前端开发服务。"
    Write-Host "- -Install 会先使用 uv 安装 Python 依赖，并安装 desktop 前端依赖。"
    Write-Host "- 不执行 build、Tauri build 或打包。"
    return
}

$Root = Split-Path -Parent $PSScriptRoot
$BackendPython = Join-Path $Root ".venv\Scripts\python.exe"
$DesktopDir = Join-Path $Root "desktop"

function Invoke-Step {
    param(
        [string]$Title,
        [scriptblock]$Script
    )
    Write-Host ""
    Write-Host "==> $Title"
    & $Script
}

if (-not (Test-Path $BackendPython)) {
    throw "未找到 Python 虚拟环境：$BackendPython。启动应用前请先创建 .venv。"
}

if ($Install) {
    Invoke-Step "使用 uv 安装 Python 依赖" {
        Push-Location $Root
        try {
            uv pip install -r requirements.txt
        } finally {
            Pop-Location
        }
    }

    Invoke-Step "安装桌面端依赖" {
        Push-Location $DesktopDir
        try {
            npm.cmd install --cache .\.npm-cache
        } finally {
            Pop-Location
        }
    }
}

$BackendCommand = @"
Set-Location '$Root'
& '$BackendPython' backend\app\main.py
"@

$FrontendCommand = @"
Set-Location '$DesktopDir'
pnpm run dev
"@

Write-Host ""
Write-Host "正在启动后端：http://127.0.0.1:8765"
Start-Process powershell.exe -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    $BackendCommand
)

Write-Host "正在启动前端：http://127.0.0.1:5173"
Start-Process powershell.exe -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    $FrontendCommand
)

Write-Host ""
Write-Host "已打开两个 PowerShell 窗口："
Write-Host "- 后端： http://127.0.0.1:8765/api/health"
Write-Host "- 前端： http://127.0.0.1:5173"
Write-Host ""
Write-Host "关闭这些窗口即可停止开发服务。"
