import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupContextViz } from "./app-context-viz.js";

/**
 * The popover's interaction contract: press-time toggling (the header is a drag
 * region, where a `click` never arrives if the pointer drifts), an outside
 * press closing it, and an explicit empty state instead of a blank box.
 */
function harness({ usage = { input: 42000, cacheRead: 8000 }, windowSize = 1_000_000 } = {}) {
  document.body.innerHTML = `
    <div class="header-right">
      <span class="pill token-usage" id="token-usage" role="button" tabindex="0"></span>
      <div class="context-viz hidden" id="context-viz">
        <div class="context-bar" id="context-bar"></div>
        <div class="context-legend" id="context-legend"></div>
        <div class="context-viz-footer">
          <span id="context-viz-used"></span>
          <span id="context-viz-total"></span>
        </div>
      </div>
      <button id="somewhere-else">elsewhere</button>
    </div>`;

  let currentUsage = usage;
  let currentWindow = windowSize;
  setupContextViz({
    tokenUsageEl: document.getElementById("token-usage"),
    contextViz: document.getElementById("context-viz"),
    contextBar: document.getElementById("context-bar"),
    contextLegend: document.getElementById("context-legend"),
    contextVizUsed: document.getElementById("context-viz-used"),
    contextVizTotal: document.getElementById("context-viz-total"),
    getUsage: () => currentUsage,
    getContextWindowSize: () => currentWindow,
  });

  const pill = document.getElementById("token-usage");
  const panel = document.getElementById("context-viz");
  const PointerEventCtor = globalThis.PointerEvent ?? class extends MouseEvent {};
  const press = (el) => {
    // Pointer events, not click: that is what the toggle listens for.
    el.dispatchEvent(new PointerEventCtor("pointerdown", { bubbles: true, cancelable: true }));
  };
  return {
    pill,
    panel,
    press,
    setUsage: (next) => {
      currentUsage = next;
    },
    setWindow: (next) => {
      currentWindow = next;
    },
    isOpen: () => !panel.classList.contains("hidden"),
  };
}

describe("context popover", () => {
  let ctx;
  beforeEach(() => {
    ctx = harness();
  });

  it("opens on the first press and closes on the next", () => {
    ctx.press(ctx.pill);
    expect(ctx.isOpen()).toBe(true);
    expect(ctx.pill.getAttribute("aria-expanded")).toBe("true");

    ctx.press(ctx.pill);
    expect(ctx.isOpen()).toBe(false);
    expect(ctx.pill.getAttribute("aria-expanded")).toBe("false");
  });

  it("renders the bar, legend and footer from the usage it is given", () => {
    ctx.press(ctx.pill);

    const segments = Array.from(document.querySelectorAll(".context-bar-segment"));
    expect(segments.map((el) => el.className.includes("cache"))).toContain(true);
    const legend = Array.from(document.querySelectorAll(".context-legend-item")).map((el) =>
      el.textContent.replace(/\s+/g, " ").trim(),
    );
    expect(legend).toHaveLength(3);
    expect(legend[0]).toContain("8.0k"); // cached
    expect(legend[1]).toContain("42.0k"); // fresh input
    expect(document.getElementById("context-viz-total").textContent).toBe("50.0k / 1.0M");
    expect(document.getElementById("context-viz-used").textContent).toMatch(/5%/);
  });

  it("stays open while pressing inside it, and closes on a press elsewhere", () => {
    ctx.press(ctx.pill);
    ctx.press(document.querySelector("#context-bar"));
    expect(ctx.isOpen()).toBe(true);

    ctx.press(document.getElementById("somewhere-else"));
    expect(ctx.isOpen()).toBe(false);
  });

  it("shows an explicit empty state instead of a blank box", () => {
    // A reset/new session: the pill is hidden by app.js, and a press that races
    // that must not leave the previous popover content or an empty skeleton.
    ctx.press(ctx.pill);
    ctx.setUsage(null);
    ctx.press(ctx.pill); // close
    ctx.press(ctx.pill); // open again

    expect(ctx.isOpen()).toBe(true);
    expect(document.querySelectorAll(".context-bar-segment")).toHaveLength(0);
    expect(document.querySelector(".context-viz-empty")).not.toBeNull();
    expect(document.getElementById("context-viz-total").textContent).toBe("");
  });

  it("also says so when the model exposes no context window", () => {
    ctx.setWindow(0);
    ctx.press(ctx.pill);

    expect(document.querySelector(".context-viz-empty")).not.toBeNull();
    expect(document.querySelectorAll(".context-legend-item")).toHaveLength(0);
  });

  it("toggles from the keyboard (Enter/Space) and closes on Escape", () => {
    const key = (k) => {
      const event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
      ctx.pill.dispatchEvent(event);
      return event;
    };

    key("Enter");
    expect(ctx.isOpen()).toBe(true);
    const escEvent = key("Escape");
    expect(ctx.isOpen()).toBe(false);
    expect(escEvent.defaultPrevented).toBe(true);

    key(" ");
    expect(ctx.isOpen()).toBe(true);
  });

  it("never toggles twice for one press (no click listener remains)", () => {
    // A press that also produces a click must not toggle back: the pill only
    // listens for pointerdown, which is what makes the drag-region case work.
    const spy = vi.fn();
    ctx.panel.addEventListener("transitionend", spy);
    ctx.press(ctx.pill);
    ctx.pill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(ctx.isOpen()).toBe(true);
  });
});
