/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { t } from "./i18n.js";
import { renderMarkdown, renderStreamingMarkdown, renderUserMarkdown } from "./markdown.js";

export class MessageRenderer {
  constructor(container) {
    this.container = container;
    this.isNearBottom = true;

    // Track scroll position for smart auto-scroll
    this.container.addEventListener("scroll", () => {
      const threshold = 100;
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight <
        threshold;
    });
  }

  clear() {
    this.container.innerHTML = "";
    // Session switches reuse the same renderer instance. If the previous session
    // left the viewport away from bottom, keep new renders from inheriting that
    // stale anchor state (which can suppress auto-scroll until the user scrolls).
    this.isNearBottom = true;
  }

  clearSearchHighlights() {
    const marks = this.container.querySelectorAll("mark[data-search-highlight='true']");
    marks.forEach((mark) => {
      const text = document.createTextNode(mark.textContent || "");
      mark.replaceWith(text);
      text.parentNode?.normalize();
    });
  }

  highlightSearchQuery(query, { scrollToFirst = true } = {}) {
    this.clearSearchHighlights();

    const normalizedQuery = typeof query === "string" ? query.trim() : "";
    if (!normalizedQuery) return 0;

    const pattern = new RegExp(this.escapeRegExp(normalizedQuery), "gi");
    let matchCount = 0;
    let firstMatch = null;

    this.container.querySelectorAll(".message-content").forEach((content) => {
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (!node.textContent?.trim()) return NodeFilter.FILTER_REJECT;
          if (node.parentElement?.closest("mark[data-search-highlight='true']")) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });

      const textNodes = [];
      let currentNode = walker.nextNode();
      while (currentNode) {
        textNodes.push(currentNode);
        currentNode = walker.nextNode();
      }

      textNodes.forEach((node) => {
        const count = this.highlightTextNode(node, pattern, (mark) => {
          if (!firstMatch) firstMatch = mark;
        });
        matchCount += count;
      });
    });

    if (scrollToFirst && firstMatch && typeof firstMatch.scrollIntoView === "function") {
      firstMatch.scrollIntoView({ block: "center", behavior: "smooth" });
    }

    return matchCount;
  }

  renderWelcome({ workspacePath } = {}) {
    const workspaceHtml = workspacePath
      ? `<p class="hint welcome-workspace">${t("msg.currentWorkspace", {
          path: this.escapeHtml(workspacePath),
        })}</p>`
      : "";
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="icons/logo-dark.svg" alt="Ompcot logo" class="tau-icon-welcome"></div>
        <p>${t("welcome.title")}</p>
        <p class="hint">${t("welcome.hint")}</p>
        ${workspaceHtml}
        <div class="shortcuts-hint">
          <span>${t("welcome.focusInput")}</span>
          <span>${t("welcome.escAbort")}</span>
        </div>
      </div>
    `;
  }

  renderUserMessage(message, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector(".welcome");
    if (welcome) welcome.remove();

    const div = document.createElement("div");
    div.className = `message user${isHistory ? " history" : ""}`;

    let imagesHtml = "";
    if (message.images && message.images.length > 0) {
      imagesHtml =
        '<div class="message-images">' +
        message.images
          .map((img) => {
            const src = img.data.startsWith("data:")
              ? img.data
              : `data:${img.mimeType || "image/png"};base64,${img.data}`;
            return `<img class="message-image" src="${src}" alt="${t("msg.attachedImage")}" />`;
          })
          .join("") +
        "</div>";
    }

    div.innerHTML = `
      <div class="message-content">${imagesHtml}${renderUserMarkdown(message.content)}</div>
      ${this._copyButtonHtml()}
    `;
    this._setupCopyBtn(div);
    this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();
  }

  /**
   * HTML for an assistant message's content blocks: every thinking block
   * (collapsed) first, then the text.
   *
   * Shared by the history renderer (`renderAssistantMessage`) and the live
   * finalize (`finalizeStreamingMessage`) so the same message can never come
   * out with different thinking blocks depending on how it was rendered: the
   * live path used to merge every thinking segment into one "\n"-joined block
   * while a reload rendered one block per segment, so the same reasoning
   * showed up as one long block right after the run and as several short ones
   * after re-opening the session.
   */
  assistantContentHtml(content, { isStreaming = false, rawText = "" } = {}) {
    let textHtml = "";
    let thinkingHtml = "";
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text") {
          textHtml += isStreaming
            ? renderStreamingMarkdown(block.text || "")
            : renderMarkdown(block.text || "");
        } else if (block?.type === "thinking" && block.thinking) {
          thinkingHtml += this.renderThinkingBlock(block.thinking);
        }
      }
    }
    // Non-block content (or a message whose blocks carry no text) falls back to
    // the raw text streamed into `_streamingRawText`.
    if (!textHtml && rawText) {
      textHtml = isStreaming ? renderStreamingMarkdown(rawText) : renderMarkdown(rawText);
    }
    // Thinking blocks stay siblings of the text. The text gets its own block
    // while streaming so the "still writing" caret can be drawn at the end of
    // its last line (see the .streaming-text rules in style.css) instead of
    // floating on a line of its own below the content.
    return (
      thinkingHtml + (isStreaming ? `<div class="streaming-text">${textHtml}</div>` : textHtml)
    );
  }

  /**
   * Existing assistant element for a message id, ignoring detached nodes.
   *
   * Frames can repeat: a replayed/retried turn re-sends the same `message_start`
   * (or a snapshot render lands around it), and appending a second element for
   * the same message showed the same reply — and its thinking blocks — twice.
   * Rendering is therefore keyed on identity: the element that already carries
   * the id is updated in place.
   */
  findAssistantElement(messageId) {
    const wanted = typeof messageId === "string" && messageId ? messageId : null;
    if (!wanted) return null;
    for (const el of this.container.querySelectorAll(".message.assistant")) {
      if (el.dataset.messageId === wanted) return el;
    }
    return null;
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false) {
    // Remove welcome message if present
    const welcome = this.container.querySelector(".welcome");
    if (welcome) welcome.remove();

    // Reuse the element this message already has, when there is one:
    // - a known id is authoritative: a replayed or retried frame for that entry
    //   updates its element (never a second copy, never a detached leftover),
    // - without an id (the live streaming placeholder) the newest unfinished
    //   element is adopted; `findUnfinishedAssistantElement` ignores finalized
    //   turns, so distinct turns never merge into one element.
    const adopted = isStreaming
      ? (this.findAssistantElement(message.id) ?? this.findUnfinishedAssistantElement(null))
      : this.findAssistantElement(message.id);
    const div = adopted ?? document.createElement("div");
    div.className = `message assistant${isHistory ? " history" : ""}`;
    div.dataset.messageId = message.id || "streaming";

    let rawStreamingText = "";
    if (typeof message.content === "string") {
      rawStreamingText = message.content;
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "text") rawStreamingText += block.text || "";
      }
    }
    // Markdown is rendered live during streaming, so the raw text (with its
    // syntax markers) can't be recovered from the DOM at finalize time.
    if (isStreaming) {
      div._streamingRawText = rawStreamingText;
    }

    // Usage/cost info
    let usageHtml = "";
    if (message.usage?.cost) {
      const cost = message.usage.cost.total;
      if (cost > 0) {
        usageHtml = `<span class="message-usage">$${cost.toFixed(4)}</span>`;
      }
    }

    const contentHtml = this.assistantContentHtml(message.content, {
      isStreaming,
      rawText: rawStreamingText,
    });
    const streamingClass = isStreaming ? " streaming" : "";

    div.innerHTML = `
      <div class="message-content${streamingClass}">${contentHtml}</div>
      ${usageHtml}
    `;

    if (isStreaming) {
      // An adopted element may still carry the previous view's "finished"
      // affordance and lifecycle flag; the copy button is also the "this turn
      // is done" marker, so both must go when the element goes back to live.
      div.querySelector(".message-copy-btn")?.remove();
      delete div.dataset.finalized;
    } else {
      // A history render is complete content: it must never be picked up as
      // "the element to finish" by a late message_end.
      div.dataset.finalized = "true";
      this._ensureCopyButton(div);
    }
    // An adopted element already sits in the right place: only a fresh one is
    // appended, so a repeated frame can never add a second copy.
    if (!adopted) this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();

    return div;
  }

  renderThinkingBlock(thinking) {
    const id = `thinking-${Math.random().toString(36).slice(2, 8)}`;
    return `<div class="thinking-block">
<div class="thinking-toggle" onclick="var c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded')">
<span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
<span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> ${t("msg.thinking")}</span>
</div>
<div class="thinking-content" id="${id}">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  /**
   * Render the thinking segments of the in-flight message.
   *
   * `thinking` is the list of thinking-block texts the runtime reports (one
   * entry per segment; a bare string is accepted for a single segment). Each
   * segment gets its own block so the live view already has the same block
   * shape the finalized/history view will show, and a segment's text is only
   * written when it actually changed — rewriting identical text re-ran the
   * block's transitions on every delta.
   */
  updateStreamingThinking(messageElement, thinking) {
    const contentDiv = messageElement?.querySelector(".message-content");
    if (!contentDiv) return;
    // A settled element (the run was stopped via stopStreaming) is no longer a
    // live target: late deltas must not resurrect the caret or re-expand the
    // thinking block.
    if (!contentDiv.classList.contains("streaming")) return;
    const segments = (Array.isArray(thinking) ? thinking : [thinking]).filter(
      (value) => typeof value === "string" && value.length > 0,
    );
    if (segments.length === 0) return;

    const existing = Array.from(contentDiv.querySelectorAll(".streaming-thinking"));
    // Thinking blocks stay ahead of the text block, in segment order.
    const textAnchor = contentDiv.querySelector(".streaming-text");
    for (let i = 0; i < segments.length; i++) {
      let thinkingDiv = existing[i];
      if (!thinkingDiv) {
        thinkingDiv = document.createElement("div");
        thinkingDiv.className = "thinking-block streaming-thinking";
        thinkingDiv.innerHTML = `
        <div class="thinking-toggle expanded" onclick="var c=this.nextElementSibling;c.classList.toggle('expanded');this.classList.toggle('expanded')">
          <span class="chevron"><svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><path d="M2 1l4 3-4 3z"/></svg></span>
          <span class="thinking-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M12 5v13"/><path d="M6.5 9h11"/><path d="M7 13h10"/></svg> ${t("msg.thinking")}</span>
        </div>
        <div class="thinking-content expanded"></div>`;
        contentDiv.insertBefore(thinkingDiv, textAnchor);
      }
      const contentEl = thinkingDiv.querySelector(".thinking-content");
      if (contentEl && contentEl.textContent !== segments[i]) {
        contentEl.textContent = segments[i];
        this.scrollToBottom();
      }
    }
  }

  updateStreamingMessage(messageElement, content) {
    const contentDiv = messageElement?.querySelector(".message-content");
    if (!contentDiv) return;
    // See updateStreamingThinking: never write into a settled element.
    if (!contentDiv.classList.contains("streaming")) return;
    messageElement._streamingRawText = content;
    let textDiv = contentDiv.querySelector(".streaming-text");
    if (!textDiv) {
      textDiv = document.createElement("div");
      textDiv.className = "streaming-text";
      contentDiv.appendChild(textDiv);
    }
    textDiv.innerHTML = renderStreamingMarkdown(content);
    this.scrollToBottom();
  }

  /**
   * Release the live-streaming affordances without finalizing the content.
   *
   * Called when a run stops without its message_end (user abort, dropped
   * connection, out-of-order frames). Without this the element kept
   * `.streaming` — a caret blinking in the transcript forever — and its
   * thinking block stayed auto-expanded, so that block looked long next to
   * every collapsed one. The element keeps `_streamingRawText`, so a late
   * message_end still finalizes it (see findUnfinishedAssistantElement).
   */
  stopStreaming(messageElement) {
    const contentDiv = messageElement?.querySelector(".message-content");
    if (!contentDiv?.classList.contains("streaming")) return;
    contentDiv.classList.remove("streaming");
    for (const thinkingDiv of contentDiv.querySelectorAll(".streaming-thinking")) {
      thinkingDiv.classList.remove("streaming-thinking");
      thinkingDiv.querySelector(".thinking-toggle")?.classList.remove("expanded");
      thinkingDiv.querySelector(".thinking-content")?.classList.remove("expanded");
    }
    this._ensureCopyButton(messageElement);
    this.scrollToBottom();
  }

  /**
   * Last assistant element that never finished streaming.
   *
   * Matched by the `finalized` flag rather than the copy button: `stopStreaming`
   * (user abort, agent_end before message_end) settles the element and adds the
   * copy button as a *visual* affordance, and history renders carry one from
   * the start — "has a copy button" said nothing about whether the element had
   * been through `finalizeStreamingMessage`, so a late `message_end` for a
   * settled element created a second copy of the same message. `messageId`
   * narrows the match when the runtime provides the entry id.
   */
  findUnfinishedAssistantElement(messageId = null) {
    const wanted = typeof messageId === "string" && messageId ? messageId : null;
    const candidates = Array.from(this.container.querySelectorAll(".message.assistant"));
    for (let i = candidates.length - 1; i >= 0; i--) {
      const element = candidates[i];
      if (wanted && element.dataset.messageId !== wanted) continue;
      if (element.dataset.finalized !== "true") return element;
    }
    return null;
  }

  /**
   * Rebuild the streamed element from the message the runtime reported.
   *
   * `thinking` is either the message's content blocks (preferred: thinking and
   * text are then laid out exactly like the history renderer lays them out) or
   * the accumulated thinking text for callers that only have that. Passing the
   * blocks keeps the finalized transcript identical to a reloaded one — the
   * merged-string form used to collapse several thinking segments into a
   * single longer block.
   */
  finalizeStreamingMessage(messageElement, usage = null, thinking = "", id = null) {
    // Stamp the real session-entry id once known — the element carried the
    // "streaming" placeholder until now, and fork actions need the real id
    // to resolve this message (F2).
    if (typeof id === "string" && id) {
      messageElement.dataset.messageId = id;
    }
    // Lifecycle flag: this element is done, so `findUnfinishedAssistantElement`
    // stops matching it and a replayed/duplicate frame can never append a
    // second copy of the same turn (the copy button alone is not a state
    // marker — `stopStreaming` adds one too).
    messageElement.dataset.finalized = "true";
    const contentDiv = messageElement.querySelector(".message-content");
    if (contentDiv) {
      contentDiv.classList.remove("streaming");
      // Rebuild only for an element that still holds streamed content: a
      // duplicate message_end must not re-render an already finalized message
      // from its DOM text (which has lost the markdown syntax markers).
      const hasRawText = typeof messageElement._streamingRawText === "string";
      const streamingText = contentDiv.querySelector(".streaming-text");
      if (hasRawText || streamingText) {
        // Prefer the raw text stashed during streaming — the DOM now holds
        // rendered markdown, so textContent has lost the syntax markers.
        const rawText = hasRawText ? messageElement._streamingRawText : streamingText.textContent;
        messageElement._streamingRawText = null;

        contentDiv.innerHTML = Array.isArray(thinking)
          ? this.assistantContentHtml(thinking, { rawText })
          : (thinking ? this.renderThinkingBlock(thinking) : "") + renderMarkdown(rawText);
      }
    }

    // Add copy button after streaming finishes
    this._ensureCopyButton(messageElement);

    // The finalized markdown can be taller than the streamed preview (code
    // blocks, lists, tables all expand), so re-anchor when we were following —
    // otherwise the last block ends up below the fold, behind the composer.
    this.scrollToBottom();

    // Add usage info if available
    if (usage?.cost && usage.cost.total > 0) {
      if (!messageElement.querySelector(".message-usage")) {
        const span = document.createElement("span");
        span.className = "message-usage";
        span.textContent = `$${usage.cost.total.toFixed(4)}`;
        messageElement.appendChild(span);
      }
    }
  }

  _copyButtonHtml() {
    return `<button class="message-copy-btn" aria-label="${t("msg.copyMessage")}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
  }

  /**
   * The copy button doubles as the "this message is finished" marker: unfinished
   * elements are exactly the ones without it (see findUnfinishedAssistantElement).
   */
  _ensureCopyButton(messageElement) {
    if (messageElement.querySelector(".message-copy-btn")) return;
    messageElement.insertAdjacentHTML("beforeend", this._copyButtonHtml());
    this._setupCopyBtn(messageElement);
  }

  renderSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "system-message";
    div.textContent = text;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage) {
    const div = document.createElement("div");
    div.className = "error-message";
    div.textContent = `⚠️ ${errorMessage}`;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  _setupCopyBtn(messageEl) {
    const btn = messageEl.querySelector(".message-copy-btn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const content = messageEl.querySelector(".message-content");
      if (!content) return;
      const text = content.textContent;
      // Fallback for non-HTTPS (LAN access)
      const copyText = (t) => {
        if (navigator.clipboard) return navigator.clipboard.writeText(t);
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.cssText = "position:fixed;left:-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        return Promise.resolve();
      };
      copyText(text).then(() => {
        btn.classList.add("copied");
        setTimeout(() => {
          btn.classList.remove("copied");
        }, 1500);
      });
    });
  }

  highlightTextNode(node, pattern, onMatch) {
    const text = node.textContent || "";
    const regex = new RegExp(pattern.source, pattern.flags);
    let lastIndex = 0;
    let matchCount = 0;
    let match = regex.exec(text);
    if (!match) return 0;

    const fragment = document.createDocumentFragment();
    while (match) {
      const [matchedText] = match;
      const start = match.index;
      if (start > lastIndex) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
      }

      const mark = document.createElement("mark");
      mark.dataset.searchHighlight = "true";
      mark.textContent = matchedText;
      fragment.appendChild(mark);
      if (typeof onMatch === "function") onMatch(mark);

      matchCount += 1;
      lastIndex = start + matchedText.length;
      match = regex.exec(text);
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    node.replaceWith(fragment);
    return matchCount;
  }

  escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.isNearBottom) {
      requestAnimationFrame(() => {
        this.jumpToBottom();
      });
    }
  }

  /**
   * Pin the viewport to the newest content, bypassing the container's
   * `scroll-behavior: smooth`.
   *
   * A smooth follow cannot keep up with a stream (or with a block that lands in
   * one big delta): while the animation runs, the geometry still reports "far
   * from the bottom", which flips `isNearBottom` false and silently stops every
   * later follow — the feed froze while the run was still going, and the
   * newest block stayed under the composer. An instant jump lands on the
   * bottom in the same frame, so the guard stays truthful.
   */
  jumpToBottom() {
    const el = this.container;
    const previousBehavior = el.style.scrollBehavior;
    el.style.scrollBehavior = "auto";
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = previousBehavior;
  }
}
