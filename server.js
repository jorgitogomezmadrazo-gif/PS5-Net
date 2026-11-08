import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

/* PS Proxy lives in psproxy.js + psclient.js. If those two files were not uploaded the hub still starts, only the proxy is off. */
let ps = { handle: () => false, fallback: () => false, upgrade: () => false };
try { ps = await import("./psproxy.js"); } catch (e) { console.error("PS Proxy NOT loaded (" + e.message.split("\n")[0] + "). Upload psproxy.js and psclient.js next to server.js."); }

const app = path.dirname(fileURLToPath(import.meta.url));
const roots = [path.join(app, "public"), app];
const types = { ".html":"text/html; charset=utf-8", ".js":"text/javascript", ".mjs":"text/javascript", ".css":"text/css", ".json":"application/json",
  ".wasm":"application/wasm", ".png":"image/png", ".jpg":"image/jpeg", ".svg":"image/svg+xml", ".mp3":"audio/mpeg", ".webp":"image/webp", ".map":"application/json" };
const blocked = /^(server\.js|psproxy\.js|psclient\.js|package(-lock)?\.json|Dockerfile|fly\.toml|\.dockerignore|README\.md)$|^(node_modules)\//;

// Looks in public/ first, then in the app folder itself (so it also works if the hub files were uploaded without the public/ folder).
function find(p, cb){
  let i = 0;
  const next = () => {
    if (i >= roots.length) return cb(null);
    const r = roots[i++], f = path.join(r, path.normalize(p));
    if (!f.startsWith(r) || (r === app && blocked.test(path.relative(app, f).replace(/\\/g, "/")))) return next();
    fs.stat(f, (e, st) => (e || !st.isFile()) ? next() : cb(f));
  };
  next();
}
const gz = new Map();   // gzip copies of big text files (the hub page is ~24 MB), made once
const textual = /^(\.html|\.js|\.mjs|\.css|\.json|\.svg|\.map)$/;
function serve(req, res, f){
  fs.stat(f, (e, st) => {
    if (e) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(f), h = { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": f.endsWith("index.html") ? "no-cache" : "public, max-age=3600", "Accept-Ranges": "bytes", "Last-Modified": st.mtime.toUTCString() };
    if (req.headers["if-modified-since"] && Date.parse(req.headers["if-modified-since"]) >= Math.floor(st.mtimeMs / 1000) * 1000 && !f.endsWith("index.html")) { res.writeHead(304, h); return res.end(); }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range && (range[1] || range[2])) {          // audio/video need this to seek and to start playing quickly
      let start = range[1] ? +range[1] : Math.max(0, st.size - +range[2]), end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) { res.writeHead(416, { "Content-Range": "bytes */" + st.size }); return res.end(); }
      res.writeHead(206, { ...h, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      const rs = fs.createReadStream(f, { start, end }); res.on("close", () => rs.destroy()); return rs.pipe(res);
    }
    if (textual.test(ext) && st.size > 2048 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      h["Content-Encoding"] = "gzip"; h["Vary"] = "Accept-Encoding"; delete h["Accept-Ranges"];
      res.writeHead(200, h); if (req.method === "HEAD") return res.end();
      const key = f + st.mtimeMs, hit = gz.get(key);
      if (hit) return res.end(hit);
      const chunks = []; const rs = fs.createReadStream(f), z = zlib.createGzip({ level: 6 });
      res.on("close", () => rs.destroy());
      z.on("data", c => { chunks.push(c); res.write(c); }); z.on("end", () => { if (st.size < 40e6) gz.set(key, Buffer.concat(chunks)); res.end(); });
      return rs.pipe(z);
    }
    h["Content-Length"] = st.size; res.writeHead(200, h);
    if (req.method === "HEAD") return res.end();
    const rs = fs.createReadStream(f); res.on("close", () => rs.destroy()); rs.pipe(res);
  });
}
const srv = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (ps.handle(req, res)) return;
  // a proxied page asked for a root-relative address (/something): it belongs to the site that page came from, not to the hub's own files
  if (req.headers.referer && /^https?:\/\/[^/]+\/ps\/(?!_)/.test(req.headers.referer) && ps.fallback(req, res)) return;
  let p; try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p.endsWith("/")) p += "index.html";
  find(p, f => {
    if (!f && p === "/index.html") {      // the hub file may have been uploaded under another name: serve the biggest top-level .html
      let best = null, size = -1;
      for (const r of roots) { try { for (const n of fs.readdirSync(r)) { if (!/\.html?$/i.test(n)) continue; const sz = fs.statSync(path.join(r, n)).size; if (sz > size) { size = sz; best = path.join(r, n); } } } catch (e) {} }
      f = best;
    }
    if (!f) { if (ps.fallback(req, res)) return; res.writeHead(404); return res.end("Not found"); }
    serve(req, res, f);
  });
});
srv.on("connection", sk => sk.setNoDelay(true)); srv.keepAliveTimeout = 75e3; srv.headersTimeout = 80e3; srv.requestTimeout = 0;   // long video / event-stream requests must not be cut off by node's 5 minute default
srv.on("upgrade", (req, socket, head) => { if (!ps.upgrade(req, socket, head)) socket.destroy(); });

// fly's dashboard sometimes generates a fly.toml with port 3000 or 8080: listen on all of them so the health check always finds the app
const ports = [...new Set([process.env.PORT, 8080, 3000].filter(Boolean).map(Number))];
srv.listen(ports[0], "0.0.0.0", () => {
  console.log("Game Hub + PS Proxy listening on " + ports[0]);
  for (const p of ports.slice(1)) { const s2 = http.createServer(srv.listeners("request")[0]); s2.on("upgrade", (...a) => srv.emit("upgrade", ...a)); s2.on("error", () => {}); s2.listen(p, "0.0.0.0"); }
});
process.on("uncaughtException", e => console.error("uncaught:", e.message));
process.on("unhandledRejection", e => console.error("unhandled:", e && e.message));

