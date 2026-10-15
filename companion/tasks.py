"""Durable, session-scoped manual action bridge; never imports discovered tools.

Only server_status is approved. This is NOT a Hermes/Paperclip AI worker.
"""
import asyncio
import json
import secrets
import time
from core.action_loader import ActionRecord, ActionRegistry
from starlette.responses import JSONResponse


class Tasks:
    def __init__(self, store, provider, agents):
        self.store, self.provider, self.agents = store, provider, agents
        self.registry = ActionRegistry({
            'server_status': ActionRecord(name='server_status', valid=True, handler=self.server_status)
        }, logger=lambda message: None)

    def server_status(self, parameters):
        return json.dumps({'provider': self.provider.status(), 'checked_at': time.time(),
                           'ai_worker': 'disconnected', 'action': 'server_status'})

    def scope(self, request):
        identity = self.store.identity(request.state.sid)
        if request.query_params.get('scope') == 'all':
            return 's.owner=?', identity['owner']
        return 's.id=?', request.state.sid

    def agent_label(self, agent_id):
        return self.agents.agents.get(agent_id, {}).get('name', agent_id)

    async def endpoint(self, request):
        sid = request.state.sid
        if request.method == 'GET':
            with self.store.connect() as db:
                condition, value = self.scope(request)
                rows = db.execute('SELECT t.id,t.action,t.status,t.result,t.created,s.agent FROM tasks t JOIN sessions s ON t.session=s.id WHERE '+condition+' ORDER BY t.created DESC LIMIT 100', (value,)).fetchall()
            return JSONResponse({'tasks': [dict(id=r[0], action=r[1], status=r[2],
                                                result=json.loads(r[3]) if r[3] else None, created_at=r[4],
                                                agent_id=r[5], agent_name=self.agent_label(r[5])) for r in rows],
                                 'ai_worker': 'disconnected'})
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError()
        except ValueError:
            return JSONResponse({'error': 'invalid_json'}, status_code=400)
        if body.get('action') not in self.registry.names():
            return JSONResponse({'error': 'action_not_allowed', 'allowed': ['server_status'], 'ai_worker': 'disconnected'}, status_code=403)
        if body.get('confirmed') is not True:
            return JSONResponse({'error': 'explicit_confirmation_required'}, status_code=409)
        if set(body) - {'action', 'confirmed'}:
            return JSONResponse({'error': 'unexpected_parameters'}, status_code=400)
        task_id = secrets.token_hex(16)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT 1 FROM sessions WHERE id=? AND expires>?', (sid, time.time())).fetchone():
                return JSONResponse({'error': 'unauthorized'}, status_code=401)
            if db.execute('SELECT count(*) FROM tasks WHERE session=?', (sid,)).fetchone()[0] >= 100:
                return JSONResponse({'error': 'task_quota'}, status_code=429)
            db.execute('INSERT INTO tasks VALUES (?,?,?,?,?,?)', (task_id, sid, body['action'], 'queued', None, time.time()))
        return JSONResponse({'id': task_id, 'status': 'queued'}, status_code=202)

    async def events(self, request):
        try:
            after = max(0, int(request.query_params.get('after', '0')))
            if after.bit_length() > 63:
                raise ValueError('cursor_out_of_range')
        except ValueError:
            return JSONResponse({'error': 'invalid_cursor'}, status_code=400)
        with self.store.connect() as db:
            condition, value = self.scope(request)
            rows = db.execute('SELECT e.id,e.payload,s.agent FROM events e JOIN sessions s ON e.session=s.id WHERE '+condition+' AND e.id>? ORDER BY e.id LIMIT 100',
                              (value, after)).fetchall()
        return JSONResponse({'events': [dict(id=row[0], agent_id=row[2], agent_name=self.agent_label(row[2]), **json.loads(row[1])) for row in rows],
                             'next_cursor': rows[-1][0] if rows else after})

    async def worker(self):
        # This allowlisted read-only action is idempotent; safe to restart after crash.
        with self.store.connect() as db:
            db.execute("UPDATE tasks SET status='queued' WHERE status='running'")
        last_cleanup = 0
        while True:
            if time.monotonic() - last_cleanup > 60:
                self.store.cleanup_expired()
                last_cleanup = time.monotonic()
            with self.store.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute("SELECT id,session,action FROM tasks WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
                if row:
                    db.execute("UPDATE tasks SET status='running' WHERE id=?", (row[0],))
            if not row:
                await asyncio.sleep(.05)
                continue
            task_id, sid, action = row
            try:
                if action != 'server_status':
                    raise ValueError('not_allowlisted')
                # The existing project's dispatch architecture is reused with an explicit safe registry.
                result = json.loads(self.registry.run(action, {}))
                status = 'completed'
                event = {'type': 'task.completed', 'task_id': task_id,
                         'speech': 'Server status check completed. AI background worker is disconnected.'}
            except Exception:
                result, status = {'error': 'action_failed'}, 'failed'
                event = {'type': 'task.failed', 'task_id': task_id, 'speech': 'Server status check failed.'}
            with self.store.connect() as db:
                db.execute('UPDATE tasks SET status=?,result=? WHERE id=?', (status, json.dumps(result), task_id))
                db.execute('INSERT INTO events(session,payload) VALUES (?,?)', (sid, json.dumps(event)))
