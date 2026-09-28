/**
 * Tail-first transcript hydration.
 *
 * A long session used to be painted from its first entry forward, in time
 * slices: the newest message — the one the reader came for — appeared only
 * after every earlier entry had been laid out, so on a huge session the
 * viewport first sat at the *top* of a half-built transcript (reading the
 * session's oldest lines) and then jumped to the end when the last slice
 * landed. Every web chat client does the opposite, and so does this module:
 * paint the newest entries first, anchor the viewport to them, and hydrate
 * earlier entries as the reader scrolls up.
 *
 * The rules:
 *
 * - the newest slice paints first and the caller anchors the viewport to it
 *   (`onTailRendered`); the rest of the session is not laid out at all until
 *   it is asked for;
 * - an earlier slice is prepended *above* what is on screen, with `scrollTop`
 *   compensated by exactly the height that was inserted, so whatever the
 *   reader is looking at stays put. `#messages` disables the browser's own
 *   scroll anchoring (`overflow-anchor: none`) — otherwise both would
 *   compensate and the view would slide down by the inserted height;
 * - a load is triggered when the reader comes within `triggerPx` of the top,
 *   and repeated while the transcript is shorter than the viewport (a tail
 *   slice of short entries must not leave a half-empty, unscrollable screen);
 * - a top row is the manual affordance and the "loading…" indicator, and it
 *   disappears once the session's first entry is on screen;
 * - starting a new hydration disposes the previous one. The callers' view
 *   tokens cover session selections, but a resync or a peek renders without
 *   one, and a stale hydration must never prepend into the view that replaced
 *   it — nor leave its row behind in a transcript somebody else repainted.
 *
 * The slice renderers append (they are the same renderers the forward path
 * uses), so a slice is rendered at the end and then *moved* into place. Moving
 * nodes keeps their listeners and identity attributes, and render + move happen
 * in one task, so the temporary position never paints.
 */
import { setScrollTopInstant } from "./scroll-follow.js";

export const HYDRATION_SLICE = 80;
export const EARLIER_TRIGGER_PX = 240;

// The hydration that owns `#messages`, if any. `cancelHydration` is called by
// every render that takes the surface over (see `renderSessionHistory`).
let activeHydrator = null;

/** Stop the hydration that owns the transcript, if any. */
export function cancelHydration() {
  activeHydrator?.dispose();
  activeHydrator = null;
}

/**
 * Render `entries` into `container` newest-first.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container - the scrolling transcript element
 * @param {Array} deps.entries - raw session entries (already id-stamped)
 * @param {(slice: Array) => void} deps.render - paints one slice, appending
 * @param {string} [deps.earlierLabel] - row text while idle
 * @param {string} [deps.loadingLabel] - row text while a slice is loading
 * @param {() => void} [deps.onTailRendered] - called once the newest slice is
 *   on screen and before any earlier slice is pulled in (the caller anchors)
 * @param {() => boolean} [deps.shouldContinue] - abort check (view tokens)
 * @param {number} [deps.sliceSize] - entries per slice
 * @param {number} [deps.triggerPx] - distance from the top that loads earlier
 * @param {() => boolean} [deps.isViewportFilled] - "the transcript can scroll
 *   far enough"; injectable because jsdom reports 0 for every box
 * @param {() => Promise<void>} [deps.yieldTo] - scheduler between slices
 * @returns {Promise<{loaded: number, total: number}>} after the newest slice
 *   (and any fill-up slices) are on screen; earlier slices load on demand.
 */
