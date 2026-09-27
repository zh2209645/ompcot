/**
 * Follow policy for the transcript viewport.
 *
 * The transcript scrolls in `#messages` while the composer sits on top of its
 * bottom edge (`position: absolute`), so "are we following the newest content"
 * decides both whether a new block may scroll the feed and whether the newest
 * content ends up hidden behind the input box.
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
 *   follow (that is the self-heal for the second failure above).
 */
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
  constructor(container, { threshold = NEAR_BOTTOM_THRESHOLD, listen = true } = {}) {
    this.container = container || null;
    this.threshold = threshold;
    // Start from what the container actually shows: a renderer constructed
    // while the transcript is empty is pinned, one attached to a viewport the
    // user had already scrolled away from is not.
    this.pinned = bottomGap(this.container) < threshold;
    if (listen && this.container?.addEventListener) {
      this.container.addEventListener("scroll", () => this.noteScroll());
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

  /** Whether the feed is following the newest content. */
  get isPinned() {
    // Nothing to scroll: whatever unpinned us earlier is stale, because the
    // user has no scroll position left to protect.
    if (this.container && this.container.scrollHeight <= this.container.clientHeight) {
      this.pinned = true;
    }
    return this.pinned;
  }

  set isPinned(value) {
    this.pinned = Boolean(value);
  }

  /** Instant jump, bypassing `scroll-behavior: smooth`. */
  jump() {
    const el = this.container;
    if (!el) return;
    const previousBehavior = el.style?.scrollBehavior;
    if (el.style) el.style.scrollBehavior = "auto";
    el.scrollTop = el.scrollHeight;
    if (el.style) el.style.scrollBehavior = previousBehavior;
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
