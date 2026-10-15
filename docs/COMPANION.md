# Headless mobile companion (personal / non-commercial)

This is a new, separate-session entry point for the existing Bags-Mark-LIII project.
The native desktop `main.py` is unchanged. The companion never imports Qt,
`sounddevice`, PortAudio, host microphone/speaker code, or the auto-discovered
computer-control actions. Its **explicit** safe action registry reuses
`core/action_loader.py` (`ActionRegistry` / `ActionRecord`).

## What actually works, and what does not

- Headless HTTP + authenticated WebSocket, pairing, isolated sessions, private
  attachments, explicit camera consent controls and durable task/event state.
- Responsive mobile UI with selected-agent picker, task tray, text, microphone,
  attachment and camera controls. Manifest/relative assets work without a CDN.
  This is an online web companion, **not an Android APK or offline PWA**.
- **Existing Codex subscription text was exercised through the official installed
  CLI, returning `BAGS_HEADLESS_CODEX_OK` over the actual loopback WebSocket.**
  No OAuth token is copied to the app, no new subscription/API key is purchased,
  and no unsupported consumer-to-API entitlement is assumed.
- Codex text intelligence and speech are separate. Browser dictation (where the
  browser provides it, with explicit vendor-network consent) plus browser TTS is
  optional. It is **not native realtime voice**. Actual phone ASR/TTS, latency,
  speaker echo, interruption and background delivery still need device tests.
- Binary PCM round-trip and camera frame routing were integration-tested with
  **explicit test fixtures, not live model voice/vision**. The current Codex text
  adapter does not accept audio or images for inference; the UI disables live
  camera for that adapter. Uploaded images may be stored privately, not analyzed.
- An optional opt-in Gemini Live adapter follows current official SDK fields,
  but no Gemini credential, paid activation, live voice call, or vision session
  was used. It is not the default plan or a requirement to buy another service.
- The real local Paperclip agent roster can be snapshotted to a **private runtime
  file**. Selecting a real specialist gets a different session/token/storage
  namespace, but its route stays visibly **disconnected**. No generic model is
  dressed up as that specialist. Bags is explicitly a new companion session,
  not the Telegram runtime. A genuine per-agent runtime bridge remains work.
- The only executable background task is user-confirmed `server_status`.
  It really runs in the local durable worker and creates `task.completed` events.
  General AI/Hermes/Paperclip task execution is **disconnected**. No shell,
  financial transaction, message-sending or arbitrary tool endpoint exists.
- Public HTTPS `/bags-mark/` is **not deployed**: the existing root-owned nginx
  route needs an administrator. Do not present a localhost address as a phone URL.

## Install and run without desktop hardware dependencies

From this repository, Python 3.11+:

```sh
uv venv .venv                       # only for a fresh checkout without a venv
uv pip install --python .venv/bin/python -r requirements-companion.txt
.venv/bin/python -m unittest discover -s tests -v
node --test tests/browser_companion.test.cjs # lifecycle/privacy tests
node --check companion/static/app.js # optional JS syntax check

# Existing official Codex CLI login is used by the CLI itself. Never scrape tokens.
codex --version
.venv/bin/python -m companion serve --text-provider codex --port 8768

# In a separate private operator terminal (not the service log):
.venv/bin/python -m companion pair
```

`serve` binds **127.0.0.1 only**, disables access logs, caps WebSocket size/queue
and concurrent connections, and never prints pairing codes. `pair` prints one
high-entropy code deliberately to the private operator terminal. It expires in
5 minutes and replaces any earlier unused code. Give it only to the device owner.
The bearer expires in one hour; there is no refresh-token endpoint. Pair again.
A plain `serve` with no text provider starts honestly unavailable unless the
optional Gemini environment has been explicitly enabled.

Codex CLI sessions use read-only sandbox + `approval_policy="never"`, ignored
user config/rules, disabled shell/unified execution, apps/plugins/hooks,
browser/computer/multi-agent/image tools, and no tools are executed by this
backend. Unexpected executable CLI event kinds fail closed; diagnostics are
not mistaken for execution. No `danger-full-access` or sandbox bypass is used.
This does **not** repair or validate the previously broken Paperclip bwrap
coding worker. This text-only route avoids invoking its sandboxed shell tools.
CLI errors are returned generically without credential-bearing stderr.
Only one CLI inference runs at a time; a turn is bounded to 90 seconds. Model
selection is optional `--codex-model EXACT_ID`; otherwise the installed CLI
chooses its authenticated default. No model ID is guessed or written globally.
Each WebSocket has its own bounded in-memory text history; reconnect creates a
new inference context. Task/upload state persists until expiry/erase.

