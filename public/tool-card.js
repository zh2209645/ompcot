/**
 * Tool Card - Renders and updates tool execution cards (collapsible)
 */

import { t } from "./i18n.js";
import { ScrollFollow } from "./scroll-follow.js";
import { nextToolStatus } from "./state.js";

// Raw statuses stay as CSS classes (`.tool-status.${status}`); only the
// visible label is translated. Unknown statuses render as-is.
function toolStatusLabel(status) {
  switch (status) {
    case "complete":
      return t("status.done");
    case "error":
      return t("status.error");
    case "pending":
    case "streaming":
      return t("status.working");
    default:
      return status;
  }
}

export class ToolCardRenderer {
  constructor(container, { statusLookup = null, follow = null } = {}) {
    this.container = container;
    this.toolCards = new Map(); // toolCallId -> element
    // Results whose card has not been drawn yet (tail-first hydration paints
    // the newest slice first, so a result can precede the message that made the
    // call). Drained by `createHistoryCard`.
    this.pendingHistoryResults = new Map();
    // Follow policy shared with the message renderer when the app passes one
    // (both render into the same scroller); a private instance keeps the
    // renderer usable on its own. See scroll-follow.js for why the decision is
    // state-based rather than recomputed at call time.
    this.follow = follow ?? new ScrollFollow(container);
    // Live status of a tool call, when the app knows one. A transcript
    // re-render (snapshot mid-run) draws history cards for calls that are
    // still executing; without this they were painted as "Done" and then
    // flipped back to "Working…" by the next live frame — the status badge
    // blinked, and kept blinking on every re-render.
    this.statusLookup = typeof statusLookup === "function" ? statusLookup : null;
  }

  createToolCard(toolExecution) {
    const { toolCallId, toolName, args, status } = toolExecution;

    // One call, one card: a replayed `tool_execution_start` (provider retry,
    // re-delivered frame) or a live start for a tool call a snapshot already
    // rendered must update the existing card, never append a second one.
    const existing = this.toolCards.get(toolCallId);
    if (existing && this.container.contains(existing)) return existing;

    const card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.toolCallId = toolCallId;

    const argsPreview = this.getArgsPreview(toolName, args);
    const argsJson = this.formatJson(args);
    const isExpanded = status === "streaming" || status === "pending";

    const isEdit =
      (toolName === "edit" || toolName === "Edit") &&
      args &&
      (args.oldText || args.old_text) &&
      (args.newText || args.new_text);

    card.innerHTML = `
      <div class="tool-card-header" onclick="this.parentElement.querySelector('.tool-card-body').classList.toggle('expanded'); this.querySelector('.tool-card-chevron').classList.toggle('expanded')">
        <div class="tool-header-left">
          <span class="tool-card-chevron${isExpanded ? " expanded" : ""}"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="tool-name">${this.escapeHtml(toolName)}</span>
          ${argsPreview ? `<span class="tool-args-preview">${this.escapeHtml(argsPreview)}</span>` : ""}
        </div>
        <div class="tool-header-right">
          <button class="tool-action-btn copy-output-btn" title="${this.escapeHtml(t("tool.copyOutput"))}" onclick="event.stopPropagation(); var t=this.closest('.tool-card').querySelector('.tool-output'); if(!t||!t.textContent.trim())return; var s=t.textContent,b=this; (navigator.clipboard?navigator.clipboard.writeText(s):new Promise(function(r){var a=document.createElement('textarea');a.value=s;a.style.cssText='position:fixed;left:-9999px';document.body.appendChild(a);a.select();document.execCommand('copy');document.body.removeChild(a);r()})).then(function(){b.classList.add('copied');setTimeout(function(){b.classList.remove('copied')},1500)})"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
          <div class="tool-status ${status}">${this.escapeHtml(toolStatusLabel(status))}</div>
        </div>
      </div>
      <div class="tool-card-body${isExpanded ? " expanded" : ""}">
        ${!isEdit && argsJson ? `<div class="tool-args">${this.escapeHtml(argsJson)}</div>` : ""}
        <div class="tool-output-wrapper">
          <div class="tool-output"></div>
        </div>
      </div>
    `;

    // Insert diff view for Edit tools
    if (isEdit) {
      const diffEl = this.renderDiff(args.oldText || args.old_text, args.newText || args.new_text);
      const body = card.querySelector(".tool-card-body");
      body.insertBefore(diffEl, body.firstChild);
    }

    this.container.appendChild(card);
    this.toolCards.set(toolCallId, card);
    // Remember the rendered status so updateToolCard can tell a real status
    // transition from the next partial-output refresh.
    card.dataset.toolStatus = status;
    this.scrollToBottom();

    return card;
  }

