# Valet PWA

Installable phone app for Bags, built on the `feature/mobile-companion` backend (`companion/`).

- Served by the companion itself at `/valet/` (same origin, so pairing, WebSocket and CSP work):
  `python -m companion serve --port 8768` then open `/valet/` through your HTTPS proxy.
- Speaks companion protocol v1: `GET /health`, `POST /api/pair`, `GET /api/agents`,
  `POST /api/agents/{id}/session`, `WS /api/live` (auth first, `text` events, `interrupt`, `ping`),
  `POST /api/uploads` (raw bytes, exact MIME, `X-Upload-Consent: yes`), `/api/tasks`, `/api/events`,
  `/api/meetings/*`, `DELETE /api/device`. Bearer token is kept in memory only.
- With no companion server (e.g. static hosting, `python3 valet/server.py`), it runs an in-browser demo.

See CONNECTING.md for the exact server steps that make Bagheera answer for real.

Opens as a plain chat. The raised centre button in the tab bar starts or ends the live (hands-free) session; tabs are Talk, Agents, Calls and Activities (meetings plus status checks). Light or dark theme, saved on the device. Calls: incoming agent calls with answer or decline; answering starts a spoken hands-free conversation (demo-simulated until the server emits call.incoming).
(browser Web Speech API: dictation plus spoken replies, not full duplex). Composer: text, attach any
file (chips; server accepts JPEG/PNG/text/PDF up to 2 MB, others stay on device), attach an email
(paste or .eml, shown as a card; its text is shared as message context), hold-to-record voice notes.
No paid providers, no secrets. Fonts: Rajdhani, Manrope (SIL OFL). Icons: Tabler (MIT), inline SVG.
