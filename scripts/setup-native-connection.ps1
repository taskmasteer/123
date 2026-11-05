param([Parameter(Mandatory=$true)][string]$PublicIPv4,[ValidateRange(1,65535)][int]$Port=9443,[switch]$RotateCertificate,[string]$DataDirectory)
$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
if(-not [Net.IPAddress]::TryParse($PublicIPv4,[ref]([Net.IPAddress]$null)) -or $PublicIPv4.Contains(':')){throw 'Specify the assigned public IPv4.'}
$projectRoot=Split-Path $PSScriptRoot -Parent
$configPath=if($DataDirectory){Join-Path $DataDirectory 'config.json'}else{Join-Path $projectRoot '.local-state\server\config.json'}
$config=Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
Add-Type -AssemblyName System.Security
function Protect-Value([string]$value){return [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($value),$null,[Security.Cryptography.DataProtectionScope]::LocalMachine))}
if($config.tlsPfx -and $config.publicOrigin -and ([Uri]$config.publicOrigin).Host -ne $PublicIPv4 -and -not $RotateCertificate){throw 'The public IP changed. Use -RotateCertificate and distribute the new client package before switching the service.'}
if(-not $config.tlsPfx -or $RotateCertificate){
 $certificate=New-SelfSignedCertificate -Type Custom -Subject 'CN=Site Factory Application Service' -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -KeyUsage DigitalSignature,KeyEncipherment,CertSign -NotAfter (Get-Date).AddYears(2) -TextExtension @('2.5.29.19={critical}{text}ca=TRUE',('2.5.29.17={text}IPAddress='+$PublicIPv4+'&IPAddress=127.0.0.1'))
 $random=New-Object byte[] 32;[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($random)
 $password=[Convert]::ToBase64String($random)
 $pfx=$certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx,$password)
 $pem="-----BEGIN CERTIFICATE-----`n"+[Convert]::ToBase64String($certificate.RawData)+"`n-----END CERTIFICATE-----`n"
 $hash=[Security.Cryptography.SHA256]::Create().ComputeHash($certificate.RawData)
 $fingerprint=($hash|ForEach-Object {$_.ToString('X2')}) -join ':'
 $config|Add-Member -Force -NotePropertyName tlsPfx -NotePropertyValue (Protect-Value ([Convert]::ToBase64String($pfx)))
 $config|Add-Member -Force -NotePropertyName tlsPassword -NotePropertyValue (Protect-Value $password)
 $config|Add-Member -Force -NotePropertyName certificate -NotePropertyValue $pem
 $config|Add-Member -Force -NotePropertyName fingerprint -NotePropertyValue $fingerprint
 $password=$null;$pfx=$null
 Remove-Item -LiteralPath ('Cert:\CurrentUser\My\'+$certificate.Thumbprint)
}
$config|Add-Member -Force -NotePropertyName publicOrigin -NotePropertyValue ('https://'+$PublicIPv4+':'+$Port)
$config|Add-Member -Force -NotePropertyName tlsPort -NotePropertyValue $Port
[IO.File]::WriteAllText($configPath,($config|ConvertTo-Json))
$clientConfig=Join-Path $projectRoot '.local-state\client-connection.json'
[IO.File]::WriteAllText($clientConfig,(@{endpoint=$config.publicOrigin;certificate=$config.certificate;fingerprint=$config.fingerprint}|ConvertTo-Json))
Write-Output 'Encrypted service certificate and public client connection configuration prepared.'
