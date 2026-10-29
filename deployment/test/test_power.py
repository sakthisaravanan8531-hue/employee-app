import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('power',Path(__file__).parents[1]/'scripts/power.py')
power=importlib.util.module_from_spec(spec)
spec.loader.exec_module(power)

class PowerTests(unittest.TestCase):
    def setUp(self):
        self.env=patch.dict(os.environ,{'FUNCTION_NAME':'app','AMPLIFY_APP_ID':'frontend','APP_URL':'https://app.example.test','API_URL':'https://api.example.test','RELEASE_SHA':'a'*40})
        self.env.start();self.capacity=2;self.commands=[]
    def tearDown(self):self.env.stop()
    def aws(self,*args):
        self.commands.append(args)
        if args[:2]==('lambda','put-function-concurrency'):
            self.capacity=int(args[-1]);return {}
        return {'ReservedConcurrentExecutions':self.capacity}
    def test_off_blocks_backend_before_publishing_maintenance(self):
        def publish(*args):self.assertEqual(self.capacity,0)
        with patch.object(power.release,'aws',side_effect=self.aws),patch.object(power.release,'deploy_frontend',side_effect=publish) as deploy,patch.object(power,'wait_offline') as wait:
            power.main('off')
        self.assertEqual(self.capacity,0);deploy.assert_called_once();wait.assert_called_once()
    def test_failed_maintenance_upload_leaves_backend_off_and_fails(self):
        with patch.object(power.release,'aws',side_effect=self.aws),patch.object(power.release,'deploy_frontend',side_effect=RuntimeError('upload failed')):
            with self.assertRaisesRegex(RuntimeError,'upload failed'):power.main('off')
        self.assertEqual(self.capacity,0)
    def test_on_enables_capacity_and_runs_verified_release(self):
        self.capacity=0
        with patch.object(power.release,'aws',side_effect=self.aws),patch.object(power.release,'main') as deploy:
            power.main('on')
        self.assertEqual(self.capacity,2);deploy.assert_called_once()
    def test_failed_resume_returns_to_off(self):
        with patch.object(power.release,'aws',side_effect=self.aws),patch.object(power.release,'main',side_effect=RuntimeError('health failed')):
            with self.assertRaisesRegex(RuntimeError,'health failed'):power.main('on')
        self.assertEqual(self.capacity,0)
    def test_status_does_not_modify_aws(self):
        with patch.object(power.release,'aws',side_effect=self.aws):power.main('status')
        self.assertEqual(len(self.commands),1);self.assertEqual(self.commands[0][1],'get-function-concurrency')
    def test_missing_setting_prevents_partial_state_change(self):
        with patch.dict(os.environ,{'APP_URL':''}),patch.object(power.release,'aws',side_effect=self.aws):
            with self.assertRaisesRegex(RuntimeError,'APP_URL'):power.main('off')
        self.assertFalse(self.commands)
    def test_unconfirmed_capacity_change_stops_before_publication(self):
        with patch.object(power.release,'aws',return_value={'ReservedConcurrentExecutions':2}),patch.object(power.release,'deploy_frontend') as deploy:
            with self.assertRaisesRegex(RuntimeError,'not confirmed'):power.main('off')
        deploy.assert_not_called()
