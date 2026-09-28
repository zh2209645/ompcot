/**
 * Context-window popover (the header's `NN%` pill).
 *
 * The pill toggles the popover on **pointerdown**, not on `click`. The header is
 * an app drag region (`-webkit-app-region: drag`, with `.header-right` marked
 * `no-drag`), and a press that drifts a pixel — or a WebView2 drag that eats the
 * mouseup — never produces a `click` on the pill at all; a press that drifts
 * *off* the pill dispatches `click` on the nearest common ancestor instead, so
 * the button looked dead or needed a second press. `pointerdown` fires on press,
 * before any of that, and the outside-close listens for it too so the two can
 * never race on the same event.
 *
 * The popover also never shows a blank box: opening it without usage data (a
 * fresh session, a re-render that reset the totals) draws an explicit
 * "no usage yet" line, because an empty panel is indistinguishable from "the
 * page did not open" — the failure this interaction was reported with.
 */
import { t } from "./i18n.js";

/**
 * Compact token count for the context pill and the popover's legend
 * (12_345 → "12.3k"). Shared with the compaction notice's before/after line in
 * app.js so both spellings are the same one.
 */
export function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function setupContextViz({
  tokenUsageEl,
  contextViz,
  contextBar,
  contextLegend,
  contextVizUsed,
  contextVizTotal,
  getUsage,
  getContextWindowSize,
}) {
  const formatTokens = formatTokenCount;

  function isOpen() {
    return !contextViz.classList.contains("hidden");
  }

  function setExpanded(open) {
    if (tokenUsageEl.setAttribute) tokenUsageEl.setAttribute("aria-expanded", String(open));
  }

  function open() {
    updateContextViz();
    contextViz.classList.remove("hidden");
    setExpanded(true);
  }

  function close() {
    contextViz.classList.add("hidden");
    setExpanded(false);
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  /**
   * The honest empty state: no usage data for what is on screen. Without it the
   * popover opened as an empty box (no bar, no legend, no footer), which reads
   * as a broken popover rather than "there is nothing to report yet".
   */
  function renderEmpty() {
    contextBar.innerHTML = "";
    contextLegend.innerHTML = "";
    contextVizUsed.textContent = "";
    contextVizTotal.textContent = "";
    const empty = document.createElement("div");
    empty.className = "context-viz-empty";
    empty.textContent = t("ctx.empty");
    contextLegend.appendChild(empty);
  }

  function updateContextViz() {
    const lastUsage = getUsage();
    const contextWindowSize = getContextWindowSize();
    if (!lastUsage || !contextWindowSize) {
      renderEmpty();
      return;
    }

    const input = lastUsage.input || 0;
    const cacheRead = lastUsage.cacheRead || 0;
    const total = contextWindowSize;
    const freshInput = input;
    const totalUsed = freshInput + cacheRead;
    const free = Math.max(0, total - totalUsed);

    // Colour classes are namespaced (`context-seg-*`) so they can never collide
    // with another app class the way a bare `messages` did with the transcript.
    const segments = [
      { key: "cache", label: t("ctx.cached"), tokens: cacheRead, color: "context-seg-cache" },
      { key: "messages", label: t("ctx.input"), tokens: freshInput, color: "context-seg-messages" },
      { key: "free", label: t("ctx.available"), tokens: free, color: "context-seg-free" },
    ];

    contextBar.innerHTML = "";
    for (const seg of segments) {
      if (seg.tokens <= 0) continue;
      const pct = (seg.tokens / total) * 100;
      const el = document.createElement("div");
      el.className = `context-bar-segment ${seg.color}`;
      el.style.width = `${pct}%`;
      el.title = `${seg.label}: ${formatTokens(seg.tokens)}`;
      contextBar.appendChild(el);
    }

    contextLegend.innerHTML = "";
    for (const seg of segments) {
      const item = document.createElement("div");
      item.className = "context-legend-item";
      item.innerHTML = `
      <span class="context-legend-left">
        <span class="context-legend-dot ${seg.color}"></span>
        ${seg.label}
      </span>
      <span class="context-legend-value">${formatTokens(seg.tokens)}</span>
    `;
      contextLegend.appendChild(item);
    }

    const pct = Math.round((totalUsed / total) * 100);
    contextVizUsed.textContent = t("ctx.used", { pct });
    contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
  }

  tokenUsageEl.addEventListener("pointerdown", (event) => {
    // Press-time toggle (see the module header): stop the outside-close from
    // also seeing this press, and keep the press from selecting text or
    // starting a header drag.
    event.stopPropagation();
    event.preventDefault();
    toggle();
  });

  // Visually a button (`role="button" tabindex="0"` in the markup), so it takes
  // Enter/Space to toggle and Escape to dismiss.
  tokenUsageEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    } else if (event.key === "Escape" && isOpen()) {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    // Containment on both sides: the panel keeps clicks that land on its own
    // padding or children, and the pill covers its children too (an exact
    // `e.target === tokenUsageEl` comparison closed the popover for any nested
    // element).
    if (contextViz.contains(event.target) || tokenUsageEl.contains(event.target)) return;
    close();
  });

  setExpanded(false);
}
