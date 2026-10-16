'use strict';
const $=s=>document.querySelector(s),esc=t=>String(t??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const kb=n=>n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KB':(n/1048576).toFixed(1)+' MB';
// Deployment base: served by the companion backend under /valet/, so the API lives one level up (keeps any /bags-mark/ proxy prefix).
const BASE=new URL(location.pathname.includes('/valet/')?'../':'./',location.href);
const U=p=>new URL(p,BASE).toString();
if('serviceWorker'in navigator)navigator.serviceWorker.register('sw.js');

/* ================= backend adapter: companion protocol v1, mock fallback ================= */
const B={mode:'detecting',token:null,expires:0,provider:null,ws:null,wsReady:false,pending:null};
async function http(path,o={}){const h={...(o.headers||{})};if(B.token)h.Authorization='Bearer '+B.token;
 let body=o.body;if(body&&!(body instanceof Blob)&&typeof body!='string'){body=JSON.stringify(body);h['Content-Type']='application/json'}
 const r=await fetch(U(path),{method:o.method||'GET',headers:h,body});const d=await r.json().catch(()=>({}));
 if(r.status==401&&B.token){B.token=null;closeWS();setConn();sys('Session expired. Pair again from the connection panel.')}return{ok:r.ok,status:r.status,data:d}}
const api=(p,o={})=>B.mode=='server'?http('api/'+p,o):mockApi(p,o);
async function detect(){try{const r=await fetch(U('health'),{cache:'no-store'});const d=await r.json();if(d&&d.protocol==1){B.mode='server';B.provider=d.provider;setConn();return}}catch{}B.mode='mock';setConn()}
function setConn(){const c=$('#conn'),n=$('#connNote');$('#pairForm').hidden=!(B.mode=='server'&&!B.token);$('#lockBtn').hidden=!(B.mode=='server'&&B.token);
 if(B.mode=='mock'){c.textContent='Offline demo';n.textContent='No Bags server found here, so replies come from the built-in demo. Nothing leaves this device.'}
 else if(!B.token){c.textContent='Pair device';n.textContent='Bags server found. Enter the one-time code from your private server to pair (it expires in 5 minutes).'}
 else{const st=B.provider?.state||'unknown';c.textContent=B.wsReady?'Connected':'Paired';n.textContent=`Paired. Text provider: ${B.provider?.name||'none'} (${st}). Session expires ${new Date(B.expires*1000).toLocaleTimeString()}.`}
 $('#provider').textContent=live.on?'Live session on':B.mode=='mock'?'Plain chat · demo':'Plain chat'}
$('#connBtn').onclick=()=>{const p=$('#connPanel');p.hidden=!p.hidden;$('#connBtn').setAttribute('aria-expanded',!p.hidden)};
$('#pairForm').onsubmit=async e=>{e.preventDefault();const code=$('#pairCode').value.trim();if(!code)return;
 const r=await fetch(U('api/pair'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});const d=await r.json().catch(()=>({}));$('#pairCode').value='';
 if(!r.ok)return sys('Pairing failed: '+(d.error||r.status)+'. Ask your server for a fresh code.');
 B.token=d.token;B.expires=d.expires_at;setConn();sys('Device paired. This session is separate from Telegram.');await loadRoster();openWS()};
$('#lockBtn').onclick=async()=>{if(!confirm('Erase all companion sessions, files, tasks and meetings for this device on the server?'))return;
 const r=await http('api/device',{method:'DELETE'}).catch(()=>({ok:false}));B.token=null;closeWS();logs={};render();setConn();sys(r.ok?'Device locked and erased on the server.':'Cleared locally. Server erase could not be confirmed.')};
function openWS(){if(B.mode!='server'||!B.token)return;closeWS();const w=new WebSocket(U('api/live').replace(/^http/,'ws'));B.ws=w;
 w.onopen=()=>w.send(JSON.stringify({type:'auth',token:B.token}));
 w.onmessage=ev=>{if(typeof ev.data!='string')return;const m=JSON.parse(ev.data);
  if(m.type=='ready'){B.wsReady=true;B.provider=m.provider;setConn();if(!m.provider?.capabilities?.text)sys('Connected, but no text provider is enabled on the server, so Bags cannot reply yet.')}
  else if(m.type=='text'||m.type=='transcript.output'){botText(m.text,'Bags · '+(B.provider?.name||'server'))}
  else if(m.type=='turn.complete'){flushBot()}
  else if(m.type=='error'){flushBot();sys(ERR[m.error]||('Server error: '+m.error))}};
 w.onclose=e=>{B.ws=null;B.wsReady=false;setConn();if(e.code==4401){B.token=null;setConn();sys('Session expired. Pair again.')}};
 clearInterval(B.ping);B.ping=setInterval(()=>B.ws?.readyState==1&&B.ws.send('{"type":"ping"}'),20000)}
function closeWS(){try{B.ws&&B.ws.close()}catch{}B.ws=null;B.wsReady=false}
const ERR={provider_unavailable:'No text provider is connected on the server, so Bags cannot reply yet.',provider_busy:'Bags is busy with another reply. Try again in a moment.',turn_busy:'Still answering your last message.',codex_text_failed_or_sandbox_blocked:'The text provider failed on the server. Nothing was sent elsewhere.',speech_layer_required:'Server voice is not available. Live session uses your browser speech instead.',attachment_not_supported:'The current provider cannot read attachments. The file is stored, not analysed.'};
let botBuf='',botTimer;function botText(t,src){botBuf+=t;clearTimeout(botTimer);botTimer=setTimeout(()=>flushBot(src),1500);B.src=src}
function flushBot(){clearTimeout(botTimer);if(!botBuf)return;const t=botBuf;botBuf='';add('bot',t,B.src||'Bags');if(live.on)say(t)}

/* ================= roster ================= */
const sp=([id,name,role])=>({id,name,role,live:false});
let roster=null;
async function loadRoster(){if(B.mode=='server'&&B.token){const r=await http('api/agents');if(r.ok){roster=r.data.agents.map(a=>({id:a.id,name:a.name,role:a.role||a.route,live:a.id=='bags'}));tree();return}}roster=null;tree()}
const allAgents=()=>roster||[ORG.personal,ORG.governance,...ORG.ceos.flatMap(c=>[c,...c.specialists.map(sp)])];
function tree(){const row=a=>`<button class="agent" data-id="${esc(a.id)}"><b>${esc(a.name)}</b><span class="r">${esc(a.role)}</span><span class="st ${a.live?'live':''}">${a.live?'Available':'Disconnected'}</span></button>`;
 $('#tree').innerHTML=roster?`<div class="glass unit">${roster.map(row).join('')}</div>`:`<div class="glass unit">${row(ORG.personal)}${row(ORG.governance)}</div>`+ORG.ceos.map(c=>`<div class="glass unit">${row(c)}<div class="sub">${c.specialists.map(s=>row(sp(s))).join('')}</div></div>`).join('');
 const all=allAgents();$('#tree').querySelectorAll('[data-id]').forEach(el=>el.onclick=()=>pick(all.find(a=>a.id==el.dataset.id)));
 $('#mParts').innerHTML=all.map(a=>`<label><input type="checkbox" value="${esc(a.id)}" ${a.id==all[0].id?'checked disabled':''}> ${esc(a.name)} <span class="note">${esc(a.role)}</span></label>`).join('')}
let agent={...ORG.personal},logs={};
async function pick(a){stopLive();if(B.mode=='server'&&B.token){const r=await http(`api/agents/${encodeURIComponent(a.id)}/session`,{method:'POST',body:{}});if(r.ok){B.token=r.data.token;openWS()}}
 agent=a;$('#agentHdr').textContent=a.name+' · '+a.role+(a.live?'':' (disconnected)');$('#msg').disabled=!a.live;$('#msg').placeholder=a.live?'Message '+a.name:a.name+' is disconnected';render();go('chat')}

/* ================= bottom tab bar ================= */
function go(tab){document.querySelectorAll('.tabbar button').forEach(b=>{const on=b.dataset.tab==tab;b.classList.toggle('on',on);on?b.setAttribute('aria-current','page'):b.removeAttribute('aria-current')});
 document.querySelectorAll('.tab').forEach(s=>s.classList.toggle('on',s.id==tab));document.body.classList.toggle('no-dock',tab!='chat');
 if(tab=='tasks')loadTasks();if(tab=='meet')loadMeetings();if(tab=='chat')scrollEnd();else scrollTo(0,0)}
document.querySelectorAll('.tabbar button').forEach(b=>b.onclick=()=>go(b.dataset.tab));

/* ================= chat log ================= */
const scrollEnd=()=>requestAnimationFrame(()=>scrollTo({top:document.body.scrollHeight,behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'auto':'smooth'}));
function add(who,text,src,extra={}){(logs[agent.id]??=[]).push({who,text,src,...extra});render()}
const sys=t=>add('sys',t,'System');
function attHTML(a){if(a.kind=='email')return`<div class="mailcard"><b>${esc(a.subject||'(no subject)')}</b><div class="m">From ${esc(a.from||'unknown')}${a.date?' · '+esc(a.date):''}</div><div>${esc(a.body.slice(0,160))}${a.body.length>160?'…':''}</div></div>`;
 return a.thumb?`<div class="att"><img src="${a.thumb}" alt="${esc(a.name)}"></div>`:`<div class="att"><svg><use href="#i-file"/></svg>${esc(a.name)} · ${kb(a.size)}${a.status?' · '+esc(a.status):''}</div>`}
function render(){$('#log').innerHTML=(logs[agent.id]||[]).map(m=>`<div class="b ${m.who}"><span class="src">${esc(m.src)}</span>${m.audio?`<audio controls preload="metadata" src="${m.audio}"></audio><div class="tr">${m.text?'Transcript: '+esc(m.text):esc(m.note||'No transcript')}</div>`:esc(m.text)}${(m.atts||[]).map(attHTML).join('')}</div>`).join('');scrollEnd()}

/* ================= attachments: files + emails ================= */
let atts=[];const SERVER_MIME=['image/jpeg','image/png','text/plain','application/pdf'],MAX=2*1048576;
function chips(){$('#chips').innerHTML=atts.map((a,i)=>`<div class="chip-f">${a.thumb?`<img src="${a.thumb}" alt="">`:`<svg><use href="#i-${a.kind=='email'?'mail':'file'}"/></svg>`}<span>${esc(a.kind=='email'?(a.subject||'Email'):a.name)}</span><small>${a.kind=='email'?'email':kb(a.size)}</small><button type="button" aria-label="Remove ${esc(a.name||a.subject)}" data-i="${i}"><svg><use href="#i-x"/></svg></button></div>`).join('');
 $('#chips').querySelectorAll('button').forEach(b=>b.onclick=()=>{atts.splice(+b.dataset.i,1);chips()})}
const menu=v=>{$('#attachMenu').hidden=!v;$('#attach').setAttribute('aria-expanded',v)};
$('#attach').onclick=()=>menu($('#attachMenu').hidden);
$('#pickFile').onclick=()=>{menu(false);$('#fileInput').click()};
$('#fileInput').onchange=e=>{for(const f of e.target.files){if(atts.length>=16){sys('Up to 16 attachments per message.');break}
 if(/\.eml$/i.test(f.name)||f.type=='message/rfc822'){f.text().then(t=>{atts.push(parseEmail(t,f.name));chips()});continue}
 atts.push({kind:'file',file:f,name:f.name,size:f.size,mime:f.type||'application/octet-stream',thumb:f.type.startsWith('image/')?URL.createObjectURL(f):null})}e.target.value='';chips()};
$('#pickEmail').onclick=()=>{menu(false);$('#emailSheet').hidden=false;$('#emlText').focus()};
$('#emlCancel').onclick=()=>{$('#emailSheet').hidden=true;$('#emlText').value=''};
$('#emlUpload').onclick=()=>$('#emlInput').click();
$('#emlInput').onchange=async e=>{const f=e.target.files[0];if(f){$('#emlText').value=await f.text()}e.target.value=''};
$('#emlAdd').onclick=()=>{const t=$('#emlText').value.trim();if(!t)return;atts.push(parseEmail(t,'pasted email'));chips();$('#emailSheet').hidden=true;$('#emlText').value=''};
function decodeQP(s){return s.replace(/=\r?\n/g,'').replace(/=([0-9A-F]{2})/gi,(_,h)=>String.fromCharCode(parseInt(h,16)))}
function decodeWord(s){return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi,(_,cs,enc,t)=>{try{const bytes=enc.toUpperCase()=='B'?Uint8Array.from(atob(t),c=>c.charCodeAt(0)):Uint8Array.from(decodeQP(t.replace(/_/g,' ')),c=>c.charCodeAt(0));return new TextDecoder(cs).decode(bytes)}catch{return t}})}
function parseEmail(raw,name){raw=raw.replace(/\r\n/g,'\n');const i=raw.indexOf('\n\n'),head=i<0?raw:raw.slice(0,i),body0=i<0?'':raw.slice(i+2);
 const H={};head.replace(/\n[ \t]+/g,' ').split('\n').forEach(l=>{const k=l.indexOf(':');if(k>0)H[l.slice(0,k).trim().toLowerCase()]=decodeWord(l.slice(k+1).trim())});
 let body=body0;const bm=/boundary="?([^";\n]+)"?/i.exec(H['content-type']||'');
 if(bm){const parts=body0.split('--'+bm[1]);const tp=parts.find(p=>/content-type:\s*text\/plain/i.test(p))||parts.find(p=>/content-type:\s*text\/html/i.test(p))||'';const j=tp.replace(/\r\n/g,'\n').indexOf('\n\n');body=j<0?tp:tp.slice(j+2);
  if(/quoted-printable/i.test(tp.slice(0,j)))body=decodeQP(body);else if(/base64/i.test(tp.slice(0,j)))try{body=new TextDecoder().decode(Uint8Array.from(atob(body.replace(/\s/g,'')),c=>c.charCodeAt(0)))}catch{}
  if(/text\/html/i.test(tp.slice(0,j)))body=body.replace(/<[^>]+>/g,' ')}
 else if(/quoted-printable/i.test(H['content-transfer-encoding']||''))body=decodeQP(body);
 body=body.replace(/\n{3,}/g,'\n\n').trim();
 if(!H.from&&!H.subject)return{kind:'email',name,from:'',subject:'Pasted text',date:'',to:'',body:raw.trim(),raw};
 return{kind:'email',name,from:H.from||'',to:H.to||'',subject:H.subject||'',date:H.date||'',body,raw}}
