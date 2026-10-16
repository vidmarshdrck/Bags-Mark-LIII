"""Mock local backend for the Valet PWA. No secrets, no paid providers. State is in memory."""
import json, os, re, time, uuid, threading, http.server
from urllib.parse import urlparse, parse_qs
ROOT=os.path.join(os.path.dirname(__file__),'static'); PORT=int(os.environ.get('PORT','8792'))
MEET, TASKS, EVENTS, LOCK = {}, {}, [], threading.Lock()
ROUTES=[('job','Aaron → Eli → Issachar → Cyrus'),('financ|money|budget','Aaron → Boaz'),('property|rent|estate','Aaron → Joshua → Boaz'),
 ('build|software|app|code|deploy','Aaron → Nathan'),('design|content|brand|logo','Aaron → Bezalel → Hiram → Vidmar'),('research','Aaron → Issachar'),('market|social','Aaron → Matthew')]
def reply(t):
    l=t.lower()
    if re.search(r'\b(today|brief|happening)\b',l):
        return f"Briefing (mock data): {len(MEET)} meeting(s) open, {sum(1 for x in TASKS.values() if x['status']!='completed')} task(s) running. Calendar and inbox aren't connected yet."
    for k,r in ROUTES:
        if re.search(k,l): return f"Understood. I'd route that {r}. Delegation isn't connected yet, so I've noted it but haven't sent it anywhere."
    return "Noted, sir. I'm running on the local mock brain: no AI provider is connected, so I can only give briefings, routing suggestions, meetings and status checks."
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k): super().__init__(*a,directory=ROOT,**k)
    def log_message(s,*a): pass
    def j(s,code,obj,ctype='application/json'):
        b=obj.encode() if isinstance(obj,str) else json.dumps(obj).encode()
        s.send_response(code); s.send_header('Content-Type',ctype); s.send_header('Content-Length',len(b)); s.send_header('Cache-Control','no-store'); s.end_headers(); s.wfile.write(b)
    def body(s):
        n=int(s.headers.get('Content-Length') or 0)
        try: return json.loads(s.rfile.read(n) or b'{}') if n<=65536 else {}
        except Exception: return {}
    def route(s,m):
        u=urlparse(s.path); p=u.path.split('/api/',1)
        if len(p)<2: return False
        p=p[1].strip('/'); q=parse_qs(u.query); parts=p.split('/')
        with LOCK: s.api(m,parts,q)
        return True
    def api(s,m,P,q):
        if P==['chat'] and m=='POST':
            t=str(s.body().get('text',''))[:4096]; return s.j(200,{'reply':reply(t),'source':'mock-local'})
        if P==['interrupt']: return s.j(200,{'type':'interrupted'})
        if P==['tasks']:
            if m=='GET': return s.j(200,{'tasks':list(TASKS.values())})
            b=s.body()
            if b.get('action')!='server_status' or b.get('confirmed') is not True: return s.j(400,{'error':'only confirmed server_status is allowed'})
            tid=uuid.uuid4().hex[:8]; TASKS[tid]={'id':tid,'action':'server_status','status':'running','result':''}
            def done():
                time.sleep(2)
                with LOCK:
                    la=os.getloadavg(); TASKS[tid].update(status='completed',result=f'Box load {la[0]:.2f}, uptime check OK (mock, this box only)')
                    EVENTS.append({'seq':len(EVENTS)+1,'task_id':tid,'speech':'Server status check completed.'})
            threading.Thread(target=done,daemon=True).start(); return s.j(202,TASKS[tid])
        if P==['events']:
            a=int((q.get('after') or ['0'])[0]); ev=[e for e in EVENTS if e['seq']>a][:50]
            return s.j(200,{'events':ev,'next_cursor':ev[-1]['seq'] if ev else a})
        if P[0]=='meetings':
            if len(P)==1:
                if m=='GET': return s.j(200,{'meetings':list(MEET.values())})
                b=s.body()
                if not (b.get('context_approved') is True and b.get('confirmed') is True): return s.j(400,{'error':'context_approved and confirmed required'})
                parts=list(dict.fromkeys(['bagheera_butler.agent']+[str(x) for x in b.get('participants',[])]))[:8]
                mid=uuid.uuid4().hex[:8]; MEET[mid]={'id':mid,'project':str(b.get('project') or 'Untitled')[:200],'agenda':str(b.get('agenda',''))[:2048],
                  'participants':parts,'state':'manual_context_only','runtime':'disconnected','active_speaker':'user','automatic_turns':False,'entries':[]}
                return s.j(201,MEET[mid])
            mt=MEET.get(P[1])
            if not mt: return s.j(404,{'error':'not_found'})
            if len(P)==2: 
                if m=='DELETE': MEET.pop(P[1]); return s.j(200,{'deleted':True})
                return s.j(200,mt)
            if P[2]=='entries' and m=='POST':
                b=s.body()
                if b.get('kind') not in ('note','decision','action_item') or not b.get('text') or b.get('confirmed') is not True: return s.j(400,{'error':'invalid_entry'})
                if len(mt['entries'])>=200: return s.j(409,{'error':'limit'})
                e={'kind':b['kind'],'text':str(b['text'])[:2048],'speaker':'user','source':'user_recorded'}
                o=b.get('owner_agent_id')
                if o in mt['participants'] or o=='user': e['owner_agent_id']=o
                if re.fullmatch(r'\d{4}-\d{2}-\d{2}',str(b.get('deadline',''))): e['deadline']=b['deadline']
                mt['entries'].append(e); return s.j(201,e)
            if P[2]=='turn':
                sp=s.body().get('speaker_id')
                if sp=='user': mt['active_speaker']='user'; return s.j(200,mt)
                return s.j(409,{'error':'meeting_runtime_disconnected'})
            if P[2]=='interrupt': mt['active_speaker']='user'; return s.j(200,mt)
            if P[2]=='minutes':
                L=[f"# {mt['project']}",'',f"Agenda: {mt['agenda']}",'','Participants: '+', '.join(mt['participants']),'']+[f"- [{e['kind']}] {e['text']} (recorded by user{', owner '+e['owner_agent_id'] if 'owner_agent_id' in e else ''}{', due '+e['deadline'] if 'deadline' in e else ''})" for e in mt['entries']]+['','No demo artifact produced.']
                return s.j(200,'\n'.join(L),'text/markdown; charset=utf-8')
        s.j(404,{'error':'no_route'})
    def do_GET(s):
        if not s.route('GET'): super().do_GET()
    def do_POST(s):
        if not s.route('POST'): s.j(404,{})
    def do_DELETE(s):
        if not s.route('DELETE'): s.j(404,{})
    def end_headers(s):
        if s.path.endswith('sw.js'): s.send_header('Service-Worker-Allowed','./')
        super().end_headers()
if __name__=='__main__': http.server.ThreadingHTTPServer(('0.0.0.0',PORT),H).serve_forever()
