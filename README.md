# Game Hub + PS Proxy (fly.io)

Files (upload all of them, keep them together):
- `public/index.html` - the hub
- `server.js` - small web server
- `psproxy.js` - the PS Proxy
- `psclient.js` - PS Proxy's script that runs inside proxied pages
- `package.json`, `Dockerfile`, `fly.toml`

Deploy: edit `fly.toml` (change the app name), then `fly launch --no-deploy --copy-config` and `fly deploy`.
If a proxy file is missing, the build stops with "MISSING FILE" instead of failing later.
