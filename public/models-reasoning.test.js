import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setLanguage } from "./i18n.js";
import {
  createModelsReasoning,
  isModelSelectorAvailable,
  normalizeModelSelector,
  UNAVAILABLE_RETRY_MS,
} from "./models-reasoning.js";

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

// ── Pure selector-normalization table (no DOM needed) ──────────────────────

describe("normalizeModelSelector", () => {
  const roles = new Map([
    ["smol", "zai/glm-5.3:high"],
    ["via-role", "@smol"],
    ["bare", "gpt-5"],
    ["unset", null],
    ["loop-a", "@loop-b"],
    ["loop-b", "@loop-a"],
  ]);

  test("strips a trailing :effort suffix when the prefix stays non-empty", () => {
    expect(normalizeModelSelector("zai/glm-5.3:high")).toBe("zai/glm-5.3");
    expect(normalizeModelSelector("gpt-5:off")).toBe("gpt-5");
    expect(normalizeModelSelector("gpt-5:inherit")).toBe("gpt-5");
    expect(normalizeModelSelector("glm-5.3:MAX")).toBe("glm-5.3"); // case-insensitive suffix
    // Not an effort word / empty prefix → untouched.
    expect(normalizeModelSelector("gpt-5:blue")).toBe("gpt-5:blue");
    expect(normalizeModelSelector(":high")).toBe(":high");
    // Only ONE trailing suffix is stripped per string.
    expect(normalizeModelSelector("gpt-5:high:xhigh")).toBe("gpt-5:high");
  });

  test("resolves @role refs one level through the roles table, stripping again", () => {
    expect(normalizeModelSelector("@smol", roles)).toBe("zai/glm-5.3");
    expect(normalizeModelSelector("@bare", roles)).toBe("gpt-5");
  });

  test("nested @role chains resolve; cycles and unset roles stay flagged", () => {
    // @via-role → "@smol" → "zai/glm-5.3:high" → "zai/glm-5.3"
    expect(normalizeModelSelector("@via-role", roles)).toBe("zai/glm-5.3");
    // Unset / unknown role refs return the raw ref (cannot match any id).
    expect(normalizeModelSelector("@unset", roles)).toBe("@unset");
    expect(normalizeModelSelector("@missing", roles)).toBe("@missing");
    // Cycle guard: stops on the revisited ref instead of looping forever.
    expect(normalizeModelSelector("@loop-a", roles)).toBe("@loop-a");
  });

  test("trims and passes plain ids through", () => {
    expect(normalizeModelSelector("  gpt-5  ")).toBe("gpt-5");
    expect(normalizeModelSelector("")).toBe("");
    expect(normalizeModelSelector(null)).toBe("");
    expect(normalizeModelSelector("claude-opus-4-20250514")).toBe("claude-opus-4-20250514");
  });
});

