param([string]$DataDirectory)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$nodeSource=(Get-Command node).Source
$runtimePath=Join-Path $projectRoot '.local-state\tools\runtime'
New-Item -ItemType Directory -Force $runtimePath | Out-Null
Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $runtimePath 'node.exe') -Force
$launcher=Join-Path $projectRoot 'scripts\start-windows-server.ps1'
$arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$launcher+'"'
if($DataDirectory){$arguments+=' -DataDirectory "'+[IO.Path]::GetFullPath($DataDirectory)+'"'}
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $projectRoot
$trigger=New-ScheduledTaskTrigger -AtStartup
$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName 'SiteFactory-Control' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Site Factory HTTPS API and durable generation worker' -Force | Out-Null
Start-ScheduledTask -TaskName 'SiteFactory-Control'
Write-Output 'SiteFactory-Control installed. No firewall ports were opened.'
