#!/usr/bin/env python3
"""Print only allowlisted non-secret OIDC claims; never print the JWT or request credentials."""
import base64
import json
import os
import urllib.parse
import urllib.request

SAFE_FIELDS=('iss','aud','sub','repository','environment','job_workflow_ref')

def safe_claims(token):
    try:
        parts=token.split('.')
        if len(parts)!=3:raise ValueError()
        body=parts[1]
        payload=json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4)))
        return {field:payload.get(field) for field in SAFE_FIELDS}
    except Exception:
        raise RuntimeError('OIDC claim metadata could not be decoded') from None

def main():
    url=os.environ.get('ACTIONS_ID_TOKEN_REQUEST_URL')
    credential=os.environ.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN')
    if not url or not credential:
        raise RuntimeError('Run this diagnostic in GitHub Actions with id-token: write')
    parsed=urllib.parse.urlsplit(url)
    query=urllib.parse.parse_qsl(parsed.query,keep_blank_values=True)
    query=[(k,v) for k,v in query if k!='audience']+[('audience','sts.amazonaws.com')]
    url=urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))
    request=urllib.request.Request(url,headers={'Authorization':'Bearer '+credential})
    try:
        with urllib.request.urlopen(request,timeout=30) as response:
            token=json.load(response)['value']
    except Exception:
        raise RuntimeError('GitHub OIDC request failed; no token or request credentials were logged') from None
    claims=safe_claims(token)
    print(json.dumps({'expectedSubject':'repo:sakthisaravanan8531-hue/employee-app:environment:production','expectedAudience':'sts.amazonaws.com','claims':claims},indent=2))

if __name__=='__main__':main()
