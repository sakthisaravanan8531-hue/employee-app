#!/usr/bin/env python3
"""Immutable ASG release followed by Amplify manual hosting deployment.
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
    result = subprocess.run(['aws', *args, '--output', 'json', '--no-cli-pager'], check=True, capture_output=True, text=True)
    return json.loads(result.stdout) if result.stdout.strip() else {}

def env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f'Missing deployment variable: {name}')
    return value

def wait_refresh(group, refresh_id):
    deadline = time.monotonic() + 2400
    while time.monotonic() < deadline:
        refresh = aws('autoscaling', 'describe-instance-refreshes', '--auto-scaling-group-name', group, '--instance-refresh-ids', refresh_id)['InstanceRefreshes'][0]
        status = refresh['Status']
        print(f'Instance refresh: {status}, {refresh.get("PercentageComplete", 0)}%', flush=True)
        if status == 'Successful':
            return
        if status in ('Failed', 'Cancelled', 'RollbackFailed', 'RollbackSuccessful'):
            raise RuntimeError(f'Instance refresh ended: {status}: {refresh.get("StatusReason", "")}')
        time.sleep(20)
    raise TimeoutError('Instance refresh exceeded 40 minutes')

def refresh(group):
    result = aws('autoscaling', 'start-instance-refresh', '--auto-scaling-group-name', group,
                 '--preferences', json.dumps({'MinHealthyPercentage': 100, 'MaxHealthyPercentage': 150, 'InstanceWarmup': 180, 'SkipMatching': False}))
    wait_refresh(group, result['InstanceRefreshId'])

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
    bucket, group, parameter = env('ARTIFACT_BUCKET'), env('ASG_NAME'), env('RELEASE_PARAMETER')
    api_url, app_url, app_id = env('API_URL'), env('APP_URL'), env('AMPLIFY_APP_ID')
    previous = aws('ssm', 'get-parameter', '--name', parameter)['Parameter']['Value']
    active = aws('autoscaling', 'describe-instance-refreshes', '--auto-scaling-group-name', group)['InstanceRefreshes']
    if any(r['Status'] in ('Pending','InProgress','Cancelling','Baking','RollbackInProgress') for r in active):
        raise RuntimeError('Another instance refresh is active; finish or cancel it before deployment')
    dist = ROOT / 'frontend/dist'
    if not (dist / 'index.html').is_file():
        raise RuntimeError('Build the frontend before deployment')
    with tempfile.TemporaryDirectory() as temp:
        bundle = Path(temp) / 'backend.zip'
        with zipfile.ZipFile(bundle, 'w', zipfile.ZIP_DEFLATED) as archive:
            for name in ['package.json', 'package-lock.json']:
                archive.write(ROOT / 'backend' / name, name)
            for file in (ROOT / 'backend/src').rglob('*.js'):
                archive.write(file, file.relative_to(ROOT / 'backend'))
            archive.writestr('VERSION', sha + '\n')
        key = f'backend/{sha}.zip'
        aws('s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', str(bundle), '--server-side-encryption', 'AES256')
    aws('ssm', 'put-parameter', '--name', parameter, '--type', 'String', '--value', f'{bucket}/{key}', '--overwrite')
    try:
        refresh(group)
        health(api_url, sha)
    except Exception:
        print('Backend release failed. Restoring previous release pointer.', flush=True)
        aws('ssm', 'put-parameter', '--name', parameter, '--type', 'String', '--value', previous, '--overwrite')
        current = aws('autoscaling', 'describe-instance-refreshes', '--auto-scaling-group-name', group)['InstanceRefreshes']
        if any(r['Status'] in ('Pending','InProgress','Baking') for r in current):
            aws('autoscaling', 'cancel-instance-refresh', '--auto-scaling-group-name', group)
            for _ in range(30):
                current = aws('autoscaling', 'describe-instance-refreshes', '--auto-scaling-group-name', group)['InstanceRefreshes']
                if not any(r['Status'] in ('Pending','InProgress','Cancelling','Baking') for r in current):
                    break
                time.sleep(10)
        refresh(group)
        health(api_url)
        raise
    # Frontend failures leave the verified backend in place; redeploy a known-good
    # commit to restore frontend compatibility. Schema changes must be additive.
    deploy_frontend(app_id, dist)
    health(app_url, sha)
    with urllib.request.urlopen(app_url, timeout=30) as response:
        if b'<div id="root"></div>' not in response.read():
            raise RuntimeError('Amplify root did not return the React application')
    print('Deployment completed; backend and Amplify routing passed health checks.')

if __name__ == '__main__':
    main()
