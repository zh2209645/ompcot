import { describe, expect, test } from "vitest";
import { bottomGap, NEAR_BOTTOM_THRESHOLD, ScrollFollow } from "./scroll-follow.js";

/** A scroll container double with real geometry (`scrollHeight`/`clientHeight`). */
function makeContainer({ scrollHeight = 2000, clientHeight = 400, scrollTop = 0 } = {}) {
  const el = document.createElement("div");
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
  return el;
}

function setGeometry(el, { scrollHeight, clientHeight }) {
  if (scrollHeight !== undefined) {
    Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  }
  if (clientHeight !== undefined) {
    Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  }
}

describe("bottomGap", () => {
  test("measures the distance to the end of the content", () => {
    expect(
      bottomGap(makeContainer({ scrollHeight: 1000, clientHeight: 400, scrollTop: 100 })),
    ).toBe(500);
    expect(bottomGap(null)).toBe(0);
  });
});

describe("ScrollFollow", () => {
  test("starts from the geometry it is attached to", () => {
    // An empty/short transcript has nothing to scroll: pinned.
    expect(
      new ScrollFollow(makeContainer({ scrollHeight: 400, clientHeight: 400, scrollTop: 0 }))
        .isPinned,
    ).toBe(true);
    expect(
      new ScrollFollow(makeContainer({ scrollHeight: 2000, clientHeight: 400, scrollTop: 100 }))
        .isPinned,
    ).toBe(false);
  });

  test("keeps following while content grows below the viewport", () => {
    // The reported failure: a streaming tool output grew for seconds while the
    // viewport stayed parked at the top, so the newest lines sat behind the
    // composer. Growth fires no scroll event, so it must not unpin.
    const el = makeContainer({ scrollHeight: 400, clientHeight: 400, scrollTop: 0 });
    const follow = new ScrollFollow(el);
    setGeometry(el, { scrollHeight: 1500 });
    expect(follow.isPinned).toBe(true);
    expect(follow.follow()).toBe(true);
    expect(el.scrollTop).toBe(1500);
    // …even once the gap has grown far past the threshold.
    setGeometry(el, { scrollHeight: 5200 });
    expect(follow.follow()).toBe(true);
    expect(el.scrollTop).toBe(5200);
  });

  test("a real scroll away from the bottom stops the follow", () => {
    const el = makeContainer({ scrollHeight: 2000, clientHeight: 400, scrollTop: 0 });
    const follow = new ScrollFollow(el);
    el.scrollTop = 100;
    el.dispatchEvent(new Event("scroll"));
    expect(follow.isPinned).toBe(false);
    expect(follow.follow()).toBe(false);
    expect(el.scrollTop).toBe(100);
    // …and once the layout is short again, the stale unpinned state heals.
    setGeometry(el, { scrollHeight: 400, clientHeight: 400 });
    el.scrollTop = 0;
    expect(follow.isPinned).toBe(true);
  });

  test("heals a stale unpinned state that no scroll event can correct", () => {
    // A re-render can replace a long transcript with a short one: the flag is
    // still false but there is no scroll position left to protect, and the
    // clamp that follows fires no event.
    const el = makeContainer({ scrollHeight: 2000, clientHeight: 400, scrollTop: 100 });
    const follow = new ScrollFollow(el);
    setGeometry(el, { scrollHeight: 400 });
    el.scrollTop = 0;
    expect(follow.follow()).toBe(true);
    expect(el.scrollTop).toBe(400);
  });

  test("follows instantly, leaving the transcript's smooth behaviour alone", () => {
    const el = makeContainer({ scrollHeight: 2000, clientHeight: 400, scrollTop: 0 });
    el.style.scrollBehavior = "smooth";
    const follow = new ScrollFollow(el);
    expect(follow.jump()).toBeUndefined();
    expect(el.scrollTop).toBe(2000);
    expect(el.style.scrollBehavior).toBe("smooth");
  });

  test("threshold is the caller's slack, and it is the exported default", () => {
    expect(NEAR_BOTTOM_THRESHOLD).toBe(100);
    // 50px from the bottom: outside a 50px slack, inside the 100px default.
    const el = makeContainer({ scrollHeight: 500, clientHeight: 400, scrollTop: 50 });
    expect(new ScrollFollow(el, { threshold: 50 }).isPinned).toBe(false);
    expect(new ScrollFollow(el).isPinned).toBe(true);
  });

  test("isPinned is assignable, so callers can re-pin explicitly", () => {
    const el = makeContainer({ scrollHeight: 2000, clientHeight: 400, scrollTop: 0 });
    const follow = new ScrollFollow(el);
    follow.isPinned = false;
    expect(follow.isPinned).toBe(false);
    follow.isPinned = true;
    expect(follow.isPinned).toBe(true);
  });
});

describe("the transcript's box changing under the content", () => {
  /** A ResizeObserver double exposing the callback it was constructed with. */
  function makeResizeObserverDouble() {
    const callbacks = [];
    class Fake {
      constructor(callback) {
        callbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
    return {
      Fake,
      fire: () => {
        for (const cb of callbacks.splice(0)) cb([]);
      },
    };
  }

  test("re-pins a following reader when the composer takes height away", () => {
    // The composer grew (a queued-message chip, the streaming toolbar): the
    // transcript's box lost 150px, the browser kept `scrollTop`, and the
    // content end is now below the fold.
    const container = makeContainer({ scrollHeight: 2000, clientHeight: 400, scrollTop: 1600 });
    const { Fake, fire } = makeResizeObserverDouble();
    const follow = new ScrollFollow(container, { ResizeObserver: Fake });
    expect(follow.isPinned).toBe(true);

    setGeometry(container, { clientHeight: 250 });
    fire();

    expect(container.scrollTop).toBe(2000);
  });

  test("leaves a reader who scrolled away exactly where they were", () => {
    const container = makeContainer({ scrollHeight: 2000, clientHeight: 400, scrollTop: 100 });
    const { Fake, fire } = makeResizeObserverDouble();
    const follow = new ScrollFollow(container, { ResizeObserver: Fake });
    expect(follow.isPinned).toBe(false);

    setGeometry(container, { clientHeight: 250 });
    fire();

    expect(container.scrollTop).toBe(100);
  });

  test("does not observe when the policy is created without listeners", () => {
    const container = makeContainer({ scrollHeight: 2000, clientHeight: 400, scrollTop: 100 });
    const { Fake, fire } = makeResizeObserverDouble();
    const follow = new ScrollFollow(container, { listen: false, ResizeObserver: Fake });

    setGeometry(container, { clientHeight: 250 });
    fire();

    expect(container.scrollTop).toBe(100);
    expect(follow.resizeObserver).toBeUndefined();
  });
});
