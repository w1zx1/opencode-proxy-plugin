<#
.SYNOPSIS
    Устанавливает плагин opencode-system-proxy в глобальную папку плагинов OpenCode.

.DESCRIPTION
    Копирует плагин в %USERPROFILE%\.config\opencode\plugins\opencode-system-proxy,
    откуда OpenCode v2 загружает плагины автоматически.

.PARAMETER Uninstall
    Удалить установленную копию плагина.

.EXAMPLE
    .\install.ps1

.EXAMPLE
    .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$target = Join-Path $env:USERPROFILE ".config\opencode\plugins\opencode-system-proxy"

if ($Uninstall) {
    if (Test-Path $target) {
        Remove-Item -Recurse -Force $target
        Write-Host "Removed $target"
    } else {
        Write-Host "Nothing to remove: $target does not exist"
    }
    return
}

New-Item -ItemType Directory -Force -Path $target | Out-Null

Copy-Item -Recurse -Force (Join-Path $PSScriptRoot "src") $target
Copy-Item -Force (Join-Path $PSScriptRoot "package.json") $target
Copy-Item -Force (Join-Path $PSScriptRoot "README.md") $target

Write-Host "Installed to $target"
Write-Host "Reload OpenCode with /reload, or run: opencode service restart"
