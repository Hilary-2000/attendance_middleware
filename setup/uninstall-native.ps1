#Requires -Version 5.1
<#
  uninstall-native.ps1 - removes the three Hikvision scheduled tasks and
  stops their processes. Does NOT reinstall PM2.

  To go back to PM2 afterwards:
     npm install -g pm2
     cd C:\Users\hp\Desktop\attendance_middleware
     pm2 start ecosystem.config.cjs
     pm2 save

  USAGE (elevated PowerShell):  .\setup\uninstall-native.ps1
#>

$ErrorActionPreference = 'Stop'

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Run from an elevated PowerShell." -ForegroundColor Red; exit 1 }

foreach ($t in 'HikvisionDeviceSync','HikvisionMiddleware','HikvisionUpdater') {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        schtasks /End /TN $t 2>$null | Out-Null
        Unregister-ScheduledTask -TaskName $t -Confirm:$false
        Write-Host "removed task: $t"
    }
}

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -match 'Devicesync\.js|index\.js|updater\.js' } |
    ForEach-Object {
        Write-Host "killing node PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Write-Host "`nDone. The middleware is now NOT running by any mechanism." -ForegroundColor Yellow
