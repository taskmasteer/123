param(
  [Parameter(Mandatory=$true)][string]$BackupFile,
  [Parameter(Mandatory=$true)][string]$Destination,
  [Parameter(Mandatory=$true)][ValidatePattern('^sf_restore_[a-z0-9_]{1,48}$')][string]$Database
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$recoverySecret=Read-Host 'Ключ восстановления' -AsSecureString
$plainRecoverySecret=[System.Net.NetworkCredential]::new('', $recoverySecret).Password
$restorePayload=@{archive=[IO.Path]::GetFullPath($BackupFile);destination=[IO.Path]::GetFullPath($Destination);database=$Database;password=$plainRecoverySecret}|ConvertTo-Json -Compress
$startInfo=[System.Diagnostics.ProcessStartInfo]::new()
$startInfo.FileName=Join-Path $projectRoot '.local-state/tools/runtime/node.exe'
$startInfo.Arguments='"'+(Join-Path $projectRoot 'scripts/restore-windows.mjs')+'"'
$startInfo.WorkingDirectory=$projectRoot
$startInfo.UseShellExecute=$false
$startInfo.CreateNoWindow=$true
$startInfo.RedirectStandardInput=$true
$restoreProcess=[System.Diagnostics.Process]::Start($startInfo)
$restoreProcess.StandardInput.Write($restorePayload)
$restoreProcess.StandardInput.Close()
$plainRecoverySecret=$null;$restorePayload=$null
$restoreProcess.WaitForExit()
if($restoreProcess.ExitCode -ne 0){throw 'Восстановление не завершено.'}
Write-Output 'Копия восстановлена отдельно. Рабочая установка не заменена. Операции в восстановленной базе остаются на паузе.'
