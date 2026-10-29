// WehdatHub web app client: CSRF header for htmx, offline banner, service worker (scope /app/).
(function () {
  "use strict";
  var meta = document.querySelector('meta[name="csrf-token"]');
  document.addEventListener("htmx:configRequest", function (e) {
    if (meta) e.detail.headers["X-CSRF-Token"] = meta.content;
  });
  // A page left open: when it comes back into view, take the session's current token (a sign-in elsewhere in this
  // browser replaces it) or go to sign-in and back here once the session has ended.
  var lastCheck = Date.now();
  function refreshToken() {
    if (!meta || document.visibilityState === "hidden" || Date.now() - lastCheck < 60000) return;
    lastCheck = Date.now();
    fetch("/app/csrf", { credentials: "same-origin", headers: { Accept: "application/json" }, redirect: "manual" })
      .then(function (r) {
        if (r.status === 200) return r.json();
        if (r.type === "opaqueredirect" || r.status === 401 || r.status === 303) location.href = "/app/login?next=" + encodeURIComponent(location.pathname + location.search);
        return null;
      })
      .then(function (d) {
        if (!d || !d.csrf || d.csrf === meta.content) return;
        meta.content = d.csrf;
        var inputs = document.querySelectorAll('input[name="_csrf"]');
        for (var i = 0; i < inputs.length; i++) inputs[i].value = d.csrf;
        var boxes = document.querySelectorAll("[data-csrf]");
        for (var j = 0; j < boxes.length; j++) boxes[j].setAttribute("data-csrf", d.csrf);
      })
      .catch(function () {});
  }
  document.addEventListener("visibilitychange", refreshToken);
  window.addEventListener("focus", refreshToken);
  // [data-copy="#id"]: copies that field's value (intake and invite links).
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-copy]") : null;
    if (!btn) return;
    var field = document.querySelector(btn.getAttribute("data-copy"));
    if (!field) return;
    var text = field.value || field.textContent || "";
    var done = function () { var t = btn.textContent; btn.textContent = "✅"; setTimeout(function () { btn.textContent = t; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () { field.select && field.select(); });
    else if (field.select) { field.select(); try { document.execCommand("copy"); done(); } catch (err) {} }
  });
  // <form data-confirm="…">: ask before a step that can't be undone from the page (deactivating a broker).
  document.addEventListener("submit", function (e) {
    var by = e.submitter && e.submitter.getAttribute && e.submitter.getAttribute("data-confirm");
    var msg = by || (e.target && e.target.getAttribute && e.target.getAttribute("data-confirm"));
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
  // Script errors from our own files go to the server (lib/errorReports.js), at most 5 per page.
  var sentErrors = 0;
  function reportError(message, file, line, stack) {
    if (!meta || sentErrors >= 5) return;
    if (file && file.indexOf(location.origin + "/app/") !== 0) return; // extensions, other sites
    sentErrors++;
    try {
      fetch("/app/client-error", {
        method: "POST",
        credentials: "same-origin",
        keepalive: true,
        headers: { "Content-Type": "application/json", "X-CSRF-Token": meta.content },
        body: JSON.stringify({ message: String(message || "").slice(0, 500), file: file || "", line: line || 0, stack: stack ? String(stack).slice(0, 2000) : "", page: location.pathname })
      }).catch(function () {});
    } catch (e) {}
  }
  window.addEventListener("error", function (e) {
    if (e.filename) reportError(e.message, e.filename, e.lineno, e.error && e.error.stack);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason || {};
    var stack = r.stack || "";
    if (stack.indexOf(location.origin + "/app/") === -1) return;
    reportError(r.message || String(r), location.origin + "/app/static/app.js", 0, stack);
  });
  function online() {
    document.body.classList.toggle("is-offline", !navigator.onLine);
  }
  window.addEventListener("online", online);
  window.addEventListener("offline", online);
  document.addEventListener("DOMContentLoaded", online);
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(function () {});
    });
  }

  // Web push (settings page): subscribe this browser and send the endpoint as form fields.
  function b64ToBytes(b64) {
    var s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function bytesToB64(buf) {
    var s = "";
    var b = new Uint8Array(buf);
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function post(path, fields) {
    var body = new URLSearchParams(fields);
    return fetch(path, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": meta ? meta.content : "" }, body: body });
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-push]") : null;
    if (!btn) return;
    var box = document.getElementById("push");
    var status = box && box.querySelector("[data-push-status]");
    var say = function (t) { if (status) status.textContent = t; };
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return say("This browser can't receive notifications (on iPhone: add the site to the home screen first).");
    navigator.serviceWorker.ready.then(function (reg) {
      if (btn.getAttribute("data-push") === "disable") {
        return reg.pushManager.getSubscription().then(function (sub) {
          if (!sub) return say("Off.");
          return post("/app/push/unsubscribe", { endpoint: sub.endpoint }).then(function () { return sub.unsubscribe(); }).then(function () { say("Off."); });
        });
      }
      return Notification.requestPermission().then(function (perm) {
        if (perm !== "granted") return say("Notifications are blocked in this browser's settings.");
        return reg.pushManager
          .subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(box.getAttribute("data-vapid")) })
          .then(function (sub) {
            return post("/app/push/subscribe", { endpoint: sub.endpoint, p256dh: bytesToB64(sub.getKey("p256dh")), auth: bytesToB64(sub.getKey("auth")) });
          })
          .then(function (r) { say(r && r.ok ? "✅ On." : "Could not turn on."); });
      });
    }).catch(function () { say("Could not turn on."); });
  });
  // Passkeys (R6): add one in Settings (#passkeys), sign in with one on the sign-in page (#passkey-login).
  // Registration sends getPublicKey() (SPKI) and getAuthenticatorData(), so the server parses no CBOR.
  var hasPasskeys = !!(window.PublicKeyCredential && navigator.credentials);
  function pkSay(box, t) { var p = box && box.querySelector("[data-passkey-status]"); if (p) p.textContent = t; }
  document.addEventListener("DOMContentLoaded", function () {
    var box = document.getElementById("passkey-login");
    if (box && hasPasskeys) box.hidden = false;
  });
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-passkey-register]") : null;
    if (!btn) return;
    var box = document.getElementById("passkeys");
    if (!hasPasskeys) return pkSay(box, "This browser can't use passkeys.");
    btn.disabled = true;
    post("/app/passkey/register/options", {})
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("options")); })
      .then(function (o) {
        o.challenge = b64ToBytes(o.challenge);
        o.user.id = b64ToBytes(o.user.id);
        o.excludeCredentials = (o.excludeCredentials || []).map(function (c) { return { type: c.type, id: b64ToBytes(c.id) }; });
        return navigator.credentials.create({ publicKey: o });
      })
      .then(function (cred) {
        var res = cred.response;
        if (!res.getPublicKey || !res.getAuthenticatorData) throw new Error("unsupported");
        return post("/app/passkey/register", {
          credentialId: bytesToB64(cred.rawId),
          clientDataJSON: bytesToB64(res.clientDataJSON),
          authenticatorData: bytesToB64(res.getAuthenticatorData()),
          publicKey: bytesToB64(res.getPublicKey()),
          alg: String(res.getPublicKeyAlgorithm())
        });
      })
      .then(function (r) { if (r.ok) location.reload(); else pkSay(box, "Could not add the passkey."); })
      .catch(function (err) { pkSay(box, err && err.message === "unsupported" ? "This browser can't add passkeys here; try Chrome or Safari." : "Cancelled or not possible on this device."); })
      .then(function () { btn.disabled = false; });
  });
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-passkey-login]") : null;
    if (!btn) return;
    var box = document.getElementById("passkey-login");
    var csrf = box.getAttribute("data-csrf");
    var send = function (path, fields) {
      fields._csrf = csrf;
      return fetch(path, { method: "POST", credentials: "same-origin", body: new URLSearchParams(fields) });
    };
    btn.disabled = true;
    send("/app/passkey/login/options", {})
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("options")); })
      .then(function (o) { o.challenge = b64ToBytes(o.challenge); return navigator.credentials.get({ publicKey: o }); })
      .then(function (cred) {
        var res = cred.response;
        return send("/app/passkey/login", {
          credentialId: bytesToB64(cred.rawId),
          clientDataJSON: bytesToB64(res.clientDataJSON),
          authenticatorData: bytesToB64(res.authenticatorData),
          signature: bytesToB64(res.signature),
          userHandle: res.userHandle ? bytesToB64(res.userHandle) : "",
          next: box.getAttribute("data-next") || "/app/"
        });
      })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error("refused")); })
      .then(function (j) { location.replace(j.next || "/app/"); })
      .catch(function () { pkSay(box, "Passkey sign-in didn't work. Turn passkeys on in Settings first, or use a bot link."); btn.disabled = false; });
  });
  // Unit photos to a client (/app/units/<code>/share-media): files through the share sheet, one tap to WhatsApp.
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest("[data-share-media]") : null;
    if (!btn) return;
    var box = document.getElementById("share-media");
    var status = box && box.querySelector("[data-share-status]");
    var say = function (t) { if (status) status.textContent = t; };
    var imgs = box ? box.querySelectorAll("[data-share-photo]") : [];
    btn.disabled = true;
    Promise.all(Array.prototype.map.call(imgs, function (img, i) {
      return fetch(img.getAttribute("src"), { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.blob() : null; })
        .then(function (b) { return b ? new File([b], "photo-" + (i + 1) + ".jpg", { type: b.type || "image/jpeg" }) : null; });
    })).then(function (files) {
      files = files.filter(Boolean);
      var data = { files: files, text: box.getAttribute("data-share-text") || "" };
      if (!files.length) return say("No photos could be loaded.");
      if (!navigator.canShare || !navigator.canShare({ files: files })) return say("This browser can't share photos. Long-press a photo to save it.");
      return navigator.share(data).catch(function (err) {
        if (err && err.name === "AbortError") return;
        // Some apps refuse text with files: try the photos alone.
        return navigator.share({ files: files });
      });
    }).catch(function () { say("Sharing didn't work here. Long-press a photo to save it."); })
      .then(function () { btn.disabled = false; });
  });
  // Chat export zip with photos (/app/import): ask for a signed upload URL, PUT the file straight to Storage with a
  // progress bar, then send the form with the stored path.
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.hasAttribute || !form.hasAttribute("data-zip-upload") || form.elements.path.value) return;
    e.preventDefault();
    var input = form.querySelector("[data-zip-file]");
    var bar = form.querySelector("[data-zip-progress]");
    var status = form.querySelector("[data-zip-status]");
    var button = form.querySelector("button[type=submit]");
    var file = input && input.files && input.files[0];
    var say = function (key) { status.textContent = status.getAttribute(key) || ""; status.hidden = false; };
    if (!file) return;
    if (file.size > Number(form.getAttribute("data-max"))) return say("data-msg-big");
    var fail = function () { button.disabled = false; bar.hidden = true; say("data-msg-fail"); };
    button.disabled = true;
    say("data-msg-wait");
    fetch("/app/import/zip/start", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-Token": meta ? meta.content : "" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.url) return fail();
        var xhr = new XMLHttpRequest();
        xhr.open("PUT", j.url);
        xhr.setRequestHeader("Content-Type", "application/zip");
        xhr.setRequestHeader("x-upsert", "false");
        bar.hidden = false;
        xhr.upload.onprogress = function (ev) { if (ev.lengthComputable) bar.value = Math.round((ev.loaded * 100) / ev.total); };
        xhr.onload = function () {
          if (xhr.status < 200 || xhr.status >= 300) return fail();
          form.elements.path.value = j.path;
          form.elements.filename.value = file.name;
          form.submit();
        };
        xhr.onerror = fail;
        xhr.send(file);
      })
      .catch(fail);
  });
  // A search answered from ?q= becomes its ?f= link in the history, so Back from a unit returns to the same results
  // without asking the AI again.
  document.addEventListener("DOMContentLoaded", function () {
    var el = document.querySelector("[data-search-url]");
    if (el && window.history && history.replaceState) history.replaceState(null, "", el.getAttribute("data-search-url"));
  });
  // ← Back: the previous page when it is ours, else the link's own address.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[data-back]");
    if (!a) return;
    var ours = false;
    try { ours = document.referrer && new URL(document.referrer).origin === location.origin; } catch (err) { ours = false; }
    if (ours && history.length > 1) {
      e.preventDefault();
      history.back();
    }
  });
  // <ol data-sortable>: reorder items by dragging or with their [data-move="up|down"] buttons; each item's hidden
  // input carries its id, so the form posts the new order (lead routing, project photo order).
  var dragged = null;
  document.addEventListener("dragstart", function (e) {
    var li = e.target.closest && e.target.closest("[data-sortable] > li");
    if (!li) return;
    dragged = li;
    e.dataTransfer.effectAllowed = "move";
  });
  document.addEventListener("dragover", function (e) {
    var li = e.target.closest && e.target.closest("[data-sortable] > li");
    if (!dragged || !li || li === dragged || li.parentNode !== dragged.parentNode) return;
    e.preventDefault();
    var r = li.getBoundingClientRect();
    li.parentNode.insertBefore(dragged, e.clientY > r.top + r.height / 2 ? li.nextSibling : li);
  });
  document.addEventListener("dragend", function () {
    if (dragged && dragged.parentNode) dragged.parentNode.dispatchEvent(new CustomEvent("sorted", { bubbles: true }));
    dragged = null;
  });
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("[data-sortable] [data-move]");
    if (!b) return;
    e.preventDefault();
    var li = b.closest("li");
    if (b.getAttribute("data-move") === "up" && li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
    if (b.getAttribute("data-move") === "down" && li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
    li.parentNode.dispatchEvent(new CustomEvent("sorted", { bubbles: true }));
  });
  // Add/edit a unit: chosen photos show as a list the broker can drag (or move with arrows) before saving; the file
  // input is rebuilt in that order, so the unit's photos are stored in the order shown (the first is the cover).
  document.addEventListener("change", function (e) {
    var input = e.target;
    if (input.matches && input.matches("select[name=market]")) {
      var tab = document.getElementById(input.value === "primary" ? "pay-tab-primary" : "pay-tab-resale");
      if (tab) tab.checked = true;
    }
    if (!input.matches || !input.matches("input[data-photo-sort]") || !window.DataTransfer) return;
    var form = input.form;
    var list = form && form.querySelector("[data-photo-preview]");
    if (!list) return;
    input._files = Array.prototype.slice.call(input.files);
    var render = function () {
      list.innerHTML = "";
      input._files.forEach(function (f, i) {
        var li = document.createElement("li");
        li.draggable = true;
        li.setAttribute("data-file", String(i));
        var img = document.createElement("img");
        img.alt = "";
        img.src = URL.createObjectURL(f);
        var name = document.createElement("span");
        name.className = "grow";
        name.textContent = (i + 1) + ". " + f.name;
        var up = document.createElement("button");
        up.type = "button"; up.className = "secondary"; up.setAttribute("data-move", "up"); up.textContent = "\u2191";
        var down = document.createElement("button");
        down.type = "button"; down.className = "secondary"; down.setAttribute("data-move", "down"); down.textContent = "\u2193";
        li.appendChild(img); li.appendChild(name); li.appendChild(up); li.appendChild(down);
        list.appendChild(li);
      });
      list.hidden = !input._files.length;
      var hint = form.querySelector("[data-photo-preview-hint]");
      if (hint) hint.hidden = input._files.length < 2;
    };
    list.onsorted = null;
    if (!list._wired) {
      list._wired = true;
      list.addEventListener("sorted", function () {
        var order = Array.prototype.map.call(list.children, function (li) { return Number(li.getAttribute("data-file")); });
        input._files = order.map(function (i) { return input._files[i]; });
        var dt = new DataTransfer();
        input._files.forEach(function (f) { dt.items.add(f); });
        input.files = dt.files;
        var manual = form.querySelector("[data-photo-manual]");
        if (manual) manual.checked = true;
        render();
      });
    }
    render();
  });
  // Mini App sign-in (/app/tg): Telegram puts its signed initData in the URL fragment as tgWebAppData.
  (function () {
    var box = document.getElementById("tg-signin");
    if (!box) return;
    var fail = function () { var p = box.querySelector("[data-tg-status]"); if (p) p.hidden = false; };
    var data = new URLSearchParams(location.hash.slice(1)).get("tgWebAppData");
    if (!data) return fail();
    var framed = "0";
    try { framed = window.top !== window.self ? "1" : "0"; } catch (e) { framed = "1"; }
    fetch("/app/tg/session", {
      method: "POST",
      credentials: "same-origin",
      body: new URLSearchParams({ initData: data, framed: framed, next: box.getAttribute("data-next") || "/app/" })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.next) location.replace(j.next); else fail(); })
      .catch(fail);
  })();

  // Theme: the Mini App follows Telegram's light or dark theme (its colours come in the URL fragment when Telegram
  // opens the page, kept for the session); elsewhere the phone's setting applies through CSS.
  (function () {
    var params = null;
    try {
      var m = /tgWebAppThemeParams=([^&]+)/.exec(location.hash);
      if (m) sessionStorage.setItem("tgTheme", decodeURIComponent(m[1]));
      params = JSON.parse(sessionStorage.getItem("tgTheme") || "null");
    } catch (err) { params = null; }
    var bg = params && params.bg_color;
    if (!bg || !/^#[0-9a-f]{6}$/i.test(bg)) return;
    var n = parseInt(bg.slice(1), 16);
    var lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    document.documentElement.setAttribute("data-theme", lum < 0.5 ? "dark" : "light");
  })();
  // Telegram Mini App bridge (no SDK: the CSP allows only our own scripts). Telegram's Back button goes back a page,
  // its Main button presses the page's main action ([data-tg-main], the first one not hidden), and the safe area
  // Telegram reports pads the page. Outside Telegram nothing here runs.
  (function () {
    var inTg = false;
    try {
      if (/tgWebAppData=|tgWebAppPlatform=/.test(location.hash)) sessionStorage.setItem("tgApp", "1");
      inTg = sessionStorage.getItem("tgApp") === "1";
    } catch (err) { inTg = /tgWebAppPlatform=/.test(location.hash); }
    if (!inTg) return;
    var root = document.documentElement;
    root.classList.add("tg-app");
    function post(type, data) {
      var body = JSON.stringify(data || {});
      try {
        if (window.TelegramWebviewProxy && window.TelegramWebviewProxy.postEvent) window.TelegramWebviewProxy.postEvent(type, body);
        else if (window.external && "notify" in window.external) window.external.notify(JSON.stringify({ eventType: type, eventData: data || {} }));
        else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data || {} }), "https://web.telegram.org");
      } catch (err) { /* not inside Telegram after all */ }
    }
    var handlers = {};
    function receive(type, data) { if (handlers[type]) handlers[type](data || {}); }
    window.Telegram = window.Telegram || {};
    window.Telegram.WebView = window.Telegram.WebView || {};
    window.Telegram.WebView.receiveEvent = receive;
    window.addEventListener("message", function (e) {
      if (e.origin !== "https://web.telegram.org") return;
      try { var m = typeof e.data === "string" ? JSON.parse(e.data) : e.data; if (m && m.eventType) receive(m.eventType, m.eventData); } catch (err) { /* not ours */ }
    });
    var home = location.pathname === "/app/" || location.pathname === "/app";
    post("web_app_setup_back_button", { is_visible: !home });
    handlers.back_button_pressed = function () { if (history.length > 1) history.back(); else location.href = "/app/"; };
    function shown(el) { return el && !el.disabled && !el.closest("[hidden]"); }
    function mainTarget() {
      var all = document.querySelectorAll("[data-tg-main]");
      for (var i = 0; i < all.length; i++) if (shown(all[i])) return all[i];
      return null;
    }
    function refreshMain() {
      var el = mainTarget();
      var css = getComputedStyle(root);
      if (!el) { post("web_app_setup_main_button", { is_visible: false }); root.classList.remove("tg-main-on"); return; }
      post("web_app_setup_main_button", { is_visible: true, is_active: true, text: (el.textContent || "").trim().slice(0, 64), color: css.getPropertyValue("--brand").trim() || "#2b7bd6", text_color: "#ffffff" });
      root.classList.add("tg-main-on");
    }
    handlers.main_button_pressed = function () { var el = mainTarget(); if (el) el.click(); };
    function pad(name, d) { ["top", "bottom", "left", "right"].forEach(function (k) { if (typeof d[k] === "number") root.style.setProperty("--tg-" + name + "-" + k, d[k] + "px"); }); }
    handlers.safe_area_changed = function (d) { pad("safe", d); };
    handlers.content_safe_area_changed = function (d) { pad("content", d); };
    post("web_app_request_safe_area");
    post("web_app_request_content_safe_area");
    post("web_app_ready");
    post("web_app_expand");
    refreshMain();
    document.addEventListener("steps:change", refreshMain);
    document.addEventListener("htmx:load", refreshMain);
  })();
  var EN = document.documentElement.lang === "en";
  // One message style (a toast above the bottom bar) for short results and for errors.
  var toastTimer = null;
  function toast(text, bad) {
    var box = document.querySelector("[data-toast-box]");
    if (!box || !text) return;
    box.textContent = text;
    box.className = "toast" + (bad ? " bad" : "");
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { box.hidden = true; }, bad ? 6000 : 4000);
  }
  window.whToast = toast;
  document.addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("[data-toast-box]")) e.target.closest("[data-toast-box]").hidden = true;
  });
  // A short success line after a save (no links or fields in it) shows as the toast instead of at the page top.
  document.addEventListener("DOMContentLoaded", function () {
    var main = document.getElementById("main");
    var n = main && main.querySelector(".notice.ok");
    if (!n || n.querySelector("a, input, button, form") || n.textContent.trim().length > 90) return;
    toast(n.textContent.replace(/\s+/g, " ").trim(), false);
    n.hidden = true;
  });
  // htmx buttons (Fill from description, Review, duplicate check): say so when the server can't be reached.
  document.addEventListener("htmx:responseError", function (e) {
    var code = e.detail && e.detail.xhr ? e.detail.xhr.status : 0;
    toast(EN ? "Something went wrong (" + code + "). Try again." : "حصلت مشكلة (" + code + "). جرب تاني.", true);
  });
  function unreachable() {
    toast(EN ? "Couldn't reach the server. Check the connection and try again." : "مقدرناش نوصل للسيرفر. اتأكد من النت وجرب تاني.", true);
  }
  document.addEventListener("htmx:sendError", unreachable);
  document.addEventListener("htmx:timeout", unreachable);
  // Every POST form locks its buttons after the first tap, so a slow server doesn't save the same thing twice.
  // Disabled a moment later, so the tapped button's own name and value are still sent.
  function unlock() {
    var busy = document.querySelectorAll("button.busy, button[data-locked]");
    for (var i = 0; i < busy.length; i++) { busy[i].disabled = false; busy[i].classList.remove("busy"); busy[i].removeAttribute("data-locked"); }
  }
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (e.defaultPrevented || !form || (form.getAttribute("method") || "").toLowerCase() !== "post") return;
    if (form.hasAttribute("data-no-lock") || form.getAttribute("target")) return;
    var tapped = e.submitter;
    setTimeout(function () {
      var buttons = form.querySelectorAll("button[type=submit], button:not([type])");
      for (var i = 0; i < buttons.length; i++) { buttons[i].disabled = true; buttons[i].setAttribute("data-locked", ""); }
      if (tapped && tapped.classList) tapped.classList.add("busy");
    }, 0);
    setTimeout(unlock, 15000);
  });
  window.addEventListener("pageshow", unlock);
  // <select data-autosubmit>: changing it applies the filter at once (no inline handlers under the CSP).
  document.addEventListener("change", function (e) {
    var t = e.target;
    if (t && t.hasAttribute && t.hasAttribute("data-autosubmit") && t.form) t.form.submit();
  });
  // Tabs made of radios: a link to something inside a hidden tab (#merge, #timeline) opens that tab first.
  function openTabFor(hash) {
    var el = hash && hash.length > 1 && document.getElementById(decodeURIComponent(hash.slice(1)));
    var panel = el && el.closest && el.closest(".tab-panel[data-tab]");
    var radio = panel && document.getElementById(panel.getAttribute("data-tab"));
    if (radio && !radio.checked) { radio.checked = true; el.scrollIntoView(); }
  }
  openTabFor(location.hash);
  window.addEventListener("hashchange", function () { openTabFor(location.hash); });
  // "Use where I am now" on the agency-only location box: fills the pin field with this phone's position.
  var here = document.querySelectorAll("[data-my-location]");
  for (var g = 0; g < here.length; g++) {
    if (!navigator.geolocation) continue;
    here[g].hidden = false;
    here[g].addEventListener("click", function () {
      var btn = this;
      var form = btn.form || btn.closest("form");
      var field = form && form.querySelector("input[name=pin], input[name=place]");
      btn.classList.add("busy");
      navigator.geolocation.getCurrentPosition(function (p) {
        btn.classList.remove("busy");
        var ll = p.coords.latitude.toFixed(6) + "," + p.coords.longitude.toFixed(6);
        if (field) field.value = field.name === "place" ? "https://maps.google.com/?q=" + ll : ll;
      }, function () {
        btn.classList.remove("busy");
        toast(btn.getAttribute("data-fail") || "", true);
      }, { enableHighAccuracy: true, timeout: 15000 });
    });
  }
  // Lead board: drag a card onto another column to move it (the card's own Move form does the save).
  var board = document.querySelector("[data-board]");
  if (board) {
    var dragged = null;
    board.addEventListener("dragstart", function (e) {
      dragged = e.target.closest && e.target.closest(".bcard");
      if (dragged && e.dataTransfer) e.dataTransfer.setData("text/plain", dragged.getAttribute("data-lead"));
    });
    board.addEventListener("dragover", function (e) { if (dragged && e.target.closest(".bcol")) e.preventDefault(); });
    board.addEventListener("drop", function (e) {
      var col = e.target.closest(".bcol");
      if (!dragged || !col) return;
      e.preventDefault();
      var form = dragged.querySelector("form.bmove");
      var select = form && form.querySelector("select[name=stage]");
      var stage = col.getAttribute("data-stage");
      if (!select || select.value === stage) return;
      if (!select.querySelector('option[value="' + stage + '"]')) { toast(EN ? "Mark Lost from the lead page." : "«ضاع» من صفحة العميل.", true); return; }
      select.value = stage;
      form.requestSubmit ? form.requestSubmit() : form.submit();
    });
  }
  // Stepped forms (<form data-steps="A|B|C">): one step at a time with a progress bar, Back and Next. Next checks only
  // the fields of the step on screen. Without this script every step simply shows.
  function stepForm(form) {
    if (!form || form.hasAttribute("data-stepped")) return;
    var names = form.getAttribute("data-steps").split("|");
    var parts = form.querySelectorAll("[data-step]");
    if (!parts.length) return;
    form.setAttribute("data-stepped", "");
    var bar = document.createElement("div");
    bar.className = "stepbar";
    var nav = document.createElement("div");
    nav.className = "row stepnav";
    var prev = document.createElement("button");
    prev.type = "button"; prev.className = "secondary"; prev.textContent = form.getAttribute("data-prev") || "Back";
    var next = document.createElement("button");
    next.type = "button"; next.textContent = form.getAttribute("data-next") || "Next";
    next.setAttribute("data-tg-main", "");
    nav.appendChild(prev); nav.appendChild(next);
    form.insertBefore(bar, form.firstChild.nextSibling);
    form.appendChild(nav);
    var at = 1;
    function show(n) {
      at = Math.max(1, Math.min(names.length, n));
      for (var i = 0; i < parts.length; i++) parts[i].hidden = String(at) !== parts[i].getAttribute("data-step");
      bar.innerHTML = "";
      for (var k = 0; k < names.length; k++) {
        var dot = document.createElement("span");
        dot.className = "stepdot" + (k + 1 < at ? " done" : k + 1 === at ? " on" : "");
        dot.textContent = (k + 1) + ". " + names[k];
        bar.appendChild(dot);
      }
      prev.hidden = at === 1;
      next.hidden = at === names.length;
      window.scrollTo(0, 0);
      document.dispatchEvent(new CustomEvent("steps:change"));
    }
    next.addEventListener("click", function () {
      var fields = form.querySelectorAll('[data-step="' + at + '"] input, [data-step="' + at + '"] select, [data-step="' + at + '"] textarea');
      for (var i = 0; i < fields.length; i++) if (fields[i].willValidate && !fields[i].checkValidity()) { fields[i].reportValidity(); return; }
      show(at + 1);
    });
    prev.addEventListener("click", function () { show(at - 1); });
    // A required field left empty on an earlier step: jump back to it instead of a silent failed submit.
    form.addEventListener("invalid", function (e) {
      var part = e.target.closest && e.target.closest("[data-step]");
      if (part && part.hidden) { show(Number(part.getAttribute("data-step"))); setTimeout(function () { e.target.reportValidity(); }, 0); }
    }, true);
    show(1);
  }
  function initSteps(root) {
    var forms = (root || document).querySelectorAll("form[data-steps]");
    for (var i = 0; i < forms.length; i++) stepForm(forms[i]);
    if (root && root.matches && root.matches("form[data-steps]")) stepForm(root);
  }
  initSteps(document);
  document.addEventListener("htmx:load", function (e) { initSteps(e.target); });
  // Folded settings ([data-fold]): each card's first heading opens and closes it. All start closed except the first,
  // the one a #hash points into, and any holding a notice or an error.
  function initFold(box) {
    var cards = box.querySelectorAll(":scope > .card");
    var target = location.hash && document.getElementById(location.hash.slice(1));
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var head = card.querySelector("h2");
      if (!head || head.parentNode !== card) continue;
      head.classList.add("foldhead");
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      var open = i === 0 || (target && card.contains(target)) || card.querySelector(".notice, [aria-invalid=true]");
      card.classList.toggle("folded", !open);
      head.setAttribute("aria-expanded", open ? "true" : "false");
    }
  }
  function toggleFold(head) {
    var card = head.parentNode;
    var closed = card.classList.toggle("folded");
    head.setAttribute("aria-expanded", closed ? "false" : "true");
  }
  var folds = document.querySelectorAll("[data-fold]");
  for (var f = 0; f < folds.length; f++) initFold(folds[f]);
  document.addEventListener("click", function (e) {
    var head = e.target.closest && e.target.closest("[data-fold] .foldhead");
    if (head) toggleFold(head);
  });
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("foldhead")) { e.preventDefault(); toggleFold(e.target); }
  });
  // Voice search: the mic in a search box dictates into it and searches. Shown only where the browser can listen.
  // Tap once to start (mic turns red with a stop square), tap again to stop. The browser also ends a listen after a
  // pause; either way the text heard is searched once the browser has finished (onend), and the mic shows a spinner
  // only while that last result is being delivered.
  var Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  var VOICE_ERRORS = {
    "not-allowed": [ "Allow the microphone for this site, then try again.", "اسمح للمايك للموقع ده، وجرب تاني." ],
    "service-not-allowed": [ "Allow the microphone for this site, then try again.", "اسمح للمايك للموقع ده، وجرب تاني." ],
    "audio-capture": [ "No microphone found. Connect one or type.", "مفيش مايك متوصل. وصّل مايك أو اكتب." ],
    "network": [ "Speech service is unreachable. Type your search instead.", "خدمة الصوت مش متاحة دلوقتي. اكتب بحثك." ],
    "no-speech": [ "Couldn't hear you. Try again or type.", "مسمعناش كويس. جرب تاني أو اكتب." ]
  };
  function setMic(btn, state) {
    btn.classList.toggle("recording", state === "recording");
    btn.classList.toggle("busy", state === "busy");
    btn.setAttribute("aria-pressed", state === "recording" ? "true" : "false");
  }
  function listen(btn) {
    if (btn._rec) {
      setMic(btn, "busy");
      btn._rec.stop();
      return;
    }
    var form = btn.form || btn.closest("form");
    var input = form && form.querySelector("input[name=q]");
    if (!input) return;
    var rec = new Speech();
    var heard = "";
    var failed = false;
    rec.lang = EN ? "en-US" : "ar-EG";
    rec.interimResults = true;
    rec.continuous = false;
    btn._rec = rec;
    rec.onresult = function (ev) {
      var text = "";
      for (var i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      heard = text.trim();
      input.value = text;
    };
    rec.onerror = function (ev) {
      failed = true;
      var msg = VOICE_ERRORS[ev.error];
      if (msg) toast(EN ? msg[0] : msg[1], true);
    };
    rec.onend = function () {
      btn._rec = null;
      setMic(btn, "idle");
      if (failed) return;
      if (heard) form.submit();
      else toast(EN ? VOICE_ERRORS["no-speech"][0] : VOICE_ERRORS["no-speech"][1], true);
    };
    try {
      rec.start();
      setMic(btn, "recording");
    } catch (_) {
      btn._rec = null;
      toast(EN ? VOICE_ERRORS["no-speech"][0] : VOICE_ERRORS["no-speech"][1], true);
    }
  }
  if (Speech) {
    var mics = document.querySelectorAll("[data-mic]");
    for (var m = 0; m < mics.length; m++) {
      mics[m].hidden = false;
      mics[m].addEventListener("click", function () { listen(this); });
    }
    var auto = document.querySelector("[data-voice-start]");
    if (auto && mics[0]) listen(mics[0]);
  } else {
    var start = document.querySelector("[data-voice-start]");
    if (start) start.focus();
  }
})();