Data defaults to `~/.local/share/bags-companion/`, outside the public repository.
Use `--data-dir /private/path` **before** the subcommand to change it.
Directory mode 0700; SQLite, roster and upload files 0600. Tokens/codes are stored
only as SHA-256 digests. The browser keeps its bearer in memory, not localStorage.
Runtime snapshots and test reports must never be added to the public git repo.

### Actual agents, not pretend personas

```sh
.venv/bin/python -m companion sync-agents --company EXACT_LOCAL_COMPANY_UUID
```

This reads only the existing loopback Paperclip API and stores just real agent
IDs, display names, roles and reported runtime states. It does not copy keys,
start agents, change profiles, execute an agent or claim that an idle/error state
is a connected chat runtime. Restart the companion to load an updated snapshot.
The local Bags companion is a separate entry from the actual Bagheera runtime.
`GET /api/agents` is authenticated. Never fetch a private roster directly from
an Android app or publish it as static JSON/GitHub Pages content.

### Optional Gemini Live, only if separately authorized later

Do not activate this to satisfy a supposed Codex voice entitlement.

```sh
uv pip install --python .venv/bin/python -r requirements-companion-gemini.txt
# Operator privately supplies BAGS_GEMINI_KEY in server environment/secrets manager.
# Set BAGS_ENABLE_GEMINI=1 and BAGS_GEMINI_MODEL to an actually authorized exact model.
.venv/bin/python -m companion serve
```

No keys are read from another Hermes profile, and no Gemini model is assumed.
The adapter lazily imports `google-genai`. Current SDK `send_realtime_input`
fields (`text`, `audio`, `video`, `audio_stream_end`) and configuration were
validated against installed google-genai 2.31.0, but not against a live account.
Raw input is mono PCM16LE 16 kHz; output mono PCM16LE 24 kHz; JPEG at most 1 FPS.
All simultaneous content parts are processed; SDK receive is repeated across
turns. Provider VAD handles real speech barge-in. `interrupt` clears client
playback (and cancels an in-progress Codex text process); it is not an invented
Gemini server-cancellation API. Session resumption is not implemented: reconnect
is explicit and starts a fresh conversation.
Official references: https://ai.google.dev/gemini-api/docs/live,
https://ai.google.dev/gemini-api/docs/live-guide,
https://ai.google.dev/gemini-api/docs/live-session.

## Protocol v1 (exact implemented paths)

All paths below are relative to the deployment base; web assets use relative
URLs so a correctly configured `/bags-mark/` proxy prefix is possible.

| Path | Behavior |
|---|---|
| `GET /health` | Public minimal service/provider state; not an inference health proof |
| `POST /api/pair` | JSON `{"code":"..."}` -> `{session_id,token,expires_at}`; single use, 5-minute code; max 30 attempts/minute per process |
| `GET /api/session` | Bearer -> selected `agent_id`, private owner/session identity, expiry, selected provider state |
| `DELETE /api/session` | Bearer; erase **current** session, files, tasks, events and invalidate its token; other agent sessions are not erased |
| `DELETE /api/device` | Bearer; erase all companion sessions/files/tasks/events/meetings for the same pairing owner, close their live sockets; other pairing owners and actual Hermes agent profiles untouched |
| `GET /api/agents` | Bearer -> `{agents:[{id,name,role,route,runtime_state}],selected}` |
| `POST /api/agents/{agent_id}/session` | Bearer + `{}`; select only a registry entry; returns distinct/stable agent session with newly rotated token; same pairing owner, unchanged expiry |
| `POST /api/uploads` | Bearer, raw bytes, exact allowed `Content-Type`, `X-Upload-Consent: yes`; returns 201 `{id,mime,size,inference:"not_sent",pdf_processing:"unavailable"}` |
| `GET/DELETE /api/uploads/{id}` | Bearer, strictly current-session owned; download forced attachment or erase |
| `POST /api/tasks` | Bearer, JSON `{"action":"server_status","confirmed":true}` -> 202 `{id,status:"queued"}`; no other fields/actions |
| `GET /api/tasks` | Bearer -> actual task statuses/results, `agent_id`/`agent_name`; AI worker explicitly disconnected |
| `GET /api/events?after=INTEGER` | Bearer -> up to 100 durable events, `{events,next_cursor}`; `task.completed`/`task.failed`, task ID, agent label, generic safe `speech` |
| `GET /api/tasks?scope=all`, `/api/events?after=N&scope=all` | Opt-in shared tray across **same pairing owner only**; never another owner's sessions |
| `WS /api/live` | Accept, then first message within 5s `{"type":"auth","token":"..."}`; token never in URL/query; one socket per selected session |

WS ready: `{type:"ready",protocol:1,session_id,agent_id,provider,camera:false,
audio_input:"pcm_s16le_16000_mono",audio_output:"pcm_s16le_24000_mono"}`.
These audio formats describe the transport, **not available speech entitlement**;
check `provider.capabilities` / `provider.state`. Codex capabilities:
`{text:true,realtime_audio:false,vision:false}`.

