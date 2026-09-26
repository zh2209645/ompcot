import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  setupThinkingLevelMenu,
  THINKING_LEVELS,
  thinkingLevelLabel,
} from "./thinking-level-menu.js";

function setupMenu({ current = "off", onSelect = vi.fn(), levels } = {}) {
  const anchor = document.createElement("div");
  anchor.className = "thinking-dropdown";
  const button = document.createElement("button");
  button.type = "button";
  button.id = "thinking-btn";
  const menu = document.createElement("div");
  menu.className = "thinking-level-menu hidden";
  anchor.append(button, menu);
  document.body.appendChild(anchor);
  const api = setupThinkingLevelMenu({ button, levels, getCurrentLevel: () => current, onSelect });
  return { button, menu, anchor, onSelect, api };
}

function itemsOf(menu) {
  return Array.from(menu.querySelectorAll(".thinking-level-item"));
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("thinkingLevelLabel", () => {
  test("labels known levels with their canonical names and falls back to the raw level", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(thinkingLevelLabel("off")).toBe("off");
    expect(thinkingLevelLabel("medium")).toBe("medium");
    expect(thinkingLevelLabel("turbo")).toBe("turbo");
  });

  test("labels the extended server levels", () => {
    expect(thinkingLevelLabel("xhigh")).toBe("xhigh");
    expect(thinkingLevelLabel("max")).toBe("max");
  });
});

