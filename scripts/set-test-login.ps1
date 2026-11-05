param([Parameter(Mandatory=$true)][ValidateSet('On','Off')][string]$Mode)
$ErrorActionPreference='Stop'
$settingPath=Join-Path $PSScriptRoot '../.local-state/server/test-login.json'
$setting=Get-Content -LiteralPath $settingPath -Raw | ConvertFrom-Json
$setting.enabled=($Mode -eq 'On')
$json=$setting | ConvertTo-Json
[IO.File]::WriteAllText([IO.Path]::GetFullPath($settingPath),$json,[Text.UTF8Encoding]::new($false))
Write-Output ('Local test login: '+$Mode+'. Restart Site Factory to apply to the current window.')
