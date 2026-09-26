/**
 * Windows Terminal theme import (Settings → Appearance)
 *
 * Parses the JSON shape exported by https://windowsterminalthemes.dev/ —
 * a bare scheme object, a `{ "schemes": [...] }` wrapper, a
 * `{ "themes": [...] }` wrapper, or a plain array — and converts each
 * entry into a full Ompcot token block (`:root[data-theme="wt-…"]`)
 * following the same quality bar as the VS Code schemes in
 * `style-theme.css`. Only `name` + `background` + `foreground` are
 * required; the 16 ANSI colors are optional but carry the theme's
 * character (accent / tool / thinking hues), so they are used whenever
 * present and valid.
 *
 * Persistence: imported themes live in the `ompcot-theme-imports`
 * cookie (10 years, Path=/, SameSite=Lax, URI-encoded value). Same
 * rationale as the `ompcot-theme` cookie in themes.js — Ompcot spawns
 * one omp process per workspace, each on its own port, and
 * localStorage is partitioned per origin (`localhost:3001` vs
 * `localhost:3002`), while cookies on `localhost` are shared across
 * ports. The definitions must travel with every workspace window, so
 * a cookie is the only storage that works.
 *
 * Cap: at most `MAX_IMPORTED_THEMES` (20) imports are kept. The stored
 * array is ordered oldest-first; when the cap is exceeded the oldest
 * entries fall off the front (FIFO eviction). Re-importing a theme
 * with the same slug replaces the previous definition and bumps it to
 * the back of the queue (it counts as freshly imported).
 */

import { t } from "./i18n.js";
import {
  applyTheme,
  getCurrentTheme,
  getImportedThemes,
  registerImportedThemes,
} from "./themes.js";

export const IMPORTS_COOKIE = "ompcot-theme-imports";
export const MAX_IMPORTED_THEMES = 20;

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const NAME_MAX_LENGTH = 40;

// Keys the site exports; only these are read (everything else ignored).
const OPTIONAL_COLOR_KEYS = [
  "cursorColor",
  "selectionBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "purple",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightPurple",
  "brightCyan",
  "brightWhite",
];

const I18N = {
  invalidJson: "settings.themeImportInvalidJson",
  missingFields: "settings.themeImportMissingFields",
  imported: "settings.themeImportImported",
  importFailed: "settings.themeImportFailed",
  capReached: "settings.themeImportCapReached",
};

// ═══════════════════════════════════════
// Color math (WCAG-ish; enough discipline to keep derived tokens legible)
// ═══════════════════════════════════════

function clamp255(value) {
  return Math.min(255, Math.max(0, Math.round(value)));
}

export function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = Number.parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function rgbToHex({ r, g, b }) {
  const toHex = (v) => clamp255(v).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function srgbToLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` color (0–1 scale). */
export function luminance(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return 0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b);
}

/** WCAG contrast ratio between two `#rrggbb` colors (1–21). */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear RGB lerp between two `#rrggbb` colors (t=0 → a, t=1 → b). */
export function mixColor(a, b, t2) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return a;
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * t2,
    g: ca.g + (cb.g - ca.g) * t2,
    b: ca.b + (cb.b - ca.b) * t2,
  });
}

function rgba(hex, alpha) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/** Backgrounds at or above this luminance are treated as light. */
const LIGHT_CUTOFF = 0.25;

/**
 * Nudge `color` toward white (dark surfaces) or black (light surfaces)
 * in 10% steps until it clears `threshold` contrast against `bg`.
 * Never invents hues — only mixes toward the poles.
 */
function ensureContrast(color, bg, dark, threshold) {
  const target = dark ? "#ffffff" : "#000000";
  let current = color;
  for (let step = 0; step < 10 && contrastRatio(current, bg) < threshold; step++) {
    current = mixColor(current, target, 0.1);
  }
  return current;
}

// ═══════════════════════════════════════
// Token mapping
// ═══════════════════════════════════════

/**
 * Map a normalized Windows Terminal scheme onto Ompcot's ~32 theme
 * tokens. Returns `{ colorScheme, dark, tokens, swatches }` where
 * `tokens` is keyed by token name (no `--` prefix) and `swatches` is
 * the 4-color preview for the settings grid
 * ([background, foreground, accent, tool-accent]).
 */
