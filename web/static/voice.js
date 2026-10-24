// Voice button (add/edit form): records a note with MediaRecorder and posts it for extraction.
(function () {
  "use strict";
  function pickType() {
    var types = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    for (var i = 0; i < types.length; i++) if (window.MediaRecorder && MediaRecorder.isTypeSupported(types[i])) return types[i];
    return "";
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-voice-target]");
    if (!btn) return;
    e.preventDefault();
    if (btn._rec) {
      btn._rec.stop();
      return;
    }
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      btn.textContent = btn.getAttribute("data-unsupported") || "Voice is not supported here";
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var type = pickType();
      var rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      var chunks = [];
      var label = btn.textContent;
      btn._rec = rec;
      btn.classList.add("recording");
      btn.textContent = btn.getAttribute("data-stop") || "■";
      rec.ondataavailable = function (ev) { if (ev.data.size) chunks.push(ev.data); };
      rec.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        btn._rec = null;
        btn.classList.remove("recording");
        btn.textContent = label;
        var blob = new Blob(chunks, { type: rec.mimeType || type || "audio/webm" });
        var form = btn.closest("form");
        var data = new FormData(form);
        data.append("voice", blob, "note");
        var meta = document.querySelector('meta[name="csrf-token"]');
        var target = document.querySelector(btn.getAttribute("data-voice-target"));
        fetch(btn.getAttribute("data-voice-url"), {
          method: "POST",
          body: data,
          credentials: "same-origin",
          headers: { "X-CSRF-Token": meta ? meta.content : "", "HX-Request": "true" }
        })
          .then(function (r) { return r.text(); })
          .then(function (htmlText) {
            if (target) {
              target.outerHTML = htmlText;
              if (window.htmx) window.htmx.process(document.body);
            }
          });
      };
      rec.start();
    });
  });
})();
