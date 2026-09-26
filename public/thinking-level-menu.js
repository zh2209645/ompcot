// Thinking-depth picker for the composer: a small popup menu anchored to the
// #thinking-btn chip, mirroring the model-dropdown open/close pattern
// (outside-click close, Esc close, aria-haspopup + arrow-key navigation).
// The composer button used to cycle levels on click; it now opens this menu so
// any level can be picked directly. The Settings-tab thinking button keeps its
// click-to-cycle behavior (see app-settings-toggles.js) and is unaffected.
//
// The menu renders the level set reported by the server (get_state
// `thinkingLevels`, model-specific). Callers push fresh sets via the returned
// `setLevels()`; a missing/empty/invalid set falls back to DEFAULT_LEVELS.

import { t } from "./i18n.js";

/** Fallback levels when the server does not report `thinkingLevels`. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

/** Gap between chip and menu, matching the model-dropdown anchor gap. */
const MENU_GAP = 6;

const LEVEL_LABEL_KEYS = {
  off: "composer.thinkLevelNameOff",
  minimal: "composer.thinkLevelNameMinimal",
  low: "composer.thinkLevelNameLow",
  medium: "composer.thinkLevelNameMedium",
  high: "composer.thinkLevelNameHigh",
  xhigh: "composer.thinkLevelNameXhigh",
  max: "composer.thinkLevelNameMax",
};

/** Localized display name for a thinking level (falls back to the raw level). */
export function thinkingLevelLabel(level) {
  const key = LEVEL_LABEL_KEYS[level];
  return key ? t(key) : String(level);
}

/**
 * A set is usable only when it is a non-empty array of non-empty strings;
 * anything else (missing, empty, malformed) falls back to the default set.
 */
function normalizeLevels(candidates) {
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0 ||
    !candidates.every((level) => typeof level === "string" && level.length > 0)
  ) {
    return THINKING_LEVELS;
  }
  return candidates;
}

/**
 * Wire the popup menu to the composer thinking button.
 *
 * @param {object} options
 * @param {HTMLButtonElement} options.button - the #thinking-btn chip
 * @param {string[]} [options.levels] - initial selectable levels
 * @param {() => string} options.getCurrentLevel - current level getter
 * @param {(level: string) => void} options.onSelect - called with the picked level
 * @returns {{ setLevels: (levels: string[]) => void } | null} null when wiring is impossible
 */
export function setupThinkingLevelMenu({
  button,
  levels = THINKING_LEVELS,
  getCurrentLevel,
  onSelect,
}) {
  if (!button || typeof getCurrentLevel !== "function" || typeof onSelect !== "function")
    return null;
  const anchor = button.parentElement;
  const menu = anchor?.querySelector(".thinking-level-menu");
  if (!anchor || !menu) return null;

  let activeLevels = normalizeLevels(levels);

  const isOpen = () => !menu.classList.contains("hidden");

  // Ensure menu semantics even if the static markup omits them.
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("composer.thinkLevelMenuTitle"));

  const close = (refocus = false) => {
    menu.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
    // preventScroll: refocusing the chip must never scroll the page.
    if (refocus) button.focus({ preventScroll: true });
  };

  // The composer sits at the bottom of the viewport, so opening downward
  // usually overflows it — and the browser would then scroll the page to
  // reveal the focused item (the "page shifts up" bug). Measure after
  // un-hiding and flip the menu above the chip when needed; it overlays
  // instead of ever pushing or scrolling layout.
  const updateMenuDirection = () => {
    menu.classList.remove("open-up");
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const anchorBottom = anchor.getBoundingClientRect().bottom;
    const menuHeight = menu.getBoundingClientRect().height;
    if (anchorBottom + menuHeight + MENU_GAP > viewportHeight) {
      menu.classList.add("open-up");
    }
  };

  const focusCurrentItem = () => {
    const target =
      menu.querySelector(".thinking-level-item.active") ||
      menu.querySelector(".thinking-level-item");
    target?.focus({ preventScroll: true });
  };

  const buildItems = () => {
    menu.replaceChildren();
    const title = document.createElement("div");
    title.className = "thinking-level-menu-title";
    title.textContent = t("composer.thinkLevelMenuTitle");
    menu.appendChild(title);

    const current = getCurrentLevel();
    for (const level of activeLevels) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `thinking-level-item${level === current ? " active" : ""}`;
      item.dataset.level = level;
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", level === current ? "true" : "false");
      const label = document.createElement("span");
      label.textContent = thinkingLevelLabel(level);
      const check = document.createElement("span");
      check.className = "thinking-level-check";
      check.textContent = "✓";
      item.append(label, check);
      item.addEventListener("click", () => {
        close(true);
        onSelect(level);
      });
      menu.appendChild(item);
    }
  };

  const open = () => {
    buildItems();
    menu.classList.remove("hidden");
    updateMenuDirection();
    button.setAttribute("aria-expanded", "true");
    focusCurrentItem();
  };

  /**
   * Replace the rendered level set (server contract: get_state
   * `thinkingLevels`). Invalid sets fall back to the default five. If the
   * menu is open it re-renders in place.
   */
  const setLevels = (nextLevels) => {
    activeLevels = normalizeLevels(nextLevels);
    if (isOpen()) {
      buildItems();
      updateMenuDirection();
      focusCurrentItem();
    }
  };

  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => (isOpen() ? close(true) : open()));

  // Arrow keys / Home / End move focus between items; Esc closes without
  // selecting (Esc handling mirrors the model-dropdown search input).
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close(true);
      return;
    }
    const items = Array.from(menu.querySelectorAll(".thinking-level-item"));
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (idx + 1 + items.length) % items.length;
    else if (e.key === "ArrowUp") next = (idx - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next < 0) return;
    e.preventDefault();
    items[next].focus({ preventScroll: true });
  });

  // Outside click closes the menu (pattern: model-dropdown close-on-outside-click)
  document.addEventListener("click", (e) => {
    if (isOpen() && !anchor.contains(e.target)) close();
  });

  return { setLevels };
}
