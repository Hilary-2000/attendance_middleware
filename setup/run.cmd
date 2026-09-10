@echo off
REM ---------------------------------------------------------------------------
REM  Generic Node launcher for the scheduled tasks.
REM    run.cmd <script> <logbase>
REM  e.g.  run.cmd index.js middleware   ->  logs\middleware-out.log / -err.log
REM
REM  - always runs from the repo root so config.js / dotenv finds .env
REM  - captures stdout/stderr to logs\<logbase>-out.log / -err.log
REM    (Task Scheduler does not capture console output on its own)
REM  - rotates a log to .1 once it passes ~5 MB
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0.."

set "SCRIPT=%~1"
set "LOGBASE=%~2"
if "%LOGBASE%"=="" set "LOGBASE=%~n1"

if not exist logs mkdir logs

for %%S in (out err) do (
    if exist "logs\%LOGBASE%-%%S.log" for %%F in ("logs\%LOGBASE%-%%S.log") do (
        if %%~zF GTR 5242880 move /y "logs\%LOGBASE%-%%S.log" "logs\%LOGBASE%-%%S.log.1" >nul 2>&1
    )
)

set "NODE=node"
where node >nul 2>&1 || set "NODE=C:\Program Files\nodejs\node.exe"

echo. >> "logs\%LOGBASE%-out.log"
echo ===== %DATE% %TIME%  start %SCRIPT% >> "logs\%LOGBASE%-out.log"
"%NODE%" "%SCRIPT%" >> "logs\%LOGBASE%-out.log" 2>> "logs\%LOGBASE%-err.log"
set RC=%errorlevel%
echo ===== %DATE% %TIME%  exit %SCRIPT% rc=%RC% >> "logs\%LOGBASE%-out.log"

endlocal & exit /b %RC%
