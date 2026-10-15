"""Owner-scoped approved meeting context and user-recorded minutes.

No multi-agent inference runtime is connected. No synthetic agent speakers,
auto-dispatch, private profile imports, or simulated task progress are allowed.
"""
import datetime
import json
import re
import secrets
import time
from urllib.parse import urlparse
from starlette.responses import JSONResponse, Response


class Meetings:
    def __init__(self, store, agents):
        self.store, self.agents = store, agents

    def read(self, db, owner, meeting_id):
        row = db.execute('SELECT payload FROM meetings WHERE id=? AND owner=?', (meeting_id, owner)).fetchone()
        return json.loads(row[0]) if row else None

    def enrich(self, db, owner, data):
        tasks, links = [], []
        for task_id in data['task_ids']:
            row = db.execute('SELECT t.id,t.action,t.status,t.result,s.agent FROM tasks t JOIN sessions s ON t.session=s.id WHERE t.id=? AND s.owner=?', (task_id, owner)).fetchone()
            if not row:
                continue
            tasks.append({'id': row[0], 'action': row[1], 'status': row[2], 'agent_id': row[4]})
            result = json.loads(row[3]) if row[3] else {}
            for url in result.get('demo_links', []) if row[2] == 'completed' else []:
                if isinstance(url, str) and len(url) <= 2048 and urlparse(url).scheme == 'https' and urlparse(url).hostname:
                    links.append({'url': url, 'task_id': row[0], 'source': 'completed_backend_task'})
        return {**data, 'tasks': tasks, 'demo_links': links, 'runtime': 'disconnected'}

    async def endpoint(self, request):
        identity = self.store.identity(request.state.sid)
        owner = identity['owner']
        meeting_id = request.path_params.get('meeting_id')
        operation = request.path_params.get('operation')
        if request.method == 'GET':
            with self.store.connect() as db:
                if not meeting_id:
                    rows = db.execute('SELECT id,payload FROM meetings WHERE owner=? ORDER BY created DESC LIMIT 20', (owner,)).fetchall()
                    return JSONResponse({'meetings': [{'id': row[0], 'project': json.loads(row[1])['project'], 'state': 'manual_context_only'} for row in rows]})
                data = self.read(db, owner, meeting_id)
                if not data:
                    return JSONResponse({'error': 'not_found'}, status_code=404)
                enriched = self.enrich(db, owner, data)
            if operation == 'minutes':
                lines = ['# '+data['project'], '', 'User-recorded minutes. Agent meeting runtime is disconnected.',
                         'Moderator / secretary roles: Bags (not an executed speaker).', '', '## Approved agenda', data['agenda'], '',
                         '## Invited actual registry participants']
                lines.extend('- '+p['name']+' ('+p['route']+')' for p in data['participants'])
                lines.extend(['', '## User-recorded notes, decisions and action items'])
                lines.extend('- ['+e['kind']+'] User: '+e['text']+' | owner: '+(e.get('owner_agent_id') or 'unassigned')+' | deadline: '+(e.get('deadline') or 'unset') for e in data['entries'])
                lines.extend(['', '## Real linked backend tasks'])
                lines.extend('- '+t['id']+' / '+t['action']+': '+t['status'] for t in enriched['tasks'])
                return Response('\n'.join(lines)+'\n', media_type='text/plain', headers={'Content-Disposition': 'attachment; filename="meeting-minutes.md"'})
            return JSONResponse(enriched)
        if request.method == 'DELETE':
            with self.store.connect() as db:
                count = db.execute('DELETE FROM meetings WHERE id=? AND owner=?', (meeting_id, owner)).rowcount
            return Response(status_code=204) if count else JSONResponse({'error': 'not_found'}, status_code=404)
        try:
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError()
        except ValueError:
            return JSONResponse({'error': 'invalid_json'}, status_code=400)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT 1 FROM sessions WHERE id=? AND expires>?', (request.state.sid, time.time())).fetchone():
                return JSONResponse({'error': 'unauthorized'}, status_code=401)
            if not meeting_id:
                if set(body) - {'project', 'agenda', 'participants', 'context_approved', 'confirmed'}:
                    return JSONResponse({'error': 'unexpected_fields'}, status_code=400)
                if body.get('context_approved') is not True or body.get('confirmed') is not True:
                    return JSONResponse({'error': 'approved_shared_context_required'}, status_code=409)
                project, agenda, participants = body.get('project'), body.get('agenda'), body.get('participants')
                if not isinstance(project, str) or not 0 < len(project) <= 120 or not isinstance(agenda, str) or not 0 < len(agenda) <= 4096:
                    return JSONResponse({'error': 'invalid_project_or_agenda'}, status_code=400)
                if not isinstance(participants, list) or not 1 <= len(participants) <= 8 or any(not isinstance(p, str) or p not in self.agents.agents for p in participants):
                    return JSONResponse({'error': 'actual_participants_required'}, status_code=400)
                participants = list(dict.fromkeys(['bags']+participants))
                if len(participants) > 8:
                    return JSONResponse({'error': 'participant_limit'}, status_code=400)
                if db.execute('SELECT count(*) FROM meetings WHERE owner=?', (owner,)).fetchone()[0] >= 20 or db.execute('SELECT count(*) FROM meetings').fetchone()[0] >= 100:
                    return JSONResponse({'error': 'meeting_quota'}, status_code=429)
                meeting_id = secrets.token_hex(16)
                data = {'id': meeting_id, 'project': project, 'agenda': agenda, 'context_approved': True,
                        'participants': [{'id': p, 'name': self.agents.agents[p]['name'], 'route': self.agents.agents[p].get('route', 'disconnected')} for p in participants],
                        'moderator_id': 'bags', 'secretary_id': 'bags', 'active_speaker': 'user',
                        'state': 'manual_context_only', 'entries': [], 'task_ids': [], 'automatic_turns': False}
                db.execute('INSERT INTO meetings VALUES (?,?,?,?)', (meeting_id, owner, json.dumps(data), time.time()))
                return JSONResponse(self.enrich(db, owner, data), status_code=201)
            data = self.read(db, owner, meeting_id)
            if not data:
                return JSONResponse({'error': 'not_found'}, status_code=404)
            participants = {p['id'] for p in data['participants']}
            if operation == 'entries':
                if set(body) - {'kind', 'text', 'owner_agent_id', 'deadline', 'confirmed'} or body.get('confirmed') is not True:
                    return JSONResponse({'error': 'user_entry_only_confirmation_required'}, status_code=400)
                kind, text = body.get('kind'), body.get('text')
                if kind not in ('note', 'decision', 'action_item') or not isinstance(text, str) or not 0 < len(text) <= 2048:
                    return JSONResponse({'error': 'invalid_entry'}, status_code=400)
                if body.get('owner_agent_id') is not None and (not isinstance(body['owner_agent_id'], str) or (body['owner_agent_id'] != 'user' and body['owner_agent_id'] not in participants)):
                    return JSONResponse({'error': 'owner_not_participant'}, status_code=400)
                deadline = body.get('deadline')
                if deadline is not None:
                    try:
                        if not isinstance(deadline, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', deadline):
                            raise ValueError()
                        datetime.date.fromisoformat(deadline)
                    except ValueError:
                        return JSONResponse({'error': 'invalid_deadline'}, status_code=400)
                if len(data['entries']) >= 200:
                    return JSONResponse({'error': 'entry_quota'}, status_code=429)
                data['entries'].append({'kind': kind, 'text': text, 'speaker_id': 'user', 'source': 'user_recorded',
                                        'owner_agent_id': body.get('owner_agent_id'), 'deadline': deadline,
                                        'execution': 'not_dispatched', 'created_at': time.time()})
            elif operation == 'turn':
                if set(body) - {'speaker_id', 'confirmed'} or body.get('confirmed') is not True:
                    return JSONResponse({'error': 'confirmation_required'}, status_code=400)
                speaker = body.get('speaker_id')
                if not isinstance(speaker, str) or (speaker != 'user' and speaker not in participants):
                    return JSONResponse({'error': 'speaker_not_participant'}, status_code=400)
                if speaker != 'user':
                    return JSONResponse({'error': 'meeting_runtime_disconnected', 'requested_speaker_id': speaker,
                                         'active_speaker': 'user', 'automatic_turns': False}, status_code=409)
                data['active_speaker'] = 'user'
            elif operation == 'interrupt':
                if body:
                    return JSONResponse({'error': 'unexpected_fields'}, status_code=400)
                data['active_speaker'] = 'user'
            elif operation == 'tasks':
                if set(body) - {'task_id', 'confirmed'} or body.get('confirmed') is not True:
                    return JSONResponse({'error': 'confirmation_required'}, status_code=400)
                task_id = body.get('task_id')
                if not isinstance(task_id, str) or not db.execute('SELECT 1 FROM tasks t JOIN sessions s ON t.session=s.id WHERE t.id=? AND s.owner=?', (task_id, owner)).fetchone():
                    return JSONResponse({'error': 'task_not_found'}, status_code=404)
                if len(data['task_ids']) >= 50:
                    return JSONResponse({'error': 'linked_task_quota'}, status_code=429)
                if task_id not in data['task_ids']:
                    data['task_ids'].append(task_id)
            else:
                return JSONResponse({'error': 'unknown_meeting_operation'}, status_code=404)
            db.execute('UPDATE meetings SET payload=? WHERE id=? AND owner=?', (json.dumps(data), meeting_id, owner))
            return JSONResponse(self.enrich(db, owner, data), status_code=200 if operation in ('interrupt', 'turn') else 201)
