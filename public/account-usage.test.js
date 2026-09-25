import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAccountUsage, createOAuthLogin } from "./account-usage.js";
import { setLanguage } from "./i18n.js";

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

describe("account usage section", () => {
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

  function createUsage(ws = new MockWsClient()) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const usage = createAccountUsage({ root, wsClient: ws });
    return { usage, ws, root };
  }

  /** Trigger refresh() and answer the get_usage request. */
  async function load(ctx, data, opts = {}) {
    const pending = ctx.usage.refresh();
    await tick();
    expect(ctx.ws.sent[ctx.ws.sent.length - 1].type).toBe("get_usage");
    ctx.ws.respond(data, opts);
    await pending;
    await tick();
  }

  const text = (ctx) => ctx.root.textContent;

  test("provider → account → limit nesting renders as titled groups and rows", async () => {
    const ctx = createUsage();
    await load(ctx, {
      usage: {
        providers: [
          {
            name: "anthropic",
            accounts: [{ email: "pro@example.com", limits: { requests: 100, used: 42 } }],
          },
        ],
      },
    });

    expect(text(ctx)).toContain("anthropic");
    expect(text(ctx)).toContain("pro@example.com");
    expect(text(ctx)).toContain("requests");
    expect(text(ctx)).toContain("100");
    expect(text(ctx)).toContain("42");
    // The limits collection became a labeled subgroup, not a JSON dump.
    expect(ctx.root.querySelectorAll(".account-usage-group-title").length).toBeGreaterThanOrEqual(
      3,
    );
    expect(ctx.root.querySelector(".account-usage-pre")).toBeNull();
  });

  test("unknown shapes render as generic key/value rows", async () => {
    const ctx = createUsage();
    await load(ctx, { usage: { plan: "pro", renewals: 3, flags: { beta: true } } });

    expect(text(ctx)).toContain("plan");
    expect(text(ctx)).toContain("pro");
    expect(text(ctx)).toContain("flags");
    expect(text(ctx)).toContain("beta");
  });

  test("unwieldy branches fall back to a pretty-printed <pre>", async () => {
    const ctx = createUsage();
    const big = Array.from({ length: 30 }, (_, i) => ({ i, v: `x${i}` }));
    await load(ctx, { usage: { items: big } });

    const pre = ctx.root.querySelector(".account-usage-pre");
    expect(pre).toBeTruthy();
    expect(pre.textContent).toContain('"x5"');
  });

  test("empty payload renders the empty note", async () => {
    const ctx = createUsage();
    await load(ctx, { usage: {} });
    expect(text(ctx)).toContain("No usage data available");
  });

  test("errors surface the server error; auth errors add the providers hint", async () => {
    const ctx = createUsage();
    await load(ctx, undefined, { success: false, error: "unauthorized: missing token" });

    expect(text(ctx)).toContain("Failed to load account usage");
    expect(text(ctx)).toContain("unauthorized: missing token");
    expect(text(ctx)).toContain("log in on the Providers page");

    await load(ctx, undefined, { success: false, error: "disk on fire" });
    expect(text(ctx)).not.toContain("log in on the Providers page");
  });

  test("the refresh button re-requests get_usage", async () => {
    const ctx = createUsage();
    await load(ctx, { usage: { plan: "pro" } });
    const sendsBefore = ctx.ws.sent.length;

    ctx.root.querySelector(".account-usage-refresh").click();
    await tick();
    expect(ctx.ws.sent[ctx.ws.sent.length - 1].type).toBe("get_usage");
    ctx.ws.respond({ usage: { plan: "max" } });
    await tick();
    expect(text(ctx)).toContain("max");
    expect(ctx.ws.sent.length).toBe(sendsBefore + 1);
  });

  test("labels re-render on language change", async () => {
    const ctx = createUsage();
    await load(ctx, { usage: { plan: "pro" } });

    setLanguage("zh-CN");
    expect(ctx.root.querySelector(".settings-section-title").textContent).toBe("账户用量");
    setLanguage("en");
  });

  // ── F7: frontend timeouts outlive the server windows ────────────────────

  test("F7: usage refresh keeps waiting through the 45s server CLI window", async () => {
    vi.useFakeTimers();
    const ctx = createUsage();
    const pending = ctx.usage.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.ws.sent[ctx.ws.sent.length - 1].type).toBe("get_usage");

    // 45s: the old 15s frontend timer would have given up long before the
    // server's CLI allowance even expired.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(ctx.root.textContent).toContain("Loading");

    // A reply landing after the server window closed is still honored —
    // the frontend window is 60s (server 45s + headroom).
    ctx.ws.respond({ usage: { plan: "pro" } });
    await pending;
    expect(ctx.root.textContent).toContain("pro");
    expect(ctx.root.textContent).not.toContain("Failed to load account usage");
  });

  test("F7: usage refresh gives up at 60s and shows the error state", async () => {
    vi.useFakeTimers();
    const ctx = createUsage();
    const pending = ctx.usage.refresh();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(ctx.root.textContent).toContain("Loading");
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(ctx.root.textContent).toContain("Failed to load account usage");
    expect(ctx.root.textContent).toContain("timeout");
  });
});

