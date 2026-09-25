import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  applyTranslations,
  getLanguage,
  onLanguageChanged,
  SUPPORTED_LANGUAGES,
  setLanguage,
  t,
} from "./i18n.js";
import { en } from "./locales/en.js";
import { zhCN } from "./locales/zh-CN.js";

function clearLangCookie() {
  // biome-ignore lint/suspicious/noDocumentCookie: test helper — Cookie Store API is async and unnecessary in tests
  document.cookie = "ompcot-lang=; Max-Age=0; Path=/; SameSite=Lax";
}

beforeEach(() => {
  clearLangCookie();
  document.documentElement.lang = "en";
  document.body.innerHTML = "";
});

describe("language detection", () => {
  test("prefers a valid cookie over navigator", () => {
    // biome-ignore lint/suspicious/noDocumentCookie: test fixture — Cookie Store API is async and unnecessary in tests
    document.cookie = "ompcot-lang=zh-CN; Max-Age=3600; Path=/; SameSite=Lax";
    expect(getLanguage()).toBe("zh-CN");
  });

  test("ignores an unknown cookie value", () => {
    // biome-ignore lint/suspicious/noDocumentCookie: test fixture — Cookie Store API is async and unnecessary in tests
    document.cookie = "ompcot-lang=klingon; Max-Age=3600; Path=/; SameSite=Lax";
    expect(getLanguage()).toBe("en");
  });

  test("matches any zh* navigator language to zh-CN", () => {
    vi.stubGlobal("navigator", { languages: ["zh-TW", "en-US"], language: "zh-TW" });
    try {
      expect(getLanguage()).toBe("zh-CN");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("falls back to English when nothing matches", () => {
    vi.stubGlobal("navigator", { languages: ["fr-FR"], language: "fr-FR" });
    try {
      expect(getLanguage()).toBe("en");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("t()", () => {
  test("translates a key in the active language", () => {
    setLanguage("en");
    expect(t("status.connected")).toBe("Connected");
    setLanguage("zh-CN");
    expect(t("status.connected")).toBe("已连接");
  });

  test("falls back to English when the key is missing from the active dictionary", () => {
    const key = "welcome.title";
    const saved = zhCN[key];
    delete zhCN[key];
    try {
      setLanguage("zh-CN");
      expect(t(key)).toBe(en[key]);
    } finally {
      zhCN[key] = saved;
    }
  });

  test("falls back to the key itself when unknown everywhere", () => {
    expect(t("no.such.key")).toBe("no.such.key");
  });

  test("interpolates {param} placeholders and keeps unknown ones literal", () => {
    setLanguage("en");
    expect(t("status.switchingModel", { model: "opus" })).toBe("Switching to opus...");
    expect(t("header.branch", { name: "main" })).toBe("Branch: main");
    expect(t("status.switchingModel", {})).toBe("Switching to {model}...");
  });
});

describe("setLanguage()", () => {
  test("writes a long-lived cross-port cookie", () => {
    setLanguage("zh-CN");
    expect(document.cookie).toContain("ompcot-lang=zh-CN");
  });

  test("updates document.documentElement.lang", () => {
    setLanguage("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    setLanguage("en");
    expect(document.documentElement.lang).toBe("en");
  });

  test("dispatches ompcot:language-changed with the new language", () => {
    const listener = vi.fn();
    window.addEventListener("ompcot:language-changed", listener);
    setLanguage("zh-CN");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].detail).toEqual({ language: "zh-CN" });
  });

  test("rejects unsupported language ids", () => {
    setLanguage("en");
    expect(setLanguage("fr")).toBe(false);
    expect(document.cookie).not.toContain("fr");
    expect(document.documentElement.lang).toBe("en");
  });

  test("onLanguageChanged returns an unsubscribe function", () => {
    const listener = vi.fn();
    const unsubscribe = onLanguageChanged(listener);
    setLanguage("zh-CN");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setLanguage("en");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("applyTranslations()", () => {
  test("fills textContent, title, placeholder and aria-label", () => {
    document.body.innerHTML = `
      <span data-i18n="status.connected">Connected</span>
      <button data-i18n-title="composer.attachImage" title="Attach image"></button>
      <input data-i18n-placeholder="composer.placeholder" placeholder="Type a message..." />
      <button data-i18n-aria-label="sidebar.refreshSessions" aria-label="Refresh sessions"></button>
    `;
    applyTranslations();
    expect(document.querySelector("[data-i18n]").textContent).toBe("Connected");
    expect(document.querySelector("[data-i18n-title]").title).toBe("Attach image");
    expect(document.querySelector("input").placeholder).toBe("Type a message...");
    expect(document.querySelector("[data-i18n-aria-label]").getAttribute("aria-label")).toBe(
      "Refresh sessions",
    );

    setLanguage("zh-CN");
    expect(document.querySelector("[data-i18n]").textContent).toBe("已连接");
    expect(document.querySelector("[data-i18n-title]").title).toBe("附加图片");
    expect(document.querySelector("input").placeholder).toBe("输入消息...");
    expect(document.querySelector("[data-i18n-aria-label]").getAttribute("aria-label")).toBe(
      "刷新会话列表",
    );
  });

  test("fills innerHTML for trusted data-i18n-html values", () => {
    document.body.innerHTML =
      '<p class="settings-help" data-i18n-html="settings.agentConfigHelp"></p>';
    applyTranslations();
    expect(document.querySelector(".settings-help").innerHTML).toContain(
      "<code>~/.omp/agent/config.yml</code>",
    );
  });

  test("keeps <html lang> in sync with the active language", () => {
    document.body.innerHTML = "";
    applyTranslations();
    expect(document.documentElement.lang).toBe("en");
    setLanguage("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });
});

describe("locale dictionaries", () => {
  test("zh-CN mirrors the English key set", () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });

  test("advertises exactly English and 简体中文", () => {
    expect(SUPPORTED_LANGUAGES).toEqual([
      { id: "en", label: "English" },
      { id: "zh-CN", label: "简体中文" },
    ]);
  });
});
