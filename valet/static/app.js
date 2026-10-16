const $=s=>document.querySelector(s),api0=(p,o={})=>fetch('api/'+p,{headers:{'Content-Type':'application/json'},...o,body:o.body&&JSON.stringify(o.body)}).then(async r=>({ok:r.ok,status:r.status,data:await r.json().catch(()=>({}))}));
let useMock=false;const api=(p,o={})=>useMock?mockApi(p,o):api0(p,o).then(r=>{if(r.status==404&&r.data.error===undefined){useMock=true;$('#conn').textContent='in-browser mock';return mockApi(p,o)}return r}).catch(()=>{useMock=true;$('#conn').textContent='in-browser mock';return mockApi(p,o)});
let agent={id:'bagheera_butler.agent',name:'Bags',live:true},logs={},hands=false,speaking=false;
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js');
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button,.tab').forEach(x=>x.classList.remove('on'));b.classList.add('on');$('#'+b.dataset.tab).classList.add('on');if(b.dataset.tab=='tasks')loadTasks();if(b.dataset.tab=='meet')loadMeetings()});
const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function add(who,text,src){(logs[agent.id]??=[]).push({who,text,src});render()}
function render(){$('#log').innerHTML=(logs[agent.id]||[]).map(m=>`<div class="b ${m.who=='me'?'me':''}"><span class="src">${esc(m.src)}</span>${esc(m.text)}</div>`).join('');scrollTo(0,1e9)}
// ---- speech (Web Speech API; dictation + spoken replies, not full-duplex) ----
const SR=window.SpeechRecognition||window.webkitSpeechRecognition,tts=window.speechSynthesis;let rec;
$('#speechNote').textContent=SR?'Voice uses your browser’s speech recognition (may use the browser vendor’s network service; not guaranteed offline). Mic pauses while Bags speaks: dictation + spoken replies, not barge-in.':'Speech recognition unavailable in this browser. Text still works (try Chrome on Android).';
if(SR){rec=new SR();rec.lang='en-GB';rec.interimResults=true;rec.continuous=false;
 rec.onresult=e=>{let fin='',part='';for(const r of e.results)(r.isFinal?fin+=r[0].transcript:part+=r[0].transcript);$('#partial').textContent=part;if(fin){$('#partial').textContent='';send(fin.trim())}};
 rec.onend=()=>{if(hands&&!speaking)try{rec.start()}catch{}};rec.onerror=e=>{if(e.error=='not-allowed'){setHands(false);add('sys','Microphone permission denied.','system')}}}
function setHands(v){hands=v&&!!SR&&agent.live;$('#handsfree').setAttribute('aria-pressed',hands);$('#handsfree').textContent='🎙 Hands-free: '+(hands?'on':'off');if(hands)try{rec.start()}catch{}else rec&&rec.abort()}
$('#handsfree').onclick=()=>setHands(!hands);
$('#stop').onclick=()=>{tts&&tts.cancel();speaking=false;setHands(false);api('interrupt',{method:'POST',body:{}})};
function say(t){if(!tts)return;speaking=true;rec&&rec.abort();const u=new SpeechSynthesisUtterance(t);u.lang='en-GB';const v=tts.getVoices().find(v=>v.lang=='en-GB');if(v)u.voice=v;u.onend=()=>{speaking=false;if(hands)try{rec.start()}catch{}};tts.speak(u)}
// ---- chat ----
async function send(t){if(!t)return;add('me',t,'You');if(!agent.live){add('sys',agent.name+' is disconnected — no runtime bridge yet. No reply is generated on their behalf.','system');return}
 const r=await api('chat',{method:'POST',body:{agent_id:agent.id,text:t}});const txt=r.data.reply||('Error: '+(r.data.error||r.status));add('bot',txt,'Bags · '+(r.data.source||'mock'));if(hands||$('#tSpeak').checked)say(txt)}
$('#composer').onsubmit=e=>{e.preventDefault();send($('#msg').value.trim());$('#msg').value=''};
// ---- org ----
function pick(a){tts&&tts.cancel();setHands(false);agent=a;$('#agentHdr').textContent=a.name+' · '+a.role+(a.live?'':' (disconnected)');render();document.querySelector('[data-tab=chat]').click()}
const sp=([id,name,role])=>({id,name,role,live:false});
function tree(){const o=ORG,row=(a,cls='')=>`<div class="${cls}" data-id="${a.id}" role="button" tabindex="0"><b>${a.name}</b> <span class="muted small">${a.role}</span> ${a.live?'<span class="pill">mock live</span>':'<span class="off">disconnected</span>'}</div>`;
 $('#tree').innerHTML=`<div class="ceo">${row(o.personal)}</div><div class="ceo">${row(o.governance)}</div>`+o.ceos.map(c=>`<div class="ceo"><h4>${row(c)}</h4>${c.specialists.map(s=>row(sp(s),'sp')).join('')}</div>`).join('');
 const all=allAgents();$('#tree').querySelectorAll('[data-id]').forEach(el=>el.onclick=()=>pick(all.find(a=>a.id==el.dataset.id)));
 $('#mParts').innerHTML=all.map(a=>`<label><input type="checkbox" value="${a.id}" ${a.id==o.personal.id?'checked disabled':''}> ${a.name} <span class="muted small">${a.role}</span></label>`).join('')}
