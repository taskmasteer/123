"""Exercise the actual Linux helper with isolated files and fake system commands."""
import ast, contextlib, io, json, os, pathlib, shutil, sys, tempfile, types, unittest, uuid

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'linux' / 'publish.py'

class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        self.parent = pathlib.Path(tempfile.gettempdir()).resolve()
        self.directory = pathlib.Path(tempfile.mkdtemp(prefix='sf-publish-test-', dir=self.parent)).resolve()
        self.base = self.directory / 'factory'; self.base.mkdir()
        self.nginx = self.directory / 'nginx'; self.nginx.mkdir()
        tree = ast.parse(SOURCE.read_text(encoding='utf-8'))
        tree.body = [node for node in tree.body if not isinstance(node, ast.Try)]
        sys.modules['fcntl'] = types.SimpleNamespace(flock=lambda *args: None, LOCK_EX=1)
        self.scope = {'__name__': 'fixture'}
        exec(compile(tree, str(SOURCE), 'exec'), self.scope)
        self.scope['BASE'] = self.base
        def path(value):
            if value == '/etc/nginx/conf.d': return self.nginx
            if value == '/etc/letsencrypt/live': return self.directory / 'certificates'
            raise AssertionError('Unexpected system path: ' + str(value))
        self.scope['pathlib'] = types.SimpleNamespace(Path=path, PurePosixPath=pathlib.PurePosixPath)
        self.commands = []; self.fail = False
        def run(args, timeout=60):
            self.commands.append(args)
            if self.fail:
                self.fail = False
                raise RuntimeError('simulated nginx failure')
            return ''
        self.scope['run'] = run
        self.sid = str(uuid.uuid4()); self.revisions = [str(uuid.uuid4()) for _ in range(7)]
        self.site = self.base / 'sites' / self.sid; (self.site / 'releases').mkdir(parents=True)
        for rev in self.revisions:
            (self.site / 'releases' / rev).mkdir()
            (self.site / 'releases' / rev / 'index.html').write_text(rev)
        self.config = self.nginx / ('sf-' + self.sid + '.conf'); self.config.write_text('original nginx')
        self.state = self.site / 'state.json'
        self.state.write_text(json.dumps({'siteId':self.sid,'domain':'fixture.example','ips':['203.0.113.1'],'order':1,'revisionId':self.revisions[0]}))

    def tearDown(self):
        if self.directory.parent != self.parent or not self.directory.name.startswith('sf-publish-test-'):
            raise AssertionError('Unsafe cleanup')
        shutil.rmtree(self.directory)

    def invoke(self, action, order=2, keep=None):
        payload = {'siteId':self.sid,'domain':'fixture.example','revisionId':self.revisions[-1],
                   'ips':[] if action=='remove' else ['203.0.113.1'],'order':str(order),'action':action,'keep':keep}
        previous = sys.stdin
        sys.stdin = types.SimpleNamespace(buffer=io.BytesIO(json.dumps(payload).encode()))
        try:
            with contextlib.redirect_stdout(io.StringIO()): self.scope['main']()
        finally: sys.stdin = previous

    def test_failed_removal_restores_nginx_and_preserves_fence(self):
        self.fail = True
        with self.assertRaises(RuntimeError): self.invoke('remove')
        self.assertEqual(self.config.read_text(), 'original nginx')
        self.assertEqual(json.loads(self.state.read_text())['ips'], ['203.0.113.1'])
        self.assertEqual(json.loads(self.state.read_text())['order'], 2)
        with self.assertRaisesRegex(ValueError, 'Stale'): self.invoke('remove', order=1)
        self.invoke('remove')
        self.assertFalse(self.config.exists())
        self.assertEqual(json.loads(self.state.read_text())['ips'], [])

    def test_prune_preserves_current_and_requested_versions(self):
        self.invoke('prune', keep=self.revisions[2:])
        self.assertEqual({p.name for p in (self.site/'releases').iterdir()}, set([self.revisions[0]] + self.revisions[2:]))
        self.assertEqual(self.config.read_text(), 'original nginx')
        self.assertEqual(self.commands, [])

    def test_conflicting_address_is_rejected_before_any_side_effect(self):
        other = self.base/'sites'/str(uuid.uuid4()); other.mkdir()
        (other/'state.json').write_text(json.dumps({'siteId':other.name,'ips':['203.0.113.1']}))
        with self.assertRaisesRegex(ValueError, 'another site'): self.invoke('prune', keep=[])
        self.assertEqual(json.loads(self.state.read_text())['order'], 1)

if __name__ == '__main__': unittest.main()
