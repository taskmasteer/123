param([Parameter(Mandatory=$true)][string]$PublicIPv4,[string]$BackupFile)
$ErrorActionPreference='Stop'
if(-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Run PowerShell as Administrator.'}
$root=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
$data=Join-Path $root '.local-state/server'
if(Test-Path (Join-Path $data 'config.json')){throw 'Existing installation: use server-manage.mjs restore/address instead.'}
if((Get-Service SiteFactory-Postgres -ErrorAction SilentlyContinue) -or (Get-ScheduledTask -TaskName SiteFactory-API -ErrorAction SilentlyContinue)){throw 'Site Factory services already exist. Use their installation directory.'}
New-Item -ItemType Directory -Force $data | Out-Null
icacls $data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot protect data directory.'}
$tools=Join-Path $root '.local-state/tools'
New-Item -ItemType Directory -Force $tools | Out-Null
# PostgreSQL requires the Microsoft runtime on a fresh Windows installation.
$redist=Join-Path $tools 'vc_redist.x64.exe'
Invoke-WebRequest -Uri 'https://aka.ms/vc14/vc_redist.x64.exe' -OutFile $redist -UseBasicParsing
$signature=Get-AuthenticodeSignature -LiteralPath $redist
if($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Microsoft Corporation(?:,|$)'){throw 'Microsoft runtime signature verification failed.'}
$runtimeInstall=Start-Process -FilePath $redist -ArgumentList '/install','/quiet','/norestart' -WindowStyle Hidden -Wait -PassThru
if($runtimeInstall.ExitCode -notin @(0,1638,3010)){throw 'Microsoft runtime installation failed.'}
$source=(Get-Content scripts/runtime-sources.lock.json -Raw | ConvertFrom-Json).targets.'win32-x64'.node
$archive=Join-Path $tools 'node.zip'
Invoke-WebRequest -Uri $source.url -OutFile $archive -UseBasicParsing
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $source.sha256){throw 'Node checksum mismatch.'}
Expand-Archive -LiteralPath $archive -DestinationPath $tools -Force
$extracted=Join-Path $tools ('node-v'+(Get-Content scripts/runtime-sources.lock.json -Raw | ConvertFrom-Json).node+'-win-x64')
if(Test-Path (Join-Path $tools 'node')){throw 'Node directory already exists; inspect the interrupted installation.'}
Rename-Item -LiteralPath $extracted -NewName 'node'
Remove-Item -LiteralPath $archive
$node=Join-Path $tools 'node/node.exe'
$env:PATH=(Join-Path $tools 'node')+';'+$env:PATH
$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'
& $node (Join-Path $tools 'node/node_modules/npm/bin/npm-cli.js') ci --omit=dev
if($LASTEXITCODE -ne 0){throw 'Dependency installation failed.'}
$env:PLAYWRIGHT_BROWSERS_PATH=Join-Path $root '.local-state/browsers'
& $node node_modules/playwright/cli.js install chromium --only-shell
if($LASTEXITCODE -ne 0){throw 'Chromium installation failed.'}
& $node scripts/check-api-browser.mjs
if($LASTEXITCODE -ne 0){throw 'Chromium runtime check failed.'}
if(-not (Test-Path (Join-Path $tools 'pgsql/bin/initdb.exe'))){throw 'Use the Windows API package with bundled PostgreSQL.'}
$argsForInit=@('scripts/server-manage.mjs','init','--ip',$PublicIPv4)
if($BackupFile){$argsForInit+='--prepare'}
& $node @argsForInit
if($LASTEXITCODE -ne 0){throw 'Initialization failed.'}
if($BackupFile){& $node scripts/server-manage.mjs restore --ip $PublicIPv4 --backup ([IO.Path]::GetFullPath($BackupFile));if($LASTEXITCODE -ne 0){throw 'Restore failed.'}}
# Keep the database outside the API task's process tree so stopping the API
# cannot terminate PostgreSQL's background processes.
$pgCtl=Join-Path $tools 'pgsql/bin/pg_ctl.exe'
& $pgCtl -D (Join-Path $data 'postgres') -m fast -w stop
if($LASTEXITCODE -ne 0){throw 'Cannot stop the initial database process.'}
& $pgCtl register -N SiteFactory-Postgres -D (Join-Path $data 'postgres') -S auto -o '-h 127.0.0.1 -p 54329'
if($LASTEXITCODE -ne 0){throw 'PostgreSQL service registration failed.'}
$baseConfig=Get-Content (Join-Path $data 'config.json') -Raw | ConvertFrom-Json
$baseConfig | Add-Member -Force -NotePropertyName databaseService -NotePropertyValue 'SiteFactory-Postgres'
[IO.File]::WriteAllText((Join-Path $data 'config.json'),($baseConfig | ConvertTo-Json -Depth 20))
# LocalService has no administrator token; grant only this installation's files.
& (Join-Path $PSScriptRoot 'grant-service-traversal.ps1') -InstallRoot $root
& icacls $root /grant '*S-1-5-19:(OI)(CI)RX' /Q | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot grant application read access.'}
& icacls $data /grant '*S-1-5-19:(OI)(CI)M' /T /Q | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot grant application data access.'}
& sc.exe config SiteFactory-Postgres obj= 'NT AUTHORITY\LocalService' password= '' | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot set database service account.'}
& sc.exe failure SiteFactory-Postgres reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null
if($LASTEXITCODE -ne 0){throw 'Cannot configure database recovery.'}
& sc.exe failureflag SiteFactory-Postgres 1 | Out-Null
Start-Service SiteFactory-Postgres
$action=New-ScheduledTaskAction -Execute $node -Argument ('"'+(Join-Path $root 'scripts/server-manage.mjs')+'" serve --log') -WorkingDirectory $root
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName SiteFactory-API -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal (New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited) -Settings $settings | Out-Null
New-NetFirewallRule -Name SiteFactory-API-9443 -DisplayName 'Site Factory API' -Direction Inbound -Protocol TCP -LocalPort 9443 -Action Allow | Out-Null
Start-ScheduledTask SiteFactory-API
$ready=$false
for($attempt=0;$attempt -lt 30;$attempt++){& $node scripts/server-manage.mjs status *> $null;if($LASTEXITCODE -eq 0){$ready=$true;break};Start-Sleep -Seconds 2}
if(-not $ready){throw 'API did not become ready. Check SiteFactory-API task and .local-state/server/server.log.'}
Write-Output ('API installed. Import '+(Join-Path $root 'site-factory.sfconnection')+' in the client.')