  updateToolCard(toolExecution) {
    let card = this.resolveCard(toolExecution.toolCallId);
    if (!card) {
      card = this.createToolCard(toolExecution);
    }

    const status = toolExecution.status;
    // Partial outputs arrive continuously (every stdout chunk). Only the
    // status TRANSITION may touch the status pill, and only the first update of
    // a live run may force the body open — doing either on every update made a
    // card the user collapsed pop back open, and re-wrote the same DOM
    // thousands of times while a command streamed. The transition is also
    // ordered: a late/replayed frame must not walk a finished pill back to
    // "Working…" and restart its pulse (see state.js nextToolStatus).
    const nextStatus = nextToolStatus(card.dataset.toolStatus, status);
    if (nextStatus !== card.dataset.toolStatus) {
      card.dataset.toolStatus = nextStatus;
      const statusElement = card.querySelector(".tool-status");
      if (statusElement) {
        statusElement.className = `tool-status ${nextStatus}`;
        statusElement.textContent = toolStatusLabel(nextStatus);
      }
      // Auto-expand once, when the tool starts producing.
      if (nextStatus === "streaming") {
        const body = card.querySelector(".tool-card-body");
        const chevron = card.querySelector(".tool-card-chevron");
        if (body) body.classList.add("expanded");
        if (chevron) chevron.classList.add("expanded");
      }
    }

    // Update output
    const outputElement = card.querySelector(".tool-output");
    const output = toolExecution.output || "";
    if (outputElement && outputElement.textContent !== output) {
      outputElement.textContent = output;
      this.scrollToBottom();
    }

    return card;
  }

  /**
   * The card a tool call is drawn by right now.
   *
   * `this.toolCards` goes stale whenever a transcript re-render replaces the
   * DOM (peek, resync, mirror snapshot): the renderer drops the index but the
   * container already holds rebuilt cards. Every later write — a late
   * `tool_execution_end`, the end-of-run sweep — must land on the element the
   * user can see; writing into the orphan instead left the visible card
   * pulsing "Working…" for good.
   */
  resolveCard(toolCallId) {
    const mapped = this.toolCards.get(toolCallId);
    if (mapped && this.container.contains(mapped)) return mapped;
    const found = this.findCardElement(toolCallId);
    if (found) this.toolCards.set(toolCallId, found);
    return found;
  }

  /** DOM lookup by `data-tool-call-id` (a scan: card counts per transcript are small). */
  findCardElement(toolCallId) {
    if (typeof toolCallId !== "string" || !toolCallId) return null;
    for (const el of this.container.querySelectorAll(".tool-card[data-tool-call-id]")) {
      if (el.dataset.toolCallId === toolCallId) return el;
    }
    return null;
  }

  finalizeToolCard(toolCallId, result, isError) {
    const card = this.resolveCard(toolCallId);
    if (!card) return;

    // Update status
    const status = isError ? "error" : "complete";
    if (card.dataset.toolStatus !== status) {
      card.dataset.toolStatus = status;
      const statusElement = card.querySelector(".tool-status");
      if (statusElement) {
        statusElement.className = `tool-status ${status}`;
        statusElement.textContent = toolStatusLabel(status);
      }
    }

    // Update output with final result
    const outputElement = card.querySelector(".tool-output");
    if (outputElement && result) {
      const output = this.formatResult(result);
      if (outputElement.textContent !== output) outputElement.textContent = output;
    }

    // Collapse completed cards (less noise)
    if (!isError) {
      const body = card.querySelector(".tool-card-body");
      const chevron = card.querySelector(".tool-card-chevron");
      if (body) body.classList.remove("expanded");
      if (chevron) chevron.classList.remove("expanded");
    }
  }

