"""Small helper for the Chatwoot Application API. Settings come from the environment; nothing secret is stored here.
  FOYERDESK_CHATWOOT_URL     required
  FOYERDESK_ACCOUNT_ID       default 1
  FOYERDESK_CHATWOOT_TOKEN   token itself, or
  FOYERDESK_CHATWOOT_TOKEN_FILE  path to a file holding it (required)
"""
import json, os, urllib.request, urllib.error

URL = os.environ['FOYERDESK_CHATWOOT_URL'].rstrip('/')
ACCOUNT = os.environ.get('FOYERDESK_ACCOUNT_ID', '1')
T = os.environ.get('FOYERDESK_CHATWOOT_TOKEN') or open(os.path.expanduser(
    os.environ['FOYERDESK_CHATWOOT_TOKEN_FILE'])).read().strip()
B = f'{URL}/api/v1/accounts/{ACCOUNT}'

def api(method, path, data=None):
    req = urllib.request.Request(B + path, method=method, data=json.dumps(data).encode() if data is not None else None,
        headers={'api_access_token': T, 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0', 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r: body = r.read().decode()
        return r.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]