async function uploadAll(list){// companion: raw bytes, exact MIME, explicit consent header. Others stay on device.
 for(const a of list){if(B.mode!='server'){a.status='kept on device';continue}
  let blob,mime;if(a.kind=='email'){mime='text/plain';blob=new Blob([`From: ${a.from}\nTo: ${a.to}\nSubject: ${a.subject}\nDate: ${a.date}\n\n${a.body}`.slice(0,MAX)],{type:mime})}else{blob=a.file;mime=a.mime}
  if(!SERVER_MIME.includes(mime)){a.status='kept on device (server accepts JPEG, PNG, text, PDF)';continue}
  if(blob.size>MAX){a.status='kept on device (over 2 MB)';continue}
  const r=await http('api/uploads',{method:'POST',body:blob,headers:{'Content-Type':mime,'X-Upload-Consent':'yes'}});a.status=r.ok?'stored on server, not analysed':'upload failed: '+(r.data.error||r.status)}}

/* ================= send ================= */
async function send(text,meta={}){text=(text||'').trim();const list=atts;if(!text&&!list.length&&!meta.voice)return;
 if(!agent.live){add('me',text,'You',{atts:list.map(strip)});atts=[];chips();return sys(`${agent.name} is disconnected. No reply is generated on their behalf.`)}
 if(B.mode=='server'&&list.length){const desc=list.map(a=>a.kind=='email'?`email "${a.subject}"`:`${a.name} (${a.mime}, ${kb(a.size)})`).join(', ');if(!confirm(`Send to ${agent.name} on your server?\n${desc}`))return}
 atts=[];chips();await uploadAll(list);
 const emails=list.filter(a=>a.kind=='email');let full=text;// email text is shared as message context so Bags can read it
 for(const e of emails)full+=`\n\n[Attached email]\nFrom: ${e.from}\nSubject: ${e.subject}\nDate: ${e.date}\n${e.body}`;
 const files=list.filter(a=>a.kind=='file');if(files.length)full+=`\n\n[Attached files: ${files.map(f=>f.name+' '+kb(f.size)).join(', ')}]`;
 if(!meta.voice)add('me',text,'You',{atts:list.map(strip)});
 full=full.trim().slice(0,4096)||'[voice note with no transcript]';
 if(B.mode=='server'){if(!B.token)return sys('Pair this device first: tap the status button at the top.');if(!B.wsReady)return sys('Not connected to the server yet. Try again in a moment.');B.ws.send(JSON.stringify({type:'text',text:full}));return}
 const r=await mockApi('chat',{method:'POST',body:{text:full,...meta,files:files.length,emails:emails.map(e=>({subject:e.subject,from:e.from,body:e.body}))}});
 add('bot',r.data.reply,'Bags · demo');if(live.on||meta.voice)say(r.data.reply)}
