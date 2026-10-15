# Prompt for Grok: build the Android companion against this repository

Build a working Android app, not a mockup or an invented API. Clone
`https://github.com/vidmarshdrck/Bags-Mark-LIII`, checkout branch
`feature/mobile-companion` (use its current verified commit), and read
`docs/COMPANION.md`, `companion/server.py`, `companion/live.py`,
`companion/text_provider.py`, `companion/providers.py`, `companion/agents.py`,
`companion/tasks.py`, `companion/uploads.py`, and `tests/test_companion.py`.
Preserve the original CC BY-NC 4.0 license and FatihMakes attribution. This is
for personal non-commercial use; do not assume a business-use grant.

## Approved product

Bags is my default personal butler. I need a clean phone companion: text and
voice-mode toggle, image/file picker, explicit optional live camera, a picker
of my **actual** Vidmar Holdings agents, and a task tray with optional spoken
completion updates. Separate sessions from Telegram are intentional and fine.
Design is already drafted in `companion/static/index.html`, `app.css`, `app.js`:
use its dark slate / warm brass palette, serif BAGS wordmark, selected-agent
header, dominant conversation, compact controls and secondary task tray. Keep
44dp+ hit targets, accessible contrast, font scaling, TalkBack, 390dp layout,
IME-safe composer, dark/light system behavior, and explicit source labels.
Show me the finished layout for approval before adding sensitive actions.

## Critical truth about providers

My **current paid Codex subscription** is the intelligence source. A real text
reply was successfully tested through the official installed Codex CLI with
read-only sandbox, tools disabled, no sandbox bypass. The backend adapter is
`CodexTextProvider`; start with `python -m companion serve --text-provider codex`.
Its capabilities are TEXT ONLY, `realtime_audio:false`, `vision:false`.
**Codex OAuth is not evidence of realtime audio/vision entitlement.** Do not
copy OAuth tokens, API keys or CLI auth files into the APK. Backend owns auth.
Do not use undocumented endpoints, silently switch providers or subscribe/spend
on a new voice provider. Do not enable Gemini as the default to make a demo work.

Prefer Android `SpeechRecognizer` on-device when available (API 31+
`isOnDeviceRecognitionAvailable` / `createOnDeviceSpeechRecognizer`), with explicit
consent before any system/vendor-network fallback. Use Android `TextToSpeech`
with actual voice-pack availability checks, user-selected voice/rate and audio
focus. These are a **separate SpeechEngine** from the text `IntelligenceClient`.
Final recognized text goes to the ordinary backend `text` event; replies can be
spoken locally. Show partial ASR text without submitting duplicate turns.
Implement a stop/interrupt button immediately. Only claim hands-free full-duplex
barge-in after testing ASR while TTS plays, acoustic echo, audio focus and actual
physical-phone latency. Otherwise label it honestly as dictation + spoken
replies, not a realtime Codex voice call. No browser/Android speech capability
may be falsely advertised as guaranteed offline.

Keep intelligence and speech provider interfaces swappable. I may use Grok
next month, but a consumer Grok plan does not automatically grant API/audio
access. There is no currently configured Grok adapter in this backend. Require
an explicitly authorized, supported server integration and fresh capability
check before enabling it. Preserve a useful text path when speech is unavailable.
The repository includes an optional Gemini Live adapter only as a separately
opt-in future route; no live Gemini credentials, speech or vision were tested.
Do not buy or activate that provider on my behalf.

## Implementation choice and transport

Use Kotlin + Jetpack Compose, coroutines/StateFlow, OkHttp HTTP/WebSocket,
CameraX, AndroidX WorkManager for bounded background status polling, and native
ASR/TTS behind interfaces. Add an `android/` Gradle project, Gradle wrapper,
version catalog/dependency bounds and a reproducible build README. Avoid heavy
server speech models: the VPS has about 4 GiB total RAM and existing agent load.
Do not depend on the desktop PyQt/PortAudio app or host microphone/speakers.

