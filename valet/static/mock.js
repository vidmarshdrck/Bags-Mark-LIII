// In-browser mock backend used when no server is present (e.g. static hosting). Data stays in this browser.
(function(){const S=JSON.parse(localStorage.valetMock||'{"M":{},"T":{},"E":[]}'),save=()=>localStorage.valetMock=JSON.stringify(S);
const R=[[/job/,'Aaron → Eli → Issachar → Cyrus'],[/financ|money|budget/,'Aaron → Boaz'],[/property|rent|estate/,'Aaron → Joshua → Boaz'],[/build|software|app|code|deploy/,'Aaron → Nathan'],[/design|content|brand|logo/,'Aaron → Bezalel → Hiram → Vidmar'],[/research/,'Aaron → Issachar'],[/market|social/,'Aaron → Matthew']];
const id=()=>Math.random().toString(16).slice(2,10),res=(status,data)=>({ok:status<300,status,data});
window.mockApi=(p,o={})=>{const m=o.method||'GET',b=o.body||{},[path,qs]=p.split('?'),P=path.split('/');let r;
 if(p=='chat'){const l=(b.text||'').toLowerCase();let t;
  if(b.emails&&b.emails.length){const e=b.emails[0],first=(e.body||'').split(/(?<=[.!?])\s|\n/).map(x=>x.trim()).find(x=>x&&!/^(hi|hello|dear|hey|good)\b.{0,30},?$/i.test(x))||'';t=`I have the email "${e.subject||'(no subject)'}" from ${e.from||'an unknown sender'}. It opens: "${first.slice(0,140)}". In the demo I can't draft a reply or act on it, but I've noted it.`}
  else if(b.voice&&!b.transcribed)t=`Voice note received, ${b.duration} seconds. I couldn't get a transcript in this browser, so please give me the gist in text.`;
  else if(/today|brief|happening/.test(l))t=`Briefing (demo): ${Object.keys(S.M).length} meeting(s), ${Object.values(S.T).filter(x=>x.status!='completed').length} running task(s). Calendar and inbox aren't connected.`;
  else{t="Noted, sir. This is the offline demo: no AI provider is connected, so I can give briefings, routing suggestions, meetings and status checks.";for(const[k,v]of R)if(k.test(l)){t=`Understood. I'd route that ${v}. Delegation isn't connected, so nothing was sent.`;break}}
  if(b.files)t+=` I can see ${b.files} attached file${b.files>1?'s':''}, kept on this device.`;
  if(b.voice&&b.transcribed)t='Voice note heard. '+t;r=res(200,{reply:t,source:'demo'})}
 else if(p=='interrupt')r=res(200,{});
 else if(p=='tasks'){if(m=='GET')r=res(200,{tasks:Object.values(S.T)});else{const t={id:id(),action:'server_status',status:'queued',result:''};S.T[t.id]=t;
  setTimeout(()=>{t.status='completed';t.result='Demo result: no server connected, so this only confirms the app is working.';S.T[t.id]=t;S.E.push({seq:S.E.length+1,type:'task.completed',task_id:t.id,speech:'Status check completed.'});save()},2000);r=res(202,t)}}
 else if(path=='events'){const a=+qs.split('=')[1],e=S.E.filter(x=>x.seq>a);r=res(200,{events:e,next_cursor:e.length?e.at(-1).seq:a})}
 else if(P[0]=='meetings'){const mt=S.M[P[1]];
  if(P.length==1){if(m=='GET')r=res(200,{meetings:Object.values(S.M)});else if(!b.context_approved)r=res(400,{error:'context_approved required'});
   else{const x={id:id(),project:b.project||'Untitled',agenda:b.agenda||'',participants:[...new Set(['bagheera_butler.agent',...b.participants])].slice(0,8),state:'manual_context_only',runtime:'disconnected',active_speaker:'user',automatic_turns:false,entries:[]};S.M[x.id]=x;r=res(201,x)}}
  else if(!mt)r=res(404,{error:'not_found'});
  else if(P.length==2)r=m=='DELETE'?(delete S.M[P[1]],res(200,{})):res(200,mt);
  else if(P[2]=='entries'){if(!b.text)r=res(400,{error:'invalid_entry'});else{const e={kind:b.kind,text:b.text.slice(0,2048),speaker:'user',source:'user_recorded'};if(b.owner_agent_id)e.owner_agent_id=b.owner_agent_id;if(b.deadline)e.deadline=b.deadline;mt.entries.push(e);r=res(201,e)}}
  else if(P[2]=='turn')r=b.speaker_id=='user'?res(200,mt):res(409,{error:'meeting_runtime_disconnected'});
  else r=res(200,mt)}
 else r=res(404,{error:'no_route'});save();return Promise.resolve(r)};})();
