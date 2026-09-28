import { describe, expect, test } from "vitest";
import { createUserEchoTracker } from "./user-echo.js";

describe("createUserEchoTracker", () => {
  test("suppresses the echo of a bubble this window drew, once", () => {
    const echo = createUserEchoTracker();
    echo.expect("hello");

    expect(echo.shouldSuppress("hello")).toBe(true);
    // One bubble, one echo: a repeated frame is no longer this window's copy.
    expect(echo.shouldSuppress("hello")).toBe(false);
    expect(echo.pendingText).toBeNull();
  });

  test("never suppresses text this window did not draw", () => {
    const echo = createUserEchoTracker();

    // Nothing was drawn (the normal case for a message queued in another
    // window, and for the steer's own echo — F23).
    expect(echo.shouldSuppress("queued then steered")).toBe(false);

    echo.expect("sent normally");
    expect(echo.shouldSuppress("something else")).toBe(false);
    expect(echo.shouldSuppress("sent normally")).toBe(false);
  });

  test("a message that left the queue without being sent is not suppressed", () => {
    // The reported bug, at the unit level: queueing renders no bubble, so the
    // tracker must not be told about it — and if anything did, the strip's
    // steer/cancel actions clear it. Whatever the sequence, the echo of a
    // message the window never drew has to render.
    const echo = createUserEchoTracker();
    echo.expect("queued text"); // a bubble that a rejection removed again
    echo.clear();

    expect(echo.shouldSuppress("queued text")).toBe(false);
    expect(echo.pendingText).toBeNull();
  });

  test("a queued message flushed to the runtime suppresses its own echo", () => {
    // The other half of the rule: when the queue flushes, *that* is the moment
    // a bubble is drawn, so that is the moment to expect the echo.
    const echo = createUserEchoTracker();
    echo.expect("flushed text");

    expect(echo.shouldSuppress("flushed text")).toBe(true);
  });
});