Read the exact protocol table in `docs/COMPANION.md`; do NOT invent routes.
All endpoints are relative to an operator-configured **HTTPS base URL** (may
have `/bags-mark/` prefix). Resolve paths without dropping that prefix. Reject
cleartext except a debug-only emulator loopback configuration; never disable
certificate verification. The public HTTPS route is **currently absent** and
needs an administrator. Do not hardcode a proposed domain/path as working.
The actual service is private `127.0.0.1:8768` on its host, not reachable as that
address from my phone. A public client should show 'server setup required'
until a verified TLS URL is supplied. No fake hosted backend.

Pair by `POST api/pair {code}`; single-use code expires in 5 minutes. Save only
returned session bearer/ID/expiry under Android Keystore-backed encryption,
exclude from backups/logcat/analytics and never put tokens in URL/query. Bearer
expires within one hour, no refresh API exists. Prompt to pair again on expiry.
HTTP calls use `Authorization: Bearer ...`. Clear secrets on logout; server
`DELETE api/session` erases current selected session only (other agent sessions
are not implicitly erased). Explain this accurately in settings. The existing web **Lock & erase device**
button instead uses `DELETE api/device`: erases all companion sessions, files,
tasks, events and meetings for the same pairing owner, closes their live sockets,
and leaves other pairing owners and actual Hermes profiles untouched. Prefer
this device-wide logout for a device lock/erase control. Clear local sensors,
roster, tasks and meetings immediately even if network erasure fails; report
server erasure as unconfirmed then. Generation-check pending pairing responses
and revoke late sessions so a stale response cannot undo the lock.

WebSocket `api/live`: first JSON within 5 seconds is
`{"type":"auth","token":"..."}`. Wait for `ready`, including `agent_id`,
`provider.state` and `provider.capabilities`. One socket per selected session.
Send `ping` every 20s; idle timeout 60s. Reconnect with capped exponential backoff
and jitter only while foreground, not an endless battery loop. Authentication
failure stops retries. A reconnect starts a **new inference context**; do not
promise backend transcript resumption. Keep local per-agent UI transcripts
isolated and encrypted only if the user explicitly enables persistence.

Text event `{"type":"text","text":"..."}` max 4096 chars; `text`,
`transcript.input`, `transcript.output`, `turn.complete`, `interrupted`, and
`error` come back as JSON. `interrupt` clears playback and cancels an active
Codex text turn; there is no shell/command API. Show `provider_busy`, `turn_busy`,
`provider_unavailable`, `speech_layer_required`, `vision_not_connected`, and
`codex_text_failed_or_sandbox_blocked` honestly. No invented assistant output.

If a future actually configured provider supports REALTIME AUDIO, the existing
WS transport uses binary mono PCM16LE, 16 kHz input, 24 kHz output. Native
`AudioRecord` and `AudioTrack` must convert/check sample rate, endianness, chunk
bounds (max 64,000 bytes per input chunk), audio focus, bounded buffers and
backpressure; no voice-note upload loop disguised as streaming. Server may
interleave binary audio and JSON. Drain every event/part; flush scheduled audio
on interruption. Phone background/screen lock pauses sensors by default.
Native microphone tests cannot be replaced by fixture bytes.

## Actual agents and data isolation

`GET api/agents` is authenticated and returns a private roster loaded from a
server-side snapshot of real local Paperclip agents. Do not hardcode invented
names/IDs, scrape Telegram or ship the private registry in assets. The default
`bags` entry is explicitly a separate companion session. The actual existing
Bagheera runtime may also appear as disconnected; do not conflate them.

Switch with `POST api/agents/{id}/session {}`. Use the newly returned token,
ID and unchanged expiry; rotate socket, stop all sensors/playback and clear
pending input. Keep files, UI transcript and tasks scoped to that returned
session. Real specialists are currently **disconnected** and must be labeled
so; disable inference controls rather than impersonating one with a generic
Codex persona. Selecting a roster entry does not start a runtime. A future
real agent-runtime bridge is separate reviewed backend work.

