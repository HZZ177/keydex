param(
    [switch]$SkipInstall,
    [switch]$SkipTests,
    [switch]$SkipRustChecks,
    [switch]$RebuildSidecar,
    [switch]$CleanSidecar,
    [switch]$Fast,
    [switch]$Full,
    [switch]$NoSign = $true,
    [ValidateRange(0, 64)]
    [int]$RustJobs = 0,
    [ValidateRange(0, 64)]
    [int]$TestWorkers = 0,
    [switch]$SerialTests,
    [switch]$LowMemoryRust,
    [switch]$CleanRustCache,
    [string]$Version,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

if ($Help) {
    Write-Host "用法：powershell.exe -ExecutionPolicy Bypass -File .\scripts\package-windows.ps1 [-Version 0.1.0] [-Fast|-Full] [-SkipInstall] [-SkipTests] [-SkipRustChecks] [-RebuildSidecar] [-CleanSidecar] [-NoSign] [-RustJobs N] [-TestWorkers N] [-SerialTests] [-LowMemoryRust] [-CleanRustCache]"
    Write-Host ""
    Write-Host "说明："
    Write-Host "- 仅在需要 Windows exe 时执行。日常开发不要默认打包。"
    Write-Host "- 不传 -Fast/-Full 且不在 CI 中运行时，会先让你输入版本号；直接回车使用 tauri.conf.json 当前版本。"
    Write-Host "- -Version 用于非交互指定本次打包版本，不修改 tauri.conf.json/package.json 源文件。"
    Write-Host "- 不传 -Fast/-Full 时会先让你选择快速打包或全量打包。"
    Write-Host "- 全量打包会安装依赖、运行测试、构建或复用 sidecar，并构建 Tauri 安装包。"
    Write-Host "- Tauri build 会按 tauri.conf.json 的 beforeBuildCommand 构建前端资源，脚本不再重复执行前端 build。"
    Write-Host "- -Fast 跳过依赖安装、测试和 Rust 预检查；sidecar 输入未变化时直接复用。"
    Write-Host "- -Full 直接使用全量打包模式，不显示交互选择。"
    Write-Host "- -SkipInstall 跳过依赖安装；-SkipTests 跳过测试。"
    Write-Host "- -SkipRustChecks 跳过 cargo fmt/check 预检查；Tauri release build 仍会编译 Rust。"
    Write-Host "- -RebuildSidecar 强制重建 sidecar；-CleanSidecar 清理 PyInstaller 缓存后重建。"
    Write-Host "- -RustJobs 设置 Cargo 编译并发；默认 0 表示按本机 CPU 自动并发。"
    Write-Host "- -TestWorkers 设置 Vitest 最大 worker 数；默认 0 使用 Vitest 默认并行。"
    Write-Host "- -SerialTests 强制桌面端测试单 worker 运行，适合低资源或排查不稳定测试。"
    Write-Host "- -LowMemoryRust 使用低内存 Rust release 配置：默认 RustJobs=1、opt-level=1、codegen-units=16、lto=false。"
    Write-Host "- -CleanRustCache 清理可能损坏的 Tauri Rust 缓存；默认不清理以复用增量编译。"
    return
}

$Root = Split-Path -Parent $PSScriptRoot
$BackendPython = Join-Path $Root ".venv\Scripts\python.exe"
$DesktopDir = Join-Path $Root "desktop"
$TauriDir = Join-Path $DesktopDir "src-tauri"
$TauriConfigPath = Join-Path $TauriDir "tauri.conf.json"
$TauriConfig = Get-Content -Raw -LiteralPath $TauriConfigPath | ConvertFrom-Json
$ConfiguredAppVersion = [string]$TauriConfig.version
if ([string]::IsNullOrWhiteSpace($ConfiguredAppVersion)) {
    throw "未能从 Tauri 配置读取版本号：$TauriConfigPath"
}
$IsCiPackaging = $env:GITHUB_ACTIONS -eq "true" -or $env:CI -eq "true"
$RequestedAppVersion = if ($null -eq $Version) { "" } else { $Version.Trim() }
if ([string]::IsNullOrWhiteSpace($RequestedAppVersion) -and -not $IsCiPackaging -and -not $Fast -and -not $Full) {
    Write-Host ""
    $RequestedAppVersion = (Read-Host "请输入本次打包版本号，直接回车使用当前版本 $ConfiguredAppVersion").Trim()
}
if ([string]::IsNullOrWhiteSpace($RequestedAppVersion)) {
    $RequestedAppVersion = $ConfiguredAppVersion
}
if ($RequestedAppVersion -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$') {
    throw "版本号格式无效：$RequestedAppVersion。请使用类似 0.1.0 或 0.1.1 的 SemVer 格式。"
}
$AppVersion = $RequestedAppVersion
$UseAppVersionOverride = $AppVersion -ne $ConfiguredAppVersion
Write-Host ""
Write-Host "本次打包版本：$AppVersion"
if ($UseAppVersionOverride) {
    Write-Host "版本号将通过 TAURI_CONFIG 临时覆盖；不会修改 tauri.conf.json/package.json 源文件。"
}
$InstallerName = "Keydex_${AppVersion}_x64-setup.exe"
$UpdaterBundleName = "Keydex_${AppVersion}_x64-setup.nsis.zip"
$UpdaterSignatureName = "$UpdaterBundleName.sig"
$SidecarDir = Join-Path $Root "desktop\src-tauri\binaries\agent-server"
$Sidecar = Join-Path $SidecarDir "agent-server.exe"
$Installer = Join-Path $Root "desktop\src-tauri\target\release\bundle\nsis\$InstallerName"
$UpdaterBundle = Join-Path $Root "desktop\src-tauri\target\release\bundle\nsis\$UpdaterBundleName"
$UpdaterSignature = Join-Path $Root "desktop\src-tauri\target\release\bundle\nsis\$UpdaterSignatureName"
$ReleaseApp = Join-Path $Root "desktop\src-tauri\target\release\keydex-desktop.exe"
$ArtifactDir = Join-Path $Root "artifacts\windows"
$ReleaseRepository = if ([string]::IsNullOrWhiteSpace($env:GITHUB_REPOSITORY)) { "HZZ177/keydex" } else { $env:GITHUB_REPOSITORY }
$ReleaseTag = if ([string]::IsNullOrWhiteSpace($env:RELEASE_TAG)) { "v$AppVersion" } else { $env:RELEASE_TAG }
$ExpectUpdaterArtifacts = $false

function Invoke-Step {
    param(
        [string]$Title,
        [scriptblock]$Script
    )
    Write-Host ""
    Write-Host "==> $Title"
    & $Script
}

function Invoke-NativeCommand {
    param(
        [string]$Command,
        [string[]]$Arguments = @()
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "命令执行失败（exit code $LASTEXITCODE）：$Command $($Arguments -join ' ')"
    }
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

function ConvertTo-OrderedMap {
    param(
        [object]$Value
    )

    if ($null -eq $Value) {
        return $null
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $map = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $map[$key] = ConvertTo-OrderedMap -Value $Value[$key]
        }
        return $map
    }
    if ($Value -is [pscustomobject]) {
        $map = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            $map[$property.Name] = ConvertTo-OrderedMap -Value $property.Value
        }
        return $map
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return @($Value | ForEach-Object { ConvertTo-OrderedMap -Value $_ })
    }
    return $Value
}

