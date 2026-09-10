#Requires -Version 5.1
<#
  install-native.ps1
  ---------------------------------------------------------------------------
  Configures the Hikvision attendance middleware to run unattended using
  native Windows Task Scheduler (no PM2). After this runs and you reboot,
  everything starts on its own with NO login required.

  Creates three SYSTEM scheduled tasks:

    HikvisionDeviceSync  - the self-pacing person/photo sync loop.
                           Starts 30s after boot; a 10-min trigger relaunches
                           it if it ever dies; also auto-restarts on crash.
    HikvisionMiddleware  - posts attendance to the cloud. Runs every 5 min
                           (skips a run if the previous one is still going).
    HikvisionUpdater     - git-pulls new code daily at 09:30 and bounces
                           the device-sync task if anything changed.

  Removes the old PM2 "PM2 Resurrect" scheduled task and stops any running
  PM2 daemons. Optionally uninstalls PM2 at the end.

  USAGE:  open Windows PowerShell / Terminal AS ADMINISTRATOR, then:
            cd C:\Users\hp\Desktop\attendance_middleware
            .\setup\install-native.ps1

  -RemovePm2  ask | yes | no   (default: ask when PM2 is installed)
              'no' is used by setup\bootstrap.ps1 on a fresh PC.
#>

param(
    [ValidateSet('ask','yes','no')]
    [string]$RemovePm2 = 'ask'
)

$ErrorActionPreference = 'Stop'

# --- must be elevated ------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal] `
          [Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host "This must be run from an ELEVATED PowerShell (Run as administrator)." -ForegroundColor Red
    exit 1
}

$RepoRoot = Split-Path $PSScriptRoot -Parent
$Run      = Join-Path $PSScriptRoot 'run.cmd'
$RunUpd   = Join-Path $PSScriptRoot 'run-updater.cmd'

Write-Host "Repo root : $RepoRoot"

# --- pre-flight checks ---------------------------------------------------------
foreach ($f in 'index.js','Devicesync.js','updater.js','.env') {
    if (-not (Test-Path (Join-Path $RepoRoot $f))) { throw "Missing required file: $f" }
}
foreach ($exe in 'node','git') {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        throw "'$exe' is not on the machine PATH - install it (or add it) and re-run."
    }
}
Write-Host "node      : $((Get-Command node).Source)  $(node -v)"
Write-Host "git       : $((Get-Command git).Source)"

# --- let SYSTEM run git in this hp-owned repo --------------------------------
$repoForGit = ($RepoRoot -replace '\\','/')
git config --system --replace-all safe.directory $repoForGit 2>$null
git config --system --add     safe.directory '*'            2>$null
Write-Host "git safe.directory configured for SYSTEM"

# --- stop / remove the old PM2 setup ----------------------------------------
Write-Host "`nStopping the old PM2 setup ..." -ForegroundColor Cyan

foreach ($t in 'PM2 Resurrect - Hikvision Attendance',
               'PM2 Resurrect - Hikvision Attendance (Boot)') {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $t -Confirm:$false
        Write-Host "  removed scheduled task: $t"
    }
}

