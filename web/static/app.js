// WehdatHub web app client: CSRF header for htmx, offline banner, service worker (scope /app/).
(function () {
  "use strict";
  var meta = document.querySelector('meta[name="csrf-token"]');
  document.addEventListener("htmx:configRequest", function (e) {
    if (meta) e.detail.headers["X-CSRF-Token"] = meta.content;
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
