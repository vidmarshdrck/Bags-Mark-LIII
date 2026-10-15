# Bags mobile companion

A hardware-independent entry point: `python -m companion serve --text-provider codex`.
The official Codex CLI must already be installed/logged in; no new subscription
or provider credential is purchased or inferred. Plain `serve` can run honestly
unavailable for transport/setup testing.

- [Setup, security, exact HTTP/WS and meeting contracts](../docs/COMPANION.md)
- [Grok Android build prompt](../docs/GROK_ANDROID_BUILD_PROMPT.md)

Run `python -m unittest discover -s tests -v` and
`node --test tests/browser_companion.test.cjs` from the repository root.
No Qt/PortAudio or server microphone is required. See the main guide for the
private loopback service, one-time pairing, existing-subscription live text
probe, and the still-missing public HTTPS/native duplex/specialist runtime paths.

Personal/non-commercial use only under the repository's existing CC BY-NC 4.0
license and FatihMakes attribution. Never commit private runtime files.
