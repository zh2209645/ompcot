import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setLanguage } from "./i18n.js";
import { createConfigSubnav } from "./settings-config-subnav.js";

const html = readFileSync(join(process.cwd(), "public/index.html"), "utf8");

describe("settings configuration sub-pages", () => {
  let dom;

  beforeEach(() => {
    // A real URL is required so i18n's language cookie actually persists
    // (about:blank silently drops document.cookie writes).
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

  function setup() {
    const root = document.querySelector('[data-settings-panel="configuration"]');
    const catalog = {
      load: vi.fn(async () => {}),
      setActivePage: vi.fn(),
    };
    const loaders = { providers: vi.fn(), advanced: vi.fn(), models: vi.fn() };
    const subnav = createConfigSubnav({ root, catalog, loaders });
    return { subnav, catalog, loaders };
  }

  const pillIds = () =>
    Array.from(document.querySelectorAll("#settings-config-subnav .settings-subnav-item")).map(
      (el) => el.dataset.configPage,
    );
  const pillOf = (pageId) =>
    document.querySelector(
      `#settings-config-subnav .settings-subnav-item[data-config-page="${pageId}"]`,
    );
  const sectionOf = (pageId) =>
    document.querySelector(`.settings-config-page[data-config-page="${pageId}"]`);
  const host = () => document.getElementById("agent-settings-host");

  test("shows Providers by default with every page as a candidate pill", () => {
    setup();

    expect(pillIds()).toEqual([
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
      "advanced",
    ]);
    expect(pillOf("providers").getAttribute("aria-selected")).toBe("true");
    expect(sectionOf("providers").hidden).toBe(false);
    expect(sectionOf("advanced").hidden).toBe(true);
    // Providers is static content — the catalog host stays out of the way.
    expect(host().hidden).toBe(true);
  });

  test("open() lazily loads only the active page's loaders, once per page", () => {
    const { subnav, catalog, loaders } = setup();

    subnav.open();
    expect(loaders.providers).toHaveBeenCalledTimes(1);
    expect(loaders.advanced).not.toHaveBeenCalled();
    expect(catalog.load).not.toHaveBeenCalled();

    subnav.open();
    expect(loaders.providers).toHaveBeenCalledTimes(1); // revisit does not reload
  });

  test("visiting a catalog page fetches the catalog once and filters the page set", () => {
    const { subnav, catalog, loaders } = setup();

    subnav.open();
    pillOf("model").click();

    expect(catalog.load).toHaveBeenCalledTimes(1);
    expect(catalog.setActivePage).toHaveBeenCalledWith("model");
    expect(host().hidden).toBe(false); // loading state is visible
    expect(loaders.advanced).not.toHaveBeenCalled();

    subnav.onCatalogPageSet(["model", "tools"]);

    expect(pillIds()).toEqual(["providers", "models", "model", "tools", "mcp", "advanced"]);
    expect(subnav.getPage()).toBe("model"); // still non-empty, no fallback
    expect(host().hidden).toBe(false);

    pillOf("model").click();
    expect(catalog.load).toHaveBeenCalledTimes(1); // shared single fetch
  });

  test("collapses to Providers when the active page has zero catalog entries", () => {
    const { subnav } = setup();

    subnav.open();
    pillOf("memory").click();
    subnav.onCatalogPageSet(["model", "tools"]);

    expect(subnav.getPage()).toBe("providers");
    expect(pillOf("providers").classList.contains("active")).toBe(true);
    expect(sectionOf("providers").hidden).toBe(false);
    expect(pillIds()).toEqual(["providers", "models", "model", "tools", "mcp", "advanced"]);
  });

  test("Advanced always stays reachable and hides the catalog host when nothing is unmapped", () => {
    const { subnav, catalog, loaders } = setup();

    subnav.open();
    pillOf("advanced").click();

    expect(loaders.advanced).toHaveBeenCalledTimes(1);
    expect(catalog.load).toHaveBeenCalledTimes(1); // Advanced also shows catalog groups

    subnav.onCatalogPageSet(["model"]);

    expect(subnav.getPage()).toBe("advanced"); // always-present page never falls back
    expect(sectionOf("advanced").hidden).toBe(false);
    expect(host().hidden).toBe(true); // no unmapped entries → config.yml only
    expect(pillIds()).toEqual(["providers", "models", "model", "mcp", "advanced"]);
  });

  test("a failed catalog load keeps every page reachable instead of hiding them", () => {
    const { subnav, catalog } = setup();

    subnav.open();
    pillOf("model").click();
    catalog.load.mockRejectedValueOnce(new Error("boom"));
    subnav.onCatalogPageSet(null);

    expect(pillIds()).toHaveLength(13);
    expect(subnav.getPage()).toBe("model"); // unknown ≠ empty
    expect(host().hidden).toBe(false); // error + retry stays visible
  });

  test("the static Models & Reasoning page hides the catalog host and refetches on every open", () => {
    const { subnav, loaders } = setup();

    subnav.open();
    pillOf("models").click();

    expect(sectionOf("models")).toBeTruthy();
    expect(sectionOf("models").hidden).toBe(false);
    expect(host().hidden).toBe(true); // static page — no catalog mount
    expect(loaders.models).toHaveBeenCalledTimes(1);

    subnav.open("providers");
    pillOf("models").click();

    // Live list: the loader re-runs on every activation, unlike Providers.
    expect(loaders.models).toHaveBeenCalledTimes(2);
  });

  test("the static MCP page hides the catalog host and refetches on every open", () => {
    const catalog = {
      load: vi.fn(async () => {}),
      setActivePage: vi.fn(),
    };
    const loaders = { mcp: vi.fn() };
    const subnav = createConfigSubnav({
      root: document.querySelector('[data-settings-panel="configuration"]'),
      catalog,
      loaders,
    });

    subnav.open();
    pillOf("mcp").click();

    expect(sectionOf("mcp")).toBeTruthy();
    expect(sectionOf("mcp").hidden).toBe(false);
    expect(host().hidden).toBe(true); // static page — no catalog mount
    expect(catalog.load).not.toHaveBeenCalled(); // static pages never fetch it
    expect(loaders.mcp).toHaveBeenCalledTimes(1);

    subnav.open("providers");
    pillOf("mcp").click();

    // Live list: the loader re-runs on every activation, unlike Providers.
    expect(loaders.mcp).toHaveBeenCalledTimes(2);
  });

  test("restores the last-active sub-page on the next open without reloading", () => {
    const { subnav, loaders } = setup();

    subnav.open();
    pillOf("tools").click();
    subnav.onCatalogPageSet(["tools", "model"]);

    loaders.providers.mockClear();
    loaders.advanced.mockClear();
    subnav.open(); // close + reopen Settings → Configuration

    expect(subnav.getPage()).toBe("tools");
    expect(sectionOf("advanced").hidden).toBe(true);
    expect(loaders.providers).not.toHaveBeenCalled();
    expect(loaders.advanced).not.toHaveBeenCalled();
  });

  test("open(pageId) forces a target sub-page", () => {
    const { subnav, loaders } = setup();

    subnav.open();
    pillOf("advanced").click();
    subnav.open("providers");

    expect(subnav.getPage()).toBe("providers");
    expect(sectionOf("providers").hidden).toBe(false);
    expect(loaders.providers).toHaveBeenCalledTimes(1);
  });

  test("re-renders pill labels on language change", () => {
    setup();

    setLanguage("zh-CN");
    expect(pillOf("providers").textContent).toBe("提供商");
    expect(pillOf("advanced").textContent).toBe("高级");

    setLanguage("en");
    expect(pillOf("providers").textContent).toBe("Providers");
    expect(pillOf("model").textContent).toBe("Model");
  });
});
