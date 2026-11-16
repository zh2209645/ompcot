// Themed dropdown menus for the settings-page <select> controls
// (.settings-select, .pkg-browse-sort).
//
// Why not the native popup: webkit2gtk paints the open select list with a
// hardcoded light palette and ignores every attempt to theme it — option
// background/color, `::picker(select)` / `appearance: base-select` and
// `color-scheme` all have no effect on the popup (verified on webkit2gtk
// 2.54; the closed control is already drawn by the CSS text pipeline via
// `appearance: none`). So the open menu is a DOM list styled from the theme
// variables instead.
//
// The <select> stays the value and semantics source: a pick writes
// select.value and dispatches the same input/change events a native pick
// would, so every existing listener keeps working. The menu is rebuilt from
// the select's live options on each open, so dynamically repopulated selects
// (language, model roles, MCP form) are always current.

const SELECTOR = "select.settings-select, select.pkg-browse-sort";

let menuEl = null;
let activeSelect = null;
let cursorIndex = -1;

function closeMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
  activeSelect = null;
  cursorIndex = -1;
}

function pickOption(select, option) {
  closeMenu();
  if (option.disabled) return;
  // Native semantics: picking the already-selected value closes the menu
  // without firing events.
  if (select.value !== option.value) {
    select.value = option.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  select.focus();
}

function moveCursor(delta) {
  if (!menuEl || !activeSelect) return;
  const rows = [...menuEl.querySelectorAll(".settings-dropdown-option")];
  if (!rows.length) return;
  let next = cursorIndex;
  for (let i = 0; i < rows.length; i++) {
    next = (next + delta + rows.length) % rows.length;
    if (!rows[next].classList.contains("disabled")) break;
  }
  cursorIndex = next;
  for (const [i, row] of rows.entries()) {
    row.classList.toggle("cursor", i === cursorIndex);
  }
  rows[cursorIndex]?.scrollIntoView({ block: "nearest" });
}

function positionMenu(select) {
  const rect = select.getBoundingClientRect();
  menuEl.style.width = `${Math.max(rect.width, 180)}px`;
  // Fixed positioning: the settings panel scrolls and clips overflow, so the
  // menu cannot live inside the select's stacking context. Flip above the
  // control when the viewport bottom cannot fit it.
  const menuHeight = menuEl.offsetHeight;
  const below = window.innerHeight - rect.bottom;
  menuEl.style.left = `${Math.min(rect.left, window.innerWidth - menuEl.offsetWidth - 8)}px`;
  if (below >= menuHeight || below >= rect.top) {
    menuEl.style.top = `${rect.bottom + 4}px`;
  } else {
    menuEl.style.top = `${Math.max(4, rect.top - menuHeight - 4)}px`;
  }
}

function openMenu(select) {
  closeMenu();
  activeSelect = select;
  cursorIndex = -1;

  const menu = document.createElement("div");
  menu.className = "settings-dropdown-menu";
  menu.setAttribute("role", "listbox");
  for (const option of select.options) {
    const row = document.createElement("div");
    row.className = "settings-dropdown-option";
    if (option.disabled) row.classList.add("disabled");
    if (option.selected) {
      row.classList.add("active");
      row.setAttribute("aria-selected", "true");
    }
    row.textContent = option.textContent;
    // Keep focus on the select so its keydown handling stays in charge.
    row.addEventListener("mousedown", (e) => e.preventDefault());
    row.addEventListener("click", () => pickOption(select, option));
    menu.appendChild(row);
  }

  menuEl = menu;
  document.body.appendChild(menu);
  positionMenu(select);
}

function toggleMenu(select) {
  if (activeSelect === select) {
    closeMenu();
  } else {
    openMenu(select);
  }
}

function handleMouseDown(e) {
  const select = e.target.closest?.(SELECTOR);
  if (select && !select.disabled) {
    // Suppress the native popup (which cannot be themed) and own the toggle.
    e.preventDefault();
    select.focus();
    toggleMenu(select);
    return;
  }
  if (menuEl && !menuEl.contains(e.target)) closeMenu();
}

function handleKeyDown(e) {
  const select = e.target.closest?.(SELECTOR);
  if (select && !select.disabled) {
    // Open gestures must never reach the native popup.
    const openKey = e.key === "Enter" || e.key === " " || (e.altKey && e.key === "ArrowDown");
    if (openKey && !activeSelect) {
      e.preventDefault();
      openMenu(select);
      return;
    }
    if (activeSelect === select) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveCursor(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveCursor(-1);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const option = select.options[cursorIndex >= 0 ? cursorIndex : select.selectedIndex];
        if (option) pickOption(select, option);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
      }
    }
    return;
  }
  if (menuEl && e.key === "Escape") {
    e.preventDefault();
    closeMenu();
  }
}

export function initSettingsDropdowns() {
  // Delegated listeners: selects are rebuilt dynamically (language switch,
  // MCP edit forms, model-role pages), so nothing is wired per element.
  document.addEventListener("mousedown", handleMouseDown);
  document.addEventListener("keydown", handleKeyDown);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("blur", closeMenu);
  // Capture-phase scroll: any scroller (panel, page) hides the fixed menu
  // out from under its anchor otherwise.
  document.addEventListener("scroll", closeMenu, true);
}
