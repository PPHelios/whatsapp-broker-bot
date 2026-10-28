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
    var msg = e.target && e.target.getAttribute && e.target.getAttribute("data-confirm");
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
})();
