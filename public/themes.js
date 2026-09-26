/**
 * Theme system — built-in themes + VS Code color schemes
 *
 * Every entry needs a matching `:root[data-theme="<id>"]` token block in
 * `style-theme.css`. `group` ("builtin" | "vscode" | "imported") controls
 * which labeled cluster the swatch renders under in Settings → Appearance;
 * entries without a group are treated as "builtin".
 *
 * Imported themes (Windows Terminal imports via theme-import.js) are NOT
 * static entries: they are merged into this map at runtime by
 * `registerImportedThemes()`, and their CSS travels in a dedicated
 * `<style id="imported-themes-css">` element instead of the static
 * stylesheet — so the registry↔CSS parity tests for the static set are
 * unaffected by them by design.
 *
 * Storage note: the active theme is persisted in a cookie (not
 * localStorage). Ompcot spawns one omp process per workspace, each on
 * its own port, and every workspace window is loaded from
 * `http://localhost:<port>`. localStorage is partitioned per origin, so
 * `localhost:3001` and `localhost:3002` would each see a different
 * `ompcot-theme` value — meaning any new project window would forget
 * the user's theme and fall back to the OS default (usually dark). Cookies
 * on `localhost` are shared across ports, so a single cookie is visible
 * to every workspace window.
 */

export const themes = {
  night: {
    name: "Dusk",
    dark: true,
    colors: ["#212121", "#a0a0a0", "#777777", "#666666"],
    vars: {},
  },
  dawn: {
    name: "Dawn",
    dark: true,
    colors: ["#1a1d26", "#7a8ab0", "#6a5a80", "#5a7a9a"],
    vars: {},
  },
  midnight: {
    name: "Midnight",
    dark: true,
    colors: ["#000000", "#5a7a9a", "#4a5565", "#4a5a72"],
    vars: {},
  },
  clean: {
    name: "Clean",
    dark: false,
    colors: ["#ffffff", "#0580c4", "#007aff", "#5ac8fa"],
    vars: {},
  },
  terracotta: {
    name: "Terracotta",
    dark: false,
    colors: ["#f4f1ec", "#b06a48", "#5c2860", "#3a6a9b"],
    vars: {},
  },
  sage: {
    name: "Sage",
    dark: false,
    colors: ["#f0f2ec", "#6a7d5a", "#4a3860", "#3a6a7a"],
    vars: {},
  },

  // VS Code schemes — canonical editor palettes. Names are product names and
  // stay in English in every locale.
  "vscode-dark-plus": {
    group: "vscode",
    name: "Dark+",
    dark: true,
    colors: ["#1e1e1e", "#007acc", "#4ec9b0", "#c586c0"],
    vars: {},
  },
  "vscode-light-plus": {
    group: "vscode",
    name: "Light+",
    dark: false,
    colors: ["#ffffff", "#007acc", "#267f79", "#af00db"],
    vars: {},
  },
  "vscode-monokai": {
    group: "vscode",
    name: "Monokai",
    dark: true,
    colors: ["#272822", "#a6e22e", "#f92672", "#66d9ef"],
    vars: {},
  },
  "vscode-solarized-dark": {
    group: "vscode",
    name: "Solarized Dark",
    dark: true,
    colors: ["#002b36", "#268bd2", "#2aa198", "#b58900"],
    vars: {},
  },
  "vscode-solarized-light": {
    group: "vscode",
    name: "Solarized Light",
    dark: false,
    colors: ["#fdf6e3", "#268bd2", "#2aa198", "#b58900"],
    vars: {},
  },
  "vscode-one-dark-pro": {
    group: "vscode",
    name: "One Dark Pro",
    dark: true,
    colors: ["#282c34", "#61afef", "#98c379", "#c678dd"],
    vars: {},
  },
  "vscode-dracula": {
    group: "vscode",
    name: "Dracula",
    dark: true,
    colors: ["#282a36", "#bd93f9", "#ff79c6", "#8be9fd"],
    vars: {},
  },
  "vscode-github-dark": {
    group: "vscode",
    name: "GitHub Dark",
    dark: true,
    colors: ["#0d1117", "#2ea043", "#58a6ff", "#bc8cff"],
    vars: {},
  },
  "vscode-github-light": {
    group: "vscode",
    name: "GitHub Light",
    dark: false,
    colors: ["#ffffff", "#1f883d", "#0969da", "#8250df"],
    vars: {},
  },
};

// TODO(rename->ompcot): cookie key kept as `ompcot-theme` for backward compat — changing it would reset all existing users' theme preference.
const THEME_COOKIE = "ompcot-theme";
const THEME_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years

