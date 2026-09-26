import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setLanguage } from "./i18n.js";
import { createModelsReasoning } from "./models-reasoning.js";

const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");

const MODELS = [
  { id: "claude-opus-4-20250514", provider: "anthropic", contextWindow: 200000 },
  { id: "claude-sonnet-4-20250514", provider: "anthropic", contextWindow: 200000 },
  { id: "gpt-5", provider: "openai", contextWindow: 128000 },
];

const CONFIG = {
  roles: [
    { id: "default", current: "claude-opus-4-20250514" },
    { id: "advisor", current: "custom-local-model" }, // not in available models → flagged
  ],
  roleIdsKnownOnly: false,
  defaultThinkingLevel: "high",
  thinkingLevelOptions: ["auto", "off", "low", "high"],
  taskAgents: [
    {
      name: "explorer",
      source: "user",
      path: "~/.omp/agent/agents/explorer.md",
      description: "Fast codebase scout",
      definitionModel: "claude-sonnet-4-20250514",
      definitionThinkingLevel: "low",
      overrideModel: "gpt-5",
      disabled: false,
    },
    {
      name: "broken",
      source: "project",
      path: ".omp/agents/broken.md",
      description: "",
      definitionModel: null,
      definitionThinkingLevel: null,
      overrideModel: null,
      disabled: true,
      parseError: "unexpected token at line 3",
    },
  ],
  available: true,
};

class MockWsClient extends EventTarget {
  constructor() {
    super();
    this.sent = [];
  }

  send(data) {
    const requestId = `req-${this.sent.length + 1}`;
    this.sent.push({ ...data, requestId });
    return requestId;
  }

  /** Answer the most recent request of the given command type. */
  respondTo(type, data, { success = true, error = undefined } = {}) {
    const entry = [...this.sent].reverse().find((m) => m.type === type);
    if (!entry) throw new Error(`no pending ${type} request`);
    this.dispatchEvent(
      new CustomEvent("commandResponse", {
        detail: { requestId: entry.requestId, success, data, error },
      }),
    );
  }

