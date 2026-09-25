import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createAgentHub } from "./agent-hub.js";
import { setLanguage } from "./i18n.js";

const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");

const ROSTER = [
  {
    id: "sub-1",
    name: "scout",
    kind: "sub",
    parentId: "main-1",
    status: "exploring files",
    running: true,
    sessionFile: "/ws/.omp/sessions/proj/sub-1.jsonl",
  },
  {
    id: "main-1",
    name: "Main session",
    kind: "main",
    parentId: null,
    status: "idle",
    running: false,
    sessionFile: null,
  },
  {
    id: "sub-2",
    name: "builder",
    kind: "sub",
    parentId: "main-1",
    status: "done",
    running: false,
    sessionFile: "/ws/.omp/sessions/proj/sub-2.jsonl",
  },
];

class MockWsClient extends EventTarget {
  constructor() {
    super();
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
    return `req-${this.sent.length}`;
  }

  /** Answer the most recent command with the given response envelope. */
  respond(data, { success = true, error = undefined } = {}) {
    const requestId = `req-${this.sent.length}`;
    this.dispatchEvent(
      new CustomEvent("commandResponse", { detail: { requestId, success, data, error } }),
    );
  }

  push(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("agent hub panel", () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM(html, { url: "http://localhost/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  });

  function createHub() {
    const ws = new MockWsClient();
    const toggleEl = document.getElementById("agent-hub-toggle");
    const panelEl = document.getElementById("agent-hub");
    const listEl = document.getElementById("agent-hub-list");
    const closeEl = document.getElementById("agent-hub-close");
    const onOpenSession = vi.fn();
    const hub = createAgentHub({ toggleEl, panelEl, listEl, closeEl, wsClient: ws, onOpenSession });
    return { hub, ws, toggleEl, panelEl, listEl, closeEl, onOpenSession };
  }

  /** Trigger refresh(), answer the list_agents request, let renders settle. */
  async function fetchRoster(ctx, data, opts = {}) {
    const pending = ctx.hub.refresh();
    await tick();
    expect(ctx.ws.sent[ctx.ws.sent.length - 1].type).toBe("list_agents");
    ctx.ws.respond(data, opts);
    await pending;
    await tick();
  }

  /** Open the panel and answer its auto-fetch. */
  async function openRostered(ctx, data = { agents: ROSTER, available: true }, opts = {}) {
    ctx.hub.open();
    await tick();
    ctx.ws.respond(data, opts);
    await tick();
  }

  const rows = () => Array.from(document.querySelectorAll("#agent-hub-list .agent-hub-row"));
  const notes = () =>
    Array.from(document.querySelectorAll("#agent-hub-list .agent-hub-note")).map(
      (el) => el.textContent,
    );
  const pressEscape = () =>
    window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  test("toggle stays hidden until a successful fetch reports a non-empty roster", async () => {
    const ctx = createHub();
    expect(ctx.toggleEl.classList.contains("hidden")).toBe(true);

    await fetchRoster(ctx, { agents: [], available: true });
    expect(ctx.toggleEl.classList.contains("hidden")).toBe(true);

    await fetchRoster(ctx, { agents: ROSTER, available: true });
    expect(ctx.toggleEl.classList.contains("hidden")).toBe(false);
  });

  test("open() expands the panel, fetches, and groups running agents first", async () => {
    const ctx = createHub();
    await fetchRoster(ctx, { agents: ROSTER, available: true });
    await openRostered(ctx);

    expect(ctx.panelEl.classList.contains("collapsed")).toBe(false);
    expect(ctx.toggleEl.getAttribute("aria-expanded")).toBe("true");

    const order = rows().map((row) => row.querySelector(".agent-hub-name").textContent);
    expect(order).toEqual(["scout", "Main session", "builder"]);

    const runningRows = document.querySelectorAll("#agent-hub-list .agent-hub-row.running");
    expect(runningRows).toHaveLength(1);
    expect(runningRows[0].querySelector(".agent-hub-name").textContent).toBe("scout");
    expect(document.querySelectorAll("#agent-hub-list .agent-hub-row.finished")).toHaveLength(2);
    expect(document.querySelectorAll("#agent-hub-list .agent-hub-group")).toHaveLength(2);
  });

  test("rows show kind badges, status text, and a transcript affordance only with a session file", async () => {
    const ctx = createHub();
    await fetchRoster(ctx, { agents: ROSTER, available: true });
    await openRostered(ctx);

    const [runningRow, mainRow, finishedSub] = rows();
    expect(runningRow.querySelector(".agent-hub-kind").textContent).toBe("Sub");
    expect(runningRow.querySelector(".agent-hub-status").textContent).toBe("exploring files");
    expect(runningRow.querySelector(".agent-hub-open")).toBeTruthy();
    expect(mainRow.querySelector(".agent-hub-kind").textContent).toBe("Main");
    expect(mainRow.querySelector(".agent-hub-open")).toBeNull();
    expect(finishedSub.querySelector(".agent-hub-open")).toBeTruthy();
  });

  test("view transcript routes the session file through the existing selection flow", async () => {
    const ctx = createHub();
    await fetchRoster(ctx, { agents: ROSTER, available: true });
    await openRostered(ctx);

    rows()[0].querySelector(".agent-hub-open").click();
    expect(ctx.onOpenSession).toHaveBeenCalledWith(ROSTER[0].sessionFile);
  });

  test("available:false shows the unavailable note while open and hides the toggle once closed", async () => {
    const ctx = createHub();
    await openRostered(ctx, { agents: [], available: false });

    expect(notes()).toEqual(["Feature unavailable"]);
    // While open the toggle stays visible so the panel can still be closed.
    expect(ctx.toggleEl.classList.contains("hidden")).toBe(false);
    ctx.hub.close();
    expect(ctx.toggleEl.classList.contains("hidden")).toBe(true);
  });

  test("a failed refetch shows the error note and keeps the roster discoverable", async () => {
    const ctx = createHub();
    await fetchRoster(ctx, { agents: ROSTER, available: true });
    await openRostered(ctx);

    await fetchRoster(ctx, undefined, { success: false, error: "boom" });

    expect(notes()).toEqual(["Failed to load agents"]);
  });

  test("close button and Esc collapse the panel", async () => {
    const ctx = createHub();
    await fetchRoster(ctx, { agents: ROSTER, available: true });
    await openRostered(ctx);

    ctx.closeEl.click();
    expect(ctx.panelEl.classList.contains("collapsed")).toBe(true);
    expect(ctx.toggleEl.getAttribute("aria-expanded")).toBe("false");

    await openRostered(ctx);
    pressEscape();
    expect(ctx.panelEl.classList.contains("collapsed")).toBe(true);
  });

  test("Esc does not close the panel while settings is open", async () => {
    const ctx = createHub();
    await fetchRoster(ctx, { agents: ROSTER, available: true });
    await openRostered(ctx);

    document.getElementById("settings-panel").classList.remove("hidden");
    pressEscape();
    expect(ctx.panelEl.classList.contains("collapsed")).toBe(false);

    document.getElementById("settings-panel").classList.add("hidden");
    pressEscape();
    expect(ctx.panelEl.classList.contains("collapsed")).toBe(true);
  });

  test("the agents_changed push refetches; unrelated rpcEvents do not", async () => {
    const ctx = createHub();
    await fetchRoster(ctx, { agents: ROSTER, available: true });
    const sends = ctx.ws.sent.length;

    ctx.ws.push("rpcEvent", { type: "agents_changed" });
    await tick();
    expect(ctx.ws.sent.length).toBe(sends + 1);
    ctx.ws.respond({ agents: ROSTER, available: true });
    await tick();

    ctx.ws.push("rpcEvent", { type: "state_changed" });
    await tick();
    expect(ctx.ws.sent.length).toBe(sends + 1);
  });

  test("polls every 10s while open and stops when closed", async () => {
    vi.useFakeTimers();
    try {
      const ctx = createHub();
      ctx.hub.open();
      await vi.advanceTimersByTimeAsync(0);
      ctx.ws.respond({ agents: ROSTER, available: true });
      await vi.advanceTimersByTimeAsync(0);
      const sends = ctx.ws.sent.length;

      await vi.advanceTimersByTimeAsync(10000);
      expect(ctx.ws.sent.length).toBe(sends + 1);
      ctx.ws.respond({ agents: ROSTER, available: true });
      await vi.advanceTimersByTimeAsync(0);

      ctx.hub.close();
      await vi.advanceTimersByTimeAsync(60000);
      expect(ctx.ws.sent.length).toBe(sends + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("re-renders roster labels on language change", async () => {
    const ctx = createHub();
    await fetchRoster(ctx, { agents: ROSTER, available: true });
    await openRostered(ctx);

    setLanguage("zh-CN");
    const groups = Array.from(document.querySelectorAll("#agent-hub-list .agent-hub-group")).map(
      (el) => el.textContent,
    );
    expect(groups).toEqual(["运行中", "已完成"]);
    expect(rows()[0].querySelector(".agent-hub-kind").textContent).toBe("子智能体");
    expect(rows()[0].querySelector(".agent-hub-open").textContent).toBe("查看记录");
    setLanguage("en");
  });

  test("destroy() detaches listeners and stops polling", async () => {
    vi.useFakeTimers();
    try {
      const ctx = createHub();
      ctx.hub.open();
      await vi.advanceTimersByTimeAsync(0);
      ctx.ws.respond({ agents: ROSTER, available: true });
      await vi.advanceTimersByTimeAsync(0);

      ctx.hub.destroy();
      const sends = ctx.ws.sent.length;
      await vi.advanceTimersByTimeAsync(60000);
      ctx.ws.push("rpcEvent", { type: "agents_changed" });
      await vi.advanceTimersByTimeAsync(0);
      expect(ctx.ws.sent.length).toBe(sends);
    } finally {
      vi.useRealTimers();
    }
  });
});