export function wtThemeToTokens(theme) {
  const bg = String(theme.background).toLowerCase();
  const fg = String(theme.foreground).toLowerCase();
  const dark = luminance(bg) < LIGHT_CUTOFF;
  const glass = dark ? "255, 255, 255" : "0, 0, 0";

  // Glass layers: white-alpha on dark surfaces, black-alpha on light —
  // same split as the static blocks in style-theme.css.
  const glassTiers = dark
    ? { base: 0.04, hover: 0.07, active: 0.09, strong: 0.05 }
    : { base: 0.03, hover: 0.06, active: 0.09, strong: 0.04 };

  // Borders derive from the foreground hue (dark: 6/10/14% fg; light:
  // neutral black alphas, matching the existing light trio).
  const borders = dark
    ? [rgba(fg, 0.06), rgba(fg, 0.1), rgba(fg, 0.14)]
    : ["rgba(0, 0, 0, 0.13)", "rgba(0, 0, 0, 0.2)", "rgba(0, 0, 0, 0.27)"];

  // Text tiers: foreground hue at descending alphas.
  const textAlphas = dark
    ? { primary: 0.88, secondary: 0.5, dim: 0.3, ghost: 0.1 }
    : { primary: 0.88, secondary: 0.55, dim: 0.35, ghost: 0.12 };

  // Accents fall back through the ANSI set; without any ANSI colors the
  // foreground stands in so the theme still applies cleanly. Only valid
  // `#rrggbb` values are picked (malformed ANSI colors are ignored, same
  // as the parser does), and output is normalized to lowercase.
  const isHex = (value) => typeof value === "string" && HEX_COLOR_RE.test(value);
  const pick = (...keys) => {
    const key = keys.find((k) => isHex(theme[k]));
    return key ? theme[key].toLowerCase() : fg;
  };
  const accent = pick("blue", "cyan", "brightBlue", "brightCyan");
  const tool = pick("purple", "brightPurple", "green");
  const thinking = pick("cyan", "brightCyan", "purple");

  const accentText = ensureContrast(accent, bg, dark, dark ? 3.5 : 4.5);
  const toolText = ensureContrast(tool, bg, dark, dark ? 3.5 : 4.5);
  const thinkingText = ensureContrast(thinking, bg, dark, dark ? 3.5 : 4.5);

  // User bubble — dark: accent-tinted glass with primary text; light:
  // solid accent with white or near-black text, whichever reads better.
  let userBubble;
  let userBubbleText;
  let userBubbleBorder;
  if (dark) {
    userBubble = rgba(accent, 0.12);
    userBubbleText = "var(--text-primary)";
    userBubbleBorder =
      "linear-gradient(135deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.03))";
  } else {
    userBubble = accent;
    const candidates = ["#ffffff", "#101418"];
    userBubbleText = candidates.reduce((best, candidate) =>
      contrastRatio(candidate, accent) > contrastRatio(best, accent) ? candidate : best,
    );
    // Neither pole reaches comfortable contrast — darken the bubble
    // until the chosen text clears 3:1.
    while (contrastRatio(userBubbleText, userBubble) < 3) {
      userBubble = mixColor(userBubble, "#000000", 0.1);
    }
    userBubbleBorder = "none";
  }

  // Sidebar (mobile) sits a touch off the background; shadows only
  // exist on light surfaces (dark blocks set every shadow to `none`).
  const sidebar = dark ? mixColor(bg, fg, 0.05) : mixColor(bg, "#000000", 0.03);
  const shadows = dark
    ? { sm: "none", md: "none", lg: "none", inset: "none" }
    : {
        sm: "0 1px 2px rgba(0, 0, 0, 0.06)",
        md: "0 2px 8px rgba(0, 0, 0, 0.06)",
        lg: "0 4px 16px rgba(0, 0, 0, 0.08)",
        inset: "none",
      };

  const tokens = {
    "bg-solid": bg,
    "header-bg": rgba(bg, 1),
    "sidebar-bg-mobile": rgba(sidebar, 0.95),
    "bg-glass": `rgba(${glass}, ${glassTiers.base})`,
    "bg-glass-hover": `rgba(${glass}, ${glassTiers.hover})`,
    "bg-glass-active": `rgba(${glass}, ${glassTiers.active})`,
    "bg-glass-strong": `rgba(${glass}, ${glassTiers.strong})`,
    "bg-frosted": rgba(bg, 0.85),
    "text-primary": rgba(fg, textAlphas.primary),
    "text-secondary": rgba(fg, textAlphas.secondary),
    "text-dim": rgba(fg, textAlphas.dim),
    "text-ghost": rgba(fg, textAlphas.ghost),
    accent,
    "accent-glow": rgba(accent, dark ? 0.2 : 0.18),
    "accent-subtle": rgba(accent, dark ? 0.08 : 0.07),
    "accent-text": accentText,
    "user-bubble": userBubble,
    "user-bubble-text": userBubbleText,
    "user-bubble-border": userBubbleBorder,
    "tool-accent": tool,
    "tool-accent-text": toolText,
    "tool-bg": rgba(tool, dark ? 0.08 : 0.06),
    "thinking-accent": thinking,
    "thinking-accent-text": thinkingText,
    "thinking-bg": rgba(thinking, dark ? 0.08 : 0.06),
    border: borders[0],
    "border-hover": borders[1],
    "border-bright": borders[2],
    "shadow-sm": shadows.sm,
    "shadow-md": shadows.md,
    "shadow-lg": shadows.lg,
    "shadow-inset": shadows.inset,
  };

  return {
    colorScheme: dark ? "dark" : "light",
    dark,
    tokens,
    swatches: [bg, fg, accent, tool],
  };
}

