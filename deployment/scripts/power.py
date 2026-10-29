#!/usr/bin/env python3
"""Manual pause/resume without deleting employee data. Uses the release role."""
import json
from pathlib import Path
import sys
import time
import urllib.request
sys.path.insert(0, str(Path(__file__).resolve().parent))
import release

def capacity(function, count):
    release.aws('lambda','put-function-concurrency','--function-name',function,'--reserved-concurrent-executions',str(count))
    observed=release.aws('lambda','get-function-concurrency','--function-name',function).get('ReservedConcurrentExecutions')
    if observed!=count:
        raise RuntimeError('Concurrency update was not confirmed; inspect the AWS function before continuing')

def wait_offline(url):
    for attempt in range(30):
        try:
            with urllib.request.urlopen(url.rstrip('/')+'/?power-check='+str(attempt),timeout=15) as response:
                if b'data-app-state="off"' in response.read():return
        except OSError:
            pass
        time.sleep(3)
    raise RuntimeError('Backend is paused, but the maintenance page could not be confirmed')

def main(action=None):
    action=action or (sys.argv[1] if len(sys.argv)>1 else '')
    if action not in ('on','off','status'):
        raise ValueError('Choose on, off or status')
    function=release.env('FUNCTION_NAME')
    if action=='status':
        value=release.aws('lambda','get-function-concurrency','--function-name',function).get('ReservedConcurrentExecutions')
        print(json.dumps({'backend':'off' if value==0 else 'enabled','reservedConcurrency':value}))
        return
    # Validate all required settings before changing runtime state.
    app_id=release.env('AMPLIFY_APP_ID');url=release.env('APP_URL')
    if action=='off':
        capacity(function,0)
        # Failure here intentionally leaves the backend off and the job failed.
        release.deploy_frontend(app_id,release.ROOT/'deployment/maintenance')
        wait_offline(url)
        print('OFF: backend invocation is blocked and the maintenance page is published. Data is retained; storage/hosting/monitoring charges may remain.')
    else:
        release.env('API_URL');release.env('RELEASE_SHA')
        try:
            capacity(function,2)
            release.main()
        except BaseException:
            capacity(function,0)
            print('Resume failed; backend returned to OFF. Inspect the failed deployment before retrying.',file=sys.stderr)
            raise
        print('ON: verified backend release and application frontend are published.')

if __name__=='__main__':
    main()
