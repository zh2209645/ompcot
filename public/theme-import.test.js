import { beforeEach, describe, expect, test } from "vitest";
import { t } from "./i18n.js";
import { en } from "./locales/en.js";
import { zhCN } from "./locales/zh-CN.js";
import {
  contrastRatio,
  loadImportedThemes,
  MAX_IMPORTED_THEMES,
  parseWindowsTerminalTheme,
  removeImportedTheme,
  saveImportedThemes,
  setupThemeImport,
  tokensToCss,
  wtThemeToTokens,
} from "./theme-import.js";
import {
  applyTheme,
  getCurrentTheme,
  getImportedThemes,
  registerImportedThemes,
  themes,
} from "./themes.js";

const CAMPBELL = JSON.stringify({
  name: "Campbell",
  background: "#0C0C0C",
  foreground: "#CCCCCC",
  cursorColor: "#CCCCCC",
  selectionBackground: "#FFFFFF",
  black: "#0C0C0C",
  red: "#C50F1F",
  green: "#13A10E",
  yellow: "#C19C00",
  blue: "#0037DA",
  purple: "#881798",
  cyan: "#3A96DD",
  white: "#CCCCCC",
  brightBlack: "#767676",
  brightRed: "#E74856",
  brightGreen: "#16C60C",
  brightYellow: "#F9F1A5",
  brightBlue: "#3B78FF",
  brightPurple: "#B4009E",
  brightCyan: "#61D6D6",
  brightWhite: "#F2F2F2",
});

const TANGO_LIGHT = JSON.stringify({
  name: "Tango Light",
  background: "#FFFFFF",
  foreground: "#555555",
  blue: "#3465A4",
  purple: "#75507B",
  cyan: "#06989A",
  green: "#4E9A06",
});

function importDom() {
  const textarea = document.createElement("textarea");
  const button = document.createElement("button");
  const status = document.createElement("div");
  const errors = document.createElement("div");
  return { textarea, button, status, errors };
}

function makeRecord(id, name, extra = {}) {
  return {
    id,
    name,
    slug: id.replace(/^wt-/, ""),
    css: `:root[data-theme="${id}"] {\n  color-scheme: dark;\n  --bg-solid: #0c0c0c;\n}\n`,
    swatches: ["#0c0c0c", "#cccccc", "#0037da", "#881798"],
    dark: true,
    ...extra,
  };
}

function expireCookie(name) {
  // biome-ignore lint/suspicious/noDocumentCookie: test helper — Cookie Store API is async and unnecessary in tests
  document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
}

beforeEach(() => {
  expireCookie("ompcot-theme");
  expireCookie("ompcot-theme-imports");
  registerImportedThemes([]);
});