Shared task tray is opt-in `scope=all` on `api/tasks` and `api/events`, across
same pairing owner only. Every item carries `agent_id` / `agent_name`. Never
mix chat histories/files across agents. Device lock-screen notifications must
be generic; speak private details only if user has explicitly enabled them
and device state/audio focus permits it.

## Attachments and camera privacy

System photo picker / Storage Access Framework only, no broad storage access.
Before upload show selected filename, MIME, size, destination agent and explicit
consent. Raw-body `POST api/uploads` with exact MIME, bearer and
`X-Upload-Consent: yes`. Allowed JPEG/PNG/text/plain/application/pdf, max 2 MiB,
16 files / 8 MiB per session, 128 MiB global server cap. No multipart endpoint.
Server returns `{id,mime,size,inference:"not_sent",pdf_processing:"unavailable"}`.
`GET/DELETE api/uploads/{id}` is current-session-only. Send WS
`{"type":"attachment","id":"..."}` only if selected provider can process it.
PDF is **storage only**, no PDF/OCR/docx inference is implemented. Codex camera
and image inference are currently unavailable; do not claim images were seen.
Uploaded instructions are untrusted data and NEVER authorize tools/actions.

CameraX requests CAMERA only on user action. Keep a live preview, conspicuous
camera-on label, explicit off control, data-use disclosure and max 1 FPS.
Only if provider vision capability is real: send `camera.set {enabled:true}`
then `camera.frame {jpeg:BASE64}`. Stream JPEG max 256 KiB, max 1280x1280; server
validates, rate-limits and does not persist frames. Never record/save frames
by default. Send `camera.set {enabled:false}` on stop. Stop hardware capture
on background, agent switch, navigation away, socket/auth loss, screen lock,
permission revocation and logout. `privacy.pause` pauses the backend; explicit
`privacy.resume` is required when returning, with sensors still off until tap.
Do not silently restart sensors after permission dialog/lifecycle races.

## Tasks and completion updates

Current executable task API is ONLY user-confirmed
`POST api/tasks {"action":"server_status","confirmed":true}`. It is a real
read-only background check through the project's explicit ActionRegistry.
`GET api/tasks` returns queued/running/completed/failed; `GET api/events?after=N`
returns durable completion/failure events and `next_cursor`. Persist event cursor
per owner/session/scope to avoid duplicate announcements, and fetch subsequent
pages as needed. Never announce completed on acceptance/queueing. Generic event
`speech` may be spoken using local TTS only if enabled. General AI task execution,
external actions and Hermes/Paperclip agent orchestration remain disconnected.
There is NO arbitrary task prompt executor, remote shell or trading endpoint.

Foreground: bounded event poll (web currently 3s) or use the existing HTTP event
contract. Background: WorkManager is opportunistic and periodic minimums apply;
no FCM/push endpoint is implemented. Do not promise immediate locked-screen
spoken completions. If adding a user-enabled foreground service for task status,
use a persistent notification and Android background restrictions correctly;
**never keep microphone/camera on as a side effect**. Otherwise deliver on next
foreground/poll and state that limitation. Ask approval before introducing a
push provider, paid services or new externally consequential actions.

## Approved project meeting mode — exact implemented contract

Add a meeting screen with configurable multi-select **actual** registry agents
for the same project: default Bags moderator/secretary roles, and owner-selected
relevant business CEO, technical advisor, Aaron, Nehemiah or others only when
present in the real roster. Use restrained translucent surfaces, rounded
corners, accessible contrast and reduced-motion support, not decorative blur
that compromises reading. Existing web design includes this panel.

