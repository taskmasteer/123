param([Parameter(Mandatory=$true)][string]$Archive,[string]$TaskName='SiteFactory-API')
$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot -Parent
$node=Join-Path $root '.local-state/tools/node/node.exe'
if(-not(Test-Path -LiteralPath $node)){$node=Join-Path $root '.local-state/tools/runtime/node.exe'}
$cli=Join-Path $root 'scripts/update-api.mjs'
$manage=Join-Path $root 'scripts/server-manage.mjs'
$task=Get-ScheduledTask $TaskName
if($task.Actions.Arguments -notlike ('*'+$root+'*')){throw 'Task belongs to another installation.'}
$applied=$false
try{
 Stop-ScheduledTask $TaskName
 Start-Sleep -Seconds 3
 & $node $cli ([IO.Path]::GetFullPath($Archive))
 if($LASTEXITCODE -ne 0){throw 'API update failed before activation.'}
 $applied=$true
 Start-ScheduledTask $TaskName
 for($attempt=0;$attempt -lt 40;$attempt++){
  & $node $manage status *> $null
  if($LASTEXITCODE -eq 0){Write-Output 'Updated API is healthy. Encrypted backup and previous code retained.';return}
  Start-Sleep -Seconds 2
 }
 throw 'Updated API did not become healthy.'
}catch{
 Stop-ScheduledTask $TaskName
 Start-Sleep -Seconds 2
 if($applied){& $node $cli rollback;if($LASTEXITCODE -ne 0){throw 'Automatic rollback failed. Keep the service stopped and inspect the upgrade journal.'}}
 $journal=Join-Path $root '.local-state/upgrade.json'
 if((Test-Path -LiteralPath $journal) -and (Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json).state -eq 'installing'){throw 'Code rollback is incomplete. API remains stopped; inspect upgrade.json.'}
 Start-ScheduledTask $TaskName
 throw
}
