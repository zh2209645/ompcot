const DEFAULT_SETTLE_DELAY_MS = 80;
const DEFAULT_SETTLE_PASSES = 2;

export function anchorHistoryToBottom(
  messagesEl,
  {
    requestAnimationFrame = window.requestAnimationFrame.bind(window),
    setTimeout = window.setTimeout.bind(window),
    settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
    settlePasses = DEFAULT_SETTLE_PASSES,
    preserveScrollTarget = false,
  } = {},
) {
  if (!messagesEl) return;
  if (preserveScrollTarget) return;

  // During history hydration, we want deterministic bottom anchoring.
  messagesEl.style.scrollBehavior = "auto";

  const applyBottomAnchor = (settling = false) => {
    // A later settle pass must not yank a reader who has left the bottom. With
    // tail-first hydration the reader may be scrolling up through history
    // within the settle window, where "anchor to the content end" is exactly
    // the wrong move — a gap of a full viewport (or an immeasurable box) means
    // they are gone, and the passes stop.
    if (settling && messagesEl.clientHeight) {
      const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      if (gap > messagesEl.clientHeight) return;
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  // Immediate anchor for already-laid-out content.
  applyBottomAnchor();

  // Keep anchoring for a short settling window so delayed ResizeObserver /
  // markdown layout work cannot leave the viewport mid-history.
  for (let pass = 0; pass < settlePasses; pass++) {
    setTimeout(
      () => {
        requestAnimationFrame(() => applyBottomAnchor(true));
      },
      settleDelayMs * (pass + 1),
    );
  }

  // Restore the default smooth behavior once settling anchors have been applied.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      messagesEl.style.scrollBehavior = "";
    });
  });
}