function Merge-OrderedMap {
    param(
        [System.Collections.IDictionary]$Base,
        [System.Collections.IDictionary]$Override
    )

    foreach ($key in $Override.Keys) {
        $baseValue = $Base[$key]
        $overrideValue = $Override[$key]
        if ($baseValue -is [System.Collections.IDictionary] -and $overrideValue -is [System.Collections.IDictionary]) {
            Merge-OrderedMap -Base $baseValue -Override $overrideValue
        } else {
            $Base[$key] = $overrideValue
        }
    }
}

function Resolve-TauriConfigOverride {
    param(
        [string]$ExistingConfig,
        [bool]$UseVersion,
        [string]$ResolvedVersion,
        [bool]$UseLocalToolsDir
    )

    $merged = [ordered]@{}
    if (-not [string]::IsNullOrWhiteSpace($ExistingConfig)) {
        try {
            $merged = ConvertTo-OrderedMap -Value ($ExistingConfig | ConvertFrom-Json)
        } catch {
            throw "TAURI_CONFIG 不是有效 JSON，无法合并本次打包配置：$ExistingConfig"
        }
    }

    $override = [ordered]@{}
    if ($UseVersion) {
        $override["version"] = $ResolvedVersion
    }
    if ($UseLocalToolsDir) {
        $override["bundle"] = [ordered]@{
            useLocalToolsDir = $true
        }
    }

    Merge-OrderedMap -Base $merged -Override $override
    if ($merged.Count -eq 0) {
        return $null
    }
    return ($merged | ConvertTo-Json -Depth 100 -Compress)
}

