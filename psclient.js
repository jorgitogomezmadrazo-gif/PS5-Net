/* PS Proxy client runtime: runs inside every proxied page and sends everything the page does back through the proxy. */
(function(){
  if (window.__PS_ON) return; window.__PS_ON = true;
  var P = "/ps/", O = location.origin, CFG = window.__PS || {};
  var RAW; try { RAW = window.sessionStorage; } catch (e) {}          // the real storage, before the per-site one below replaces it
  var MAIN = false; try { MAIN = window.parent === window.top; } catch (e) {}   // true for the page the hub's frame shows (not for frames inside that page)
  function hostNow(){ var s = location.pathname.slice(P.length), m = /^https?:\/+([^\/?#]+)/i.exec(s); return m ? m[1].toLowerCase() : ""; }
  function box(title, msg, btn, fn){
    var d = document, h = '<div style="font:16px/1.5 system-ui,sans-serif;background:#10131a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box"><div style="max-width:420px;text-align:center"><h2 style="margin:0 0 8px">' + title + '</h2><p style="opacity:.75;margin:0 0 20px">' + msg + '</p><button id=psb style="font:inherit;padding:12px 22px;border:0;border-radius:10px;background:#3b82f6;color:#fff">' + btn + '</button></div></div>';
    try { window.stop(); } catch (e) {}
    d.documentElement.innerHTML = "<head><meta name=viewport content='width=device-width,initial-scale=1'></head><body style='margin:0'>" + h + "</body>";
    var b = d.getElementById("psb"); if (b) b.onclick = fn;
  }
  function safeMode(then){ try { fetch(P + "_cfg?nodeep=" + encodeURIComponent(hostNow()), { credentials: "same-origin" }).then(then, then); } catch (e) { then(); } }
  /* v2 loop breaker: a page that reloads itself over and over (frame-busting scripts do this) freezes the whole hub, so stop it after a few rounds */
  if (MAIN && RAW) { try {
    var now = Date.now(), log = JSON.parse(RAW.getItem("ps_loads") || "[]").filter(function(x){ return now - x[0] < 8000; });
    log.push([now, location.pathname + location.search]); RAW.setItem("ps_loads", JSON.stringify(log));
    var same = log.filter(function(x){ return x[1] === location.pathname + location.search; }).length;
    if (same >= 5 || log.length >= 10) {
      RAW.removeItem("ps_loads");
      box("This page keeps reloading itself", "PS Proxy stopped it so the hub does not freeze. Safe mode loads the site with less rewriting, which fixes most of these.", "Try safe mode", function(){ safeMode(function(){ location.reload(); }); });
      return;
    }
  } catch (e) {} }

  function decode(p){ var s = p.slice(P.length), m = /^(https?):\/+(.*)$/i.exec(s); return m ? m[1].toLowerCase() + "://" + m[2] : null; }
  function target(){ var d = decode(location.pathname); return d ? d + location.search : (CFG.base || ""); }
  var BASEOV = CFG.base || null;   // only set when the page has its own <base> tag
  function realBase(){ return BASEOV || target(); }
  var TURL; try { TURL = new URL(target()); } catch (e) { TURL = new URL("https://example.com/"); }
  var HOST = TURL.host;
  var SKIP = /^\s*(#|data:|blob:|javascript:|mailto:|tel:|about:)/i;
  function px(u, b){
    try {
      if (u == null) return u; u = String(u); if (SKIP.test(u) || !u.trim()) return u;
      if (u.indexOf(P) === 0) return u; if (u.indexOf(O + P) === 0) return u.slice(O.length);
      var a = new URL(u, b || realBase());
      if (a.origin === O && a.pathname.indexOf(P) !== 0) a = new URL(a.pathname + a.search + a.hash, TURL.origin);   // the page built an address from our origin: it means the real site
      if (a.protocol !== "http:" && a.protocol !== "https:") return u;
      return P + a.href;
    } catch (e) { return u; }
  }
  function un(u){ try { u = String(u); var s = u.indexOf(O + P) === 0 ? u.slice(O.length) : u; if (s.indexOf(P) === 0) return decode(s.split("#")[0]) + (u.split("#")[1] ? "#" + u.split("#")[1] : "") || u; } catch (e) {} return u; }
  function srcset(v){ return String(v).split(",").map(function(p){ var t = p.trim().split(/\s+/); if (t[0]) t[0] = px(t[0]); return t.join(" "); }).join(", "); }
  function okNav(u){ u = String(u == null ? "" : u); var m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(u); return !m || /^(https?|blob|data|about|javascript)$/i.test(m[1]); }     // intent://, android-app://, whatsapp:// ... would leave the frame blank
  window.__PSpx = px; window.__PSun = un;

  /* network */
  var cj = {};
  function eatCookies(v){ try { if (!v) return; decodeURIComponent(v).split(/;\s*/).forEach(function(x){ var i = x.indexOf("="); if (i > 0) cj[x.slice(0, i)] = x.slice(i + 1); }); } catch (e) {} }
  eatCookies(encodeURIComponent(CFG.cookies || ""));
  var _f = window.fetch;
  if (_f) window.fetch = function(i, n){
    try { if (typeof i === "string" || i instanceof URL) i = px(i); else if (i && i.url) i = new Request(px(i.url), i); } catch (e) {}
    return _f.call(this, i, n).then(function(r){ try { eatCookies(r.headers.get("x-ps-cookies")); } catch (e) {} return r; });
  };
  var _o = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u){ var a = [].slice.call(arguments), x = this; a[1] = px(u); x.addEventListener("readystatechange", function(){ if (x.readyState === 2) { try { eatCookies(x.getResponseHeader("x-ps-cookies")); } catch (e) {} } }); return _o.apply(this, a); };
  var _b = navigator.sendBeacon; if (_b) navigator.sendBeacon = function(u, d){ return _b.call(navigator, px(u), d); };
  var _E = window.EventSource; if (_E) { window.EventSource = function(u, o){ return new _E(px(u), o); }; window.EventSource.prototype = _E.prototype; }
  var _W = window.WebSocket;
  if (_W) {
    window.WebSocket = function(u, pr){
      var a = new URL(u, realBase()); a.protocol = a.protocol === "wss:" || a.protocol === "https:" ? "https:" : "http:";
      var w = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host + P + "_ws/" + a.href;
      return pr !== undefined ? new _W(w, pr) : new _W(w);
    };
    ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function(k){ window.WebSocket[k] = _W[k]; }); window.WebSocket.prototype = _W.prototype;
  }
  /* v3: video players (Twitch, YouTube ...) start their stream code inside a worker made from a blob: it never passes through the proxy, so its segment downloads fail.
     The blob is wrapped: a small prelude first (same fetch / XHR / importScripts redirection as proxied workers), then the original worker. */
  var RETRY_FETCH = "(function(){var F=self.fetch;if(!F)return;function w(ms){return new Promise(function(r){setTimeout(r,ms)})}self.fetch=function(i,n){var u=typeof i===\"string\"?i:(i&&i.url)||\"\";if(!/\\.(m3u8|ts|m4s|aac|mpd)(\\?|$)|\\/segment\\/|\\/playlist\\//i.test(u))return F.apply(this,arguments);var a=arguments,me=this,k=0;function go(){return F.apply(me,a).then(function(r){if(r.status>=500&&k<2){k++;return w(300*k*k).then(go)}return r},function(e){if(k<2&&!(n&&n.signal&&n.signal.aborted)){k++;return w(300*k*k).then(go)}throw e})}return go()}})();";
  try { (new Function(RETRY_FETCH))(); } catch (e) {}
  function wpre(){ return 'var __PSL=new URL(' + JSON.stringify(target() || location.href) + ');(function(){var O=self.location.origin,P="/ps/";function px(u){try{var a=new URL(u,__PSL.href);if(a.origin===O&&a.pathname.indexOf(P)===0)return a.href;if(a.protocol!=="http:"&&a.protocol!=="https:")return u;return O+P+a.href}catch(e){return u}}'
    + 'if(self.fetch){var f=self.fetch;self.fetch=function(i,n){try{if(typeof i==="string"||i instanceof URL)i=px(String(i));else if(i&&i.url)i=new Request(px(i.url),i)}catch(e){}return f.call(this,i,n)}}'
    + 'if(self.XMLHttpRequest){var o=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){var a=[].slice.call(arguments);a[1]=px(u);return o.apply(this,a)}}'
    + 'if(self.importScripts){var im=self.importScripts;self.importScripts=function(){return im.apply(self,[].map.call(arguments,function(u){return px(u)}))}}})();\n' + RETRY_FETCH; }
  function wrapBlobWorker(u, o){ var mod = o && o.type === "module", code = wpre() + (mod ? "import(" + JSON.stringify(u) + ");" : "importScripts(" + JSON.stringify(u) + ");"); return URL.createObjectURL(new Blob([code], { type: "text/javascript" })); }
  ["Worker", "SharedWorker"].forEach(function(n){ var W = window[n]; if (!W) return;
    window[n] = function(u, o){ try { var su = u instanceof URL ? u.href : (typeof u === "string" ? u : ""); if (su && /^blob:/i.test(su)) u = wrapBlobWorker(su, o); else if (typeof u === "string" && !/^data:/i.test(u)) u = px(u); else if (u instanceof URL) u = px(u.href); } catch (e) {} return new W(u, o); };
    window[n].prototype = W.prototype; });
  try { var _pm = window.postMessage; window.postMessage = function(m, o, t){ if (typeof o === "string" && o !== "*" && o !== "/") o = "*"; else if (o && typeof o === "object" && o.targetOrigin && o.targetOrigin !== "/") o = Object.assign({}, o, { targetOrigin: "*" }); return _pm.call(this, m, o, t); }; } catch (e) {}
  var _wo = window.open; window.open = function(u, n){ var a = [].slice.call(arguments); if (u && !okNav(u)) return null; if (u) a[0] = px(u); if (n === "_top" || n === "_parent") a[1] = "_self"; return _wo.apply(window, a); };
  try { var hp = history.pushState, hr = history.replaceState;
    history.pushState = function(s, t, u){ return hp.call(history, s, t, u == null ? u : px(u)); };
    history.replaceState = function(s, t, u){ return hr.call(history, s, t, u == null ? u : px(u)); }; } catch (e) {}
  /* service workers can't run inside the proxy; pages get a harmless stand-in (a refusal makes some apps retry in a tight loop) */
  try { if (navigator.serviceWorker) {
    var fakeReg = function(sc){ return { scope: sc || location.origin + "/", active: null, installing: null, waiting: null, navigationPreload: { enable: function(){ return Promise.resolve(); }, disable: function(){ return Promise.resolve(); } }, pushManager: { getSubscription: function(){ return Promise.resolve(null); }, permissionState: function(){ return Promise.resolve("denied"); } }, update: function(){ return Promise.resolve(); }, unregister: function(){ return Promise.resolve(true); }, addEventListener: function(){}, removeEventListener: function(){} }; };
    navigator.serviceWorker.register = function(u, o){ return Promise.resolve(fakeReg(o && o.scope)); };
    navigator.serviceWorker.getRegistrations = function(){ return Promise.resolve([]); };
    navigator.serviceWorker.getRegistration = function(){ return Promise.resolve(undefined); };
    try { Object.defineProperty(navigator.serviceWorker, "ready", { get: function(){ return new Promise(function(){}); }, configurable: true }); } catch (e) {}
  } } catch (e) {}
  try { Object.defineProperty(window, "frameElement", { get: function(){ return null; }, configurable: true }); } catch (e) {}

  /* elements */
  function pp(C, prop){
    try { var d = Object.getOwnPropertyDescriptor(C.prototype, prop); if (!d || !d.set) return;
      Object.defineProperty(C.prototype, prop, { configurable: true, enumerable: d.enumerable, get: function(){ return un(d.get.call(this)); }, set: function(v){ d.set.call(this, px(v)); } }); } catch (e) {}
  }
  [["HTMLImageElement","src"],["HTMLScriptElement","src"],["HTMLLinkElement","href"],["HTMLAnchorElement","href"],["HTMLAreaElement","href"],["HTMLIFrameElement","src"],["HTMLSourceElement","src"],
   ["HTMLMediaElement","src"],["HTMLEmbedElement","src"],["HTMLObjectElement","data"],["HTMLFormElement","action"],["HTMLInputElement","src"],["HTMLTrackElement","src"],["HTMLVideoElement","poster"]]
    .forEach(function(x){ if (window[x[0]]) pp(window[x[0]], x[1]); });
  var URLATTR = { src:1, href:1, action:1, poster:1, formaction:1, "data-src":1 };
  var _sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(n, v){ var l = String(n).toLowerCase(); if (URLATTR[l] || (l === "data" && this.tagName === "OBJECT")) v = px(v); else if (l === "srcset") v = srcset(v); return _sa.call(this, n, v); };
  function fixEl(e){
    if (!e || e.nodeType !== 1) return;
    /* only write an attribute when it really changes: writing the same value again (app links such as android-app:// or intent:// can not be proxied) queued a new mutation every time and froze the whole hub in an endless loop */
    for (var a in URLATTR) { var v = e.getAttribute && e.getAttribute(a); if (v && !SKIP.test(v) && v.indexOf(P) !== 0) { var np = px(v); if (np !== v) _sa.call(e, a, np); } }
    if (e.tagName === "OBJECT") { var dv = e.getAttribute("data"); if (dv && !SKIP.test(dv) && dv.indexOf(P) !== 0) { var nd = px(dv); if (nd !== dv) _sa.call(e, "data", nd); } }
    if ((e.tagName === "A" || e.tagName === "AREA" || e.tagName === "FORM") && /^_(top|parent)$/i.test(e.getAttribute("target") || "")) _sa.call(e, "target", "_self");
    var ss = e.getAttribute && e.getAttribute("srcset"); if (ss && ss.indexOf(P) < 0) { var ns = srcset(ss); if (ns !== ss) _sa.call(e, "srcset", ns); }
  }
  /* new elements are fixed in small batches (big apps add thousands of nodes at once) and every element only once */
  var pend = [], pendT = 0;
  function fixTree(n){ if (!n || n.__psd) return; fixEl(n); try { n.__psd = 1; } catch (e) {} if (n.querySelectorAll) { var l = n.querySelectorAll("[src],[href],[action],[poster],[data],[srcset],[target]"); for (var i = 0; i < l.length; i++) { if (!l[i].__psd) { fixEl(l[i]); try { l[i].__psd = 1; } catch (e) {} } } } }
  function drain(){ pendT = 0; var t0 = Date.now(); while (pend.length && Date.now() - t0 < 12) fixTree(pend.shift()); if (pend.length) pendT = setTimeout(drain, 16); }
  try { new MutationObserver(function(ms){
      for (var i = 0; i < ms.length; i++) { var m = ms[i];
        if (m.type === "attributes") { try { m.target.__psd = 0; } catch (e) {} fixEl(m.target); }
        else for (var j = 0; j < m.addedNodes.length; j++) if (m.addedNodes[j].nodeType === 1) pend.push(m.addedNodes[j]); }
      if (pend.length && !pendT) pendT = setTimeout(drain, 0);
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "href", "action", "poster", "data", "srcset", "target"] }); } catch (e) {}
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest && e.target.closest("a,area"); if (!a) return;
    var h = a.getAttribute("href") || "";
    if (/^_(top|parent)$/i.test(a.getAttribute("target") || "")) a.setAttribute("target", "_self");     // a sandboxed frame is not allowed to navigate the hub: open the link in this frame instead
    if (/^\s*javascript:/i.test(h)) {         // javascript:void(0) links: keep the click handler, skip the navigation
      e.preventDefault();
      if (!a.hasAttribute("onclick") && !a.onclick) { var c = h.replace(/^\s*javascript:/i, ""); if (c && !/^\s*(void\s*\(?\s*0\s*\)?|undefined|;)?\s*;?\s*$/i.test(c)) { try { (0, eval)(decodeURIComponent(c)); } catch (x) { try { (0, eval)(c); } catch (y) {} } } }
    } else if (h && !okNav(h) && !/^\s*(mailto:|tel:|sms:)/i.test(h)) { e.preventDefault(); e.stopPropagation();          // app links do nothing instead of blanking the frame
    } else if (h && !SKIP.test(h) && h.indexOf(P) !== 0) { var nh = px(h); if (nh !== h) a.setAttribute("href", nh); }
  }, true);
  document.addEventListener("submit", function(e){ var f = e.target; if (f && f.tagName === "FORM") { if (/^_(top|parent)$/i.test(f.getAttribute("target") || "")) f.setAttribute("target", "_self"); var a = f.getAttribute("action"); f.setAttribute("action", px(a == null || a === "" ? realBase() : a)); } }, true);

  /* storage / cookies / device: every site gets its own space, and the hub's own data stays out of reach */
  var PRE = "ps:" + HOST + ":";
  function nsStore(st){
    var kc = null, kt = 0;
    function keys(){ var n = Date.now(); if (kc && n - kt < 1000) return kc; kc = []; kt = n; for (var i = 0; i < st.length; i++) { var k = st.key(i); if (k && k.indexOf(PRE) === 0) kc.push(k.slice(PRE.length)); } return kc; }
    try { window.addEventListener("storage", function(){ kc = null; }); } catch (e) {}
    return new Proxy(st, {
      get: function(t, k){
        if (k === "getItem") return function(x){ return st.getItem(PRE + x); };
        if (k === "setItem") return function(x, v){ st.setItem(PRE + x, v); kc = null; };
        if (k === "removeItem") return function(x){ st.removeItem(PRE + x); kc = null; };
        if (k === "clear") return function(){ keys().slice().forEach(function(z){ st.removeItem(PRE + z); }); kc = null; };
        if (k === "key") return function(i){ var ks = keys(); return ks[i] != null ? ks[i] : null; };
        if (k === "length") return keys().length;
        if (typeof k === "symbol") return st[k];
        var v = st.getItem(PRE + k); return v === null ? undefined : v;
      },
      set: function(t, k, v){ st.setItem(PRE + k, v); kc = null; return true; },
      deleteProperty: function(t, k){ st.removeItem(PRE + k); kc = null; return true; },
      has: function(t, k){ return st.getItem(PRE + k) !== null; },
      ownKeys: function(){ return keys().slice(); },
      getOwnPropertyDescriptor: function(t, k){ var v = st.getItem(PRE + k); return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true }; }
    });
  }
  try { var LS = nsStore(window.localStorage), SS = nsStore(window.sessionStorage);
    Object.defineProperty(window, "localStorage", { get: function(){ return LS; }, configurable: true });
    Object.defineProperty(window, "sessionStorage", { get: function(){ return SS; }, configurable: true }); } catch (e) {}
  try { var io = IDBFactory.prototype.open; IDBFactory.prototype.open = function(n, v){ return v === undefined ? io.call(this, PRE + n) : io.call(this, PRE + n, v); };
    var idl = IDBFactory.prototype.deleteDatabase; IDBFactory.prototype.deleteDatabase = function(n){ return idl.call(this, PRE + n); }; } catch (e) {}
  var ckq = [], ckT = 0;
  function ckFlush(){ ckT = 0; if (!ckq.length) return; var seen = {}, out = []; for (var i = ckq.length - 1; i >= 0; i--) { var nm = ckq[i].split("=")[0]; if (!seen[nm]) { seen[nm] = 1; out.unshift(ckq[i]); } } ckq = []; try { _f.call(window, P + "_ck", { method: "POST", body: TURL.hostname + "\n" + out.slice(-30).join("\n"), credentials: "same-origin" }); } catch (e) {} }
  try { Object.defineProperty(document, "cookie", { configurable: true,
    get: function(){ return Object.keys(cj).map(function(k){ return k + "=" + cj[k]; }).join("; "); },
    set: function(v){ v = String(v); var f = v.split(";")[0], i = f.indexOf("="); if (i > 0) { if (/max-age=0|expires=\w{3}, \d\d \w{3} 1970/i.test(v)) delete cj[f.slice(0, i)]; else cj[f.slice(0, i)] = f.slice(i + 1); }
      ckq.push(v); if (!ckT) ckT = setTimeout(ckFlush, 400); } }); } catch (e) {}
  if (CFG.ua) { try { Object.defineProperty(Navigator.prototype, "userAgent", { get: function(){ return CFG.ua; }, configurable: true });
    Object.defineProperty(Navigator.prototype, "platform", { get: function(){ return /Android|iPhone|Linux/.test(CFG.ua) ? "Linux armv8l" : /CrOS/.test(CFG.ua) ? "Linux x86_64" : "Win32"; }, configurable: true }); } catch (e) {} }

  /* "deep" mode helper: a stand-in for location that reports the real page */
  var PSL = {};
  ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"].forEach(function(k){
    Object.defineProperty(PSL, k, { enumerable: true,
      get: function(){ try { var u = new URL(target()); if (k === "hash") return location.hash; return u[k]; } catch (e) { return location[k]; } },
      set: function(v){ if (k === "href") { if (okNav(v)) location.href = px(v, realBase()); } else if (k === "hash") location.hash = v; else { try { var u = new URL(target()); u[k] = v; location.href = px(u.href); } catch (e) {} } } });
  });
  PSL.assign = function(u){ if (okNav(u)) location.assign(px(u, realBase())); }; PSL.replace = function(u){ if (okNav(u)) location.replace(px(u, realBase())); };
  PSL.reload = function(){ location.reload(); }; PSL.toString = function(){ return target(); };
  PSL.ancestorOrigins = []; PSL.valueOf = function(){ return target(); };
  try { Object.defineProperty(Document.prototype, "URL", { get: function(){ return target() + location.hash; }, configurable: true });
    Object.defineProperty(Document.prototype, "documentURI", { get: function(){ return target() + location.hash; }, configurable: true });
    Object.defineProperty(Document.prototype, "domain", { get: function(){ return TURL.hostname; }, set: function(){}, configurable: true }); } catch (e) {}
  /* links report their real address parts, so routers that compare a link's path with their routes still match */
  ["origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"].forEach(function(k){
    [window.HTMLAnchorElement, window.HTMLAreaElement].forEach(function(C){ if (!C) return;
      try { Object.defineProperty(C.prototype, k, { configurable: true, get: function(){ try { return new URL(this.href)[k]; } catch (e) { return ""; } }, set: function(v){ try { var u = new URL(this.href); u[k] = v; this.href = u.href; } catch (e) {} } }); } catch (e) {} }); });
  window.__PSL = PSL;

  /* v2 blank page watchdog: if the page ends up showing nothing, say so and offer safe mode (and try it once by itself when scripts crashed) */
  var errCount = 0, sent = 0;
  function report(m){ if (sent++ > 6) return; try { _f.call(window, P + "_log", { method: "POST", body: target() + "\n" + String(m).slice(0, 400), credentials: "same-origin" }); } catch (e) {} }
  window.addEventListener("error", function(e){ if (!e.target || e.target === window) { errCount++; report("script error: " + (e.message || "?") + " @ " + (e.filename || "").slice(-80) + ":" + (e.lineno || 0)); } else if (e.target.src || e.target.href) { report("failed to load " + (e.target.tagName || "") + " " + String(e.target.src || e.target.href).slice(0, 200)); } }, true);
  window.addEventListener("unhandledrejection", function(e){ errCount++; report("promise error: " + (e.reason && (e.reason.message || e.reason)) ); });
  function looksBlank(){
    var b = document.body; if (!b) return true;
    if (b.querySelector("canvas,video,iframe,embed,object,audio,svg,img,input,textarea,select,button")) return false;
    return (b.innerText || "").replace(/\s/g, "").length < 15;
  }
  function check(last){
    if (!MAIN || document.getElementById("ps-pill")) return;
    if (!looksBlank()) return;
    if (last) report("page looks blank after load");
    var key = "ps_auto:" + hostNow(), tried = false; try { tried = RAW && RAW.getItem(key); } catch (e) {}
    if (CFG.deep && errCount > 0 && !tried) { try { RAW.setItem(key, "1"); } catch (e) {} return safeMode(function(){ location.reload(); }); }
    if (!last) return;
    var p = document.createElement("div"); p.id = "ps-pill";
    p.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;background:#1f2937;color:#fff;font:14px system-ui,sans-serif;padding:10px 14px;border-radius:999px;box-shadow:0 4px 18px #0008;display:flex;gap:10px;align-items:center";
    p.innerHTML = "<span>This page looks blank</span>";
    function mk(t, f){ var b = document.createElement("button"); b.textContent = t; b.style.cssText = "font:inherit;border:0;border-radius:999px;padding:6px 12px;background:#3b82f6;color:#fff"; b.onclick = f; p.appendChild(b); }
    if (CFG.deep) mk("Safe mode", function(){ safeMode(function(){ location.reload(); }); }); else mk("Reload", function(){ location.reload(); });
    mk("\u00d7", function(){ p.remove(); });
    (document.body || document.documentElement).appendChild(p);
  }
  function arm(){ setTimeout(function(){ check(false); }, 3500); setTimeout(function(){ check(true); }, 9000); }
  if (document.readyState === "complete") arm(); else window.addEventListener("load", arm);
})();