const strip=a=>({kind:a.kind,name:a.name,size:a.size,thumb:a.thumb,status:a.status,subject:a.subject,from:a.from,date:a.date,body:a.body||''});
$('#composer').onsubmit=e=>{e.preventDefault();const t=$('#msg').value;$('#msg').value='';send(t);$('#msg').focus()};

/* ================= live session (off by default; starts only on tap) ================= */
const SR=window.SpeechRecognition||window.webkitSpeechRecognition,tts=window.speechSynthesis;const live={on:false,rec:null,speaking:false};
function say(t){if(!tts)return;live.speaking=true;try{live.rec&&live.rec.abort()}catch{}const u=new SpeechSynthesisUtterance(t);u.lang='en-GB';const v=tts.getVoices().find(v=>v.lang=='en-GB');if(v)u.voice=v;
 u.onend=u.onerror=()=>{live.speaking=false;if(live.on)listen()};tts.cancel();tts.speak(u)}
function listen(){if(!live.on||live.speaking||!SR)return;const r=new SR();live.rec=r;r.lang='en-GB';r.interimResults=true;
 r.onresult=e=>{let f='',p='';for(const x of e.results)x.isFinal?f+=x[0].transcript:p+=x[0].transcript;$('#partial').textContent=p;if(f.trim()){$('#partial').textContent='';send(f)}};
 r.onerror=e=>{if(e.error=='not-allowed'||e.error=='service-not-allowed'){stopLive();sys('Microphone permission denied, so the live session stopped. Typing still works.')}};
 r.onend=()=>{if(live.on&&!live.speaking)setTimeout(listen,300)};try{r.start()}catch{}}
