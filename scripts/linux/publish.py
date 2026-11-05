#!/usr/bin/env python3
"""Root-owned deployment helper. JSON on stdin; no shell interpolation of user data."""
import base64, fcntl, hashlib, ipaddress, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time, urllib.request, uuid

BASE = pathlib.Path('/srv/site-factory')
def permitted_domain(domain):
    # The controller verifies DNS access before deployment; defense in depth here.
    return isinstance(domain,str) and len(domain)<=253 and domain!='esmartsoft.com' and not domain.endswith('.esmartsoft.com') and re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}',domain)

def run(args, timeout=60):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('Command failed: ' + args[0] + ': ' + result.stderr[-1500:])
    return result.stdout

def atomic(path, text, mode=0o644):
    tmp = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    with open(tmp, 'x', encoding='utf-8') as f:
        os.chmod(tmp, mode); f.write(text); f.flush(); os.fsync(f.fileno())
    os.replace(tmp, path)

def link(path, target):
    tmp = path.with_name(path.name + '.tmp-' + uuid.uuid4().hex)
    os.symlink(target, tmp); os.replace(tmp, path)

def config_text(site, ips, tls):
    domain, sid = site['domain'], site['siteId']
    root = BASE / 'sites' / sid / 'current'
    common = f'''server_name {domain} {' '.join(ips)};
    root {root}; index index.html; server_tokens off;
    add_header X-Content-Type-Options nosniff always;
    location = /__site_factory_release {{ default_type text/plain; alias {root}/release-id.txt; add_header Cache-Control no-store always; }}
    location ^~ /.well-known/acme-challenge/ {{ root /srv/site-factory/acme; }}
    location ~ /\\. {{ deny all; }}
    location / {{ try_files $uri $uri/ =404; }}'''
    http = 'server {\n' + ''.join(f'listen {ip}:80;\n' for ip in ips) + common + '\n}\n'
    if tls:
        cert = f'/etc/letsencrypt/live/sf-{sid}'
        http += 'server {\n' + ''.join(f'listen {ip}:443 ssl;\n' for ip in ips) + common + f'\nssl_certificate {cert}/fullchain.pem;\nssl_certificate_key {cert}/privkey.pem;\nssl_protocols TLSv1.2 TLSv1.3;\n}}\n'
    return http

