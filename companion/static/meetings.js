'use strict';
// Manual approved meeting context only. No generated or impersonated agent voices.
let activeMeetingId = '', meetingViewGeneration = 0, meetingBusy = false;
function meetingMessage(text) { $('meetingState').textContent = text; }
function resetMeetings() {
  activeMeetingId = ''; meetingViewGeneration++;
  $('meetingPanel').hidden = true; $('meetingEntries').replaceChildren(); $('meetingProgress').replaceChildren();
  $('meetingSelect').replaceChildren(); $('meetingParticipants').replaceChildren();
  $('meetingProject').value = $('meetingAgenda').value = $('meetingEntry').value = '';
  $('meetingConsent').checked = false; meetingMessage('Meeting runtime disconnected.');
}
function loadMeetingRoster() {
  $('meetingParticipants').replaceChildren(...roster.map(agent => {
    const label = document.createElement('label'), checkbox = document.createElement('input');
    checkbox.type = 'checkbox'; checkbox.value = agent.id; checkbox.checked = agent.id === 'bags'; checkbox.disabled = agent.id === 'bags';
    label.append(checkbox, document.createTextNode(`${agent.name} · ${agent.id === 'bags' ? 'moderator/secretary role' : 'runtime disconnected'}`)); return label;
  }));
  $('createMeeting').disabled = !token;
  refreshMeetingList().catch(e => meetingMessage(e.message));
}
async function refreshMeetingList() {
  if (!token) return; const session = sessionGeneration;
  const data = await api('api/meetings'); if (session !== sessionGeneration) return;
  const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Choose a meeting';
  $('meetingSelect').replaceChildren(empty, ...data.meetings.map(meeting => { const option = document.createElement('option'); option.value = meeting.id; option.textContent = meeting.project; return option; }));
  $('meetingSelect').value = activeMeetingId;
}
function meetingOptions(select, participants, includeEmpty) {
  const values = includeEmpty ? [{id: '', name: 'Unassigned'}, {id: 'user', name: 'User'}] : [{id: 'user', name: 'User — active floor'}];
  values.push(...participants);
  const previous = $(select).value;
  $(select).replaceChildren(...values.map(participant => { const option = document.createElement('option'); option.value = participant.id; option.textContent = participant.name; return option; }));
  if (values.some(v => v.id === previous)) $(select).value = previous;
}
function renderMeeting(data) {
  $('meetingPanel').hidden = false;
  meetingMessage(`${data.project} · approved shared context only · agent meeting runtime DISCONNECTED · active speaker: User`);
  meetingOptions('meetingSpeaker', data.participants, false); meetingOptions('entryOwner', data.participants, true);
  $('meetingEntries').replaceChildren(...data.entries.map(entry => {
    const row = document.createElement('div'); row.className = 'task';
    const owner = entry.owner_agent_id === 'user' ? 'User' : data.participants.find(p => p.id === entry.owner_agent_id)?.name || 'Unassigned';
    row.textContent = `User-recorded ${entry.kind}: ${entry.text} · owner: ${owner} · deadline: ${entry.deadline || 'unset'} · not dispatched`; return row;
  }));
  const progress = data.tasks.map(task => { const row = document.createElement('div'); row.className = 'task'; row.textContent = `REAL backend task ${task.action}: ${task.status}`; return row; });
  for (const demo of data.demo_links) {
    const link = document.createElement('a'); link.href = demo.url; link.rel = 'noopener noreferrer'; link.target = '_blank'; link.textContent = 'Backend task demo artifact'; progress.push(link);
  }
  if (!data.demo_links.length) { const row = document.createElement('p'); row.textContent = 'No backend demo artifact has been produced.'; progress.push(row); }
  $('meetingProgress').replaceChildren(...progress);
}
async function refreshMeeting() {
  if (!token || !activeMeetingId) return;
  const session = sessionGeneration, view = meetingViewGeneration, id = activeMeetingId;
  const data = await api(`api/meetings/${id}`);
  if (session !== sessionGeneration || view !== meetingViewGeneration || id !== activeMeetingId) return;
  renderMeeting(data);
}
function showMeetingTaskChoices(tasks) {
  const previous = $('meetingTask').value, empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Choose an existing real task';
  $('meetingTask').replaceChildren(empty, ...tasks.map(task => { const option = document.createElement('option'); option.value = task.id; option.textContent = `${task.agent_name || selectedName()} · ${task.action} · ${task.status}`; return option; }));
  if (tasks.some(task => task.id === previous)) $('meetingTask').value = previous;
}
async function meetingAction(operation, body) {
  if (!token || !activeMeetingId || meetingBusy) return;
  const session = sessionGeneration, id = activeMeetingId, view = meetingViewGeneration;
  meetingBusy = true;
  try { const data = await api(`api/meetings/${id}/${operation}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    if (session === sessionGeneration && id === activeMeetingId && view === meetingViewGeneration) renderMeeting(data);
  } catch (e) { if (session === sessionGeneration) meetingMessage(e.message === 'meeting_runtime_disconnected' ? 'Requested agent has NOT spoken. Multi-agent meeting runtime is disconnected; no pretend speaker is generated.' : e.message); }
  finally { meetingBusy = false; }
}
$('createMeeting').onclick = async () => {
  if (!token || meetingBusy) return;
  if (!$('meetingConsent').checked) { meetingMessage('Approve the shared agenda explicitly first.'); return; }
  if (!confirm('Create this approved meeting context? Only the supplied agenda and manual notes are shared in this workspace; no private agent memory is imported. AI meeting speech is not connected.')) return;
  const session = sessionGeneration, view = ++meetingViewGeneration;
  const participants = [...$('meetingParticipants').querySelectorAll('input:checked')].map(input => input.value);
  meetingBusy = true; $('createMeeting').disabled = true;
  try { const data = await api('api/meetings', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({project: $('meetingProject').value, agenda: $('meetingAgenda').value, participants, context_approved: true, confirmed: true})});
    if (session !== sessionGeneration || view !== meetingViewGeneration) return;
    activeMeetingId = data.id; renderMeeting(data); await refreshMeetingList();
  } catch (e) { if (session === sessionGeneration) meetingMessage(e.message); }
  finally { meetingBusy = false; $('createMeeting').disabled = !token; }
};
$('meetingSelect').onchange = () => { activeMeetingId = $('meetingSelect').value; meetingViewGeneration++; $('meetingPanel').hidden = !activeMeetingId; refreshMeeting().catch(e => meetingMessage(e.message)); };
$('meetingTurn').onclick = () => meetingAction('turn', {speaker_id: $('meetingSpeaker').value, confirmed: true});
$('meetingInterrupt').onclick = () => { interrupt(); meetingAction('interrupt', {}); };
$('recordEntry').onclick = () => {
  if (!confirm('Record this explicitly as a USER note/decision/action item? It does not execute or dispatch work.')) return;
  const body = {kind: $('entryKind').value, text: $('meetingEntry').value, confirmed: true};
  if ($('entryOwner').value) body.owner_agent_id = $('entryOwner').value;
  if ($('entryDeadline').value) body.deadline = $('entryDeadline').value;
  meetingAction('entries', body);
};
$('linkTask').onclick = () => { if ($('meetingTask').value && confirm('Link this existing task and its real status to the approved meeting context?')) meetingAction('tasks', {task_id: $('meetingTask').value, confirmed: true}); };
$('downloadMinutes').onclick = async () => {
  if (!token || !activeMeetingId) return; const session = sessionGeneration, id = activeMeetingId;
  try { const response = await fetch(new URL(`api/meetings/${id}/minutes`, base), {headers: {Authorization: 'Bearer '+token}});
    if (!response.ok) throw new Error('Minutes unavailable.'); const blob = await response.blob();
    if (session !== sessionGeneration || id !== activeMeetingId) return;
    const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'meeting-minutes.md'; link.click(); URL.revokeObjectURL(url);
  } catch (e) { if (session === sessionGeneration) meetingMessage(e.message); }
};
$('eraseMeeting').onclick = async () => {
  if (!token || !activeMeetingId || !confirm('Erase this shared meeting workspace and its manual minutes? Linked real tasks are not cancelled or deleted.')) return;
  const session = sessionGeneration, id = activeMeetingId;
  try { await api(`api/meetings/${id}`, {method: 'DELETE'}); if (session !== sessionGeneration || id !== activeMeetingId) return; resetMeetings(); loadMeetingRoster(); }
  catch (e) { if (session === sessionGeneration) meetingMessage(e.message); }
};
