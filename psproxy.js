/* PS Proxy - a rewriting web proxy built for the PS5 Game Hub (no dependencies).
   Pages are fetched by this server and shown under  /ps/<full address>. Needs psclient.js next to it. */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = () => fs.readFileSync(path.join(HERE, "psclient.js"));
const P = "/ps/";
const UAS = {
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  mobile:  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  iphone:  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  chromeos:"Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
};
const ADS = ["doubleclick.net","googlesyndication.com","googleadservices.com","google-analytics.com","googletagmanager.com","googletagservices.com","adservice.google.com",
  "adnxs.com","adsrvr.org","amazon-adsystem.com","taboola.com","outbrain.com","criteo.com","criteo.net","pubmatic.com","rubiconproject.com","openx.net","casalemedia.com",
  "scorecardresearch.com","quantserve.com","moatads.com","2mdn.net","adform.net","smartadserver.com","yieldmo.com","teads.tv","mgid.com","popads.net","propellerads.com",
  "adcolony.com","applovin.com","unityads.unity3d.com","ads.pubmatic.com","hotjar.com","fullstory.com","facebook.net","connect.facebook.net"];
const isAd = h => ADS.some(d => h === d || h.endsWith("." + d));

const sessions = new Map();
function session(req, res, create = true){
  const m = /(?:^|;\s*)ps_sid=([a-f0-9]{32})/.exec(req.headers.cookie || "");
  let s = m && sessions.get(m[1]);
  if (!s && create) {
    const id = crypto.randomBytes(16).toString("hex");
    s = { id, jar: new Map(), cfg: { adblock: true, ua: "", nojs: false, dark: false, deep: true }, reqs: 0, blocked: 0, seen: Date.now() };
    sessions.set(id, s);
    if (sessions.size > 800) { const old = [...sessions.values()].sort((a, b) => a.seen - b.seen).slice(0, 200); old.forEach(o => sessions.delete(o.id)); }
    const sec = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
    res.setHeader("Set-Cookie", `ps_sid=${id}; Path=/; HttpOnly; Max-Age=31536000; SameSite=${sec ? "None; Secure" : "Lax"}`);
  }
  if (s) s.seen = Date.now();
  return s;
}

/* ---- cookie jar ---- */
function jarSet(s, host, raw){
  const parts = raw.split(";").map(x => x.trim()), eq = parts[0].indexOf("="); if (eq < 1) return;
  const c = { name: parts[0].slice(0, eq), v: parts[0].slice(eq + 1), domain: host, path: "/", exp: 0, httpOnly: false, secure: false, host };
  for (const a of parts.slice(1)) {
    const [k, ...r] = a.split("="), v = r.join("="), kl = k.toLowerCase();
    if (kl === "domain" && v) c.domain = v.replace(/^\./, "").toLowerCase();
    else if (kl === "path" && v) c.path = v;
    else if (kl === "expires") { const t = Date.parse(v); if (t) c.exp = t; }
    else if (kl === "max-age") c.exp = Date.now() + (+v) * 1000;
    else if (kl === "httponly") c.httpOnly = true;
    else if (kl === "secure") c.secure = true;
  }
  if (!(host === c.domain || host.endsWith("." + c.domain))) return;
  const key = c.domain + "|" + c.path + "|" + c.name;
  if (c.exp && c.exp < Date.now()) s.jar.delete(key); else s.jar.set(key, c);
}
function jarGet(s, u, forScript){
  const out = [];
  for (const [k, c] of s.jar) {
    if (c.exp && c.exp < Date.now()) { s.jar.delete(k); continue; }
    if (!(u.hostname === c.domain || u.hostname.endsWith("." + c.domain))) continue;
    if (!u.pathname.startsWith(c.path)) continue;
    if (c.secure && u.protocol !== "https:") continue;
    if (forScript && c.httpOnly) continue;
    out.push(c.name + "=" + c.v);
  }
  return out.join("; ");
}