function Test-TauriUpdaterArtifactsEnabled {
    param(
        [string]$ConfigJson
    )

    if ([string]::IsNullOrWhiteSpace($ConfigJson)) {
        return $false
    }

    try {
        $config = $ConfigJson | ConvertFrom-Json
    } catch {
        throw "TAURI_CONFIG 不是有效 JSON，无法判断 updater 产物配置：$ConfigJson"
    }

    $createUpdaterArtifacts = $config.bundle.createUpdaterArtifacts
    if ($null -eq $createUpdaterArtifacts) {
        return $false
    }
    if ($createUpdaterArtifacts -is [bool]) {
        return $createUpdaterArtifacts
    }

    $textValue = ([string]$createUpdaterArtifacts).Trim()
    return -not [string]::IsNullOrWhiteSpace($textValue) -and $textValue -ne "false"
}

function Resolve-RustBuildJobs {
    param(
        [int]$Jobs,
        [bool]$LowMemory
    )

    if ($Jobs -gt 0) {
        return $Jobs
    }
    if ($LowMemory) {
        return 1
    }
    return [Math]::Max(1, [Environment]::ProcessorCount)
}

function Set-RustBuildProfile {
    param(
        [int]$Jobs,
        [bool]$LowMemory
    )
    $resolvedJobs = Resolve-RustBuildJobs -Jobs $Jobs -LowMemory $LowMemory
    $env:CARGO_BUILD_JOBS = [string]$resolvedJobs

    if ($LowMemory) {
        $env:CARGO_PROFILE_RELEASE_OPT_LEVEL = "1"
        $env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS = "16"
        $env:CARGO_PROFILE_RELEASE_LTO = "false"
    } else {
        Remove-Item Env:CARGO_PROFILE_RELEASE_OPT_LEVEL -ErrorAction SilentlyContinue
        Remove-Item Env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS -ErrorAction SilentlyContinue
        Remove-Item Env:CARGO_PROFILE_RELEASE_LTO -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "Rust 构建并发：CARGO_BUILD_JOBS=$env:CARGO_BUILD_JOBS"
    if ($LowMemory) {
        Write-Host "Rust release 配置：低内存模式 opt-level=$env:CARGO_PROFILE_RELEASE_OPT_LEVEL, codegen-units=$env:CARGO_PROFILE_RELEASE_CODEGEN_UNITS, lto=$env:CARGO_PROFILE_RELEASE_LTO"
    } else {
        Write-Host "Rust release 配置：使用 Cargo 默认 release 优化，不覆盖 opt-level/codegen-units/lto。"
    }
}

function Resolve-DesktopTestArguments {
    if ($SerialTests) {
        return @("run", "test", "--", "--maxWorkers", "1", "--minWorkers", "1")
    }
    if ($TestWorkers -gt 0) {
        return @("run", "test", "--", "--maxWorkers", [string]$TestWorkers)
    }
    return @("run", "test")
}

function Clear-RustCrateArtifacts {
    param(
        [string]$TargetProfileDir,
        [string[]]$CrateNames
    )
    if (-not (Test-Path $TargetProfileDir)) {
        return
    }

    $targetRoot = [System.IO.Path]::GetFullPath($TargetProfileDir)
    $targetRootWithSeparator = $targetRoot.TrimEnd(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    ) + [System.IO.Path]::DirectorySeparatorChar

    foreach ($crateName in $CrateNames) {
        $crateFileStem = $crateName.Replace("-", "_")
        $patterns = @(
            (Join-Path $TargetProfileDir "deps\*$crateFileStem-*"),
            (Join-Path $TargetProfileDir "deps\lib$crateFileStem-*"),
            (Join-Path $TargetProfileDir ".fingerprint\$crateName-*"),
            (Join-Path $TargetProfileDir ".fingerprint\$crateFileStem-*")
        )

        foreach ($pattern in $patterns) {
            Get-ChildItem -Path $pattern -Force -ErrorAction SilentlyContinue |
                ForEach-Object {
                    $artifactPath = [System.IO.Path]::GetFullPath($_.FullName)
                    if (-not $artifactPath.StartsWith($targetRootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
                        throw "拒绝清理 target 目录之外的 Rust 产物：$artifactPath"
                    }
                    Remove-Item -LiteralPath $artifactPath -Recurse -Force
                }
        }
    }
}

function Test-LocalNsisCache {
    param(
        [string]$NsisDir
    )
    $requiredFiles = @(
        "makensis.exe",
        "Bin\makensis.exe",
        "Stubs\lzma-x86-unicode",
        "Stubs\lzma_solid-x86-unicode",
        "Include\MUI2.nsh",
        "Include\FileFunc.nsh",
        "Include\x64.nsh",
        "Include\nsDialogs.nsh",
        "Include\WinMessages.nsh",
        "Include\Win\COM.nsh",
        "Include\Win\Propkey.nsh",
        "Include\Win\RestartManager.nsh",
        "Plugins\x86-unicode\additional\nsis_tauri_utils.dll"
    )
    foreach ($relativePath in $requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $NsisDir $relativePath))) {
            return $false
        }
    }
    return $true
}

