import { describe, expect, test } from "vitest";
import { CONFIG_PAGES, isAlwaysPage, pageForKey } from "./agent-settings-pages.js";
import { en } from "./locales/en.js";
import { zhCN } from "./locales/zh-CN.js";

describe("configuration page map", () => {
  test("page order follows the omp settings taxonomy, Providers first, Advanced last", () => {
    expect(CONFIG_PAGES.map((page) => page.id)).toEqual([
      "providers",
      "models",
      "appearance",
      "model",
      "interaction",
      "context",
      "memory",
      "files",
      "shell",
      "tools",
      "mcp",
      "tasks",
      "other",
      "advanced",
    ]);
  });

  test("Providers, Models & Reasoning, MCP and Advanced are always-present pages", () => {
    expect(CONFIG_PAGES.filter((page) => isAlwaysPage(page.id)).map((page) => page.id)).toEqual([
      "providers",
      "models",
      "mcp",
      "advanced",
    ]);
  });

  test("Other is a catalog-driven page ordered after Tasks, before Advanced", () => {
    // The catch-all bucket hides when the catalog has no unmapped keys —
    // only Advanced is always present at the end of the strip.
    const other = CONFIG_PAGES.find((page) => page.id === "other");
    expect(other).toBeTruthy();
    expect(isAlwaysPage("other")).toBe(false);
    expect(CONFIG_PAGES.map((page) => page.id).indexOf("other")).toBe(
      CONFIG_PAGES.map((page) => page.id).indexOf("advanced") - 1,
    );
  });

  test("models is a static management page; model catalog keys stay on the model page", () => {
    // The Models & Reasoning sub-page manages roles/thinking/task-agent
    // overrides over dedicated RPCs — the model.* settings catalog keeps
    // rendering under the separate "Model" page.
    expect(pageForKey("model.temperature")).toBe("model");
    expect(CONFIG_PAGES.find((page) => page.id === "models")).toBeTruthy();
  });

  test("maps first key segments to their sub-page", () => {
    expect(pageForKey("theme.preset")).toBe("appearance");
    expect(pageForKey("composer.width")).toBe("appearance");
    expect(pageForKey("model.temperature")).toBe("model");
    expect(pageForKey("sampling.maxTokens")).toBe("model");
    expect(pageForKey("thinking.level")).toBe("model");
    expect(pageForKey("input.escape")).toBe("interaction");
    expect(pageForKey("approvals.bash")).toBe("interaction");
    expect(pageForKey("git.commitSignature")).toBe("interaction");
    expect(pageForKey("compaction.reserve")).toBe("context");
    expect(pageForKey("ttsr.enabled")).toBe("context");
    expect(pageForKey("memory.autoLearn.enabled")).toBe("memory");
    expect(pageForKey("mnemopi.interval")).toBe("memory");
    expect(pageForKey("edit.formatOnSave")).toBe("files");
    expect(pageForKey("lsp.enabled")).toBe("files");
    expect(pageForKey("bash.timeout")).toBe("shell");
    expect(pageForKey("runtimes.node")).toBe("shell");
    expect(pageForKey("tools.todos.enabled")).toBe("tools");
    expect(pageForKey("mcp.discovery")).toBe("tools");
    expect(pageForKey("subagents.defaultModel")).toBe("tasks");
    expect(pageForKey("skills.paths")).toBe("tasks");
  });

  test("maps unprefixed keys by their single segment", () => {
    expect(pageForKey("theme")).toBe("appearance");
    expect(pageForKey("tools")).toBe("tools");
  });

  test("mcp catalog keys stay on Tools: the MCP management page is static UI", () => {
    // The MCP servers page is a management surface, not a catalog page —
    // Discovery & MCP settings keep rendering under Tools.
    expect(pageForKey("mcp.discovery")).toBe("tools");
    expect(CONFIG_PAGES.find((page) => page.id === "mcp")).toBeTruthy();
  });

  test("falls back to Other for unmapped segments so no setting is ever hidden", () => {
    expect(pageForKey("quantum.entangle")).toBe("other");
    expect(pageForKey("general")).toBe("other");
    expect(pageForKey("permissions.allow")).toBe("other");
  });

  test("providers catalog keys land in Other: the Providers page is static by design", () => {
    expect(pageForKey("providers.customHeaders")).toBe("other");
  });

  test("no catalog key ever maps to Advanced — it is only the raw config.yml editor", () => {
    const samples = [
      "quantum.entangle",
      "general",
      "permissions.allow",
      "providers.customHeaders",
      "model.temperature",
      "theme.preset",
      "skills.paths",
    ];
    for (const key of samples) {
      expect(pageForKey(key)).not.toBe("advanced");
    }
  });

  test("treats missing values as unmapped", () => {
    expect(pageForKey(null)).toBe("other");
    expect(pageForKey(undefined)).toBe("other");
    expect(pageForKey("")).toBe("other");
  });

  test("every page has a label in both locales", () => {
    for (const page of CONFIG_PAGES) {
      expect(typeof en[page.i18nKey]).toBe("string");
      expect(en[page.i18nKey].length).toBeGreaterThan(0);
      expect(typeof zhCN[page.i18nKey]).toBe("string");
      expect(zhCN[page.i18nKey].length).toBeGreaterThan(0);
    }
  });
});
