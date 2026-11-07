/* PS Proxy - a rewriting web proxy built for the PS5 Game Hub (no dependencies).
   Pages are fetched by this server and shown under  /ps/<full address>. Needs psclient.js next to it. */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";
import vm from "node:vm";
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

/* ---- v2: outgoing connections ----
   UPSTREAM_PROXY (optional, e.g. http://user:pass@host:port) sends every request through another HTTP proxy. Sites such as Reddit refuse
   fly.io's data-center address; a proxy with a different address is the only thing that gets past that kind of block. */
const UP = (() => { try { return process.env.UPSTREAM_PROXY ? new URL(process.env.UPSTREAM_PROXY) : null; } catch (e) { console.error("UPSTREAM_PROXY is not a valid address"); return null; } })();
function tunnel(host, port, cb){
  const secure = UP.protocol === "https:";
  const sock = secure ? tls.connect({ host: UP.hostname, port: +UP.port || 443, servername: UP.hostname }) : net.connect(+UP.port || 80, UP.hostname);
  let buf = Buffer.alloc(0), done = false;
  const fail = e => { if (done) return; done = true; sock.destroy(); cb(e); };
  sock.once("error", fail); sock.setTimeout(15000, () => fail(new Error("the upstream proxy took too long")));
  const auth = UP.username ? "Proxy-Authorization: Basic " + Buffer.from(decodeURIComponent(UP.username) + ":" + decodeURIComponent(UP.password)).toString("base64") + "\r\n" : "";
  sock.once(secure ? "secureConnect" : "connect", () => sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`));
  const onData = d => {
    buf = Buffer.concat([buf, d]); const i = buf.indexOf("\r\n\r\n"); if (i < 0) return;
    sock.removeListener("data", onData); sock.pause();
    const line = buf.subarray(0, buf.indexOf("\r\n")).toString();
    if (!/^HTTP\/1\.[01] 200/.test(line)) return fail(new Error("the upstream proxy refused the connection (" + line + ")"));
    done = true; sock.setTimeout(0); sock.removeListener("error", fail);
    const rest = buf.subarray(i + 4); if (rest.length) sock.unshift(rest);
    cb(null, sock);
  };
  sock.on("data", onData);
}
function mkConn(secure){
  return function(o, cb){
    tunnel(o.host || o.hostname, +o.port || (secure ? 443 : 80), (e, sock) => {
      if (e) return cb(e);
      if (!secure) { sock.resume(); return cb(null, sock); }
      let once = false; const t = tls.connect({ socket: sock, servername: o.servername || o.host || o.hostname, ALPNProtocols: ["http/1.1"] });
      t.once("secureConnect", () => { if (!once) { once = true; cb(null, t); } }); t.once("error", er => { if (!once) { once = true; cb(er); } });
    });
  };
}
class TunnelHttps extends https.Agent {}; TunnelHttps.prototype.createConnection = mkConn(true);
class TunnelHttp extends http.Agent {}; TunnelHttp.prototype.createConnection = mkConn(false);
const agentOpts = { keepAlive: true, maxSockets: 96, maxFreeSockets: 16, keepAliveMsecs: 15000 };
const AGENT = { "https:": UP ? new TunnelHttps(agentOpts) : new https.Agent(agentOpts), "http:": UP ? new TunnelHttp(agentOpts) : new http.Agent(agentOpts) };
/* safe mode is remembered per site: "deep" script rewriting is switched off for the page's host when it makes that page blank */
const pageHostOf = (req, t) => { const ref = req.headers.referer; if (ref) { try { const r = new URL(ref); if (r.pathname.startsWith(P) && !r.pathname.startsWith(P + "_")) { const rt = parseTarget(r.pathname + r.search); if (rt) return rt.host; } } catch (e) {} } return t.host; };

const sessions = new Map();
function session(req, res, create = true){
  const m = /(?:^|;\s*)ps_sid=([a-f0-9]{32})/.exec(req.headers.cookie || "");
  let s = m && sessions.get(m[1]);
  if (!s && create) {
    const id = crypto.randomBytes(16).toString("hex");
    s = { id, jar: new Map(), cfg: { adblock: true, ua: "", nojs: false, dark: false, deep: true }, noDeep: new Set(), log: [], reqs: 0, blocked: 0, seen: Date.now() };
    sessions.set(id, s);
    if (sessions.size > 800) { const old = [...sessions.values()].sort((a, b) => a.seen - b.seen).slice(0, 200); old.forEach(o => sessions.delete(o.id)); }
    const sec = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
    res.setHeader("Set-Cookie", `ps_sid=${id}; Path=/; HttpOnly; Max-Age=31536000; SameSite=${sec ? "None; Secure" : "Lax"}`);
  }
  if (s) s.seen = Date.now();
  return s;
}

/* ---- v2 debug log: what sites answered and what crashed, shown at /ps/_debug ---- */
function note(s, o){ if (!s || !s.log) return; o.t = Date.now(); s.log.push(o); if (s.log.length > 200) s.log.shift(); }
const eh = x => String(x == null ? "" : x).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function debugPage(s){
  const rows = [...s.log].reverse().map(o => {
    const bad = o.k === "err" || o.k === "client" || (o.status >= 400);
    const tm = new Date(o.t).toLocaleTimeString();
    const txt = o.k === "res" ? `${o.status} ${o.dest || ""} ${o.url}${o.server ? "  [server: " + o.server + "]" : ""}${o.hint ? "  <- " + o.hint : ""}` : o.k === "err" ? `FAILED ${o.url}  ${o.msg}` : `PAGE ${o.url}  ${o.msg}`;
    return `<div style="padding:6px 8px;border-bottom:1px solid #2a3140;${bad ? "color:#ff8a8a" : "opacity:.8"}">${tm} ${eh(txt)}</div>`;
  }).join("") || "<p>Nothing recorded yet. Use a site through the proxy, then reload this page.</p>";
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>PS Proxy debug</title><body style="font:13px/1.4 ui-monospace,monospace;background:#10131a;color:#e6e8ee;margin:0"><div style="padding:12px 8px"><b>PS Proxy 2.0 debug</b> &middot; requests ${s.reqs} &middot; <a style="color:#8cf" href="">reload</a> &middot; red = problems. Screenshot this page and send it.</div>${rows}`;
}
const hintFor = (st, hd) => st === 403 || st === 429 ? ((hd.server || "") + " " + (hd["cf-mitigated"] || "")).match(/cloudflare|akamai|envoy|reddit|tsa/i) || st === 429 ? "the site is refusing this server's address (rate-limit / bot block)" : "site refused the request" : st >= 500 ? "the site itself had an error" : "";

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
const attrRe = /(\s(?:href|src|action|poster|formaction|background|data-src|data-href|data-lazy-src|cite|manifest|xlink:href)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
function rewriteCss(css, base){
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, u) => /^(data:|#)/i.test(u) ? m : "url(" + q + px(u.replace(/&amp;/g, "&"), base) + q + ")")
    .replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, u) => "@import " + q + px(u, base) + q);
}
function rewriteSrcset(v, base){
  return v.split(",").map(p => { const t = p.trim().split(/\s+/); if (!t[0]) return ""; t[0] = px(t[0], base); return t.join(" "); }).join(", ");
}
const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unEnt = s => s.replace(/&quot;/g, '"').replace(/&#0*39;|&#x27;|&apos;/gi, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const enc = s => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
/* Rewrites the attributes of ONE tag. (Only ever called on real tags, so JavaScript text like  var src = "x"  inside a <script> is never touched.) */
function rewriteTag(name, attrs, base, s, deep){
  name = name.toLowerCase();
  if (name === "meta") {
    if (/http-equiv\s*=\s*["']?(?:content-security-policy|x-frame-options)/i.test(attrs)) return "";
    if (/\bname\s*=\s*["']?referrer/i.test(attrs)) return "";
    if (/http-equiv\s*=\s*["']?refresh/i.test(attrs)) attrs = attrs.replace(/(content\s*=\s*["'][^"']*?url\s*=\s*)([^"']+)/i, (m, pre, u) => pre + px(unEnt(u.trim()), base));
    return "<meta" + attrs + ">";
  }
  attrs = attrs.replace(/\s(?:integrity|crossorigin|referrerpolicy|nonce)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
               .replace(/\s(?:integrity|crossorigin)(?=[\s/]|$)/gi, "")
               .replace(/(\starget\s*=\s*["']?)_(?:top|parent)\b/gi, "$1_self");      // the frame may not navigate the hub (no allow-top-navigation), so these would just do nothing
  if (s.cfg.nojs) attrs = attrs.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
  else if (deep) attrs = attrs.replace(/(\son[a-z]+\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, a, b) => { const v = unEnt(a ?? b ?? ""); return /location/.test(v) ? pre + '"' + enc(deepSafe(v)) + '"' : m; });
  attrs = attrs.replace(attrRe, (m, pre, a, b, c) => {
    const v = a ?? b ?? c ?? "", q = a != null ? '"' : b != null ? "'" : '"';
    return pre + q + enc(px(unEnt(v), base)) + q;
  });
  if (name === "object") attrs = attrs.replace(/(\sdata\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, a, b) => pre + '"' + enc(px(unEnt(a ?? b), base)) + '"');
  attrs = attrs.replace(/(\s(?:srcset|data-srcset|imagesrcset)\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, a, b) => pre + '"' + enc(rewriteSrcset(unEnt(a ?? b), base)) + '"');
  attrs = attrs.replace(/(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (m, pre, a, b) => pre + '"' + enc(rewriteCss(unEnt(a ?? b), base)) + '"');
  return "<" + name + attrs + ">";
}
const TAG_RE = /<!--[\s\S]*?-->|<(script|style|textarea|title)\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)(?:<\/\1\s*>|$)|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
function rewriteHtml(html, target, s, deep){
  let base = target.href;
  const bm = /<base\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/i.exec(html);
  if (bm) { try { base = new URL(bm[1] ?? bm[2] ?? bm[3], target.href).href; } catch (e) {} html = html.replace(bm[0], ""); }
  html = html.replace(TAG_RE, (m, rawName, rawAttrs, body, name, attrs) => {
    if (m.startsWith("<!--")) return m;                                  // comments are left alone
    if (rawName) {                                                      // <script> <style> <textarea> <title>: rewrite the tag, treat the text as code/text
      const ln = rawName.toLowerCase(), open = rewriteTag(ln, rawAttrs, base, s, deep), close = "</" + ln + ">";
      if (ln === "script") {
        if (s.cfg.nojs) return "";
        const isData = /type\s*=\s*["']?(?:application\/(?:ld\+)?json|text\/template|text\/x-|importmap|speculationrules)/i.test(rawAttrs);
        return open + (deep && !isData && !/\bsrc\s*=/i.test(rawAttrs) ? deepSafe(body) : body) + close;
      }
      if (ln === "style") return open + rewriteCss(body, base) + close;
      return open + body + close;
    }
    return rewriteTag(name, attrs, base, s, deep);
  });
  const info = { base: bm ? base : "", cookies: jarGet(s, target, true), ua: s.cfg.ua ? UAS[s.cfg.ua] : "", deep: !!deep };
  const head = '<script>window.__PS=' + JSON.stringify(info).replace(/</g, "\\u003c") + ';</script><script src="/ps/_client.js"></script>' +
    (s.cfg.dark ? "<style>html{filter:invert(1) hue-rotate(180deg)!important;background:#fff}img,video,canvas,picture,iframe,svg image{filter:invert(1) hue-rotate(180deg)!important}</style>" : "");
  if (/<head(?:\s[^>]*)?>/i.test(html)) return html.replace(/<head(?:\s[^>]*)?>/i, m => m + head);
  if (/<html(?:\s[^>]*)?>/i.test(html)) return html.replace(/<html(?:\s[^>]*)?>/i, m => m + "<head>" + head + "</head>");
  const dt = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i.exec(html);          // keep the doctype first, or the browser drops into quirks mode
  return dt ? dt[0] + head + html.slice(dt[0].length) : head + html;
}
/* deep mode: make scripts read the REAL page address instead of the proxy's */
const REG_PREV = "(,=:[!&|?{};+-*%<>~^";
function deepJs(js){
  const fixBare = (m, pre, off, str) => {
    const end = off + m.length;
    const after = (str.slice(end, end + 40).match(/^\s*(\S?)/) || [, ""])[1];           // only look at a few characters (a slice of the whole file for every match made big scripts freeze the server)
    let k = off + pre.length - 1; while (k >= 0 && /\s/.test(str[k])) k--;
    const before = k >= 0 ? str[k] : "";
    if (!/[.\[);,}\]=?]/.test(after) && after !== "") return m;           // only when it is used as a value
    if (before === "{" && after === "}") return m;                          // {location} shorthand
    if (before === "{" && after === ",") return m;
    if (after === "=" && /^\s*==/.test(str.slice(end, end + 8))) return pre + "__PSL";
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

/* the rewritten script must still be valid JavaScript; if the rewrite ever broke it, the original is used instead (a page that loads beats a blank page) */
const parses = code => {
  try { new vm.Script(code); return true; } catch (e) {}
  try { if (vm.SourceTextModule) { new vm.SourceTextModule(code); return true; } } catch (e) {}
  return false;
};
const deepCache = new Map();
function deepSafe(js){
  if (js.length > 5e6 || !/location/.test(js)) return js;
  const key = crypto.createHash("sha1").update(js).digest("hex"), hit = deepCache.get(key); if (hit != null) return hit;
  let out = js;
  try { const r = deepJs(js); out = (r === js || parses(r) || !parses(js)) ? r : js; } catch (e) { out = js; }
  deepCache.set(key, out); if (deepCache.size > 150) deepCache.delete(deepCache.keys().next().value);
  return out;
}
const SKIP_REQ = /^(host|connection|keep-alive|proxy-.*|te|trailer|upgrade|transfer-encoding|accept-encoding|cookie|origin|referer|sec-fetch-.*|x-forwarded-.*|x-real-ip|forwarded|fly-.*|via|cf-.*|cdn-loop|x-request-start|x-request-id|x-envoy-.*|x-vercel-.*|x-amzn-.*|ps-.*)$/i;
function cleanReqHeaders(req, s, t){
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) if (!SKIP_REQ.test(k)) h[k] = v;      // everything the page sent (client-id, authorization, csrf tokens ...) goes through
  h["user-agent"] = s.cfg.ua ? UAS[s.cfg.ua] : (req.headers["user-agent"] || UAS.desktop);
  h["accept-encoding"] = "gzip, deflate, br";
  h.host = t.host;
  const ck = jarGet(s, t, false); if (ck) h.cookie = ck;
  let pageOrigin = ""; const ref = req.headers.referer;
  if (ref) { try { const r = new URL(ref); if (r.pathname.startsWith(P)) { const rt = parseTarget(r.pathname + r.search); if (rt) { h.referer = rt.href; pageOrigin = rt.origin; } } } catch (e) {} }
  if (req.headers.origin) h.origin = pageOrigin || t.origin;          // the page's own site, like a real browser sends
  else if (pageOrigin && pageOrigin !== t.origin && req.headers["sec-fetch-dest"] === "empty") h.origin = pageOrigin;   // a real browser adds Origin to cross-site fetch/XHR calls
  if (!h.referer && req.headers.origin) h.referer = t.origin + "/";
  return h;
}
const DROP = new Set(["content-security-policy", "content-security-policy-report-only", "x-frame-options", "strict-transport-security", "set-cookie", "report-to", "nel",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy", "permissions-policy", "alt-svc", "link", "public-key-pins", "clear-site-data"]);
const rewritable = ct => /text\/html|application\/xhtml/i.test(ct) ? "html" : /text\/css/i.test(ct) ? "css" : /javascript|ecmascript/i.test(ct) ? "js" : "";

/* code added in front of scripts that run inside a Worker (workers get no psclient.js, but rewritten scripts still mention __PSL) */
const WORKER_PRELUDE = '/*ps-worker*/var __PSL=(function(){try{var s=self.location.pathname.slice(4),m=/^(https?):\\/+(.*)$/i.exec(s);return new URL(m?m[1].toLowerCase()+"://"+m[2]+self.location.search:self.location.href)}catch(e){return self.location}})();' +
  '(function(){var O=self.location.origin,P="/ps/";function px(u){try{var a=new URL(u,__PSL.href);if(a.origin===O&&a.pathname.indexOf(P)===0)return a.href;if(a.protocol!=="http:"&&a.protocol!=="https:")return u;return O+P+a.href}catch(e){return u}}' +
  'if(self.fetch){var f=self.fetch;self.fetch=function(i,n){try{if(typeof i==="string"||i instanceof URL)i=px(String(i));else if(i&&i.url)i=new Request(px(i.url),i)}catch(e){}return f.call(this,i,n)}}' +
  'if(self.XMLHttpRequest){var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=px(u);return o.apply(this,a)}}' +
  'if(self.importScripts){var im=self.importScripts;self.importScripts=function(){return im.apply(self,[].map.call(arguments,function(u){return px(u)}))}}})();\n';
const MAX_REWRITE = 30e6;      // bigger text files are streamed through untouched instead of being held in memory (a 256MB fly machine would crash)
const lastOrigin = (res, s, origin) => { try { res.appendHeader("Set-Cookie", `ps_lo=${encodeURIComponent(origin)}; Path=/; Max-Age=86400; SameSite=Lax`); } catch (e) {} };

function fail(res, t, msg){
  if (res.headersSent) { try { res.destroy(); } catch (e) {} return; }
  try {
    res.writeHead(502, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;background:#10131a;color:#fff;padding:40px"><h2>PS Proxy couldn't open that page</h2><p>${esc(t.href)}</p><p style="opacity:.7">${esc(msg)}</p><p><a style="color:#8cf" href="javascript:location.reload()">Try again</a></p>`);
  } catch (e) { try { res.destroy(); } catch (x) {} }
}