describe("parseWindowsTerminalTheme", () => {
  test("parses a single bare scheme object", () => {
    const result = parseWindowsTerminalTheme(CAMPBELL);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.themes).toHaveLength(1);
    const theme = result.themes[0];
    expect(theme.id).toBe("wt-campbell");
    expect(theme.name).toBe("Campbell");
    expect(theme.slug).toBe("campbell");
    expect(theme.dark).toBe(true);
    expect(theme.swatches).toEqual(["#0c0c0c", "#cccccc", "#0037da", "#881798"]);
    expect(theme.css).toContain(':root[data-theme="wt-campbell"]');
  });

  test("parses a { schemes: [...] } wrapper", () => {
    const result = parseWindowsTerminalTheme(
      JSON.stringify({ schemes: [JSON.parse(CAMPBELL), JSON.parse(TANGO_LIGHT)] }),
    );
    expect(result.ok).toBe(true);
    expect(result.themes.map((x) => x.id)).toEqual(["wt-campbell", "wt-tango-light"]);
  });

  test("parses a { themes: [...] } wrapper", () => {
    const result = parseWindowsTerminalTheme(JSON.stringify({ themes: [JSON.parse(CAMPBELL)] }));
    expect(result.ok).toBe(true);
    expect(result.themes).toHaveLength(1);
  });

  test("parses a plain array of schemes", () => {
    const result = parseWindowsTerminalTheme(`[${CAMPBELL}, ${TANGO_LIGHT}]`);
    expect(result.ok).toBe(true);
    expect(result.themes).toHaveLength(2);
  });

  test("rejects unparseable JSON with a localized key", () => {
    const result = parseWindowsTerminalTheme("{not json");
    expect(result.ok).toBe(false);
    expect(en[result.error]).toBeTruthy();
    expect(typeof result.detail).toBe("string");
  });

  test("flags entries missing required fields", () => {
    const result = parseWindowsTerminalTheme(JSON.stringify({ name: "Broken" }));
    expect(result.ok).toBe(true);
    expect(result.themes).toEqual([]);
    expect(result.errors).toEqual([{ name: "Broken", key: "settings.themeImportMissingFields" }]);
    expect(en["settings.themeImportMissingFields"]).toBeTruthy();
  });

  test("flags invalid hex colors", () => {
    const result = parseWindowsTerminalTheme(
      JSON.stringify({ name: "Bad", background: "#0C0C0", foreground: "#CCCCCC" }),
    );
    expect(result.themes).toEqual([]);
    expect(result.errors[0].key).toBe("settings.themeImportMissingFields");
  });

  test("sanitizes names (trim, 40-char cap) and derives the slug", () => {
    const long = "C".repeat(60);
    const result = parseWindowsTerminalTheme(
      JSON.stringify([
        { name: "  Campbell  ", background: "#0C0C0C", foreground: "#CCCCCC" },
        { name: long, background: "#0C0C0C", foreground: "#CCCCCC" },
      ]),
    );
    expect(result.themes[0].name).toBe("Campbell");
    expect(result.themes[0].id).toBe("wt-campbell");
    expect(result.themes[1].name).toHaveLength(40);
    expect(result.themes[1].id).toBe(`wt-${"c".repeat(40)}`);
  });

  test("suffixes in-batch slug collisions", () => {
    const result = parseWindowsTerminalTheme(`[${CAMPBELL}, ${CAMPBELL}, ${CAMPBELL}]`);
    expect(result.themes.map((x) => x.id)).toEqual([
      "wt-campbell",
      "wt-campbell-2",
      "wt-campbell-3",
    ]);
  });

  test("keeps the id of an existing import so saving replaces it", () => {
    const result = parseWindowsTerminalTheme(CAMPBELL, ["wt-campbell"]);
    expect(result.themes[0].id).toBe("wt-campbell");
  });

  test("suffixing skips ids already used by live imports", () => {
    const result = parseWindowsTerminalTheme(`[${CAMPBELL}, ${CAMPBELL}]`, ["wt-campbell-2"]);
    expect(result.themes.map((x) => x.id)).toEqual(["wt-campbell", "wt-campbell-3"]);
  });

  test("drops malformed optional colors but keeps the entry", () => {
    const scheme = JSON.parse(CAMPBELL);
    scheme.purple = "not-a-color";
    scheme.brightPurple = "not-a-color";
    const result = parseWindowsTerminalTheme(JSON.stringify(scheme));
    expect(result.themes).toHaveLength(1);
    // tool accent chain: purple ?? brightPurple ?? green → green
    expect(result.themes[0].swatches[3]).toBe("#13a10e");
  });
});

