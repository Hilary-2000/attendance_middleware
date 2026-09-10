@echo off
REM Restarts PM2 and reloads the saved process list
REM (hikvision-middleware, hikvision-device-sync, hikvision-updater)
REM after a reboot or crash. Registered as Windows Scheduled Task
REM "PM2 Resurrect - Hikvision Attendance".
set PM2_HOME=C:\Users\hp\.pm2
"C:\Users\hp\AppData\Roaming\npm\pm2.cmd" resurrect