/** Serialize a token mapping as a `:root[data-theme="<id>"]` block. */
export function tokensToCss(id, mapped) {
  const groups = [
    [
      "bg-solid",
      "header-bg",
      "sidebar-bg-mobile",
      "bg-glass",
      "bg-glass-hover",
      "bg-glass-active",
      "bg-glass-strong",
      "bg-frosted",
    ],
    ["text-primary", "text-secondary", "text-dim", "text-ghost"],
    ["accent", "accent-glow", "accent-subtle", "accent-text"],
    ["user-bubble", "user-bubble-text", "user-bubble-border"],
    ["tool-accent", "tool-accent-text", "tool-bg"],
    ["thinking-accent", "thinking-accent-text", "thinking-bg"],
    ["border", "border-hover", "border-bright"],
    ["shadow-sm", "shadow-md", "shadow-lg", "shadow-inset"],
  ];
  const body = groups
    .map((group) => group.map((key) => `  --${key}: ${mapped.tokens[key]};`).join("\n"))
    .join("\n\n");
  return `:root[data-theme="${id}"] {\n  color-scheme: ${mapped.colorScheme};\n\n${body}\n}\n`;
}

// ═══════════════════════════════════════
// Parsing + validation
// ═══════════════════════════════════════

function slugify(name) {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Non-latin names can slug to empty; keep a stable fallback.
  return slug || "theme";
}

/** Accept the bare scheme, either site wrapper, or a plain array. */
function extractSchemeEntries(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.schemes)) return raw.schemes;
  if (Array.isArray(raw?.themes)) return raw.themes;
  return [raw];
}

/**
 * Normalize one candidate scheme. Required: non-empty `name` (trimmed,
 * ≤40 chars), `background`/`foreground` as `#RRGGBB`. Optional colors
 * are kept when valid and silently dropped when malformed (the theme's
 * character degrades gracefully instead of failing the whole entry).
 */
function normalizeScheme(candidate) {
  const rawName = typeof candidate?.name === "string" ? candidate.name.trim() : "";
  const name = rawName.slice(0, NAME_MAX_LENGTH);
  const fallbackLabel = rawName ? rawName.slice(0, NAME_MAX_LENGTH) : "(unnamed)";
  const background = candidate?.background;
  const foreground = candidate?.foreground;
  if (!name || !HEX_COLOR_RE.test(background) || !HEX_COLOR_RE.test(foreground)) {
    return { error: { name: fallbackLabel, key: I18N.missingFields } };
  }
  const scheme = {
    name,
    background: background.toLowerCase(),
    foreground: foreground.toLowerCase(),
  };
  for (const key of OPTIONAL_COLOR_KEYS) {
    const value = candidate?.[key];
    if (typeof value === "string" && HEX_COLOR_RE.test(value)) {
      scheme[key] = value.toLowerCase();
    }
  }
  return { scheme };
}