function Stop-ArtifactProcesses {
    param(
        [string]$Directory
    )
    if (-not (Test-Path $Directory)) {
        return
    }
    $resolved = (Resolve-Path $Directory).Path
    Get-Process "keydex-desktop", "agent-server" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($resolved, [System.StringComparison]::OrdinalIgnoreCase) } |
        Stop-Process -Force -ErrorAction SilentlyContinue
}

function Read-PackageMode {
    Write-Host ""
    Write-Host "请选择 Windows 打包模式："
    Write-Host "  1) 快速打包：跳过依赖安装、测试和 Rust 预检查；sidecar 输入未变化时复用。"
    Write-Host "  2) 全量打包：安装依赖、运行测试和 Rust 预检查；再构建安装包。"
    Write-Host ""

    while ($true) {
        $choice = (Read-Host "请输入 1/2，或输入 fast/full").Trim().ToLowerInvariant()
        switch ($choice) {
            { $_ -in @("1", "f", "fast", "quick", "q", "快速", "快速打包") } { return "Fast" }
            { $_ -in @("2", "full", "all", "a", "全量", "全量打包") } { return "Full" }
            default {
                Write-Host "输入无效，请输入 1 或 2。"
            }
        }
    }
}

function Resolve-PackageMode {
    if ($Fast -and $Full) {
        throw "-Fast 和 -Full 不能同时使用。"
    }
    if ($Fast) {
        return "Fast"
    }
    if ($Full) {
        return "Full"
    }
    return (Read-PackageMode)
}

