// Thinking-effort picker for the composer: a small popup menu anchored to the
// #thinking-btn chip, mirroring the model-dropdown open/close pattern
// (outside-click close, Esc close, aria-haspopup + arrow-key navigation).
// The composer button used to cycle levels on click; it now opens this menu so
// any level can be picked directly. The Settings-tab thinking button keeps its
// click-to-cycle behavior (see app-settings-toggles.js) and is unaffected.

import { t } from "./i18n.js";

/** Levels the embedded server accepts for set_thinking_level (embedded-server.ts). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

const LEVEL_LABEL_KEYS = {
  off: "composer.thinkLevelNameOff",
  minimal: "composer.thinkLevelNameMinimal",
  low: "composer.thinkLevelNameLow",
  medium: "composer.thinkLevelNameMedium",
  high: "composer.thinkLevelNameHigh",
};

/** Localized display name for a thinking level (falls back to the raw level). */
export function thinkingLevelLabel(level) {
  const key = LEVEL_LABEL_KEYS[level];
  return key ? t(key) : String(level);
}

/**
 * Wire the popup menu to the composer thinking button.
 *
 * @param {object} options
 * @param {HTMLButtonElement} options.button - the #thinking-btn chip
 * @param {string[]} [options.levels] - selectable levels
 * @param {() => string} options.getCurrentLevel - current level getter
 * @param {(level: string) => void} options.onSelect - called with the picked level
 */
export function setupThinkingLevelMenu({
  button,
  levels = THINKING_LEVELS,
  getCurrentLevel,
  onSelect,
}) {
  if (!button || typeof getCurrentLevel !== "function" || typeof onSelect !== "function") return;
  const anchor = button.parentElement;
  const menu = anchor?.querySelector(".thinking-level-menu");
  if (!anchor || !menu) return;

  const isOpen = () => !menu.classList.contains("hidden");

  // Ensure menu semantics even if the static markup omits them.
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", t("composer.thinkLevelMenuTitle"));

  const close = (refocus = false) => {
    menu.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
    if (refocus) button.focus();
  };

  const buildItems = () => {
    menu.replaceChildren();
    const title = document.createElement("div");
    title.className = "thinking-level-menu-title";
    title.textContent = t("composer.thinkLevelMenuTitle");
    menu.appendChild(title);

    const current = getCurrentLevel();
    for (const level of levels) {
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
    button.setAttribute("aria-expanded", "true");
    const current =
      menu.querySelector(".thinking-level-item.active") ||
      menu.querySelector(".thinking-level-item");
    current?.focus();
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
    items[next].focus();
  });

  // Outside click closes the menu (pattern: model-dropdown close-on-outside-click)
  document.addEventListener("click", (e) => {
    if (isOpen() && !anchor.contains(e.target)) close();
  });
}