describe("wtThemeToTokens", () => {
  test("dark background maps to the dark color scheme", () => {
    const mapped = wtThemeToTokens(JSON.parse(CAMPBELL));
    expect(mapped.colorScheme).toBe("dark");
    expect(mapped.tokens["shadow-sm"]).toBe("none");
    expect(mapped.tokens["bg-glass"]).toBe("rgba(255, 255, 255, 0.04)");
    expect(mapped.tokens["bg-frosted"]).toBe("rgba(12, 12, 12, 0.85)");
  });

  test("light background maps to the light color scheme", () => {
    const mapped = wtThemeToTokens(JSON.parse(TANGO_LIGHT));
    expect(mapped.colorScheme).toBe("light");
    expect(mapped.tokens["shadow-md"]).toContain("rgba(0, 0, 0");
    expect(mapped.tokens["bg-glass"]).toBe("rgba(0, 0, 0, 0.03)");
    expect(mapped.tokens.border).toBe("rgba(0, 0, 0, 0.13)");
  });

  test("accent falls back blue → cyan when blue is missing", () => {
    const scheme = JSON.parse(CAMPBELL);
    delete scheme.blue;
    const mapped = wtThemeToTokens(scheme);
    expect(mapped.tokens.accent).toBe("#3a96dd");
    expect(mapped.swatches[2]).toBe("#3a96dd");
  });

  test("tool and thinking accents come from purple/cyan with fallbacks", () => {
    const mapped = wtThemeToTokens(JSON.parse(CAMPBELL));
    expect(mapped.tokens["tool-accent"]).toBe("#881798");
    expect(mapped.tokens["thinking-accent"]).toBe("#3a96dd");
    const minimal = wtThemeToTokens({
      name: "Bare",
      background: "#101010",
      foreground: "#eeeeee",
    });
    // No ANSI colors at all → foreground stands in for every accent.
    expect(minimal.tokens.accent).toBe("#eeeeee");
    expect(minimal.tokens["tool-accent"]).toBe("#eeeeee");
  });

  test("accent-text clears 3.5:1 on dark backgrounds without inventing hues", () => {
    const mapped = wtThemeToTokens(JSON.parse(CAMPBELL));
    // Raw Campbell blue is 2.39:1 on #0c0c0c — the text variant must lift.
    expect(contrastRatio("#0037da", "#0c0c0c")).toBeLessThan(3.5);
    expect(contrastRatio(mapped.tokens["accent-text"], "#0c0c0c")).toBeGreaterThanOrEqual(3.5);
    expect(mapped.tokens["accent-text"]).toMatch(/^#[0-9a-f]{6}$/);
    // Raw Campbell purple is 2.44:1 here — the tool text variant lifts too.
    expect(mapped.tokens["tool-accent-text"]).not.toBe("#881798");
    expect(contrastRatio(mapped.tokens["tool-accent-text"], "#0c0c0c")).toBeGreaterThanOrEqual(3.5);
  });

  test("light schemes keep 4.5:1 text accents and pick bubble text by contrast", () => {
    const mapped = wtThemeToTokens(JSON.parse(TANGO_LIGHT));
    expect(contrastRatio(mapped.tokens["accent-text"], "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(mapped.tokens["user-bubble"]).toBe("#3465a4");
    expect(mapped.tokens["user-bubble-text"]).toBe("#ffffff");
    expect(mapped.tokens["user-bubble-border"]).toBe("none");
  });

  test("emits the full 32-token block via tokensToCss", () => {
    const requiredTokens = [
      "bg-solid",
      "header-bg",
      "sidebar-bg-mobile",
      "bg-glass",
      "bg-glass-hover",
      "bg-glass-active",
      "bg-glass-strong",
      "bg-frosted",
      "text-primary",
      "text-secondary",
      "text-dim",
      "text-ghost",
      "accent",
      "accent-glow",
      "accent-subtle",
      "accent-text",
      "user-bubble",
      "user-bubble-text",
      "user-bubble-border",
      "tool-accent",
      "tool-accent-text",
      "tool-bg",
      "thinking-accent",
      "thinking-accent-text",
      "thinking-bg",
      "border",
      "border-hover",
      "border-bright",
      "shadow-sm",
      "shadow-md",
      "shadow-lg",
      "shadow-inset",
    ];
    const mapped = wtThemeToTokens(JSON.parse(CAMPBELL));
    const css = tokensToCss("wt-campbell", mapped);
    for (const token of requiredTokens) {
      expect(css, `missing --${token}`).toContain(`--${token}:`);
    }
    expect(css).toContain("color-scheme: dark;");
    // Every declared token is one of the known names (plus color-scheme).
    const declared = [...css.matchAll(/--([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(declared).size).toBe(requiredTokens.length);
  });
});

describe("imports cookie", () => {
  test("round-trips through the cookie", () => {
    const record = parseWindowsTerminalTheme(CAMPBELL).themes[0];
    const { saved, evicted } = saveImportedThemes([record]);
    expect(evicted).toBe(false);
    expect(saved).toHaveLength(1);
    expect(loadImportedThemes()).toEqual([record]);
  });

  test("dedupes by id (last wins, moved to the back) and evicts the oldest over the cap", () => {
    const batch = [];
    for (let i = 0; i < MAX_IMPORTED_THEMES + 2; i++) {
      batch.push(makeRecord(`wt-theme-${String(i).padStart(2, "0")}`, `Theme ${i}`));
    }
    batch.push(makeRecord("wt-theme-05", "Theme 5 re-imported"));
    const { saved, evicted } = saveImportedThemes(batch);
    expect(evicted).toBe(true);
    expect(saved).toHaveLength(MAX_IMPORTED_THEMES);
    // Oldest two (00, 01) fell off the front; 05 moved to the back.
    expect(saved[0].id).toBe("wt-theme-02");
    expect(saved.at(-1).id).toBe("wt-theme-05");
    expect(saved.at(-1).name).toBe("Theme 5 re-imported");
    expect(loadImportedThemes()).toEqual(saved);
  });

  test("ignores malformed cookie payloads", () => {
    // biome-ignore lint/suspicious/noDocumentCookie: test helper — Cookie Store API is async and unnecessary in tests
    document.cookie = `ompcot-theme-imports=${encodeURIComponent("not json")}; Max-Age=3600; Path=/; SameSite=Lax`;
    expect(loadImportedThemes()).toEqual([]);
  });
});

describe("registry merge + style injection", () => {
  test("registers imported themes into the themes map with a style element", () => {
    const record = parseWindowsTerminalTheme(CAMPBELL).themes[0];
    registerImportedThemes([record]);

    const entry = themes["wt-campbell"];
    expect(entry.group).toBe("imported");
    expect(entry.name).toBe("Campbell");
    expect(entry.dark).toBe(true);
    expect(entry.colors).toHaveLength(4);
    expect(entry.vars).toEqual({});

    const styleEl = document.getElementById("imported-themes-css");
    expect(styleEl?.tagName).toBe("STYLE");
    expect(styleEl.textContent).toContain(':root[data-theme="wt-campbell"]');
    expect(getImportedThemes().map((x) => x.id)).toEqual(["wt-campbell"]);
  });

  test("built-in and VS Code entries survive registration", () => {
    registerImportedThemes([makeRecord("wt-x", "X")]);
    expect(themes.night).toBeTruthy();
    expect(themes["vscode-dracula"]).toBeTruthy();
    expect(themes.night.group).toBeUndefined();
    expect(themes["vscode-dracula"].group).toBe("vscode");
  });

  test("applyTheme + getCurrentTheme resolve imported ids via the theme cookie", () => {
    const record = parseWindowsTerminalTheme(CAMPBELL).themes[0];
    registerImportedThemes([record]);
    applyTheme("wt-campbell");
    expect(document.documentElement.dataset.theme).toBe("wt-campbell");
    expect(getCurrentTheme()).toBe("wt-campbell");
    expect(document.cookie).toContain("ompcot-theme=wt-campbell");
  });

  test("deleting the active imported theme falls back to night", () => {
    const record = parseWindowsTerminalTheme(CAMPBELL).themes[0];
    registerImportedThemes([record]);
    applyTheme("wt-campbell");

    const result = removeImportedTheme("wt-campbell");
    expect(result.fellBack).toBe(true);
    expect(themes["wt-campbell"]).toBeUndefined();
    expect(getImportedThemes()).toEqual([]);
    expect(document.getElementById("imported-themes-css").textContent).not.toContain("wt-campbell");
    expect(document.documentElement.dataset.theme).toBe("night");
    expect(getCurrentTheme()).toBe("night");
  });

  test("deleting a non-active import leaves the current theme alone", () => {
    registerImportedThemes([
      parseWindowsTerminalTheme(CAMPBELL).themes[0],
      makeRecord("wt-other", "Other", { dark: false }),
    ]);
    applyTheme("wt-campbell");
    const result = removeImportedTheme("wt-other");
    expect(result.fellBack).toBe(false);
    expect(getCurrentTheme()).toBe("wt-campbell");
  });
});

describe("setupThemeImport UI", () => {
  test("import click parses, registers, refreshes the grid, and reports status", () => {
    const { textarea, button, status, errors } = importDom();
    let refreshed = 0;
    setupThemeImport({
      textarea,
      importBtn: button,
      statusEl: status,
      errorsEl: errors,
      onThemesChanged: () => {
        refreshed += 1;
      },
    });

    // Placeholder documents the wire format and is not translated.
    expect(textarea.placeholder).toContain('"background": "#0C0C0C"');

    textarea.value = CAMPBELL;
    button.click();

    expect(refreshed).toBe(1);
    expect(themes["wt-campbell"]).toBeTruthy();
    expect(textarea.value).toBe("");
    expect(errors.classList.contains("hidden")).toBe(true);
    expect(status.textContent).toBe(t("settings.themeImportImported", { count: 1 }));
    expect(loadImportedThemes()).toHaveLength(1);
  });

  test("invalid JSON shows the localized failure without touching the registry", () => {
    const { textarea, button, status, errors } = importDom();
    setupThemeImport({
      textarea,
      importBtn: button,
      statusEl: status,
      errorsEl: errors,
      onThemesChanged: () => {},
    });
    textarea.value = "{oops";
    button.click();
    expect(status.textContent).toBe(t("settings.themeImportFailed"));
    expect(status.dataset.tone).toBe("error");
    expect(errors.classList.contains("hidden")).toBe(false);
    expect(errors.textContent).toContain(t("settings.themeImportInvalidJson"));
    expect(getImportedThemes()).toEqual([]);
  });

  test("per-entry validation errors render inline with the entry name", () => {
    const { textarea, button, status, errors } = importDom();
    setupThemeImport({
      textarea,
      importBtn: button,
      statusEl: status,
      errorsEl: errors,
      onThemesChanged: () => {},
    });
    textarea.value = JSON.stringify({ name: "Broken", background: "#0C0C0C" });
    button.click();
    expect(status.textContent).toBe(t("settings.themeImportFailed"));
    expect(errors.textContent).toContain("Broken");
    expect(errors.textContent).toContain(t("settings.themeImportMissingFields"));
  });

  test("partial success imports the valid entries and lists the broken one", () => {
    const { textarea, button, status, errors } = importDom();
    setupThemeImport({
      textarea,
      importBtn: button,
      statusEl: status,
      errorsEl: errors,
      onThemesChanged: () => {},
    });
    textarea.value = `[${CAMPBELL}, {"name":"Nope"}]`;
    button.click();
    expect(themes["wt-campbell"]).toBeTruthy();
    expect(status.textContent).toBe(t("settings.themeImportImported", { count: 1 }));
    expect(errors.textContent).toContain("Nope");
  });
});

describe("i18n keys", () => {
  test("en and zh-CN define the theme-import key set 1:1", () => {
    const keys = [
      "settings.themeImportTitle",
      "settings.themeImportImport",
      "settings.themeGroupImported",
      "settings.themeImportInvalidJson",
      "settings.themeImportMissingFields",
      "settings.themeImportImported",
      "settings.themeImportFailed",
      "settings.themeImportDelete",
      "settings.themeImportCapReached",
    ];
    for (const key of keys) {
      expect(en[key], `en "${key}"`).toBeTruthy();
      expect(zhCN[key], `zh-CN "${key}"`).toBeTruthy();
    }
  });
});
