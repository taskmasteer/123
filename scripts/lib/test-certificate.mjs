import {spawnSync} from 'node:child_process';
import {createPrivateKey} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
export async function testCertificate(cert,key){
 if(process.platform!=='win32'){
  const result=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost'],{stdio:'ignore'});
  if(result.status!==0)throw Error('Fixture certificate generation failed');return;
 }
 // Ephemeral certificate, no writes to Windows certificate stores. Output remains
 // in this test process and is never printed to the terminal.
 const script="$ErrorActionPreference='Stop'; $r=[Security.Cryptography.RSA]::Create(2048); $q=[Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=localhost',$r,[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1); $c=$q.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-1),[DateTimeOffset]::UtcNow.AddDays(1)); $p=$r.ExportParameters($true); @{cert=[Convert]::ToBase64String($c.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)); n=[Convert]::ToBase64String($p.Modulus); e=[Convert]::ToBase64String($p.Exponent); d=[Convert]::ToBase64String($p.D); p=[Convert]::ToBase64String($p.P); q=[Convert]::ToBase64String($p.Q); dp=[Convert]::ToBase64String($p.DP); dq=[Convert]::ToBase64String($p.DQ); qi=[Convert]::ToBase64String($p.InverseQ)} | ConvertTo-Json -Compress";
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','pipe','ignore'],encoding:'utf8'});
 if(result.status!==0)throw Error('Windows fixture certificate generation failed');
 const value=JSON.parse(result.stdout),jwk={kty:'RSA'};for(const field of ['n','e','d','p','q','dp','dq','qi'])jwk[field]=Buffer.from(value[field],'base64').toString('base64url');
 await writeFile(key,createPrivateKey({format:'jwk',key:jwk}).export({format:'pem',type:'pkcs8'}),{mode:0o600});
 await writeFile(cert,'-----BEGIN CERTIFICATE-----\n'+value.cert.match(/.{1,64}/g).join('\n')+'\n-----END CERTIFICATE-----\n',{mode:0o600});
}