def main():
    raw = sys.stdin.buffer.read(16000001)
    if len(raw) > 16000000: raise ValueError('Payload too large')
    p = json.loads(raw)
    sid = str(uuid.UUID(p['siteId'])); revision = str(uuid.UUID(p['revisionId']))
    if sid != p['siteId'] or revision != p['revisionId']: raise ValueError('Noncanonical identifiers')
    if not permitted_domain(p['domain']): raise ValueError('Domain is not permitted')
    ips = [str(ipaddress.IPv4Address(v)) for v in p['ips']]
    action = p['action']
    if action not in ('deploy','certificate','bindings','remove','prune'): raise ValueError('Invalid action')
    if (not ips and action!='remove') or len(set(ips)) != len(ips): raise ValueError('Invalid address allocation')
    order = int(p['order'])
    if order < 1: raise ValueError('Invalid operation sequence')
    BASE.mkdir(exist_ok=True)
    with open(BASE / '.publication.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        root = BASE / 'sites' / sid
        root.mkdir(parents=True, exist_ok=True)
        state_file = root / 'state.json'
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
        prior_state = dict(state)
        if state and state['domain'] != p['domain']: raise ValueError('Domain identity changed')
        if int(state.get('order', 0)) > order: raise ValueError('Stale deployment fenced')
        for file in (BASE / 'sites').glob('*/state.json'):
            other = json.loads(file.read_text())
            if other['siteId'] != sid and set(other['ips']) & set(ips): raise ValueError('Address belongs to another site')
        # Persist fencing before any side effect, including after an interrupted call.
        state.update(siteId=sid, domain=p['domain'], ips=ips, order=order)
        atomic(state_file, json.dumps(state), 0o600)
        live = root / 'current'
        nginx = pathlib.Path('/etc/nginx/conf.d') / ('sf-' + sid + '.conf')
        prior_config = nginx.read_text() if nginx.exists() else None
        prior_link = os.readlink(live) if live.is_symlink() else None
        cert = pathlib.Path('/etc/letsencrypt/live') / ('sf-' + sid) / 'fullchain.pem'
        if action in ('bindings','remove','prune'):
            if action=='prune':
                keep={str(uuid.UUID(v)) for v in p['keep']}
                keep.add(state.get('revisionId'))
                for release in (root/'releases').glob('*'):
                    if re.fullmatch(r'[a-f0-9-]{36}',release.name) and release.name not in keep and not release.is_symlink(): shutil.rmtree(release)
            else:
                try:
                    if action=='remove': nginx.unlink(missing_ok=True)
                    elif prior_link: atomic(nginx,config_text(p,ips,cert.exists()))
                    run(['nginx','-t']);run(['systemctl','reload','nginx'])
                except Exception:
                    if prior_config is not None: atomic(nginx,prior_config)
                    elif nginx.exists(): nginx.unlink()
                    prior_state['order']=order
                    atomic(state_file,json.dumps(prior_state),0o600)
                    run(['nginx','-t']);run(['systemctl','reload','nginx']);raise
                if action=='remove': state['ips']=[]
            atomic(state_file,json.dumps(state),0o600)
            print(json.dumps({'ok':True,'ips':state['ips']}));return
        if action == 'deploy':
            files = p['files']
            if not files or len(files) > 100: raise ValueError('Invalid file count')
            payload, total, names = [], 0, set()
            for item in files:
                path = item['path']
                parts = path.split('/')
                if len(path) > 240 or any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', part) or part in ('.','..') for part in parts): raise ValueError('Unsafe file path')
                if pathlib.PurePosixPath(path).suffix.lower() not in ('.html','.css','.js','.svg','.png','.jpg','.jpeg','.webp','.gif','.ico','.woff','.woff2'): raise ValueError('Non-static file')
                if path.lower() in names: raise ValueError('Duplicate path')
                names.add(path.lower())
                content = base64.b64decode(item['data'], validate=True); total += len(content)
                if len(content) > 2000000 or total > 10000000: raise ValueError('File size limit')
                if hashlib.sha256(content).hexdigest() != item['sha256']: raise ValueError('Checksum mismatch')
                payload.append((path, content))
            if 'index.html' not in names: raise ValueError('index.html required')
            releases = root / 'releases'; releases.mkdir(exist_ok=True)
            release = releases / revision
            if not release.exists():
                staging = pathlib.Path(tempfile.mkdtemp(prefix='.stage-', dir=releases))
                try:
                    for path, content in payload:
                        target = staging / path; target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_bytes(content); os.chmod(target, 0o644)
                    (staging / 'release-id.txt').write_text(revision)
                    os.chmod(staging, 0o755)
                    os.rename(staging, release)
                finally:
                    if staging.exists(): shutil.rmtree(staging)
            else:
                for path, content in payload:
                    if (release/path).read_bytes() != content: raise ValueError('Immutable release differs')
            try:
                link(live, str(release))
                atomic(nginx, config_text(p, ips, cert.exists()))
                run(['nginx','-t']); run(['systemctl','reload','nginx'])
                request = urllib.request.Request('http://' + ips[0] + '/__site_factory_release', headers={'Host':p['domain']})
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                for attempt in range(20):
                    try:
                        with opener.open(request, timeout=10) as response:
                            if response.read(100).decode() != revision: raise RuntimeError('Release health check failed')
                        break
                    except Exception:
                        if attempt == 19: raise
                        time.sleep(0.25)
            except Exception:
                if prior_link: link(live, prior_link)
                elif live.is_symlink(): live.unlink()
                if prior_config is not None: atomic(nginx, prior_config)
                elif nginx.exists(): nginx.unlink()
                run(['nginx','-t']); run(['systemctl','reload','nginx'])
                raise
            state.update(revisionId=revision)
        else:
            if state.get('revisionId') != revision: raise ValueError('Certificate request is not for the active release')
            run(['certbot','certonly','--webroot','-w','/srv/site-factory/acme','--non-interactive','--agree-tos','--register-unsafely-without-email','--cert-name','sf-'+sid,'-d',p['domain'],'--keep-until-expiring'],240)
            try:
                atomic(nginx, config_text(p, ips, True))
                run(['nginx','-t']); run(['systemctl','reload','nginx'])
            except Exception:
                if prior_config is not None: atomic(nginx, prior_config)
                run(['nginx','-t']); run(['systemctl','reload','nginx'])
                raise
        atomic(state_file, json.dumps(state), 0o600)
        print(json.dumps({'ok':True,'revisionId':revision,'tls':cert.exists(),'ips':ips}))

try: main()
except Exception as error:
    print(json.dumps({'ok':False,'error':str(error)})); sys.exit(1)
