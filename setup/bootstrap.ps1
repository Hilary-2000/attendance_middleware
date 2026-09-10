#Requires -Version 5.1
<#
  bootstrap.ps1  -  one-line fresh-PC installer for the Hikvision attendance
  middleware.

  Run from an ELEVATED PowerShell:

    [Net.ServicePointManager]::SecurityProtocol='Tls12'; irm https://raw.githubusercontent.com/Hilary-2000/attendance_middleware/main/setup/bootstrap.ps1 | iex

  It will:
    1. install Node.js LTS + Git if missing (via winget)
    2. clone the repo (default C:\attendance_middleware) or pull if it exists
    3. npm install
    4. create .env and config.js from the examples, open .env in Notepad
    5. register the three SYSTEM scheduled tasks (setup\install-native.ps1)

  Safe to re-run: it pulls instead of re-cloning and re-registers the tasks.
#>

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
Set-ExecutionPolicy -Scope Process Bypass -Force -ErrorAction SilentlyContinue

$REPO   = 'https://github.com/Hilary-2000/attendance_middleware.git'
$BRANCH = 'main'

# --- must be elevated ----------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host "Run this from an ELEVATED PowerShell (right-click PowerShell -> Run as administrator)." -ForegroundColor Red
    return
}

Write-Host "=== Hikvision attendance middleware - fresh install ===" -ForegroundColor Cyan

# --- where to install --------------------------------------------------------
$InstallDir = Read-Host "Install location [C:\attendance_middleware]"
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = 'C:\attendance_middleware' }
$InstallDir = $InstallDir.Trim().TrimEnd('\')

# --- prerequisites: Node + Git ---------------------------------------------
function Ensure-Tool([string]$Cmd, [string]$WingetId, [string]$Name) {
    if (Get-Command $Cmd -ErrorAction SilentlyContinue) { Write-Host "  $Name : found"; return }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "$Name is not installed and winget is unavailable. Install $Name manually, then re-run."
    }
    Write-Host "  $Name : installing via winget ($WingetId) ..."
    winget install --id $WingetId --exact --silent --scope machine `
        --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
    if (-not (Get-Command $Cmd -ErrorAction SilentlyContinue)) {
        throw "$Name was installed but is not on PATH yet. Close this window, open a NEW elevated PowerShell, and run the one-liner again."
    }
}
Write-Host "`nChecking prerequisites ..."
Ensure-Tool 'node' 'OpenJS.NodeJS.LTS' 'Node.js'
Ensure-Tool 'git'  'Git.Git'           'Git'

# --- clone or update -------------------------------------------------------
if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Host "`nRepo already present at $InstallDir - pulling latest ..."
    git -C $InstallDir pull --ff-only
} else {
    Write-Host "`nCloning into $InstallDir ..."
    $parent = Split-Path $InstallDir -Parent
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    git clone --branch $BRANCH $REPO $InstallDir
}
Set-Location $InstallDir

# --- dependencies --------------------------------------------------------
Write-Host "`nInstalling npm dependencies (this takes a minute) ..."
cmd /c "npm install --no-fund --no-audit"
if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }

# --- config files ------------------------------------------------------
if (-not (Test-Path (Join-Path $InstallDir '.env'))) {
    Copy-Item (Join-Path $InstallDir '.env_example') (Join-Path $InstallDir '.env')
    Write-Host "created .env"
}
if (-not (Test-Path (Join-Path $InstallDir 'config.js'))) {
    Copy-Item (Join-Path $InstallDir 'config_example.js') (Join-Path $InstallDir 'config.js')
    Write-Host "created config.js"
}

Write-Host "`nFill in .env: TERMINAL_HOST, TERMINAL_PASSWORD, SCHOOL_CODE," -ForegroundColor Yellow
Write-Host "CLOUD_API_BASE_URL, SYNC_TIMEZONE (Africa/Nairobi). Save and close Notepad to continue." -ForegroundColor Yellow
Start-Process notepad (Join-Path $InstallDir '.env') -Wait

# --- register the scheduled tasks -------------------------------------
Write-Host "`nRegistering Windows scheduled tasks ..." -ForegroundColor Cyan
& (Join-Path $InstallDir 'setup\install-native.ps1') -RemovePm2 no

Write-Host "`n=== Install complete ===" -ForegroundColor Green
Write-Host "Reboot to confirm it all starts with nobody logged in, then run:"
Write-Host "  cd `"$InstallDir`"; .\setup\manage.ps1 status"
