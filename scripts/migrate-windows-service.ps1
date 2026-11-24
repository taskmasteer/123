param([string]$TaskName='SiteFactory-Control')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$data=Join-Path $root '.local-state/server'
$configPath=Join-Path $data 'config.json'
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$task=Get-ScheduledTask -TaskName $TaskName
if($task.Actions.Arguments -notlike ('*'+$root+'*')){throw 'Task does not belong to this installation.'}
$node=Join-Path $root '.local-state/tools/runtime/node.exe'
if(-not(Test-Path -LiteralPath $node)){$node=Join-Path $root '.local-state/tools/node/node.exe'}
$pgCtl=Join-Path $root '.local-state/tools/pgsql/bin/pg_ctl.exe'
$cluster=Join-Path $data 'postgres'
$service=Get-CimInstance Win32_Service -Filter "Name='SiteFactory-Postgres'"
if($service -and $service.PathName -notlike ('*'+$cluster+'*')){throw 'Database service belongs to another installation.'}
Export-ScheduledTask -TaskName $TaskName | Set-Content -LiteralPath (Join-Path $data 'task-before-service-migration.xml') -Encoding utf8
Stop-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
# Stop only this installation's API processes; never stop PostgreSQL by process tree.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
 $_.CommandLine -like ('*'+$root+'*') -and ($_.CommandLine -like '*dist*apps*server*src*main.js*' -or $_.CommandLine -like '*server-manage.mjs*serve*' -or $_.CommandLine -like '*server-manage.mjs*run-api*')
} | ForEach-Object {Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue}
& $pgCtl -D $cluster status *> $null
if($LASTEXITCODE -eq 0){& $pgCtl -D $cluster -m fast -w stop;if($LASTEXITCODE -ne 0){throw 'Cannot stop database cleanly.'}}
& (Join-Path $PSScriptRoot 'grant-service-traversal.ps1') -InstallRoot $root
& icacls $root /grant '*S-1-5-19:(OI)(CI)RX' /Q | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot grant application read access.'}
& icacls $data /grant '*S-1-5-19:(OI)(CI)M' /T /Q | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot grant data access.'}
if(-not $service){& $pgCtl register -N SiteFactory-Postgres -D $cluster -S auto -o ('-h 127.0.0.1 -p '+$config.databasePort);if($LASTEXITCODE -ne 0){throw 'Database service registration failed.'}}
& sc.exe config SiteFactory-Postgres obj= 'NT AUTHORITY\LocalService' password= '' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot change database service account.'}
$config | Add-Member -Force -NotePropertyName databaseService -NotePropertyValue 'SiteFactory-Postgres'
[IO.File]::WriteAllText($configPath,($config | ConvertTo-Json -Depth 30))
& sc.exe failure SiteFactory-Postgres reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot configure database recovery.'}
& sc.exe failureflag SiteFactory-Postgres 1 | Out-Null
Start-Service SiteFactory-Postgres
$action=New-ScheduledTaskAction -Execute $node -Argument ('"'+(Join-Path $root 'scripts/server-manage.mjs')+'" serve --log') -WorkingDirectory $root
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
Set-ScheduledTask -TaskName $TaskName -Action $action -Principal (New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited) -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output 'API and database service accounts migrated to LocalService. Verify health before closing maintenance.'