function paintLive(){$('.livebar').classList.toggle('on',live.on);$('#liveBtn span').textContent=live.on?'End live session':'Start live session';$('#liveBtn').setAttribute('aria-pressed',live.on);
 $('#liveTitle').textContent=live.on?'Live session on':'Live session off';$('#liveNote').textContent=live.on?'Listening. Speak, pause, and Bags answers aloud. The mic pauses while Bags talks.':"Tap to talk hands-free. Uses your browser's speech, no paid service.";setConn()}
function startLive(){if(!SR){sys('This browser has no speech recognition, so a live session is not possible here. Try Chrome on Android. Typing and voice notes still work.');return}
 if(!agent.live)return sys(agent.name+' is disconnected.');live.on=true;paintLive();sys('Live session started.');listen()}
function stopLive(){if(!live.on)return;live.on=false;try{live.rec&&live.rec.abort()}catch{}tts&&tts.cancel();live.speaking=false;$('#partial').textContent='';paintLive();sys('Live session ended.');B.ws?.readyState==1&&B.ws.send('{"type":"interrupt"}')}
$('#liveBtn').onclick=()=>live.on?stopLive():startLive();
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopLive();if(mr)recStop(true)}});// sensors never keep running in background

/* ================= voice notes: hold to record ================= */
const recBtn=$('#rec');let mr,chunks,stream,noteSR,noteText,t0,timer,cancelled,starting=false,pressed=false;
const fallback=m=>{sys(m+' You can still type your message.');$('#msg').focus()};
async function recStart(e){e.preventDefault();pressed=true;if(starting||mr)return;if(live.on)stopLive();
 if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)return fallback('Voice notes are not supported in this browser.');
 starting=true;try{stream=await navigator.mediaDevices.getUserMedia({audio:true})}catch(err){starting=false;pressed=false;return fallback(err.name=='NotAllowedError'?'Microphone permission was denied, so the voice note was not recorded.':'No microphone is available.')}
 starting=false;if(!pressed){stream.getTracks().forEach(t=>t.stop());return sys('Hold the mic button to record.')}
 chunks=[];cancelled=false;noteText='';mr=new MediaRecorder(stream);mr.ondataavailable=d=>d.data.size&&chunks.push(d.data);mr.onstop=finish;mr.start();
 if(SR){noteSR=new SR();noteSR.lang='en-GB';noteSR.continuous=true;noteSR.interimResults=true;noteSR.onresult=e=>{let f='',p='';for(const r of e.results)r.isFinal?f+=r[0].transcript:p+=r[0].transcript;noteText=f;$('#partial').textContent=(f+' '+p).trim()};try{noteSR.start()}catch{}}
 t0=Date.now();recBtn.classList.add('rec');$('#recHint').hidden=false;timer=setInterval(()=>{const s=Math.floor((Date.now()-t0)/1e3);$('#recTime').textContent=Math.floor(s/60)+':'+String(s%60).padStart(2,'0');if(s>=120)recStop()},250)}