describe("oauth login row", () => {
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

  function createOauth(ws = new MockWsClient(), deps = {}) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const reloadApiKeys = vi.fn();
    const oauth = createOAuthLogin({ root, wsClient: ws, reloadApiKeys, ...deps });
    return { oauth, ws, root, reloadApiKeys };
  }

  const lastSent = (ctx) => ctx.ws.sent[ctx.ws.sent.length - 1];

  test("invalid provider names are rejected client-side without sending", async () => {
    const ctx = createOauth();
    const input = ctx.root.querySelector(".oauth-login-input");
    input.value = "not a provider!";
    ctx.root.querySelector(".oauth-login-btn").click();
    await tick();

    expect(ctx.root.textContent).toContain("letters, digits");
    expect(ctx.ws.sent).toHaveLength(0);
  });

  test("valid provider sends run_omp_login and shows the browser hint while pending", async () => {
    const ctx = createOauth();
    const input = ctx.root.querySelector(".oauth-login-input");
    input.value = "anthropic";
    ctx.root.querySelector(".oauth-login-btn").click();
    await tick();

    expect(lastSent(ctx)).toEqual({ type: "run_omp_login", provider: "anthropic" });
    expect(ctx.root.querySelector(".oauth-login-status").classList.contains("hidden")).toBe(false);
    expect(ctx.root.querySelector(".settings-btn-spinner").classList.contains("hidden")).toBe(
      false,
    );
    expect(ctx.root.textContent).toContain("Opened in your browser");
    expect(ctx.root.querySelector(".oauth-login-btn").disabled).toBe(true);

    ctx.ws.respond({ exitCode: 0 });
    await tick();
    expect(ctx.root.textContent).toContain("Login complete");
    expect(ctx.reloadApiKeys).toHaveBeenCalledTimes(1);
    expect(ctx.root.querySelector(".oauth-login-btn").disabled).toBe(false);
  });

  test("failure shows the output tail plus the terminal escape hatch", async () => {
    const ctx = createOauth();
    const input = ctx.root.querySelector(".oauth-login-input");
    input.value = "anthropic";
    ctx.root.querySelector(".oauth-login-btn").click();
    await tick();

    ctx.ws.respond({ exitCode: 1, output: `${"x".repeat(2500)}oauth flow failed` });
    await tick();

    const output = ctx.root.querySelector(".oauth-login-output");
    expect(output.classList.contains("hidden")).toBe(false);
    expect(output.textContent.length).toBeLessThanOrEqual(2000); // tail only
    expect(output.textContent).toContain("oauth flow failed");
    expect(ctx.root.querySelector(".oauth-login-advice").textContent).toContain(
      "omp login anthropic",
    );
    expect(ctx.reloadApiKeys).not.toHaveBeenCalled();
  });

  test("transport-level errors also land in the failure path", async () => {
    const ctx = createOauth();
    const input = ctx.root.querySelector(".oauth-login-input");
    input.value = "openai-codex";
    ctx.root.querySelector(".oauth-login-btn").click();
    await tick();

    ctx.ws.respond(undefined, { success: false, error: "browser launch blocked" });
    await tick();

    expect(ctx.root.querySelector(".oauth-login-output").textContent).toContain(
      "browser launch blocked",
    );
    expect(ctx.root.querySelector(".oauth-login-advice").textContent).toContain(
      "omp login openai-codex",
    );
  });

  test("Enter in the provider input starts the login", async () => {
    const ctx = createOauth();
    const input = ctx.root.querySelector(".oauth-login-input");
    input.value = "anthropic";
    input.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await tick();
    expect(lastSent(ctx)).toEqual({ type: "run_omp_login", provider: "anthropic" });
    ctx.ws.respond({ exitCode: 0 });
    await tick();
  });

  // ── F7: the oauth frontend window is the server window + headroom ──────

  test("F7: oauth keeps waiting through the full 5-minute server window", async () => {
    vi.useFakeTimers();
    const ctx = createOauth();
    const input = ctx.root.querySelector(".oauth-login-input");
    input.value = "anthropic";
    ctx.root.querySelector(".oauth-login-btn").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastSent(ctx)).toEqual({ type: "run_omp_login", provider: "anthropic" });

    // Exactly 5 minutes: the OLD frontend timer (== the server window) would
    // have fired here and masked the real outcome with a bare "timeout".
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(ctx.root.querySelector(".oauth-login-btn").disabled).toBe(true);
    expect(ctx.root.textContent).not.toContain("Login failed");

    // The server's own (diagnostic-rich) result still lands.
    ctx.ws.respond({ exitCode: 1, output: "device flow expired" });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.root.textContent).toContain("Login failed");
    expect(ctx.root.querySelector(".oauth-login-output").textContent).toContain(
      "device flow expired",
    );
    expect(ctx.reloadApiKeys).not.toHaveBeenCalled();
  });
});
