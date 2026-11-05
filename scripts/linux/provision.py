#!/usr/bin/env python3
"""Idempotent fresh Ubuntu/Debian provisioning; credentials never enter this helper."""
import base64, fcntl, fnmatch, hashlib, ipaddress, json, os, pathlib, re, shlex, subprocess, sys, time

def run(args, timeout=120):
    p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout,env={**os.environ,'DEBIAN_FRONTEND':'noninteractive','NEEDRESTART_MODE':'l'})
    if p.returncode: raise RuntimeError('Failed: '+args[0]+': '+p.stderr[-1200:])
    return p.stdout

def write(path,text,mode=0o600):
    path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.site-factory-tmp');temp.write_text(text);os.chmod(temp,mode);os.replace(temp,path)

def os_info():
    return dict(line.split('=',1) for line in pathlib.Path('/etc/os-release').read_text().replace('"','').splitlines() if '=' in line)

def interfaces(): return json.loads(run(['ip','-j','address','show']))

def main():
    p=json.load(sys.stdin);action=p['action'];identifier=p['id']
    if not re.fullmatch('[a-zA-Z0-9-]{1,64}',identifier): raise ValueError('Invalid host identifier')
    primary=str(ipaddress.IPv4Address(p['host']));extra=[str(ipaddress.IPv4Address(v)) for v in p['additionalIPv4']]
    backup=pathlib.Path('/var/backups/site-factory/provision-'+identifier);backup.mkdir(parents=True,exist_ok=True);os.chmod(backup,0o700)
    os.umask(0o022)
    if os.geteuid()!=0: raise ValueError('Root or passwordless sudo is required')
    with open('/run/site-factory-provision.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if action=='inspect':
            info=os_info();version=int(info.get('VERSION_ID','0').split('.')[0])
            if not (info.get('ID')=='ubuntu' and version>=22 or info.get('ID')=='debian' and version>=12): raise ValueError('Supported: Ubuntu 22.04+ or Debian 12+')
            if pathlib.Path('/proc/1/comm').read_text().strip()!='systemd': raise ValueError('A systemd VPS is required')
            managed=pathlib.Path('/usr/local/lib/site-factory/publish.py').exists()
            # Refuse to adopt arbitrary pre-existing web configurations.
            for directory in ['/etc/nginx/sites-enabled','/etc/nginx/conf.d']:
                for file in pathlib.Path(directory).glob('*'):
                    if not (managed and (file.name=='site-factory-default' or re.fullmatch(r'sf-[a-f0-9-]{36}\.conf',file.name))): raise ValueError('Existing Nginx site detected; use an empty VPS')
            listeners=run(['ss','-lntp'])
            if re.search(r':(?:80|443)\s',listeners) and not managed: raise ValueError('Ports 80/443 are already used; use an empty VPS')
            addresses=interfaces();device=next((item['ifname'] for item in addresses if any(a.get('local')==primary for a in item.get('addr_info',[]))),None)
            if not device: raise ValueError('The public management IPv4 is not configured inside the VPS; NAT hosts need a separate network profile')
            if extra and not pathlib.Path('/usr/sbin/netplan').exists() and not pathlib.Path('/usr/bin/netplan').exists():
                existing={a.get('local') for item in addresses for a in item.get('addr_info',[])}
                if not set(extra)<=existing: raise ValueError('Additional /32 setup requires Netplan; preconfigure addresses on this OS first')
            return {'os':info.get('PRETTY_NAME'), 'interface':device,'addresses':[a.get('local') for item in addresses for a in item.get('addr_info',[]) if a.get('family')=='inet'],'managed':managed}
        if action=='packages':
            run(['apt-get','update','-qq'],300);run(['apt-get','install','-y','--no-install-recommends','nginx','ufw','certbot'],600)
            for path in ['/srv/site-factory/sites','/srv/site-factory/acme','/usr/local/lib/site-factory','/etc/letsencrypt/renewal-hooks/deploy']:pathlib.Path(path).mkdir(parents=True,exist_ok=True)
            publisher=base64.b64decode(p['publisher'],validate=True)
            if hashlib.sha256(publisher).hexdigest()!=p['publisherHash']:raise ValueError('Publisher checksum differs')
            write('/usr/local/lib/site-factory/publish.py',publisher.decode(),0o644)
            default=pathlib.Path('/etc/nginx/sites-enabled/default')
            if default.is_symlink() and default.resolve()==pathlib.Path('/etc/nginx/sites-available/default'):default.unlink()
            write('/etc/nginx/sites-available/site-factory-default','server { listen 80 default_server; listen [::]:80 default_server; server_name _; server_tokens off; location / { return 404; } }\n',0o644)
            enabled=pathlib.Path('/etc/nginx/sites-enabled/site-factory-default')
            if not enabled.exists():enabled.symlink_to('/etc/nginx/sites-available/site-factory-default')
            write('/etc/letsencrypt/renewal-hooks/deploy/site-factory-nginx','#!/bin/sh\nnginx -t && systemctl reload nginx\n',0o755)
            run(['nginx','-t']);run(['systemctl','enable','--now','nginx','certbot.timer']);run(['systemctl','reload','nginx'])
            return {'installed':True}
        if action=='network':
            addresses=interfaces();existing={a.get('local') for item in addresses for a in item.get('addr_info',[])}
            if set(extra)<=existing:return {'rollback':None}
            interface=next(item['ifname'] for item in addresses if any(a.get('local')==primary for a in item.get('addr_info',[])))
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,15}',interface):raise ValueError('Unexpected interface name')
            import yaml
            # Cloud images may use a logical Netplan ID with match/set-name.
            merged=yaml.safe_load(run(['netplan','get'])) or {}
            devices=merged.get('network',{}).get('ethernets',{})
            mac=next(item.get('address','').lower() for item in addresses if item['ifname']==interface)
            candidates=[name for name,value in devices.items() if name==interface or value.get('set-name')==interface or fnmatch.fnmatch(interface,value.get('match',{}).get('name','!')) or value.get('match',{}).get('macaddress','!').lower()==mac]
            if len(candidates)!=1:raise ValueError('Cannot safely identify the Netplan interface; configure additional IPv4 manually')
            device_id=candidates[0]
            target=pathlib.Path('/etc/netplan/60-site-factory-ipv4.yaml');saved=backup/'netplan.yaml'
            prior=target.read_text() if target.exists() else None
            current=yaml.safe_load(prior) if prior else {'network':{'version':2,'ethernets':{}}}
            device=current['network']['ethernets'].setdefault(device_id,{})
            device['addresses']=list(dict.fromkeys(device.get('addresses',[])+[v+'/32' for v in extra]))
            if prior is not None:write(saved,prior)
            rollback=backup/'network-rollback.sh'
            restore=f'cp {shlex.quote(str(saved))} {target}' if prior is not None else f'rm -f {target}'
            write(rollback,'#!/bin/sh\numask 022\n'+restore+'\nnetplan apply\n',0o700)
            write(target,yaml.safe_dump(current,sort_keys=False));
            try:run(['netplan','generate'])
            except Exception:
                if prior is None:target.unlink(missing_ok=True)
                else:write(target,prior)
                raise
            unit='sf-net-'+identifier
            run(['systemd-run','--quiet','--unit='+unit,'--on-active=180','/bin/sh',str(rollback)])
            run(['netplan','apply'])
            return {'rollback':unit}
        if action=='firewall':
            port=int(p['port']);local=int(p.get('localPort',port))
            if not 1<=port<=65535 or not 1<=local<=65535:raise ValueError('Invalid SSH port')
            active='Status: active' in run(['ufw','status'])
            run(['tar','-C','/etc','-czf',str(backup/'ufw.tar.gz'),'ufw'])
            rollback=backup/'firewall-rollback.sh'
            restore=f"tar -C /etc -xzf {backup/'ufw.tar.gz'}\n"+('ufw reload\n' if active else 'ufw --force disable\n')
            write(rollback,'#!/bin/sh\n'+restore,0o700)
            unit='sf-fw-'+identifier
            run(['systemd-run','--quiet','--unit='+unit,'--on-active=180','/bin/sh',str(rollback)])
            for value in sorted(set([port,local,80,443])):run(['ufw','allow',str(value)+'/tcp'])
            run(['ufw','--force','enable'])
            return {'rollback':unit}
        if action in ('confirm-network','confirm-firewall','recover-network','recover-firewall','rollback-network','rollback-firewall'):
            suffix='network' if action.endswith('network') else 'firewall';unit=('sf-net-' if suffix=='network' else 'sf-fw-')+identifier
            rollback=backup/(suffix+'-rollback.sh')
            if not rollback.exists():return {'confirmed':True}
            subprocess.run(['systemctl','stop',unit+'.timer',unit+'.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if action.startswith(('rollback','recover')):run(['/bin/sh',str(rollback)])
            rollback.unlink(missing_ok=True)
            run(['systemctl','reset-failed',unit+'.service'],30) if subprocess.run(['systemctl','is-failed',unit+'.service'],stdout=subprocess.DEVNULL).returncode==0 else None
            return {'confirmed':True}
        if action=='verify':
            run(['nginx','-t']);run(['systemctl','is-active','nginx','certbot.timer'])
            current={a.get('local') for item in interfaces() for a in item.get('addr_info',[])}
            if not {primary,*extra}<=current:raise ValueError('Some IPv4 addresses are not configured')
            return {'ready':True,'addresses':[primary,*extra],'firewall':run(['ufw','status']),'nginx':run(['nginx','-V'])}
        raise ValueError('Unknown operation')

try: print(json.dumps({'ok':True,**main()}))
except Exception as error: print(json.dumps({'ok':False,'error':str(error)}));sys.exit(1)
