import { beforeEach, describe, expect, it } from "vitest";
import {
  applyFontSettings,
  clampFontScale,
  DEFAULT_FONT_SETTINGS,
  FONT_COOKIE,
  FONT_FAMILIES,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  fontStackFor,
  getFontSettings,
  normalizeFontSettings,
  setupFontSettings,
} from "./font-settings.js";
import { setLanguage } from "./i18n.js";

function clearFontCookie() {
  // biome-ignore lint/suspicious/noDocumentCookie: test setup needs the synchronous cookie the module reads
  document.cookie = `${FONT_COOKIE}=; Max-Age=0; Path=/`;
}

describe("font settings", () => {
  beforeEach(() => {
    clearFontCookie();
    document.documentElement.style.removeProperty("--font-ui");
    document.documentElement.style.removeProperty("--font-scale");
    setLanguage("en");
  });

  it("defaults to the system stack at 100% when nothing is stored", () => {
    expect(getFontSettings()).toEqual(DEFAULT_FONT_SETTINGS);
  });

  it("round-trips a choice through the cookie", () => {
    applyFontSettings({ family: "serif", scale: 1.15 });

    expect(getFontSettings()).toEqual({ family: "serif", scale: 1.15 });
  });

  it("clamps the scale into the supported range", () => {
    expect(clampFontScale(0.1)).toBe(FONT_SCALE_MIN);
    expect(clampFontScale(9)).toBe(FONT_SCALE_MAX);
    expect(clampFontScale("nonsense")).toBe(DEFAULT_FONT_SETTINGS.scale);
  });

  it("falls back to the default family for unknown values", () => {
    applyFontSettings({ family: "comic-sans", scale: "1.1" });

    const stored = getFontSettings();
    expect(stored.family).toBe(DEFAULT_FONT_SETTINGS.family);
    expect(stored.scale).toBe(1.1);
  });

  it("survives a corrupt cookie", () => {
    // biome-ignore lint/suspicious/noDocumentCookie: simulates a hand-edited/corrupt stored value
    document.cookie = `${FONT_COOKIE}=%7Bnot-json; Path=/`;

    expect(getFontSettings()).toEqual(DEFAULT_FONT_SETTINGS);
  });

  it("applies the family and size as CSS variables on <html>", () => {
    applyFontSettings({ family: "sans", scale: 1.25 });

    const root = document.documentElement;
    expect(root.style.getPropertyValue("--font-ui")).toBe(fontStackFor("sans"));
    expect(root.style.getPropertyValue("--font-scale")).toBe("1.25");
  });

  it("normalizeFontSettings tolerates missing/garbage input", () => {
    expect(normalizeFontSettings(null)).toEqual(DEFAULT_FONT_SETTINGS);
    expect(normalizeFontSettings("serif")).toEqual(DEFAULT_FONT_SETTINGS);
    expect(normalizeFontSettings({ family: "mono" }).scale).toBe(1);
  });

  it("every offered family resolves to a non-empty stack", () => {
    for (const family of FONT_FAMILIES) {
      expect(fontStackFor(family.id).length).toBeGreaterThan(10);
    }
  });
});

describe("font settings controls", () => {
  function buildControls() {
    document.body.innerHTML = `
      <select id="font-family-select" class="settings-select"></select>
      <input type="range" id="font-size-range" />
      <span id="font-size-value"></span>
      <button type="button" id="font-size-reset">Reset</button>`;
    return {
      selectEl: document.getElementById("font-family-select"),
      rangeEl: document.getElementById("font-size-range"),
      valueEl: document.getElementById("font-size-value"),
      resetEl: document.getElementById("font-size-reset"),
    };
  }

  beforeEach(() => {
    clearFontCookie();
    document.documentElement.style.removeProperty("--font-ui");
    document.documentElement.style.removeProperty("--font-scale");
    setLanguage("en");
  });

  it("renders the stored preference into the controls", () => {
    applyFontSettings({ family: "mono", scale: 1.2 });
    const controls = buildControls();

    setupFontSettings(controls);

    expect(controls.selectEl.value).toBe("mono");
    expect(controls.selectEl.options.length).toBe(FONT_FAMILIES.length);
    expect(controls.rangeEl.min).toBe(String(FONT_SCALE_MIN));
    expect(controls.rangeEl.max).toBe(String(FONT_SCALE_MAX));
    expect(controls.rangeEl.value).toBe("1.2");
    expect(controls.valueEl.textContent).toBe("120%");
  });

  it("a slider change applies and persists immediately", () => {
    const controls = buildControls();
    setupFontSettings(controls);

    controls.rangeEl.value = "1.35";
    controls.rangeEl.dispatchEvent(new Event("input"));

    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1.35");
    expect(getFontSettings().scale).toBe(1.35);
    expect(controls.valueEl.textContent).toBe("135%");
  });

  it("a family change applies the new stack", () => {
    const controls = buildControls();
    setupFontSettings(controls);

    controls.selectEl.value = "serif";
    controls.selectEl.dispatchEvent(new Event("change"));

    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe(
      fontStackFor("serif"),
    );
    expect(getFontSettings().family).toBe("serif");
  });

  it("reset restores the defaults on the document and in the controls", () => {
    applyFontSettings({ family: "mono", scale: 1.4 });
    const controls = buildControls();
    setupFontSettings(controls);

    controls.resetEl.click();

    expect(getFontSettings()).toEqual(DEFAULT_FONT_SETTINGS);
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1");
    expect(controls.selectEl.value).toBe(DEFAULT_FONT_SETTINGS.family);
    expect(controls.valueEl.textContent).toBe("100%");
  });

  it("labels the family options in the active language", () => {
    const controls = buildControls();
    const api = setupFontSettings(controls);
    const englishLabels = [...controls.selectEl.options].map((option) => option.textContent);

    setLanguage("zh-CN");
    api.render();

    const chineseLabels = [...controls.selectEl.options].map((option) => option.textContent);
    expect(englishLabels).toEqual(["System default", "Sans-serif", "Serif", "Monospace"]);
    expect(chineseLabels).toEqual(["系统默认", "无衬线", "衬线", "等宽"]);
  });
});