function proxy(req, res, s, t){
  s.reqs++;
  if (s.cfg.adblock && isAd(t.hostname)) {
    s.blocked++;
    res.writeHead(/\.js(\?|$)/.test(t.pathname) ? 200 : 204, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }); return res.end("");
  }
  const lib = t.protocol === "https:" ? https : http;
  const dest = String(req.headers["sec-fetch-dest"] || "");
  const deep = s.cfg.deep && !s.noDeep.has(pageHostOf(req, t));
  let up, tries = 0, got = false;
  const nf = m => { note(s, { k: "err", url: t.href, msg: m }); fail(res, t, m); };
  // when the browser gives up on a request (video seek, page change, tab closed) stop the upstream download too, otherwise sockets pile up until the proxy freezes
  res.on("close", () => { if (!res.writableEnded && up) up.destroy(); });
  const attempt = () => {
    tries++;
    try {
      up = lib.request({ protocol: t.protocol, hostname: t.hostname, port: t.port || (t.protocol === "https:" ? 443 : 80), path: t.pathname + t.search, method: req.method, headers: cleanReqHeaders(req, s, t), timeout: 30000, agent: AGENT[t.protocol] });
    } catch (e) { return nf(e.message); }
    up.on("response", r => { got = true; onResponse(r); });
    up.on("timeout", () => up.destroy(new Error("The site took too long to answer (30s)")));
    up.on("error", e => {
      // a kept-alive connection that the site had already closed: just try once more on a fresh one
      if (!got && tries < 2 && (req.method === "GET" || req.method === "HEAD") && /ECONNRESET|EPIPE|socket hang up/i.test(e.code + " " + e.message) && !res.headersSent && !res.destroyed) return attempt();
      nf(e.message);
    });
    if (req.method === "GET" || req.method === "HEAD") up.end(); else { req.on("error", () => up.destroy()); req.pipe(up); }
  };
  const onResponse = r => {
    try {
      try { up.setTimeout(0); } catch (e) {}                                       // the 30s limit is only for connecting / waiting for the first byte; videos and event streams may take longer
      const rc = r.headers["set-cookie"]; if (rc) (Array.isArray(rc) ? rc : [rc]).forEach(c => jarSet(s, t.hostname, c));
      const h = {};
      for (const [k, v] of Object.entries(r.headers)) if (!DROP.has(k) && !/^(connection|keep-alive|transfer-encoding|proxy-.*)$/.test(k)) h[k] = v;
      h["access-control-allow-origin"] = req.headers.origin || "*"; h["access-control-allow-credentials"] = "true";
      h["access-control-expose-headers"] = "*"; h["referrer-policy"] = "same-origin";      // keeps the Referer on every click so relative links always find their real site
      { const cv = jarGet(s, t, true); if (cv && cv.length < 6000) h["x-ps-cookies"] = encodeURIComponent(cv); }       // lets the page's scripts see cookies the server just set (csrf tokens etc.)
      if (r.headers.location) { h.location = px(r.headers.location, t.href); }
      if (r.statusCode >= 400 || /^(document|iframe|frame)$/.test(dest)) note(s, { k: "res", status: r.statusCode, dest: dest, url: t.href, server: r.headers.server || "", hint: hintFor(r.statusCode, r.headers) });
      let kind = rewritable(r.headers["content-type"] || "");
      if (/^(worker|sharedworker)$/.test(dest) && kind === "js") kind = "worker";
      const len = +r.headers["content-length"] || 0;
      if (!kind || req.method === "HEAD" || r.statusCode === 304 || r.statusCode === 206 || r.statusCode === 204 || len > MAX_REWRITE || ((kind === "js" || kind === "worker") && !deep)) {
        res.writeHead(r.statusCode, h); r.on("error", () => res.destroy()); return r.pipe(res);
      }
      // text we rewrite: decompress, rewrite, send as utf-8
      const enc = (r.headers["content-encoding"] || "").toLowerCase(); delete h["content-encoding"]; delete h["content-length"]; delete h.etag;
      let stream = r; if (enc === "gzip") stream = r.pipe(zlib.createGunzip()); else if (enc === "br") stream = r.pipe(zlib.createBrotliDecompress()); else if (enc === "deflate") stream = r.pipe(zlib.createInflate());
      const chunks = []; let size = 0;
      stream.on("data", c => { size += c.length; if (size > MAX_REWRITE * 2) { up.destroy(); nf("That file is too large to open through the proxy."); } else chunks.push(c); });
      stream.on("error", () => { nf("The site sent a broken or cut-off response."); });
      r.on("error", () => { nf("The connection to the site dropped."); });
      stream.on("end", () => {
        try {
          const buf = Buffer.concat(chunks), cs = /charset=([\w-]+)/i.exec(r.headers["content-type"] || "") || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString("latin1"));
          let text; try { text = new TextDecoder(cs ? cs[1] : "utf-8").decode(buf); } catch (e) { text = buf.toString("utf8"); }
          if (kind === "html") {
            if (r.statusCode >= 300 && r.statusCode < 400 && !text.trim()) text = "";
            else { text = rewriteHtml(text, t, s, deep); lastOrigin(res, s, t.origin); }
          } else if (kind === "css") text = rewriteCss(text, t.href);
          else if (kind === "worker") text = WORKER_PRELUDE + deepSafe(text);
          else text = deepSafe(text);
          h["content-type"] = (kind === "html" ? "text/html" : kind === "css" ? "text/css" : "text/javascript") + "; charset=utf-8";
          h["cache-control"] = "no-cache";
          res.writeHead(r.statusCode, h); res.end(text);
        } catch (e) { nf("Could not process the page: " + e.message); }
      });
    } catch (e) { nf(e.message); }
  };
  attempt();
}