export async function hydrateTranscriptTailFirst({
  container,
  entries,
  render,
  earlierLabel = "",
  loadingLabel = "",
  onTailRendered = null,
  shouldContinue = null,
  sliceSize = HYDRATION_SLICE,
  triggerPx = EARLIER_TRIGGER_PX,
  isViewportFilled = null,
  yieldTo = null,
}) {
  const list = Array.isArray(entries) ? entries : [];
  const total = list.length;

  let nextEnd = total; // entries [0, nextEnd) are not on screen yet
  let painted = false; // has this hydration put anything on screen yet?
  let loading = false;
  let disposed = false;
  let sentinel = null;

  const pause = yieldTo || (() => new Promise((resolve) => setTimeout(resolve, 0)));
  // No measurable box (headless / detached) must not spin the fill loop.
  const filled =
    isViewportFilled ||
    (() => !container?.clientHeight || container.scrollHeight > container.clientHeight * 1.5);

  const hydrate = {
    get loaded() {
      return total - nextEnd;
    },
    get total() {
      return total;
    },
    get disposed() {
      return disposed;
    },
    dispose,
    loadEarlier,
  };

  function dispose() {
    if (disposed) return;
    disposed = true;
    container?.removeEventListener?.("scroll", onScroll);
    sentinel?.remove?.();
    sentinel = null;
    if (activeHydrator === hydrate) activeHydrator = null;
  }

  function onScroll() {
    if (disposed || loading || nextEnd <= 0) return;
    if ((container?.scrollTop ?? 0) <= triggerPx) void loadEarlier();
  }

  function makeSentinel() {
    const doc = container.ownerDocument || globalThis.document;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "earlier-loader";
    button.dataset.earlierLoader = "true";
    const label = doc.createElement("span");
    label.className = "earlier-loader-label";
    label.textContent = earlierLabel;
    button.appendChild(label);
    button.addEventListener("click", () => void loadEarlier());
    return button;
  }

  /** Swap the row between its idle and loading text (and its busy state). */
  function setSentinelState(busy) {
    if (!sentinel) return;
    const label = sentinel.querySelector(".earlier-loader-label");
    const text = busy ? loadingLabel : earlierLabel;
    if (label && label.textContent !== text) label.textContent = text;
    if (busy) sentinel.setAttribute("aria-busy", "true");
    else sentinel.removeAttribute("aria-busy");
  }

  function mountSentinel() {
    if (disposed || sentinel || nextEnd <= 0 || !container) return;
    sentinel = makeSentinel();
    container.insertBefore(sentinel, container.firstChild ?? null);
  }

  /** Pull in one earlier slice and give the reader's anchor back its height. */
  async function loadEarlier() {
    if (disposed || loading || nextEnd <= 0) return false;
    // The transcript was emptied out from under this hydration (a session
    // switch, a failed load that fell back to the welcome view). Prepending
    // into whatever replaced it would be another session's history — stop, and
    // let the render that owns the surface hydrate it instead.
    if (painted && container && !container.firstElementChild) {
      dispose();
      return false;
    }
    if (shouldContinue && !shouldContinue()) {
      dispose();
      return false;
    }
    loading = true;
    const start = Math.max(0, nextEnd - sliceSize);
    const slice = list.slice(start, nextEnd);
    // Where the slice goes: above everything that is already on screen, below
    // the row. Only a later slice moves — the first paint lands where it is
    // (the caller cleared the transcript for it).
    const anchorNode =
      sentinel?.parentNode === container ? sentinel.nextSibling : (container?.firstChild ?? null);
    const heightBefore = container?.scrollHeight ?? 0;
    const topBefore = container?.scrollTop ?? 0;
    const countBefore = container?.children.length ?? 0;

    setSentinelState(true);
    try {
      render(slice);
    } catch (err) {
      // One bad entry must not leave the transcript half-hydrated with a row
      // that never finishes: stop here and say so. (The caller's render walk
      // is the same code the forward path runs, so this only guards against a
      // session file the renderers cannot draw.)
      console.error("[Hydration] slice render failed:", err);
      loading = false;
      dispose();
      return false;
    }

    if (painted && container) {
      // `anchorNode` is the row's next sibling, or the first entry when the
      // session has no row left; `null` appends, which is correct when the row
      // (or nothing) is all that is on screen.
      const added = Array.from(container.children).slice(countBefore);
      for (const node of added) container.insertBefore(node, anchorNode);
      const delta = (container.scrollHeight ?? 0) - heightBefore;
      if (delta > 0) setScrollTopInstant(container, topBefore + delta);
    }
    painted = true;
    nextEnd = start;
    loading = false;

    if (nextEnd <= 0) {
      sentinel?.remove?.();
      sentinel = null;
    } else {
      setSentinelState(false);
    }
    return true;
  }

  activeHydrator?.dispose();
  activeHydrator = hydrate;

  if (total === 0 || !container || typeof render !== "function") {
    return { loaded: 0, total };
  }

  container.addEventListener?.("scroll", onScroll);
  await loadEarlier(); // the newest entries first
  mountSentinel();
  // A tail slice that threw disposed this hydration: there is nothing to
  // anchor to and nothing to fill.
  if (!disposed) {
    onTailRendered?.();

    // A tail of short entries can leave the transcript shorter than the
    // viewport — nothing to scroll, so nothing could ever trigger the next
    // slice. Pull earlier slices in until the viewport is covered.
    while (nextEnd > 0 && !filled()) {
      await pause();
      if (!(await loadEarlier())) break;
    }
  }

  return { loaded: total - nextEnd, total };
}
