param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference='Stop'
# SetFileSecurity updates this directory only. Avoid recursively rewriting the
# owner's profile when granting this non-inheritable ancestor access rule.
if(-not ('SiteFactoryDirectorySecurity' -as [type])){
 Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class SiteFactoryDirectorySecurity {
 [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 public static extern bool SetFileSecurity(string path, uint flags, byte[] descriptor);
}
'@
}
$ancestor=Split-Path ([IO.Path]::GetFullPath($InstallRoot)) -Parent
while($ancestor -and $ancestor -ne [IO.Path]::GetPathRoot($ancestor)){
 $acl=Get-Acl -LiteralPath $ancestor
 $sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-19')
 $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]::None,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
 if(-not [SiteFactoryDirectorySecurity]::SetFileSecurity($ancestor,4,$acl.GetSecurityDescriptorBinaryForm())){throw 'Cannot grant service access to installation ancestors.'}
 $ancestor=Split-Path $ancestor -Parent
}