/**
 * Parse pasted Windows Terminal theme JSON.
 *
 * Returns `{ ok: true, themes: [entry], errors: [{name, key}] }` on
 * parseable JSON (valid entries plus per-entry validation errors), or
 * `{ ok: false, error, detail }` when the text is not JSON at all.
 * Each entry is a persistence record:
 * `{ id, name, slug, css, swatches, dark }`.
 *
 * `existingIds` are the ids already registered from earlier imports:
 * a slug that matches one of them keeps its id (replacing the old
 * definition on save), while collisions *inside this batch* get a
 * numeric suffix (`wt-campbell-2`, …).
 */
export function parseWindowsTerminalTheme(jsonText, existingIds = []) {
  let raw;
  try {
    raw = JSON.parse(jsonText);
  } catch (error) {
    return { ok: false, error: I18N.invalidJson, detail: String(error?.message ?? error) };
  }

  const entries = [];
  const errors = [];
  const claimed = new Set();
  const existing = new Set(existingIds);
  let suffix = 2;

  extractSchemeEntries(raw).forEach((candidate) => {
    const result = normalizeScheme(candidate);
    if (result.error) {
      errors.push(result.error);
      return;
    }
    const { scheme } = result;
    const slug = slugify(scheme.name);
    const base = `wt-${slug}`;
    let id = base;
    if (claimed.has(id)) {
      // In-batch collision → numeric suffix, skipping ids that already
      // exist as live imports (an auto-suffix must never silently
      // replace an unrelated imported theme).
      let candidate = `${base}-${suffix}`;
      while (claimed.has(candidate) || existing.has(candidate)) {
        suffix++;
        candidate = `${base}-${suffix}`;
      }
      id = candidate;
    }
    claimed.add(id);

    const mapped = wtThemeToTokens(scheme);
    entries.push({
      id,
      name: scheme.name,
      slug,
      css: tokensToCss(id, mapped),
      swatches: mapped.swatches,
      dark: mapped.dark,
    });
  });

  return { ok: true, themes: entries, errors };
}

// ═══════════════════════════════════════
// Cookie persistence (cross-port by design)
// ═══════════════════════════════════════

function isImportedThemeRecord(value) {
  return (
    value &&
    typeof value.id === "string" &&
    typeof value.css === "string" &&
    Array.isArray(value.swatches) &&
    value.swatches.length === 4
  );
}

/** Read imported theme definitions from the cookie (defensively). */
export function loadImportedThemes() {
  try {
    const cookies = document.cookie ? document.cookie.split("; ") : [];
    for (const entry of cookies) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      if (entry.slice(0, eq) !== IMPORTS_COOKIE) continue;
      const raw = entry.slice(eq + 1);
      try {
        const parsed = JSON.parse(decodeURIComponent(raw));
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isImportedThemeRecord);
      } catch {
        return [];
      }
    }
  } catch {
    // document.cookie can throw in sandboxed contexts; treat as missing.
  }
  return [];
}

/**
 * Persist imported themes. The list is ordered oldest-first; duplicates
 * (by id) collapse to the last occurrence, which also moves it to the
 * back — a re-import counts as fresh. Returns `{ saved, evicted }`
 * where `evicted` says whether the 20-theme cap dropped old entries.
 */
