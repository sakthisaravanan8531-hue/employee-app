import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('oidc',Path(__file__).parents[1]/'scripts/oidc-diagnostics.py')
oidc=importlib.util.module_from_spec(spec);spec.loader.exec_module(oidc)

def jwt(payload):return 'header.'+base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip('=')+'.signature'

class OidcTests(unittest.TestCase):
    def test_only_non_secret_claims_are_selected(self):
        token=jwt({'iss':'https://token.actions.githubusercontent.com','aud':'sts.amazonaws.com','sub':'repo:owner/repo:environment:production','repository':'owner/repo','unrelated_secret':'DO-NOT-LOG'})
        result=oidc.safe_claims(token)
        self.assertEqual(result['aud'],'sts.amazonaws.com');self.assertNotIn('DO-NOT-LOG',json.dumps(result));self.assertNotIn(token,json.dumps(result))
    def test_malformed_token_does_not_appear_in_error(self):
        secret='sensitive-bad-token'
        with self.assertRaisesRegex(RuntimeError,'metadata could not be decoded') as error:oidc.safe_claims(secret)
        self.assertNotIn(secret,str(error.exception))
    def test_request_credentials_and_token_are_not_logged(self):
        token=jwt({'sub':'repo:owner/repo:environment:production','aud':'sts.amazonaws.com'})
        output=io.StringIO()
        with patch.dict(os.environ,{'ACTIONS_ID_TOKEN_REQUEST_URL':'https://example.test/token?api=1','ACTIONS_ID_TOKEN_REQUEST_TOKEN':'secret-request-credential'}),patch.object(oidc.urllib.request,'urlopen') as urlopen,contextlib.redirect_stdout(output):
            urlopen.return_value.__enter__.return_value=io.StringIO(json.dumps({'value':token}))
            oidc.main()
        logged=output.getvalue();self.assertNotIn(token,logged);self.assertNotIn('secret-request-credential',logged);self.assertIn('expectedSubject',logged)
        self.assertIn('audience=sts.amazonaws.com',urlopen.call_args.args[0].full_url)
