import { bottomGap, jumpToBottom, NEAR_BOTTOM_THRESHOLD } from "./scroll-follow.js";

const BASE_TOP_INSET = 68;
const BASE_BOTTOM_INSET = 100;
const CHROME_GAP = 12;

function defaultMeasureHeight(element) {
  if (!element) return 0;
  const rect = element.getBoundingClientRect?.();
  return Math.ceil(rect?.height || element.offsetHeight || 0);
}

export function syncMessagesInsets({
  main,
  messages,
  header,
  inputArea,
  measureHeight = defaultMeasureHeight,
} = {}) {
  if (!main || !messages || !header || !inputArea) {
    return {
      topInset: BASE_TOP_INSET,
      bottomInset: BASE_BOTTOM_INSET,
    };
  }

  const topInset = Math.max(BASE_TOP_INSET, measureHeight(header) + CHROME_GAP);
  const bottomInset = Math.max(BASE_BOTTOM_INSET, measureHeight(inputArea) + CHROME_GAP);

  main.style.setProperty("--messages-top-inset", `${topInset}px`);
  main.style.setProperty("--messages-bottom-inset", `${bottomInset}px`);
  messages.style.setProperty("scroll-padding-top", `${topInset}px`);
  messages.style.setProperty("scroll-padding-bottom", `${bottomInset}px`);

  return { topInset, bottomInset };
}

export function setupMessagesInsets({
  main,
  messages,
  header,
  inputArea,
  requestAnimationFrame = globalThis.requestAnimationFrame?.bind(globalThis),
  threshold = NEAR_BOTTOM_THRESHOLD,
} = {}) {
  let frameId = 0;
  let lastBottomInset = null;

  const sync = () => {
    frameId = 0;
    // Read the geometry *before* the new inset lands: the scroller still has its
    // old box, so this is the position the reader was actually looking at. (The
    // composer's own element has changed already — that is what scheduled this
    // sync — which is exactly why the check cannot be made afterwards.)
    const gapBefore = bottomGap(messages);
    const { bottomInset } = syncMessagesInsets({ main, messages, header, inputArea });
    const changed = lastBottomInset !== null && bottomInset !== lastBottomInset;
    lastBottomInset = bottomInset;
    // The composer is part of the transcript's viewport, and it changes without
    // any scroll: a queued-message bar, image previews, the streaming toolbar,
    // a wrapped draft. The scroller shrinks (or grows) under a reader who was at
    // the bottom, and the content they were reading slides behind the opaque
    // composer — where nothing ever pulls it back, because content growth below
    // the fold fires no scroll event and the follow policy (rightly) only
    // follows while pinned. Re-pin here: the reader was at the bottom before the
    // box changed, so they belong at the bottom after it.
    if (changed && gapBefore < threshold) {
      // One frame later, on purpose: the inset lands as a `margin-bottom` this
      // frame, and a jump issued in the same task is clamped against the
      // *previous* box — measured live, every queued-message chip left the
      // transcript exactly one chip behind the bottom. `history-scroll-anchor`
      // carries the same double-rAF lesson for the render path.
      requestAnimationFrame(() => jumpToBottom(messages));
    }
  };

  const scheduleSync = () => {
    if (frameId) return;
    frameId = requestAnimationFrame(sync);
  };

  scheduleSync();

  const observer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          scheduleSync();
        })
      : null;

  observer?.observe(header);
  observer?.observe(inputArea);
  observer?.observe(main);

  window.addEventListener("resize", scheduleSync);
  window.visualViewport?.addEventListener("resize", scheduleSync);

  return () => {
    if (frameId) cancelAnimationFrame(frameId);
    observer?.disconnect();
    window.removeEventListener("resize", scheduleSync);
    window.visualViewport?.removeEventListener("resize", scheduleSync);
  };
}
