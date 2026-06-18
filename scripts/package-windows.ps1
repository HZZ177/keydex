param(
    [switch]$SkipInstall,
    [switch]$SkipTests,
    [switch]$NoSign = $true,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host "用法：powershell.exe -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1 [-SkipInstall] [-SkipTests] [-NoSign]"
    Write-Host ""
    Write-Host "说明："
    Write-Host "- 仅在需要 Windows exe 时执行。日常开发不要默认打包。"
    Write-Host "- 默认会安装依赖、运行测试、构建 sidecar 和 Tauri 应用。"
    Write-Host "- -SkipInstall 跳过依赖安装；-SkipTests 跳过测试。"
    return
}

$Root = Split-Path -Parent $PSScriptRoot
$BackendPython = Join-Path $Root ".venv\Scripts\python.exe"
$DesktopDir = Join-Path $Root "desktop"
$TauriDir = Join-Path $DesktopDir "src-tauri"
$Sidecar = Join-Path $Root "desktop\src-tauri\binaries\agent-server-x86_64-pc-windows-msvc.exe"
$Installer = Join-Path $Root "desktop\src-tauri\target\release\bundle\nsis\Python Codex_0.1.0_x64-setup.exe"
$ReleaseApp = Join-Path $Root "desktop\src-tauri\target\release\python-codex-desktop.exe"
$ReleaseSidecar = Join-Path $Root "desktop\src-tauri\target\release\agent-server.exe"
$ArtifactDir = Join-Path $Root "artifacts\windows"

function Invoke-Step {
    param(
        [string]$Title,
        [scriptblock]$Script
    )
    Write-Host ""
    Write-Host "==> $Title"
    & $Script
}

function Assert-Path {
    param(
        [string]$Path,
        [string]$Message
    )
    if (-not (Test-Path $Path)) {
        throw $Message
    }
}

function Stop-ArtifactProcesses {
    param(
        [string]$Directory
    )
    if (-not (Test-Path $Directory)) {
        return
    }
    $resolved = (Resolve-Path $Directory).Path
    Get-Process "python-codex-desktop", "agent-server" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($resolved, [System.StringComparison]::OrdinalIgnoreCase) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

function Copy-Artifact {
    param(
        [string]$Source,
        [string]$Destination
    )
    $lastError = $null
    for ($attempt = 1; $attempt -le 10; $attempt++) {
        try {
            Copy-Item -LiteralPath $Source -Destination $Destination -Force
            return
        } catch {
            $lastError = $_
            Start-Sleep -Milliseconds 500
        }
    }
    throw $lastError
}

Assert-Path $BackendPython "未找到 Python 虚拟环境：$BackendPython。打包前请先创建 .venv。"

if (-not $SkipInstall) {
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

if (-not $SkipTests) {
    Invoke-Step "运行后端 lint 检查" {
        Push-Location $Root
        try {
            & $BackendPython -m ruff check .
        } finally {
            Pop-Location
        }
    }

    Invoke-Step "运行后端测试" {
        Push-Location $Root
        try {
            & $BackendPython -m pytest
        } finally {
            Pop-Location
        }
    }

    Invoke-Step "运行桌面端测试" {
        Push-Location $DesktopDir
        try {
            npm.cmd run test
        } finally {
            Pop-Location
        }
    }
}

Invoke-Step "构建 Python sidecar" {
    Push-Location $Root
    try {
        & $BackendPython backend\packaging\build_agent_server.py
    } finally {
        Pop-Location
    }
}
Assert-Path $Sidecar "未生成 sidecar 二进制文件：$Sidecar。"

Invoke-Step "构建桌面端前端资源" {
    Push-Location $DesktopDir
    try {
        npm.cmd run build
    } finally {
        Pop-Location
    }
}

Invoke-Step "检查 Tauri Rust 代码" {
    Push-Location $TauriDir
    try {
        cargo fmt --check
        cargo check
        cargo build
    } finally {
        Pop-Location
    }
}

Invoke-Step "构建 Tauri NSIS 安装包" {
    Push-Location $DesktopDir
    try {
        $args = @("run", "tauri:build", "--", "--ci")
        if ($NoSign) {
            $args += "--no-sign"
        }
        & npm.cmd @args
    } finally {
        Pop-Location
    }
}
Assert-Path $Installer "未生成安装包：$Installer。"
Assert-Path $ReleaseApp "未生成发布版桌面程序：$ReleaseApp。"
Assert-Path $ReleaseSidecar "未生成发布版 sidecar：$ReleaseSidecar。"

Invoke-Step "复制发布产物到快速目录" {
    New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
    Stop-ArtifactProcesses -Directory $ArtifactDir

    $artifactInstaller = Join-Path $ArtifactDir "Python Codex_0.1.0_x64-setup.exe"
    $artifactApp = Join-Path $ArtifactDir "python-codex-desktop.exe"
    $artifactSidecar = Join-Path $ArtifactDir "agent-server.exe"
    $artifactBuildSidecar = Join-Path $ArtifactDir "agent-server-x86_64-pc-windows-msvc.exe"

    Copy-Artifact -Source $Installer -Destination $artifactInstaller
    Copy-Artifact -Source $ReleaseApp -Destination $artifactApp
    Copy-Artifact -Source $ReleaseSidecar -Destination $artifactSidecar
    Copy-Artifact -Source $Sidecar -Destination $artifactBuildSidecar

    $files = @(
        Get-Item -LiteralPath $artifactInstaller
        Get-Item -LiteralPath $artifactApp
        Get-Item -LiteralPath $artifactSidecar
        Get-Item -LiteralPath $artifactBuildSidecar
    )
    $manifest = [ordered]@{
        generated_at = (Get-Date).ToString("o")
        source_root = $Root
        files = @(
            foreach ($file in $files) {
                [ordered]@{
                    name = $file.Name
                    path = $file.FullName
                    bytes = $file.Length
                    last_write_time = $file.LastWriteTime.ToString("o")
                }
            }
        )
    }
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $ArtifactDir "manifest.json")

    $readmeLines = @(
        "Python Codex Windows 产物",
        "",
        "主安装包：",
        "  Python Codex_0.1.0_x64-setup.exe",
        "",
        "调试/直接运行二进制：",
        "  python-codex-desktop.exe",
        "  agent-server.exe",
        "",
        "Tauri sidecar 输入二进制：",
        "  agent-server-x86_64-pc-windows-msvc.exe",
        "",
        "生成时间：",
        "  $($manifest.generated_at)"
    )
    ($readmeLines -join [Environment]::NewLine) |
        Set-Content -Encoding UTF8 (Join-Path $ArtifactDir "README.txt")
}

$InstallerInfo = Get-Item -LiteralPath $Installer
$SidecarInfo = Get-Item -LiteralPath $Sidecar
$ArtifactInstallerInfo = Get-Item -LiteralPath (Join-Path $ArtifactDir "Python Codex_0.1.0_x64-setup.exe")

Write-Host ""
Write-Host "打包完成。"
Write-Host "安装包：$($InstallerInfo.FullName)"
Write-Host "安装包大小：$($InstallerInfo.Length) 字节"
Write-Host "快速产物目录：$ArtifactDir"
Write-Host "快速安装包：$($ArtifactInstallerInfo.FullName)"
Write-Host "Sidecar：$($SidecarInfo.FullName)"
Write-Host "Sidecar 大小：$($SidecarInfo.Length) 字节"