function recStop(cancel){pressed=false;if(!mr)return;cancelled=!!cancel;clearInterval(timer);recBtn.classList.remove('rec');$('#recHint').hidden=true;try{noteSR&&noteSR.stop()}catch{};mr.state!='inactive'&&mr.stop();stream.getTracks().forEach(t=>t.stop())}
function finish(){const dur=(Date.now()-t0)/1e3,blob=new Blob(chunks,{type:mr.mimeType||'audio/webm'});mr=null;
 setTimeout(()=>{const txt=(noteText||$('#partial').textContent||'').trim();$('#partial').textContent='';
  if(cancelled)return sys('Voice note cancelled.');if(dur<0.6)return sys('Too short. Hold the mic button while you speak.');
  add('me',txt,`You · voice note ${dur.toFixed(1)}s`,{audio:URL.createObjectURL(blob),note:SR?'No speech detected':'Transcript unavailable in this browser'});
  send(txt,{voice:true,duration:+dur.toFixed(1),transcribed:!!txt})},400)}
recBtn.addEventListener('pointerdown',recStart);recBtn.addEventListener('pointerup',()=>recStop(false));
recBtn.addEventListener('pointerleave',()=>pressed&&recStop(true));recBtn.addEventListener('pointercancel',()=>recStop(true));recBtn.addEventListener('contextmenu',e=>e.preventDefault());
recBtn.addEventListener('keydown',e=>{if((e.key==' '||e.key=='Enter')&&!e.repeat)recStart(e)});recBtn.addEventListener('keyup',e=>{if(e.key==' '||e.key=='Enter')recStop(false)});

