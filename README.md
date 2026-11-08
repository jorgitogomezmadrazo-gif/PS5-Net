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
- **Debug page**: after a page fails, open `/ps/_debug` on your site. It lists what each site answered (403 from Cloudflare = the site blocks this server's address) and which scripts crashed. Screenshot it when asking for help.

## v3 changes
- Fixed freeze: link fixer no longer loops on app links (intent://, android-app://); app links are ignored instead of blanking the page.
- Faster storage/cookies, service-worker stand-in, frame-buster checks neutralized.
- Video: HLS (.m3u8) and DASH (.mpd) manifests are rewritten through the proxy; Range requests pass through; iframe allows autoplay/fullscreen/PiP.
- Sites that block datacenter IPs (e.g. Reddit): set UPSTREAM_PROXY. Debug log: /ps/_debug. DRM video is not supported.

## v3.1 – new Music app (PS Music)
- Rebuilt Music app: 3-panel layout (library, artist/album pages, now-playing with synced lyrics from lrclib.net).
- Import (top right): Spotify track / album / playlist / artist links or direct audio URLs, plus files from your device.
- Spotify imports play 30s previews in the app; the Spotify button under the lyrics swaps in Spotify's own player for the full song (needs a Spotify login in the browser).
- Reading album/playlist track lists uses a new server endpoint /ps/_raw (allow-listed to Spotify + lyrics hosts), so psproxy.js must be uploaded too.
- Lyrics: matched by artist + cleaned title + song length (wrong-length versions are rejected), 60fps sync, per-song timing nudge (− / +), tap-a-line sync for 30s previews, exact sync through the Spotify player (iFrame API).
- Spotify imports no longer use 30s previews: they play in full through Spotify's own player (hidden behind the app's controls; needs a Spotify login in the browser). Lyrics sync to its exact position.
- Optional "Sign in with Spotify" (Settings in the Music app): Web Playback SDK, Premium required. Create an app at developer.spotify.com/dashboard, add the Redirect URI shown in Settings (https://YOUR-APP.fly.dev/spotify-callback.html), paste the Client ID. public/spotify-callback.html must be uploaded.

## PS Proxy v3
- Video: blob web workers (used by Twitch, YouTube and most players for their stream code) are now wrapped so their playlist and segment downloads go through the proxy; Twitch's `#EXT-X-TWITCH-PREFETCH` lines and unquoted playlist URIs are rewritten.
- Speed: connection pool 96 -> 512 sockets per site, DNS answers cached 60s, TCP no-delay, scripts/styles/images/fonts the site marks cacheable are kept in a 96MB memory cache (and cached in the browser), everything the proxy rewrites is sent compressed (brotli/gzip).
- /ps/_status shows version 3.0 and cache stats; /ps/_debug is unchanged.
- v3.1 reliability: video requests (playlists, segments) are retried automatically (server side up to 4 tries on resets, timeouts and 5xx; browser/worker side 2 more), stalled video downloads are cut after 25s so the player re-requests, and Twitch video servers get twitch.tv Origin/Referer headers.

## Using a Wisp server (optional)
Set the secret/env var `WISP_URL` to your Wisp server's address, e.g. `fly secrets set WISP_URL=wss://your-wisp-server.example/wisp/`.
All upstream connections then go through it (a Wisp server relays TCP over one WebSocket), so websites see the Wisp server's address instead of Fly's.
TLS still ends inside PS Proxy, so the relay sees only host:port. If both are set, `UPSTREAM_PROXY` wins. /ps/_status shows `"wisp": true` when active.
Only use a Wisp server you run yourself or that its owner lets you use.
- Control Center > Proxy (globe icon): turn PS Proxy on/off and enter your own Wisp server (wss://.../wisp/). It is tested when you save, remembered by the hub and re-applied to every new session. Per-session on the server, so it never affects other visitors. Private/local addresses are refused unless the env var ALLOW_PRIVATE_WISP=1 is set.