/* ---- url helpers ---- */
function parseTarget(reqUrl){
  let s = reqUrl.slice(P.length);
  if (/^https?%3A/i.test(s)) { try { s = decodeURIComponent(s); } catch (e) {} }
  const m = /^(https?):\/+(.*)$/i.exec(s);
  s = m ? m[1].toLowerCase() + "://" + m[2] : "https://" + s;
  try { return new URL(s); } catch (e) { return null; }
}
const px = (u, base) => {
  try {
    u = String(u).trim();
    if (!u || /^(#|data:|blob:|javascript:|mailto:|tel:|about:)/i.test(u)) return u;
    if (u.startsWith(P)) return u;
    const a = new URL(u, base);
    if (a.protocol !== "http:" && a.protocol !== "https:") return u;
    return P + a.href;
  } catch (e) { return u; }
};
const attrRe = /(\s(?:href|src|action|poster|data|formaction|background|data-src|data-href|data-lazy-src|cite|manifest|xlink:href)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
function rewriteCss(css, base){
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => /^(data:|#)/i.test(u) ? m : "url(" + q + px(u.replace(/&amp;/g, "&"), base) + q + ")")
    .replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, u) => "@import " + q + px(u, base) + q);
}
function rewriteSrcset(v, base){
  return v.split(",").map(p => { const t = p.trim().split(/\s+/); if (!t[0]) return ""; t[0] = px(t[0], base); return t.join(" "); }).join(", ");
}
const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
function rewriteHtml(html, target, s){
  let base = target.href;
  const bm = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/i.exec(html);
  if (bm) { try { base = new URL(bm[1] ?? bm[2] ?? bm[3], target.href).href; } catch (e) {} html = html.replace(bm[0], ""); }
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?(?:content-security-policy|x-frame-options)[^>]*>/gi, "");
  html = html.replace(/\s(?:integrity|crossorigin)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  if (s.cfg.nojs) html = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "").replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
  html = html.replace(attrRe, (m, pre, a, b, c) => {
    const v = a ?? b ?? c ?? "", q = a != null ? '"' : b != null ? "'" : '"';
    return pre + q + px(v.replace(/&amp;/g, "&"), base).replace(/&/g, "&amp;").replace(/"/g, "&quot;") + q;
  });
  html = html.replace(/(\s(?:srcset|data-srcset|imagesrcset)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, a, b) => pre + '"' + rewriteSrcset(a ?? b, base) + '"');
  html = html.replace(/(<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*content\s*=\s*["'][^"']*?url=)([^"']+)/gi, (m, pre, u) => pre + px(u, base));
  html = html.replace(/(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, a, b) => pre + '"' + rewriteCss(a ?? b, base).replace(/"/g, "&quot;") + '"');
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, z) => a + rewriteCss(css, base) + z);
  if (s.cfg.deep) html = html.replace(/(<script\b(?![^>]*\bsrc=)[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, a, js, z) => /type\s*=\s*["']?(?:application\/(?:ld\+)?json|text\/template|importmap)/i.test(a) ? m : a + deepJs(js) + z);
  const info = { base: bm ? base : "", cookies: jarGet(s, target, true), ua: s.cfg.ua ? UAS[s.cfg.ua] : "" };
  const head = '<script>window.__PS=' + JSON.stringify(info).replace(/</g, "\\u003c") + ';</script><script src="/ps/_client.js"></script>' +
    (s.cfg.dark ? "<style>html{filter:invert(1) hue-rotate(180deg)!important;background:#fff}img,video,canvas,picture,iframe,svg image{filter:invert(1) hue-rotate(180deg)!important}</style>" : "");
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + head);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => m + "<head>" + head + "</head>");
  return head + html;
}
/* deep mode: make scripts read the REAL page address instead of the proxy's */
const REG_PREV = "(,=:[!&|?{};+-*%<>~^";
function deepJs(js){
  const fixBare = (m, pre, off, str) => {
    const after = (str.slice(off + m.length).match(/^\s*(\S?)/) || [, ""])[1];
    const before = (str.slice(0, off + pre.length).match(/(\S?)\s*$/) || [, ""])[1];
    if (!/[.\[);,}\]=?]/.test(after) && after !== "") return m;           // only when it is used as a value
    if ((before === "{" || before === ",") && (after === "}") && before === "{") return m;   // {location} shorthand
    if (after === "=" && /^\s*==/.test(str.slice(off + m.length))) return pre + "__PSL";
    if (after === "=") return pre + "__PSL.href";
    return pre + "__PSL";
  };
  const fix = c => c
    .replace(/\b(?:window|self|document|top|parent|globalThis)\s*\.\s*location\s*=(?!=)/g, "__PSL.href=")
    .replace(/\b(?:window|self|document|top|parent|globalThis)\s*\.\s*location\b/g, "__PSL")
    .replace(/(^|[^\w$.])location\b(?!\s*:)/g, fixBare);
  const n = js.length; let out = "", cs = 0, i = 0;
  const flush = e => { if (e > cs) out += fix(js.slice(cs, e)); };
  const skipTo = (from, to) => { flush(from); out += js.slice(from, to); cs = to; i = to; };
  while (i < n) {                         // only touch real code: strings, comments and regex literals are left alone
    const ch = js.charCodeAt(i), c = js[i];
    if (c === '"' || c === "'") {
      let j = i + 1; while (j < n && js[j] !== c && js[j] !== "\n") { if (js[j] === "\\") j++; j++; }
      skipTo(i, j + 1);
    } else if (c === "`") {
      let j = i + 1, piece = i; flush(i); out += "`"; cs = i + 1;
      while (j < n && js[j] !== "`") {
        if (js[j] === "\\") { j += 2; continue; }
        if (js[j] === "$" && js[j + 1] === "{") {            // code inside ${ } is code again
          out += js.slice(cs, j + 2); let d = 1, k = j + 2; while (k < n && d) { if (js[k] === "{") d++; else if (js[k] === "}") d--; k++; }
          out += deepJs(js.slice(j + 2, k - 1)) + "}"; cs = k; j = k; continue;
        }
        j++;
      }
      out += js.slice(cs, j + 1); cs = j + 1; i = j + 1;
    } else if (c === "/" && js[i + 1] === "/") { let j = js.indexOf("\n", i); if (j < 0) j = n; skipTo(i, j); }
    else if (c === "/" && js[i + 1] === "*") { let j = js.indexOf("*/", i + 2); j = j < 0 ? n : j + 2; skipTo(i, j); }
    else if (c === "/") {                  // division or a regular expression?
      let k = i - 1; while (k >= 0 && /\s/.test(js[k])) k--;
      const pv = k >= 0 ? js[k] : "(";
      if (REG_PREV.includes(pv) || /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw)$/.test(js.slice(Math.max(0, k - 8), k + 1))) {
        let j = i + 1, cls = false; while (j < n && js[j] !== "\n") { if (js[j] === "\\") j++; else if (js[j] === "[") cls = true; else if (js[j] === "]") cls = false; else if (js[j] === "/" && !cls) break; j++; }
        skipTo(i, j + 1);
      } else i++;
    } else i++;
  }
  flush(n);
  return out;
}