function allAgents(){const o=ORG;return[o.personal,o.governance,...o.ceos.flatMap(c=>[c,...c.specialists.map(sp)])]}
tree();
// ---- meetings ----
$('#mCreate').onclick=async()=>{const parts=[...$('#mParts').querySelectorAll('input:checked')].map(i=>i.value);
 const r=await api('meetings',{method:'POST',body:{project:$('#mProject').value,agenda:$('#mAgenda').value,participants:parts,context_approved:$('#mOk').checked,confirmed:true}});
 if(!r.ok)return alert(r.data.error);loadMeetings();openMeeting(r.data.id)};
async function loadMeetings(){const r=await api('meetings');$('#mList').innerHTML=(r.data.meetings||[]).map(m=>`<div class="card" role="button" onclick="openMeeting('${m.id}')"><b>${esc(m.project)}</b> <span class="muted small">${m.participants.length} participants · ${m.entries.length} entries</span></div>`).join('')}
const nm=id=>(allAgents().find(a=>a.id==id)||{name:id}).name;
window.openMeeting=async id=>{const m=(await api('meetings/'+id)).data;
 $('#mView').innerHTML=`<div class="meeting"><h3>${esc(m.project)}</h3><p class="small muted">State: ${m.state} · runtime ${m.runtime} · floor: ${m.active_speaker} · automatic turns ${m.automatic_turns}</p><p>${esc(m.agenda)}</p>
 <p class="small">Participants: ${m.participants.map(nm).join(', ')}</p>
 <div>${m.entries.map(e=>`<div class="b"><span class="src">${e.kind} · ${e.speaker} (${e.source})${e.owner_agent_id?' · owner '+nm(e.owner_agent_id):''}${e.deadline?' · due '+e.deadline:''}</span>${esc(e.text)}</div>`).join('')||'<p class="muted small">No entries.</p>'}</div>
 <select id="eKind"><option value="note">note</option><option value="decision">decision</option><option value="action_item">action item</option></select>
 <select id="eOwner"><option value="">no owner</option><option value="user">me</option>${m.participants.map(p=>`<option value="${p}">${nm(p)}</option>`).join('')}</select>
 <input id="eDate" type="date"><textarea id="eText" placeholder="Record minute (attributed to you)"></textarea><button id="eAdd">Add entry</button>
 <select id="tSpk">${m.participants.map(p=>`<option value="${p}">${nm(p)}</option>`).join('')}</select><button id="eTurn">Request agent turn</button>
 <button id="eMin">Download minutes</button><button class="danger" id="eDel">Erase meeting</button></div>`;
 $('#eAdd').onclick=async()=>{await api(`meetings/${id}/entries`,{method:'POST',body:{kind:$('#eKind').value,text:$('#eText').value,owner_agent_id:$('#eOwner').value||undefined,deadline:$('#eDate').value||undefined,confirmed:true}});openMeeting(id);loadMeetings()};
 $('#eTurn').onclick=async()=>{const r=await api(`meetings/${id}/turn`,{method:'POST',body:{speaker_id:$('#tSpk').value,confirmed:true}});alert(r.ok?'Floor: '+r.data.active_speaker:r.status+' '+r.data.error)};
 $('#eMin').onclick=()=>{const L=[`# ${m.project}`,'',`Agenda: ${m.agenda}`,'','Participants: '+m.participants.map(nm).join(', '),'',...m.entries.map(e=>`- [${e.kind}] ${e.text} (recorded by user${e.owner_agent_id?', owner '+nm(e.owner_agent_id):''}${e.deadline?', due '+e.deadline:''})`),'','No demo artifact produced.'];const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([L.join('\n')],{type:'text/markdown'}));a.download='minutes.md';a.click()};
 $('#eDel').onclick=async()=>{if(confirm('Erase this meeting workspace?')){await api('meetings/'+id,{method:'DELETE'});$('#mView').innerHTML='';loadMeetings()}}};
// ---- tasks ----
let cursor=+localStorage.cursor||0;
$('#tStatus').onclick=async()=>{await api('tasks',{method:'POST',body:{action:'server_status',confirmed:true}});loadTasks()};
async function loadTasks(){const r=await api('tasks');$('#tList').innerHTML=(r.data.tasks||[]).map(t=>`<div class="card"><b>${t.action}</b> · ${t.status}<div class="small muted">${esc(t.result||'')}</div></div>`).join('')||'<p class="muted">No tasks.</p>'}
setInterval(async()=>{if(document.hidden)return;const r=await api('events?after='+cursor);for(const e of r.data.events||[]){add('sys',e.speech,'task event');if($('#tSpeak').checked)say(e.speech)}cursor=r.data.next_cursor??cursor;localStorage.cursor=cursor},3000);
add('bot','Good evening, sir. Bags at your service — type or switch on hands-free.','Bags · mock');
