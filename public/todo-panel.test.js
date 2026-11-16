import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setLanguage } from "./i18n.js";
import { createTodoPanel } from "./todo-panel.js";

class MockWsClient extends EventTarget {
  constructor() {
    super();
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
    return `req-${this.sent.length}`;
  }

  /** Answer the most recent request with `data` (or an error envelope). */
  respond(data, { success = true, error = undefined } = {}) {
    const requestId = `req-${this.sent.length}`;
    this.dispatchEvent(
      new CustomEvent("commandResponse", { detail: { requestId, success, data, error } }),
    );
  }
}

const PHASES = [
  {
    name: "Audit",
    tasks: [
      { content: "Triage notes", status: "completed" },
      { content: "Map findings", status: "in_progress" },
      { content: "Write report", status: "pending", details: "with evidence" },
    ],
  },
];

describe("todo panel", () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
  });

  afterEach(() => {
    setLanguage("en");
    vi.restoreAllMocks();
    vi.useRealTimers();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  });

  function createPanel(ws = new MockWsClient(), options = {}) {
    const toggleEl = document.createElement("button");
    toggleEl.innerHTML = '<span class="todo-count hidden"></span>';
    const panelEl = document.createElement("div");
    panelEl.classList.add("hidden");
    document.body.append(toggleEl, panelEl);
    const panel = createTodoPanel({ wsClient: ws, toggleEl, panelEl, ...options });
    return { panel, ws, toggleEl, panelEl };
  }

  const pointerdown = (el) =>
    el.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));

  test("refresh asks for the shown session's file and renders phases with status glyphs", async () => {
    const ctx = createPanel(new MockWsClient(), { getSessionFile: () => "C:/s/b.jsonl" });
    const pending = ctx.panel.refresh();
    expect(ctx.ws.sent[0]).toEqual({ type: "get_todos", sessionPath: "C:/s/b.jsonl" });
    ctx.ws.respond({ phases: PHASES });
    await pending;

    expect(ctx.panelEl.querySelector(".todo-phase-name").textContent).toBe("Audit");
    const tasks = [...ctx.panelEl.querySelectorAll(".todo-task")];
    expect(tasks).toHaveLength(3);
    expect(tasks[0].querySelector(".todo-task-glyph").textContent).toBe("✓");
    expect(tasks[1].querySelector(".todo-task-glyph").textContent).toBe("▶");
    expect(tasks[2].querySelector(".todo-task-glyph").textContent).toBe("○");
    expect(tasks[2].querySelector(".todo-task-content").textContent).toBe("Write report");
    expect(tasks[2].querySelector(".todo-task-details").textContent).toBe("with evidence");
  });

  test("badge counts open tasks and hides when there are none", async () => {
    const ctx = createPanel();
    const pending = ctx.panel.refresh();
    ctx.ws.respond({ phases: PHASES });
    await pending;
    const badge = ctx.toggleEl.querySelector(".todo-count");
    expect(badge.classList.contains("hidden")).toBe(false);
    expect(badge.textContent).toBe("2"); // in_progress + pending

    const done = ctx.panel.refresh();
    ctx.ws.respond({
      phases: [{ name: "P", tasks: [{ content: "x", status: "completed" }] }],
    });
    await done;
    expect(badge.classList.contains("hidden")).toBe(true);
  });

  test("an empty or never-todo session renders the empty state", async () => {
    const ctx = createPanel();
    const pending = ctx.panel.refresh();
    ctx.ws.respond({ phases: [] });
    await pending;
    expect(ctx.panelEl.querySelector(".context-viz-empty").textContent).toBeTruthy();
    expect(ctx.panelEl.querySelector(".todo-phase")).toBeNull();
  });

  test("unknown statuses render as pending and junk tasks are dropped", async () => {
    const ctx = createPanel();
    const pending = ctx.panel.refresh();
    ctx.ws.respond({
      phases: [
        {
          name: "P",
          tasks: [{ content: "old blocked task", status: "blocked" }, { bogus: true }],
        },
      ],
    });
    await pending;
    const tasks = [...ctx.panelEl.querySelectorAll(".todo-task")];
    expect(tasks).toHaveLength(1);
    expect(tasks[0].querySelector(".todo-task-glyph").textContent).toBe("○");
  });

  test("popover toggles on pointerdown and closes on outside presses", async () => {
    const ctx = createPanel();
    const pending = ctx.panel.refresh();
    ctx.ws.respond({ phases: PHASES });
    await pending;

    pointerdown(ctx.toggleEl);
    expect(ctx.panelEl.classList.contains("hidden")).toBe(false);
    expect(ctx.toggleEl.getAttribute("aria-expanded")).toBe("true");

    // A press outside closes it even when the target's own bubble handler
    // stops propagation — the panel listens in the capture phase, so the
    // context pill's stopPropagation cannot strand it open.
    const outside = document.createElement("div");
    outside.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.appendChild(outside);
    pointerdown(outside);
    expect(ctx.panelEl.classList.contains("hidden")).toBe(true);

    // Presses on the panel itself keep it open.
    pointerdown(ctx.toggleEl);
    pointerdown(ctx.panelEl);
    expect(ctx.panelEl.classList.contains("hidden")).toBe(false);
  });

  test("Enter toggles and Escape closes via the keyboard", async () => {
    const ctx = createPanel();
    const key = (k) =>
      ctx.toggleEl.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true }),
      );
    key("Enter");
    expect(ctx.panelEl.classList.contains("hidden")).toBe(false);
    key("Escape");
    expect(ctx.panelEl.classList.contains("hidden")).toBe(true);
  });

  test("a failed refresh keeps the list already on screen", async () => {
    const ctx = createPanel();
    const first = ctx.panel.refresh();
    ctx.ws.respond({ phases: PHASES });
    await first;
    expect(ctx.panelEl.querySelectorAll(".todo-task")).toHaveLength(3);

    const second = ctx.panel.refresh();
    ctx.ws.respond(null, { success: false, error: "not-connected" });
    await second;
    expect(ctx.panelEl.querySelectorAll(".todo-task")).toHaveLength(3);
  });

  test("clear() resets the panel and badge for a session switch", async () => {
    const ctx = createPanel();
    const pending = ctx.panel.refresh();
    ctx.ws.respond({ phases: PHASES });
    await pending;

    ctx.panel.clear();
    expect(ctx.panelEl.querySelector(".context-viz-empty")).toBeTruthy();
    expect(ctx.toggleEl.querySelector(".todo-count").classList.contains("hidden")).toBe(true);
  });

  test("scheduleRefresh coalesces a burst into one request", async () => {
    vi.useFakeTimers();
    const ctx = createPanel();
    ctx.panel.scheduleRefresh();
    ctx.panel.scheduleRefresh();
    expect(ctx.ws.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(ctx.ws.sent).toHaveLength(1);
    expect(ctx.ws.sent[0].type).toBe("get_todos");
  });

  test("language switch re-renders the labels", async () => {
    const ctx = createPanel();
    const pending = ctx.panel.refresh();
    ctx.ws.respond({ phases: [] });
    await pending;
    const title = () => ctx.panelEl.querySelector(".todo-title span").textContent;
    expect(title()).toBe("Tasks");

    setLanguage("zh-CN");
    expect(title()).toBe("任务");
  });
});