function Apply-PackageMode {
    param(
        [ValidateSet("Fast", "Full")]
        [string]$Mode
    )

    if ($Mode -eq "Fast") {
        $script:SkipInstall = $true
        $script:SkipTests = $true
        $script:SkipRustChecks = $true
        Write-Host ""
        Write-Host "已选择：快速打包"
        Write-Host "将跳过依赖安装、测试和 Rust 预检查；sidecar 输入未变化时复用。"
        return
    }

    Write-Host ""
    Write-Host "已选择：全量打包"
    Write-Host "将安装依赖、运行测试和 Rust 预检查；sidecar 输入未变化时复用，除非显式传入 -RebuildSidecar 或 -CleanSidecar。"
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

function Copy-DirectoryArtifact {
    param(
        [string]$Source,
        [string]$Destination
    )
    $artifactRoot = [System.IO.Path]::GetFullPath($ArtifactDir)
    $destinationFull = [System.IO.Path]::GetFullPath($Destination)
    $artifactRootWithSeparator = $artifactRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $destinationFull.StartsWith($artifactRootWithSeparator, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "拒绝递归覆盖 artifacts 目录之外的路径：$Destination"
    }
    if (Test-Path $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

$PackageMode = Resolve-PackageMode
Apply-PackageMode -Mode $PackageMode
Set-RustBuildProfile -Jobs $RustJobs -LowMemory $LowMemoryRust.IsPresent

Assert-Path $BackendPython "未找到 Python 虚拟环境：$BackendPython。打包前请先创建 .venv。"

if (-not $SkipInstall) {
    Invoke-Step "使用 uv 安装 Python 依赖" {
        Push-Location $Root
        try {
            Invoke-NativeCommand "uv" @("pip", "install", "-r", "requirements.txt")
        } finally {
            Pop-Location
        }
    }

    Invoke-Step "安装桌面端依赖" {
        Push-Location $DesktopDir
        try {
            Invoke-NativeCommand "npm.cmd" @("install", "--cache", ".\.npm-cache")
        } finally {
            Pop-Location
        }
    }
}

if (-not $SkipTests) {
    Invoke-Step "运行后端 lint 检查" {
        Push-Location $Root
        try {
            Invoke-NativeCommand $BackendPython @("-m", "ruff", "check", ".")
        } finally {
            Pop-Location
        }
    }

    Invoke-Step "运行后端测试" {
        Push-Location $Root
        try {
            Invoke-NativeCommand $BackendPython @("-m", "pytest")
        } finally {
            Pop-Location
        }
    }

    Invoke-Step "运行桌面端测试" {
        Push-Location $DesktopDir
        try {
            Invoke-NativeCommand "npm.cmd" (Resolve-DesktopTestArguments)
        } finally {
            Pop-Location
        }
    }
}

Invoke-Step "构建 Python sidecar" {
    Push-Location $Root
    try {
        Stop-ArtifactProcesses -Directory (Join-Path $Root "desktop\src-tauri\binaries")
        $sidecarArgs = @("backend\packaging\build_agent_server.py")
        if (-not $RebuildSidecar -and -not $CleanSidecar) {
            $sidecarArgs += "--reuse-if-current"
        }
        if ($CleanSidecar) {
            $sidecarArgs += "--clean"
        }
        Invoke-NativeCommand $BackendPython $sidecarArgs
    } finally {
        Pop-Location
    }
}
Assert-Path $SidecarDir "未生成 sidecar 目录：$SidecarDir。"
Assert-Path $Sidecar "未生成 sidecar 二进制文件：$Sidecar。"

if (-not $SkipRustChecks) {
    Invoke-Step "检查 Tauri Rust 代码" {
        Push-Location $TauriDir
        try {
            Invoke-NativeCommand "cargo" @("fmt", "--check")
            Invoke-NativeCommand "cargo" @("check")
        } finally {
            Pop-Location
        }
    }
}

if ($CleanRustCache) {
    Invoke-Step "清理可能损坏的 Tauri Rust 缓存" {
        Clear-RustCrateArtifacts `
            -TargetProfileDir (Join-Path $TauriDir "target\release") `
            -CrateNames @("tauri-utils", "tauri-plugin-fs", "keydex-desktop", "keydex_desktop_lib")
    }
}

Invoke-Step "构建 Tauri NSIS 安装包" {
    Push-Location $DesktopDir
    $previousTauriConfig = $env:TAURI_CONFIG
    try {
        $localNsisDir = Join-Path $TauriDir "target\.tauri\NSIS"
        $useLocalToolsDir = (Test-LocalNsisCache -NsisDir $localNsisDir) -and [string]::IsNullOrWhiteSpace($previousTauriConfig)
        $buildTauriConfig = Resolve-TauriConfigOverride `
            -ExistingConfig $previousTauriConfig `
            -UseVersion $UseAppVersionOverride `
            -ResolvedVersion $AppVersion `
            -UseLocalToolsDir $useLocalToolsDir
        if ([string]::IsNullOrWhiteSpace($buildTauriConfig)) {
            Remove-Item Env:TAURI_CONFIG -ErrorAction SilentlyContinue
        } else {
            $env:TAURI_CONFIG = $buildTauriConfig
        }
        $script:ExpectUpdaterArtifacts = Test-TauriUpdaterArtifactsEnabled -ConfigJson $buildTauriConfig
        if ($script:ExpectUpdaterArtifacts -and $NoSign) {
            throw "当前配置要求生成 Tauri updater 产物，但 -NoSign 处于启用状态。CI 发版请传 -NoSign:`$false 并配置 TAURI_SIGNING_PRIVATE_KEY。"
        }
        if ($script:ExpectUpdaterArtifacts) {
            Write-Host "Tauri updater 产物：已启用 createUpdaterArtifacts。"
        }
        if ($useLocalToolsDir) {
            Write-Host "检测到本机 Tauri NSIS 缓存，临时使用项目内工具目录：$localNsisDir"
        }
        if ($UseAppVersionOverride) {
            Write-Host "临时覆盖 Tauri 打包版本：$AppVersion"
        }
        $args = @("run", "tauri:build", "--", "--ci")
        if ($NoSign) {
            $args += "--no-sign"
        }
        Invoke-NativeCommand "npm.cmd" $args
    } finally {
        $env:TAURI_CONFIG = $previousTauriConfig
        Pop-Location
    }
}
Assert-Path $Installer "未生成安装包：$Installer。"
Assert-Path $ReleaseApp "未生成发布版桌面程序：$ReleaseApp。"

Invoke-Step "复制发布产物到快速目录" {
    New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null
    Stop-ArtifactProcesses -Directory $ArtifactDir

    $artifactInstaller = Join-Path $ArtifactDir $InstallerName
    $artifactUpdaterBundle = Join-Path $ArtifactDir $UpdaterBundleName
    $artifactUpdaterSignature = Join-Path $ArtifactDir $UpdaterSignatureName
    $artifactLatestJson = Join-Path $ArtifactDir "latest.json"
    $artifactApp = Join-Path $ArtifactDir "keydex-desktop.exe"
    $artifactSidecarDir = Join-Path $ArtifactDir "binaries\agent-server"
    $artifactSidecar = Join-Path $artifactSidecarDir "agent-server.exe"
    $legacyArtifactSidecars = @(
        (Join-Path $ArtifactDir "agent-server.exe"),
        (Join-Path $ArtifactDir "agent-server-x86_64-pc-windows-msvc.exe")
    )

    Copy-Artifact -Source $Installer -Destination $artifactInstaller
    $hasUpdaterBundle = Test-Path -LiteralPath $UpdaterBundle
    $hasUpdaterSignature = Test-Path -LiteralPath $UpdaterSignature
    if ($hasUpdaterBundle -xor $hasUpdaterSignature) {
        throw "updater 产物不完整：$UpdaterBundle / $UpdaterSignature"
    }
    if ($ExpectUpdaterArtifacts -and -not ($hasUpdaterBundle -and $hasUpdaterSignature)) {
        throw "已启用 createUpdaterArtifacts，但未生成 updater 产物：$UpdaterBundle / $UpdaterSignature。请检查 TAURI_SIGNING_PRIVATE_KEY、TAURI_CONFIG 和 Tauri build 日志。"
    }
    if ($hasUpdaterBundle) {
        Copy-Artifact -Source $UpdaterBundle -Destination $artifactUpdaterBundle
        Copy-Artifact -Source $UpdaterSignature -Destination $artifactUpdaterSignature
        $signature = (Get-Content -Raw -LiteralPath $artifactUpdaterSignature).Trim()
        $updateUrl = "https://github.com/$ReleaseRepository/releases/download/$ReleaseTag/$UpdaterBundleName"
        $latest = [ordered]@{
            version = $AppVersion
            notes = "Keydex $AppVersion"
            pub_date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
            platforms = [ordered]@{
                "windows-x86_64" = [ordered]@{
                    signature = $signature
                    url = $updateUrl
                }
            }
        }
        $latest | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath $artifactLatestJson
    } else {
        foreach ($staleUpdaterArtifact in @($artifactUpdaterBundle, $artifactUpdaterSignature, $artifactLatestJson)) {
            if (Test-Path -LiteralPath $staleUpdaterArtifact) {
                Remove-Item -LiteralPath $staleUpdaterArtifact -Force
            }
        }
    }
    Copy-Artifact -Source $ReleaseApp -Destination $artifactApp
    foreach ($legacySidecar in $legacyArtifactSidecars) {
        if (Test-Path $legacySidecar) {
            Remove-Item -LiteralPath $legacySidecar -Force
        }
    }
    Copy-DirectoryArtifact -Source $SidecarDir -Destination $artifactSidecarDir

    $files = @(
        Get-Item -LiteralPath $artifactInstaller
        Get-Item -LiteralPath $artifactApp
        Get-Item -LiteralPath $artifactSidecar
    )
    if ($hasUpdaterBundle) {
        $files += @(
            Get-Item -LiteralPath $artifactUpdaterBundle
            Get-Item -LiteralPath $artifactUpdaterSignature
            Get-Item -LiteralPath $artifactLatestJson
        )
    }
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
        "Keydex Windows 产物",
        "",
        "主安装包：",
        "  $InstallerName",
        ""
    )
    if ($hasUpdaterBundle) {
        $readmeLines += @(
            "应用内更新产物：",
            "  $UpdaterBundleName",
            "  $UpdaterSignatureName",
            "  latest.json",
            ""
        )
    }
    $readmeLines += @(
        "调试/直接运行二进制：",
        "  keydex-desktop.exe",
        "",
        "Tauri sidecar 目录：",
        "  binaries\agent-server\agent-server.exe",
        "",
        "生成时间：",
        "  $($manifest.generated_at)"
    )
    ($readmeLines -join [Environment]::NewLine) |
        Set-Content -Encoding UTF8 (Join-Path $ArtifactDir "README.txt")
}

$InstallerInfo = Get-Item -LiteralPath $Installer
$SidecarInfo = Get-Item -LiteralPath $Sidecar
$SidecarDirBytes = (Get-ChildItem -LiteralPath $SidecarDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
$ArtifactInstallerInfo = Get-Item -LiteralPath (Join-Path $ArtifactDir $InstallerName)

Write-Host ""
Write-Host "打包完成。"
Write-Host "安装包：$($InstallerInfo.FullName)"
Write-Host "安装包大小：$($InstallerInfo.Length) 字节"
Write-Host "快速产物目录：$ArtifactDir"
Write-Host "快速安装包：$($ArtifactInstallerInfo.FullName)"
Write-Host "Sidecar 目录：$SidecarDir"
Write-Host "Sidecar 入口：$($SidecarInfo.FullName)"
Write-Host "Sidecar 目录大小：$SidecarDirBytes 字节"
