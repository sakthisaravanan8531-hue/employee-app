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
        (self.root / '.local/lambda').mkdir(parents=True)
        (self.root / 'frontend/dist').mkdir(parents=True)
        self.sha = 'a' * 40
        (self.root / '.local/lambda/index.js').write_text('// bundled fixture')
        (self.root / '.local/lambda/VERSION').write_text(self.sha)
        (self.root / 'frontend/dist/index.html').write_text('<div id="root"></div>')
        self.environment = patch.dict(os.environ, {'RELEASE_SHA':self.sha,'FUNCTION_NAME':'employee-api','API_URL':'https://api.example.test','APP_URL':'https://app.example.test','AMPLIFY_APP_ID':'test-app'})
        self.environment.start()
        self.root_patch = patch.object(release,'ROOT',self.root); self.root_patch.start()
        self.commands=[]
    def tearDown(self):
        self.root_patch.stop();self.environment.stop();self.temp.cleanup()
    def fake_aws(self,*args):
        self.commands.append(args)
        if args[:2]==('lambda','get-alias'):
            return {'FunctionVersion':'1','RevisionId':'old-revision'}
        if args[:2]==('lambda','publish-version'):
            return {'Version':'2'}
        if args[:2]==('lambda','update-alias'):
            return {'RevisionId':'updated-revision'}
        if args[:2]==('lambda','update-function-code'):
            file=Path(args[args.index('--zip-file')+1].removeprefix('fileb://'))
            with zipfile.ZipFile(file) as bundle:
                self.assertEqual(bundle.read('VERSION').decode().strip(),self.sha)
                self.assertEqual(set(bundle.namelist()),{'index.js','VERSION'})
        return {}
    def test_success_publishes_exact_commit_and_frontend_after_health(self):
        events=[]
        with patch.object(release,'aws',side_effect=self.fake_aws),patch.object(release,'health',side_effect=lambda *args:events.append('health')),patch.object(release,'deploy_frontend',side_effect=lambda *args:events.append('frontend')),patch.object(release.urllib.request,'urlopen') as request:
            request.return_value.__enter__.return_value.read.return_value=b'<div id="root"></div>'
            release.main()
        self.assertEqual(events,['health','frontend','health'])
        writes=[c for c in self.commands if c[:2]==('lambda','update-alias')]
        self.assertEqual(writes[0][writes[0].index('--function-version')+1],'2')
        self.assertEqual(writes[0][writes[0].index('--revision-id')+1],'old-revision')
    def test_failed_backend_restores_alias_and_fails(self):
        with patch.object(release,'aws',side_effect=self.fake_aws),patch.object(release,'health',side_effect=[RuntimeError('unhealthy'),None]) as health,patch.object(release,'deploy_frontend') as frontend:
            with self.assertRaisesRegex(RuntimeError,'unhealthy'):release.main()
        writes=[c for c in self.commands if c[:2]==('lambda','update-alias')]
        self.assertEqual(writes[-1][writes[-1].index('--function-version')+1],'1')
        self.assertEqual(writes[-1][writes[-1].index('--revision-id')+1],'updated-revision')
        self.assertEqual(health.call_count,2);frontend.assert_not_called()
    def test_wrong_backend_version_blocks_release(self):
        (self.root/'.local/lambda/VERSION').write_text('wrong')
        with patch.object(release,'aws',side_effect=self.fake_aws):
            with self.assertRaisesRegex(RuntimeError,'Build the backend'):release.main()
        self.assertFalse(self.commands)
    def test_missing_frontend_build_blocks_alias_change(self):
        (self.root/'frontend/dist/index.html').unlink()
        with patch.object(release,'aws',side_effect=self.fake_aws):
            with self.assertRaisesRegex(RuntimeError,'Build the frontend'):release.main()
        self.assertFalse(any(c[:2]==('lambda','update-alias') for c in self.commands))
    def test_untrusted_commit_string_is_rejected_before_aws_calls(self):
        with patch.dict(os.environ,{'RELEASE_SHA':'main; something'}),patch.object(release,'aws') as aws:
            with self.assertRaisesRegex(RuntimeError,'full Git commit SHA'):release.main()
            aws.assert_not_called()
    def test_failed_publish_never_moves_live_alias(self):
        def failure(*args):
            if args[:2]==('lambda','publish-version'):raise RuntimeError('publish failed')
            return self.fake_aws(*args)
        with patch.object(release,'aws',side_effect=failure):
            with self.assertRaisesRegex(RuntimeError,'publish failed'):release.main()
        self.assertFalse(any(c[:2]==('lambda','update-alias') for c in self.commands))

if __name__=='__main__':unittest.main()
