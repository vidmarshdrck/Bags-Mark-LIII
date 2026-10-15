"""Local operator commands; pairing/registry never live in the public repository."""
import argparse
import json
import os
import shutil
from pathlib import Path
from urllib.parse import urlparse


def main():
    parser = argparse.ArgumentParser(description='Bags headless mobile companion (personal/non-commercial).')
    parser.add_argument('--data-dir', type=Path, default=Path.home()/'.local/share/bags-companion')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('pair', help='Print one new single-use pairing code, valid 5 minutes; replaces previous code')
    serve = sub.add_parser('serve', help='Serve loopback only; use an authorized TLS reverse proxy for mobile')
    serve.add_argument('--port', type=int, default=8768)
    serve.add_argument('--origin', help='Exact public HTTPS origin, no path, once a TLS reverse proxy is configured')
    serve.add_argument('--root-path', default='', help='ASGI proxy prefix, e.g. /bags-mark')
    serve.add_argument('--text-provider', choices=['none', 'codex'], default='none')
    serve.add_argument('--codex-model', help='Optional exact model; omit to use installed CLI default, not a guessed ID')
    sync = sub.add_parser('sync-agents', help='Snapshot real agent names/IDs locally, without credentials or runtime configuration')
    sync.add_argument('--paperclip-url', default='http://127.0.0.1:3100')
    sync.add_argument('--company', required=True)
    args = parser.parse_args()
    os.umask(0o077)
    from .store import Store
    store = Store(args.data_dir)
    if args.command == 'pair':
        print(store.issue_pairing())
    elif args.command == 'sync-agents':
        from urllib.request import urlopen
        import re
        url = urlparse(args.paperclip_url)
        if url.scheme != 'http' or url.hostname not in ('127.0.0.1', 'localhost', '::1') or url.username or url.password:
            parser.error('Roster discovery is restricted to the existing loopback Paperclip API.')
        if not re.fullmatch(r'[a-fA-F0-9-]{36}', args.company):
            parser.error('Pass the exact real Paperclip company UUID.')
        with urlopen(args.paperclip_url.rstrip('/')+'/api/companies/'+args.company+'/agents', timeout=8) as response:
            raw = response.read(2*1024*1024+1)
        if len(raw) > 2*1024*1024:
            parser.error('Roster response exceeded safety limit.')
        agents = json.loads(raw)
        if not isinstance(agents, list) or len(agents) > 100:
            parser.error('Unexpected roster shape.')
        sanitized = [{'id': a['id'], 'name': a['name'], 'role': a.get('role', ''),
                      'runtime_state': a.get('status', 'unverified')} for a in agents]
        path = store.root / 'agents.json'
        temporary = path.with_suffix('.tmp')
        with open(temporary, 'w', encoding='utf-8') as output:
            json.dump(sanitized, output, indent=2)
        temporary.chmod(0o600)
        temporary.replace(path)
        readback = json.loads(path.read_text())
        assert len(readback) == len(sanitized)
        print(json.dumps({'agents_saved': len(readback), 'path': str(path), 'runtime_bridge': 'disconnected'}))
    else:
        if args.origin:
            origin = urlparse(args.origin)
            if origin.scheme != 'https' or origin.path or origin.query or origin.fragment or origin.username:
                parser.error('--origin must be an exact HTTPS origin, without a path or credentials.')
        from .server import create_app
        from .providers import provider_from_environment
        provider = provider_from_environment()
        if args.text_provider == 'codex':
            from .text_provider import CodexTextProvider
            binary = shutil.which('codex')
            if not binary:
                parser.error('Official codex CLI not installed; no alternative auth inferred.')
            workspace = store.root / 'text-workspace'
            workspace.mkdir(mode=0o700, exist_ok=True)
            provider = CodexTextProvider(binary, workspace, args.codex_model)
        import uvicorn
        uvicorn.run(create_app(store.root, provider=provider, allowed_origin=args.origin),
                    host='127.0.0.1', port=args.port, root_path=args.root_path,
                    access_log=False, proxy_headers=False, ws_max_size=360000,
                    ws_max_queue=8, limit_concurrency=32)


if __name__ == '__main__':
    main()
