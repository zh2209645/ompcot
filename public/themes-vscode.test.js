import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { en } from "./locales/en.js";
import { zhCN } from "./locales/zh-CN.js";
import { getCurrentTheme, themes } from "./themes.js";

const themeCss = readFileSync(join(process.cwd(), "public", "style-theme.css"), "utf8");

// The full per-theme token set — derived from the existing built-in blocks
// (every `:root[data-theme]` block must define all of these). `color-scheme`
// is not a custom property; it's asserted separately below.
const REQUIRED_TOKENS = [
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

/**
 * Parse every `:root[data-theme="<id>"] { ... }` block into
 * `{ id, colorScheme, tokens: Set<string> }`. Blocks contain no nested
 * braces (only parens), so matching to the first `}` is exact.
 */
function parseThemeBlocks(css) {
  const blocks = new Map();
  for (const match of css.matchAll(/data-theme="([^"]+)"\]\s*\{([^}]*)\}/g)) {
    const id = match[1];
    const body = match[2];
    const tokens = new Set([...body.matchAll(/--([a-z-]+)\s*:/g)].map((m) => m[1]));
    const scheme = body.match(/color-scheme:\s*(dark|light)/)?.[1] ?? null;
    blocks.set(id, { colorScheme: scheme, tokens });
  }
  return blocks;
}

function clearThemeCookie() {
  // biome-ignore lint/suspicious/noDocumentCookie: test helper — Cookie Store API is async and unnecessary in tests
  document.cookie = "ompcot-theme=; Max-Age=0; Path=/; SameSite=Lax";
}

beforeEach(() => {
  clearThemeCookie();
});

describe("theme registry ↔ CSS parity", () => {
  const blocks = parseThemeBlocks(themeCss);

  test("every theme id has a :root[data-theme] CSS block", () => {
    for (const id of Object.keys(themes)) {
      expect(blocks.has(id), `missing CSS block for theme "${id}"`).toBe(true);
    }
  });

  test("every CSS data-theme block maps to a registered theme", () => {
    for (const id of blocks.keys()) {
      expect(themes[id], `CSS block "${id}" has no themes.js entry`).toBeTruthy();
    }
  });

  test("every block sets the full required token set", () => {
    for (const [id, { tokens }] of blocks) {
      const missing = REQUIRED_TOKENS.filter((t) => !tokens.has(t));
      expect(missing, `theme "${id}" is missing tokens`).toEqual([]);
    }
  });

  test("color-scheme matches the theme's dark flag", () => {
    for (const [id, theme] of Object.entries(themes)) {
      const { colorScheme } = blocks.get(id);
      expect(colorScheme, `theme "${id}"`).toBe(theme.dark ? "dark" : "light");
    }
  });
});

describe("theme registry", () => {
  test("builtin entries come first, VS Code schemes after", () => {
    const ids = Object.keys(themes);
    const groupOf = (id) => themes[id].group ?? "builtin";
    const firstVscode = ids.findIndex((id) => groupOf(id) === "vscode");
    expect(firstVscode).toBeGreaterThan(-1);
    expect(ids.slice(firstVscode).every((id) => groupOf(id) === "vscode")).toBe(true);
  });

  test("group values are valid and both groups are populated", () => {
    const groups = { builtin: 0, vscode: 0 };
    for (const theme of Object.values(themes)) {
      const group = theme.group ?? "builtin";
      expect(["builtin", "vscode"]).toContain(group);
      groups[group] += 1;
    }
    expect(groups.builtin).toBe(6);
    expect(groups.vscode).toBe(9);
  });

  test("each theme carries 4 hex swatches, a name, and empty vars", () => {
    for (const [id, theme] of Object.entries(themes)) {
      expect(typeof theme.name, `theme "${id}" name`).toBe("string");
      expect(typeof theme.dark, `theme "${id}" dark`).toBe("boolean");
      expect(theme.colors, `theme "${id}" colors`).toHaveLength(4);
      for (const c of theme.colors) {
        expect(c, `theme "${id}" swatch`).toMatch(/^#[0-9a-f]{6}$/i);
      }
      expect(theme.vars, `theme "${id}" vars`).toEqual({});
    }
  });

  test("getCurrentTheme falls back to night when nothing is saved", () => {
    expect(getCurrentTheme()).toBe("night");
  });
});

describe("theme group i18n", () => {
  test("en and zh-CN both define the group headings", () => {
    for (const key of ["settings.themeGroupBuiltin", "settings.themeGroupVscode"]) {
      expect(en[key], `en "${key}"`).toBeTruthy();
      expect(zhCN[key], `zh-CN "${key}"`).toBeTruthy();
    }
  });

  test("VS Code theme names stay English product names in zh-CN-land", () => {
    // Names render verbatim (not via i18n); just assert the canonical ones.
    expect(themes["vscode-dark-plus"].name).toBe("Dark+");
    expect(themes["vscode-one-dark-pro"].name).toBe("One Dark Pro");
    expect(themes["vscode-github-dark"].name).toBe("GitHub Dark");
  });
});
