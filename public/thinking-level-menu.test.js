import { afterEach, describe, expect, test, vi } from "vitest";
import {
  setupThinkingLevelMenu,
  THINKING_LEVELS,
  thinkingLevelLabel,
} from "./thinking-level-menu.js";

function setupMenu({ current = "off", onSelect = vi.fn() } = {}) {
  const anchor = document.createElement("div");
  anchor.className = "thinking-dropdown";
  const button = document.createElement("button");
  button.type = "button";
  button.id = "thinking-btn";
  const menu = document.createElement("div");
  menu.className = "thinking-level-menu hidden";
  anchor.append(button, menu);
  document.body.appendChild(anchor);
  setupThinkingLevelMenu({ button, getCurrentLevel: () => current, onSelect });
  return { button, menu, anchor, onSelect };
}

function itemsOf(menu) {
  return Array.from(menu.querySelectorAll(".thinking-level-item"));
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("thinkingLevelLabel", () => {
  test("localizes the known levels and falls back to the raw level", () => {
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(thinkingLevelLabel("off")).toBe("Off");
    expect(thinkingLevelLabel("medium")).toBe("Medium");
    expect(thinkingLevelLabel("turbo")).toBe("turbo");
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
      "Choose thinking effort",
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

  test("missing menu anchor or callbacks is a harmless no-op", () => {
    const button = document.createElement("button");
    expect(() =>
      setupThinkingLevelMenu({ button, getCurrentLevel: () => "off", onSelect: vi.fn() }),
    ).not.toThrow();
    const anchored = setupMenu();
    expect(() =>
      setupThinkingLevelMenu({
        button: anchored.button,
        getCurrentLevel: null,
        onSelect: vi.fn(),
      }),
    ).not.toThrow();
  });
});