  lastCommand() {
    const last = this.sent[this.sent.length - 1];
    if (!last) return null;
    const { requestId: _requestId, ...command } = last;
    return command;
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const change = (dom) => new dom.window.Event("change", { bubbles: true });

describe("models & reasoning page", () => {
  let dom;
  const instances = [];

  beforeEach(() => {
    dom = new JSDOM(html, { url: "http://localhost/" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    setLanguage("en");
  });

  afterEach(() => {
    for (const mr of instances.splice(0)) mr.destroy();
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
  });

  function setup() {
    const ws = new MockWsClient();
    const mr = createModelsReasoning({
      root: document.getElementById("models-reasoning-root"),
      wsClient: ws,
    });
    instances.push(mr);
    return { mr, ws };
  }

  /** Run refresh() and answer both contract fetches. */
  async function loadPage(ctx, { config = CONFIG, models = MODELS } = {}) {
    const pending = ctx.mr.refresh();
    await tick();
    ctx.ws.respondTo("get_model_configuration", config);
    ctx.ws.respondTo("get_available_models", { models });
    await pending;
    await tick();
  }

  /** Answer the refetch that follows a successful mutation. */
  async function respondRefetch(ctx, config = CONFIG, models = MODELS) {
    await tick();
    ctx.ws.respondTo("get_model_configuration", config);
    ctx.ws.respondTo("get_available_models", { models });
    await tick();
    await tick();
  }

  const $ = (sel) => document.querySelector(`#models-reasoning-root ${sel}`);
  const $$ = (sel) => Array.from(document.querySelectorAll(`#models-reasoning-root ${sel}`));

  test("renders main session, roles and task agents from the configuration contract", async () => {
    const ctx = setup();
    await loadPage(ctx);

    // Main session: default model + thinking depth, hint line.
    expect($('[data-mr-row="default-model"] select').value).toBe("claude-opus-4-20250514");
    expect($('[data-mr-row="default-thinking"] select').value).toBe("high");
    expect($('[data-mr-row="default-thinking"] select').textContent).toContain("Auto");
    expect($(".mr-hint").textContent).toContain("composer depth menu");

    // Roles: one row per entry; advisor gets its hint; unknown selector flagged.
    const roleRows = $$("[data-mr-row^='role:']");
    expect(roleRows).toHaveLength(2);
    const advisor = $('[data-mr-row="role:advisor"]');
    expect(advisor.textContent).toContain("advisor model");
    const advisorSelect = advisor.querySelector("select");
    expect(advisorSelect.value).toBe("custom-local-model");
    expect(
      Array.from(advisorSelect.options).some((option) =>
        option.textContent.includes("not in available list"),
      ),
    ).toBe(true);
    expect(advisor.querySelector(".mr-clear")).toBeTruthy();

    // Task agents: name, source badge, override, definition chips, toggle.
    expect($$("[data-mr-row^='agent:']")).toHaveLength(2);
    const explorer = $('[data-mr-row="agent:explorer"]');
    expect(explorer.querySelector(".mr-agent-name").textContent).toBe("explorer");
    expect(explorer.querySelector(".mr-badge").textContent).toBe("user");
    expect(explorer.querySelector(".mr-override select").value).toBe("gpt-5");
    expect(explorer.querySelector(".settings-toggle").classList.contains("on")).toBe(true);
    expect(explorer.textContent).toContain("from definition file");
    expect(explorer.textContent).toContain("claude-sonnet-4-20250514");

    // Disabled agent: off toggle + Disabled badge.
    const broken = $('[data-mr-row="agent:broken"]');
    expect(broken.querySelector(".settings-toggle").classList.contains("on")).toBe(false);
    expect(broken.textContent).toContain("Disabled");

    // Footnote at the section bottom.
    expect($(".mr-footnote").textContent).toContain("settings overrides");
  });

  test("default model and thinking depth save via RPC, then refetch", async () => {
    const ctx = setup();
    await loadPage(ctx);

    const modelSelect = $('[data-mr-row="default-model"] select');
    modelSelect.value = "gpt-5";
    modelSelect.dispatchEvent(change(dom));
    await tick();

    expect(ctx.ws.lastCommand()).toEqual({
      type: "set_model_role",
      role: "default",
      selector: "gpt-5",
    });
    expect($('[data-mr-status="default-model"]').textContent).toBe("Saving…");

    ctx.ws.respondTo("set_model_role", { ok: true });
    await respondRefetch(ctx, {
      ...CONFIG,
      roles: [{ id: "default", current: "gpt-5" }, CONFIG.roles[1]],
    });

    // The refetch re-rendered the page; the new value stuck and the status
    // survived the rebuild.
    expect($('[data-mr-row="default-model"] select').value).toBe("gpt-5");
    expect($('[data-mr-status="default-model"]').textContent).toBe("Saved");

    const thinkingSelect = $('[data-mr-row="default-thinking"] select');
    thinkingSelect.value = "auto";
    thinkingSelect.dispatchEvent(change(dom));
    await tick();

    expect(ctx.ws.lastCommand()).toEqual({ type: "set_default_thinking_level", level: "auto" });
    ctx.ws.respondTo("set_default_thinking_level", { ok: true });
    await respondRefetch(ctx);
  });

  test("role rows set and clear; server errors surface verbatim", async () => {
    const ctx = setup();
    await loadPage(ctx);

    const advisorSelect = $('[data-mr-row="role:advisor"] select');
    advisorSelect.value = "gpt-5";
    advisorSelect.dispatchEvent(change(dom));
    await tick();

    expect(ctx.ws.lastCommand()).toEqual({
      type: "set_model_role",
      role: "advisor",
      selector: "gpt-5",
    });
    ctx.ws.respondTo("set_model_role", { ok: true });
    await respondRefetch(ctx);

    // Clear ✕ sends a null selector.
    $('[data-mr-row="role:advisor"] .mr-clear').click();
    await tick();

    expect(ctx.ws.lastCommand()).toEqual({
      type: "set_model_role",
      role: "advisor",
      selector: null,
    });
    ctx.ws.respondTo("set_model_role", null, { success: false, error: "role is read-only" });
    await respondRefetch(ctx);

    const status = $('[data-mr-status="role:advisor"]');
    expect(status.textContent).toBe("role is read-only");
    expect(status.dataset.tone).toBe("error");
  });

  test("task-agent override set/clear and the disable toggle revert on failure", async () => {
    const ctx = setup();
    await loadPage(ctx);

    // Clear the override → model: null.
    const overrideSelect = $('[data-mr-row="agent:explorer"] .mr-override select');
    overrideSelect.value = "";
    overrideSelect.dispatchEvent(change(dom));
    await tick();

    expect(ctx.ws.lastCommand()).toEqual({
      type: "set_task_agent_model_override",
      agent: "explorer",
      model: null,
    });
    ctx.ws.respondTo("set_task_agent_model_override", { ok: true });
    await respondRefetch(ctx);
    expect($('[data-mr-status="agent:explorer"]').textContent).toBe("Saved");

    // Disable: optimistic toggle-off, reverted when the server rejects.
    $('[data-mr-row="agent:explorer"] .settings-toggle').click();
    await tick();

    expect(ctx.ws.lastCommand()).toEqual({
      type: "set_task_agent_disabled",
      agent: "explorer",
      disabled: true,
    });
    expect($('[data-mr-row="agent:explorer"] .settings-toggle').classList.contains("on")).toBe(
      false,
    );

    ctx.ws.respondTo("set_task_agent_disabled", null, { success: false, error: "cannot disable" });
    await respondRefetch(ctx);

    expect($('[data-mr-row="agent:explorer"] .settings-toggle').classList.contains("on")).toBe(
      true,
    );
    expect($('[data-mr-status="agent:explorer"]').textContent).toBe("cannot disable");
  });

  test("parseError rows dim with a definition parse hint", async () => {
    const ctx = setup();
    await loadPage(ctx);

    const broken = $('[data-mr-row="agent:broken"]');
    expect(broken.classList.contains("mr-agent-error")).toBe(true);
    expect(broken.textContent).toContain("Definition parse error");
    expect(broken.querySelector(".mr-agent-parse").title).toBe("unexpected token at line 3");
  });

  test("available:false degrades to an unavailable note without sections", async () => {
    const ctx = setup();
    await loadPage(ctx, { config: { ...CONFIG, available: false } });

    expect($(".mr-note").textContent).toBe("Unavailable");
    expect($('[data-mr-row="default-model"]')).toBeNull();
    expect($$("[data-mr-row^='role:']")).toHaveLength(0);
  });

  test("an empty task agent list shows a note instead of cards", async () => {
    const ctx = setup();
    await loadPage(ctx, { config: { ...CONFIG, taskAgents: [] } });

    expect($(".mr-note").textContent).toBe("No task agents");
    expect($$("[data-mr-row^='agent:']")).toHaveLength(0);
    expect($(".mr-footnote").textContent).toContain("settings overrides");
  });

  test("a failed load shows an error line with a working retry", async () => {
    const ctx = setup();
    const pending = ctx.mr.refresh();
    await tick();
    ctx.ws.respondTo("get_model_configuration", null, { success: false, error: "boom" });
    ctx.ws.respondTo("get_available_models", { models: MODELS });
    await pending;
    await tick();

    expect($(".mr-error").textContent).toContain("Failed to load model configuration");
    expect($('[data-mr-row="default-model"]')).toBeNull();

    $(".mr-retry").click();
    await tick();
    ctx.ws.respondTo("get_model_configuration", CONFIG);
    ctx.ws.respondTo("get_available_models", { models: MODELS });
    await tick();
    await tick();

    expect($('[data-mr-row="default-model"]')).toBeTruthy();
    expect($(".mr-error")).toBeNull();
  });

  test("re-renders section labels on language change", async () => {
    const ctx = setup();
    await loadPage(ctx);

    const titles = () => $$(".settings-section-title").map((el) => el.textContent);
    expect(titles()).toEqual(["Main session", "Model roles", "Task agents"]);

    setLanguage("zh-CN");
    expect(titles()).toEqual(["主会话", "模型角色", "任务 Agent"]);
    expect($('[data-mr-row="default-model"] .settings-label').textContent).toBe("默认模型");
    expect($('[data-mr-row="agent:explorer"] .mr-override-label').textContent).toBe("覆盖模型");

    setLanguage("en");
    expect(titles()).toEqual(["Main session", "Model roles", "Task agents"]);
  });
});
