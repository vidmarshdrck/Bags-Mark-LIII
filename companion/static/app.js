'use strict';
// No provider keys, bearer persistence, untrusted innerHTML, or background sensors.
const $ = id => document.getElementById(id);
const base = new URL('./', location.href);
let token = '', socket, ready = false, provider = {}, agentId = 'bags', roster = [];
let micStream, cameraStream, processor, micContext, micSource, cameraTimer, pingTimer, pollTimer;
let recognition, outputContext, nextAudio = 0, playback = new Set(), cursor = 0, paused = false;
const transcripts = new Map();
let sessionGeneration = 0, micGeneration = 0, cameraGeneration = 0, playbackGeneration = 0, taskViewGeneration = 0;
let micPending = false, cameraPending = false, transitioning = false;
function note(text, who = 'system') {
  const article = document.createElement('article'); article.className = 'message ' + who;
  if (who === 'assistant') { const title = document.createElement('strong'); title.textContent = selectedName(); article.append(title); }
  article.append(document.createTextNode(text)); $('messages').append(article);
  while ($('messages').children.length > 100) $('messages').firstChild.remove();
  $('messages').scrollTop = $('messages').scrollHeight;
}
function selectedName() { return roster.find(a => a.id === agentId)?.name || 'Bags'; }
function send(event) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event)); }
async function api(path, options = {}) {
  const response = await fetch(new URL(path, base), {...options, headers: {Authorization: 'Bearer ' + token, ...options.headers}});
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed'); return data;
}
function capabilities() { return provider.capabilities || {text: provider.state === 'configured', realtime_audio: provider.name === 'gemini-live', vision: provider.name === 'gemini-live'}; }
function updateControls() {
  const canText = ready && !paused && provider.state === 'configured' && capabilities().text;
  $('text').disabled = $('send').disabled = !canText;
  $('mic').disabled = !canText; $('camera').disabled = !canText || !capabilities().vision;
  $('interrupt').disabled = !ready; $('file').disabled = !token;
  $('statusTask').disabled = !token; $('agent').disabled = !token || transitioning; $('reconnect').disabled = !token || transitioning;
  $('resume').hidden = !paused;
  $('mic').textContent = micPending ? 'Cancel mic request' : micStream || recognition ? 'Stop microphone' : capabilities().realtime_audio ? 'Start live voice' : 'Dictate text';
  $('mic').classList.toggle('active', !!micStream || !!recognition);
  $('camera').textContent = cameraPending ? 'Cancel camera request' : cameraStream ? 'Stop camera' : 'Camera off';
  $('camera').classList.toggle('active', !!cameraStream);
  $('privacy').textContent = `${micStream || recognition ? 'MICROPHONE ON' : 'Microphone off'} · ${cameraStream ? 'CAMERA ON' : 'camera off'} · ${paused ? 'paused; manual resume required' : 'no background capture'}`;
}
async function stopMic() {
  micGeneration++; micPending = false;
  if (recognition) { const old = recognition; recognition = null; old.abort(); }
  if (processor) { processor.disconnect(); processor.onaudioprocess = null; processor = null; }
  micSource?.disconnect(); micSource = null;
  micStream?.getTracks().forEach(t => t.stop()); micStream = null;
  if (micContext) { const old = micContext; micContext = null; await old.close(); }
  send({type: 'audio.end'}); updateControls();
}
function stopCamera() {
  cameraGeneration++; cameraPending = false;
  clearInterval(cameraTimer); cameraTimer = null;
  cameraStream?.getTracks().forEach(t => t.stop()); cameraStream = null;
  $('preview').srcObject = null; $('cameraPanel').hidden = true;
  send({type: 'camera.set', enabled: false}); updateControls();
}
function stopPlayback() {
  playbackGeneration++;
  for (const source of playback) { try { source.stop(); } catch (_) {} }
  playback.clear(); nextAudio = 0; window.speechSynthesis?.cancel();
}
function interrupt() { stopPlayback(); send({type: 'interrupt'}); }
function speak(text) {
  if (!$('spoken').checked || document.hidden || paused || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'en-GB';
  window.speechSynthesis.speak(utterance);
}
async function audioOutput(data) {
  if (paused || document.hidden) return;
  const generation = playbackGeneration, session = sessionGeneration, originSocket = socket;
  outputContext ||= new AudioContext(); await outputContext.resume();
  if (generation !== playbackGeneration || session !== sessionGeneration || socket !== originSocket || paused || document.hidden) return;
  const pcm = new DataView(data), count = Math.floor(data.byteLength / 2);
  const buffer = outputContext.createBuffer(1, count, 24000), channel = buffer.getChannelData(0);
  for (let i = 0; i < count; i++) channel[i] = pcm.getInt16(i * 2, true) / 32768;
  if (nextAudio - outputContext.currentTime > 2) stopPlayback();
  const source = outputContext.createBufferSource(); source.buffer = buffer; source.connect(outputContext.destination);
  playback.add(source); source.onended = () => playback.delete(source);
  nextAudio = Math.max(nextAudio, outputContext.currentTime); source.start(nextAudio); nextAudio += buffer.duration;
}
async function connect() {
  const generation = ++sessionGeneration, authToken = token;
  if (socket) { socket.onclose = null; socket.close(); }
  ready = false; paused = false; await stopMic(); stopCamera(); stopPlayback();
  if (generation !== sessionGeneration || !token) return;
  const url = new URL('api/live', base); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(url); socket.binaryType = 'arraybuffer';
  const connectedSocket = socket;
  socket.onopen = () => { if (socket === connectedSocket && generation === sessionGeneration) send({type: 'auth', token: authToken}); };
  socket.onmessage = event => {
    if (socket !== connectedSocket || generation !== sessionGeneration) return;
    if (event.data instanceof ArrayBuffer) { audioOutput(event.data).catch(() => note('Tap Interrupt, then reconnect to unlock audio playback.')); return; }
    const e = JSON.parse(event.data);
    if (e.type === 'ready') {
      ready = true; provider = e.provider; agentId = e.agent_id; $('connection').textContent = 'Paired';
      $('provider').textContent = `${provider.name} · ${provider.state}. ${provider.reason || 'Configured; realtime provider has not been live-verified.'}`;
      $('pairing').hidden = true; $('route').textContent = `${selectedName()} selected · separate companion session · ${agentId === 'bags' ? 'not Telegram memory' : 'actual runtime disconnected'}`;
      if (typeof loadMeetingRoster === 'function') loadMeetingRoster();
      updateControls();
    } else if (e.type === 'text' || e.type === 'transcript.output') {
      note(e.text, 'assistant'); if (!capabilities().realtime_audio) speak(e.text);
    } else if (e.type === 'transcript.input') note(e.text, 'user');
    else if (e.type === 'interrupted') stopPlayback();
    else if (e.type === 'error') { note(e.error); if (e.error === 'speech_layer_required') stopMic(); }
    else if (e.type === 'provider.reconnect_required') { pause(); note('Provider requires a new separate session. Tap Reconnect.'); }
  };
  socket.onclose = () => { if (socket !== connectedSocket || generation !== sessionGeneration) return; ready = false; stopMic(); stopCamera(); stopPlayback(); $('connection').textContent = 'Disconnected'; updateControls(); };
  socket.onerror = () => note('Connection failed. Check HTTPS routing and server availability.');
  clearInterval(pingTimer); pingTimer = setInterval(() => send({type: 'ping'}), 20000);
  clearInterval(pollTimer); pollTimer = setInterval(() => { if (!document.hidden) refreshTasks().catch(() => {}); }, 3000);
}
async function loadRoster() {
  const data = await api('api/agents'); roster = data.agents; agentId = data.selected;
  $('agent').replaceChildren(...roster.map(agent => { const option = document.createElement('option'); option.value = agent.id; option.textContent = `${agent.name} · ${agent.route === 'disconnected' ? 'disconnected' : 'personal butler'}`; return option; }));
  $('agent').value = agentId;
  if (typeof loadMeetingRoster === 'function') loadMeetingRoster();
}
async function refreshTasks() {
  if (!token) return;
  const session = sessionGeneration, view = taskViewGeneration;
  const scope = $('shared').checked ? '&scope=all' : '';
  const [tasks, events] = await Promise.all([api('api/tasks?' + (scope ? 'scope=all' : '')), api(`api/events?after=${cursor}${scope}`)]);
  if (session !== sessionGeneration || view !== taskViewGeneration) return;
  $('tasks').replaceChildren(...tasks.tasks.map(task => { const row = document.createElement('div'); row.className = 'task'; const title = document.createElement('b'); title.textContent = `${task.agent_name || selectedName()} · ${task.action}`; row.append(title, document.createTextNode(task.status)); return row; }));
  if (!tasks.tasks.length) $('tasks').textContent = 'No tasks in this view.';
  for (const e of events.events) {
    if (e.id <= cursor) continue;
    note(`${e.agent_name || selectedName()}: ${e.speech}`);
    speak(`${e.agent_name || selectedName()}: ${e.speech}`);
    if ($('notifications').checked && 'Notification' in window && Notification.permission === 'granted') new Notification('Bags companion task update', {body: 'A task status changed. Open your private task tray.'});
  }
  cursor = Math.max(cursor, events.next_cursor);
  if (typeof showMeetingTaskChoices === 'function') showMeetingTaskChoices(tasks.tasks);
  if (typeof refreshMeeting === 'function') await refreshMeeting();
}
async function pause() {
  paused = true; stopCamera(); stopPlayback(); const cleanup = stopMic();
  send({type: 'privacy.pause'}); updateControls(); await cleanup;
}
$('pairform').onsubmit = async event => {
  event.preventDefault(); const generation = ++sessionGeneration;
  try { const data = await api('api/pair', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({code: $('code').value})});
    if (generation !== sessionGeneration) { await api('api/device', {method: 'DELETE', headers: {Authorization: 'Bearer '+data.token}}).catch(() => {}); return; }
    token = data.token; $('code').value = ''; cursor = 0; await loadRoster(); await connect(); await refreshTasks(); }
  catch (error) { note(error.message); }
};
$('sendform').onsubmit = event => { event.preventDefault(); const text = $('text').value.trim(); if (!text || !ready || paused) return; interrupt(); send({type: 'text', text}); note(text, 'user'); $('text').value = ''; };
$('agent').onchange = async () => {
  if (transitioning) return;
  transitioning = true; const transition = ++sessionGeneration, selected = $('agent').value; updateControls();
  try {
    transcripts.set(agentId, [...$('messages').childNodes]);
    await pause(); socket?.close();
    const data = await api(`api/agents/${encodeURIComponent(selected)}/session`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'});
    if (transition !== sessionGeneration) return;
    token = data.token; agentId = selected; cursor = 0;
    const old = transcripts.get(agentId); $('messages').replaceChildren(...(old || []));
    await connect(); await refreshTasks();
  } catch (error) { note(error.message); }
  finally { transitioning = false; updateControls(); }
};
$('mic').onclick = async () => {
  let requestGeneration = micGeneration;
  try {
    if (micStream || recognition || micPending) { await stopMic(); return; }
    if (!window.isSecureContext) throw new Error('Microphone requires HTTPS or localhost.');
    interrupt();
    const session = sessionGeneration, generation = ++micGeneration, originSocket = socket;
    requestGeneration = generation;
    if (!capabilities().realtime_audio) {
      const Recognizer = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Recognizer) throw new Error('Browser dictation is unavailable. Native Android speech is a separate build; text still works.');
      if (!confirm('Use browser dictation? Audio may be sent to your browser vendor. This is text dictation plus optional TTS, not native realtime Codex audio.')) return;
      const r = new Recognizer(); recognition = r; r.lang = 'en-US'; r.interimResults = false; r.continuous = false;
      r.onresult = event => { if (recognition !== r || generation !== micGeneration || session !== sessionGeneration || socket !== originSocket || paused || document.hidden || !ready) return; const text = event.results[0][0].transcript; note(text, 'user'); send({type: 'text', text}); };
      r.onerror = () => note('Dictation unavailable or permission denied.');
      r.onend = () => { if (recognition === r) recognition = null; updateControls(); };
      r.start(); updateControls(); return;
    }
    micPending = true; updateControls();
    const acquired = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
    if (generation !== micGeneration || session !== sessionGeneration || socket !== originSocket || document.hidden || paused || !ready) { acquired.getTracks().forEach(t => t.stop()); return; }
    micPending = false; micStream = acquired;
    micContext = new AudioContext(); micSource = micContext.createMediaStreamSource(micStream);
    processor = micContext.createScriptProcessor(2048, 1, 1); // bounded prototype; native app uses AudioRecord
    processor.onaudioprocess = event => {
      if (generation !== micGeneration || session !== sessionGeneration || socket !== originSocket || !ready || paused || socket.bufferedAmount > 262144) { stopMic(); return; }
      const input = event.inputBuffer.getChannelData(0), rate = micContext.sampleRate / 16000;
      const samples = Math.floor(input.length / rate), pcm = new ArrayBuffer(samples * 2), view = new DataView(pcm);
      for (let i = 0; i < samples; i++) { const value = Math.max(-1, Math.min(1, input[Math.floor(i * rate)])); view.setInt16(i * 2, value < 0 ? value * 32768 : value * 32767, true); }
      socket.send(pcm);
    };
    micSource.connect(processor); processor.connect(micContext.destination); updateControls();
  } catch (error) { if (requestGeneration === micGeneration) { await stopMic(); note(error.message); } }
};
$('camera').onclick = async () => {
  let requestGeneration = cameraGeneration;
  try {
    if (cameraStream || cameraPending) { stopCamera(); return; }
    const session = sessionGeneration, generation = ++cameraGeneration, originSocket = socket;
    requestGeneration = generation;
    if (!confirm('Share live camera frames with the configured vision provider? Uses network data, up to 1 frame/second; no persistent recording here.')) return;
    cameraPending = true; updateControls();
    const acquired = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment', width: {ideal: 640}, height: {ideal: 480}}, audio: false});
    if (generation !== cameraGeneration || session !== sessionGeneration || socket !== originSocket || document.hidden || paused || !ready) { acquired.getTracks().forEach(t => t.stop()); return; }
    cameraPending = false; cameraStream = acquired;
    $('preview').srcObject = cameraStream; $('cameraPanel').hidden = false; send({type: 'camera.set', enabled: true}); updateControls();
    const canvas = document.createElement('canvas'); let encoding = false;
    cameraTimer = setInterval(async () => {
      if (generation !== cameraGeneration || session !== sessionGeneration || encoding || !cameraStream || paused || !ready || socket.bufferedAmount > 262144) return;
      encoding = true;
      try { const video = $('preview'); const scale = Math.min(640 / video.videoWidth, 480 / video.videoHeight, 1); if (!Number.isFinite(scale)) return;
        canvas.width = Math.floor(video.videoWidth * scale); canvas.height = Math.floor(video.videoHeight * scale); canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const jpeg = canvas.toDataURL('image/jpeg', .65).split(',')[1]; send({type: 'camera.frame', jpeg});
      } finally { encoding = false; }
    }, 1100);
  } catch (error) { if (requestGeneration === cameraGeneration) { stopCamera(); note(error.message); } }
};
$('file').onchange = async () => {
  const session = sessionGeneration, uploadAgent = agentId, uploadToken = token;
  const file = $('file').files[0]; $('file').value = ''; if (!file) return;
  if (file.size > 2 * 1024 * 1024) { note('File exceeds 2 MiB.'); return; }
  if (!confirm(`Upload ${file.name} (${file.type || 'unknown MIME'}, ${file.size} bytes) to this private session? Allowed content may be sent to the configured provider. PDFs are storage-only.`)) return;
  try { const data = await api('api/uploads', {method: 'POST', headers: {'Content-Type': file.type, 'X-Upload-Consent': 'yes'}, body: file});
    if (session !== sessionGeneration || uploadAgent !== agentId || token !== uploadToken) { await api(`api/uploads/${data.id}`, {method: 'DELETE', headers: {Authorization: 'Bearer '+uploadToken}}).catch(() => {}); return; }
    note(`Attachment stored privately: ${file.name}. ${data.mime === 'application/pdf' ? 'PDF parsing is unavailable.' : provider.state === 'configured' ? 'Sending allowed content to selected session.' : 'AI provider unavailable; not analyzed.'}`);
    const erase = document.createElement('button'); erase.textContent = 'Delete ' + file.name; erase.onclick = async () => { try { await api(`api/uploads/${data.id}`, {method: 'DELETE'}); erase.remove(); note('Attachment deleted.'); } catch (e) { note(e.message); } }; $('messages').append(erase);
    if (ready && provider.state === 'configured' && data.mime !== 'application/pdf') send({type: 'attachment', id: data.id});
  } catch (error) { note(error.message); }
};
$('interrupt').onclick = interrupt;
$('resume').onclick = () => { if (document.hidden) return; paused = false; send({type: 'privacy.resume'}); updateControls(); };
$('reconnect').onclick = () => connect().catch(e => note(e.message));
$('statusTask').onclick = async () => { if (!confirm(`Run the read-only server status check for ${selectedName()}? This is not an AI agent task.`)) return; try { await api('api/tasks', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action: 'server_status', confirmed: true})}); await refreshTasks(); } catch (error) { note(error.message); } };
$('shared').onchange = () => { taskViewGeneration++; cursor = 0; refreshTasks().catch(e => note(e.message)); };
$('notifications').onchange = async () => { if (!$('notifications').checked) return; if (!('Notification' in window)) { $('notifications').checked = false; note('Device notifications are not supported.'); return; } $('notifications').checked = await Notification.requestPermission() === 'granted'; };
$('spoken').onchange = () => { if (!$('spoken').checked) stopPlayback(); };
$('disconnect').onclick = async () => {
  const revokeToken = token; sessionGeneration++; token = ''; ready = false;
  socket?.close(); clearInterval(pollTimer); clearInterval(pingTimer); transcripts.clear();
  $('messages').replaceChildren(); $('tasks').replaceChildren(); $('agent').replaceChildren(); roster = []; agentId = 'bags';
  $('pairing').hidden = false; $('connection').textContent = 'Locked'; $('route').textContent = 'Separate session · not Telegram memory';
  if (typeof resetMeetings === 'function') resetMeetings();
  updateControls(); await pause();
  if (revokeToken) { try { await api('api/device', {method: 'DELETE', headers: {Authorization: 'Bearer '+revokeToken}, signal: AbortSignal.timeout(10000)}); } catch (_) { note('Local lock completed; server erasure could not be confirmed. Server session expires automatically.'); } }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
window.addEventListener('pagehide', () => { pause(); socket?.close(); });
fetch(new URL('health', base)).then(r => r.json()).then(data => { provider = data.provider; $('provider').textContent = `${provider.name} · ${provider.state}. ${provider.reason || 'Pair to connect to a separate session.'}`; updateControls(); }).catch(() => { $('provider').textContent = 'Server unreachable.'; });