try { & pm2 kill 2>$null | Out-Null } catch { }

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'pm2|Daemon\.js|ProcessContainerFork|InteractorDaemon|index\.js|Devicesync\.js|updater\.js' } |
    ForEach-Object {
        Write-Host "  killing stale node PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Start-Sleep 2

# --- scheduled-task building blocks ----------------------------------------
function New-RepeatTrigger([int]$Minutes) {
    # Work around the PowerShell bug that drops -RepetitionInterval on register.
    $t = New-ScheduledTaskTrigger -Once -At (Get-Date)
    $t.Repetition = (New-ScheduledTaskTrigger -Once -At (Get-Date) `
        -RepetitionInterval (New-TimeSpan -Minutes $Minutes) `
        -RepetitionDuration  (New-TimeSpan -Days 3650)).Repetition
    $t
}
function New-CmdAction([string]$Wrapper, [string]$ScriptArg) {
    $arg = "/c `"$Wrapper`""
    if ($ScriptArg) { $arg += " $ScriptArg" }
    New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $arg -WorkingDirectory $RepoRoot
}

$system = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$common = @{
    AllowStartIfOnBatteries    = $true
    DontStopIfGoingOnBatteries = $true
    StartWhenAvailable         = $true
    MultipleInstances          = 'IgnoreNew'
}

$bootTrigger = New-ScheduledTaskTrigger -AtStartup
$bootTrigger.Delay = 'PT30S'

Write-Host "`nRegistering scheduled tasks ..." -ForegroundColor Cyan

# 1. device-sync : long-running loop
Register-ScheduledTask -Force -TaskName 'HikvisionDeviceSync' -Principal $system `
    -Action  (New-CmdAction $Run 'Devicesync.js device-sync') `
    -Trigger $bootTrigger, (New-RepeatTrigger 10) `
    -Settings (New-ScheduledTaskSettingsSet @common `
                 -ExecutionTimeLimit ([TimeSpan]::Zero) `
                 -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3) `
    -Description 'Hikvision person/photo sync loop. Auto-restarts; watchdog every 10 min.' | Out-Null
Write-Host "  + HikvisionDeviceSync"

# 2. middleware : every 5 minutes
Register-ScheduledTask -Force -TaskName 'HikvisionMiddleware' -Principal $system `
    -Action  (New-CmdAction $Run 'index.js middleware') `
    -Trigger (New-RepeatTrigger 5) `
    -Settings (New-ScheduledTaskSettingsSet @common -ExecutionTimeLimit (New-TimeSpan -Minutes 4)) `
    -Description 'Posts terminal attendance events to the cloud every 5 minutes.' | Out-Null
Write-Host "  + HikvisionMiddleware"

# 3. updater : daily 09:30
Register-ScheduledTask -Force -TaskName 'HikvisionUpdater' -Principal $system `
    -Action  (New-CmdAction $RunUpd '') `
    -Trigger (New-ScheduledTaskTrigger -Daily -At ([datetime]'09:30')) `
    -Settings (New-ScheduledTaskSettingsSet @common -ExecutionTimeLimit (New-TimeSpan -Minutes 15)) `
    -Description 'Pulls new code from GitHub each morning; restarts device-sync if changed.' | Out-Null
Write-Host "  + HikvisionUpdater"

# --- start them now -------------------------------------------------------
Write-Host "`nStarting tasks ..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName 'HikvisionDeviceSync'
Start-ScheduledTask -TaskName 'HikvisionMiddleware'
Start-Sleep 25

# --- verify --------------------------------------------------------------
Write-Host "`n---- status ----------------------------------------------------" -ForegroundColor Green
Get-ScheduledTask -TaskName 'Hikvision*' |
    Get-ScheduledTaskInfo |
    Select-Object TaskName, LastRunTime, LastTaskResult, NextRunTime |
    Format-Table -AutoSize

$loop = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
        Where-Object { $_.CommandLine -match 'Devicesync\.js' }
if ($loop) {
    Write-Host "device-sync loop is running (PID $($loop.ProcessId))." -ForegroundColor Green
} else {
    Write-Host "device-sync loop is NOT running yet - check logs\device-sync-err.log" -ForegroundColor Yellow
}

Write-Host "`nlast lines of logs\device-sync-out.log:" -ForegroundColor Green
Get-Content (Join-Path $RepoRoot 'logs\device-sync-out.log') -Tail 6 -ErrorAction SilentlyContinue
Write-Host "`nlast lines of logs\middleware-out.log:" -ForegroundColor Green
Get-Content (Join-Path $RepoRoot 'logs\middleware-out.log') -Tail 6 -ErrorAction SilentlyContinue

# --- optionally remove PM2 --------------------------------------------------
Write-Host ""
$pm2Present = [bool](Get-Command pm2 -ErrorAction SilentlyContinue)
$doRemove =
    switch ($RemovePm2) {
        'yes'   { $pm2Present }
        'no'    { $false }
        default { $pm2Present -and ((Read-Host "PM2 is no longer used. Uninstall it now? (y/N)") -match '^(y|yes)$') }
    }

if ($doRemove) {
    try {
        & pm2 kill 2>$null | Out-Null
        npm uninstall -g pm2
        Remove-Item "$env:USERPROFILE\.pm2" -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item 'C:\ProgramData\pm2'   -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host "PM2 removed." -ForegroundColor Green
        Write-Host "Note: pm2-resurrect.bat, register-boot-task.ps1 and ecosystem.config.cjs"
        Write-Host "are still tracked in git - delete them in a commit when you're ready."
    } catch {
        Write-Host "PM2 uninstall hit an error: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "Run 'npm uninstall -g pm2' by hand later."
    }
} elseif ($pm2Present) {
    Write-Host "Left PM2 installed (unused). Remove later with: npm uninstall -g pm2"
}

Write-Host "`nDONE. Reboot the machine to confirm everything comes back with nobody logged in." -ForegroundColor Green
Write-Host "After reboot, check with:  .\setup\manage.ps1 status"