The backend already provides a **manual approved-context meeting workspace**,
not connected multi-agent conversation. Never fabricate agent speaker labels
or let the generic model impersonate participants. Source-attributed manual
minutes say User; requesting an actual agent turn currently returns 409
`meeting_runtime_disconnected`. Distinct live agent speakers/voices require a
real authenticated bridge and per-speaker attribution in a later reviewed
implementation. No uncontrolled all-agents-talking loops; default one requested
turn at a time, immediate user interrupt and explicit floor ownership.

Exact new bearer routes, all owner-scoped:
- `GET/POST api/meetings`. Create body `{project,agenda,participants:[actual IDs],
  context_approved:true,confirmed:true}`. `bags` default role is included, max8
  participants. Returned state `manual_context_only`, runtime `disconnected`,
  active_speaker `user`, automatic_turns `false` are intentional and must be shown.
- `GET/DELETE api/meetings/{id}`. Same pairing owner may view approved shared
  context from another selected agent session; another owner cannot. Do not
  import private agent memory, files or histories into this meeting.
- `POST api/meetings/{id}/entries` body `{kind:note|decision|action_item,text,
  owner_agent_id?:participant|user,deadline?:YYYY-MM-DD,confirmed:true}`. Source
  is forcibly `user_recorded`, speaker `user`. Entries do **not** dispatch work.
- `POST api/meetings/{id}/turn {speaker_id,confirmed:true}`; agents currently
  return 409, user floor works. `POST .../interrupt {}` returns user floor.
- `POST .../tasks {task_id,confirmed:true}` links only an existing real owner's
  backend task. `GET .../{id}` refreshes its actual statuses while meeting is open.
  It does not make arbitrary queued work executable. No fake busy animations.
- `GET .../{id}/minutes` is an authenticated text/plain Markdown download of
  agenda, participants, source-attributed notes, decisions, owners, deadlines,
  and actual linked backend tasks. Max200 entries, 2048chars each; max50 linked
  tasks, 20 meetings/owner,100 globally. DELETE meeting erases its workspace,
  not underlying tasks. Locking one current agent session does not erase other
  agent sessions' shared meeting records; offer explicit meeting erase.
- `demo_links` contains only actual HTTPS links in completed backend task results;
  current status-check worker yields none. Show 'No demo artifact produced'
  rather than generating plausible links or reporting an unbuilt dashboard done.

Human approval of meeting context is not approval for consequential actions.
Execution still goes exclusively through explicit allowlisted confirmed real
tools. Task completion announcements must come from authenticated durable
backend events, not a model claiming it finished. Keep private agent context
isolated from shared project context and record exact speaker/provenance whenever
a future real bridge is added. Test multi-owner isolation and forbid a client
from writing manual notes as an agent speaker.

## Tests and deliverable

Run backend unittests and real transport probe (`scripts/probe_companion.py`;
`--live-codex` only when explicitly using the existing authorized subscription).
Keep fixture/simulator tests labeled as fixtures, never live AI/voice results.
Add Android unit tests for URL prefixes, token expiry/rotation, per-agent
isolation, capability gating, PCM conversion, bounded reconnect/buffers, MIME/
size consent, cursor dedupe, status-to-speech mapping and lifecycle stop logic.
Use local MockWebServer contract fixtures that match these exact endpoints.
Run lint/unit tests and `./gradlew :app:assembleDebug`; return actual build output,
APK path/download artifact, SHA-256 and install instructions requiring Android's
normal owner-approved APK install flow. Never claim installed on my phone without
physical-device confirmation. Do not commit signing keys or credentials.

Show clean screenshots for disconnected/pairing, Bags text connected, specialist
disconnected, task completion, permission denial and speech unavailable states.
Clearly distinguish emulator tests from physical microphone/camera/speaker tests.
Report concise outcomes and blockers: current public HTTPS, specialist runtime
bridge, native duplex speech/vision provider and push delivery are not magically
solved by building an APK. Produce working code, not just a proposal.
