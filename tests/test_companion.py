"""Local ASGI integration tests; no live model or microphone is used."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from starlette.testclient import TestClient


class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def app(self, **kwargs):
        from companion.server import create_app
        return create_app(Path(self.tmp.name), **kwargs)

    def pair(self, app, client):
        code = app.state.store.issue_pairing()
        response = client.post('/api/pair', json={'code': code})
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_headless_import_health_and_single_use_pairing(self):
        self.assertIsNotNone(importlib.util.find_spec('companion'), 'headless companion missing')
        app = self.app()
        with TestClient(app) as client:
            self.assertEqual(client.get('/health').json()['provider']['state'], 'unavailable')
            code = app.state.store.issue_pairing()
            result = client.post('/api/pair', json={'code': code})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(client.post('/api/pair', json={'code': code}).status_code, 401)
            auth = {'Authorization': 'Bearer ' + result.json()['token']}
            self.assertEqual(client.get('/api/session', headers=auth).status_code, 200)
            self.assertEqual(client.get('/api/session').status_code, 401)
            self.assertNotIn(result.json()['token'].encode(), (Path(self.tmp.name) / 'state.sqlite3').read_bytes())

    def test_websocket_auth_unavailable_and_camera_default_off(self):
        app = self.app()
        with TestClient(app) as client:
            pair = self.pair(app, client)
            with client.websocket_connect('/api/live') as ws:
                ws.send_json({'type': 'auth', 'token': pair['token']})
                self.assertEqual(ws.receive_json()['type'], 'ready')
                ws.send_json({'type': 'camera.frame', 'jpeg': '/9j/2Q=='})
                self.assertEqual(ws.receive_json()['error'], 'camera_off')
                ws.send_bytes(b'\x00\x00')
                self.assertEqual(ws.receive_json()['error'], 'provider_unavailable')
                ws.send_json({'type': 'interrupt'})
                self.assertEqual(ws.receive_json()['type'], 'interrupted')
            from starlette.websockets import WebSocketDisconnect
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect('/api/live') as ws:
                    ws.send_json({'type': 'auth', 'token': 'bad'})
                    ws.receive_json()

    def test_bidirectional_transport_with_explicit_test_fixture(self):
        from contextlib import asynccontextmanager
        import asyncio

        class FixtureConnection:
            def __init__(self):
                self.queue = asyncio.Queue()
                self.images = []
            async def send_text(self, text):
                await self.queue.put({'type': 'text', 'text': 'FIXTURE:' + text})
            async def send_audio(self, data):
                await self.queue.put(b'\x01\x00' * 24)
            async def send_image(self, data):
                self.images.append(data)
                await self.queue.put({'type': 'fixture.image', 'bytes': len(data)})
            async def audio_end(self):
                pass
            async def events(self):
                while True:
                    yield await self.queue.get()

        connection = FixtureConnection()
        class FixtureProvider:
            def status(self):
                return {'name': 'test-fixture-not-ai', 'state': 'configured'}
            @asynccontextmanager
            async def connect(self):
                yield connection

        app = self.app(provider=FixtureProvider())
        with TestClient(app) as client:
            pair = self.pair(app, client)
            with client.websocket_connect('/api/live') as ws:
                ws.send_json({'type': 'auth', 'token': pair['token']})
                self.assertEqual(ws.receive_json()['audio_output'], 'pcm_s16le_24000_mono')
                ws.send_json({'type': 'text', 'text': 'hello'})
                self.assertEqual(ws.receive_json()['text'], 'FIXTURE:hello')
                ws.send_bytes(b'\x00\x00' * 320)
                self.assertEqual(ws.receive_bytes(), b'\x01\x00' * 24)
                ws.send_json({'type': 'camera.set', 'enabled': True})
                self.assertTrue(ws.receive_json()['enabled'])
                import base64, io
                from PIL import Image
                image = io.BytesIO()
                Image.new('RGB', (2, 2)).save(image, format='JPEG')
                ws.send_json({'type': 'camera.frame', 'jpeg': base64.b64encode(image.getvalue()).decode()})
                self.assertEqual(ws.receive_json()['type'], 'fixture.image')
                ws.send_json({'type': 'privacy.pause'})
                self.assertEqual(ws.receive_json()['type'], 'paused')
                ws.send_bytes(b'\x00\x00')
                self.assertEqual(ws.receive_json()['error'], 'paused')
        self.assertFalse(list(Path(self.tmp.name).rglob('*.jpg')), 'camera must not persist')

    def test_provider_requires_explicit_opt_in_and_maps_all_live_parts(self):
        from companion import providers
        self.assertTrue(hasattr(providers, 'provider_from_environment'), 'provider factory missing')
        self.assertEqual(providers.provider_from_environment({}).status()['state'], 'unavailable')
        self.assertEqual(providers.provider_from_environment({'BAGS_GEMINI_KEY': 'not-real'}).status()['state'], 'unavailable')
        from types import SimpleNamespace as N
        event = N(server_content=N(interrupted=True, turn_complete=True,
            input_transcription=N(text='user words'), output_transcription=N(text='reply words'),
            model_turn=N(parts=[N(inline_data=N(data=b'pcm', mime_type='audio/pcm;rate=24000'), text=None),
                               N(inline_data=None, text='text part')])), go_away=None)
        mapped = list(providers.map_live_event(event))
        self.assertIn(b'pcm', mapped)
        self.assertIn({'type': 'interrupted', 'scope': 'provider'}, mapped)
        self.assertIn({'type': 'text', 'text': 'text part'}, mapped)
        self.assertIn({'type': 'transcript.output', 'text': 'reply words'}, mapped)
        self.assertIn({'type': 'turn.complete'}, mapped)

    def test_upload_consent_mime_limits_private_and_isolated(self):
        app = self.app()
        with TestClient(app) as client:
            first, second = self.pair(app, client), self.pair(app, client)
            auth = {'Authorization': 'Bearer ' + first['token'], 'Content-Type': 'text/plain'}
            path = '/api/uploads'
            self.assertEqual(client.post(path, headers=auth, content=b'hello').status_code, 403)
            auth['X-Upload-Consent'] = 'yes'
            result = client.post(path, headers=auth, content=b'hello untrusted file')
            self.assertEqual(result.status_code, 201)
            file_id = result.json()['id']
            saved = Path(self.tmp.name) / 'uploads' / file_id
            self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
            self.assertEqual(client.get(path+'/'+file_id, headers=auth).content, b'hello untrusted file')
            self.assertEqual(client.get(path+'/'+file_id, headers={'Authorization': 'Bearer '+second['token']}).status_code, 404)
            self.assertEqual(client.post(path, headers={**auth, 'Content-Type': 'image/jpeg'}, content=b'not jpeg').status_code, 415)
            self.assertEqual(client.post(path, headers=auth, content=b'x'*(2*1024*1024+1)).status_code, 413)
            self.assertEqual(client.delete(path+'/'+file_id, headers=auth).status_code, 204)
            self.assertFalse(saved.exists())

    def test_allowlisted_background_task_is_durable_confirmed_and_scoped(self):
        import time
        app = self.app()
        with TestClient(app) as client:
            first, second = self.pair(app, client), self.pair(app, client)
            auth = {'Authorization': 'Bearer '+first['token']}
            self.assertEqual(client.post('/api/tasks', headers=auth, json={'action': 'shell', 'confirmed': True}).status_code, 403)
            self.assertEqual(client.post('/api/tasks', headers=auth, json={'action': 'server_status'}).status_code, 409)
            result = client.post('/api/tasks', headers=auth, json={'action': 'server_status', 'confirmed': True})
            self.assertEqual(result.status_code, 202)
            task_id = result.json()['id']
            deadline = time.monotonic()+3
            while time.monotonic() < deadline:
                tasks = client.get('/api/tasks', headers=auth).json()['tasks']
                if tasks[0]['status'] == 'completed':
                    break
                time.sleep(.02)
            self.assertEqual(tasks[0]['status'], 'completed')
            self.assertEqual(tasks[0]['id'], task_id)
            self.assertIn('provider', tasks[0]['result'])
            events = client.get('/api/events?after=0', headers=auth).json()['events']
            self.assertEqual(events[-1]['type'], 'task.completed')
            self.assertIn('Server status', events[-1]['speech'])
            self.assertEqual(client.get('/api/tasks', headers={'Authorization': 'Bearer '+second['token']}).json()['tasks'], [])
        # Read with a fresh app instance: queue/events are not just process memory.
        with TestClient(self.app()) as client:
            self.assertEqual(client.get('/api/tasks', headers=auth).json()['tasks'][0]['status'], 'completed')

    def test_security_expiration_origin_body_cap_and_revocation(self):
        import time
        app = self.app()
        with TestClient(app) as client:
            expired = app.state.store.issue_pairing(ttl=-1)
            self.assertEqual(client.post('/api/pair', json={'code': expired}).status_code, 401)
            pair = self.pair(app, client)
            auth = {'Authorization': 'Bearer '+pair['token']}
            self.assertEqual(client.post('/api/pair', json={'code': 'x'}, headers={'Origin': 'https://evil.example'}).status_code, 403)
            self.assertEqual(client.post('/api/pair', content=b'x'*8193).status_code, 413)
            response = client.get('/health')
            self.assertEqual(response.headers['cache-control'], 'no-store')
            self.assertIn("frame-ancestors 'none'", response.headers['content-security-policy'])
            with app.state.store.connect() as db:
                db.execute('UPDATE sessions SET expires=? WHERE id=?', (time.time()-1, pair['session_id']))
            self.assertEqual(client.get('/api/session', headers=auth).status_code, 401)
            new = self.pair(app, client)
            new_auth = {'Authorization': 'Bearer '+new['token']}
            result = client.delete('/api/session', headers=new_auth)
            self.assertEqual(result.status_code, 204)
            self.assertEqual(client.get('/api/session', headers=new_auth).status_code, 401)

    def test_mobile_assets_manifest_and_no_hardware_imports(self):
        import sys
        app = self.app()
        with TestClient(app) as client:
            page = client.get('/')
            self.assertEqual(page.status_code, 200)
            self.assertIn('Separate session', page.text)
            self.assertEqual(client.get('/manifest.webmanifest').json()['display'], 'standalone')
            script = client.get('/app.js')
            self.assertEqual(script.status_code, 200)
            self.assertIn('visibilitychange', script.text)
            self.assertIn('privacy.pause', script.text)
            self.assertEqual(client.get('/icon.svg').status_code, 200)
        self.assertNotIn('sounddevice', sys.modules)
        self.assertNotIn('PyQt6', sys.modules)

    def test_codex_text_adapter_is_separate_from_speech_and_sandboxed(self):
        from companion import text_provider
        command = text_provider.codex_command('/usr/bin/codex', '/tmp', 'selected-model')
        self.assertIn('read-only', command)
        self.assertIn('approval_policy="never"', command)
        self.assertNotIn('danger-full-access', command)
        self.assertIn('shell_tool', command)
        status = text_provider.CodexTextProvider('/usr/bin/codex', '/tmp', 'selected-model').status()
        self.assertFalse(status['capabilities']['realtime_audio'])
        self.assertTrue(status['capabilities']['text'])
        self.assertFalse(status['capabilities']['vision'])

    def test_actual_registry_selection_is_isolated_and_disconnected_not_impersonated(self):
        import json
        # Explicit roster fixture, not a claim that these IDs are live agents.
        (Path(self.tmp.name)/'agents.json').write_text(json.dumps([
            {'id': 'test-agent-id', 'name': 'Fixture Specialist', 'role': 'engineer', 'runtime_state': 'unverified'}]))
        app = self.app()
        with TestClient(app) as client:
            root = self.pair(app, client)
            auth = {'Authorization': 'Bearer '+root['token']}
            roster = client.get('/api/agents', headers=auth)
            self.assertEqual(roster.status_code, 200)
            self.assertEqual(roster.json()['selected'], 'bags')
            selected = client.post('/api/agents/test-agent-id/session', headers=auth, json={})
            self.assertEqual(selected.status_code, 201)
            other = selected.json()
            self.assertNotEqual(other['session_id'], root['session_id'])
            other_auth = {'Authorization': 'Bearer '+other['token']}
            state = client.get('/api/session', headers=other_auth).json()
            self.assertEqual(state['agent_id'], 'test-agent-id')
            self.assertEqual(state['provider']['state'], 'unavailable')
            self.assertEqual(client.post('/api/agents/invented/session', headers=auth, json={}).status_code, 404)
            with client.websocket_connect('/api/live') as ws:
                ws.send_json({'type': 'auth', 'token': other['token']})
                self.assertEqual(ws.receive_json()['agent_id'], 'test-agent-id')
                ws.send_json({'type': 'text', 'text': 'who are you?'})
                self.assertEqual(ws.receive_json()['error'], 'provider_unavailable')

    def test_shared_notifications_stay_with_pairing_owner_and_cleanup_expired_data(self):
        import time
        app = self.app()
        with TestClient(app) as client:
            root, outsider = self.pair(app, client), self.pair(app, client)
            app.state.agent_routes.agents['fixture-child'] = {'id': 'fixture-child', 'name': 'Fixture child'}
            root_auth = {'Authorization': 'Bearer '+root['token']}
            child = client.post('/api/agents/fixture-child/session', headers=root_auth, json={}).json()
            child_auth = {'Authorization': 'Bearer '+child['token']}
            upload = client.post('/api/uploads', headers={**child_auth, 'Content-Type': 'text/plain', 'X-Upload-Consent': 'yes'}, content=b'private child data').json()
            self.assertEqual(client.get('/api/uploads/'+upload['id'], headers=root_auth).status_code, 404)
            client.post('/api/tasks', headers=child_auth, json={'action': 'server_status', 'confirmed': True})
            deadline = time.monotonic()+3
            events = []
            while time.monotonic() < deadline:
                events = client.get('/api/events?scope=all', headers=root_auth).json()['events']
                if events:
                    break
                time.sleep(.02)
            self.assertTrue(events)
            self.assertEqual(events[0]['agent_id'], 'fixture-child')
            self.assertEqual(client.get('/api/events', headers=root_auth).json()['events'], [])
            other_auth = {'Authorization': 'Bearer '+outsider['token']}
            self.assertEqual(client.get('/api/events?scope=all', headers=other_auth).json()['events'], [])
            self.assertEqual(client.get('/api/tasks?scope=all', headers=other_auth).json()['tasks'], [])
            with app.state.store.connect() as db:
                db.execute('UPDATE sessions SET expires=? WHERE id=?', (time.time()-1, child['session_id']))
            app.state.store.cleanup_expired()
            self.assertFalse((Path(self.tmp.name)/'uploads'/upload['id']).exists())

    def test_websocket_origin_expired_token_and_pairing_rate_limit(self):
        from starlette.websockets import WebSocketDisconnect
        import time
        app = self.app()
        with TestClient(app) as client:
            pair = self.pair(app, client)
            with self.assertRaises(WebSocketDisconnect):
                with client.websocket_connect('/api/live', headers={'Origin': 'https://evil.example'}):
                    pass
            with client.websocket_connect('/api/live') as ws:
                ws.send_json({'type': 'auth', 'token': pair['token']})
                ws.receive_json()
                with app.state.store.connect() as db:
                    db.execute('UPDATE sessions SET expires=? WHERE id=?', (time.time()-1, pair['session_id']))
                ws.send_json({'type': 'ping'})
                with self.assertRaises(WebSocketDisconnect):
                    ws.receive_json()
            for _ in range(29):
                client.post('/api/pair', json={'code': 'bad'})
            self.assertEqual(client.post('/api/pair', json={'code': 'bad'}).status_code, 429)

    def test_codex_diagnostic_items_are_not_mistaken_for_executed_tools(self):
        from companion import text_provider
        self.assertTrue(hasattr(text_provider, 'codex_item_text'), 'Codex event classifier missing')
        diagnostic = {'type': 'item.completed', 'item': {'type': 'error', 'message': 'Explicit fixture: disabled code host warning'}}
        self.assertIsNone(text_provider.codex_item_text(diagnostic))
        self.assertEqual(text_provider.codex_item_text({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'Fixture reply'}}), 'Fixture reply')
        with self.assertRaises(ValueError):
            text_provider.codex_item_text({'type': 'item.started', 'item': {'type': 'command_execution'}})

    def test_database_connections_close_after_transaction(self):
        import sqlite3
        app = self.app()
        with app.state.store.connect() as db:
            db.execute('SELECT 1')
        with self.assertRaises(sqlite3.ProgrammingError):
            db.execute('SELECT 1')

    def test_upload_cannot_outlive_revoked_session_while_streaming(self):
        app = self.app()
        with TestClient(app) as client:
            pair = self.pair(app, client)
            def body():
                yield b'private '
                with app.state.store.connect() as db:
                    db.execute('DELETE FROM sessions WHERE id=?', (pair['session_id'],))
                yield b'content'
            response = client.post('/api/uploads', headers={'Authorization': 'Bearer '+pair['token'], 'Content-Type': 'text/plain', 'X-Upload-Consent': 'yes'}, content=body())
            self.assertEqual(response.status_code, 401)
            self.assertEqual(list((Path(self.tmp.name)/'uploads').iterdir()), [])

    def test_codex_stdin_deadline_and_cumulative_output_bounds(self):
        from companion import text_provider
        self.assertTrue(hasattr(text_provider, 'TURN_TIMEOUT'), 'whole-turn deadline missing')
        import asyncio, sys
        from unittest.mock import patch
        script = Path(self.tmp.name)/'fixture-provider'
        async def exercise(source):
            script.write_text('#!'+sys.executable+'\n'+source)
            script.chmod(0o700)
            provider = text_provider.CodexTextProvider(str(script), self.tmp.name)
            connection = text_provider.CodexTextConnection(provider)
            connection.history = [{'role': 'user', 'content': 'x'*200000}]
            with patch.object(text_provider, 'TURN_TIMEOUT', .2):
                await asyncio.wait_for(connection._answer('fixture'), 3)
            self.assertEqual((await connection.queue.get())['type'], 'error')
            self.assertFalse(provider.lock.locked())
            self.assertIsNone(connection.process)
        asyncio.run(exercise('import time\ntime.sleep(30)\n'))
        asyncio.run(exercise('import sys,json\nsys.stdin.read()\nprint(json.dumps({"type":"item.completed","item":{"type":"agent_message","text":"x"*300000}}))\n'))

    def test_meeting_approved_shared_context_real_participants_and_manual_minutes(self):
        app = self.app()
        app.state.agent_routes.agents['fixture-advisor'] = {'id': 'fixture-advisor', 'name': 'Fixture advisor', 'route': 'disconnected'}
        with TestClient(app) as client:
            first, outsider = self.pair(app, client), self.pair(app, client)
            auth = {'Authorization': 'Bearer '+first['token']}
            outside = {'Authorization': 'Bearer '+outsider['token']}
            payload = {'project': 'Fixture project', 'agenda': 'Approve design', 'participants': ['bags', 'fixture-advisor'], 'context_approved': True, 'confirmed': True}
            denied = client.post('/api/meetings', headers=auth, json={**payload, 'context_approved': False})
            self.assertEqual(denied.status_code, 409)
            self.assertEqual(client.post('/api/meetings', headers=auth, json={**payload, 'participants': ['invented']}).status_code, 400)
            meeting = client.post('/api/meetings', headers=auth, json=payload)
            self.assertEqual(meeting.status_code, 201)
            meeting_id = meeting.json()['id']
            url = '/api/meetings/'+meeting_id
            self.assertEqual(client.get(url, headers=outside).status_code, 404)
            self.assertEqual(client.post(url+'/entries', headers=auth, json={'kind': 'note', 'text': 'Pretend specialist output', 'speaker_id': 'fixture-advisor', 'confirmed': True}).status_code, 400)
            entry = client.post(url+'/entries', headers=auth, json={'kind': 'action_item', 'text': 'Review design', 'owner_agent_id': 'fixture-advisor', 'deadline': '2026-11-01', 'confirmed': True})
            self.assertEqual(entry.status_code, 201)
            turn = client.post(url+'/turn', headers=auth, json={'speaker_id': 'fixture-advisor', 'confirmed': True})
            self.assertEqual(turn.status_code, 409)
            self.assertEqual(turn.json()['error'], 'meeting_runtime_disconnected')
            self.assertEqual(client.post(url+'/interrupt', headers=auth, json={}).status_code, 200)
            task = client.post('/api/tasks', headers=auth, json={'action': 'server_status', 'confirmed': True}).json()
            self.assertEqual(client.post(url+'/tasks', headers=auth, json={'task_id': task['id'], 'confirmed': True}).status_code, 201)
            data = client.get(url, headers=auth).json()
            self.assertEqual(data['state'], 'manual_context_only')
            self.assertEqual(data['entries'][0]['speaker_id'], 'user')
            self.assertEqual(data['entries'][0]['source'], 'user_recorded')
            self.assertEqual(data['tasks'][0]['id'], task['id'])
            self.assertEqual(data['demo_links'], [])
            minutes = client.get(url+'/minutes', headers=auth)
            self.assertIn('User-recorded', minutes.text)
            self.assertIn('Review design', minutes.text)
            self.assertIn('2026-11-01', minutes.text)

    def test_device_erase_removes_all_owned_agent_sessions_not_other_pairings(self):
        app = self.app()
        app.state.agent_routes.agents['fixture-child'] = {'id': 'fixture-child', 'name': 'Fixture child'}
        with TestClient(app) as client:
            root, outsider = self.pair(app, client), self.pair(app, client)
            auth = {'Authorization': 'Bearer '+root['token']}
            child = client.post('/api/agents/fixture-child/session', headers=auth, json={}).json()
            other_auth = {'Authorization': 'Bearer '+child['token']}
            upload = client.post('/api/uploads', headers={**other_auth, 'Content-Type': 'text/plain', 'X-Upload-Consent': 'yes'}, content=b'owned private file').json()
            client.post('/api/meetings', headers=auth, json={'project': 'Private workspace', 'agenda': 'Private agenda', 'participants': ['bags'], 'context_approved': True, 'confirmed': True})
            self.assertEqual(client.delete('/api/device', headers=auth).status_code, 204)
            self.assertEqual(client.get('/api/session', headers=auth).status_code, 401)
            self.assertEqual(client.get('/api/session', headers=other_auth).status_code, 401)
            self.assertEqual(client.get('/api/session', headers={'Authorization': 'Bearer '+outsider['token']}).status_code, 200)
            self.assertFalse((Path(self.tmp.name)/'uploads'/upload['id']).exists())
            with app.state.store.connect() as db:
                self.assertEqual(db.execute('SELECT count(*) FROM meetings').fetchone()[0], 0)

    def test_revocation_waits_for_live_provider_cleanup_and_cursor_is_bounded(self):
        from contextlib import asynccontextmanager
        from companion.providers import UnavailableProvider
        closed = []
        class FixtureProvider(UnavailableProvider):
            @asynccontextmanager
            async def connect(self):
                try:
                    yield None
                finally:
                    closed.append(True)
        app = self.app(provider=FixtureProvider())
        with TestClient(app) as client:
            pair = self.pair(app, client)
            auth = {'Authorization': 'Bearer '+pair['token']}
            with client.websocket_connect('/api/live') as ws:
                ws.send_json({'type': 'auth', 'token': pair['token']}); ws.receive_json()
                self.assertEqual(client.delete('/api/session', headers=auth).status_code, 204)
                self.assertTrue(closed, 'Revocation must await provider context teardown')
        with TestClient(app, raise_server_exceptions=False) as client:
            pair = self.pair(app, client)
            auth = {'Authorization': 'Bearer '+pair['token']}
            self.assertEqual(client.get('/api/events?after=9223372036854775808', headers=auth).status_code, 400)
            with app.state.store.connect() as db:
                db.execute('UPDATE sessions SET expires=0 WHERE id=?', (pair['session_id'],))
            self.assertIsNone(app.state.store.agent_session(pair['session_id'], 'bags'))

    def test_full_provider_queue_cannot_delay_subprocess_cleanup(self):
        import asyncio, sys
        from companion.text_provider import CodexTextProvider, CodexTextConnection
        script = Path(self.tmp.name)/'fixture-bad-provider'
        script.write_text('#!'+sys.executable+'\nprint("not-json")\n'); script.chmod(0o700)
        async def check():
            provider = CodexTextProvider(str(script), self.tmp.name)
            connection = CodexTextConnection(provider)
            for _ in range(connection.queue.maxsize):
                connection.queue.put_nowait({'type': 'fixture'})
            try:
                await asyncio.wait_for(connection._answer('fixture'), 2)
            except asyncio.TimeoutError:
                self.fail('Full output queue blocked bounded subprocess cleanup')
            self.assertFalse(provider.lock.locked()); self.assertIsNone(connection.process)
        asyncio.run(check())


if __name__ == '__main__':
    unittest.main()
