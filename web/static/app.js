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