const json = (res, o) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(o)); };
export function handle(req, res){
  const u = req.url;
  if (!u.startsWith(P)) return false;
  const s = session(req, res);
  if (u === P + "_client.js") { res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=300" }); res.end(CLIENT()); return true; }
  if (u.startsWith(P + "_status")) { json(res, { ps: 1, name: "PS Proxy", version: "2.0", cfg: s.cfg, requests: s.reqs, blocked: s.blocked, upstreamProxy: !!UP, safeHosts: [...s.noDeep] }); return true; }
  if (u.startsWith(P + "_cfg")) {
    const q = new URL(u, "http://x").searchParams;
    for (const k of ["adblock", "nojs", "dark", "deep"]) if (q.has(k)) s.cfg[k] = q.get(k) === "1";
    if (q.has("nodeep")) { const h = q.get("nodeep").toLowerCase().replace(/[^a-z0-9.:-]/g, ""); if (h) s.noDeep.add(h); if (s.noDeep.size > 500) s.noDeep.clear(); }   // v2 safe mode for one site
    if (q.has("ua")) s.cfg.ua = UAS[q.get("ua")] ? q.get("ua") : "";
    json(res, { ps: 1, cfg: s.cfg }); return true;
  }
  if (u.startsWith(P + "_debug")) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); res.end(debugPage(s)); return true; }
  if (u.startsWith(P + "_log") && req.method === "POST") {
    let b = ""; req.on("data", c => { if (b.length < 2048) b += c; }); req.on("end", () => { const i = b.indexOf("\n"); note(s, { k: "client", url: i > 0 ? b.slice(0, i) : "", msg: b.slice(i + 1) }); res.writeHead(204); res.end(); }); return true;
  }
  if (u.startsWith(P + "_clear")) { s.jar.clear(); s.noDeep.clear(); json(res, { ps: 1, cleared: true }); return true; }
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
/* a proxied page asked for a root-relative file we didn't rewrite (e.g. made by a script): send it to the right site using the Referer (or, if the browser sent none, the last page the proxy showed) */
export function fallback(req, res){
  let t = null;
  const ref = req.headers.referer;
  if (ref) { try { const r = new URL(ref); if (r.pathname.startsWith(P) && !r.pathname.startsWith(P + "_")) t = parseTarget(r.pathname + r.search); } catch (e) {} }
  if (!t && !ref) {
    const m = /(?:^|;\s*)ps_lo=([^;]+)/.exec(req.headers.cookie || "");
    if (m) { try { t = new URL(decodeURIComponent(m[1])); } catch (e) {} }
  }
  if (!t) return false;
  res.writeHead(307, { Location: P + t.origin + req.url, "Cache-Control": "no-store" }); res.end(); return true;
}
export function upgrade(req, socket, head){
  if (!req.url.startsWith(P + "_ws/")) return false;
  const s = session(req, { setHeader(){} }, false);
  let t; try { t = new URL(req.url.slice((P + "_ws/").length).replace(/^(https?):\/+/i, "$1://")); } catch (e) { socket.destroy(); return true; }
  const secure = t.protocol === "https:", port = +t.port || (secure ? 443 : 80);
  socket.on("error", () => {});
  const open = cb => {
    if (!UP) { const c = secure ? tls.connect({ host: t.hostname, port, servername: t.hostname }) : net.connect(port, t.hostname); c.once(secure ? "secureConnect" : "connect", () => cb(c)); c.on("error", () => socket.destroy()); socket.on("error", () => c.destroy()); return; }
    tunnel(t.hostname, port, (e, raw) => {
      if (e) return socket.destroy();
      if (!secure) { raw.resume(); return cb(raw); }
      const c = tls.connect({ socket: raw, servername: t.hostname }); c.once("secureConnect", () => cb(c)); c.on("error", () => socket.destroy()); socket.on("error", () => c.destroy());
    });
  };
  open(up => {
    up.on("error", () => socket.destroy());
    const h = Object.assign({}, req.headers, { host: t.host, origin: t.origin });
    delete h.cookie; if (s) { const ck = jarGet(s, new URL(t.href.replace(/^ws/, "http")), false); if (ck) h.cookie = ck; }
    up.write(`GET ${t.pathname}${t.search} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => k + ": " + v).join("\r\n") + "\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(socket); socket.pipe(up);
  });
  return true;
}



