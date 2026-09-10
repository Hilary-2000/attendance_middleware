@echo off
REM ---------------------------------------------------------------------------
REM  Wrapper for the daily HikvisionUpdater task.
REM    1. run updater.js  (git pull + npm install if package.json changed)
REM    2. always bounce HikvisionDeviceSync so it reloads code AND its log
REM       rotates once a day. The middleware task is short-lived and picks
REM       up new code on its next 5-minute run by itself.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."

call "%~dp0run.cmd" updater.js updater
set RC=%errorlevel%

echo [run-updater] restarting HikvisionDeviceSync
schtasks /End /TN "HikvisionDeviceSync" >nul 2>&1
timeout /t 3 /nobreak >nul
schtasks /Run /TN "HikvisionDeviceSync" >nul 2>&1

endlocal & exit /b %RC%