export function saveImportedThemes(list) {
  const deduped = new Map();
  for (const record of Array.isArray(list) ? list : []) {
    if (!isImportedThemeRecord(record)) continue;
    // Delete-then-set: Map keeps an existing key's original position, so
    // a re-import would otherwise stay at its old (oldest) spot.
    deduped.delete(record.id);
    deduped.set(record.id, record);
  }
  const merged = [...deduped.values()];
  const evicted = merged.length > MAX_IMPORTED_THEMES;
  const saved = evicted ? merged.slice(merged.length - MAX_IMPORTED_THEMES) : merged;
  try {
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is async and unsuitable for synchronous cross-port theme persistence
    document.cookie = `${IMPORTS_COOKIE}=${encodeURIComponent(JSON.stringify(saved))}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // ignore — same fallback as the theme cookie in themes.js
  }
  return { saved, evicted };
}

/**
 * Delete an imported theme by id. If it was the active theme, fall back
 * to "night" (the registry entry is gone, so the id would no longer
 * resolve). Returns `{ fellBack }` so callers can surface a status.
 */
export function removeImportedTheme(id) {
  // Capture this BEFORE re-registering: once the entry is gone from the
  // registry, getCurrentTheme() can no longer resolve the saved id.
  const wasActive = getCurrentTheme() === id;
  const remaining = getImportedThemes().filter((theme) => theme.id !== id);
  const { saved } = saveImportedThemes(remaining);
  registerImportedThemes(saved);
  if (wasActive) applyTheme("night");
  return { fellBack: wasActive };
}

// ═══════════════════════════════════════
// Settings → Appearance import UI
// ═══════════════════════════════════════

// Deliberately untranslated: it documents the wire format, not the UI.
const INPUT_PLACEHOLDER = [
  "{",
  '  "name": "Campbell",',
  '  "background": "#0C0C0C",',
  '  "foreground": "#CCCCCC",',
  '  "cursorColor": "#CCCCCC",',
  '  "selectionBackground": "#FFFFFF",',
  '  "blue": "#0037DA", "purple": "#881798", "cyan": "#3A96DD",',
  '  "brightPurple": "#B4009E", "brightCyan": "#61D6D6", ...',
  "}",
].join("\n");

const statusTimers = new WeakMap();

function showStatus(el, message, tone) {
  if (!el) return;
  const timer = statusTimers.get(el);
  if (timer) {
    clearTimeout(timer);
    statusTimers.delete(el);
  }
  el.textContent = message;
  el.dataset.tone = tone;
  el.classList.remove("hidden");
  if (tone === "ok") {
    statusTimers.set(
      el,
      setTimeout(() => {
        el.classList.add("hidden");
      }, 4000),
    );
  }
}

function renderErrors(el, result) {
  if (!el) return;
  el.textContent = "";
  const items = [];
  if (result?.error) {
    items.push({ label: null, key: result.error, detail: result.detail });
  }
  for (const err of result?.errors ?? []) {
    items.push({ label: err.name, key: err.key });
  }
  if (items.length === 0) {
    el.classList.add("hidden");
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "theme-import-error-item";
    const message = document.createElement("span");
    message.textContent = item.label ? `${item.label}: ${t(item.key)}` : t(item.key);
    row.appendChild(message);
    if (item.detail) {
      const detail = document.createElement("code");
      detail.textContent = item.detail;
      row.appendChild(detail);
    }
    el.appendChild(row);
  }
  el.classList.remove("hidden");
}

/**
 * Wire the import textarea + button. On success the parsed themes are
 * merged with the existing imports, persisted, registered into the
 * theme registry (which re-injects the shared stylesheet), and the grid
 * is rebuilt via `onThemesChanged`.
 */
export function setupThemeImport({ textarea, importBtn, statusEl, errorsEl, onThemesChanged }) {
  if (!textarea || !importBtn) return;

  textarea.placeholder = INPUT_PLACEHOLDER;

  importBtn.addEventListener("click", () => {
    const result = parseWindowsTerminalTheme(
      textarea.value,
      getImportedThemes().map((x) => x.id),
    );

    if (!result.ok) {
      renderErrors(errorsEl, result);
      showStatus(statusEl, t(I18N.importFailed), "error");
      return;
    }

    renderErrors(errorsEl, result);

    if (result.themes.length === 0) {
      showStatus(statusEl, t(I18N.importFailed), "error");
      return;
    }

    const { saved, evicted } = saveImportedThemes([...getImportedThemes(), ...result.themes]);
    registerImportedThemes(saved);
    textarea.value = "";
    let message = t(I18N.imported, { count: result.themes.length });
    if (evicted) message += ` ${t(I18N.capReached)}`;
    showStatus(statusEl, message, "ok");
    onThemesChanged?.();
  });
}
