param([string]$DataDirectory)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$clusterRoot=Join-Path $projectRoot '.local-state\server'
$dataRoot=if($DataDirectory){[IO.Path]::GetFullPath($DataDirectory)}else{$clusterRoot}
$config=Get-Content (Join-Path $dataRoot 'config.json') -Raw | ConvertFrom-Json
$pgCtl=Join-Path $projectRoot '.local-state\tools\pgsql\bin\pg_ctl.exe'
& $pgCtl -D (Join-Path $clusterRoot 'postgres') status *> $null
if($LASTEXITCODE -ne 0){
  $pgProcess=Start-Process -FilePath $pgCtl -ArgumentList @('-D',('"'+(Join-Path $clusterRoot 'postgres')+'"'),'-l',('"'+(Join-Path $clusterRoot 'postgres.log')+'"'),'-o',('"-h 127.0.0.1 -p '+$config.databasePort+'"'),'-w','start') -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'pg-start.log') -RedirectStandardError (Join-Path $dataRoot 'pg-start-error.log')
  if($pgProcess.ExitCode -ne 0){throw 'PostgreSQL start failed.'}
}
$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path $projectRoot '.local-state\browsers'
$env:SITE_FACTORY_SERVER_DATA=$dataRoot
$env:SITE_FACTORY_SOURCE_ROOT=$projectRoot
$env:SITE_FACTORY_INSTALL_ROOT=$projectRoot
& (Join-Path $projectRoot '.local-state\tools\runtime\node.exe') (Join-Path $projectRoot 'dist\apps\server\src\main.js') >> (Join-Path $dataRoot 'server.log') 2>&1
exit $LASTEXITCODE