/* ================= meetings (companion /api/meetings) ================= */
const nm=id=>(allAgents().find(a=>a.id==id)||{name:id}).name;
$('#mCreate').onclick=async()=>{if(!$('#mProject').value.trim()||!$('#mAgenda').value.trim())return alert('Add a project name and an agenda first.');if(!$('#mOk').checked)return alert('Tick the box to approve the shared context first.');const parts=[...$('#mParts').querySelectorAll('input:checked')].map(i=>i.value);
 const r=await api('meetings',{method:'POST',body:{project:$('#mProject').value.trim(),agenda:$('#mAgenda').value.trim(),participants:parts,context_approved:$('#mOk').checked,confirmed:true}});
 if(!r.ok)return alert(r.status==401?'Pair this device first.':'Approve the shared context first ('+(r.data.error||r.status)+').');loadMeetings();openMeeting(r.data.id)};
async function loadMeetings(){const r=await api('meetings');$('#mList').innerHTML=(r.data.meetings||[]).map(m=>`<button class="card agent" data-m="${esc(m.id)}"><b>${esc(m.project)}</b><span class="r">${esc(m.state||'')}</span></button>`).join('')||'<p class="note">No meetings yet.</p>';
 $('#mList').querySelectorAll('[data-m]').forEach(b=>b.onclick=()=>openMeeting(b.dataset.m))}