Client JSON events: `text` (`text`, max 4096 chars), `attachment` (`id`),
`camera.set` (`enabled` boolean), `camera.frame` (`jpeg` base64), `audio.end`,
`privacy.pause`, `privacy.resume`, `interrupt`, `ping`. Binary messages are raw
input PCM chunks (nonempty, even byte length, at most 64,000 bytes). Server binary
messages are raw output PCM; JSON events include `text`, `transcript.input`,
`transcript.output`, `turn.complete`, `camera.state`, `paused`, `resumed`,
`audio.ended`, `interrupted`, `pong`, `provider.reconnect_required`, and
`{type:"error",error:STABLE_CODE}`. No provider exception text or API key is sent.

Common errors: `provider_unavailable`, `speech_layer_required`,
`vision_not_connected`, `codex_text_failed_or_sandbox_blocked`, `turn_busy`,
`provider_busy`, `camera_off`, `paused`, `frame_rate_limit`, `invalid_pcm`,
`invalid_jpeg`, `attachment_not_found`, `attachment_not_supported`.
Close codes: 4401 invalid/expired token, 4403 origin forbidden, 4409 duplicate
session socket, 4429 input rate cap, 1011 failed provider connection.
Client heartbeat every 20s; input idle timeout 60s; auth is rechecked on input
and provider output. Browser/native clients must discard tokens after expiry
and require pairing; there is no hidden token renewal API.

## Privacy and bounds

- Explicit camera permission, preview and on/off control; default off; max 1 FPS,
  256 KiB JPEG and 1280x1280 dimensions for streamed frames. Frames are validated
  and forwarded in memory, **not saved**. Provider retention remains its policy.
- Explicit microphone gesture/permission; visible indicator. `visibilitychange`,
  page hide, socket loss and device lock stop tracks, dictation, camera timer and audio
  playback. Resume is manual; sensors never restart silently. Native app must
  enforce this on lifecycle transitions, not just a JS callback.
- Upload max 2 MiB; 16 files / 8 MiB per agent session; 128 MiB global storage cap.
  Only JPEG/PNG verified by decoder (max 4096x4096), UTF-8 text, PDF signature.
  PDFs are never parsed/executed; there is no antivirus claim. Text inference is
  limited to 4096 characters; images are downscaled/reencoded for the optional
  live provider; Codex image inference is explicitly unavailable.
- No original filenames in server storage, no path lookup from uploads, no HTML
  rendering of content. Uploaded instructions do not grant tools or permissions.
- State limit 1000 sessions, 100 manual tasks/session; event polling max 100/page.
  Expired sessions' uploads/tasks/events are purged on startup and every minute.
  The SQLite file is not encrypted; deletion is logical, not forensic secure erase.
- Authenticated separate pairing owners cannot read one another's files/tasks/
  events. Shared notifications are opt-in and generic on device lock screens.
- No shell/tool executor reachable from model output. External consequential
  actions require a future explicit reviewed allowlist and human confirmation.
- Browser ASR may use the browser vendor's network service. No large VPS speech
  model was installed: no local ASR/Piper/eSpeak was available in the inspected
  runtime. Native Android on-device ASR/TTS is the preferred resource-light next
  implementation, subject to actual device capability/voice-pack availability.

## Project meeting workspace (implemented, not simulated multi-agent chat)

The rounded/translucent meeting panel lets the owner multi-select **actual
registry participants**, approve one project agenda, record user notes/decisions/
action items with owners and YYYY-MM-DD deadlines, link existing real backend
tasks, and download source-attributed minutes. Bags is the default moderator/
secretary **role**, not a claim that it or another agent has spoken in a meeting.
The backend meeting runtime is disconnected. All entries are `speaker_id:user`,
`source:user_recorded`; agent floor requests return an honest 409. There are no
all-agent loops, fake speaker replies, fake busy indicators, or implicit tool
permissions. Recorded action items are `not_dispatched` and do not execute work.
Only an explicit approved agenda/manual entries are shared across the same
pairing owner's meeting workspace; no private agent memory/files are imported.

Exact bearer-authenticated routes (relative to deployment base):

- `GET /api/meetings`: owner's saved meeting IDs/projects/states.
- `POST /api/meetings`: `{project,agenda,participants:[REGISTRY_ID,...],
  context_approved:true,confirmed:true}`. `bags` is included automatically;
  at most 8 participants, 20 meetings/owner, 100 globally. Returns full meeting
  with `state:manual_context_only`, `runtime:disconnected`, `active_speaker:user`,
  `automatic_turns:false`, participants, entries, task IDs, actual task statuses,
  and `demo_links`. There is no model call at creation.
