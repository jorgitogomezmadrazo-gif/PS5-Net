/* PS Proxy client runtime: runs inside every proxied page and sends everything the page does back through the proxy. */
(function(){
  if (window.__PS_ON) return; window.__PS_ON = true;
  var P = "/ps/", O = location.origin, CFG = window.__PS || {};
  function decode(p){ var s = p.slice(P.length), m = /^(https?):\/+(.*)$/i.exec(s); return m ? m[1].toLowerCase() + "://" + m[2] : null; }
  function target(){ var d = decode(location.pathname); return d ? d + location.search : (CFG.base || ""); }
  function realBase(){ return CFG.base || target(); }
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
  window.__PSpx = px; window.__PSun = un;

  /* network */
  var _f = window.fetch; if (_f) window.fetch = function(i, n){ try { if (typeof i === "string" || i instanceof URL) i = px(i); else if (i && i.url) i = new Request(px(i.url), i); } catch (e) {} return _f.call(this, i, n); };
  var _o = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function(m, u){ var a = [].slice.call(arguments); a[1] = px(u); return _o.apply(this, a); };
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
  var _wo = window.open; window.open = function(u){ var a = [].slice.call(arguments); if (u) a[0] = px(u); return _wo.apply(window, a); };
  try { var hp = history.pushState, hr = history.replaceState;
    history.pushState = function(s, t, u){ return hp.call(history, s, t, u == null ? u : px(u)); };
    history.replaceState = function(s, t, u){ return hr.call(history, s, t, u == null ? u : px(u)); }; } catch (e) {}
  try { if (navigator.serviceWorker) navigator.serviceWorker.register = function(){ return Promise.reject(new Error("service workers are off inside PS Proxy")); }; } catch (e) {}

  /* elements */
  function pp(C, prop){
    try { var d = Object.getOwnPropertyDescriptor(C.prototype, prop); if (!d || !d.set) return;
      Object.defineProperty(C.prototype, prop, { configurable: true, enumerable: d.enumerable, get: function(){ return un(d.get.call(this)); }, set: function(v){ d.set.call(this, px(v)); } }); } catch (e) {}
  }
  [["HTMLImageElement","src"],["HTMLScriptElement","src"],["HTMLLinkElement","href"],["HTMLAnchorElement","href"],["HTMLAreaElement","href"],["HTMLIFrameElement","src"],["HTMLSourceElement","src"],
   ["HTMLMediaElement","src"],["HTMLEmbedElement","src"],["HTMLObjectElement","data"],["HTMLFormElement","action"],["HTMLInputElement","src"],["HTMLTrackElement","src"],["HTMLVideoElement","poster"]]
    .forEach(function(x){ if (window[x[0]]) pp(window[x[0]], x[1]); });
  var URLATTR = { src:1, href:1, action:1, poster:1, data:1, formaction:1, "data-src":1 };
  var _sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(n, v){ var l = String(n).toLowerCase(); if (URLATTR[l]) v = px(v); else if (l === "srcset") v = srcset(v); return _sa.call(this, n, v); };
  function fixEl(e){
    if (!e || e.nodeType !== 1) return;
    for (var a in URLATTR) { var v = e.getAttribute && e.getAttribute(a); if (v && !SKIP.test(v) && v.indexOf(P) !== 0) _sa.call(e, a, px(v)); }
    var ss = e.getAttribute && e.getAttribute("srcset"); if (ss && ss.indexOf(P) < 0) _sa.call(e, "srcset", srcset(ss));
  }
  function fixTree(n){ fixEl(n); if (n.querySelectorAll) [].forEach.call(n.querySelectorAll("[src],[href],[action],[poster],[data],[srcset]"), fixEl); }
  try { new MutationObserver(function(ms){ ms.forEach(function(m){ if (m.type === "attributes") fixEl(m.target); else [].forEach.call(m.addedNodes, fixTree); }); })
    .observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "href", "action", "poster", "data", "srcset"] }); } catch (e) {}
  document.addEventListener("click", function(e){
    var a = e.target && e.target.closest && e.target.closest("a,area"); if (!a) return;
    var h = a.getAttribute("href") || "";
    if (/^\s*javascript:/i.test(h)) {         // javascript:void(0) links: keep the click handler, skip the navigation
      e.preventDefault();
      if (!a.hasAttribute("onclick") && !a.onclick) { var c = h.replace(/^\s*javascript:/i, ""); if (c && !/^\s*(void\s*\(?\s*0\s*\)?|undefined|;)?\s*;?\s*$/i.test(c)) { try { (0, eval)(decodeURIComponent(c)); } catch (x) { try { (0, eval)(c); } catch (y) {} } } }
    } else if (h && !SKIP.test(h) && h.indexOf(P) !== 0) { a.setAttribute("href", h); }
  }, true);
  document.addEventListener("submit", function(e){ var f = e.target; if (f && f.tagName === "FORM") { var a = f.getAttribute("action"); f.setAttribute("action", px(a == null || a === "" ? realBase() : a)); } }, true);

  /* storage / cookies / device: every site gets its own space, and the hub's own data stays out of reach */
  var PRE = "ps:" + HOST + ":";
  function nsStore(st){
    return new Proxy(st, {
      get: function(t, k){
        if (k === "getItem") return function(x){ return st.getItem(PRE + x); };
        if (k === "setItem") return function(x, v){ st.setItem(PRE + x, v); };
        if (k === "removeItem") return function(x){ st.removeItem(PRE + x); };
        if (k === "clear") return function(){ Object.keys(st).filter(function(z){ return z.indexOf(PRE) === 0; }).forEach(function(z){ st.removeItem(z); }); };
        if (k === "key") return function(i){ var ks = Object.keys(st).filter(function(z){ return z.indexOf(PRE) === 0; }); return ks[i] != null ? ks[i].slice(PRE.length) : null; };
        if (k === "length") return Object.keys(st).filter(function(z){ return z.indexOf(PRE) === 0; }).length;
        if (typeof k === "symbol") return st[k];
        var v = st.getItem(PRE + k); return v === null ? undefined : v;
      },
      set: function(t, k, v){ st.setItem(PRE + k, v); return true; },
      deleteProperty: function(t, k){ st.removeItem(PRE + k); return true; },
      has: function(t, k){ return st.getItem(PRE + k) !== null; },
      ownKeys: function(){ return Object.keys(st).filter(function(z){ return z.indexOf(PRE) === 0; }).map(function(z){ return z.slice(PRE.length); }); },
      getOwnPropertyDescriptor: function(t, k){ var v = st.getItem(PRE + k); return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true }; }
    });
  }
  try { var LS = nsStore(window.localStorage), SS = nsStore(window.sessionStorage);
    Object.defineProperty(window, "localStorage", { get: function(){ return LS; }, configurable: true });
    Object.defineProperty(window, "sessionStorage", { get: function(){ return SS; }, configurable: true }); } catch (e) {}
  try { var io = IDBFactory.prototype.open; IDBFactory.prototype.open = function(n, v){ return v === undefined ? io.call(this, PRE + n) : io.call(this, PRE + n, v); };
    var idl = IDBFactory.prototype.deleteDatabase; IDBFactory.prototype.deleteDatabase = function(n){ return idl.call(this, PRE + n); }; } catch (e) {}
  var cj = {}; String(CFG.cookies || "").split(/;\s*/).forEach(function(c){ var i = c.indexOf("="); if (i > 0) cj[c.slice(0, i)] = c.slice(i + 1); });
  try { Object.defineProperty(document, "cookie", { configurable: true,
    get: function(){ return Object.keys(cj).map(function(k){ return k + "=" + cj[k]; }).join("; "); },
    set: function(v){ v = String(v); var f = v.split(";")[0], i = f.indexOf("="); if (i > 0) { if (/max-age=0|expires=\w{3}, \d\d \w{3} 1970/i.test(v)) delete cj[f.slice(0, i)]; else cj[f.slice(0, i)] = f.slice(i + 1); }
      try { _f.call(window, P + "_ck", { method: "POST", body: TURL.hostname + "\n" + v, credentials: "same-origin" }); } catch (e) {} } }); } catch (e) {}
  if (CFG.ua) { try { Object.defineProperty(Navigator.prototype, "userAgent", { get: function(){ return CFG.ua; }, configurable: true });
    Object.defineProperty(Navigator.prototype, "platform", { get: function(){ return /Android|iPhone|Linux/.test(CFG.ua) ? "Linux armv8l" : /CrOS/.test(CFG.ua) ? "Linux x86_64" : "Win32"; }, configurable: true }); } catch (e) {} }

  /* "deep" mode helper: a stand-in for location that reports the real page */
  var PSL = {};
  ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"].forEach(function(k){
    Object.defineProperty(PSL, k, { enumerable: true,
      get: function(){ try { var u = new URL(realBase()); if (k === "hash") return location.hash; return u[k]; } catch (e) { return location[k]; } },
      set: function(v){ if (k === "href") location.href = px(v, realBase()); else if (k === "hash") location.hash = v; else { try { var u = new URL(realBase()); u[k] = v; location.href = px(u.href); } catch (e) {} } } });
  });
  PSL.assign = function(u){ location.assign(px(u, realBase())); }; PSL.replace = function(u){ location.replace(px(u, realBase())); };
  PSL.reload = function(){ location.reload(); }; PSL.toString = function(){ return realBase(); };
  window.__PSL = PSL;
})();
