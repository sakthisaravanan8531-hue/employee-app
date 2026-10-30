#!/usr/bin/env python3
"""Versioned Lambda release followed by Amplify manual hosting deployment.
Uses the AWS CLI credential chain (OIDC in GitHub Actions). Never logs signed URLs.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]

def aws(*args):
    try:
        result = subprocess.run(['aws', *args, '--output', 'json', '--no-cli-pager'], check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as error:
        # Successful Amplify responses contain signed URLs: never dump stdout.
        # Surface only AWS's service error, with URL query strings/tokens removed.
        match = re.search(r'An error occurred \([^\n]+', error.stderr or '')
        detail = match.group(0) if match else 'AWS CLI failed; inspect the operation with an authorized operator session.'
        detail = re.sub(r'(https?://[^\s?]+)\?[^\s]+', r'\1?[redacted]', detail)
        detail = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[redacted token]', detail)
        detail = re.sub(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b', '[redacted access key]', detail)
        raise RuntimeError(f'AWS {args[0]} {args[1]} failed (exit {error.returncode}): {detail[:4000]}') from None
    return json.loads(result.stdout) if result.stdout.strip() else {}

def env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f'Missing deployment variable: {name}')
    return value

def health(url, version=None):
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url.rstrip('/') + '/api/health', timeout=15) as response:
                value = json.load(response)
                if value.get('status') == 'ok' and (not version or value.get('version') == version):
                    return
        except (OSError, ValueError):
            pass
        time.sleep(5)
    raise RuntimeError('API health or expected release version check failed')

def deploy_frontend(app_id, dist):
    with tempfile.TemporaryDirectory() as temp:
        bundle = Path(temp) / 'frontend.zip'
        with zipfile.ZipFile(bundle, 'w', zipfile.ZIP_DEFLATED) as archive:
            for file in dist.rglob('*'):
                if file.is_file():
                    archive.write(file, file.relative_to(dist))
        deployment = aws('amplify', 'create-deployment', '--app-id', app_id, '--branch-name', 'main')
        request = urllib.request.Request(deployment['zipUploadUrl'], data=bundle.read_bytes(), method='PUT', headers={'Content-Type': 'application/zip'})
        with urllib.request.urlopen(request, timeout=180) as response:
            if response.status not in (200, 201):
                raise RuntimeError('Amplify bundle upload failed')
        job_id = deployment['jobId']
        aws('amplify', 'start-deployment', '--app-id', app_id, '--branch-name', 'main', '--job-id', job_id)
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            status = aws('amplify', 'get-job', '--app-id', app_id, '--branch-name', 'main', '--job-id', job_id)['job']['summary']['status']
            print(f'Amplify deployment: {status}', flush=True)
            if status == 'SUCCEED':
                return
            if status in ('FAILED', 'CANCELLED'):
                raise RuntimeError(f'Amplify deployment ended: {status}')
            time.sleep(10)
        raise TimeoutError('Amplify deployment exceeded 15 minutes')

def main():
    sha = env('RELEASE_SHA')
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise RuntimeError('RELEASE_SHA must be a full Git commit SHA')
    function = env('FUNCTION_NAME')
    api_url, app_url, app_id = env('API_URL'), env('APP_URL'), env('AMPLIFY_APP_ID')
    dist = ROOT / 'frontend/dist'
    backend = ROOT / '.local/lambda'
    if not (dist / 'index.html').is_file():
        raise RuntimeError('Build the frontend before deployment')
    if not (backend / 'index.js').is_file() or (backend / 'VERSION').read_text().strip() != sha:
        raise RuntimeError('Build the backend for RELEASE_SHA before deployment')
    if aws('lambda','get-function-concurrency','--function-name',function).get('ReservedConcurrentExecutions') == 0:
        print('Application is OFF; automatic deployment skipped. Use Application ON or OFF to resume.')
        return
    previous = aws('lambda', 'get-alias', '--function-name', function, '--name', 'live')
    # Guard alias movement with RevisionId. Never overwrite a concurrent rollout.
    with tempfile.TemporaryDirectory() as temp:
        bundle = Path(temp) / 'backend.zip'
        with zipfile.ZipFile(bundle, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name in ['index.js', 'VERSION']:
                archive.write(backend / name, name)
        aws('lambda', 'update-function-code', '--function-name', function, '--zip-file', 'fileb://' + str(bundle))
    aws('lambda', 'wait', 'function-updated-v2', '--function-name', function)
    published = aws('lambda', 'publish-version', '--function-name', function, '--description', sha)
    updated = aws('lambda', 'update-alias', '--function-name', function, '--name', 'live', '--function-version', published['Version'], '--revision-id', previous['RevisionId'])
    try:
        health(api_url, sha)
    except Exception:
        print('Health failed; restoring previous Lambda alias.', flush=True)
        aws('lambda', 'update-alias', '--function-name', function, '--name', 'live', '--function-version', previous['FunctionVersion'], '--revision-id', updated['RevisionId'])
        health(api_url)
        raise
    # Frontend failures leave the verified backend in place; redeploy a known-good
    # commit to restore frontend compatibility. Data changes must remain backward-compatible.
    deploy_frontend(app_id, dist)
    health(app_url, sha)
    with urllib.request.urlopen(app_url, timeout=30) as response:
        if b'<div id="root"></div>' not in response.read():
            raise RuntimeError('Amplify root did not return the React application')
    print('Deployment completed; backend and Amplify routing passed health checks.')

if __name__ == '__main__':
    main()
