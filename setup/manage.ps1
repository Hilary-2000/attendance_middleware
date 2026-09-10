#Requires -Version 5.1
<#
  manage.ps1 - day-to-day control of the Hikvision attendance tasks.

    .\setup\manage.ps1 status                 # what's running, last results, log tails
    .\setup\manage.ps1 restart                # restart all three tasks
    .\setup\manage.ps1 restart device-sync    # restart just one
    .\setup\manage.ps1 stop                   # disable + stop everything
    .\setup\manage.ps1 start                  # enable + start everything
    .\setup\manage.ps1 logs device-sync       # live tail (Ctrl+C to quit)
    .\setup\manage.ps1 logs middleware
    .\setup\manage.ps1 logs updater

  'stop' / 'start' / 'restart' need an elevated PowerShell. 'status' and
  'logs' do not.
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet('status','restart','stop','start','logs')]
    [string]$Command = 'status',

    [Parameter(Position = 1)]
    [ValidateSet('all','device-sync','middleware','updater')]
    [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent

$TASKS = [ordered]@{
    'device-sync' = 'HikvisionDeviceSync'
    'middleware'  = 'HikvisionMiddleware'
    'updater'     = 'HikvisionUpdater'
}
$LOGS = @{
    'device-sync' = 'logs\device-sync-out.log'
    'middleware'  = 'logs\middleware-out.log'
    'updater'     = 'logs\updater-out.log'
}

function Selected {
    if ($Target -eq 'all') { $TASKS.GetEnumerator() }
    else { $TASKS.GetEnumerator() | Where-Object { $_.Key -eq $Target } }
}
function Require-Admin {
    $a = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $a) { Write-Host "Run this from an elevated PowerShell." -ForegroundColor Red; exit 1 }
}

switch ($Command) {

    'status' {
        Get-ScheduledTask -TaskName 'Hikvision*' -ErrorAction SilentlyContinue |
            Get-ScheduledTaskInfo |
            Select-Object TaskName, LastRunTime,
                          @{n='LastResult';e={ '0x{0:X}' -f $_.LastTaskResult }},
                          NextRunTime |
            Format-Table -AutoSize

        $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
        foreach ($e in $TASKS.GetEnumerator()) {
            $st = (Get-ScheduledTask -TaskName $e.Value -ErrorAction SilentlyContinue).State
            $rx = switch ($e.Key) {
                'device-sync' { 'Devicesync\.js' }
                'middleware'  { 'index\.js' }
                'updater'     { 'updater\.js' }
            }
            $p = $procs | Where-Object { $_.CommandLine -match $rx }
            $run = if ($p) { "node PID $($p.ProcessId -join ',')" } else { '-' }
            "{0,-12} task:{1,-9} process:{2}" -f $e.Key, $st, $run
        }

        foreach ($e in $TASKS.GetEnumerator()) {
            $lf = Join-Path $RepoRoot $LOGS[$e.Key]
            Write-Host "`n--- $($e.Key)  ($($LOGS[$e.Key])) ---" -ForegroundColor Cyan
            if (Test-Path $lf) { Get-Content $lf -Tail 5 } else { Write-Host "(no log yet)" }
        }
    }

    'restart' {
        Require-Admin
        foreach ($e in Selected) {
            Write-Host "restarting $($e.Key) ..."
            schtasks /End /TN $e.Value 2>$null | Out-Null
            Start-Sleep 2
            Start-ScheduledTask -TaskName $e.Value
        }
        Write-Host "done." -ForegroundColor Green
    }

    'stop' {
        Require-Admin
        foreach ($e in Selected) {
            Write-Host "stopping $($e.Key) ..."
            Disable-ScheduledTask -TaskName $e.Value | Out-Null
            schtasks /End /TN $e.Value 2>$null | Out-Null
        }
        Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
            Where-Object { $_.CommandLine -match 'Devicesync\.js|index\.js|updater\.js' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Write-Host "stopped + disabled." -ForegroundColor Green
    }

    'start' {
        Require-Admin
        foreach ($e in Selected) {
            Enable-ScheduledTask -TaskName $e.Value | Out-Null
            Start-ScheduledTask  -TaskName $e.Value
            Write-Host "started $($e.Key)"
        }
        Write-Host "done." -ForegroundColor Green
    }

    'logs' {
        if ($Target -eq 'all') { $Target = 'device-sync' }
        $lf = Join-Path $RepoRoot $LOGS[$Target]
        Write-Host "tailing $lf  (Ctrl+C to stop)" -ForegroundColor Cyan
        Get-Content $lf -Tail 40 -Wait
    }
}
