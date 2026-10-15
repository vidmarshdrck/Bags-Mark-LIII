"""Bounded headless HTTP/WebSocket service. Run via python -m companion."""
import asyncio
import json
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path
from starlette.applications import Starlette
from starlette.responses import JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from .live import live_socket
from .store import Store
from .providers import provider_from_environment
from .tasks import Tasks
from .uploads import Uploads
from .agents import AgentRoutes
from .meetings import Meetings


class SecurityHeaders:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        async def secured(message):
            if message['type'] == 'http.response.start':
                message.setdefault('headers', []).extend([
                    (b'cache-control', b'no-store'), (b'x-content-type-options', b'nosniff'),
                    (b'referrer-policy', b'no-referrer'),
                    (b'permissions-policy', b'camera=(self), microphone=(self)'),
                    (b'content-security-policy', b"default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")])
            await send(message)
        await self.app(scope, receive, secured)


def create_app(data_dir, provider=None, allowed_origin=None):
    store = Store(data_dir)
    provider = provider or provider_from_environment()
    agent_routes = AgentRoutes(data_dir, provider)
    uploads, tasks = Uploads(store), Tasks(store, provider, agent_routes)
    meetings = Meetings(store, agent_routes)
    pairing_attempts = deque(maxlen=30)

    @asynccontextmanager
    async def lifespan(app):
        worker = asyncio.create_task(tasks.worker())
        try:
            yield
        finally:
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)

    def guarded(handler):
        async def endpoint(request):
            header = request.headers.get('authorization', '')
            sid = store.authenticate(header[7:]) if header.startswith('Bearer ') else None
            if not sid:
                return JSONResponse({'error': 'unauthorized'}, status_code=401)
            request.state.sid = sid
            return await handler(request)
        return endpoint

    async def health(request):
        return JSONResponse({'ok': True, 'protocol': 1, 'provider': provider.status(), 'ai_worker': 'disconnected'})

    async def pair(request):
        now = time.monotonic()
        if len(pairing_attempts) == 30 and now - pairing_attempts[0] < 60:
            return JSONResponse({'error': 'pairing_rate_limit'}, status_code=429)
        pairing_attempts.append(now)
        try:
            body = await request.json()
            result = store.pair(body.get('code'))
        except (ValueError, AttributeError):
            result = None
        return JSONResponse(result or {'error': 'invalid_or_expired_pairing'}, status_code=200 if result else 401)

    async def close_live(sid):
        lifecycle = app.state.stops.get(sid)
        if lifecycle:
            stop, closed = lifecycle
            stop.set()
            # The live handler owns its ASGI lifecycle; never cancel a hosting server task.
            await asyncio.wait_for(closed.wait(), 10)

    async def session(request):
        if request.method == 'DELETE':
            sid = request.state.sid
            with store.connect() as db:
                for (file_id,) in db.execute('SELECT id FROM uploads WHERE session=?', (sid,)).fetchall():
                    (uploads.root / file_id).unlink(missing_ok=True)
                for table in ('uploads', 'tasks', 'events'):
                    db.execute(f'DELETE FROM {table} WHERE session=?', (sid,))
                db.execute('DELETE FROM sessions WHERE id=?', (sid,))
            await close_live(sid)
            return Response(status_code=204)
        return JSONResponse({'session_id': request.state.sid, **store.identity(request.state.sid),
                             'provider': agent_routes.provider_for(store, request.state.sid).status(),
                             'ai_worker': 'disconnected', 'expires_in_max_seconds': 3600})

    async def erase_device(request):
        identity = store.identity(request.state.sid)
        owner = identity['owner']
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            session_ids = [row[0] for row in db.execute('SELECT id FROM sessions WHERE owner=?', (owner,))]
            for sid in session_ids:
                for (file_id,) in db.execute('SELECT id FROM uploads WHERE session=?', (sid,)).fetchall():
                    (uploads.root / file_id).unlink(missing_ok=True)
                for table in ('uploads', 'tasks', 'events'):
                    db.execute(f'DELETE FROM {table} WHERE session=?', (sid,))
            db.execute('DELETE FROM meetings WHERE owner=?', (owner,))
            db.execute('DELETE FROM sessions WHERE owner=?', (owner,))
        for sid in session_ids:
            await close_live(sid)
        return Response(status_code=204)

    async def agents(request):
        if request.method == 'GET':
            return JSONResponse({'agents': list(agent_routes.agents.values()),
                                 'selected': store.identity(request.state.sid)['agent_id']})
        agent_id = request.path_params['agent_id']
        if agent_id not in agent_routes.agents:
            return JSONResponse({'error': 'unknown_agent'}, status_code=404)
        result = store.agent_session(request.state.sid, agent_id)
        return JSONResponse(result or {'error': 'session_quota'}, status_code=201 if result else 429)

    async def asset(request):
        from starlette.responses import FileResponse
        name = request.path_params.get('asset', 'index.html')
        allowed = {'index.html', 'app.js', 'meetings.js', 'app.css', 'manifest.webmanifest', 'icon.svg'}
        if name not in allowed:
            return Response(status_code=404)
        media = 'application/manifest+json' if name.endswith('webmanifest') else None
        return FileResponse(Path(__file__).parent / 'static' / name, media_type=media)

    async def request_gate(request, call_next):
        origin = request.headers.get('origin')
        expected = allowed_origin or request.url.scheme + '://' + request.url.netloc
        if origin and origin != expected:
            return JSONResponse({'error': 'origin_forbidden'}, status_code=403)
        if request.method == 'POST' and not request.url.path.endswith('/api/uploads'):
            # Stop before parsing untrusted JSON; uploads are bounded while streaming.
            total, chunks = 0, []
            async for chunk in request.stream():
                total += len(chunk)
                if total > 8192:
                    return JSONResponse({'error': 'body_too_large'}, status_code=413)
                chunks.append(chunk)
            request._body = b''.join(chunks)
        return await call_next(request)

    app = Starlette(lifespan=lifespan, routes=[
        Route('/health', health), Route('/api/pair', pair, methods=['POST']),
        Route('/api/device', guarded(erase_device), methods=['DELETE']),
        Route('/api/session', guarded(session), methods=['GET', 'DELETE']), WebSocketRoute('/api/live', live_socket),
        Route('/api/uploads', guarded(uploads.endpoint), methods=['POST']),
        Route('/api/uploads/{file_id}', guarded(uploads.endpoint), methods=['GET', 'DELETE']),
        Route('/api/tasks', guarded(tasks.endpoint), methods=['GET', 'POST']),
        Route('/api/events', guarded(tasks.events)),
        Route('/api/agents', guarded(agents)),
        Route('/api/meetings', guarded(meetings.endpoint), methods=['GET', 'POST']),
        Route('/api/meetings/{meeting_id}', guarded(meetings.endpoint), methods=['GET', 'DELETE']),
        Route('/api/meetings/{meeting_id}/{operation}', guarded(meetings.endpoint), methods=['GET', 'POST']),
        Route('/api/agents/{agent_id}/session', guarded(agents), methods=['POST']), Route('/', asset), Route('/{asset}', asset),
    ])
    # Security header middleware outermost, including early errors from the request gate.
    from starlette.middleware.base import BaseHTTPMiddleware
    app.add_middleware(BaseHTTPMiddleware, dispatch=request_gate)
    app.add_middleware(SecurityHeaders)
    app.state.store, app.state.provider = store, provider
    app.state.allowed_origin = allowed_origin
    app.state.active = set()
    app.state.connections = {}
    app.state.stops = {}
    app.state.send_attachment = uploads.send
    app.state.agent_routes = agent_routes
    return app
