import { describe, expect, test } from "vitest";
import { CONFIG_PAGES, isAlwaysPage, pageForKey } from "./agent-settings-pages.js";
import { en } from "./locales/en.js";
import { zhCN } from "./locales/zh-CN.js";

describe("configuration page map", () => {
  test("page order follows the omp settings taxonomy, Providers first, Advanced last", () => {
    expect(CONFIG_PAGES.map((page) => page.id)).toEqual([
      "providers",
      "appearance",
      "model",
      "interaction",
      "context",
      "memory",
      "files",
      "shell",
      "tools",
      "tasks",
      "advanced",
    ]);
  });

  test("Providers and Advanced are always-present pages", () => {
    expect(CONFIG_PAGES.filter((page) => isAlwaysPage(page.id)).map((page) => page.id)).toEqual([
      "providers",
      "advanced",
    ]);
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

  test("falls back to Advanced for unmapped segments so no setting is ever hidden", () => {
    expect(pageForKey("quantum.entangle")).toBe("advanced");
    expect(pageForKey("general")).toBe("advanced");
    expect(pageForKey("permissions.allow")).toBe("advanced");
  });

  test("providers catalog keys land in Advanced: the Providers page is static by design", () => {
    expect(pageForKey("providers.customHeaders")).toBe("advanced");
  });

  test("treats missing values as unmapped", () => {
    expect(pageForKey(null)).toBe("advanced");
    expect(pageForKey(undefined)).toBe("advanced");
    expect(pageForKey("")).toBe("advanced");
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