async function openMeeting(id){const m=(await api('meetings/'+id)).data,P=m.participants||[],E=m.entries||[];const pid=p=>typeof p=='string'?p:p.id;
 $('#mView').innerHTML=`<div class="glass panel"><h2>${esc(m.project)}</h2><p class="note">State ${esc(m.state)} · runtime ${esc(m.runtime)} · floor ${esc(m.active_speaker)} · automatic turns ${m.automatic_turns}</p><p>${esc(m.agenda)}</p>
 <p class="note">Participants: ${P.map(p=>esc(nm(pid(p)))).join(', ')}</p>
 <div>${E.map(e=>`<div class="card"><div class="m">${esc(e.kind)} · ${esc(e.speaker||e.speaker_id)} (${esc(e.source)})${e.owner_agent_id?' · owner '+esc(nm(e.owner_agent_id)):''}${e.deadline?' · due '+esc(e.deadline):''}</div>${esc(e.text)}</div>`).join('')||'<p class="note">No entries.</p>'}</div>
 <div class="row"><select id="eKind" aria-label="Entry type"><option value="note">Note</option><option value="decision">Decision</option><option value="action_item">Action item</option></select>
 <select id="eOwner" aria-label="Owner"><option value="">No owner</option><option value="user">Me</option>${P.map(p=>`<option value="${esc(pid(p))}">${esc(nm(pid(p)))}</option>`).join('')}</select><input id="eDate" type="date" aria-label="Deadline"></div>
 <textarea id="eText" rows="2" placeholder="Record a minute (attributed to you)"></textarea><button id="eAdd" class="primary">Add entry</button>
 <div class="row"><select id="tSpk" aria-label="Speaker">${P.map(p=>`<option value="${esc(pid(p))}">${esc(nm(pid(p)))}</option>`).join('')}</select><button id="eTurn">Request turn</button></div>
 <div class="row"><button id="eMin">Download minutes</button><button class="danger" id="eDel">Erase meeting</button></div></div>`;
 $('#eAdd').onclick=async()=>{const b={kind:$('#eKind').value,text:$('#eText').value,confirmed:true};if($('#eOwner').value)b.owner_agent_id=$('#eOwner').value;if($('#eDate').value)b.deadline=$('#eDate').value;const r=await api(`meetings/${id}/entries`,{method:'POST',body:b});if(!r.ok)alert('Could not add: '+(r.data.error||r.status));openMeeting(id)};
 $('#eTurn').onclick=async()=>{const r=await api(`meetings/${id}/turn`,{method:'POST',body:{speaker_id:$('#tSpk').value,confirmed:true}});alert(r.ok?'You have the floor.':r.data.error=='meeting_runtime_disconnected'?'That agent is not connected, so it cannot speak in meetings yet.':'Not available: '+r.data.error)};
 $('#eMin').onclick=async()=>{let txt;if(B.mode=='server'){const r=await fetch(U(`api/meetings/${id}/minutes`),{headers:{Authorization:'Bearer '+B.token}});txt=await r.text()}else txt=[`# ${m.project}`,'',`Agenda: ${m.agenda}`,'','Participants: '+P.map(p=>nm(pid(p))).join(', '),'',...E.map(e=>`- [${e.kind}] ${e.text} (recorded by user)`),'','No demo artifact produced.'].join('\n');
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([txt],{type:'text/markdown'}));a.download='minutes.md';a.click()};
 $('#eDel').onclick=async()=>{if(confirm('Erase this meeting workspace?')){await api('meetings/'+id,{method:'DELETE'});$('#mView').innerHTML='';loadMeetings()}}}

/* ================= tasks (companion /api/tasks + /api/events) ================= */
let cursor=0;
$('#tStatus').onclick=async()=>{const r=await api('tasks',{method:'POST',body:{action:'server_status',confirmed:true}});if(!r.ok)sys(r.status==401?'Pair this device first.':'Task refused: '+(r.data.error||r.status));loadTasks()};
async function loadTasks(){const r=await api('tasks');$('#tList').innerHTML=(r.data.tasks||[]).map(t=>`<div class="card"><b>${esc(t.action)}</b> · ${esc(t.status)}<div class="m">${esc(typeof t.result=='object'?JSON.stringify(t.result):t.result||'')}</div></div>`).join('')||'<p class="note">No tasks yet.</p>'}
setInterval(async()=>{if(document.hidden||(B.mode=='server'&&!B.token)||B.mode=='detecting')return;const r=await api('events?after='+cursor);if(!r.ok)return;for(const e of r.data.events||[]){sys(e.speech||e.type);if($('#tSpeak').checked)say(e.speech||'Task finished.');loadTasks()}cursor=r.data.next_cursor??cursor},3000);

/* ================= boot: plain chat, greeting, nothing live ================= */
tree();paintLive();add('bot','Good evening, sir. Type a message, attach a file or an email, or hold the mic for a voice note. Tap Start live session when you want to talk hands-free.','Bags');
detect().then(()=>{if(B.mode=='mock')mockApi('events?after=0').then(r=>cursor=r.data.next_cursor||0)});
