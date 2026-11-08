@echo off
rem FlowVision scheduled backup job (Windows Task Scheduler runs this; see docs/BACKUP_AND_RECOVERY.md section 8).
rem   backup-task.cmd daily   <log folder>   snapshot, then retention only if the snapshot was complete
rem   backup-task.cmd weekly  <log folder>   full backup, copied to the external drive
rem   backup-task.cmd monthly <log folder>   read every byte of the Restic repository
rem Runs in the FlowVision folder (two levels up), so the backup tool reads that folder's .env.
rem Appends to <log folder>\<job>.log and exits with the backup tool's own code
rem (0 done, 1 failed, 2 configuration, 3 incomplete), which Task Scheduler shows as "Last Run Result".
setlocal EnableExtensions EnableDelayedExpansion
set "JOB=%~1"
set "LOGDIR=%~2"
if "%JOB%"=="" goto usage
if "%LOGDIR%"=="" goto usage
cd /d "%~dp0..\.." || exit /b 2
if not exist "%LOGDIR%\" mkdir "%LOGDIR%" || exit /b 2
set "LOG=%LOGDIR%\%JOB%.log"
where node >nul 2>&1 || (>>"%LOG%" echo node.exe is not on PATH for this Windows account & exit /b 2)
>>"%LOG%" echo.
>>"%LOG%" echo ===== %DATE% %TIME% %JOB% started on %COMPUTERNAME% as %USERNAME%
set RC=0
if /i "%JOB%"=="daily" (
  call :run snapshot
  if !RC! EQU 0 call :run forget
) else if /i "%JOB%"=="weekly" (
  call :run full
) else if /i "%JOB%"=="monthly" (
  call :run check --read-data
) else (
  goto usage
)
>>"%LOG%" echo ===== %DATE% %TIME% %JOB% finished with exit code !RC!
exit /b !RC!

:run
node scripts\backup.ts %* >>"%LOG%" 2>&1
set RC=%ERRORLEVEL%
exit /b 0

:usage
echo Usage: backup-task.cmd daily^|weekly^|monthly ^<log folder^>
exit /b 2