function cleanReqHeaders(req, s, t){
  const h = {};
  for (const k of ["accept", "accept-language", "range", "content-type", "content-length", "if-none-match", "if-modified-since", "if-range", "cache-control", "pragma", "x-requested-with"]) if (req.headers[k]) h[k] = req.headers[k];
  h["user-agent"] = s.cfg.ua ? UAS[s.cfg.ua] : (req.headers["user-agent"] || UAS.desktop);
  h["accept-encoding"] = "gzip, deflate, br";
  h.host = t.host;
  const ck = jarGet(s, t, false); if (ck) h.cookie = ck;
  if (req.headers.origin) h.origin = t.origin;
  const ref = req.headers.referer; if (ref) { try { const r = new URL(ref); if (r.pathname.startsWith(P)) { const rt = parseTarget(r.pathname + r.search); if (rt) h.referer = rt.href; } } catch (e) {} }
  if (!h.referer && req.headers.origin) h.referer = t.origin + "/";
  return h;
}
const DROP = new Set(["content-security-policy", "content-security-policy-report-only", "x-frame-options", "strict-transport-security", "set-cookie", "report-to", "nel",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy", "permissions-policy", "alt-svc", "link", "public-key-pins", "clear-site-data"]);
const rewritable = ct => /text\/html|application\/xhtml/i.test(ct) ? "html" : /text\/css/i.test(ct) ? "css" : /javascript|ecmascript/i.test(ct) ? "js" : "";

function proxy(req, res, s, t, hops = 0){
  s.reqs++;
  if (s.cfg.adblock && isAd(t.hostname)) {
    s.blocked++;
    res.writeHead(/\.js(\?|$)/.test(t.pathname) ? 200 : 204, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); return res.end("");
  }
  const lib = t.protocol === "https:" ? https : http;
  const up = lib.request({ protocol: t.protocol, hostname: t.hostname, port: t.port || (t.protocol === "https:" ? 443 : 80), path: t.pathname + t.search, method: req.method, headers: cleanReqHeaders(req, s, t), timeout: 30000 }, r => {
    const rc = r.headers["set-cookie"]; if (rc) (Array.isArray(rc) ? rc : [rc]).forEach(c => jarSet(s, t.hostname, c));
    const h = {};
    for (const [k, v] of Object.entries(r.headers)) if (!DROP.has(k)) h[k] = v;
    h["access-control-allow-origin"] = req.headers.origin || "*"; h["access-control-allow-credentials"] = "true";
    if (r.headers.location) { h.location = px(r.headers.location, t.href); }
    const kind = rewritable(r.headers["content-type"] || "");
    if (!kind || req.method === "HEAD" || r.statusCode === 304 || r.statusCode === 206 || (kind === "js" && !s.cfg.deep)) { res.writeHead(r.statusCode, h); return r.pipe(res); }
    // text we rewrite: decompress, rewrite, send as utf-8
    const enc = (r.headers["content-encoding"] || "").toLowerCase(); delete h["content-encoding"]; delete h["content-length"]; delete h.etag;
    let stream = r; if (enc === "gzip") stream = r.pipe(zlib.createGunzip()); else if (enc === "br") stream = r.pipe(zlib.createBrotliDecompress()); else if (enc === "deflate") stream = r.pipe(zlib.createInflate());
    const chunks = []; stream.on("data", c => chunks.push(c)); stream.on("error", () => { try { res.destroy(); } catch (e) {} });
    stream.on("end", () => {
      const buf = Buffer.concat(chunks), cs = /charset=([\w-]+)/i.exec(r.headers["content-type"] || "") || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString("latin1"));
      let text; try { text = new TextDecoder(cs ? cs[1] : "utf-8").decode(buf); } catch (e) { text = buf.toString("utf8"); }
      text = kind === "html" ? rewriteHtml(text, t, s) : kind === "css" ? rewriteCss(text, t.href) : deepJs(text);
      h["content-type"] = (kind === "html" ? "text/html" : kind === "css" ? "text/css" : "text/javascript") + "; charset=utf-8";
      h["cache-control"] = "no-cache";
      res.writeHead(r.statusCode, h); res.end(text);
    });
  });
  up.on("timeout", () => up.destroy(new Error("timed out")));
  up.on("error", e => { if (res.headersSent) return res.destroy(); res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" }); res.end(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;background:#10131a;color:#fff;padding:40px"><h2>PS Proxy couldn't open that page</h2><p>${esc(t.href)}</p><p style="opacity:.7">${esc(e.message)}</p>`); });
  if (req.method === "GET" || req.method === "HEAD") up.end(); else req.pipe(up);
}

const json = (res, o) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
export function handle(req, res){
  const u = req.url;
  if (!u.startsWith(P)) return false;
  const s = session(req, res);
  if (u === P + "_client.js") { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=300" }); res.end(CLIENT()); return true; }
  if (u.startsWith(P + "_status")) { json(res, { ps: 1, name: "PS Proxy", version: "1.0", cfg: s.cfg, requests: s.reqs, blocked: s.blocked }); return true; }
  if (u.startsWith(P + "_cfg")) {
    const q = new URL(u, "http://x").searchParams;
    for (const k of ["adblock", "nojs", "dark", "deep"]) if (q.has(k)) s.cfg[k] = q.get(k) === "1";
    if (q.has("ua")) s.cfg.ua = UAS[q.get("ua")] ? q.get("ua") : "";
    json(res, { ps: 1, cfg: s.cfg }); return true;
  }
  if (u.startsWith(P + "_clear")) { s.jar.clear(); json(res, { ps: 1, cleared: true }); return true; }
  if (u.startsWith(P + "_go")) {
    const q = (new URL(u, "http://x").searchParams.get("q") || "").trim();
    const dest = /^[\w-]+(\.[\w-]+)+(\/|$|:|\?)/.test(q) || /^https?:\/\//i.test(q) ? (/^https?:/i.test(q) ? q : "https://" + q) : "https://duckduckgo.com/?q=" + encodeURIComponent(q);
    res.writeHead(302, { Location: P + dest }); res.end(); return true;
  }
  if (u.startsWith(P + "_ck") && req.method === "POST") {
    let b = ""; req.on("data", c => { if (b.length < 8192) b += c; }); req.on("end", () => { const i = b.indexOf("\n"); if (i > 0) jarSet(s, b.slice(0, i), b.slice(i + 1)); res.writeHead(204); res.end(); }); return true;
  }
  if (u.startsWith(P + "_ws/")) { res.writeHead(426); res.end("WebSocket only"); return true; }
  const t = parseTarget(u);
  if (!t) { res.writeHead(400); res.end("Bad address"); return true; }
  proxy(req, res, s, t); return true;
}
/* a proxied page asked for a root-relative file we didn't rewrite (e.g. made by a script): send it to the right site using the Referer */
export function fallback(req, res){
  const ref = req.headers.referer; if (!ref) return false;
  let r; try { r = new URL(ref); } catch (e) { return false; }
  if (!r.pathname.startsWith(P) || r.pathname.startsWith(P + "_")) return false;
  const t = parseTarget(r.pathname + r.search); if (!t) return false;
  res.writeHead(307, { Location: P + t.origin + req.url, "Cache-Control": "no-store" }); res.end(); return true;
}
export function upgrade(req, socket, head){
  if (!req.url.startsWith(P + "_ws/")) return false;
  const s = session(req, { setHeader(){} }, false);
  let t; try { t = new URL(req.url.slice((P + "_ws/").length).replace(/^(https?):\/+/i, "$1://")); } catch (e) { socket.destroy(); return true; }
  const secure = t.protocol === "https:", port = +t.port || (secure ? 443 : 80);
  const up = (secure ? tls.connect({ host: t.hostname, port, servername: t.hostname }) : net.connect(port, t.hostname));
  up.on("error", () => socket.destroy()); socket.on("error", () => up.destroy());
  up.once(secure ? "secureConnect" : "connect", () => {
    const h = Object.assign({}, req.headers, { host: t.host, origin: t.origin });
    delete h.cookie; if (s) { const ck = jarGet(s, new URL(t.href.replace(/^ws/, "http")), false); if (ck) h.cookie = ck; }
    up.write(`GET ${t.pathname}${t.search} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  return true;
}



