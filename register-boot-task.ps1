# Run this in an elevated (Administrator) PowerShell window.
# Registers a SYSTEM-level scheduled task that resurrects PM2 at boot,
# with no user login required, closing the gap the logon-trigger task
# (already registered under the hp account) doesn't cover.

$Action = New-ScheduledTaskAction -Execute "C:\Users\hp\Desktop\attendance_middleware\pm2-resurrect.bat" -WorkingDirectory "C:\Users\hp\Desktop\attendance_middleware"

$TriggerStartup = New-ScheduledTaskTrigger -AtStartup
$TriggerStartup.Delay = "PT60S"

$Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "PM2 Resurrect - Hikvision Attendance (Boot)" `
    -Action $Action -Trigger $TriggerStartup -Principal $Principal -Settings $Settings `
    -Description "Restarts PM2 and resurrects hikvision-middleware/device-sync/updater at system boot, no login required." `
    -Force

Write-Output "Done. Verifying..."
Get-ScheduledTask -TaskName "PM2 Resurrect - Hikvision Attendance (Boot)" | Format-List TaskName, State
