param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$NormalizedVersion = $Version.Trim()
if ($NormalizedVersion.StartsWith("v", [System.StringComparison]::OrdinalIgnoreCase)) {
    $NormalizedVersion = $NormalizedVersion.Substring(1)
}

if ($NormalizedVersion -notmatch '^\d+\.\d+\.\d+([\-+][0-9A-Za-z.-]+)?$') {
    throw "Invalid release version '$Version'. Use SemVer such as 0.1.1 or 0.1.1-beta.1."
}

function Set-VersionInFile {
    param(
        [string]$RelativePath,
        [string]$Pattern
    )

    $path = Join-Path $Root $RelativePath
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Version file not found: $RelativePath"
    }

    $content = Get-Content -Raw -LiteralPath $path
    $match = [regex]::Match($content, $Pattern, [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if (-not $match.Success) {
        throw "Version field not found in $RelativePath"
    }

    $group = $match.Groups["version"]
    if (-not $group.Success) {
        throw "Version capture group not found for $RelativePath"
    }

    $next = $content.Substring(0, $group.Index) +
        $NormalizedVersion +
        $content.Substring($group.Index + $group.Length)

    Write-Host "${RelativePath}: $($group.Value) -> $NormalizedVersion"
    if (-not $DryRun) {
        $encoding = [System.Text.UTF8Encoding]::new($false)
        [System.IO.File]::WriteAllText($path, $next, $encoding)
    }
}

$jsonVersionPattern = '^\s*"version"\s*:\s*"(?<version>[^"]+)"'
$tomlVersionPattern = '^\s*version\s*=\s*"(?<version>[^"]+)"'

Set-VersionInFile -RelativePath "package.json" -Pattern $jsonVersionPattern
Set-VersionInFile -RelativePath "desktop/package.json" -Pattern $jsonVersionPattern
Set-VersionInFile -RelativePath "desktop/src-tauri/tauri.conf.json" -Pattern $jsonVersionPattern
Set-VersionInFile -RelativePath "desktop/src-tauri/Cargo.toml" -Pattern $tomlVersionPattern

if ($DryRun) {
    Write-Host "Dry run complete. No files were modified."
} else {
    Write-Host "Release version set to $NormalizedVersion."
}
