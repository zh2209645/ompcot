import { describe, expect, test } from "vitest";
import { COMPOSER_MAX_HEIGHT, setComposerText, syncComposerHeight } from "./composer-input.js";

/**
 * Textarea double: real `scrollHeight` (jsdom reports 0) and a `scrollTop` the
 * browser clamps to the scrollable range.
 */
function makeInput({ scrollHeight = 0, clientHeight = 40, value = "" } = {}) {
  const el = document.createElement("textarea");
  Object.defineProperty(el, "scrollHeight", {
    get: () => scrollHeight,
    configurable: true,
  });
  el._clientHeight = clientHeight;
  el.value = value;
  el.setSelectionRange(el.value.length, el.value.length);
  return el;
}

describe("syncComposerHeight", () => {
  test("caps the growth at the CSS max-height", () => {
    const input = makeInput({ scrollHeight: 400 });
    syncComposerHeight(input);
    expect(input.style.height).toBe(`${COMPOSER_MAX_HEIGHT}px`);
    expect(COMPOSER_MAX_HEIGHT).toBe(160);
  });

  test("grows to the content height while it fits", () => {
    const input = makeInput({ scrollHeight: 72 });
    syncComposerHeight(input);
    expect(input.style.height).toBe("72px");
  });

  test("reveals the end of a long draft when the caret is at the end", () => {
    // The reported bug: a programmatic write (restored draft, voice
    // transcript) left the box showing the first lines while the caret and the
    // end of the text were off-screen.
    const input = makeInput({ scrollHeight: 900, value: "x".repeat(900) });
    input.scrollTop = 0;
    syncComposerHeight(input);
    expect(input.scrollTop).toBe(900);
  });

  test("leaves a caret placed mid-draft where the browser put it", () => {
    const input = makeInput({ scrollHeight: 900, value: "x".repeat(900) });
    input.setSelectionRange(10, 10);
    input.scrollTop = 0;
    syncComposerHeight(input);
    expect(input.scrollTop).toBe(0);
  });

  test("honours a caller-supplied cap", () => {
    const input = makeInput({ scrollHeight: 900 });
    syncComposerHeight(input, { maxHeight: 240 });
    expect(input.style.height).toBe("240px");
  });
});

describe("setComposerText", () => {
  test("writes the draft, puts the caret at the end and shows it", () => {
    const input = makeInput({ scrollHeight: 640 });
    setComposerText(input, "restored draft\nsecond line");
    expect(input.value).toBe("restored draft\nsecond line");
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(input.style.height).toBe(`${COMPOSER_MAX_HEIGHT}px`);
    expect(input.scrollTop).toBe(640);
  });

  test("clears the draft for an empty value", () => {
    const input = makeInput({ scrollHeight: 0, value: "old" });
    setComposerText(input, "");
    expect(input.value).toBe("");
    expect(input.selectionStart).toBe(0);
  });

  test("survives a client without selection APIs", () => {
    const input = makeInput({ scrollHeight: 300 });
    input.setSelectionRange = () => {
      throw new Error("unsupported");
    };
    expect(() => setComposerText(input, "draft")).not.toThrow();
    expect(input.value).toBe("draft");
    expect(input.scrollTop).toBe(300);
  });
});
