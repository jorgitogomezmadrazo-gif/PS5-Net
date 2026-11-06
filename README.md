# Game Hub + PS Proxy (fly.io)

Deploy: edit `fly.toml` (change the app name), then `fly launch --no-deploy --copy-config` and `fly deploy`.
No packages are installed: the server (`server.js`, `psproxy.js`, `psclient.js`) uses only what Node already has.

Files: `public/index.html` is the hub, `public/apps/` the extra apps. Keep `server.js`, `psproxy.js` and `psclient.js` together.

## PS Proxy
Links added to the hub open through `/ps/<address>`. In the player bar: **Proxy: ON/OFF** and **PS tools**
(ad blocker, dark mode, no-JS reader mode, deep mode, browser identity, clear cookies).
Extra addresses: `/ps/_go?q=...` (address or search), `/ps/_status`, `/ps/_cfg?...`.
Cookies are kept on the server per visitor; each site gets its own storage space.
Limits: sites that check their own address need Deep mode, and some sites (heavy logins, DRM video) may still refuse to work.
