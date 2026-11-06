import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ps from "./psproxy.js";

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
const srv = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); return res.end("ok"); }
  if (ps.handle(req, res)) return;
  let p; try { p = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p.endsWith("/")) p += "index.html";
  find(p, f => {
    if (!f && p === "/index.html") {      // the hub file may have been uploaded under another name: serve the biggest top-level .html
      let best = null, size = -1;
      for (const r of roots) { try { for (const n of fs.readdirSync(r)) { if (!/\.html?$/i.test(n)) continue; const sz = fs.statSync(path.join(r, n)).size; if (sz > size) { size = sz; best = path.join(r, n); } } } catch (e) {} }
      f = best;
    }
    if (!f) { if (ps.fallback(req, res)) return; res.writeHead(404); return res.end("Not found"); }
    const h = { "Content-Type": types[path.extname(f)] || "application/octet-stream", "Cache-Control": f.endsWith("index.html") ? "no-cache" : "public, max-age=3600" };
    res.writeHead(200, h); fs.createReadStream(f).pipe(res);
  });
});
srv.on("upgrade", (req, socket, head) => { if (!ps.upgrade(req, socket, head)) socket.destroy(); });

// fly's dashboard sometimes generates a fly.toml with port 3000 or 8080: listen on all of them so the health check always finds the app
const ports = [...new Set([process.env.PORT, 8080, 3000].filter(Boolean).map(Number))];
srv.listen(ports[0], "0.0.0.0", () => {
  console.log("Game Hub + PS Proxy listening on " + ports[0]);
  for (const p of ports.slice(1)) { const s2 = http.createServer(srv.listeners("request")[0]); s2.on("upgrade", (...a) => srv.emit("upgrade", ...a)); s2.on("error", () => {}); s2.listen(p, "0.0.0.0"); }
});
process.on("uncaughtException", e => console.error("uncaught:", e.message));
