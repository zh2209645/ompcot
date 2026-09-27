/**
 * Interface font settings — family + size, persisted in a cookie.
 *
 * Storage note: like the theme (`ompcot-theme`) and language (`ompcot-lang`)
 * preferences the choice lives in a cookie rather than localStorage. Ompcot
 * runs one window per workspace and every window is served from its own
 * localhost port (its own origin), so localStorage would partition the setting
 * per window; cookies are shared across ports, which is what lets one font
 * choice apply everywhere.
 *
 * Size is a *scale factor*, never a pixel value: every text size in the
 * stylesheets is written as `calc(<px> * var(--font-scale))`, so the transcript,
 * sidebar and chrome all scale together and the relative hierarchy between
 * headings, body text and metadata is preserved. Code keeps `--font-mono`
 * unless the user picks the monospace family for the interface as well.
 */

import { onLanguageChanged, t } from "./i18n.js";

// TODO(rename->ompcot): cookie key kept as `ompcot-font` for consistency with the other cross-port preference cookies.
export const FONT_COOKIE = "ompcot-font";
const FONT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export const FONT_SCALE_MIN = 0.85;
export const FONT_SCALE_MAX = 1.4;
export const FONT_SCALE_STEP = 0.05;

export const DEFAULT_FONT_SETTINGS = { family: "system", scale: 1 };

/**
 * Interface font choices. `stack` is a complete CSS font stack: the first
 * family the OS actually has wins, so the same entry behaves sensibly on
 * macOS, Windows and Linux. CJK fallbacks are included where the generic
 * family would otherwise pick a serif face for Chinese text.
 */
export const FONT_FAMILIES = [
  {
    id: "system",
    labelKey: "settings.fontFamilySystem",
    stack:
      '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", sans-serif',
  },
  {
    id: "sans",
    labelKey: "settings.fontFamilySans",
    stack: '"Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif',
  },
  {
    id: "serif",
    labelKey: "settings.fontFamilySerif",
    stack: 'Georgia, "Times New Roman", "Songti SC", "Noto Serif CJK SC", SimSun, serif',
  },
  {
    id: "mono",
    labelKey: "settings.fontFamilyMono",
    stack:
      'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Cascadia Mono", "Noto Sans Mono", monospace',
  },
];

const FAMILY_BY_ID = new Map(FONT_FAMILIES.map((family) => [family.id, family]));

/** Font stack for a family id, falling back to the default. */
export function fontStackFor(familyId) {
  return (FAMILY_BY_ID.get(familyId) ?? FAMILY_BY_ID.get(DEFAULT_FONT_SETTINGS.family)).stack;
}

/** Clamp arbitrary input to the supported scale range. */
export function clampFontScale(value) {
  const scale = Number(value);
  if (!Number.isFinite(scale)) return DEFAULT_FONT_SETTINGS.scale;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, scale));
}

/** Normalize an unknown/corrupt preference object into a usable one. */
export function normalizeFontSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const family = FAMILY_BY_ID.has(source.family) ? source.family : DEFAULT_FONT_SETTINGS.family;
  return { family, scale: clampFontScale(source.scale) };
}

function readFontCookie() {
  try {
    const cookies = document.cookie ? document.cookie.split("; ") : [];
    for (const entry of cookies) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      if (entry.slice(0, eq) !== FONT_COOKIE) continue;
      let raw = entry.slice(eq + 1);
      try {
        raw = decodeURIComponent(raw);
      } catch {
        /* keep the raw value */
      }
      const [family, scale] = raw.split(":");
      return { family, scale };
    }
  } catch {
    // document.cookie can throw in sandboxed contexts; treat as missing.
  }
  return null;
}

function writeFontCookie(settings) {
  try {
    const value = encodeURIComponent(`${settings.family}:${settings.scale}`);
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is async and not suitable for synchronous preference persistence
    document.cookie = `${FONT_COOKIE}=${value}; Max-Age=${FONT_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // ignore — same fallback as the read path
  }
}

/** Current preference: cookie when present and valid, defaults otherwise. */
export function getFontSettings() {
  return normalizeFontSettings(readFontCookie());
}

/**
 * Apply a preference to the document (CSS variables) and persist it.
 * Returns the normalized settings that were applied.
 */
export function applyFontSettings(settings) {
  const normalized = normalizeFontSettings(settings);
  const root = document.documentElement;
  root.style.setProperty("--font-ui", fontStackFor(normalized.family));
  root.style.setProperty("--font-scale", String(normalized.scale));
  writeFontCookie(normalized);
  return normalized;
}

/**
 * Wire the Settings → General controls (`select` + range + percentage readout
 * + reset). The markup lives in index.html; this only fills the family options
 * (their labels are translated) and keeps both controls in sync with the
 * stored preference.
 *
 * @returns {{render: () => void, apply: (settings: object) => object}}
 */
export function setupFontSettings({ selectEl, rangeEl, valueEl, resetEl } = {}) {
  function render() {
    if (selectEl) {
      const current = getFontSettings().family;
      selectEl.replaceChildren(
        ...FONT_FAMILIES.map((family) => {
          const option = document.createElement("option");
          option.value = family.id;
          option.textContent = t(family.labelKey);
          option.selected = family.id === current;
          return option;
        }),
      );
    }
    const { scale } = getFontSettings();
    if (rangeEl) {
      rangeEl.min = String(FONT_SCALE_MIN);
      rangeEl.max = String(FONT_SCALE_MAX);
      rangeEl.step = String(FONT_SCALE_STEP);
      rangeEl.value = String(scale);
      rangeEl.setAttribute("aria-valuetext", `${Math.round(scale * 100)}%`);
    }
    if (valueEl) valueEl.textContent = `${Math.round(scale * 100)}%`;
  }

  function apply(settings) {
    const applied = applyFontSettings(settings);
    render();
    return applied;
  }

  if (selectEl) {
    selectEl.addEventListener("change", () => {
      apply({ ...getFontSettings(), family: selectEl.value });
    });
  }
  if (rangeEl) {
    // `input` so dragging the handle scales the interface live; the cookie is
    // written once per step, which is cheap and keeps windows in sync.
    rangeEl.addEventListener("input", () => {
      apply({ ...getFontSettings(), scale: rangeEl.value });
    });
  }
  if (resetEl) {
    resetEl.addEventListener("click", () => apply(DEFAULT_FONT_SETTINGS));
  }

  // Option labels are translated at render time.
  onLanguageChanged(() => render());
  // Apply the stored preference on boot (and normalize a corrupt cookie): the
  // module is initialised by app.js on every window, so a window that never
  // opens Settings still renders with the user's font choice.
  apply(getFontSettings());

  return { render, apply };
}
