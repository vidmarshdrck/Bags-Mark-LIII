const $=s=>document.querySelector(s),esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let useMock=false;const markMock=()=>{useMock=true;$('#conn').textContent='in-browser mock'};
const api0=(p,o={})=>fetch('api/'+p,{headers:{'Content-Type':'application/json'},...o,body:o.body&&JSON.stringify(o.body)}).then(async r=>({ok:r.ok,status:r.status,data:await r.json().catch(()=>({}))}));
const api=(p,o={})=>useMock?mockApi(p,o):api0(p,o).then(r=>{if(r.status==404&&r.data.error===undefined){markMock();return mockApi(p,o)}return r}).catch(()=>{markMock();return mockApi(p,o)});
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js');
let agent={...ORG.personal},logs={},hands=false,speaking=false;
// ---------- bottom tab bar ----------
function go(tab){document.querySelectorAll('.tabbar button').forEach(b=>{const on=b.dataset.tab==tab;b.classList.toggle('on',on);on?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current')});
 document.querySelectorAll('.tab').forEach(s=>s.classList.toggle('on',s.id==tab));document.body.classList.toggle('no-dock',tab!='chat');
 if(tab=='tasks')loadTasks();if(tab=='meet')loadMeetings();if(tab=='chat')scrollEnd();else scrollTo(0,0)}
document.querySelectorAll('.tabbar button').forEach(b=>b.onclick=()=>go(b.dataset.tab));
// ---------- chat log ----------
const scrollEnd=()=>requestAnimationFrame(()=>scrollTo({top:document.body.scrollHeight,behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'}));
function add(who,text,src,extra={}){(logs[agent.id]??=[]).push({who,text,src,...extra});render()}
function render(){$('#log').innerHTML=(logs[agent.id]||[]).map((m,i)=>`<div class="b ${m.who}"><span class="src">${esc(m.src)}</span>${m.audio?`<audio controls preload="metadata" src="${m.audio}"></audio><div class="tr">${m.text?'Transcript: '+esc(m.text):esc(m.note||'No transcript')}</div>`:esc(m.text)}</div>`).join('');scrollEnd()}
async function ask(text,meta){if(!agent.live){add('sys',`${agent.name} is disconnected. No reply is generated on their behalf.`,'System');return}
 const r=await api('chat',{method:'POST',body:{agent_id:agent.id,text,...meta}});const t=r.data.reply||('Error: '+(r.data.error||r.status));
 add('bot',t,'Bags · '+(r.data.source||'mock'));if(hands||$('#tSpeak').checked||meta?.voice)say(t)}
function sendText(t){t=(t||'').trim();if(!t)return;add('me',t,'You');ask(t)}
$('#composer').onsubmit=e=>{e.preventDefault();sendText($('#msg').value);$('#msg').value='';$('#msg').focus()};
// ---------- speech synthesis + recognition (Web Speech API, free, browser-provided) ----------
const SR=window.SpeechRecognition||window.webkitSpeechRecognition,tts=window.speechSynthesis;
function say(t){if(!tts)return;speaking=true;$('#stop').hidden=false;try{hfRec&&hfRec.abort()}catch{}
 const u=new SpeechSynthesisUtterance(t);u.lang='en-GB';const v=tts.getVoices().find(v=>v.lang=='en-GB');if(v)u.voice=v;
 u.onend=u.onerror=()=>{speaking=false;$('#stop').hidden=true;if(hands)startHF()};tts.cancel();tts.speak(u)}
$('#stop').onclick=()=>{tts&&tts.cancel();speaking=false;$('#stop').hidden=true;api('interrupt',{method:'POST',body:{}})};
let hfRec;function startHF(){if(!SR||!hands||speaking)return;hfRec=new SR();hfRec.lang='en-GB';hfRec.interimResults=true;
 hfRec.onresult=e=>{let f='',p='';for(const r of e.results)r.isFinal?f+=r[0].transcript:p+=r[0].transcript;$('#partial').textContent=p;if(f){$('#partial').textContent='';sendText(f)}};
 hfRec.onerror=e=>{if(e.error=='not-allowed'||e.error=='service-not-allowed'){setHands(false);add('sys','Microphone permission denied. Typing still works.','System')}};
 hfRec.onend=()=>{if(hands&&!speaking)setTimeout(startHF,250)};try{hfRec.start()}catch{}}
function setHands(v){if(v&&!SR){add('sys','Hands-free needs speech recognition, which this browser lacks. Try Chrome on Android. Typing and voice notes still work.','System');v=false}
 hands=v;$('#handsfree').setAttribute('aria-pressed',v);if(v){add('sys','Hands-free on: speak, pause, and Bags answers aloud. The mic pauses while Bags talks.','System');startHF()}else{try{hfRec&&hfRec.abort()}catch{};$('#partial').textContent=''}}
$('#handsfree').onclick=()=>setHands(!hands);
// ---------- voice notes: hold to record (MediaRecorder), transcript via Web Speech where supported ----------
const recBtn=$('#rec');let mr,chunks,stream,noteSR,noteText,t0,timer,cancelled,starting=false,pressed=false;
const fallback=msg=>{add('sys',msg+' You can still type your message.','System');$('#msg').focus()};
async function recStart(e){e.preventDefault();pressed=true;if(starting||mr)return;
 if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)return fallback('Voice notes are not supported in this browser.');
 starting=true;try{stream=await navigator.mediaDevices.getUserMedia({audio:true})}catch(err){starting=false;pressed=false;
  return fallback(err.name=='NotAllowedError'?'Microphone permission was denied, so the voice note was not recorded.':'No microphone is available ('+err.name+').')}
 starting=false;if(!pressed){stream.getTracks().forEach(t=>t.stop());return add('sys','Hold the mic button to record.','System')}
 chunks=[];cancelled=false;noteText='';mr=new MediaRecorder(stream);mr.ondataavailable=d=>d.data.size&&chunks.push(d.data);mr.onstop=finish;mr.start();
 if(SR){noteSR=new SR();noteSR.lang='en-GB';noteSR.continuous=true;noteSR.interimResults=true;noteSR.onresult=e=>{let f='',p='';for(const r of e.results)r.isFinal?f+=r[0].transcript:p+=r[0].transcript;noteText=f;$('#partial').textContent=(f+' '+p).trim()};try{noteSR.start()}catch{}}
 t0=Date.now();recBtn.classList.add('rec');$('#recHint').hidden=false;timer=setInterval(()=>{const s=Math.floor((Date.now()-t0)/1e3);$('#recTime').textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');if(s>=120)recStop()},250)}
function recStop(cancel){pressed=false;if(!mr)return;cancelled=!!cancel;clearInterval(timer);recBtn.classList.remove('rec');$('#recHint').hidden=true;try{noteSR&&noteSR.stop()}catch{};mr.state!='inactive'&&mr.stop();stream.getTracks().forEach(t=>t.stop())}
function finish(){const dur=(Date.now()-t0)/1e3,blob=new Blob(chunks,{type:mr.mimeType||'audio/webm'});mr=null;
 setTimeout(()=>{const txt=(noteText||$('#partial').textContent||'').trim();$('#partial').textContent='';
  if(cancelled)return add('sys','Voice note cancelled.','System');if(dur<0.6)return add('sys','Too short. Hold the mic button while you speak.','System');
  add('me',txt,`You · voice note ${dur.toFixed(1)}s`,{audio:URL.createObjectURL(blob),note:SR?'No speech detected':'Transcript unavailable in this browser'});
  ask(txt||`[voice note, ${dur.toFixed(1)}s, no transcript]`,{voice:true,duration:+dur.toFixed(1),transcribed:!!txt})},400)}
recBtn.addEventListener('pointerdown',recStart);recBtn.addEventListener('pointerup',()=>recStop(false));
recBtn.addEventListener('pointerleave',()=>pressed&&recStop(true));recBtn.addEventListener('pointercancel',()=>recStop(true));
recBtn.addEventListener('contextmenu',e=>e.preventDefault());
recBtn.addEventListener('keydown',e=>{if((e.key==' '||e.key=='Enter')&&!e.repeat)recStart(e)});recBtn.addEventListener('keyup',e=>{if(e.key==' '||e.key=='Enter')recStop(false)});
// ---------- agents ----------
const sp=([id,name,role])=>({id,name,role,live:false});
const allAgents=()=>{const o=ORG;return[o.personal,o.governance,...o.ceos.flatMap(c=>[c,...c.specialists.map(sp)])]};
function pick(a){tts&&tts.cancel();setHands(false);agent=a;$('#agentHdr').textContent=a.name+' · '+a.role+(a.live?'':' (disconnected)');$('#msg').disabled=!a.live;$('#msg').placeholder=a.live?'Message '+a.name:a.name+' is disconnected';render();go('chat')}
function tree(){const o=ORG,row=a=>`<button class="agent" data-id="${a.id}"><b>${esc(a.name)}</b><span class="r">${esc(a.role)}</span><span class="st ${a.live?'live':''}">${a.live?'MOCK LIVE':'DISCONNECTED'}</span></button>`;
 $('#tree').innerHTML=`<div class="glass unit">${row(o.personal)}${row(o.governance)}</div>`+o.ceos.map(c=>`<div class="glass unit">${row(c)}<div class="sub">${c.specialists.map(s=>row(sp(s))).join('')}</div></div>`).join('');
 const all=allAgents();$('#tree').querySelectorAll('[data-id]').forEach(el=>el.onclick=()=>pick(all.find(a=>a.id==el.dataset.id)));
 $('#mParts').innerHTML=all.map(a=>`<label><input type="checkbox" value="${a.id}" ${a.id==o.personal.id?'checked disabled':''}> ${esc(a.name)} <span class="note">${esc(a.role)}</span></label>`).join('')}
tree();
// ---------- meetings ----------
const nm=id=>(allAgents().find(a=>a.id==id)||{name:id}).name;
$('#mCreate').onclick=async()=>{const parts=[...$('#mParts').querySelectorAll('input:checked')].map(i=>i.value);
 const r=await api('meetings',{method:'POST',body:{project:$('#mProject').value,agenda:$('#mAgenda').value,participants:parts,context_approved:$('#mOk').checked,confirmed:true}});
 if(!r.ok)return alert('Approve the shared context first.');loadMeetings();openMeeting(r.data.id)};
async function loadMeetings(){const r=await api('meetings');$('#mList').innerHTML=(r.data.meetings||[]).map(m=>`<button class="card agent" onclick="openMeeting('${m.id}')"><b>${esc(m.project)}</b><span class="r">${m.participants.length} participants · ${m.entries.length} entries</span></button>`).join('')||'<p class="note">No meetings yet.</p>'}
window.openMeeting=async id=>{const m=(await api('meetings/'+id)).data;
 $('#mView').innerHTML=`<div class="glass panel"><h2>${esc(m.project)}</h2><p class="note">State ${m.state} · runtime ${m.runtime} · floor ${m.active_speaker} · automatic turns ${m.automatic_turns}</p><p>${esc(m.agenda)}</p>
 <p class="note">Participants: ${m.participants.map(nm).map(esc).join(', ')}</p>
 <div>${m.entries.map(e=>`<div class="card"><div class="m">${e.kind} · ${e.speaker} (${e.source})${e.owner_agent_id?' · owner '+esc(nm(e.owner_agent_id)):''}${e.deadline?' · due '+e.deadline:''}</div>${esc(e.text)}</div>`).join('')||'<p class="note">No entries.</p>'}</div>
 <div class="row"><select id="eKind"><option value="note">Note</option><option value="decision">Decision</option><option value="action_item">Action item</option></select>
 <select id="eOwner"><option value="">No owner</option><option value="user">Me</option>${m.participants.map(p=>`<option value="${p}">${esc(nm(p))}</option>`).join('')}</select><input id="eDate" type="date"></div>
 <textarea id="eText" rows="2" placeholder="Record a minute (attributed to you)"></textarea><button id="eAdd" class="primary">Add entry</button>
 <div class="row"><select id="tSpk">${m.participants.map(p=>`<option value="${p}">${esc(nm(p))}</option>`).join('')}</select><button id="eTurn">Request turn</button></div>
 <div class="row"><button id="eMin">Download minutes</button><button class="danger" id="eDel">Erase meeting</button></div></div>`;
 $('#eAdd').onclick=async()=>{await api(`meetings/${id}/entries`,{method:'POST',body:{kind:$('#eKind').value,text:$('#eText').value,owner_agent_id:$('#eOwner').value||undefined,deadline:$('#eDate').value||undefined,confirmed:true}});openMeeting(id);loadMeetings()};
 $('#eTurn').onclick=async()=>{const r=await api(`meetings/${id}/turn`,{method:'POST',body:{speaker_id:$('#tSpk').value,confirmed:true}});alert(r.ok?'Floor: '+r.data.active_speaker:'Not available: '+r.data.error)};
 $('#eMin').onclick=()=>{const L=[`# ${m.project}`,'',`Agenda: ${m.agenda}`,'','Participants: '+m.participants.map(nm).join(', '),'',...m.entries.map(e=>`- [${e.kind}] ${e.text} (recorded by user${e.owner_agent_id?', owner '+nm(e.owner_agent_id):''}${e.deadline?', due '+e.deadline:''})`),'','No demo artifact produced.'];const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([L.join('\n')],{type:'text/markdown'}));a.download='minutes.md';a.click()};
 $('#eDel').onclick=async()=>{if(confirm('Erase this meeting workspace?')){await api('meetings/'+id,{method:'DELETE'});$('#mView').innerHTML='';loadMeetings()}}};
// ---------- tasks ----------
let cursor=+localStorage.cursor||0;
$('#tStatus').onclick=async()=>{await api('tasks',{method:'POST',body:{action:'server_status',confirmed:true}});loadTasks()};
async function loadTasks(){const r=await api('tasks');$('#tList').innerHTML=(r.data.tasks||[]).map(t=>`<div class="card"><b>${t.action}</b> · ${t.status}<div class="m">${esc(t.result||'')}</div></div>`).join('')||'<p class="note">No tasks yet.</p>'}
setInterval(async()=>{if(document.hidden)return;const r=await api('events?after='+cursor);for(const e of r.data.events||[]){add('sys',e.speech,'Task event');if($('#tSpeak').checked)say(e.speech);loadTasks()}cursor=r.data.next_cursor??cursor;localStorage.cursor=cursor},3000);
add('bot','Good evening, sir. Type, hold the mic for a voice note, or switch on hands-free.','Bags · mock');