function readThemeCookie() {
  try {
    const cookies = document.cookie ? document.cookie.split("; ") : [];
    for (const entry of cookies) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      const name = entry.slice(0, eq);
      if (name !== THEME_COOKIE) continue;
      const raw = entry.slice(eq + 1);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  } catch {
    // document.cookie can throw in sandboxed contexts; treat as missing.
  }
  return null;
}

function writeThemeCookie(themeId) {
  try {
    const value = encodeURIComponent(themeId);
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is async and not suitable for synchronous theme persistence
    document.cookie = `${THEME_COOKIE}=${value}; Max-Age=${THEME_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // ignore — same fallback as the read path
  }
}

// One-time migration: lift any previously saved value out of the per-origin
// localStorage and into the cross-port cookie. Old key is left in place so
// downgrades stay readable; new writes always go to the cookie.
function migrateLegacyLocalStorageValue() {
  try {
    if (readThemeCookie()) return;
    const legacy = localStorage.getItem(THEME_COOKIE);
    if (legacy) writeThemeCookie(legacy);
  } catch {
    // localStorage may be unavailable; nothing to migrate
  }
}

migrateLegacyLocalStorageValue();

export function applyTheme(themeId) {
  const root = document.documentElement;
  if (!themes[themeId]) themeId = "night";
  root.setAttribute("data-theme", themeId);
  writeThemeCookie(themeId);
}

export function getCurrentTheme() {
  const saved = readThemeCookie();
  if (saved === "dark") return "night";
  if (saved === "light") return "terracotta";
  if (saved && themes[saved]) return saved;
  if (window.matchMedia?.("(prefers-color-scheme: light)").matches) return "terracotta";
  return "night";
}

// Track OS theme changes only when the user hasn't picked a theme yet.
// As soon as a cookie exists (set by applyTheme) this listener becomes a
// no-op, so the user's explicit choice wins.
if (!readThemeCookie()) {
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener("change", (e) => {
    if (!readThemeCookie()) {
      const root = document.documentElement;
      root.setAttribute("data-theme", e.matches ? "terracotta" : "night");
    }
  });
}

// ═══════════════════════════════════════
// Imported themes (Windows Terminal imports — see theme-import.js)
//
// Imported entries live in the same `themes` map (group: "imported") so
// `applyTheme` / `getCurrentTheme` resolve their ids like any other
// theme: the id persists in the ordinary `ompcot-theme` cookie and
// stays stable across windows because the definition itself travels in
// the `ompcot-theme-imports` cookie. Their CSS is injected once into a
// single shared `<style id="imported-themes-css">` element rather than
// the static style-theme.css.
// ═══════════════════════════════════════

const IMPORTED_STYLE_ID = "imported-themes-css";

function toRegistryEntry(record) {
  return {
    group: "imported",
    name: record.name,
    dark: Boolean(record.dark),
    colors: record.swatches,
    vars: {},
    // Not part of the swatch contract — kept so the record can be
    // round-tripped back to the imports cookie without re-parsing CSS.
    slug: record.slug ?? "",
    css: record.css,
  };
}

/** The currently registered imported themes, as persistence records. */
export function getImportedThemes() {
  const records = [];
  for (const [id, theme] of Object.entries(themes)) {
    if (theme.group !== "imported" || !theme.css) continue;
    records.push({
      id,
      name: theme.name,
      slug: theme.slug ?? "",
      css: theme.css,
      swatches: theme.colors,
      dark: Boolean(theme.dark),
    });
  }
  return records;
}

/**
 * Replace the imported slice of the registry with `list` (persistence
 * records as produced by theme-import.js). Replace semantics keep this
 * a single entry point for boot restore, import, and delete; builtin
 * and VS Code entries are never touched. Also re-syncs the shared
 * imported-themes stylesheet.
 */
export function registerImportedThemes(list) {
  for (const [id, theme] of Object.entries(themes)) {
    if (theme.group === "imported") delete themes[id];
  }
  for (const record of Array.isArray(list) ? list : []) {
    if (!record?.id || !record?.css) continue;
    themes[record.id] = toRegistryEntry(record);
  }
  syncImportedStylesheet();
}

function syncImportedStylesheet() {
  if (typeof document === "undefined") return;
  let styleEl = document.getElementById(IMPORTED_STYLE_ID);
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = IMPORTED_STYLE_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = getImportedThemes()
    .map((record) => record.css)
    .join("\n");
}
