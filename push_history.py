#!/usr/bin/env python3
import urllib.request, json, base64, os, sys

token = os.environ.get('GH_TOKEN')
repo  = os.environ.get('GITHUB_REPOSITORY', 'CHRISEVO24/ecj-tracker')

if not token:
    print("No GH_TOKEN"); sys.exit(1)

with open('history.json', 'rb') as f:
    content = f.read()

data = json.loads(content)
keys = sorted(data.keys())
print(f"Pushing {len(keys)} snapshots, latest={keys[-1]}")

req = urllib.request.Request(
    f'https://api.github.com/repos/{repo}/contents/history.json',
    headers={'Authorization': f'token {token}', 'Accept': 'application/vnd.github.v3+json'}
)
with urllib.request.urlopen(req) as r:
    sha = json.loads(r.read())['sha']

body = json.dumps({'message': 'Auto update history.json [skip ci]',
    'content': base64.b64encode(content).decode(), 'sha': sha}).encode()

req2 = urllib.request.Request(
    f'https://api.github.com/repos/{repo}/contents/history.json',
    data=body, method='PUT',
    headers={'Authorization': f'token {token}', 'Content-Type': 'application/json',
             'Accept': 'application/vnd.github.v3+json'}
)
with urllib.request.urlopen(req2) as r:
    result = json.loads(r.read())
    if 'content' in result:
        print(f"SUCCESS: SHA={result['content']['sha'][:8]}")
    else:
        print(f"FAILED: {result.get('message')}")
        sys.exit(1)
