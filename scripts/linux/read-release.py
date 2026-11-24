"""Read one pinned release for recovery; never changes the live host."""
import base64, json, pathlib, re, sys
p = json.load(sys.stdin)
for key in ('siteId', 'revisionId'):
    if not re.fullmatch(r'[a-f0-9-]{36}', p[key]): raise ValueError('Invalid release identity')
domain = p['domain']
if domain == 'esmartsoft.com' or domain.endswith('.esmartsoft.com'): raise ValueError('Protected domain')
site = pathlib.Path('/srv/site-factory/sites') / p['siteId']
if any(path.is_symlink() for path in [site, site / 'releases', site / 'state.json']): raise ValueError('Invalid site directory')
state = json.loads((site / 'state.json').read_text())
if state['domain'] != domain or state['revisionId'] != p['revisionId']: raise ValueError('Remote release changed')
root = site / 'releases' / p['revisionId']
if root.is_symlink() or not root.is_dir(): raise ValueError('Invalid release directory')
files, total = [], 0
for path in sorted(root.rglob('*')):
    if path.is_symlink(): raise ValueError('Release contains a symlink')
    if path.is_dir(): continue
    name = path.relative_to(root).as_posix()
    if name == 'release-id.txt': continue
    if not path.is_file() or path.stat().st_size > 2000000: raise ValueError('Invalid release file')
    data = path.read_bytes(); total += len(data)
    if total > 10000000 or len(files) >= 100: raise ValueError('Release exceeds limits')
    files.append({'path': name, 'data': base64.b64encode(data).decode()})
if json.loads((site / 'state.json').read_text()) != state: raise ValueError('Remote release changed')
print(json.dumps(files))