describe("isModelSelectorAvailable", () => {
  const roles = new Map([
    ["smol", "zai/glm-5.3:high"],
    ["unset", null],
  ]);
  const list = [
    { id: "glm-5.3", provider: "zai", contextWindow: 128000 }, // bare id + provider field
    { id: "gpt-5", provider: "openai", contextWindow: 128000 },
    { id: "openrouter/anthropic/claude-sonnet-4" }, // provider-prefixed id shape
  ];

  test("matches exact, case-insensitive, effort-suffixed and role-ref selectors", () => {
    expect(isModelSelectorAvailable("gpt-5", list)).toBe(true);
    expect(isModelSelectorAvailable("GPT-5", list)).toBe(true);
    expect(isModelSelectorAvailable("zai/glm-5.3:high", list)).toBe(true);
    expect(isModelSelectorAvailable("@smol", list, roles)).toBe(true);
    expect(isModelSelectorAvailable("openrouter/anthropic/claude-sonnet-4", list)).toBe(true);
  });

  test("matches provider-prefixed selector vs bare id and the reverse", () => {
    // Selector carries the provider prefix, available id is bare.
    expect(isModelSelectorAvailable("zai/glm-5.3", list)).toBe(true);
    // Bare selector vs provider-prefixed id (last segment).
    expect(isModelSelectorAvailable("claude-sonnet-4", list)).toBe(true);
    // provider/id exact composite also matches.
    expect(isModelSelectorAvailable("zai/glm-5.3", [{ id: "glm-5.3", provider: "zai" }])).toBe(
      true,
    );
  });

  test("flags only genuinely-absent base ids", () => {
    expect(isModelSelectorAvailable("custom-local-model", list)).toBe(false);
    expect(isModelSelectorAvailable("custom/local:high", list)).toBe(false);
    // Unresolved role ref → raw "@unset" cannot match → flagged.
    expect(isModelSelectorAvailable("@unset", list, roles)).toBe(false);
    expect(isModelSelectorAvailable("@missing", list, roles)).toBe(false);
    // Different provider with same last segment: both-prefixed needs exact.
    expect(isModelSelectorAvailable("other/glm-5.3", [{ id: "zai/glm-5.3" }])).toBe(false);
    // Nothing stored → nothing to flag.
    expect(isModelSelectorAvailable("", list)).toBe(true);
    expect(isModelSelectorAvailable(null, list)).toBe(true);
  });
});

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
    vi.useRealTimers();
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

  test("effort-suffixed and @role selectors render unflagged; only genuinely-absent ids are flagged", async () => {
    const ctx = setup();
    await loadPage(ctx, {
      config: {
        ...CONFIG,
        roles: [
          { id: "default", current: "zai/glm-5.3:high" }, // effort suffix, base id available
          { id: "smol", current: "gpt-5" },
          { id: "plan", current: "@smol" }, // role ref → resolves to gpt-5
          { id: "vision", current: "@unset-role" }, // unresolved role ref → flagged
          { id: "advisor", current: "custom-local-model" }, // genuinely absent → flagged
        ],
        taskAgents: [
          {
            ...CONFIG.taskAgents[0],
            overrideModel: "glm-5.3:low", // bare-selector form of an available id
          },
        ],
      },
      models: [
        { id: "glm-5.3", provider: "zai", contextWindow: 128000 },
        { id: "gpt-5", provider: "openai", contextWindow: 128000 },
      ],
    });

    const optionTexts = (rowKey) =>
      Array.from($(`[data-mr-row="${rowKey}"] select`).options).map((o) => o.textContent);

    // Effort suffix: raw selector stays selected and visible, unflagged.
    expect($('[data-mr-row="default-model"] select').value).toBe("zai/glm-5.3:high");
    expect(
      optionTexts("default-model").some((text) => text.includes("not in available list")),
    ).toBe(false);

    // @smol resolves to gpt-5 → unflagged extra option.
    expect($('[data-mr-row="role:plan"] select').value).toBe("@smol");
    expect(optionTexts("role:plan").some((text) => text.includes("not in available list"))).toBe(
      false,
    );

    // Unresolved role ref and genuinely-absent id stay flagged.
    expect(optionTexts("role:vision").some((text) => text.includes("not in available list"))).toBe(
      true,
    );
    expect(optionTexts("role:advisor").some((text) => text.includes("not in available list"))).toBe(
      true,
    );

    // Task-agent override in bare form still matches the available id → unflagged.
    expect($('[data-mr-row="agent:explorer"] .mr-override select').value).toBe("glm-5.3:low");
    expect(
      Array.from($('[data-mr-row="agent:explorer"] .mr-override select').options).some((o) =>
        o.textContent.includes("not in available list"),
      ),
    ).toBe(false);
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

  test("available:false schedules a silent retry; a later good load replaces the note", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const configFetches = () =>
      ctx.ws.sent.filter((m) => m.type === "get_model_configuration").length;

    const pending = ctx.mr.refresh();
    await vi.advanceTimersByTimeAsync(0);
    ctx.ws.respondTo("get_model_configuration", { ...CONFIG, available: false });
    ctx.ws.respondTo("get_available_models", { models: MODELS });
    await pending;
    await vi.advanceTimersByTimeAsync(0);

    expect($(".mr-note").textContent).toBe("Unavailable");
    expect(configFetches()).toBe(1);

    // +5s: exactly one silent re-fetch, answered with a healthy payload.
    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MS);
    expect(configFetches()).toBe(2);
    ctx.ws.respondTo("get_model_configuration", CONFIG);
    ctx.ws.respondTo("get_available_models", { models: MODELS });
    await vi.advanceTimersByTimeAsync(0);

    // The note is replaced by the regular content path…
    expect($(".mr-note")).toBeNull();
    expect($('[data-mr-row="default-model"] select').value).toBe("claude-opus-4-20250514");

    // …and no further retries fire once content is up.
    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MS * 4);
    expect(configFetches()).toBe(2);
  });

  test("available:false silent retries are capped at three per page-open", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const configFetches = () =>
      ctx.ws.sent.filter((m) => m.type === "get_model_configuration").length;

    const pending = ctx.mr.refresh();
    await vi.advanceTimersByTimeAsync(0);
    ctx.ws.respondTo("get_model_configuration", { ...CONFIG, available: false });
    ctx.ws.respondTo("get_available_models", { models: MODELS });
    await pending;
    expect(configFetches()).toBe(1);

    for (let expected = 2; expected <= 4; expected++) {
      await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MS);
      expect(configFetches()).toBe(expected);
      ctx.ws.respondTo("get_model_configuration", { ...CONFIG, available: false });
      ctx.ws.respondTo("get_available_models", { models: MODELS });
      await vi.advanceTimersByTimeAsync(0);
    }

    // Budget spent: the note stays and nothing else is sent.
    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MS * 4);
    expect(configFetches()).toBe(4);
    expect($(".mr-note").textContent).toBe("Unavailable");
  });

  test("destroy() cancels a pending silent retry", async () => {
    vi.useFakeTimers();
    const ctx = setup();
    const pending = ctx.mr.refresh();
    await vi.advanceTimersByTimeAsync(0);
    ctx.ws.respondTo("get_model_configuration", { ...CONFIG, available: false });
    ctx.ws.respondTo("get_available_models", { models: MODELS });
    await pending;

    ctx.mr.destroy();
    await vi.advanceTimersByTimeAsync(UNAVAILABLE_RETRY_MS * 4);
    expect(ctx.ws.sent.filter((m) => m.type === "get_model_configuration")).toHaveLength(1);
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
