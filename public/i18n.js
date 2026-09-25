/**
 * Interface language (i18n) — English + 简体中文.
 *
 * Storage note: the active language is persisted in a cookie (not
 * localStorage). Ompcot spawns one omp process per workspace, each on
 * its own port, and every workspace window is loaded from
 * `http://localhost:<port>`. localStorage is partitioned per origin, so
 * `localhost:3001` and `localhost:3002` would each see a different
 * `ompcot-lang` value — meaning any new project window would forget
 * the user's language and fall back to the browser default. Cookies
 * on `localhost` are shared across ports, so a single cookie is visible
 * to every workspace window. (Same rationale as `ompcot-theme` in
 * themes.js.)
 *
 * Lookup order for `t(key)`: active language dictionary → English
 * dictionary (source of truth) → the raw key. Missing zh-CN keys are
 * therefore safe; they render English.
 *
 * Static markup is translated declaratively via `data-i18n*` attributes
 * (see applyTranslations); strings built at runtime in JS use `t()`
 * directly.
 */

import { en } from "./locales/en.js";
import { zhCN } from "./locales/zh-CN.js";

export const SUPPORTED_LANGUAGES = [
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
];

const DICTS = { en, "zh-CN": zhCN };
const DEFAULT_LANGUAGE = "en";
const LANG_COOKIE = "ompcot-lang";
const LANG_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 10; // 10 years
const LANGUAGE_CHANGED_EVENT = "ompcot:language-changed";

// Resolved fresh on every getLanguage() call (cookie → navigator → default),
// mirroring getCurrentTheme() in themes.js — parsing document.cookie is
// cheap, and re-reading keeps windows consistent if the cookie changes.

function readLangCookie() {
  try {
    const cookies = document.cookie ? document.cookie.split("; ") : [];
    for (const entry of cookies) {
      const eq = entry.indexOf("=");
      if (eq === -1) continue;
      const name = entry.slice(0, eq);
      if (name !== LANG_COOKIE) continue;
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

function writeLangCookie(langId) {
  try {
    const value = encodeURIComponent(langId);
    // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API is async and not suitable for synchronous language persistence
    document.cookie = `${LANG_COOKIE}=${value}; Max-Age=${LANG_COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`;
  } catch {
    // ignore — same fallback as the read path
  }
}

/** Returns the active language id ("en" | "zh-CN"): cookie → navigator → "en". */
export function getLanguage() {
  const saved = readLangCookie();
  if (saved && DICTS[saved]) return saved;
  try {
    const preferred = navigator.languages || [navigator.language];
    for (const tag of preferred) {
      if (typeof tag === "string" && tag.toLowerCase().startsWith("zh")) return "zh-CN";
    }
  } catch {
    // navigator may be unavailable; fall through to default
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Persists and applies a new interface language.
 * Returns true when `langId` is supported and was applied, false otherwise.
 */
export function setLanguage(langId) {
  const isSupported = SUPPORTED_LANGUAGES.some((lang) => lang.id === langId);
  if (!isSupported) return false;
  writeLangCookie(langId);
  document.documentElement.lang = langId;
  applyTranslations();
  window.dispatchEvent(new CustomEvent(LANGUAGE_CHANGED_EVENT, { detail: { language: langId } }));
  return true;
}

/**
 * Translate `key` using the active language, falling back to English and
 * then to the key itself. `{param}` placeholders are replaced with values
 * from `params`.
 */
export function t(key, params) {
  const dict = DICTS[getLanguage()] || {};
  const template = dict[key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

const I18N_ATTR_TARGETS = [
  ["data-i18n", "textContent"],
  ["data-i18n-title", "title"],
  ["data-i18n-placeholder", "placeholder"],
  ["data-i18n-aria-label", "aria-label"],
  // innerHTML is trusted input: only our own locale dictionaries flow in
  // here (help texts containing <code>/<a> markup).
  ["data-i18n-html", "innerHTML"],
];

/**
 * Walk `root` (default: document) and translate every element carrying a
 * `data-i18n*` attribute. Also keeps <html lang> in sync with the active
 * language so assistive tech and font rendering follow the UI language.
 */
export function applyTranslations(root = document) {
  for (const [attr, prop] of I18N_ATTR_TARGETS) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const key = el.getAttribute(attr);
      if (!key) continue;
      // aria-* is set via setAttribute — the reflected property form is not
      // reliably implemented across WebViews/jsdom.
      if (prop.startsWith("aria-")) el.setAttribute(prop, t(key));
      else el[prop] = t(key);
    }
  }
  if (root === document) {
    document.documentElement.lang = getLanguage();
  }
}

/**
 * Subscribe to language changes. Returns an unsubscribe function.
 * The callback runs after applyTranslations() has already refreshed the
 * static markup; use it to re-render JS-owned dynamic labels.
 */
export function onLanguageChanged(callback) {
  window.addEventListener(LANGUAGE_CHANGED_EVENT, callback);
  return () => {
    window.removeEventListener(LANGUAGE_CHANGED_EVENT, callback);
  };
}