  /**
   * Create a pre-collapsed card for session history using DOM methods (no innerHTML)
   */
  createHistoryCard(toolExecution) {
    const { toolCallId, toolName, args } = toolExecution;

    // Same identity rule as createToolCard: an already rendered (connected)
    // card for this call is reused instead of duplicated.
    const existing = this.toolCards.get(toolCallId);
    if (existing && this.container.contains(existing)) return existing;

    const card = document.createElement("div");
    card.className = "tool-card";
    card.dataset.toolCallId = toolCallId;

    // Header
    const header = document.createElement("div");
    header.className = "tool-card-header";

    const headerLeft = document.createElement("div");
    headerLeft.className = "tool-header-left";

    const chevron = document.createElement("span");
    chevron.className = "tool-card-chevron";
    chevron.innerHTML =
      '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg>';
    headerLeft.appendChild(chevron);

    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = toolName;
    headerLeft.appendChild(name);

    const preview = this.getArgsPreview(toolName, args);
    if (preview) {
      const previewEl = document.createElement("span");
      previewEl.className = "tool-args-preview";
      previewEl.textContent = preview;
      headerLeft.appendChild(previewEl);
    }

    header.appendChild(headerLeft);

    // Right side: copy button + status
    const headerRight = document.createElement("div");
    headerRight.className = "tool-header-right";

    const copyBtn = document.createElement("button");
    copyBtn.className = "tool-action-btn copy-output-btn";
    copyBtn.title = t("tool.copyOutput");
    copyBtn.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const output = card.querySelector(".tool-output");
      if (!output?.textContent.trim()) return;
      const text = output.textContent;
      (navigator.clipboard
        ? navigator.clipboard.writeText(text)
        : new Promise((r) => {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;left:-9999px";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
            r();
          })
      ).then(() => {
        copyBtn.classList.add("copied");
        setTimeout(() => copyBtn.classList.remove("copied"), 1500);
      });
    });
    headerRight.appendChild(copyBtn);

    const liveStatus = this.statusLookup?.(toolCallId) || "complete";
    const status = document.createElement("div");
    status.className = `tool-status ${liveStatus}`;
    status.textContent = toolStatusLabel(liveStatus);
    headerRight.appendChild(status);

    header.appendChild(headerRight);

    // Toggle expand on click
    header.addEventListener("click", () => {
      body.classList.toggle("expanded");
      chevron.classList.toggle("expanded");
    });

    card.appendChild(header);

    // Body (collapsed by default)
    const body = document.createElement("div");
    body.className = "tool-card-body";

    const isEdit =
      (toolName === "edit" || toolName === "Edit") &&
      args &&
      (args.oldText || args.old_text) &&
      (args.newText || args.new_text);

    if (isEdit) {
      body.appendChild(
        this.renderDiff(args.oldText || args.old_text, args.newText || args.new_text),
      );
    } else {
      const argsJson = this.formatJson(args);
      if (argsJson) {
        const argsEl = document.createElement("div");
        argsEl.className = "tool-args";
        argsEl.textContent = argsJson;
        body.appendChild(argsEl);
      }
    }

    const outputEl = document.createElement("div");
    outputEl.className = "tool-output";
    body.appendChild(outputEl);

    card.appendChild(body);

    this.container.appendChild(card);
    this.toolCards.set(toolCallId, card);
    // Keep the pill and the dataset in step with what was just rendered, so
    // the next live update only writes on a real transition.
    card.dataset.toolStatus = liveStatus;

    // Tail-first hydration renders slices newest-first: a result is often drawn
    // before the tool call that produced it (the call sits at the end of an
    // earlier slice). Apply the held result now, or the card stays "Working…"
    // with an empty body — nothing else settles a card drawn from the file.
    const pending = this.pendingHistoryResults?.get(toolCallId);
    if (pending) {
      this.pendingHistoryResults.delete(toolCallId);
      this.applyHistoryResult(card, pending.result, pending.isError);
    }

    return card;
  }

  /**
   * Add result to a history card (stays collapsed).
   *
   * The card may not exist yet — see `pendingHistoryResults`. The result is
   * held and applied when the card lands.
   */
  addHistoryResult(toolCallId, result, isError) {
    const card = this.resolveCard(toolCallId);
    if (!card) {
      if (typeof toolCallId === "string" && toolCallId) {
        this.pendingHistoryResults?.set(toolCallId, { result, isError });
      }
      return;
    }
    this.applyHistoryResult(card, result, isError);
  }

  /** Settle a history card's pill and body from a session-file result. */
  applyHistoryResult(card, result, isError) {
    // The session file knows this call finished — the live lookup may still say
    // `streaming` (its end frame was suppressed while a read-only agent
    // transcript owned the surface, or lost on a saturated client), and a card
    // drawn "Working…" from that lookup never settles. So the result settles the
    // pill for BOTH outcomes, not just errors.
    const status = isError ? "error" : "complete";
    if (card.dataset.toolStatus !== status) {
      card.dataset.toolStatus = status;
      const statusEl = card.querySelector(".tool-status");
      if (statusEl) {
        statusEl.className = `tool-status ${status}`;
        statusEl.textContent = toolStatusLabel(status);
      }
    }

    const outputElement = card.querySelector(".tool-output");
    if (outputElement && result) {
      const output = this.formatResult(result);
      if (outputElement.textContent !== output) outputElement.textContent = output;
    }
  }

  /** Compact preview for the header line */
  getArgsPreview(_toolName, args) {
    if (!args || Object.keys(args).length === 0) return "";

    // Show the most relevant arg inline
    if (args.path) return args.path;
    if (args.command) return args.command.substring(0, 80);
    if (args.query) return args.query.substring(0, 60);
    if (args.url) return args.url;

    // Fallback: first string value
    for (const val of Object.values(args)) {
      if (typeof val === "string" && val.length > 0) {
        return val.substring(0, 60);
      }
    }
    return "";
  }

  formatJson(obj) {
    try {
      if (Object.keys(obj).length === 0) return "";
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }

  /** Render a simple inline diff for Edit tool */
  renderDiff(oldText, newText) {
    const container = document.createElement("div");
    container.className = "tool-diff";

    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");

    // Removed lines
    for (const line of oldLines) {
      const el = document.createElement("div");
      el.className = "diff-line diff-removed";
      el.textContent = `- ${line}`;
      container.appendChild(el);
    }

    // Added lines
    for (const line of newLines) {
      const el = document.createElement("div");
      el.className = "diff-line diff-added";
      el.textContent = `+ ${line}`;
      container.appendChild(el);
    }

    return container;
  }

  formatResult(result) {
    if (!result) return "";

    if (result.content && Array.isArray(result.content)) {
      return result.content
        .map((block) => {
          if (block.type === "text") return block.text;
          return JSON.stringify(block);
        })
        .join("\n");
    }

    return JSON.stringify(result, null, 2);
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    if (!this.container) return;
    // Instant, not the transcript's `scroll-behavior: smooth`: a smooth follow
    // lags a fast-growing card, and the lagging geometry is what used to stop
    // the auto-follow for good (see ScrollFollow).
    if (!this.follow.isPinned) return;
    requestAnimationFrame(() => {
      this.follow.jump();
    });
  }

  expandAll() {
    this.toolCards.forEach((card) => {
      card.querySelector(".tool-card-body")?.classList.add("expanded");
      card.querySelector(".tool-card-chevron")?.classList.add("expanded");
    });
  }

  collapseAll() {
    this.toolCards.forEach((card) => {
      card.querySelector(".tool-card-body")?.classList.remove("expanded");
      card.querySelector(".tool-card-chevron")?.classList.remove("expanded");
    });
  }

  clear() {
    this.toolCards.forEach((card) => {
      card.remove();
    });
    this.toolCards.clear();
    this.pendingHistoryResults?.clear();
  }
}
