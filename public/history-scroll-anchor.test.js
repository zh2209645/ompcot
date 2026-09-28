import { describe, expect, test, vi } from "vitest";
import { anchorHistoryToBottom } from "./history-scroll-anchor.js";

describe("anchorHistoryToBottom", () => {
  test("re-anchors to latest scrollHeight across delayed layout shifts", () => {
    const messagesEl = {
      scrollTop: 0,
      scrollHeight: 120,
      style: { scrollBehavior: "smooth" },
    };

    const timeouts = [];
    const requestAnimationFrame = vi.fn((cb) => {
      cb();
      return 1;
    });
    const setTimeoutFn = vi.fn((cb, ms) => {
      timeouts.push({ cb, ms });
      return timeouts.length;
    });

    anchorHistoryToBottom(messagesEl, {
      requestAnimationFrame,
      setTimeout: setTimeoutFn,
      settleDelayMs: 80,
      settlePasses: 2,
    });

    // immediate anchor
    expect(messagesEl.scrollTop).toBe(120);
    expect(messagesEl.style.scrollBehavior).toBe("");

    // first layout shift before first timeout flushes
    messagesEl.scrollHeight = 380;
    timeouts[0].cb();
    expect(messagesEl.scrollTop).toBe(380);

    // second layout shift before second timeout flushes
    messagesEl.scrollHeight = 620;
    timeouts[1].cb();
    expect(messagesEl.scrollTop).toBe(620);
  });

  test("skips bottom anchoring when preserving a search-target scroll position", () => {
    const messagesEl = {
      scrollTop: 240,
      scrollHeight: 620,
      style: { scrollBehavior: "smooth" },
    };

    const requestAnimationFrame = vi.fn((cb) => {
      cb();
      return 1;
    });
    const setTimeoutFn = vi.fn();

    anchorHistoryToBottom(messagesEl, {
      requestAnimationFrame,
      setTimeout: setTimeoutFn,
      preserveScrollTarget: true,
    });

    expect(messagesEl.scrollTop).toBe(240);
    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(messagesEl.style.scrollBehavior).toBe("smooth");
  });

  test("leaves a reader who scrolled away alone during the settle window", () => {
    const messagesEl = {
      scrollTop: 0,
      scrollHeight: 3000,
      clientHeight: 300,
      style: { scrollBehavior: "smooth" },
    };

    const timeouts = [];
    const requestAnimationFrame = vi.fn((cb) => {
      cb();
      return 1;
    });
    const setTimeoutFn = vi.fn((cb, ms) => {
      timeouts.push({ cb, ms });
      return timeouts.length;
    });

    anchorHistoryToBottom(messagesEl, {
      requestAnimationFrame,
      setTimeout: setTimeoutFn,
      settleDelayMs: 80,
      settlePasses: 2,
    });
    // The immediate anchor runs …
    expect(messagesEl.scrollTop).toBe(3000);

    // … the reader scrolls up through history (with tail-first hydration that
    // is where they are, and earlier entries keep loading above them) …
    messagesEl.scrollTop = 400;
    timeouts[0].cb();
    timeouts[1].cb();

    // … and the settle passes leave them exactly there.
    expect(messagesEl.scrollTop).toBe(400);
  });

  test("still re-anchors settling layout while the reader is at the bottom", () => {
    const messagesEl = {
      scrollTop: 0,
      scrollHeight: 900,
      clientHeight: 300,
      style: { scrollBehavior: "smooth" },
    };

    const timeouts = [];
    const requestAnimationFrame = vi.fn((cb) => {
      cb();
      return 1;
    });
    const setTimeoutFn = vi.fn((cb) => {
      timeouts.push({ cb });
      return timeouts.length;
    });

    anchorHistoryToBottom(messagesEl, {
      requestAnimationFrame,
      setTimeout: setTimeoutFn,
      settlePasses: 1,
    });
    expect(messagesEl.scrollTop).toBe(900);

    // Late layout (images, markdown) grew the content while the reader stayed
    // at the end: the settle pass follows it.
    messagesEl.scrollHeight = 1500;
    timeouts[0].cb();
    expect(messagesEl.scrollTop).toBe(1500);
  });
});
