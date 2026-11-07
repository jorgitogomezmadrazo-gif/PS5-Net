# Game Hub + PS Proxy (fly.io)

Files (upload all of them, keep them together):
- `public/index.html` - the hub
- `server.js` - small web server
- `psproxy.js` - the PS Proxy
- `psclient.js` - PS Proxy's script that runs inside proxied pages
- `package.json`, `Dockerfile`, `fly.toml`

Deploy: edit `fly.toml` (change the app name), then `fly launch --no-deploy --copy-config` and `fly deploy`.
If a proxy file is missing, the build stops with "MISSING FILE" instead of failing later.

## PS Proxy v2

New in v2:
- **Loop breaker**: a page that reloads itself over and over (frame-busting scripts) is stopped after a few rounds, so the hub no longer freezes.
- **Blank page watchdog + safe mode**: if a page shows nothing, a small "This page looks blank" bar appears with a **Safe mode** button. If the page's scripts crashed, safe mode is tried once automatically. Safe mode is remembered per site (PS tools > reset clears it).
- **Upstream proxy (optional)**: some sites (Reddit, parts of Twitch/YouTube) refuse fly.io's data-center address with "blocked by network security". Code cannot fix that. If you have an HTTP proxy with a different address, run:
  `fly secrets set UPSTREAM_PROXY=http://user:pass@host:port`
  and every request (and WebSocket) goes through it. Unset it to go back to direct.
- Stale keep-alive connections are retried once, abandoned downloads are cancelled, `/ps/_status` reports `version: "2.0"`.
- fly.toml: higher connection limit and 1 GB memory (see comments in the file).
