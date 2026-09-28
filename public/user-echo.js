/**
 * The user messages this window drew itself.
 *
 * A message the user sends is drawn optimistically (the bubble appears as the
 * prompt goes out) and then echoes back as a `message_start` for the user role.
 * The echo must not draw a second copy — unless the window did *not* draw one,
 * in which case the echo is the only copy the user will ever see.
 *
 * Which of the two it is can only be answered by the moment the bubble was
 * drawn, so the tracker has to be told exactly then:
 *
 * - `expect(text)` — a bubble for this text is on screen (a direct send, or a
 *   queued message being flushed to the runtime);
 * - `clear()` — whatever was expected is no longer on screen (the text was
 *   rejected and re-queued, or it left the queue without being sent).
 *
 * What it must *not* be told is "this text is queued" (F23). Queueing renders
 * no bubble — the strip chip is not a transcript message — and the queued text
 * can still leave the queue through the per-item *steer now* button, which
 * delivers it without ever drawing a bubble. Remembering it at queue time then
 * suppressed the steer's own echo, and the message vanished from the GUI (the
 * runtime still received it, so the session file held a copy the window never
 * showed): reported as "clicking send-now on a queued message loses it".
 */
export function createUserEchoTracker() {
  let pending = null;

  return {
    /** A bubble for this text is on screen; its echo must not draw another. */
    expect(text) {
      pending = typeof text === "string" && text ? text : null;
    },

    /** Nothing on screen is waiting for that echo any more. */
    clear() {
      pending = null;
    },

    /**
     * Whether an echoed user message is the copy already on screen. Consumes
     * the expectation either way: one bubble, one echo.
     */
    shouldSuppress(echoText) {
      if (!pending || echoText !== pending) {
        pending = null;
        return false;
      }
      pending = null;
      return true;
    },

    /** The text a bubble is on screen for, for tests and debugging. */
    get pendingText() {
      return pending;
    },
  };
}