- `GET /api/meetings/{id}`: same-owner approved context/minutes and current linked
  task state; owner isolation returns 404 to a different pairing principal.
- `DELETE /api/meetings/{id}`: erase shared meeting workspace, NOT linked tasks.
- `POST /api/meetings/{id}/entries`: `{kind:note|decision|action_item,text,
  owner_agent_id?:PARTICIPANT_ID|user,deadline?:YYYY-MM-DD,confirmed:true}`.
  Max 2048 chars/entry, 200 entries/meeting. Client-supplied speaker identities
  and other fields are rejected; user authorship is enforced server-side.
- `POST /api/meetings/{id}/turn`: `{speaker_id:PARTICIPANT_ID|user,confirmed:true}`.
  A non-user request returns 409 `meeting_runtime_disconnected`; no agent output
  or automatic next turn is generated. User gets the floor explicitly.
- `POST /api/meetings/{id}/interrupt`: `{}`; gives user the floor. Client also
  invokes the existing WS interrupt to stop any separate chat playback/turn.
- `POST /api/meetings/{id}/tasks`: `{task_id:EXISTING_OWNER_TASK_ID,confirmed:true}`;
  max 50 links, same-owner lookup, no arbitrary fake status/link insertion.
- `GET /api/meetings/{id}/minutes`: authenticated text/plain Markdown download,
  explicitly user-recorded, includes actual linked task statuses.

A task's progress remains its real queued/running/completed/failed status while
minutes are open. Demo URLs are surfaced **only** from completed backend task
results that actually contain HTTPS `demo_links`. The current server-status
worker produces none, so the UI says no demo artifact was produced. There is no
invented demo URL or background dashboard delivery. Shared meeting records are
removed when no sessions for the pairing owner remain; erasing just one current
agent session does not erase other-agent shared meeting context. Use DELETE on
the meeting explicitly when desired. Actual moderated multi-agent inference,
per-speaker audio and external task dispatch need a real reviewed runtime bridge.

## HTTPS deployment (administrator needed; not performed)

The live local service can be checked at `http://127.0.0.1:8768/health`.
An administrator must approve/install a TLS reverse proxy route, preserving
WebSocket upgrade. Example **configuration proposal only**, not a live route:

```nginx
location = /bags-mark { return 308 /bags-mark/; }
location /bags-mark/ {
    client_max_body_size 2m;
    proxy_pass http://127.0.0.1:8768/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
}
```

Start companion with `serve --text-provider codex --origin https://YOUR_HOST
--root-path /bags-mark`. Origin has no path or trailing slash. Keep port 8768
private; do not open a raw public HTTP/WebSocket port or disable TLS checks.
Do not change existing `/sms`, `/health`, firewall or nginx ownership. Verify
public HTML, assets, authenticated WS and real Android permissions after the
administrator makes the change. No public GitHub Pages deployment of private
runtime data or credential-bearing UI configuration is permitted.

The current session started a **transient user systemd unit**,
`bags-companion.service`, on loopback with a 384 MiB memory cap and
`NoNewPrivileges=yes`. It is independent of the agent process, but is not an
installed boot-persistent unit. Operator checks:
`systemctl --user status bags-companion.service`. No existing gateway was
reconfigured or restarted. A persistent unit can be installed after review.

## Reproduce verification

```sh
.venv/bin/python -m unittest discover -s tests -v
node --check companion/static/app.js
uv pip check --python .venv/bin/python
# Running local server, transports/auth/uploads/worker (no fake model output):
.venv/bin/python scripts/probe_companion.py
# Explicitly exercise one real reply using current Codex subscription quota:
.venv/bin/python scripts/probe_companion.py --live-codex
```

The unittest provider is explicitly `test-fixture-not-ai`. Test PCM/JPEG are
fixtures, never live voice/vision evidence. The optional live probe revokes its
own test session afterward and prints no secrets. Starlette 1.8 currently emits
one upstream TestClient/httpx deprecation warning; httpx2 was not installed after
the package-similarity safety warning. No test failure is concealed by that.
Native desktop startup remains outside this headless test scope.

The web Lock & erase device control first clears local state and sensors, then
calls `DELETE /api/device` (all sessions for this pairing owner). Late pairing
responses are generation-checked and revoked; they cannot unlock a locked UI.
A standalone `DELETE /api/session` is deliberately narrower.

For the Android implementation handoff, use `docs/GROK_ANDROID_BUILD_PROMPT.md`.
The existing upstream license/attribution is unchanged: **CC BY-NC 4.0**. Personal
non-commercial adaptation is allowed; business/commercial distribution needs
separate permission/legal review. This repository is public: never commit the
private roster, provider auth, tasks, files, codes, tokens, keystores or reports.
