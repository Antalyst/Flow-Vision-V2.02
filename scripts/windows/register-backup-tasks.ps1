<#
.SYNOPSIS
  Writes (and with -Register, creates) FlowVision's three scheduled backup tasks. See docs/BACKUP_AND_RECOVERY.md section 8.

.DESCRIPTION
  Daily 19:00 snapshot (+ retention), weekly Sunday 20:00 full backup (+ external-drive copy), monthly 1st 21:00 repository read.
  Every task:
    - runs a missed start as soon as the computer is on again (StartWhenAvailable);
    - also runs on battery power, and is not stopped when the laptop unplugs;
    - never starts a second copy of itself while one is running (IgnoreNew); the backup tool's lock also keeps
      the three jobs from overlapping each other;
    - is stopped after 8 hours (a hung job then shows as failed rather than blocking every later run);
    - runs as the account that runs this script, with that account's rights only (no elevation).
  Without -Register nothing is changed on this computer: the task definitions are only written as XML files to -OutDir,
  to review (or import by hand in Task Scheduler, Action > Import Task).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\windows\register-backup-tasks.ps1 -LogDir D:\FlowVisionBackups\logs
  powershell -ExecutionPolicy Bypass -File scripts\windows\register-backup-tasks.ps1 -LogDir D:\FlowVisionBackups\logs -Register
#>
[CmdletBinding()]
param(
  # Where the jobs append their logs (created if missing). Use the backup computer's own disk.
  [Parameter(Mandatory = $true)][string]$LogDir,
  # The FlowVision folder (the one holding package.json and .env). Default: two levels above this script.
  [string]$AppDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  # Where the task XML files are written.
  [string]$OutDir = (Join-Path $env:TEMP 'flowvision-backup-tasks'),
  # Actually create the tasks (under \FlowVision\ in Task Scheduler) for the current user.
  [switch]$Register
)
$ErrorActionPreference = 'Stop'

if (-not [IO.Path]::IsPathRooted($LogDir)) { throw "LogDir must be an absolute path, e.g. D:\FlowVisionBackups\logs" }
$runner = Join-Path $AppDir 'scripts\windows\backup-task.cmd'
if (-not (Test-Path -LiteralPath $runner)) { throw "Not a FlowVision folder (no scripts\windows\backup-task.cmd): $AppDir" }
if (-not (Test-Path -LiteralPath (Join-Path $AppDir '.env'))) { Write-Warning "$AppDir has no .env: the jobs will use only this account's environment variables." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Warning 'node.exe is not on PATH for this account: the jobs will fail until it is.' }

$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$esc = { param($s) [Security.SecurityElement]::Escape($s) }
# The first start is tomorrow (Task Scheduler needs a start boundary; times are this computer's local time).
$day = (Get-Date).Date.AddDays(1).ToString('yyyy-MM-dd')

$tasks = @(
  @{ Name = 'Daily snapshot'; Job = 'daily'; Time = '19:00:00'; Schedule = '<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>'
     About = 'FlowVision: daily Restic snapshot of the database and uploaded files, restore-tested, then retention.' },
  @{ Name = 'Weekly full backup'; Job = 'weekly'; Time = '20:00:00'; Schedule = '<ScheduleByWeek><DaysOfWeek><Sunday /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek>'
     About = 'FlowVision: weekly encrypted full backup, verified, copied to the external drive and verified there.' },
  @{ Name = 'Monthly repository read'; Job = 'monthly'; Time = '21:00:00'; Schedule = '<ScheduleByMonth><DaysOfMonth><Day>1</Day></DaysOfMonth><Months><January /><February /><March /><April /><May /><June /><July /><August /><September /><October /><November /><December /></Months></ScheduleByMonth>'
     About = 'FlowVision: monthly read of every byte of the Restic repository (restic check --read-data).' }
)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
foreach ($t in $tasks) {
  # cmd.exe /c ""<runner>" <job> "<log dir>"": the outer quotes are removed by cmd, the inner ones keep paths with spaces whole.
  $arguments = '/c ""' + $runner + '" ' + $t.Job + ' "' + $LogDir + '""'
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>$(& $esc $user)</Author>
    <Description>$(& $esc $t.About)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$($day)T$($t.Time)</StartBoundary>
      <Enabled>true</Enabled>
      $($t.Schedule)
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(& $esc $user)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT8H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(& $esc (Join-Path $env:SystemRoot 'System32\cmd.exe'))</Command>
      <Arguments>$(& $esc $arguments)</Arguments>
      <WorkingDirectory>$(& $esc $AppDir)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
  $file = Join-Path $OutDir ("FlowVision - " + $t.Name + '.xml')
  [IO.File]::WriteAllText($file, $xml, [Text.Encoding]::Unicode)
  [xml]$null = Get-Content -LiteralPath $file -Raw   # well-formed, or this stops here
  Write-Host "written: $file"
  if ($Register) {
    Register-ScheduledTask -TaskPath '\FlowVision\' -TaskName $t.Name -Xml $xml -Force | Out-Null
    Write-Host "registered: \FlowVision\$($t.Name) (runs as $user while that account is signed in)"
  }
}
if (-not $Register) { Write-Host 'Nothing was registered. Review the XML, then run again with -Register.' }
else {
  Write-Host 'Check them with: Get-ScheduledTask -TaskPath \FlowVision\ | Get-ScheduledTaskInfo'
  Write-Host 'To run them when nobody is signed in: Task Scheduler > task > Properties > "Run whether user is logged on or not" (Windows then stores the password).'
}
