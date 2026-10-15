"""Exercise a running LOOPBACK server. Optional live Codex call uses existing login.

Fixture PCM bytes are transport data, NOT evidence of speech recognition/synthesis.
Never prints codes or bearer tokens. Run from repository root with .venv python.
"""
import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import httpx
from websockets.asyncio.client import connect
from companion.store import Store


async def probe(args):
    origin = 'http://127.0.0.1:' + str(args.port)
    code = Store(args.data_dir).issue_pairing()
    checks = {}
    async with httpx.AsyncClient(base_url=origin, timeout=10) as client:
        health = (await client.get('/health')).json()
        checks['provider'] = health['provider']
        assert (await client.get('/api/session')).status_code == 401
        pair = await client.post('/api/pair', json={'code': code})
        pair.raise_for_status()
        data = pair.json()
        token = data['token']
        headers = {'Authorization': 'Bearer '+token}
        assert (await client.post('/api/pair', json={'code': code})).status_code == 401
        checks['auth_and_single_use_pairing'] = True
        roster = (await client.get('/api/agents', headers=headers)).json()
        checks['registry_entries_including_local_bags'] = len(roster['agents'])
        upload = await client.post('/api/uploads', headers={**headers, 'Content-Type': 'text/plain', 'X-Upload-Consent': 'yes'}, content=b'Probe attachment: untrusted data, no tools authorized.')
        assert upload.status_code == 201
        file_id = upload.json()['id']
        assert (await client.get('/api/uploads/'+file_id, headers=headers)).content.startswith(b'Probe attachment')
        assert (await client.delete('/api/uploads/'+file_id, headers=headers)).status_code == 204
        checks['private_upload_roundtrip_and_delete'] = True
        async with connect(origin.replace('http:', 'ws:')+'/api/live', max_size=1024*1024) as ws:
            await ws.send(json.dumps({'type': 'auth', 'token': token}))
            ready = json.loads(await ws.recv())
            assert ready['type'] == 'ready' and ready['agent_id'] == 'bags'
            await ws.send(json.dumps({'type': 'camera.frame', 'jpeg': '/9j/2Q=='}))
            assert json.loads(await ws.recv())['error'] == 'camera_off'
            await ws.send(b'\x00\x00'*320)
            message = json.loads(await ws.recv())
            assert message['error'] in ('speech_layer_required', 'provider_unavailable')
            checks['camera_default_off_and_audio_entitlement_not_faked'] = True
            if args.live_codex:
                assert ready['provider']['name'] == 'codex-subscription-text'
                await ws.send(json.dumps({'type': 'text', 'text': 'Reply with exactly BAGS_HEADLESS_CODEX_OK. Do not use any tools.'}))
                async with asyncio.timeout(100):
                    while True:
                        result = json.loads(await ws.recv())
                        if result['type'] == 'error':
                            raise RuntimeError(result['error'])
                        if result['type'] == 'text':
                            assert result['text'].strip() == 'BAGS_HEADLESS_CODEX_OK', result['text']
                            checks['live_codex_text_reply'] = result['text']
                            break
            await ws.send(json.dumps({'type': 'interrupt'}))
            while json.loads(await ws.recv())['type'] != 'interrupted':
                pass
            checks['interrupt_control'] = True
        task = await client.post('/api/tasks', headers=headers, json={'action': 'server_status', 'confirmed': True})
        assert task.status_code == 202
        deadline = time.monotonic()+5
        while time.monotonic() < deadline:
            events = (await client.get('/api/events', headers=headers)).json()['events']
            if events:
                assert events[-1]['type'] == 'task.completed'
                checks['real_allowlisted_worker_completion_event'] = events[-1]['type']
                break
            await asyncio.sleep(.05)
        else:
            raise AssertionError('worker did not complete')
        real_agents = [agent for agent in roster['agents'] if agent['id'] != 'bags']
        if real_agents:
            meeting = await client.post('/api/meetings', headers=headers, json={
                'project': 'Transport probe — explicit test workspace',
                'agenda': 'Verify manual minutes and real status, not an AI discussion.',
                'participants': ['bags', real_agents[0]['id']], 'context_approved': True, 'confirmed': True})
            assert meeting.status_code == 201
            meeting_id = meeting.json()['id']
            path = '/api/meetings/'+meeting_id
            record = await client.post(path+'/entries', headers=headers, json={
                'kind': 'note', 'text': 'User-recorded transport verification fixture.', 'confirmed': True})
            assert record.status_code == 201 and record.json()['entries'][0]['source'] == 'user_recorded'
            assert (await client.post(path+'/turn', headers=headers, json={
                'speaker_id': real_agents[0]['id'], 'confirmed': True})).status_code == 409
            assert (await client.post(path+'/tasks', headers=headers, json={
                'task_id': task.json()['id'], 'confirmed': True})).status_code == 201
            current = (await client.get(path, headers=headers)).json()
            assert current['tasks'][0]['status'] == 'completed' and current['demo_links'] == []
            assert 'User-recorded' in (await client.get(path+'/minutes', headers=headers)).text
            assert (await client.delete(path, headers=headers)).status_code == 204
            checks['real_meeting_contract_manual_minutes_no_impersonation'] = True
        assert (await client.delete('/api/device', headers=headers)).status_code == 204
        assert (await client.get('/api/session', headers=headers)).status_code == 401
        checks['revoked_test_session'] = True
    print(json.dumps(checks, indent=2))
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(checks, indent=2)+'\n')
        args.output.chmod(0o600)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8768)
    parser.add_argument('--data-dir', type=Path, default=Path.home()/'.local/share/bags-companion')
    parser.add_argument('--live-codex', action='store_true', help='Explicitly spend existing subscription quota on one real text reply')
    parser.add_argument('--output', type=Path)
    asyncio.run(probe(parser.parse_args()))
