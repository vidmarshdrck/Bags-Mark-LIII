# Valet PWA

Installable phone app for Bags, built on the `feature/mobile-companion` backend (`companion/`).

- Served by the companion itself at `/valet/` (same origin, so pairing, WebSocket and CSP work):
  `python -m companion serve --port 8768` then open `/valet/` through your HTTPS proxy.
- Speaks companion protocol v1: `GET /health`, `POST /api/pair`, `GET /api/agents`,
  `POST /api/agents/{id}/session`, `WS /api/live` (auth first, `text` events, `interrupt`, `ping`),
  `POST /api/uploads` (raw bytes, exact MIME, `X-Upload-Consent: yes`), `/api/tasks`, `/api/events`,
  `/api/meetings/*`, `DELETE /api/device`. Bearer token is kept in memory only.
- With no companion server (e.g. static hosting, `python3 valet/server.py`), it runs an in-browser demo.

Opens as a plain chat. Live (hands-free) session starts only when you tap **Start live session**
(browser Web Speech API: dictation plus spoken replies, not full duplex). Composer: text, attach any
file (chips; server accepts JPEG/PNG/text/PDF up to 2 MB, others stay on device), attach an email
(paste or .eml, shown as a card; its text is shared as message context), hold-to-record voice notes.
No paid providers, no secrets. Fonts: Rajdhani, Manrope (SIL OFL). Icons: Tabler (MIT), inline SVG.
