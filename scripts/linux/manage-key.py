#!/usr/bin/env python3
"""Manage only the specified automation key in the current SSH user's home."""
import fcntl, ipaddress, json, os, pathlib, re, sys, tempfile
p=json.load(sys.stdin)
if p['action'] not in ('install','remove'): raise ValueError('Invalid action')
key=p['publicKey'].split()
if len(key)<2 or key[0]!='ssh-ed25519' or not re.fullmatch(r'[A-Za-z0-9+/=]+',key[1]): raise ValueError('Invalid public key')
identifier=p['id']
if not re.fullmatch(r'[a-zA-Z0-9-]{1,100}',identifier): raise ValueError('Invalid key identifier')
directory=pathlib.Path.home()/'.ssh'
if directory.is_symlink(): raise ValueError('Unsafe SSH directory')
directory.mkdir(mode=0o700,exist_ok=True);os.chmod(directory,0o700)
path=directory/'authorized_keys'
if path.is_symlink(): raise ValueError('Unsafe authorized_keys')
with open(directory/'.site-factory-key.lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    text=path.read_text() if path.exists() else ''
    if len(text)>1000000: raise ValueError('Key file too large')
    lines=[line for line in text.splitlines() if key[1] not in line.split()]
    if p['action']=='install':
        source=str(ipaddress.ip_address(p['source']))
        lines.append('from="'+source+'",restrict '+' '.join(key[:2])+' site-factory-'+identifier)
    fd,temp=tempfile.mkstemp(prefix='.keys-',dir=directory)
    try:
        with os.fdopen(fd,'w') as f: os.fchmod(f.fileno(),0o600);f.write('\n'.join(lines)+'\n');f.flush();os.fsync(f.fileno())
        os.replace(temp,path)
    finally:
        if os.path.exists(temp): os.unlink(temp)
print(json.dumps({'ok':True}))
