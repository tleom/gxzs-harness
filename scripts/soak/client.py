"""Authenticated client for the isolated synthetic owner stack."""
import base64
import hashlib
import hmac
import json
import pathlib
import time
import urllib.error
import urllib.request
import uuid


class FixtureClient:
    def __init__(self, root):
        self.root = pathlib.Path(root).resolve()
        assert self.root.parent == pathlib.Path('/home/jrgx')
        assert self.root.name.startswith('gxzs-simulated-soak-')
        self.config = json.loads((self.root / 'stack-private.json').read_text())
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, url, method='GET', body=None, headers=None, timeout=60):
        raw = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=raw, method=method,
            headers={**({'Content-Type': 'application/json'} if body is not None else {}), **(headers or {})})
        try:
            response = self.opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            # Error details may contain private assertions; retain only a bounded body.
            detail = error.read(2000).decode(errors='replace')
            for secret in [self.config['token'], self.config['assertionKey']]:
                detail = detail.replace(secret, '[redacted]')
            raise RuntimeError(f'HTTP {error.code}: {detail}') from None
        return response

    def platform(self, path, body=None):
        with self.request(self.config['publicURL'] + path, 'POST' if body is not None else 'GET', body,
                {'Authorization': 'Bearer ' + self.config['token']}) as response:
            return json.load(response)

    def manager(self, path, body=None):
        with self.request(self.config['managerURL'] + path, 'POST' if body is not None else 'GET', body,
                {'Authorization': 'Bearer ' + self.config['token']}, timeout=180) as response:
            return json.load(response)

    def bindings(self):
        return {item['owner_id']: item for item in self.platform('/__test/bindings')}

    def open_host(self, row, method, path, body=None, timeout=60):
        raw = b'' if body is None else json.dumps(body).encode()
        now = int(time.time())
        owner = row['owner_id']
        tenant, user = owner.split(':')
        key = hmac.new(base64.b64decode(self.config['assertionKey']),
            f"assertion\n{owner}\n{row['generation']}\n{row['instance_id']}".encode(), hashlib.sha256).digest()
        claims = {'iss': 'gxzs-simulator', 'aud': 'agent-workbench', 'sub': owner,
            'tenant_id': tenant, 'user_id': user, 'name': 'synthetic-owner', 'iat': now, 'exp': now + 60,
            'jti': str(uuid.uuid4()), 'method': method, 'target': '/ai/workbench' + path,
            'body_sha256': hashlib.sha256(raw).hexdigest(),
            'content_type': 'application/json' if body is not None else '', 'last_event_id': ''}
        encode = lambda value: base64.urlsafe_b64encode(value).decode().rstrip('=')
        message = encode(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode()) + '.' + encode(json.dumps(claims).encode())
        token = message + '.' + encode(hmac.new(key, message.encode(), hashlib.sha256).digest())
        return self.request(row['endpoint'] + '/ai/workbench' + path, method, body,
            {'X-GXZS-Assertion': token}, timeout)

    def host(self, row, method, path, body=None, timeout=60):
        with self.open_host(row, method, path, body, timeout) as response:
            return json.load(response)['data']
