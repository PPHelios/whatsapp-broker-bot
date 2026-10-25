// tests/router/tap-guard.test.js — lib/tapGuard.js: repeated button taps are dropped (busy / same button again too soon).
"use strict";

const TapGuard = require("../../lib/tapGuard");

describe("tap guard", () => {
  let at;
  let guard;
  beforeEach(() => {
    at = 0;
    guard = TapGuard.createTapGuard({ now: () => at });
  });

  test("a tap while the broker's previous tap runs is dropped as busy; other brokers are not held", () => {
    const first = guard.claim("b1", "draft_confirm");
    expect(first.ok).toBe(true);
    expect(guard.claim("b1", "draft_cancel")).toEqual({ ok: false, reason: "busy" });
    expect(guard.claim("b2", "draft_confirm").ok).toBe(true);
    first.release();
    expect(guard.claim("b1", "draft_cancel").ok).toBe(true);
  });

  test("the same button again inside the window is a repeat; after it, or a different button, runs", () => {
    guard.claim("b1", "DRAFT_SAVE").release();
    at += 1000;
    expect(guard.claim("b1", "DRAFT_SAVE")).toEqual({ ok: false, reason: "repeat" });
    const other = guard.claim("b1", "draft_edit");
    expect(other.ok).toBe(true);
    other.release();
    at += TapGuard.REPEAT_WINDOW_MS;
    expect(guard.claim("b1", "DRAFT_SAVE").ok).toBe(true);
  });

  test("a hung turn stops holding the broker after STALE_MS; release is safe to call twice", () => {
    const hung = guard.claim("b1", "x");
    at += TapGuard.STALE_MS;
    const next = guard.claim("b1", "y");
    expect(next.ok).toBe(true);
    hung.release(); // the old turn finishing must not free the new one
    expect(guard.claim("b1", "z")).toEqual({ ok: false, reason: "busy" });
    next.release();
    next.release();
    expect(guard.claim("b1", "z").ok).toBe(true);
  });

  test("tapId reads button and list replies only; toasts are bilingual", () => {
    expect(TapGuard.tapId({ type: "interactive", interactive: { button_reply: { id: "a" } } })).toBe("a");
    expect(TapGuard.tapId({ type: "interactive", interactive: { list_reply: { id: "b" } } })).toBe("b");
    expect(TapGuard.tapId({ type: "text", text: { body: "a" } })).toBeNull();
    expect(TapGuard.toast("busy", "en")).toMatch(/still working/);
    expect(TapGuard.toast("repeat", "ar")).toMatch(/وصلت/);
  });
});
