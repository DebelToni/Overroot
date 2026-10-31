"""Read-only Overroot responses and compiler init configuration; install in ~/uptime/."""
from _probe import main

SPEC = {
    'name': 'Overroot LaTeX studio',
    'group': 'Apps',
    'scope': 'Origin/public frontend and status API, dedicated Cloudflare connector readiness, and compiler container running with init. Does not log in, read documents, edit, or compile LaTeX.',
    'probes': [
        {'kind': 'http', 'name': 'Origin health', 'url': 'http://127.0.0.1:4317/health', 'equals': {'ok': True}},
        {'kind': 'http', 'name': 'Connector ready', 'url': 'http://127.0.0.1:20417/ready', 'equals': {'status': 200}, 'keys': ['readyConnections']},
        {'kind': 'http', 'name': 'Public API', 'url': 'https://overroot.toni.foo/api/v1/status', 'equals': {'ok': True, 'name': 'Overroot', 'publicUrl': 'https://overroot.toni.foo', 'identityOrigin': 'https://accounts.toni.foo'}},
        {'kind': 'http', 'name': 'Public frontend', 'url': 'https://overroot.toni.foo/', 'contains': '<title>Overroot</title>'},
        {'kind': 'command', 'name': 'Compiler worker init',
         'argv': ['docker', 'inspect', '--format', '{"running":{{json .State.Running}},"init":{{json .HostConfig.Init}}}', 'overroot-tectonic-worker'],
         'equals': {'running': True, 'init': True}},
    ],
    'boot': {'user': ['overroot.service', 'overroot-cloudflared.service'], 'system': [], 'containers': ['overroot-tectonic-worker']},
    'link': 'https://overroot.toni.foo/',
}

if __name__ == '__main__':
    main(SPEC)
