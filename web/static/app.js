// WehdatHub web app client: CSRF header for htmx, offline banner, service worker (scope /app/).
(function () {
  "use strict";
  // Features the agency owner switched off (body[data-ai-off]): their buttons are grayed out with a hint below.
  function grayOutAi(root) {
    var off = (document.body.getAttribute("data-ai-off") || "").split(",");
    if (!off[0]) return;
    var hint = document.body.getAttribute("data-ai-off-hint") || "";
    (root || document).querySelectorAll("[data-ai]").forEach(function (el) {
      if (off.indexOf(el.getAttribute("data-ai")) < 0 || el.hasAttribute("data-ai-off")) return;
      el.setAttribute("data-ai-off", "");
      el.setAttribute("aria-disabled", "true");
      if (el.tagName === "BUTTON") el.disabled = true;
      if (el.tagName === "A") el.removeAttribute("href");
      el.classList.add("ai-off");
      var note = document.createElement("small");
      note.className = "muted ai-off-hint";
      note.textContent = hint;
      el.insertAdjacentElement("afterend", note);
    });
  }
  document.addEventListener("DOMContentLoaded", function () { grayOutAi(document); });
  document.addEventListener("htmx:afterSwap", function (e) { grayOutAi(e.target || document); });
  var meta = document.querySelector('meta[name="csrf-token"]');
  // One-time request IDs: each action carries an ID, so the server runs a repeat of it (double tap, retry) only once.
  function newRid() {
    var a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    var s = "";
    for (var i = 0; i < a.length; i++) s += ("0" + a[i].toString(16)).slice(-2);
    return s;
  }
  document.addEventListener("htmx:configRequest", function (e) {
    if (meta) e.detail.headers["X-CSRF-Token"] = meta.content;
    var m = (e.detail.verb || "").toLowerCase();
    if (m && m !== "get" && e.detail.elt) {
      if (!e.detail.elt.__rid) e.detail.elt.__rid = newRid();
      e.detail.headers["X-Request-Id"] = e.detail.elt.__rid;
    }
  });
  // A finished request frees its ID, so the next real action on the same button is a new one.
  document.addEventListener("htmx:afterRequest", function (e) { if (e.detail && e.detail.elt) e.detail.elt.__rid = null; });
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!form || !form.getAttribute || (form.getAttribute("method") || "").toLowerCase() !== "post" || form.hasAttribute("hx-post")) return;
    var f = form.querySelector("input[name=_rid]");
    if (!f) { f = document.createElement("input"); f.type = "hidden"; f.name = "_rid"; form.appendChild(f); }
    if (!f.value) f.value = newRid();
  }, true);
  window.addEventListener("pageshow", function () {
    var all = document.querySelectorAll("input[name=_rid]");
    for (var i = 0; i < all.length; i++) all[i].value = "";
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
  // Document reading: the exact credit cost (pages picked, pages already read are free) before the button is pressed.
  (function () {
    var form = document.querySelector("form[data-ai-read]");
    if (!form || !window.fetch || !window.FormData) return;
    var note = form.querySelector("[data-ai-estimate]");
    var cost = form.querySelector("[data-estimate-cost]");
    var timer = null;
    var run = function () {
      var files = form.querySelector('input[type="file"]');
      if (!files || !files.files.length) return;
      var url = (form.getAttribute("action") || location.href).replace(/\/read$/, "/estimate");
      fetch(url, { method: "POST", body: new FormData(form), credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (note && d.text) note.textContent = d.text;
          if (cost) cost.textContent = d.ok ? "(" + d.credits + ")" : "";
          // A large read asks for a yes with the page count and cost.
          var flag = form.querySelector("[data-confirmed]");
          if (d.ok && d.confirm) { form.setAttribute("data-confirm", d.text); if (flag) flag.value = "1"; }
          else { form.removeAttribute("data-confirm"); if (flag) flag.value = "0"; }
        })
        .catch(function () {});
    };
    form.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(run, 400); });
    form.addEventListener("change", function () { clearTimeout(timer); timer = setTimeout(run, 400); });
  })();
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
    btn.classList.add("busy");
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
      .catch(function () { pkSay(box, "Passkey sign-in didn't work. Turn passkeys on in Settings first, or use a bot link."); btn.disabled = false; btn.classList.remove("busy"); });
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
      // Some apps (WhatsApp on Android) drop the text sent with photos, so the description is copied first: paste it after the photos.
      try { if (navigator.clipboard && data.text) navigator.clipboard.writeText(data.text).then(function () { say(document.documentElement.lang === "en" ? "Description copied: paste it under the photos if it is missing." : "الوصف اتنسخ: الصقه تحت الصور لو مش ظاهر."); }, function () {}); } catch (e) { /* the text is also on the page */ }
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
  // A search answered from ?q= becomes its ?f= link in the history, so Back from a unit returns to the same results
  // without asking the AI again.
  document.addEventListener("DOMContentLoaded", function () {
    var el = document.querySelector("[data-search-url]");
    if (el && window.history && history.replaceState) history.replaceState(null, "", el.getAttribute("data-search-url"));
  });
  // Slow pages (data-lazy="address"): the page opens at once with a spinner, then the content is fetched and put in its place.
  (function () {
    var T = document.documentElement.lang === "ar"
      ? { fail: "ما اتحملش. جرب تاني.", retry: "حاول تاني" }
      : { fail: "It did not load.", retry: "Try again" };
    function fill(el) {
      var url = el.getAttribute("data-lazy");
      if (!url || !window.fetch) return;
      fetch(url, { credentials: "same-origin", headers: { Accept: "text/html" } })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
        .then(function (t) {
          el.removeAttribute("data-lazy");
          el.removeAttribute("role");
          el.className = "lazy-done";
          el.innerHTML = t;
          document.dispatchEvent(new CustomEvent("lazy:loaded", { detail: el }));
        })
        .catch(function () {
          el.textContent = "";
          var p = document.createElement("p");
          p.className = "warn";
          p.textContent = T.fail + " ";
          var b = document.createElement("button");
          b.type = "button";
          b.textContent = T.retry;
          b.addEventListener("click", function () { window.location.reload(); });
          p.appendChild(b);
          el.appendChild(p);
        });
    }
    var pending = document.querySelectorAll("[data-lazy]");
    for (var i = 0; i < pending.length; i++) fill(pending[i]);
  })();
  // Search: pressing Enter or Search shows a spinner at once (the AI reading can take a moment), until the page answers.
  document.addEventListener("submit", function (e) {
    var f = e.target && e.target.closest && e.target.closest("[data-search-form]");
    if (!f) return;
    f.classList.add("is-busy");
    // The search button is locked while the answer is on its way (the page replaces itself when it arrives).
    var sb = e.submitter;
    // Locked a moment later, so the button's own name and value still go with the form.
    if (sb) setTimeout(function () { sb.disabled = true; sb.classList.add("busy"); }, 0);
  });
  // Existing photos on the edit form: the delete button marks one removed (greyed, with Undo); the hidden tick carries it to the server.
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-remove-photo]") : null;
    if (!btn) return;
    var li = btn.closest("li");
    var box = li && li.querySelector("input[name=remove_photo]");
    if (!box) return;
    box.checked = !box.checked;
    li.classList.toggle("removed", box.checked);
    btn.textContent = box.checked ? (EN ? "↩ Undo" : "↩ تراجع") : (EN ? "🗑 Delete" : "🗑 احذف");
  });
  // A unit card's small photo: if the small copy is not there yet (older photos), show the full photo instead, once.
  document.addEventListener("error", function (e) {
    var img = e.target;
    if (!img || img.tagName !== "IMG" || !img.classList.contains("uc-thumb")) return;
    var full = img.getAttribute("data-full");
    if (full && img.src !== full) img.src = full;
  }, true);
  // Photos from the server: a spinner until each one loads, two quiet retries, then "tap to retry". Never blocks the page.
  function watchImages(root) {
    var imgs = (root || document).querySelectorAll("ol.photo-order img[data-wait]:not([data-watched])");
    Array.prototype.forEach.call(imgs, function (img) {
      img.setAttribute("data-watched", "");
      var base = img.getAttribute("src"), tries = 0;
      if (img.complete && img.naturalWidth) return;
      img.classList.add("img-wait");
      img.addEventListener("load", function () { img.classList.remove("img-wait", "img-bad"); });
      img.addEventListener("error", function () {
        if (tries < 2) { tries++; setTimeout(function () { img.src = base + (base.indexOf("?") < 0 ? "?" : "&") + "r=" + tries; }, 700 * tries); return; }
        img.classList.remove("img-wait"); img.classList.add("img-bad"); img.title = EN ? "Tap to retry" : "دوس لإعادة المحاولة";
      });
      img.addEventListener("click", function () { if (img.classList.contains("img-bad")) { tries = 0; img.classList.remove("img-bad"); img.classList.add("img-wait"); img.src = base + (base.indexOf("?") < 0 ? "?" : "&") + "r=" + Date.now(); } });
    });
  }
  watchImages(document);
  document.addEventListener("htmx:afterSwap", function (e) { watchImages(e.target); });

  // Uploads with a progress bar (forms with data-progress): the file goes up with XMLHttpRequest so the bar shows how much has
  // gone; then the server reads it. The answer replaces the page (a redirect is followed).
  var UP = document.documentElement.lang === "ar"
    ? { up: "بنحمل الملف…", read: "السيرفر بيقرا الملف…", fail: "التحميل ما نجحش. جرب تاني.", net: "في مشكلة في الاتصال. جرب تاني." }
    : { up: "Uploading…", read: "The server is reading the file…", fail: "The upload failed. Try again.", net: "A connection problem. Try again." };
  document.addEventListener("submit", function (ev) {
    var form = ev.target;
    if (!form || !form.matches || !form.matches("form[data-progress]") || ev.defaultPrevented) return;
    if (!window.XMLHttpRequest || !window.FormData) return;
    ev.preventDefault();
    var box = document.createElement("div");
    box.className = "upbar";
    box.setAttribute("role", "status");
    var bar = document.createElement("progress");
    bar.max = 1;
    bar.value = 0;
    var label = document.createElement("p");
    label.className = "muted small";
    label.textContent = UP.up;
    box.appendChild(bar);
    box.appendChild(label);
    form.insertBefore(box, form.firstChild);
    var controls = form.querySelectorAll("button, input[type=submit]");
    for (var i = 0; i < controls.length; i++) controls[i].disabled = true;
    setFormBusy(form, true);
    var stop = function (msg) {
      setFormBusy(form, false);
      label.textContent = msg;
      for (var k = 0; k < controls.length; k++) controls[k].disabled = false;
    };
    var xhr = new XMLHttpRequest();
    xhr.open("POST", (form.getAttribute("action") || location.href), true);
    xhr.setRequestHeader("Accept", "text/html");
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      bar.value = e.loaded / e.total;
      label.textContent = UP.up + " " + Math.round((e.loaded / e.total) * 100) + "%";
    };
    xhr.upload.onload = function () { bar.removeAttribute("value"); label.textContent = UP.read; };
    xhr.onerror = function () { stop(UP.net); };
    xhr.ontimeout = function () { stop(UP.fail); };
    xhr.onload = function () {
      if (xhr.responseURL && xhr.responseURL !== location.href) { location.assign(xhr.responseURL); return; }
      // A refusal on the unit form keeps the form as it is (the chosen photos can't be refilled by a script): only the
      // message, the review and the Save button are taken from the answer.
      if (form.id === "unit-form" && xhr.status >= 400 && xhr.status < 500 && window.DOMParser) {
        var doc = new DOMParser().parseFromString(xhr.responseText, "text/html");
        var nf = doc.getElementById("unit-form");
        if (nf) {
          if (box.parentNode) box.parentNode.removeChild(box);
          var oldBanner = form.querySelector(":scope > .notice.bad");
          if (oldBanner) oldBanner.remove();
          var newBanner = nf.querySelector(":scope > .notice.bad");
          if (newBanner) form.insertBefore(document.importNode(newBanner, true), form.firstChild.nextSibling);
          var nr = nf.querySelector("[data-auto-review]"), orv = form.querySelector("[data-auto-review]");
          if (nr && orv) orv.innerHTML = nr.innerHTML;
          var ns = nf.querySelector("[data-save-row]"), os = form.querySelector("[data-save-row]");
          if (ns && os) os.innerHTML = ns.innerHTML;
          for (var j = 0; j < controls.length; j++) controls[j].disabled = false;
          setFormBusy(form, false);
          form.dispatchEvent(new CustomEvent("stepgoto", { detail: 99 }));
          gateSave(form);
          window.scrollTo(0, 0);
          return;
        }
      }
      document.open();
      document.write(xhr.responseText);
      document.close();
    };
    xhr.send(new FormData(form));
  });
  // The stage board arrows: scroll one column left or right.
  document.addEventListener("click", function (e) {
    var step = e.target.closest && e.target.closest("[data-board-step]");
    if (!step) return;
    var wrap = step.closest(".board-wrap");
    var cols = wrap && wrap.querySelector("[data-board]");
    if (!cols) return;
    var col = cols.querySelector(".bcol");
    var delta = Number(step.getAttribute("data-board-step")) * ((col ? col.offsetWidth : 260) + 12);
    var before = cols.scrollLeft, max = cols.scrollWidth - cols.clientWidth;
    cols.scrollBy({ left: delta, behavior: "smooth" });
    // Loop: when the edge stops the step, jump to the other end (any sign of scrollLeft, RTL or LTR).
    setTimeout(function () {
      if (Math.abs(cols.scrollLeft - before) >= 2) return;
      cols.scrollTo({ left: Math.abs(before) < 4 ? (delta > 0 ? -max : max) : 0, behavior: "smooth" });
    }, 400);
  });
  // ← Back (and the open menu button): the previous page when it is ours, else the link's own address.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[data-back], a[data-menu-close]");
    if (!a) return;
    var ours = false;
    try { ours = document.referrer && new URL(document.referrer).origin === location.origin; } catch (err) { ours = false; }
    if (ours && history.length > 1) {
      // Telegram's webview often ignores history.back(): if the page did not change, follow the link's own address.
      e.preventDefault();
      var here = location.href, to = a.href;
      history.back();
      setTimeout(function () { if (location.href === here) location.href = to; }, 400);
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
  // Appearance: System (the phone's, or Telegram's) unless the user picked Light or Dark on the More page; kept on this device.
  (function () {
    var root = document.documentElement, auto = root.getAttribute("data-theme");
    function stored() { try { return localStorage.getItem("theme") || "system"; } catch (e) { return "system"; } }
    function apply(v) {
      if (v === "light" || v === "dark") root.setAttribute("data-theme", v);
      else if (auto) root.setAttribute("data-theme", auto);
      else root.removeAttribute("data-theme");
      document.querySelectorAll("[data-theme-set]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-set") === v)); });
    }
    apply(stored());
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-theme-set]");
      if (!b) return;
      var v = b.getAttribute("data-theme-set");
      try { localStorage.setItem("theme", v); } catch (err) { /* private window: the choice lasts this page only */ }
      apply(v);
    });
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
    // Telegram's native Back: go to the page's own ← Back link (same as tapping it). iPhone's history.back() can do
    // nothing inside Telegram, so it is only the fallback for a page with no such link.
    handlers.back_button_pressed = function () {
      var link = document.querySelector("a[data-back]");
      if (link && link.href && new URL(link.href).origin === location.origin && link.href !== location.href) { location.href = link.href; return; }
      if (history.length > 1) history.back(); else location.href = "/app/";
    };
    function shown(el) { return el && !el.disabled && !el.closest("[hidden]"); }
    function mainTarget() {
      var all = document.querySelectorAll("[data-tg-main]");
      for (var i = 0; i < all.length; i++) if (shown(all[i])) return all[i];
      // No marked button: a page with exactly one primary save button in a POST form gets it as the Main button.
      var subs = document.querySelectorAll("main form[method=post] button[type=submit]:not(.secondary):not(.link):not(.danger):not([data-confirm]):not([data-no-tg-main])");
      var ok = [];
      for (var j = 0; j < subs.length; j++) if (shown(subs[j])) ok.push(subs[j]);
      return ok.length === 1 ? ok[0] : null;
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
    var xhr = e.detail && e.detail.xhr;
    var code = xhr ? xhr.status : 0;
    // The server's own reason (a short plain text) is shown as it is; anything else gets the generic line with the status.
    var ct = xhr && xhr.getResponseHeader ? String(xhr.getResponseHeader("Content-Type") || "") : "";
    var why = xhr && ct.indexOf("text/plain") === 0 ? String(xhr.responseText || "").trim() : "";
    if (why && why.length <= 200) { toast(why, true); return; }
    toast(EN ? "Something went wrong (" + code + "). Try again." : "حصلت مشكلة (" + code + "). جرب تاني.", true);
  });
  function unreachable(e) {
    // Only the browser knows the server couldn't be reached, so it tells the server (logged and listed as a failure).
    reportError("htmx " + (e && e.type ? e.type : "unreachable") + " " + (e && e.detail && e.detail.pathInfo ? e.detail.pathInfo.requestPath : ""), location.origin + "/app/htmx", 0, "");
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
  window.addEventListener("pageshow", function () {
    unlock();
    var lk = document.querySelectorAll("a.btn.busy, a.btn.is-disabled");
    for (var i = 0; i < lk.length; i++) lk[i].classList.remove("busy", "is-disabled");
  });
  // Share the flyer image (the phone's share sheet) when the browser can; Download stays for the rest.
  (function () {
    var sb = document.querySelector("[data-share-image]");
    if (!sb) return;
    if (!navigator.share || !navigator.canShare) { sb.hidden = true; return; }
    sb.addEventListener("click", function () {
      fetch(sb.getAttribute("data-share-image"), { credentials: "same-origin" }).then(function (r) { return r.blob(); }).then(function (b) {
        var f = new File([b], sb.getAttribute("data-share-name") || "flyer.jpg", { type: b.type || "image/jpeg" });
        if (!navigator.canShare({ files: [f] })) return;
        return navigator.share({ files: [f] });
      }).catch(function () { /* cancelled */ });
    });
  })();
  // The notifications page with nothing unread: close the phone's tray notifications and clear the icon counter.
  if (location.pathname === "/app/notifications" && !document.querySelector(".inbox .unread")) {
    if (navigator.clearAppBadge) navigator.clearAppBadge().catch(function () {});
    if ("serviceWorker" in navigator) navigator.serviceWorker.ready.then(function (reg) { return reg.getNotifications(); }).then(function (list) { list.forEach(function (n) { n.close(); }); }).catch(function () {});
  }
  // Any submit button locks at the tap, even when the page handles its form itself (AJAX or htmx), so the spinner shows
  // until the answer. A button whose form is not valid sends nothing, so it is not locked. Unlocked after 15 s at the latest.
  document.addEventListener("click", function (e) {
    // Button-style links (Edit, Compare, Send photos) show the same spinner while the next page loads.
    var link = e.target && e.target.closest ? e.target.closest("a.btn") : null;
    if (link && link.getAttribute("href") && link.getAttribute("href").charAt(0) !== "#" && !link.hasAttribute("target") && !link.hasAttribute("data-no-lock") && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) {
      setTimeout(function () {
        link.classList.add("busy");
        // The flyer types: while one is loading the others cannot be tapped.
        var fl = link.closest("[data-flyer]");
        if (fl) Array.prototype.forEach.call(fl.querySelectorAll("a.btn"), function (a) { if (a !== link) a.classList.add("is-disabled"); });
      }, 0);
      setTimeout(unlock, 15000);
      return;
    }
    var b = e.target && e.target.closest ? e.target.closest("button[type=submit], button:not([type]), input[type=submit]") : null;
    if (!b || !b.form || b.disabled || b.hasAttribute("data-no-lock") || b.hasAttribute("data-confirm") || b.form.hasAttribute("data-no-lock")) return;
    if (b.form.getAttribute("target") || !b.form.checkValidity()) return;
    setTimeout(function () {
      if (b.disabled) return;
      b.disabled = true;
      b.setAttribute("data-locked", "");
      b.classList.add("busy");
    }, 0);
    setTimeout(unlock, 15000);
  }, true);
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
  // ---- The new-unit form: a draft kept on this phone, a warning before leaving unsaved work, live price/phone readback.
  // Only the unit's public fields are kept; owner, notes, commission, address, location and photos never are.
  var DRAFT_KEY = "wh-unit-draft";
  var DRAFT_SKIP = /^(_csrf|version|code|photos|voice|describe|force|dup_ack|photo_pending|photo_keys|action|photo_order|remove_photo|photo_manual|owner_.*|notes|commission|co_broker|unit_no|address|pin)$/;
  try { if (/[?&]saved=1/.test(location.search)) { localStorage.removeItem(DRAFT_KEY); Object.keys(localStorage).forEach(function (k) { if (k.indexOf("wh-unit-photos:") === 0) localStorage.removeItem(k); }); } } catch (e) {}
  (function () {
    var form = document.getElementById("unit-form");
    if (!form || /\/edit$/.test(form.getAttribute("action") || "")) return;
    var dirty = false, timer = null;
    function fieldsOf() { return Array.prototype.filter.call(form.elements, function (el) { return el.name && !DRAFT_SKIP.test(el.name) && el.type !== "file" && el.type !== "submit" && el.type !== "button" && el.type !== "hidden"; }); }
    function save() {
      try {
        var out = {};
        fieldsOf().forEach(function (el) {
          if (el.type === "checkbox") { if (el.checked) (out[el.name] = out[el.name] || []).push(el.value); }
          else if (el.value) out[el.name] = el.value;
        });
        if (Object.keys(out).length) localStorage.setItem(DRAFT_KEY, JSON.stringify({ at: Date.now(), v: out })); else localStorage.removeItem(DRAFT_KEY);
      } catch (e) {}
    }
    // Restore only into an empty form (a form re-shown after a refusal already has its values).
    try {
      var raw = localStorage.getItem(DRAFT_KEY);
      var d = raw ? JSON.parse(raw) : null;
      var empty = fieldsOf().every(function (el) { return el.type === "checkbox" ? !el.checked : !el.value || el.tagName === "SELECT"; });
      if (d && d.v && Date.now() - d.at < 7 * 24 * 3600 * 1000 && empty) {
        fieldsOf().forEach(function (el) {
          var val = d.v[el.name];
          if (val === undefined) return;
          if (el.type === "checkbox") el.checked = [].concat(val).indexOf(el.value) >= 0; else el.value = String(val);
        });
        var note = document.createElement("p");
        note.className = "card notice";
        note.setAttribute("data-draft-note", "");
        note.textContent = (EN ? "Your unfinished unit was restored. " : "رجّعنا الوحدة اللي ما كملتهاش. ") + (EN ? "Photos and owner details are not kept. " : "الصور وبيانات المالك مش بتتحفظ. ");
        var discard = document.createElement("button");
        discard.type = "button"; discard.className = "secondary small"; discard.textContent = EN ? "Start over" : "ابدأ من الأول";
        discard.addEventListener("click", function () { try { localStorage.removeItem(DRAFT_KEY); } catch (e) {} dirty = false; location.reload(); });
        note.appendChild(discard);
        form.insertBefore(note, form.firstChild.nextSibling);
      }
    } catch (e) {}
    form.addEventListener("input", function () { dirty = true; clearTimeout(timer); timer = setTimeout(save, 500); });
    form.addEventListener("submit", function () { dirty = false; });
    window.addEventListener("beforeunload", function (e) { if (dirty && !window.__whSaved) { e.preventDefault(); e.returnValue = ""; } });
    // Price and phone: say how the typed text is read, as you type.
    var DIG = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
    function latin(t) { return String(t).replace(/[٠-٩]/g, function (c) { return DIG[c]; }); }
    function readPrice(t) {
      var x = latin(t).replace(/,/g, "").trim();
      var m = x.match(/^(\d+(?:\.\d+)?)\s*(m|million|مليون|k|thousand|ألف|الف)?$/i);
      if (!m) return null;
      var n = parseFloat(m[1]), u = (m[2] || "").toLowerCase();
      if (u === "m" || u === "million" || u === "مليون") n *= 1e6; else if (u) n *= 1e3;
      return n >= 1000 ? n : null;
    }
    function hint(name, fn) {
      var inp = form.querySelector('[name="' + name + '"]');
      if (!inp) return;
      var s = document.createElement("small");
      s.className = "muted"; s.setAttribute("aria-live", "polite"); s.setAttribute("data-readback", name);
      inp.parentNode.appendChild(s);
      var run = function () { s.textContent = inp.value ? fn(inp.value) : ""; };
      inp.addEventListener("input", run);
      run();
    }
    // The price field shows thousands separators as it is typed (caret at the end); they are stripped again on submit.
    (function () {
      var inp = form.querySelector('[name="price_value"]');
      if (!inp) return;
      inp.addEventListener("input", function () {
        if (inp.selectionStart !== inp.value.length) return;
        // "9 مليون", "9m", "250 ألف": a number with a word is left as typed (the readback shows its value); only plain digits get commas.
        if (/[^\d.,\s٠-٩]/.test(inp.value)) return;
        var d = latin(inp.value).replace(/[^\d.]/g, "");
        if (!d) return;
        var parts = d.split(".");
        inp.value = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (parts.length > 1 ? "." + parts[1] : "");
      });
      form.addEventListener("submit", function () { inp.value = latin(inp.value).replace(/,/g, ""); }, true);
    })();
    hint("price_value", function (v) { var n = readPrice(v); return n ? "= " + n.toLocaleString("en") : (EN ? "Not read as a price yet" : "لسه مش مقروء كسعر"); });
    hint("owner_phone", function (v) { var d = latin(v).replace(/\D/g, ""); return /^(20)?0?1[0125]\d{8}$/.test(d) ? "✅" : (EN ? "⚠️ Egyptian mobile numbers have 11 digits (01…)" : "⚠️ الموبايل المصري 11 رقم (01…)"); });
  })();

  // A form that is waiting for the server can't be edited or tapped (inert), so nothing changes under the request.
  function setFormBusy(form, on) {
    if (!form) return;
    if (on) form.setAttribute("aria-busy", "true"); else form.removeAttribute("aria-busy");
    try { form.inert = on; } catch (e) {}
  }
  // The unit form's review panel: loaded by itself (last step, or on an edit page) and it decides whether Save is open.
  function runReview(form) {
    var r = form && form.querySelector("[data-auto-review]");
    if (r && window.htmx) htmx.trigger(r, "review-run");
  }
  function gateSave(form) {
    var save = form && form.querySelector("[data-save-row] button[type=submit]");
    if (!save) return;
    var panel = form.querySelector("[data-review]");
    var state = panel ? panel.getAttribute("data-review") : "";
    var warns = form.querySelectorAll("[data-warning]").length;
    var ack = form.querySelector("[data-warn-ack]");
    var open = state === "ok" && (!warns || (ack && ack.checked));
    if (!panel || form._stale) open = false; // no review yet, or the form changed since the review: Save waits
    var hint = form.querySelector("[data-ack-hint]");
    if (hint) hint.hidden = Boolean(ack && ack.checked);
    save.disabled = !open;
    save.title = open ? "" : (state === "blocked" ? (EN ? "Fill in what is missing first" : "كمّل الناقص الأول") : (warns ? (EN ? "Tick that you checked the warnings" : "علّم إنك راجعت التنبيهات") : ""));
  }
  window.whGateSave = gateSave;
  var unitFormEl = document.getElementById("unit-form");
  if (unitFormEl && unitFormEl.querySelector("[data-auto-review]")) {
    gateSave(unitFormEl);
    // The warnings tick survives a reload of the review when there is no new warning; a changed form needs a new look.
    var warnList = function (form) { return Array.prototype.map.call(form.querySelectorAll("[data-warning]"), function (w) { return w.getAttribute("data-warning"); }); };
    document.addEventListener("htmx:beforeSwap", function (e) {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-auto-review")) {
        var a0 = unitFormEl.querySelector("[data-warn-ack]");
        unitFormEl._ackSig = a0 && a0.checked ? warnList(unitFormEl) : null;
      }
    });
    document.addEventListener("htmx:afterSwap", function (e) {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-auto-review")) {
        var a1 = unitFormEl.querySelector("[data-warn-ack]");
        if (unitFormEl._ackSig && a1 && warnList(unitFormEl).every(function (f) { return unitFormEl._ackSig.indexOf(f) >= 0; })) a1.checked = true; // only warnings already seen: the tick stays
        unitFormEl._ackSig = null;
        unitFormEl._stale = false;
        gateSave(unitFormEl);
      }
    });
    // Anything that changes the form (or its photos) makes the review old: Save closes at once and the review runs again.
    var rvTimer = null;
    var stale = function () {
      unitFormEl._stale = true;
      gateSave(unitFormEl);
      if (!unitFormEl.querySelector("[data-review]")) return; // the review has not been shown yet (earlier steps)
      clearTimeout(rvTimer);
      rvTimer = setTimeout(function () { runReview(unitFormEl); }, 700);
    };
    unitFormEl.addEventListener("photos:changed", stale);
    unitFormEl.addEventListener("change", function (e) {
      if (e.target && e.target.hasAttribute && (e.target.hasAttribute("data-warn-ack") || e.target.type === "file")) return;
      if (unitFormEl.querySelector("[data-review]")) stale();
    });
    // If the review can't be loaded the server still checks everything at Save, so Save is not left locked.
    // If the review can't be loaded, Save stays closed and the page says so, with a button to check again.
    var reviewFailed = function (e) {
      if (!(e.target && e.target.hasAttribute && e.target.hasAttribute("data-auto-review"))) return;
      e.target.innerHTML = '<section class="card" data-review-failed><p class="notice bad" role="alert">' + (EN ? "Couldn't check the details. Save is off until it works." : "مقدرناش نراجع البيانات. الحفظ مقفول لحد ما تنجح.") + ' <button type="button" class="secondary small" data-review-retry>' + (EN ? "Check again" : "راجع تاني") + '</button></p></section>';
      unitFormEl._stale = false;
      gateSave(unitFormEl);
    };
    document.addEventListener("htmx:responseError", reviewFailed);
    document.addEventListener("htmx:sendError", reviewFailed);
    unitFormEl.addEventListener("click", function (e) { if (e.target.closest && e.target.closest("[data-review-retry]")) runReview(unitFormEl); });
    unitFormEl.addEventListener("change", function (e) { if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-warn-ack")) gateSave(unitFormEl); });
    // An edit page (not stepped) shows its review at once and keeps it current while the form is changed.
    if (!unitFormEl.hasAttribute("data-steps")) {
      setTimeout(function () { runReview(unitFormEl); }, 0);
    }
    // The form can't be touched while a button's request runs (the automatic review is quiet).
    document.addEventListener("htmx:beforeRequest", function (e) {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-auto-review")) return;
      if (e.detail && e.detail.elt && unitFormEl.contains(e.detail.elt)) setFormBusy(unitFormEl, true);
    });
    document.addEventListener("htmx:afterRequest", function (e) {
      if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-auto-review")) return;
      if (e.detail && e.detail.elt && unitFormEl.contains(e.detail.elt)) setFormBusy(unitFormEl, false);
    });
    // A missing item in the list takes you to its field (on its step).
    var jump = function (li) {
      var f = li.getAttribute("data-blocker");
      var input = f && unitFormEl.querySelector('[name="' + f + '"]');
      if (!input) return;
      var part = input.closest("[data-step]");
      if (part && part.hidden) unitFormEl.dispatchEvent(new CustomEvent("stepgoto", { detail: part.getAttribute("data-step") }));
      var more = input.closest("details");
      if (more) more.open = true;
      var lab = input.closest("label");
      if (lab) lab.classList.add("field-missing");
      setTimeout(function () { input.focus(); input.scrollIntoView({ block: "center" }); }, 0);
    };
    unitFormEl.addEventListener("click", function (e) { var li = e.target.closest && e.target.closest("[data-blocker]"); if (li) jump(li); });
    unitFormEl.addEventListener("keydown", function (e) { if (e.key !== "Enter" && e.key !== " ") return; var li = e.target.closest && e.target.closest("[data-blocker]"); if (li) { e.preventDefault(); jump(li); } });
  }
  // Stepped forms (<form data-steps="A|B|C">): one step at a time with a progress bar, Back and Next. Next checks only
  // the fields of the step on screen. Without this script every step simply shows.
  function stepForm(form) {
    if (!form || form.hasAttribute("data-stepped")) return;
    form.addEventListener("input", function (e) {
      var lab = e.target && e.target.closest ? e.target.closest("label") : null;
      if (lab) lab.classList.remove("field-missing");
    });
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
    var spin = document.createElement("span");
    spin.className = "spin"; spin.setAttribute("aria-hidden", "true");
    next.appendChild(spin);
    nav.appendChild(prev); nav.appendChild(next);
    var stepErr = document.createElement("p");
    stepErr.className = "notice bad card step-err"; stepErr.setAttribute("role", "alert"); stepErr.hidden = true;
    form.insertBefore(bar, form.firstChild.nextSibling);
    form.insertBefore(stepErr, bar.nextSibling); // the message sits at the top, under the step bar, where it is seen
    var showStepErr = function () { stepErr.hidden = false; try { stepErr.scrollIntoView({ block: "center" }); } catch (x) { window.scrollTo(0, 0); } };
    form.appendChild(nav);
    var checkUrl = form.getAttribute("data-check");
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
      stepErr.hidden = true;
      window.scrollTo(0, 0);
      document.dispatchEvent(new CustomEvent("steps:change"));
      // The last step is "check and save": the review loads by itself and decides whether Save is open.
      if (at === names.length) runReview(form);
    }
    // Next: the browser's own checks first; then, when the form has a check address, the server's field rules for this
    // step (a spinner shows while they run). A blocker on a field of this step keeps the step open with its message.
    // If the check cannot be reached, Next still moves on: the final save checks everything.
    form.addEventListener("stepgoto", function (e) { show(Number(e.detail)); });
    function busy(on) {
      setFormBusy(form, on);
      next.disabled = on;
      next.classList.toggle("is-busy", on);
    }
    var warnedDup = null;
    next.addEventListener("click", function () {
      var fields = form.querySelectorAll('[data-step="' + at + '"] input, [data-step="' + at + '"] select, [data-step="' + at + '"] textarea');
      for (var i = 0; i < fields.length; i++) if (fields[i].willValidate && !fields[i].checkValidity()) { fields[i].reportValidity(); return; }
      if (!checkUrl || !window.fetch || !window.FormData) { show(at + 1); return; }
      var here = at;
      busy(true);
      fetch(checkUrl, { method: "POST", body: new FormData(form), credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          busy(false);
          if (here !== at) return;
          var shown = [];
          var blockers = (j && j.blockers) || [];
          for (var b = 0; b < blockers.length; b++) {
            // "Compound or area" is one blocker for two inputs; it is shown on the compound field.
            var fname = blockers[b].field === "location" ? "compound" : blockers[b].field;
            var input = form.querySelector('[data-step="' + here + '"] [name="' + fname + '"]');
            if (input) shown.push({ field: fname, label: blockers[b].label });
          }
          // A look-alike unit is a red warning with a link, shown once; tapping Next again goes on (the final save does not ask again: dup_ack).
          var dup = j && j.duplicate;
          if (!shown.length && dup && warnedDup !== dup) {
            warnedDup = dup;
            stepErr.textContent = "";
            var lnk = document.createElement("a");
            lnk.href = "/app/units/" + encodeURIComponent(dup);
            lnk.textContent = dup;
            stepErr.appendChild(document.createTextNode(EN ? "⚠️ This looks like " : "⚠️ شكلها نفس الوحدة "));
            stepErr.appendChild(lnk);
            stepErr.appendChild(document.createTextNode(EN ? " already in your list. Tap Next again if it is a different unit." : " اللي عندك. لو دي وحدة تانية دوس التالي تاني."));
            showStepErr();
            return;
          }
          // Tapping Next past the look-alike warning accepts it: the final save never asks about it again (dup_ack).
          if (!shown.length && dup && warnedDup === dup) {
            var da = form.querySelector('input[name="dup_ack"]');
            if (!da) { da = document.createElement("input"); da.type = "hidden"; da.name = "dup_ack"; form.appendChild(da); }
            da.value = "1";
          }
          if (!shown.length) { show(here + 1); return; }
          // Red outline on each field that blocks this step; it clears when the field is changed.
          for (var m = 0; m < shown.length; m++) {
            var mf = form.querySelector('[data-step="' + here + '"] [name="' + shown[m].field + '"]');
            if (mf && mf.closest("label")) mf.closest("label").classList.add("field-missing");
          }
          stepErr.textContent = shown.map(function (x) { return x.label; }).join(" · ");
          showStepErr();
          var first = form.querySelector('[data-step="' + here + '"] [name="' + shown[0].field + '"]');
          if (first) first.focus({ preventScroll: true }); // the message at the top stays in view
        })
        .catch(function () { busy(false); show(here + 1); });
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
    "ai": [ "The AI couldn't write that down. Tap the mic again to use the phone's voice.", "الذكاء الاصطناعي مقدرش يكتبها. اضغط المايك تاني عشان صوت التليفون." ],
    "no-speech": [ "Couldn't hear you. Try again or type.", "مسمعناش كويس. جرب تاني أو اكتب." ]
  };
  function setMic(btn, state) {
    btn.classList.toggle("recording", state === "recording");
    btn.classList.toggle("busy", state === "busy");
    btn.setAttribute("aria-pressed", state === "recording" ? "true" : "false");
  }
  function pickType() {
    var types = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    for (var i = 0; i < types.length; i++) if (window.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) return types[i];
    return "";
  }
  // The search box shows a spinner while a search is on its way (the page changes once the form is sent).
  function busyBox(form, on) {
    var box = form && form.querySelector(".searchbox");
    if (box) box.classList.toggle("busy", on);
  }
  function send(form) {
    busyBox(form, true);
    form.submit();
  }
  // Records a note and sends it to the server, which writes it down with the AI. Falls back to the phone's speech
  // when the server cannot (btn._phone is set, and the next tap uses the phone).
  function transcribe(btn, form, blob) {
    var data = new FormData();
    data.append("voice", blob, "note");
    var meta = document.querySelector('meta[name="csrf-token"]');
    setMic(btn, "busy");
    fetch(btn.getAttribute("data-voice-url"), { method: "POST", body: data, credentials: "same-origin", headers: { "X-CSRF-Token": meta ? meta.content : "" } })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (out) {
        setMic(btn, "idle");
        if (out.ok && out.j.q) {
          form.querySelector("input[name=q]").value = out.j.q;
          return send(form);
        }
        if (out.j.fallback) btn._phone = true;
        toast(out.j.error || (EN ? VOICE_ERRORS["no-speech"][0] : VOICE_ERRORS["no-speech"][1]), true);
      })
      .catch(function () {
        setMic(btn, "idle");
        btn._phone = true;
        toast(EN ? VOICE_ERRORS.ai[0] : VOICE_ERRORS.ai[1], true);
      });
  }
  function recordNote(btn, form) {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var type = pickType();
      var rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      var chunks = [];
      rec.ondataavailable = function (ev) { if (ev.data.size) chunks.push(ev.data); };
      rec.onstop = function () {
        btn._rec = null;
        stream.getTracks().forEach(function (t) { t.stop(); });
        transcribe(btn, form, new Blob(chunks, { type: rec.mimeType || type || "audio/webm" }));
      };
      btn._rec = rec;
      rec.start();
      setMic(btn, "recording");
    }).catch(function () {
      toast(EN ? VOICE_ERRORS["not-allowed"][0] : VOICE_ERRORS["not-allowed"][1], true);
    });
  }
  // The phone's own speech recognition, used when the AI path is not available.
  function listenPhone(btn, form, input) {
    var rec = new Speech();
    var heard = "";
    var failed = false;
    var timer = null;
    // Some browsers start listening but never send results or an end event. Give up after a while so the mic is not
    // stuck red or spinning, and say what to do.
    rec.guard = function (ms) {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (btn._rec !== rec) return;
        try { rec.abort(); } catch (_) {}
        btn._rec = null;
        setMic(btn, "idle");
        if (heard) send(form);
        else toast(EN ? "Voice didn't respond. Check the mic, or type your search." : "الصوت مردش. اتأكد من المايك، أو اكتب بحثك.", true);
      }, ms);
    };
    rec.lang = EN ? "en-US" : "ar-EG";
    rec.interimResults = true;
    rec.continuous = false;
    btn._rec = rec;
    rec.onresult = function (ev) {
      var text = "";
      for (var i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      heard = text.trim();
      input.value = text;
      rec.guard(10000);
    };
    rec.onerror = function (ev) {
      failed = true;
      var msg = VOICE_ERRORS[ev.error];
      if (msg) toast(EN ? msg[0] : msg[1], true);
    };
    rec.onend = function () {
      clearTimeout(timer);
      if (btn._rec !== rec) return;
      btn._rec = null;
      setMic(btn, "idle");
      if (failed) return;
      if (heard) send(form);
      else toast(EN ? VOICE_ERRORS["no-speech"][0] : VOICE_ERRORS["no-speech"][1], true);
    };
    try {
      rec.start();
      setMic(btn, "recording");
      rec.guard(12000);
    } catch (_) {
      btn._rec = null;
      toast(EN ? VOICE_ERRORS["no-speech"][0] : VOICE_ERRORS["no-speech"][1], true);
    }
  }
  function listen(btn) {
    if (btn._rec) {
      // Keep the recorder in a local: its end handler may clear btn._rec before stop() returns.
      var active = btn._rec;
      setMic(btn, "busy");
      active.stop();
      if (active.guard) active.guard(4000);
      return;
    }
    var form = btn.form || btn.closest("form");
    var input = form && form.querySelector("input[name=q]");
    if (!input) return;
    input.blur(); // dismiss the keyboard so the mic's state is what the user sees
    if (canRecord() && btn.getAttribute("data-voice-url") && !btn._phone) return recordNote(btn, form);
    btn._phone = false;
    listenPhone(btn, form, input);
  }
  function canRecord() {
    return !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }
  // Enter (or the iPhone's blue Go key) searches the typed text. It never starts the mic. Arabic input composes with
  // isComposing, so Enter there only picks the word.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" || e.isComposing) return;
    var input = e.target.closest && e.target.closest("form[role=search] input[name=q]");
    if (!input) return;
    e.preventDefault();
    input.blur();
    if (input.value.trim()) send(input.form);
  });
  if (Speech) {
    var mics = document.querySelectorAll("[data-mic]");
    for (var m = 0; m < mics.length; m++) {
      mics[m].hidden = false;
      mics[m].addEventListener("click", function () { listen(this); });
    }
  }
  // A voice file picked on the unit form runs the same "fill from a voice note" request as the record button.
  document.addEventListener("change", function (e) {
    var input = e.target;
    if (!input || !input.matches || !input.matches("[data-voice-file]")) return;
    var n = input.files ? input.files.length : 0;
    if (n > 5) { input.value = ""; toast(EN ? "Up to 5 voice notes at a time." : "لحد 5 فويس نوت في المرة.", true); return; }
    var per = Number(input.getAttribute("data-cost")) || 0;
    if (n > 1 && per) toast(EN ? n + " voice notes · " + n * per + " credits" : n + " فويس نوت · " + n * per + " رصيد", false);
    var box = input.closest("section") || input.form;
    var fill = box && box.querySelector('[data-ai="unit_fill"]');
    if (fill && window.htmx) htmx.trigger(fill, "click");
    else if (input.form) input.form.submit();
  });
  // The home page's mic opens search with ?voice=1. Listening never starts on page load: browsers ask for the
  // microphone then, on every visit and back-navigation. Focus the box and let the user tap the mic.
  var start = document.querySelector("[data-voice-start]");
  if (start) start.focus();
  // Place suggestions: compounds, their other names, areas and sub-zones in one list (GET /app/places/suggest).
  var placeTimer = null;
  document.addEventListener("input", function (e) {
    var input = e.target;
    if (!input || !input.matches || !input.matches("[data-place-suggest]")) return;
    var list = document.getElementById(input.getAttribute("list"));
    var q = input.value.trim();
    if (!list || q.length < 2) return;
    clearTimeout(placeTimer);
    placeTimer = setTimeout(function () {
      fetch("/app/places/suggest?q=" + encodeURIComponent(q), { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : { items: [] }; })
        .then(function (d) {
          list.innerHTML = "";
          window.__placeItems = d.items || [];
          window.__placeQ = q.toLowerCase();
          (d.items || []).forEach(function (it) {
            var o = document.createElement("option");
            o.value = it.label || it.name_en || it.name_ar;
            o.label = it.path || "";
            list.appendChild(o);
          });
        })
        .catch(function () {});
    }, 200);
  });
  // A compound brings its own area (filled and locked); a compound or area the list does not know makes the area
  // mandatory and ticks "not in the list" so the new place goes to the approval queue with its area.
  // The list is read for the typed value itself: a change that comes before its suggestions arrived (fast typing, paste,
  // autofill) asks for them first, so a known compound is never taken for a new one.
  document.addEventListener("change", function (e) {
    var input = e.target;
    if (!input || !input.matches || !input.matches("[data-place-suggest]")) return;
    var typed = input.value.trim();
    if (typed.length >= 2 && window.__placeQ !== typed.toLowerCase() && window.fetch) {
      clearTimeout(placeTimer);
      fetch("/app/places/suggest?q=" + encodeURIComponent(typed), { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : { items: [] }; })
        .catch(function () { return { items: [] }; })
        .then(function (d) {
          window.__placeItems = d.items || [];
          window.__placeQ = typed.toLowerCase();
          if (input.value.trim() === typed) input.dispatchEvent(new Event("change", { bubbles: true }));
        });
      return;
    }
    placeArea(input);
  });
  // Place box states: known place -> its area shown as one line (boxes stay hidden); unknown name -> a warning with close
  // matches and an "add as new" button; add-new opens a small part with the required area and the optional extras.
  function placeBits(input) {
    var form = input.form;
    var box = input.closest("[data-place]");
    if (!form || !box) return null;
    return {
      box: box, areaSel: form.querySelector('select[name="area_id"]'), subSel: form.querySelector('select[name="subzone_id"]'),
      isNew: form.querySelector('input[name="compound_new"]'), panel: box.querySelector("[data-place-new]"),
      warn: box.querySelector("[data-place-warn]"), sum: box.querySelector("[data-place-summary]"), input: input
    };
  }
  function optText(sel) { return sel && sel.value && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : ""; }
  function placeShowSummary(b) {
    var t = [optText(b.areaSel), optText(b.subSel)].filter(Boolean).join(" › ");
    b.sum.querySelector("[data-place-path]").textContent = t;
    b.sum.hidden = !t;
  }
  function placeOpenNew(b, open) {
    b.panel.hidden = !open;
    b.isNew.disabled = !open;
    if (open) { b.warn.hidden = true; b.sum.hidden = true; b.areaSel.setAttribute("required", "required"); } else { b.areaSel.removeAttribute("required"); }
  }
  function placeArea(input) {
    var b = placeBits(input);
    if (!b || !b.areaSel) return;
    var v = input.value.trim().toLowerCase();
    var hit = (window.__placeItems || []).filter(function (it) { return (it.name_en || "").toLowerCase() === v || (it.name_ar || "").toLowerCase() === v; })[0];
    b.warn.hidden = true;
    if (!v) { placeOpenNew(b, false); b.sum.hidden = true; return; }
    if (hit && hit.area_id) {
      placeOpenNew(b, false);
      b.areaSel.value = hit.area_id;
      if (b.subSel) b.subSel.value = hit.kind === "compound" || hit.subzone_id ? hit.subzone_id || "" : b.subSel.value;
      placeShowSummary(b);
      return;
    }
    if (!b.panel.hidden) return; // the add-new part is already open for this name
    b.sum.hidden = true;
    var items = (window.__placeItems || []).slice(0, 3);
    b.warn.querySelector("[data-place-warn-text]").textContent = (b.box.getAttribute("data-msg-warn") || "").replace("%s", input.value.trim());
    var did = b.warn.querySelector("[data-place-did]");
    did.innerHTML = "";
    items.forEach(function (it) {
      var btn = document.createElement("button");
      btn.type = "button"; btn.className = "btn ghost"; btn.setAttribute("data-place-pick", it.label || it.name_en || it.name_ar);
      btn.textContent = (it.label || it.name_en || it.name_ar) + (it.path ? " · " + it.path : "");
      did.appendChild(btn);
    });
    b.warn.hidden = false;
  }
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target.closest("[data-place-add],[data-place-cancel],[data-place-pick]") : null;
    if (!t) return;
    var box = t.closest("[data-place]");
    var input = box && box.querySelector("[data-place-suggest]");
    var b = input && placeBits(input);
    if (!b) return;
    if (t.hasAttribute("data-place-pick")) {
      input.value = t.getAttribute("data-place-pick");
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (t.hasAttribute("data-place-add")) {
      b.areaSel.value = ""; if (b.subSel) b.subSel.value = "";
      placeOpenNew(b, true);
      b.areaSel.focus();
    } else {
      placeOpenNew(b, false);
      b.warn.hidden = true;
      input.focus();
    }
  });
})();
