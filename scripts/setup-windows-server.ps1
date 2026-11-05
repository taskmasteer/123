param([int]$Port=4310,[int]$DatabasePort=54329)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
$dataRoot=Join-Path $projectRoot '.local-state\server'
$pgBin=Join-Path $projectRoot '.local-state\tools\pgsql\bin'
if(-not (Test-Path (Join-Path $pgBin 'initdb.exe'))){throw 'Install PostgreSQL binaries into .local-state/tools/pgsql first.'}
New-Item -ItemType Directory -Force $dataRoot | Out-Null
# Only local Administrators and SYSTEM can access this installation's secrets and DB.
$userSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
icacls $dataRoot /grant:r "*${userSid}:(OI)(CI)F" | Out-Null
icacls $dataRoot /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Private data ACL failed.'}
$configPath=Join-Path $dataRoot 'config.json'
if(Test-Path $configPath){Write-Output 'Existing installation preserved.';exit 0}
Add-Type -AssemblyName System.Security
$bytes=New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$password=[Convert]::ToBase64String($bytes)
$pwFile=Join-Path $dataRoot 'init-password'
try{
  [IO.File]::WriteAllText($pwFile,$password)
  & (Join-Path $pgBin 'initdb.exe') -D (Join-Path $dataRoot 'postgres') -U factory --auth=scram-sha-256 --pwfile=$pwFile --encoding=UTF8 --no-locale | Out-Null
  if($LASTEXITCODE -ne 0){throw 'Database initialization failed.'}
}finally{if(Test-Path $pwFile){Remove-Item -LiteralPath $pwFile}}
$cipher=[Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($password),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
@{port=$Port;databasePort=$DatabasePort;databasePassword=[Convert]::ToBase64String($cipher)} | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
$process=Start-Process -FilePath (Join-Path $pgBin 'pg_ctl.exe') -ArgumentList @('-D',('"'+(Join-Path $dataRoot 'postgres')+'"'),'-l',('"'+(Join-Path $dataRoot 'postgres.log')+'"'),'-o',('"-h 127.0.0.1 -p '+$DatabasePort+'"'),'-w','start') -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'pg-start.log') -RedirectStandardError (Join-Path $dataRoot 'pg-start-error.log')
if($process.ExitCode -ne 0){throw 'Database start failed.'}
$password=$null
Write-Output 'Private loopback database initialized. Run the server after building.'
