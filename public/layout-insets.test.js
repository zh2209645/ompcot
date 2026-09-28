import { afterEach, describe, expect, test, vi } from "vitest";
import { setupMessagesInsets, syncMessagesInsets } from "./layout-insets.js";

describe("syncMessagesInsets", () => {
  test("uses the live header and composer heights instead of hard-coded message padding", () => {
    const main = document.createElement("div");
    const messages = document.createElement("div");
    const header = document.createElement("div");
    const inputArea = document.createElement("div");

    syncMessagesInsets({
      main,
      messages,
      header,
      inputArea,
      measureHeight: (element) => {
        if (element === header) return 92;
        if (element === inputArea) return 118;
        return 0;
      },
    });

    expect(main.style.getPropertyValue("--messages-top-inset")).toBe("104px");
    expect(main.style.getPropertyValue("--messages-bottom-inset")).toBe("130px");
    expect(messages.style.getPropertyValue("scroll-padding-top")).toBe("104px");
    expect(messages.style.getPropertyValue("scroll-padding-bottom")).toBe("130px");
  });

  test("never shrinks below the base safe insets", () => {
    const main = document.createElement("div");
    const messages = document.createElement("div");
    const header = document.createElement("div");
    const inputArea = document.createElement("div");

    syncMessagesInsets({
      main,
      messages,
      header,
      inputArea,
      measureHeight: () => 20,
    });

    expect(main.style.getPropertyValue("--messages-top-inset")).toBe("68px");
    expect(main.style.getPropertyValue("--messages-bottom-inset")).toBe("100px");
  });
});

describe("setupMessagesInsets", () => {
  /**
   * A scroller whose geometry the test controls (jsdom lays nothing out), with
   * the one coupling that matters here: `#messages` is trimmed by the inset, so
   * a taller composer means a shorter viewport for the same content.
   */
  function makeHarness({ gap, inputHeight = 220 }) {
    const frames = [];
    const main = document.createElement("div");
    const header = document.createElement("div");
    const inputArea = document.createElement("div");
    const height = { value: inputHeight };
    const messages = document.createElement("div");
    const state = { scrollHeight: 1000, scrollTop: 600 - gap };
    const inset = () =>
      Number(main.style.getPropertyValue("--messages-bottom-inset").replace("px", "")) || 100;
    Object.defineProperty(messages, "scrollHeight", { get: () => state.scrollHeight });
    Object.defineProperty(messages, "clientHeight", { get: () => 500 - inset() });
    Object.defineProperty(messages, "scrollTop", {
      get: () => state.scrollTop,
      // A real scroller clamps writes to its own range.
      set: (v) => {
        state.scrollTop = Math.max(0, Math.min(v, state.scrollHeight - (500 - inset())));
      },
    });

    vi.spyOn(header, "getBoundingClientRect").mockReturnValue({ height: 80 });
    vi.spyOn(inputArea, "getBoundingClientRect").mockImplementation(() => ({
      height: height.value,
    }));

    const dispose = setupMessagesInsets({
      main,
      messages,
      header,
      inputArea,
      requestAnimationFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
    });
    const flush = () => {
      const queued = frames.splice(0);
      for (const cb of queued) cb(0);
    };
    const settle = () => {
      flush();
      flush(); // the re-pin is deliberately one frame behind the inset change
    };
    flush(); // baseline sync: the app measures its chrome once at startup
    // Park the reader `gap` px above the content end (0 = following the feed).
    state.scrollTop = state.scrollHeight - (500 - inset()) - gap;
    // What the ResizeObserver does in the browser when the composer's box
    // changes: schedule a sync on the next frame.
    const resizeTo = (value) => {
      height.value = value;
      window.dispatchEvent(new Event("resize"));
      settle();
    };
    return {
      main,
      messages,
      height,
      flush,
      settle,
      resizeTo,
      dispose,
      maxScroll: () => messages.scrollHeight - messages.clientHeight,
    };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("re-pins a reader who was at the bottom when the composer grows under them", () => {
    const h = makeHarness({ gap: 0 });
    expect(h.messages.scrollTop).toBe(h.maxScroll());

    // A queued-message bar / image previews / the streaming toolbar appear: the
    // scroller's box shrinks by the inset delta with no scroll of its own.
    h.resizeTo(340);

    expect(h.main.style.getPropertyValue("--messages-bottom-inset")).toBe("352px");
    // Re-pinned: the content end is visible again, not 100px behind the composer.
    expect(h.messages.scrollTop).toBe(h.maxScroll());
    h.dispose();
  });

  test("leaves a reader who had scrolled away exactly where they were", () => {
    const h = makeHarness({ gap: 500 });
    const parked = h.messages.scrollTop;
    h.resizeTo(340);

    expect(h.messages.scrollTop).toBe(parked);
    h.dispose();
  });

  test("does nothing when the composer's box did not change", () => {
    const h = makeHarness({ gap: 0 });
    h.messages.scrollTop = 300;
    h.settle();

    expect(h.messages.scrollTop).toBe(300);
    h.dispose();
  });
});
