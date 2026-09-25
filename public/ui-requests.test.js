import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setLanguage } from "./i18n.js";
import { createForkActions, UIRequestManager } from "./ui-requests.js";

class MockWsClient extends EventTarget {
  constructor() {
    super();
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
    return `req-${this.sent.length}`;
  }

  respond(data, { success = true, error = undefined } = {}) {
    const requestId = `req-${this.sent.length}`;
    this.dispatchEvent(
      new CustomEvent("commandResponse", { detail: { requestId, success, data, error } }),
    );
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("extension UI request dialogs", () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  });

  function createManager(ws = new MockWsClient()) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const manager = new UIRequestManager(container, ws);
    return { manager, ws, container };
  }

  const dialog = (ctx) => ctx.container.querySelector(".dialog");
  const lastSent = (ctx) => ctx.ws.sent[ctx.ws.sent.length - 1];

  test("select: clicking an option sends ui_response with its value", async () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "u1", method: "select", title: "Pick", options: ["A", "B"] });

    const options = ctx.container.querySelectorAll(".dialog-option");
    expect(options).toHaveLength(2);
    expect(dialog(ctx).getAttribute("role")).toBe("dialog");

    options[1].click();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_response", id: "u1", value: "B" });
    expect(dialog(ctx)).toBeNull();
  });

  test("select options are keyboard-activatable", async () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "u1", method: "select", options: ["A"] });

    const option = ctx.container.querySelector(".dialog-option");
    expect(option.tabIndex).toBe(0);
    expect(option.getAttribute("role")).toBe("button");
    option.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_response", id: "u1", value: "A" });
  });

  test("confirm: yes/no map to boolean values", async () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "c1", method: "confirm", title: "Sure?", message: "really" });

    ctx.container.querySelector("#dialog-yes").click();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_response", id: "c1", value: true });

    ctx.manager.handle({ id: "c2", method: "confirm" });
    ctx.container.querySelector("#dialog-no").click();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_response", id: "c2", value: false });
  });

  test("input: submit sends the trimmed value; empty submit is a cancel", async () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "i1", method: "input", placeholder: "name" });

    const input = ctx.container.querySelector(".dialog-input");
    input.value = "  hello  ";
    ctx.container.querySelector("#dialog-submit").click();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_response", id: "i1", value: "hello" });

    ctx.manager.handle({ id: "i2", method: "input" });
    ctx.container.querySelector("#dialog-submit").click();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_cancel", id: "i2" });
  });

  test("cancel button and Esc send ui_cancel", async () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "u1", method: "select", options: ["A"] });

    ctx.container.querySelector("#dialog-cancel").click();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_cancel", id: "u1" });

    ctx.manager.handle({ id: "u2", method: "confirm" });
    document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_cancel", id: "u2" });
  });

  test("deadline expiry dismisses locally and sends a best-effort ui_cancel (F4)", async () => {
    vi.useFakeTimers();
    const ctx = createManager();
    ctx.manager.handle({ id: "t1", method: "select", options: ["A"], timeout: 5000 });

    // Countdown is visible and starts at 5s.
    expect(ctx.container.querySelector(".dialog-countdown-text").textContent).toContain("5");

    vi.advanceTimersByTime(5000);
    // Coordinated contract: the server resolves expired requests itself and
    // treats them as settled, so the frontend dismisses locally and sends a
    // ui_cancel the server may safely ignore — never a ui_response.
    expect(lastSent(ctx)).toEqual({ type: "ui_cancel", id: "t1" });
    expect(dialog(ctx)).toBeNull();
  });

  test("confirm deadline expiry also sends ui_cancel", async () => {
    vi.useFakeTimers();
    const ctx = createManager();
    ctx.manager.handle({ id: "t2", method: "confirm", timeout: 1000 });

    vi.advanceTimersByTime(1000);
    expect(lastSent(ctx)).toEqual({ type: "ui_cancel", id: "t2" });
  });

  test("multiple requests queue and replay one dialog at a time", async () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "q1", method: "select", options: ["A"] });
    ctx.manager.handle({ id: "q2", method: "confirm" });
    ctx.manager.handle({ id: "q3", method: "input" });

    // Only the first dialog is on screen.
    expect(ctx.container.querySelectorAll(".dialog")).toHaveLength(1);
    expect(ctx.container.querySelector(".dialog-option")).toBeTruthy();

    ctx.container.querySelector(".dialog-option").click();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_response", id: "q1", value: "A" });
    expect(ctx.container.querySelector("#dialog-yes")).toBeTruthy();

    ctx.container.querySelector("#dialog-yes").click();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_response", id: "q2", value: true });
    expect(ctx.container.querySelector(".dialog-input")).toBeTruthy();

    ctx.container.querySelector("#dialog-cancel").click();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "ui_cancel", id: "q3" });
    expect(dialog(ctx)).toBeNull();
  });

  test("duplicate request ids are ignored; notify never opens a modal", () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "d1", method: "select", options: ["A"] });
    ctx.manager.handle({ id: "d1", method: "select", options: ["B"] });
    expect(ctx.container.querySelectorAll(".dialog-option")).toHaveLength(1);

    ctx.manager.handle({ id: "d2", method: "notify", message: "hi" });
    // The live select dialog is untouched: still the only dialog on screen.
    expect(ctx.container.querySelectorAll(".dialog")).toHaveLength(1);
    expect(ctx.container.querySelectorAll(".dialog-option")).toHaveLength(1);
  });

  test("malformed or unknown requests are dropped with a warning", () => {
    const ctx = createManager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ctx.manager.handle({ method: "select" }); // no id
    ctx.manager.handle({ id: "x", method: "teleport" }); // unknown method
    expect(dialog(ctx)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("language switch re-renders the live dialog and keeps typed text", () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "l1", method: "input", timeout: 60000 });
    const input = ctx.container.querySelector(".dialog-input");
    input.value = "keep me";
    setLanguage("zh-CN");

    expect(ctx.container.querySelector(".dialog-input").value).toBe("keep me");
    expect(ctx.container.querySelector(".dialog-countdown-text").textContent).toContain("60");
    setLanguage("en");
    ctx.manager.destroy();
  });

  // ── F6: attribute-injection XSS via placeholder ─────────────────────────

  test("F6: a malicious placeholder cannot inject dialog attributes", () => {
    const ctx = createManager();
    ctx.manager.handle({
      id: "x1",
      method: "input",
      title: `"<img src=x onerror=alert(2)>`,
      placeholder: `" onfocus="alert(1)" autofocus x="`,
    });

    const input = ctx.container.querySelector(".dialog-input");
    expect(input).toBeTruthy();
    // The payload must exist as the (single) placeholder VALUE, never as
    // injected attributes.
    expect(input.getAttribute("onfocus")).toBeNull();
    expect(input.hasAttribute("autofocus")).toBe(false);
    expect(input.hasAttribute("x")).toBe(false);
    expect(input.placeholder).toBe(`" onfocus="alert(1)" autofocus x="`);
    // No element in the dialog carries an on* attribute.
    for (const el of ctx.container.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.toLowerCase().startsWith("on")).toBe(false);
      }
    }
    // The title payload stayed escaped text, not markup.
    expect(ctx.container.querySelector("img")).toBeNull();
    expect(ctx.container.querySelector(".dialog-title").textContent).toBe(
      `"<img src=x onerror=alert(2)>`,
    );
  });

  test("F6: editor prefill is assigned as a value, not markup", () => {
    const ctx = createManager();
    ctx.manager.handle({
      id: "x2",
      method: "editor",
      prefill: `</textarea><img src=x onerror=alert(3)>`,
    });

    const textarea = ctx.container.querySelector(".dialog-textarea");
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe(`</textarea><img src=x onerror=alert(3)>`);
    expect(ctx.container.querySelector("img")).toBeNull();
  });

  // ── F5: server `expiresAt` deadlines ────────────────────────────────────

  test("F5: expiresAt drives the countdown instead of a fresh local window", () => {
    vi.useFakeTimers();
    const ctx = createManager();
    // The compat `timeout` field is huge — the server's absolute deadline 5s
    // out must win.
    ctx.manager.handle({
      id: "e1",
      method: "select",
      options: ["A"],
      timeout: 600000,
      expiresAt: Date.now() + 5000,
    });

    expect(ctx.container.querySelector(".dialog-countdown-text").textContent).toContain("5");
    vi.advanceTimersByTime(4999);
    expect(ctx.container.querySelector(".dialog")).toBeTruthy();

    vi.advanceTimersByTime(2);
    expect(lastSent(ctx)).toEqual({ type: "ui_cancel", id: "e1" });
    expect(dialog(ctx)).toBeNull();
  });

  test("F5: requests already expired at dequeue are discarded silently", async () => {
    vi.useFakeTimers();
    const ctx = createManager();
    // First dialog occupies the screen...
    ctx.manager.handle({ id: "live", method: "confirm", timeout: 60000 });
    // ...while this one's server deadline passes entirely in the queue.
    ctx.manager.handle({
      id: "dead",
      method: "select",
      options: ["A"],
      timeout: 30000,
      expiresAt: Date.now() + 1000,
    });
    vi.advanceTimersByTime(1500);
    // And one more that arrives already expired.
    ctx.manager.handle({ id: "late", method: "input", expiresAt: Date.now() - 1000 });

    ctx.container.querySelector("#dialog-yes").click();
    await vi.advanceTimersByTimeAsync(0);

    // Only the live dialog's reply went out; nothing was shown or sent for
    // the expired requests (the server already settled them).
    expect(ctx.ws.sent).toEqual([{ type: "ui_response", id: "live", value: true }]);
    expect(dialog(ctx)).toBeNull();
  });

  // ── F4: server-side cancel frames ───────────────────────────────────────

  test("F4: a cancel frame dismisses the active dialog without replying", async () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "a1", method: "confirm" });
    ctx.manager.handle({ id: "a2", method: "select", options: ["A"] });
    const sentBefore = ctx.ws.sent.length;

    ctx.manager.handle({ id: "a1", method: "cancel" });
    await tick();

    // a2 took the screen; nothing was sent for a1 (server settled it).
    expect(ctx.container.querySelector(".dialog-option")).toBeTruthy();
    expect(ctx.ws.sent.length).toBe(sentBefore);
  });

  test("F4: a cancel frame drops a queued request; the queue keeps flowing", async () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "h1", method: "confirm" });
    ctx.manager.handle({ id: "h2", method: "input" });
    ctx.manager.handle({ id: "h3", method: "select", options: ["A"] });

    ctx.manager.handle({ id: "h2", method: "cancel" });
    ctx.container.querySelector("#dialog-yes").click();
    await tick();

    expect(ctx.container.querySelector(".dialog-input")).toBeNull();
    expect(ctx.container.querySelector(".dialog-option")).toBeTruthy();
    expect(lastSent(ctx)).toEqual({ type: "ui_response", id: "h1", value: true });
  });

  test("F4: a cancel frame for an unknown id is a silent no-op", () => {
    const ctx = createManager();
    ctx.manager.handle({ id: "z1", method: "confirm" });
    ctx.manager.handle({ id: "zz", method: "cancel" });
    expect(ctx.container.querySelector(".dialog")).toBeTruthy();
  });

  // ── F9: reply acks are fire-and-forget ──────────────────────────────────

  test("F9: a rejected reply ack warns in the console, never crashes", async () => {
    const ctx = createManager();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ctx.manager.handle({ id: "k1", method: "confirm" });
    ctx.container.querySelector("#dialog-yes").click();
    await tick();

    // The server acks with an error envelope, echoing the transport id.
    ctx.ws.respond(undefined, { success: false, error: "Unknown or expired UI request" });
    await tick();

    expect(warn).toHaveBeenCalledWith(
      "[UIRequests] Reply not accepted by server:",
      "k1",
      "Unknown or expired UI request",
    );
    // The dialog is long gone and nothing threw.
    expect(dialog(ctx)).toBeNull();
  });
});

