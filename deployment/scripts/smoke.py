#!/usr/bin/env python3
"""Authenticated live CRUD check. Credentials come from process variables, never logs."""
import http.cookiejar
import json
import os
import urllib.request
import uuid

def main():
    base=os.environ['APP_URL'].rstrip('/')
    opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(method,path,data=None):
        request=urllib.request.Request(base+path, data=json.dumps(data).encode() if data is not None else (b'{}' if method=='DELETE' else None), method=method, headers={'Content-Type':'application/json'})
        with opener.open(request,timeout=30) as response:
            return json.load(response) if response.status!=204 else None
    call('POST','/api/login',{'username':os.environ.get('ADMIN_USERNAME','admin'),'password':os.environ['ADMIN_PASSWORD']})
    record={'name':'Deployment smoke test','email':f'smoke-{uuid.uuid4()}@example.test','department':'Validation','title':'Temporary record'}
    created=call('POST','/api/employees',record)
    try:
        assert any(r['id']==created['id'] for r in call('GET','/api/employees'))
        record['title']='Updated record'
        assert call('PUT','/api/employees/'+created['id'],record)['title']=='Updated record'
    finally:
        call('DELETE','/api/employees/'+created['id'])
    assert not any(r['id']==created['id'] for r in call('GET','/api/employees'))
    call('POST','/api/logout',{})
    print('PASS: live HTTPS login, list, create, update, delete and logout')

if __name__=='__main__':
    main()
