// Browser lifecycle tests with explicit DOM/media fixtures. No real device/model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../companion/static/app.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '../companion/static/meetings.js'), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; };
function harness() {
  class Element {
    constructor() { this.children = []; this.value = ''; this.disabled = false; this.hidden = false; this.checked = false; this.files = []; this.classList = {toggle(){}}; this.selectedOptions = [{textContent: 'Bags'}]; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = items; }
    remove() {} scrollIntoView() {}
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0]; }
  }
  const elements = new Map();
  const document = {hidden: false, getElementById(id) { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); }, createElement(){return new Element();}, createTextNode(text){return {textContent: text};}, addEventListener(){}};
  const media = deferred(); const resume = deferred(); const counts = {sources: 0, mediaRequests: 0};
  class Audio {
    constructor(){this.currentTime=0;this.sampleRate=48000;this.destination={};}
    resume(){return resume.promise;} close(){return Promise.resolve();}
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
    createScriptProcessor(){return {connect(){},disconnect(){}};}
    createBuffer(channels,count){return {getChannelData(){return new Float32Array(count);},duration: count/24000};}
    createBufferSource(){counts.sources++;return {connect(){},start(){},stop(){}};}
  }
  class Socket {
    static OPEN = 1;
    constructor(){this.readyState=1;this.bufferedAmount=0;this.sent=[];}
    send(data){this.sent.push(data);} close(){this.readyState=3;}
  }
  const recognizers=[];
  class Recognition {constructor(){recognizers.push(this);} start(){} abort(){} }
  const context = {console,URL,ArrayBuffer,DataView,Float32Array,Map,Set,Promise,JSON,WebSocket:Socket,AudioContext:Audio,
    SpeechSynthesisUtterance:class{}, document,location:{href:'http://127.0.0.1:8768/',protocol:'http:'},
    navigator:{mediaDevices:{getUserMedia(){counts.mediaRequests++;return media.promise;}}},
    confirm:()=>true,fetch:()=>new Promise(()=>{}), setInterval:()=>1,clearInterval(){},
    window:{isSecureContext:true,speechSynthesis:{cancel(){},speak(){}},SpeechRecognition:Recognition,addEventListener(){}}};
  vm.createContext(context); vm.runInContext(source,context);
  const run = code => vm.runInContext(code,context);
  run("token='fixture-token';socket=new WebSocket();ready=true;paused=false;provider={name:'fixture-not-ai',state:'configured',capabilities:{text:true,realtime_audio:true,vision:true}};");
  return {run, context, elements, media, resume, counts, recognizers};
}
function stream() { const track={stopped:false,stop(){this.stopped=true;}}; return {track,getTracks(){return [track];}}; }

test('late pairing cannot undo device lock', async () => {
  const h=harness(), pair=deferred();
  h.context.AbortSignal=AbortSignal;
  h.context.fetch=url => String(url).endsWith('/api/pair') ? pair.promise : Promise.resolve({ok:true,status:204,json:async()=>({})});
  const pending=h.run("$('pairform').onsubmit({preventDefault(){}})");
  await h.run("$('disconnect').onclick()");
  pair.resolve({ok:true,status:200,json:async()=>({token:'late-fixture-token',session_id:'late'})});
  await pending;
  assert.equal(h.run('token'),'');
  assert.equal(h.run('ready'),false);
});
test('pause stops camera before async audio close and cannot overtake resume', async () => {
  const h=harness(), closing=deferred(), camera=stream();
  h.context.closing=closing; h.context.fixtureCamera=camera;
  h.run('micContext={close:()=>closing.promise};cameraStream=fixtureCamera');
  const pending=h.run('pause()');
  assert.equal(camera.track.stopped,true);
  h.run("$('resume').onclick()"); closing.resolve(); await pending;
  assert.deepEqual(JSON.parse(h.run("JSON.stringify(socket.sent.map(x=>JSON.parse(x).type).filter(x=>x.startsWith('privacy.')))")),['privacy.pause','privacy.resume']);
});
test('pending mic acquisition cannot migrate into a reconnected session', async () => {
  const h=harness(), s=stream();
  const pending=h.run("$('mic').onclick()");
  await h.run('connect()'); h.run('ready=true');
  h.media.resolve(s); await pending;
  assert.equal(s.track.stopped,true);
  assert.equal(h.run('!!micStream'),false);
});
test('repeated camera click cancels pending acquisition rather than orphaning tracks', async () => {
  const h=harness(), s=stream();
  const first=h.run("$('camera').onclick()");
  const second=h.run("$('camera').onclick()");
  h.media.resolve(s); await Promise.all([first,second]);
  assert.equal(h.counts.mediaRequests,1);
  assert.equal(s.track.stopped,true);
  assert.equal(h.run('!!cameraStream'),false);
});
test('late dictation result is never sent to the new socket', async () => {
  const h=harness(); h.run('provider.capabilities.realtime_audio=false');
  await h.run("$('mic').onclick()"); const old=h.recognizers[0];
  await h.run('connect()'); h.run('ready=true');
  old.onresult({results:[[{transcript:'private old-session words'}]]});
  assert.equal(h.run("socket.sent.filter(x=>JSON.parse(x).type==='text').length"),0);
});
test('interrupt invalidates audio awaiting resume before it creates a source', async () => {
  const h=harness(); const output=h.run('audioOutput(new ArrayBuffer(8))');
  h.run('stopPlayback()'); h.resume.resolve(); await output;
  assert.equal(h.counts.sources,0);
});
test('a completed old-session poll cannot append to a new conversation', async () => {
  const h=harness(), pending=[];
  h.context.fetch=(url)=> {const d=deferred();pending.push({url:String(url),d});return d.promise;};
  const poll=h.run('refreshTasks()'); await h.run('connect()'); h.run('ready=true');
  for(const item of pending) item.d.resolve({ok:true,status:200,json:async()=>item.url.includes('/api/tasks')?{tasks:[]}:{events:[{id:1,speech:'private old update'}],next_cursor:1}});
  await poll;
  assert.equal(h.elements.get('messages')?.children.length || 0,0);
});
