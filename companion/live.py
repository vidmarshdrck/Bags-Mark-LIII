"""Mobile protocol v1. Binary = mono PCM16LE 16kHz in / 24kHz out."""
import asyncio
import base64
import binascii
import io
import json
import time
from PIL import Image, UnidentifiedImageError
from starlette.websockets import WebSocketDisconnect

MAX_FRAME = 256 * 1024


def jpeg_bytes(data):
    """Decode and bound the actual image, not merely the client MIME label."""
    if len(data) > MAX_FRAME:
        raise ValueError('image_too_large')
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != 'JPEG' or image.width > 1280 or image.height > 1280:
                raise ValueError('jpeg_required_max_1280')
            image.verify()
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ValueError('invalid_jpeg') from exc
    return data


async def live_socket(ws):
    app = ws.app
    store = app.state.store
    origin = ws.headers.get('origin')
    expected = app.state.allowed_origin or ('https' if ws.url.scheme == 'wss' else 'http') + '://' + ws.url.netloc
    if origin and origin != expected:
        await ws.close(code=4403)
        return
    await ws.accept()
    sid = None
    registered = False
    try:
        auth = await asyncio.wait_for(ws.receive_json(), 5)
        token = auth.get('token') if auth.get('type') == 'auth' else None
        sid = store.authenticate(token)
        if not sid:
            await ws.close(code=4401)
            return
        if sid in app.state.active:
            await ws.close(code=4409)
            return
        app.state.active.add(sid)
        registered = True
        app.state.connections[sid] = ws
        stop, closed = asyncio.Event(), asyncio.Event()
        app.state.stops[sid] = (stop, closed)
        provider = app.state.agent_routes.provider_for(store, sid)
        agent_id = store.identity(sid)['agent_id']
        async with provider.connect() as connection:
            await ws.send_json({'type': 'ready', 'protocol': 1, 'session_id': sid,
                                'provider': provider.status(), 'camera': False, 'agent_id': agent_id,
                                'audio_input': 'pcm_s16le_16000_mono',
                                'audio_output': 'pcm_s16le_24000_mono'})

            paused = False

            async def output():
                if connection is None:
                    await asyncio.Future()
                    return
                async for event in connection.events():
                    if not store.authenticate(token):
                        await ws.close(code=4401)
                        return
                    if paused:
                        continue
                    if isinstance(event, bytes):
                        await ws.send_bytes(event)
                    else:
                        await ws.send_json(event)

            async def input_loop():
                nonlocal paused
                camera, last_frame = False, 0.0
                window, count = time.monotonic(), 0
                while True:
                    message = await asyncio.wait_for(ws.receive(), 60)
                    if message['type'] == 'websocket.disconnect':
                        return
                    if not store.authenticate(token):
                        await ws.close(code=4401)
                        return
                    now = time.monotonic()
                    count = count + 1 if now - window < 1 else 1
                    if now - window >= 1:
                        window = now
                    if count > 100:
                        await ws.close(code=4429)
                        return
                    try:
                        binary = message.get('bytes')
                        if binary is not None:
                            if paused:
                                raise ValueError('paused')
                            if not connection:
                                raise ValueError('provider_unavailable')
                            if not 0 < len(binary) <= 64000 or len(binary) % 2:
                                raise ValueError('invalid_pcm')
                            await connection.send_audio(binary)
                            continue
                        raw = message.get('text') or ''
                        if len(raw) > 360000:
                            raise ValueError('message_too_large')
                        event = json.loads(raw)
                        kind = event.get('type')
                        if kind == 'ping':
                            await ws.send_json({'type': 'pong'})
                        elif kind == 'interrupt':
                            # Clear client playback; provider VAD handles actual speech barge-in.
                            if connection and hasattr(connection, 'interrupt'):
                                await connection.interrupt()
                            await ws.send_json({'type': 'interrupted', 'scope': 'client_playback'})
                        elif kind == 'privacy.pause':
                            camera, paused = False, True
                            if connection:
                                if hasattr(connection, 'interrupt'):
                                    await connection.interrupt()
                                await connection.audio_end()
                            await ws.send_json({'type': 'paused', 'camera': False})
                        elif kind == 'privacy.resume':
                            paused = False
                            await ws.send_json({'type': 'resumed', 'camera': False})
                        elif kind == 'camera.set':
                            enabled = event.get('enabled')
                            if not isinstance(enabled, bool):
                                raise ValueError('boolean_required')
                            if paused and enabled:
                                raise ValueError('paused')
                            camera = enabled
                            await ws.send_json({'type': 'camera.state', 'enabled': camera})
                        elif kind == 'camera.frame':
                            if not camera:
                                raise ValueError('camera_off')
                            if now - last_frame < 1:
                                raise ValueError('frame_rate_limit')
                            if not connection:
                                raise ValueError('provider_unavailable')
                            data = base64.b64decode(event.get('jpeg', ''), validate=True)
                            data = jpeg_bytes(data)
                            last_frame = now
                            await connection.send_image(data)
                        elif kind == 'audio.end':
                            if connection:
                                await connection.audio_end()
                            await ws.send_json({'type': 'audio.ended'})
                        elif kind in ('text', 'attachment'):
                            if paused:
                                raise ValueError('paused')
                            if not connection:
                                raise ValueError('provider_unavailable')
                            if kind == 'attachment':
                                await app.state.send_attachment(connection, sid, event.get('id'))
                            else:
                                text = event.get('text')
                                if not isinstance(text, str) or not 0 < len(text) <= 4096:
                                    raise ValueError('invalid_text')
                                await connection.send_text(text)
                        else:
                            raise ValueError('unknown_event')
                    except (ValueError, TypeError, AttributeError, binascii.Error) as exc:
                        known = str(exc)
                        allowed = {'paused', 'provider_unavailable', 'invalid_pcm', 'message_too_large',
                                   'boolean_required', 'camera_off', 'frame_rate_limit', 'image_too_large',
                                   'jpeg_required_max_1280', 'invalid_jpeg', 'invalid_text', 'unknown_event',
                                   'attachment_not_found', 'attachment_not_supported'}
                        await ws.send_json({'type': 'error', 'error': known if known in allowed else 'invalid_event'})

            async def lifetime():
                # Independent deadline/revocation watcher: no client/provider traffic required.
                while True:
                    identity = store.identity(sid)
                    remaining = identity['expires_at'] - time.time() if identity else 0
                    if stop.is_set() or remaining <= 0 or not store.authenticate(token):
                        await ws.close(code=4401)
                        return
                    try:
                        await asyncio.wait_for(stop.wait(), min(1, remaining))
                    except asyncio.TimeoutError:
                        pass

            tasks = [asyncio.create_task(input_loop()), asyncio.create_task(output()),
                     asyncio.create_task(lifetime())]
            try:
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
            finally:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
    except (WebSocketDisconnect, asyncio.TimeoutError, asyncio.CancelledError):
        # ASGI servers cancel the connection task on shutdown/disconnect.
        # Child tasks are cancelled above; do not surface lifecycle cancellation as a provider fault.
        pass
    except Exception:
        # Provider exceptions may include credentials/URLs: never send/log their raw strings.
        try:
            await ws.send_json({'type': 'error', 'error': 'provider_connection_failed'})
            await ws.close(code=1011)
        except RuntimeError:
            pass
    finally:
        if registered:
            app.state.active.discard(sid)
            app.state.connections.pop(sid, None)
            lifecycle = app.state.stops.pop(sid, None)
            if lifecycle:
                lifecycle[1].set()