describe("fork actions", () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  });

  function assistantMessage(id, { streaming = false } = {}) {
    const el = document.createElement("div");
    el.className = "message assistant";
    if (id !== undefined) el.dataset.messageId = id;
    el.innerHTML = `<div class="message-content${streaming ? " streaming" : ""}">answer</div>`;
    document.body.appendChild(el);
    return el;
  }

  function createActions(ws = new MockWsClient(), deps = {}) {
    const actions = createForkActions({
      wsClient: ws,
      messagesContainer: document.body,
      ...deps,
    });
    return { actions, ws };
  }

  const lastSent = (ctx) => ctx.ws.sent[ctx.ws.sent.length - 1];

  test("attaches a fork button to finished assistant messages; click forks its entry", async () => {
    assistantMessage("entry-42");
    const ctx = createActions();

    const btn = document.querySelector(".message-fork-btn");
    expect(btn).toBeTruthy();
    btn.click();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "fork_session", entryId: "entry-42" });
  });

  test("streaming placeholders get no button and no entry id", () => {
    assistantMessage("streaming", { streaming: true });
    const ctx = createActions();
    // Placeholder stays button-free...
    expect(document.querySelector(".message-fork-btn")).toBeNull();
    // ...but the palette path still forks (server forks from latest).
    void ctx.actions.forkFromLatest();
    expect(lastSent(ctx)).toEqual({ type: "fork_session" });
  });

  test("forkFromLatest uses the most recent message carrying an id", async () => {
    assistantMessage("entry-1");
    assistantMessage("streaming", { streaming: true });
    assistantMessage("entry-7");
    const ctx = createActions();

    const forked = ctx.actions.forkFromLatest();
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "fork_session", entryId: "entry-7" });
    ctx.ws.respond({ cancelled: true });
    await forked;
  });

  test("success reports status and refreshes; cancelled stays silent", async () => {
    assistantMessage("entry-1");
    const onStatus = vi.fn();
    const onRefresh = vi.fn();
    const ctx = createActions(new MockWsClient(), { onStatus, onRefresh });

    document.querySelector(".message-fork-btn").click();
    await tick();
    ctx.ws.respond({ cancelled: false });
    await tick();
    expect(onStatus).toHaveBeenLastCalledWith("Fork created");
    expect(onRefresh).toHaveBeenCalledTimes(1);

    document.querySelector(".message-fork-btn").click();
    await tick();
    ctx.ws.respond({ cancelled: true });
    await tick();
    // The second fork announced itself ("Forking...") but never completed.
    const forkedCalls = onStatus.mock.calls.filter(([m]) => m === "Fork created");
    expect(forkedCalls).toHaveLength(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  test("server errors surface verbatim", async () => {
    assistantMessage("entry-1");
    const onError = vi.fn();
    const ctx = createActions(new MockWsClient(), { onError });

    document.querySelector(".message-fork-btn").click();
    await tick();
    ctx.ws.respond(undefined, { success: false, error: "cannot fork a running session" });
    await tick();
    expect(onError).toHaveBeenCalledWith("cannot fork a running session");
  });
});
