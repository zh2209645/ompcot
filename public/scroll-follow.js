/**
 * Follow policy for the transcript viewport.
 *
 * The transcript scrolls in `#messages`, which is a flow sibling of the header
 * and the composer (nothing overlaps it), so "are we following the newest
 * content" decides whether a new block may scroll the feed — and whether the
 * newest content stays out of the fold when the composer's own box grows and
 * takes height away from the transcript below it.
 *
 * Two things made the old per-call check wrong:
 *
 * - `ToolCardRenderer` recomputed the distance from the bottom *at call time*.
 *   The very growth that should trigger a follow is what pushed the distance
 *   past the threshold, so the check failed exactly when it was needed: a
 *   streaming tool output (a long `bash`, a `wait`) grew for seconds with the
 *   viewport parked at the top, and the newest lines ended up behind the
 *   composer until something else happened to scroll.
 * - `MessageRenderer` latched its flag on scroll events only. Content growing
 *   below the viewport fires none, and neither does a re-render that replaces
 *   a long transcript with a short one — so a flag left `false` by an earlier
 *   scroll stayed false for good, and every later follow was a silent no-op.
 *
 * The policy here is therefore state-based, not call-time:
 *
 * - `noteScroll()` (a real scroll: user gesture, our own jump, keyboard) is the
 *   only thing that can unpin the feed;
 * - content growth never unpins (a reader who was at the bottom stays at the
 *   bottom);
 * - a container with nothing to scroll is always pinned — there is no scroll
 *   position to preserve, so a stale unpinned flag must not suppress the next
 *   follow (that is the self-heal for the second failure above, and it lives in
 *   `reset()`, which every renderer calls when it replaces the transcript,
 *   rather than in a per-frame geometry read — see `isPinned`);
 * - the viewport changing under the content is a follow, not a scroll: the
 *   composer growing (a queued-message chip, the streaming toolbar, a wrapped
 *   draft) shortens the transcript's box, the browser keeps `scrollTop` where
 *   it was, and a following reader is left 50–150px short of the content end
 *   with the newest message below the fold. A `ResizeObserver` on the container
 *   re-pins them; a reader parked mid-history keeps their position untouched.
 */
/**
 * Write a scroll offset in this frame.
 *
 * `#messages` sets `scroll-behavior: smooth`, so a plain `scrollTop` write
 * animates — and while it animates the geometry still reports "far from the
 * bottom", which is exactly what the follow policy must not read as a user
 * scroll, and what keeps a programmatic follow from being misread as the user
 * scrolling away mid-animation. The same write is how tail-first hydration
 * keeps the reader's place while earlier entries are inserted above the
 * viewport (see transcript-hydration.js).
 */
export function setScrollTopInstant(element, top) {
  if (!element) return;
  const previousBehavior = element.style?.scrollBehavior;
  if (element.style) element.style.scrollBehavior = "auto";
  element.scrollTop = top;
  if (element.style) element.style.scrollBehavior = previousBehavior;
}

/** Move a scroller to its content end in this frame. */
export function jumpToBottom(element) {
  if (!element) return;
  setScrollTopInstant(element, element.scrollHeight);
}

export const NEAR_BOTTOM_THRESHOLD = 100;

/** Distance in pixels between the viewport's bottom edge and the content end. */
export function bottomGap(container) {
  if (!container) return 0;
  const { scrollHeight, scrollTop, clientHeight } = container;
  return scrollHeight - scrollTop - clientHeight;
}

export class ScrollFollow {
  /**
   * @param {HTMLElement} container - the scrolling transcript element
   * @param {object} [options]
   * @param {number} [options.threshold] - px of slack that still counts as "at the bottom"
   * @param {boolean} [options.listen] - subscribe to the container's `scroll` events
   */
  constructor(
    container,
    {
      threshold = NEAR_BOTTOM_THRESHOLD,
      listen = true,
      ResizeObserver = globalThis.ResizeObserver,
    } = {},
  ) {
    this.container = container || null;
    this.threshold = threshold;
    // Start from what the container actually shows: a renderer constructed
    // while the transcript is empty is pinned, one attached to a viewport the
    // user had already scrolled away from is not.
    this.pinned = bottomGap(this.container) < threshold;
    if (listen && this.container?.addEventListener) {
      this.container.addEventListener("scroll", () => this.noteScroll());
    }
    // The transcript's box changes without any scroll when the composer above
    // it grows or shrinks (it is a flow sibling, so its height comes out of the
    // transcript's). The browser leaves `scrollTop` alone, which strands a
    // following reader short of the content end — re-pin them here. `isPinned`
    // is state (only a real scroll clears it), so a reader who scrolled away is
    // never moved by this.
    if (listen && this.container && typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.isPinned) this.jump();
      });
      this.resizeObserver.observe(this.container);
    }
  }

  /** Re-derive the pinned state from geometry — call from a scroll event. */
  noteScroll() {
    if (!this.container) {
      this.pinned = true;
      return;
    }
    this.pinned = bottomGap(this.container) < this.threshold;
  }

  /**
   * Whether the feed is following the newest content.
   *
   * State, never a measurement: the renderers ask this on every streamed
   * update and every rendered entry, and a geometry read here forces a
   * synchronous layout of the whole transcript — measured 28 ms on an
   * 80k-node / 3775-item session, paid per delta frame. Only a real scroll
   * (`noteScroll`) or a replaced transcript (`reset`) changes it.
   */
  get isPinned() {
    return this.pinned;
  }

  set isPinned(value) {
    this.pinned = Boolean(value);
  }

  /**
   * The transcript was replaced: a history repaint, a snapshot, a clear.
   *
   * The new content starts at its end with nothing scrolled, so the feed
   * follows it again. This is where the old getter's self-heal ("nothing to
   * scroll is pinned") belongs: the renderers tell the policy when they throw
   * the transcript away, instead of the policy asking the layout on every
   * frame whether that happened.
   */
  reset() {
    this.pinned = true;
  }

  /** Instant jump, bypassing `scroll-behavior: smooth`. */
  jump() {
    jumpToBottom(this.container);
  }

  /**
   * Jump to the newest content when the feed is following it.
   *
   * Instant, never smooth: a smooth follow is still animating while more
   * content lands, which is what the old geometry checks misread as "the user
   * scrolled away".
   *
   * @returns {boolean} true when the viewport was moved
   */
  follow() {
    if (!this.isPinned) return false;
    this.jump();
    return true;
  }
}
