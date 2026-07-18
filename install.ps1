<#
pictureBOM installer for Windows.

Run from PowerShell:
    powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/deereeco/pictureBOM/main/install.ps1 | iex"

Or download this file and run it directly to use the options:
    .\install.ps1 [-NoShortcut] [-DesktopIcon] [-Source <pip requirement>] [-Python <version>]

Installs git and uv if missing (uv downloads its own Python, so a system
Python install is not required), installs pictureBOM as a uv tool, and
creates a Start Menu shortcut.
#>
param(
    [string]$Source = "git+https://github.com/deereeco/pictureBOM.git",
    [string]$Python = "3.13",
    [switch]$NoShortcut,
    [switch]$DesktopIcon
)

$ErrorActionPreference = "Stop"

function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user;$env:USERPROFILE\.local\bin"
}

function New-AppShortcut([string]$Directory, [string]$IconPath) {
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut((Join-Path $Directory "pictureBOM.lnk"))
    $lnk.TargetPath = Join-Path $env:USERPROFILE ".local\bin\picturebom-gui.exe"
    $lnk.WorkingDirectory = [Environment]::GetFolderPath("MyDocuments")
    $lnk.Description = "pictureBOM - SolidWorks visual BOM generator"
    $lnk.WindowStyle = 7  # minimized: the console window just hosts the local server
    if ($IconPath) { $lnk.IconLocation = "$IconPath,0" }
    $lnk.Save()
}

# The package ships picturebom.ico; copy it to a stable path the shortcut can
# reference (the tool env path contains a Python version dir that changes).
function Install-AppIcon {
    try {
        $toolRoot = (& uv tool dir).Trim()
        $src = Get-ChildItem -Path (Join-Path $toolRoot "picturebom") -Recurse -Filter "picturebom.ico" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($src) {
            $destDir = Join-Path $env:USERPROFILE ".picturebom"
            New-Item -ItemType Directory -Force -Path $destDir | Out-Null
            $dest = Join-Path $destDir "picturebom.ico"
            Copy-Item $src.FullName $dest -Force
            return $dest
        }
    } catch {}
    return $null
}

Write-Host ""
Write-Host "=== pictureBOM installer ===" -ForegroundColor Cyan

# --- git (uv needs the git CLI to install from a GitHub URL) -----------------
if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Host "git: already installed"
} else {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: git is missing and winget is unavailable to install it." -ForegroundColor Red
        Write-Host "Install git from https://git-scm.com/download/win, open a new PowerShell, and re-run this script."
        exit 1
    }
    Write-Host "Installing git..."
    # Try a per-user install first (no admin rights needed); fall back to the
    # default machine scope, which may show a UAC prompt.
    winget install --id Git.Git -e --silent --scope user --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        winget install --id Git.Git -e --silent --accept-package-agreements --accept-source-agreements
    }
    Update-SessionPath
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: git was installed but isn't on PATH yet. Open a NEW PowerShell window and re-run this script." -ForegroundColor Red
        exit 1
    }
    Write-Host "git: installed"
}

# --- uv (installs and manages Python + pictureBOM) ---------------------------
if (Get-Command uv -ErrorAction SilentlyContinue) {
    Write-Host "uv: already installed"
} else {
    Write-Host "Installing uv..."
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    Update-SessionPath
    if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: uv was installed but isn't on PATH yet. Open a NEW PowerShell window and re-run this script." -ForegroundColor Red
        exit 1
    }
    Write-Host "uv: installed"
}

# --- pictureBOM ---------------------------------------------------------------
Write-Host "Installing pictureBOM (uv will download Python $Python on first install)..."
uv tool install --force --python $Python $Source
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: pictureBOM installation failed. See the output above." -ForegroundColor Red
    exit 1
}
# Ensure the uv tools directory is on PATH for future terminals.
uv tool update-shell

# --- shortcuts ------------------------------------------------------------------
$icon = Install-AppIcon
if (-not $NoShortcut) {
    New-AppShortcut ([Environment]::GetFolderPath("Programs")) $icon
    Write-Host "Start Menu shortcut created: pictureBOM"
}
if ($DesktopIcon) {
    New-AppShortcut ([Environment]::GetFolderPath("Desktop")) $icon
    Write-Host "Desktop shortcut created: pictureBOM"
}

Write-Host ""
Write-Host "Done!" -ForegroundColor Green
Write-Host "  Launch:    Start Menu > pictureBOM   (or run: picturebom-gui)"
Write-Host "  Update:    uv tool upgrade picturebom"
Write-Host "  Uninstall: uv tool uninstall picturebom"
Write-Host ""
Write-Host "Remember: SolidWorks must be running before you click Run."