describe("setupThinkingLevelMenu", () => {
  test("opening via the button lists every level with the current one checked", () => {
    const { button, menu } = setupMenu({ current: "medium" });

    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    button.click();
    expect(menu.classList.contains("hidden")).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.querySelector(".thinking-level-menu-title").textContent).toBe(
      "Choose thinking depth",
    );

    const items = itemsOf(menu);
    expect(items.map((el) => el.dataset.level)).toEqual(THINKING_LEVELS);
    const active = items.find((el) => el.classList.contains("active"));
    expect(active.dataset.level).toBe("medium");
    expect(active.getAttribute("aria-checked")).toBe("true");
    expect(active.querySelector(".thinking-level-check").textContent).toBe("✓");
    expect(items.filter((el) => el.getAttribute("aria-checked") === "true")).toHaveLength(1);
    // The current item receives focus so arrow-key navigation starts there.
    expect(document.activeElement).toBe(active);
  });

  test("renders exactly the level array the caller provides, including xhigh/max", () => {
    const { button, menu } = setupMenu({
      current: "high",
      levels: ["off", "low", "high", "xhigh", "max"],
    });
    button.click();

    const items = itemsOf(menu);
    expect(items.map((el) => el.dataset.level)).toEqual(["off", "low", "high", "xhigh", "max"]);
    expect(items[3].textContent).toContain("xhigh");
    expect(items[4].textContent).toContain("max");
    expect(items.find((el) => el.classList.contains("active")).dataset.level).toBe("high");
  });

  test("falls back to the default five levels for a missing or invalid set", () => {
    // NOTE: `[]` is deliberately absent — an explicit empty array is the
    // server's "no controllable thinking depth" contract and disables the
    // chip (see the unsupported-models suite below).
    for (const invalid of [undefined, null, ["off", 42], "low"]) {
      const { button, menu } = setupMenu({ levels: invalid });
      button.click();
      expect(itemsOf(menu).map((el) => el.dataset.level)).toEqual(THINKING_LEVELS);
    }
  });

  test("setLevels swaps the rendered set and re-renders while open", () => {
    const { api, button, menu } = setupMenu({ current: "off" });
    button.click();
    expect(itemsOf(menu).map((el) => el.dataset.level)).toEqual(THINKING_LEVELS);

    api.setLevels(["off", "medium", "max"]);
    const items = itemsOf(menu);
    expect(items.map((el) => el.dataset.level)).toEqual(["off", "medium", "max"]);
    expect(items[2].textContent).toContain("max");
    expect(menu.classList.contains("hidden")).toBe(false);
  });

  test("shows no selection when the current level is not in the supported set", () => {
    const { button, menu } = setupMenu({ current: "ultra", levels: ["off", "low", "high"] });
    button.click();

    const items = itemsOf(menu);
    expect(items).toHaveLength(3);
    expect(items.filter((el) => el.classList.contains("active"))).toHaveLength(0);
    expect(items.filter((el) => el.getAttribute("aria-checked") === "true")).toHaveLength(0);
    // Focus still lands on the first item so keyboard navigation works.
    expect(document.activeElement).toBe(items[0]);
  });

  test("selecting a level closes the menu and reports the choice", () => {
    const { button, menu, onSelect } = setupMenu({ current: "off" });
    button.click();
    itemsOf(menu)
      .find((el) => el.dataset.level === "high")
      .click();
    expect(onSelect).toHaveBeenCalledWith("high");
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  test("clicking the button again toggles the menu closed", () => {
    const { button, menu } = setupMenu();
    button.click();
    button.click();
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  test("Escape closes the menu without selecting", () => {
    const { button, menu, onSelect } = setupMenu({ current: "low" });
    button.click();
    const active = document.activeElement;
    active.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });

  test("arrow keys move focus through the levels", () => {
    const { button, menu } = setupMenu({ current: "off" });
    button.click();
    const items = itemsOf(menu);
    expect(document.activeElement).toBe(items[0]);

    items[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(items[1]);

    items[1].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(items[0]);

    items[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  test("an outside click closes the menu", () => {
    const { menu } = setupMenu({ current: "high" });
    const button = document.querySelector("#thinking-btn");
    button.click();
    expect(menu.classList.contains("hidden")).toBe(false);

    document.body.click();
    expect(menu.classList.contains("hidden")).toBe(true);
  });

  test("opens downward when it fits the viewport, flips above when it would overflow", () => {
    // jsdom has no layout, so stub the measured rects: the menu measures the
    // anchor's bottom edge and its own height after un-hiding.
    const fits = setupMenu({ current: "off" });
    vi.spyOn(fits.anchor, "getBoundingClientRect").mockReturnValue({ bottom: 100 });
    vi.spyOn(fits.menu, "getBoundingClientRect").mockReturnValue({ height: 200 });
    fits.button.click();
    expect(fits.menu.classList.contains("open-up")).toBe(false);

    const overflows = setupMenu({ current: "off" });
    vi.spyOn(overflows.anchor, "getBoundingClientRect").mockReturnValue({ bottom: 700 });
    vi.spyOn(overflows.menu, "getBoundingClientRect").mockReturnValue({ height: 200 });
    overflows.button.click();
    // 700 + 200 + 6 > 768 viewport → must open upward, overlaying the composer.
    expect(overflows.menu.classList.contains("open-up")).toBe(true);
  });

  test("opening the menu changes no container height (absolute positioning pinned)", () => {
    // The regression: the menu participating in layout pushed the page up.
    // jsdom cannot compute layout, so pin the CSS contract that guarantees
    // overlay behavior, and assert the DOM structure is untouched by open().
    const css = readFileSync(join(process.cwd(), "public/style.css"), "utf8");
    const menuRule = css.match(/\.thinking-level-menu\s*\{[^}]+\}/)?.[0] || "";
    const openUpRule = css.match(/\.thinking-level-menu\.open-up\s*\{[^}]+\}/)?.[0] || "";
    expect(menuRule).toContain("position: absolute");
    expect(menuRule).toContain("max-height:");
    expect(menuRule).toContain("overflow-y: auto");
    expect(openUpRule).toContain("top: auto");
    expect(openUpRule).toContain("bottom: calc(100% + 6px)");

    const { anchor, button, menu } = setupMenu({ current: "off" });
    const childrenBefore = anchor.childElementCount;
    const bodyScrollHeightBefore = document.body.scrollHeight;
    button.click();
    expect(anchor.childElementCount).toBe(childrenBefore);
    expect(menu.parentElement).toBe(anchor);
    expect(document.body.scrollHeight).toBe(bodyScrollHeightBefore);
    button.click();
    expect(document.body.scrollHeight).toBe(bodyScrollHeightBefore);
  });

  test("missing menu anchor or callbacks is a harmless no-op", () => {
    const button = document.createElement("button");
    expect(() =>
      setupThinkingLevelMenu({ button, getCurrentLevel: () => "off", onSelect: vi.fn() }),
    ).not.toThrow();
    const anchored = setupMenu();
    const noopApi = setupThinkingLevelMenu({
      button: anchored.button,
      getCurrentLevel: null,
      onSelect: vi.fn(),
    });
    expect(noopApi).toBeNull();
    expect(anchored.api).not.toBeNull();
  });
});

describe("unsupported models (empty server level set)", () => {
  test("an explicit empty set disables the chip: tooltip/aria swap, menu cannot open", () => {
    const { button, menu, api } = setupMenu({ levels: [] });

    expect(api.isSupported()).toBe(false);
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("This model does not support thinking depth control");
    expect(button.getAttribute("aria-label")).toBe(
      "This model does not support thinking depth control",
    );
    // Menu semantics are dropped while unsupported.
    expect(button.hasAttribute("aria-haspopup")).toBe(false);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    // Clicking (even programmatically, which bypasses native disabling)
    // must not open the menu or render any level item.
    button.click();
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(menu.querySelectorAll(".thinking-level-item")).toHaveLength(0);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  test("setLevels([]) disables the chip and closes an open menu; the disabled style is pinned", () => {
    const { api, button, menu } = setupMenu({ current: "low" });
    button.click();
    expect(menu.classList.contains("hidden")).toBe(false);

    api.setLevels([]);
    expect(api.isSupported()).toBe(false);
    expect(button.disabled).toBe(true);
    expect(menu.classList.contains("hidden")).toBe(true);
    expect(button.title).toBe("This model does not support thinking depth control");

    // CSS contract: the disabled chip is dimmed and not clickable.
    const css = readFileSync(join(process.cwd(), "public/style.css"), "utf8");
    const disabledBody =
      css.match(
        /\.thinking-tag:disabled,\s*\.thinking-tag:disabled:hover,\s*\.settings-value-btn:disabled,\s*\.settings-value-btn:disabled:hover\s*\{([^}]+)\}/,
      )?.[1] || "";
    expect(disabledBody).not.toBe("");
    expect(disabledBody).toContain("opacity:");
    expect(disabledBody).toContain("cursor: not-allowed");
  });

  test("re-enabling via a fresh set (set_model ack path) updates the chip immediately", () => {
    const { api, button, menu } = setupMenu({ levels: [] });
    expect(button.disabled).toBe(true);

    // app.js feeds the set_model ack straight into setLevels: after
    // switching to a model WITH an effort ladder the chip must come back
    // synchronously, with no extra round-trip.
    api.setLevels(["off", "low", "high"]);
    expect(api.isSupported()).toBe(true);
    expect(button.disabled).toBe(false);
    expect(button.title).toBe("Thinking depth controls reasoning. Click to choose.");

    button.click();
    expect(menu.classList.contains("hidden")).toBe(false);
    expect(itemsOf(menu).map((el) => el.dataset.level)).toEqual(["off", "low", "high"]);
  });

  test("the set_model ack seam swaps the rendered set immediately, even while open", () => {
    const { api, button, menu } = setupMenu({ current: "high" });
    button.click();
    expect(itemsOf(menu).map((el) => el.dataset.level)).toEqual(THINKING_LEVELS);

    api.setLevels(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(menu.classList.contains("hidden")).toBe(false);
    expect(itemsOf(menu).map((el) => el.dataset.level)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);

    // Switching to an unsupported model through the same seam disables again.
    api.setLevels([]);
    expect(api.isSupported()).toBe(false);
    expect(button.disabled).toBe(true);
    expect(menu.classList.contains("hidden")).toBe(true);
  });
});
