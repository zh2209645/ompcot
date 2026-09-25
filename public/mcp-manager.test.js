import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setLanguage } from "./i18n.js";
import { createMcpManager } from "./mcp-manager.js";

const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");

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

const SERVERS = [
  {
    name: "docs",
    type: "stdio",
    command: "npx",
    args: ["-y", "docs-mcp"],
    enabled: true,
    source: "user",
    sourcePath: "~/.omp/agent/mcp.json",
    writable: true,
    status: "connected",
    toolCount: 12,
  },
  {
    name: "search",
    type: "http",
    url: "http://127.0.0.1:8123/mcp",
    enabled: false,
    source: "project",
    sourcePath: ".omp/mcp.json",
    writable: true,
    status: "failed",
  },
  {
    name: "locked",
    type: "sse",
    url: "http://example.com/sse",
    enabled: true,
    source: "plugin",
    sourcePath: "plugins/bundle/mcp.json",
    writable: false,
    status: "connected",
  },
];

const LIST_OK = { servers: SERVERS, capabilities: { liveStatus: true, connect: false } };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mcp manager page", () => {
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

  function createManager(ws = new MockWsClient()) {
    const root = document.getElementById("mcp-manager-root");
    const manager = createMcpManager({ root, wsClient: ws });
    return { manager, ws, root };
  }

  /** Trigger refresh() and answer the mcp.list request. */
  async function loadList(ctx, data, opts = {}) {
    const pending = ctx.manager.refresh();
    await tick();
    expect(ctx.ws.sent[ctx.ws.sent.length - 1].type).toBe("mcp.list");
    ctx.ws.respond(data, opts);
    await pending;
    await tick();
  }

  /**
   * Answer a mutation request, then the mcp.list refetch it always triggers.
   * `listData` keeps the follow-up render deterministic.
   */
  async function completeMutation(ctx, listData, mutation = { success: true }) {
    ctx.ws.respond(undefined, mutation);
    await tick();
    ctx.ws.respond(listData);
    await tick();
    await tick();
  }

  const rootEl = () => document.getElementById("mcp-manager-root");
  const cards = () => Array.from(rootEl().querySelectorAll(".mcp-card"));
  const note = () => rootEl().querySelector(".mcp-note")?.textContent;

  function cardOf(name) {
    return cards().find((card) => card.querySelector(".mcp-name").textContent === name);
  }

  /** Form controls in DOM order: name, scope, type, url, command, args, env. */
  function formInputs(form) {
    const inputs = form.querySelectorAll(".mcp-input");
    const [nameInput, scopeSelect, typeSelect, urlInput, commandInput, argsInput, envInput] =
      inputs;
    return { nameInput, scopeSelect, typeSelect, urlInput, commandInput, argsInput, envInput };
  }

  function openForm() {
    rootEl().querySelector(".mcp-add-btn").click();
    const form = rootEl().querySelector(".mcp-form");
    expect(form.classList.contains("hidden")).toBe(false);
    return form;
  }

  function submitForm(form) {
    form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  }

  test("renders server cards with type, source, status and tool count", async () => {
    const ctx = createManager();
    await loadList(ctx, LIST_OK);

    expect(cards()).toHaveLength(3);

    const docs = cardOf("docs");
    expect(docs.querySelector(".mcp-badge.mcp-type").textContent).toBe("stdio");
    const source = docs.querySelector(".mcp-badge.mcp-source");
    expect(source.textContent).toBe("User");
    expect(source.title).toBe("~/.omp/agent/mcp.json");
    expect(docs.querySelector(".mcp-dot").className).toContain("connected");
    expect(docs.textContent).toContain("Status: Connected");
    expect(docs.textContent).toContain("12 tools");

    expect(cardOf("search").querySelector(".mcp-dot").className).toContain("failed");
    expect(cardOf("search").textContent).not.toContain("tools");
  });

  test("writable rows get edit/remove actions; read-only rows show a lock hint", async () => {
    const ctx = createManager();
    await loadList(ctx, LIST_OK);

    const docs = cardOf("docs");
    expect(docs.querySelector(".mcp-card-actions .settings-toggle")).toBeTruthy();
    expect(docs.querySelectorAll(".mcp-card-btn")).toHaveLength(2); // edit + remove

    const locked = cardOf("locked");
    expect(locked.textContent).toContain("Read-only");
    expect(locked.querySelector(".mcp-card-btn")).toBeNull();
  });

  test("enable toggle sends mcp.toggle and refetches the list", async () => {
    const ctx = createManager();
    await loadList(ctx, LIST_OK);
    const sendsBefore = ctx.ws.sent.length;

    cardOf("search").querySelector(".settings-toggle").click();
    await tick();
    expect(ctx.ws.sent[ctx.ws.sent.length - 1]).toEqual({
      type: "mcp.toggle",
      name: "search",
      enabled: true,
    });

    await completeMutation(ctx, LIST_OK);
    expect(ctx.ws.sent[ctx.ws.sent.length - 1].type).toBe("mcp.list");
    expect(ctx.ws.sent.length).toBe(sendsBefore + 2);
  });

  test("mutation errors surface the server error string inline", async () => {
    const ctx = createManager();
    await loadList(ctx, LIST_OK);

    cardOf("search").querySelector(".settings-toggle").click();
    await tick();
    await completeMutation(ctx, LIST_OK, { success: false, error: "config file is read-only" });

    const errorLine = rootEl().querySelector(".mcp-error");
    expect(errorLine.classList.contains("hidden")).toBe(false);
    expect(errorLine.textContent).toBe("config file is read-only");
  });

  test("connect actions follow capabilities.connect and the server status", async () => {
    const ctx = createManager();
    await loadList(ctx, LIST_OK);
    // No connect capability → no connect/disconnect/reconnect buttons at all.
    for (const card of cards()) {
      expect(card.querySelectorAll(".mcp-action-btn")).toHaveLength(0);
    }

    await loadList(ctx, {
      servers: SERVERS,
      capabilities: { liveStatus: true, connect: true },
    });
    const actionLabels = (name) =>
      Array.from(cardOf(name).querySelectorAll(".mcp-action-btn")).map((b) => b.textContent);
    expect(actionLabels("docs")).toEqual(["Disconnect"]);
    expect(actionLabels("search")).toEqual(["Reconnect"]);
    expect(actionLabels("locked")).toEqual(["Disconnect"]);
  });

  test("liveStatus:false shows the banner and renders every status as unknown", async () => {
    const ctx = createManager();
    await loadList(ctx, {
      servers: SERVERS,
      capabilities: { liveStatus: false, connect: false },
    });

    expect(rootEl().querySelector(".mcp-banner").classList.contains("hidden")).toBe(false);
    for (const card of cards()) {
      expect(card.querySelector(".mcp-status-value").textContent).toBe("Unknown");
      expect(card.querySelector(".mcp-dot").className).toContain("unknown");
    }
  });

  test("with liveStatus:true the banner stays hidden", async () => {
    const ctx = createManager();
    await loadList(ctx, { servers: [], capabilities: { liveStatus: true, connect: false } });
    expect(rootEl().querySelector(".mcp-banner").classList.contains("hidden")).toBe(true);
  });

  test("add form builds a stdio save payload from the fields", async () => {
    const ctx = createManager();
    await loadList(ctx, { servers: [], capabilities: { liveStatus: true, connect: false } });

    const form = openForm();
    const { nameInput, commandInput, argsInput, envInput } = formInputs(form);
    nameInput.value = "docs";
    commandInput.value = "npx";
    argsInput.value = "-y\n docs-mcp\n";
    envInput.value = "DOCS_KEY=abc";

    submitForm(form);
    await tick();
    expect(ctx.ws.sent[ctx.ws.sent.length - 1]).toEqual({
      type: "mcp.save",
      name: "docs",
      scope: "user",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "docs-mcp"],
        env: { DOCS_KEY: "abc" },
      },
    });

    await completeMutation(ctx, LIST_OK);
    expect(form.classList.contains("hidden")).toBe(true);
  });

  test("http type swaps the command fields for a URL field", async () => {
    const ctx = createManager();
    await loadList(ctx, { servers: [], capabilities: { liveStatus: true, connect: false } });

    const form = openForm();
    const { nameInput, typeSelect, urlInput } = formInputs(form);
    typeSelect.value = "http";
    typeSelect.dispatchEvent(new dom.window.Event("change", { bubbles: true }));

    const stdioStack = form.querySelectorAll(".mcp-form-grid.mcp-form-stack")[0];
    expect(stdioStack.classList.contains("hidden")).toBe(true);

    nameInput.value = "search";
    urlInput.value = "http://127.0.0.1:8123/mcp";
    submitForm(form);
    await tick();
    expect(ctx.ws.sent[ctx.ws.sent.length - 1]).toEqual({
      type: "mcp.save",
      name: "search",
      scope: "user",
      config: { type: "http", url: "http://127.0.0.1:8123/mcp" },
    });

    await completeMutation(ctx, LIST_OK);
  });

  test("save without a name (or command) shows the inline error and sends nothing", async () => {
    const ctx = createManager();
    await loadList(ctx, { servers: [], capabilities: { liveStatus: true, connect: false } });
    const sendsBefore = ctx.ws.sent.length;

    const form = openForm();
    submitForm(form);
    await tick();

    const formError = form.querySelector(".mcp-form-error");
    expect(formError.classList.contains("hidden")).toBe(false);
    expect(ctx.ws.sent.length).toBe(sendsBefore);
  });

  test("edit prefills from the row, locks the name, and omits untouched env", async () => {
    const ctx = createManager();
    await loadList(ctx, LIST_OK);

    cardOf("docs").querySelectorAll(".mcp-card-btn")[0].click();
    const form = rootEl().querySelector(".mcp-form");
    expect(form.classList.contains("hidden")).toBe(false);

    const { nameInput, commandInput, argsInput } = formInputs(form);
    expect(nameInput.value).toBe("docs");
    expect(nameInput.disabled).toBe(true);
    expect(commandInput.value).toBe("npx");
    expect(argsInput.value).toBe("-y\ndocs-mcp");

    submitForm(form);
    await tick();
    expect(ctx.ws.sent[ctx.ws.sent.length - 1]).toEqual({
      type: "mcp.save",
      name: "docs",
      scope: "user",
      config: { type: "stdio", command: "npx", args: ["-y", "docs-mcp"] },
    });

    await completeMutation(ctx, LIST_OK);
    expect(form.classList.contains("hidden")).toBe(true);
  });

  test("remove is two-step: arm, then send mcp.remove with the row scope", async () => {
    const ctx = createManager();
    await loadList(ctx, LIST_OK);
    const sendsBefore = ctx.ws.sent.length;

    cardOf("docs").querySelectorAll(".mcp-card-btn")[1].click();
    await tick();
    const armed = cardOf("docs").querySelectorAll(".mcp-card-btn")[1];
    expect(armed.classList.contains("armed")).toBe(true);
    expect(ctx.ws.sent.length).toBe(sendsBefore);

    armed.click();
    await tick();
    expect(ctx.ws.sent[ctx.ws.sent.length - 1]).toEqual({
      type: "mcp.remove",
      name: "docs",
      scope: "user",
    });
    await completeMutation(ctx, LIST_OK);
  });

  test("failed list loads render an error note", async () => {
    const ctx = createManager();
    await loadList(ctx, undefined, { success: false, error: "nope" });

    expect(note()).toBe("Failed to load MCP servers");
  });

  test("empty roster renders the empty note", async () => {
    const ctx = createManager();
    await loadList(ctx, { servers: [], capabilities: { liveStatus: true, connect: false } });

    expect(note()).toBe("No MCP servers configured");
  });

  test("re-renders card labels on language change", async () => {
    const ctx = createManager();
    await loadList(ctx, LIST_OK);

    setLanguage("zh-CN");
    expect(cardOf("docs").textContent).toContain("状态: 已连接");
    expect(cardOf("locked").textContent).toContain("只读");
    setLanguage("en");
  });
});
