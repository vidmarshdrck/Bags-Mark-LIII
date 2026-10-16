# Connecting the Valet app to Bagheera for real

Today the app runs in two modes:
- **Demo** (no server found): replies, calls and status checks are simulated in the browser.
- **Companion** (served by `python -m companion` on this branch at `/valet/`): pairing, live text socket,
  uploads, activities (tasks/events) and meetings are real. Tested on a box with `--text-provider none`.

Bagheera only *answers* once two server-side things exist. Both are VPS work, so they go through Bags,
and both need Shadrick's go-ahead.

## 1. Text provider (Bagheera's brain), no new spend
Uses the Codex subscription Shadrick already pays for, via the official CLI (no keys in the app).
```sh
cd ~/Bags-Mark-LIII && git fetch && git checkout feature/valet-pwa
uv venv .venv && uv pip install --python .venv/bin/python -r requirements-companion.txt
codex --version            # must already be logged in with the existing subscription; never copy auth files
.venv/bin/python -m unittest discover -s tests
.venv/bin/python -m companion serve --text-provider codex --port 8768 \
    --origin https://<YOUR-DOMAIN> --root-path /bags-mark      # run under pm2 or systemd
```
Optional real roster: `.venv/bin/python -m companion sync-agents --company <PAPERCLIP_COMPANY_UUID>`, then restart.

## 2. Public HTTPS route (so the phone can reach it)
The service binds to 127.0.0.1:8768 only. An admin adds a TLS reverse proxy, for example in nginx:
```nginx
location /bags-mark/ {
    proxy_pass http://127.0.0.1:8768/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;      # WebSocket for /api/live
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 120s;
}
```
Then `sudo nginx -t && sudo systemctl reload nginx`.

## 3. Pair the phone
1. Open `https://<YOUR-DOMAIN>/bags-mark/valet/` on the phone and choose Add to Home Screen.
2. On the server, run `.venv/bin/python -m companion pair` in a private terminal (the code lasts 5 minutes).
3. In the app, tap the status chip at the top, enter the code and tap **Pair device**. The chip should read **Connected**.
   The session lasts one hour, and there is no refresh, so pair again after that.

## Known gaps (not solved by the steps above)
- **Hermes @Bagsvalet_bot:** the companion's Bagheera is a *separate session*, not the Telegram runtime,
  so it doesn't share Telegram memory. A bridge from the companion to the Hermes profile is separate, reviewed work.
- **Incoming calls:** the companion only emits `task.completed` / `task.failed` events. The app already handles
  `{"type":"call.incoming","agent_id":"bags","speech":"<reason>"}` on `GET /api/events`, but no server code emits it yet.
  Calls are demo-only until something adds that event (e.g. a scheduled briefing in `companion/tasks.py`).
- **Voice:** live session and calls use the phone browser's Web Speech API (dictation plus spoken replies), not
  realtime server audio. Other agents stay **disconnected** until a real agent runtime bridge exists.
