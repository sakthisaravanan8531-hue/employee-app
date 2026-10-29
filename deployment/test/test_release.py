import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('release', Path(__file__).parents[1] / 'scripts/release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'backend/src').mkdir(parents=True)
        (self.root / 'frontend/dist').mkdir(parents=True)
        for name in ['package.json', 'package-lock.json']:
            (self.root / 'backend' / name).write_text('{}')
        (self.root / 'backend/src/server.js').write_text('// fixture')
        (self.root / 'frontend/dist/index.html').write_text('<div id="root"></div>')
        self.sha = 'a' * 40
        self.environment = patch.dict(os.environ, {'RELEASE_SHA':self.sha,'ARTIFACT_BUCKET':'artifacts','ASG_NAME':'fleet','RELEASE_PARAMETER':'/employee/release','API_URL':'https://api.example.test','APP_URL':'https://app.example.test','AMPLIFY_APP_ID':'test-app'})
        self.environment.start()
        self.root_patch = patch.object(release,'ROOT',self.root); self.root_patch.start()
        self.commands=[]
    def tearDown(self):
        self.root_patch.stop();self.environment.stop();self.temp.cleanup()
    def fake_aws(self,*args):
        self.commands.append(args)
        if args[:2]==('ssm','get-parameter'):
            return {'Parameter':{'Value':'old-bucket/old.zip'}}
        if args[:2]==('autoscaling','describe-instance-refreshes'):
            return {'InstanceRefreshes':[]}
        if args[:2]==('s3api','put-object'):
            file=Path(args[args.index('--body')+1])
            with zipfile.ZipFile(file) as bundle:
                self.assertEqual(bundle.read('VERSION').decode().strip(),self.sha)
                self.assertEqual(set(bundle.namelist()),{'package.json','package-lock.json','src/server.js','VERSION'})
        return {}
    def test_success_publishes_exact_commit_and_frontend_after_health(self):
        events=[]
        with patch.object(release,'aws',side_effect=self.fake_aws),patch.object(release,'refresh',side_effect=lambda group:events.append('refresh')),patch.object(release,'health',side_effect=lambda *args:events.append('health')),patch.object(release,'deploy_frontend',side_effect=lambda *args:events.append('frontend')),patch.object(release.urllib.request,'urlopen') as request:
            request.return_value.__enter__.return_value.read.return_value=b'<div id="root"></div>'
            release.main()
        self.assertEqual(events,['refresh','health','frontend','health'])
        writes=[c for c in self.commands if c[:2]==('ssm','put-parameter')]
        self.assertEqual(writes[0][writes[0].index('--value')+1],f'artifacts/backend/{self.sha}.zip')
    def test_failed_backend_restores_pointer_refreshes_previous_and_fails(self):
        with patch.object(release,'aws',side_effect=self.fake_aws),patch.object(release,'refresh',side_effect=[RuntimeError('unhealthy'),None]) as refresh,patch.object(release,'health') as health,patch.object(release,'deploy_frontend') as frontend:
            with self.assertRaisesRegex(RuntimeError,'unhealthy'):release.main()
        writes=[c for c in self.commands if c[:2]==('ssm','put-parameter')]
        self.assertEqual(writes[-1][writes[-1].index('--value')+1],'old-bucket/old.zip')
        self.assertEqual(refresh.call_count,2);health.assert_called_once_with('https://api.example.test');frontend.assert_not_called()
    def test_existing_refresh_blocks_changes(self):
        def active(*args):
            if args[:2]==('autoscaling','describe-instance-refreshes'):return {'InstanceRefreshes':[{'Status':'InProgress'}]}
            return self.fake_aws(*args)
        with patch.object(release,'aws',side_effect=active):
            with self.assertRaisesRegex(RuntimeError,'Another instance refresh'):release.main()
        self.assertFalse(any(c[:2]==('ssm','put-parameter') for c in self.commands))
    def test_missing_frontend_build_blocks_release_pointer_change(self):
        (self.root/'frontend/dist/index.html').unlink()
        with patch.object(release,'aws',side_effect=self.fake_aws):
            with self.assertRaisesRegex(RuntimeError,'Build the frontend'):release.main()
        self.assertFalse(any(c[:2]==('ssm','put-parameter') for c in self.commands))
    def test_untrusted_commit_string_is_rejected_before_aws_calls(self):
        with patch.dict(os.environ,{'RELEASE_SHA':'main; something'}),patch.object(release,'aws') as aws:
            with self.assertRaisesRegex(RuntimeError,'full Git commit SHA'):release.main()
            aws.assert_not_called()
    def test_failed_refresh_is_not_reported_successful(self):
        with patch.object(release,'aws',return_value={'InstanceRefreshes':[{'Status':'Failed','StatusReason':'unhealthy'}]}):
            with self.assertRaisesRegex(RuntimeError,'unhealthy'):release.wait_refresh('fleet','refresh-1')

if __name__=='__main__':unittest.main()
