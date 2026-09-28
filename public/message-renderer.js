/**
 * Message Renderer - Renders chat messages with markdown support
 */

import { debugLog, logDebug } from "./debug-log.js";
import { t } from "./i18n.js";
import { renderMarkdown, renderStreamingMarkdown, renderUserMarkdown } from "./markdown.js";
import { ScrollFollow } from "./scroll-follow.js";

/**
 * How often the census may compare message text (the one duplicate key that
 * cannot be counted incrementally). See `reportDuplicateMessages`.
 */
export const TEXT_DUPLICATE_SCAN_MS = 2000;

/**
 * Session-notice types written for the *agent*, not for the person watching.
 *
 * omp persists the notices its TUI shows as `custom_message` entries with
 * `display: true`, and the GUI rendered every one of them. Some are nudges the
 * runtime hands the model mid-run, and the model is the only intended reader:
 * `lsp-late-diagnostic` is the LSP tooling telling the agent that diagnostics
 * arrived after its edit returned — the reported flood rendered 22 of them in
 * one turn, each a paragraph of `[biome]` output addressed at the model — and
 * `mid-run-todo-nudge` is the todo reminder (already `display: false` in this
 * build; listed so a future build that flips the flag cannot leak it).
 *
 * Notices the person cares about keep rendering: `async-result` (a background
 * job's result was delivered) and `launch-completion` (a supervised process
 * ended). The list lives here rather than in the extension because every paint
 * path — history, snapshot, resync, and the live `session_notice` frame — goes
 * through `renderNotice`; the entries stay in the session file and in the debug
 * bundle's frame log, so hiding is purely a display decision.
 */
export const AGENT_ONLY_NOTICE_TYPES = new Set(["lsp-late-diagnostic", "mid-run-todo-nudge"]);

/** Increment/decrement a duplicate counter, dropping it at zero. */
function bumpCount(map, key, delta) {
  const next = (map.get(key) || 0) + delta;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}

export class MessageRenderer {
  constructor(container, { follow = null } = {}) {
    this.container = container;
    // The follow policy (pinned state, self-heal, instant jumps) lives in
    // scroll-follow.js: a guard recomputed at call time skipped the follow
    // exactly when content growth had just pushed the newest block away, and a
    // flag latched on scroll events alone stayed false after a re-render
    // replaced a long transcript with a short one. The app passes the same
    // instance to the tool-card renderer — both draw into one scroller.
    this.follow = follow ?? new ScrollFollow(container);
    // Identity index for the assistant elements this renderer created — the
    // finders below, and the census, key on entry id / runtime timestamp and
    // used to walk `container.querySelectorAll(".message.assistant")` per
    // lookup. That is O(n) per rendered entry and per streamed frame: hydrating
    // a 3775-item transcript measured 5470 scans / 1.06 s, with the per-entry
    // census adding a full-text pass over every message on top. The maps are
    // authoritative (every `.message.assistant` element is created here) and
    // are reset by `clear()`.
    this.assistantOrder = [];
    this.assistantsById = new Map();
    this.assistantsByTs = new Map();
    // Duplicate bookkeeping for the census: how many *elements* claim each
    // entry id / timestamp. Maintained incrementally (ids are written once at
    // render and once when a late id finalizes), so the census never has to
    // scan or read message text to answer "is anything drawn twice".
    this.assistantIdCounts = new Map();
    this.assistantTsCounts = new Map();
    this.userCount = 0;
    this.lastTextDuplicateScan = 0;
    this.followFrame = null;
  }

  /**
   * Register (or re-register) an assistant element in the identity index.
   *
   * Called for every render; `order` only takes elements this renderer created
   * (an adopted element is already in it — the hydration moves nodes, and the
   * index follows the element, not its position).
   */
  indexAssistant(element, { created = false } = {}) {
    if (created) this.assistantOrder.push(element);
    const id = element.dataset.messageId || "";
    const ts = element.dataset.messageTs || "";
    if (element._indexedId !== id) {
      if (element._indexedId) bumpCount(this.assistantIdCounts, element._indexedId, -1);
      element._indexedId = id;
      if (id) bumpCount(this.assistantIdCounts, id, 1);
    }
    if (id) this.assistantsById.set(id, element);
    if (element._indexedTs !== ts) {
      if (element._indexedTs) bumpCount(this.assistantTsCounts, element._indexedTs, -1);
      element._indexedTs = ts;
      if (ts) bumpCount(this.assistantTsCounts, ts, 1);
    }
    if (ts) this.assistantsByTs.set(ts, element);
    return element;
  }

  /** Assistant elements in render order, ones no longer in the transcript skipped. */
  liveAssistants() {
    const out = [];
    for (const element of this.assistantOrder) {
      if (this.container?.contains(element)) out.push(element);
    }
    return out;
  }

  /** True when the element is still part of the transcript. */
  isLiveAssistant(element) {
    return Boolean(element) && Boolean(this.container?.contains(element));
  }

  /** Whether the feed is following the newest content (see ScrollFollow). */
  get isNearBottom() {
    return this.follow.isPinned;
  }

  set isNearBottom(value) {
    this.follow.isPinned = value;
  }

  /**
   * Element census recorded with every transcript operation (see debug-log.js).
   *
   * This runs on every rendered entry and every streamed frame, so it must cost
   * nothing when capture is off — the arguments used to be built eagerly
   * (a `querySelectorAll` per call plus a full-text pass over every message in
   * `reportDuplicateMessages`), which made rendering quadratic in the
   * transcript size whether or not anybody was debugging.
   */
  transcriptState(op, extra = {}) {
    if (!debugLog.isEnabled()) return;
    // Counts and the last few identities only, and from the index itself: this
    // line is written on every rendered entry and every streamed frame, so it
    // must not walk the transcript. `assistantOrder` is append-only and reset
    // by `clear()`, so its length *is* the live count.
    const tail = this.assistantOrder.slice(-12);
    logDebug("transcript", {
      op,
      assistants: this.assistantOrder.length,
      users: this.userCount,
      ids: tail.map((el) => el.dataset.messageId || null),
      ts: tail.map((el) => el.dataset.messageTs || null),
      streaming: tail.filter((el) => el.dataset.finalized !== "true").length,
      // The automatic path throttles the one check that reads message text; an
      // explicit call (a debug dump, a test) always gets a full answer.
      duplicates: this.reportDuplicateMessages(null, { throttleText: true }),
      ...extra,
    });
  }

  /**
   * Detect the transcript drawing one message twice.
   *
   * This is the reported symptom that leaves no trace in the session file (one
   * entry, two elements), and it is invisible to a user's screenshot: two
   * elements can carry the same session-entry id (a history render plus a live
   * copy) or one real id plus the live placeholder. Both cases are recorded, so
   * an exported debug bundle proves the mechanism instead of describing it.
   *
   * @returns {Array<{id: string|null, count: number, reason: string}>} findings
   */
  reportDuplicateMessages(assistants = null, { throttleText = false } = {}) {
    if (!debugLog.isEnabled()) return [];
    // Runtime identity and entry id come from the counters the index maintains:
    // the timestamp is the one key both copies of a message always share (the
    // finalize path stamps it, the streaming path stamps it, every adoption
    // rule matches on it), and the id check skips the live placeholder — so
    // these two answer the question with no walk at all.
    const findings = [];
    for (const [ts, count] of this.assistantTsCounts) {
      if (count > 1) findings.push({ id: null, ts, count, reason: "same-message-ts" });
    }
    for (const [id, count] of this.assistantIdCounts) {
      if (id !== "streaming" && count > 1) findings.push({ id, count, reason: "same-entry-id" });
    }
    // The content-prefix key catches the pair the other two cannot (a history
    // copy and a live copy whose ids differ *and* whose runtime identity never
    // made it onto one of them). It is the only part that reads message text,
    // so it runs at most once every `TEXT_DUPLICATE_SCAN_MS`: a duplicate stays
    // on screen and in the counters, so a bundle exported a second later still
    // proves it.
    const now = Date.now();
    if (!throttleText || now - this.lastTextDuplicateScan >= TEXT_DUPLICATE_SCAN_MS) {
      this.lastTextDuplicateScan = now;
      const elements = assistants ?? this.liveAssistants();
      const byText = new Map();
      for (const el of elements) {
        const text = (el.querySelector(".message-content")?.textContent || "").trim().slice(0, 120);
        if (text.length < 40) continue;
        byText.set(text, (byText.get(text) || 0) + 1);
      }
      for (const [text, count] of byText) {
        if (count > 1) findings.push({ id: null, count, reason: "same-content", text });
      }
    }
    if (findings.length > 0) {
      logDebug("transcript.duplicate", {
        assistants: (assistants ?? this.liveAssistants()).length,
        findings,
      });
    }
    return findings;
  }

  clear() {
    logDebug("transcript", {
      op: "clear",
      removed: this.container.querySelectorAll(".message").length,
      ids: this.liveAssistants().map((el) => el.dataset.messageId || null),
    });
    if (this.followFrame !== null) {
      cancelAnimationFrame(this.followFrame);
      this.followFrame = null;
    }
    this.container.innerHTML = "";
    // The index is the elements that just went away.
    this.assistantOrder = [];
    this.assistantsById.clear();
    this.assistantsByTs.clear();
    this.assistantIdCounts.clear();
    this.assistantTsCounts.clear();
    this.userCount = 0;
    // Session switches reuse the same renderer instance. If the previous session
    // left the viewport away from bottom, keep new renders from inheriting that
    // stale anchor state (which can suppress auto-scroll until the user scrolls)
    // — this is also where the follow policy learns the transcript was replaced,
    // instead of asking the layout on every frame (see ScrollFollow.isPinned).
    this.follow.reset();
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

  renderUserMessage(message, isHistory = false, { forceScroll = false } = {}) {
    // Remove welcome message if present
    const welcome = this.container.querySelector(".welcome");
    if (welcome) welcome.remove();

    const div = document.createElement("div");
    div.className = `message user${isHistory ? " history" : ""}`;
    // Session-entry identity, when the caller knows it: the rewind action needs
    // the entry to navigate to, and fork can branch from a user message too.
    if (message.id) div.dataset.messageId = String(message.id);
    // The raw text (markdown markup intact) for the rewind action to restore:
    // reading it back from the DOM would return the *rendered* text.
    div._messageText =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter((b) => b?.type === "text")
              .map((b) => b.text || "")
              .join("\n")
          : "";

    div.innerHTML = `
      <div class="message-content">${renderUserMarkdown(message.content)}</div>
      ${this._copyButtonHtml()}
    `;
    this._setupCopyBtn(div);
    this.container.appendChild(div);
    this.userCount += 1;
    if (!isHistory) this.scrollToBottom({ force: forceScroll, immediate: forceScroll });
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
    const element = this.assistantsById.get(wanted);
    return this.isLiveAssistant(element) ? element : null;
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
    //   turns, so distinct turns never merge into one element,
    // - an element settled before its id arrived is adopted only for its own
    //   message, matched by runtime identity (see `findSettledAssistantElement`).
    const adopted = isStreaming
      ? (this.findAssistantElement(message.id) ??
        this.findUnfinishedAssistantElement(null, message.timestamp) ??
        this.findSettledAssistantElement(message.timestamp))
      : this.findAssistantElement(message.id);
    const div = adopted ?? document.createElement("div");
    div.className = `message assistant${isHistory ? " history" : ""}`;
    // Never walk a known entry id back to the placeholder: a frame without one
    // (a streaming replay whose id has not been resolved yet) handled at an
    // element that already carries the real id must leave it in place — the id
    // is what fork-from-message resolves and what the duplicate census matches
    // on, and overwriting it with "streaming" blinds both.
    if (message.id || !div.dataset.messageId) {
      div.dataset.messageId = message.id || "streaming";
    }
    // Runtime message identity (`timestamp`) — the same role+timestamp key the
    // extension resolves session-entry ids with. A live element finalized before
    // its id arrived (agent_end overtakes the entry-id retry) carries only the
    // "streaming" placeholder; this is what lets its own late frame find it.
    div.dataset.messageTs = typeof message.timestamp === "number" ? String(message.timestamp) : "";

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
    this.indexAssistant(div, { created: !adopted });
    this.transcriptState("assistant", {
      adopted: Boolean(adopted),
      streaming: isStreaming,
      history: isHistory,
      messageId: div.dataset.messageId || null,
    });
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
    // Blocks past the reported segments are stale: an element can be adopted
    // across messages when a `message_start` frame was dropped (or the message
    // ended without one), and a reply whose reasoning has fewer segments than
    // the one before it kept the old chain's remaining blocks on screen.
    for (let i = segments.length; i < existing.length; i++) {
      existing[i].remove();
      this.scrollToBottom();
    }
  }

  updateStreamingMessage(messageElement, content, { typing = null } = {}) {
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
    // The caret lives on this element only (see the .typing rules in
    // style.css) and only while the model is writing user-facing text; `null`
    // leaves the caller's last decision alone (seed writes, adoptions).
    if (typing !== null) this.setStreamingTyping(messageElement, typing);
    this.scrollToBottom();
  }

  /**
   * Show or hide the live caret on a streaming message. The caller decides from
   * the frame it just handled (`isTypingUserText`, public/state.js); thinking and
   * tool frames clear it so the caret never means "busy".
   *
   * A settled element (its content div lost `streaming` — the run ended, the
   * element was finalized, or a history render drew it) is no longer a live
   * target: an update that arrives after the fact must not bring the caret
   * back, or the transcript shows a caret blinking on text that stopped
   * arriving.
   */
  setStreamingTyping(messageElement, typing) {
    const textDiv = messageElement?.querySelector?.(".streaming-text");
    if (!textDiv) return;
    if (typing && !messageElement.querySelector(".message-content.streaming")) return;
    textDiv.classList.toggle("typing", Boolean(typing));
  }

  /**
   * Finish every assistant element the live stream left behind.
   *
   * A `message_end` can be dropped rather than replayed — while a deferred
   * session switch is pending every frame except `agent_end` is suppressed, and
   * that run's `agent_end` may never come at all (the settle then arrives from
   * the runtime-idle registry path). The element keeps its last cumulative text
   * and looks settled: no streaming caret, a copy button, and the finalized flag
   * that every adoption/lookup rule keys on. The end of the run is the last
   * moment any of it can still be true, exactly like `settleOpenToolCalls`.
   *
   * @returns {number} how many elements were settled
   */
  settleAllStreaming() {
    let settled = 0;
    for (const element of this.liveAssistants()) {
      if (element.dataset.finalized === "true") continue;
      const contentDiv = element.querySelector(".message-content");
      const rawText =
        typeof element._streamingRawText === "string"
          ? element._streamingRawText
          : (contentDiv?.querySelector(".streaming-text")?.textContent ?? "");
      // One element that fails to finalize (an unexpected shape from a replayed
      // frame, a renderer throw) must not abort the sweep for every element
      // after it: a half-swept transcript is exactly the frozen caret this
      // exists to prevent, and the next run end may be minutes away.
      try {
        this.finalizeStreamingMessage(element, null, null, element.dataset.messageId || null);
      } catch (err) {
        this.stopStreaming(element);
        console.error("[Transcript] Failed to settle a streaming element:", err);
        settled += 1;
        continue;
      }
      if (rawText && contentDiv && !contentDiv.querySelector(".streaming-text")) {
        // finalizeStreamingMessage rebuilt from `_streamingRawText`; make sure a
        // freshly emptied element still shows the text it had.
        contentDiv.innerHTML = renderMarkdown(rawText);
      }
      settled += 1;
    }
    return settled;
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
    this.transcriptState("stop", { messageId: messageElement.dataset.messageId || null });
    contentDiv.classList.remove("streaming");
    // The caret is hidden by the `.message-content.streaming` ancestor rule, but
    // the class itself must go: an element adopted again as live (a replayed
    // frame, a late partial flush) would otherwise resume blinking on text that
    // stopped arriving.
    for (const textDiv of contentDiv.querySelectorAll(".streaming-text.typing")) {
      textDiv.classList.remove("typing");
    }
    for (const thinkingDiv of contentDiv.querySelectorAll(".streaming-thinking")) {
      thinkingDiv.classList.remove("streaming-thinking");
      thinkingDiv.querySelector(".thinking-toggle")?.classList.remove("expanded");
      thinkingDiv.querySelector(".thinking-content")?.classList.remove("expanded");
    }
    this._ensureCopyButton(messageElement);
    this.scrollToBottom();
  }

  /**
   * Any assistant element carrying this runtime message identity.
   *
   * The identity finders above answer "is this *the* element to adopt/finish?";
   * this one answers the plain existence question a late frame asks ("is this
   * message already on screen?"), across every element shape — live, settled,
   * or rendered from history with a real entry id.
   */
  findAssistantElementByTs(messageTs) {
    const wanted =
      typeof messageTs === "number" && Number.isFinite(messageTs) ? String(messageTs) : null;
    if (!wanted) return null;
    const element = this.assistantsByTs.get(wanted);
    return this.isLiveAssistant(element) ? element : null;
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
  findUnfinishedAssistantElement(messageId = null, messageTs = null) {
    const wanted = typeof messageId === "string" && messageId ? messageId : null;
    const wantedTs =
      typeof messageTs === "number" && Number.isFinite(messageTs) ? String(messageTs) : null;
    for (let i = this.assistantOrder.length - 1; i >= 0; i--) {
      const element = this.assistantOrder[i];
      if (!this.isLiveAssistant(element)) continue;
      if (wanted && element.dataset.messageId !== wanted) continue;
      if (element.dataset.finalized === "true") continue;
      // Asked without an id (the live-streaming adoption), the element must
      // still belong to *this* message: an entry id is only stamped on frames
      // that already resolved one, while the runtime holds an identified
      // `message_end` for its entry-id retry (~60ms) — long enough for the next
      // message's `message_start` and updates to arrive first. Without this the
      // new message adopted the previous message's unfinished element, and the
      // earlier reply disappeared from the transcript (the census recorded the
      // same element changing its `data-message-ts` four times in one run).
      if (!wanted) {
        const elementTs = element.dataset.messageTs || "";
        if (elementTs && elementTs !== wantedTs) continue;
      }
      return element;
    }
    return null;
  }

  /**
   * Assistant element that already holds this message *and is finished*.
   *
   * The streaming path asks this before drawing an update: the runtime flushes
   * a turn's final partial on its way out, so a `message_update` can arrive
   * *after* its `agent_end`, for a message the run end already finalized.
   * Adopting it would un-finish the turn (`renderAssistantMessage(…, true)`
   * clears the finalized flag by design) and appending drew the reply a second
   * time — the debug bundle's pair of `1790562840193` elements, one with the
   * entry id and one still `"streaming"`, seven seconds into a live run.
   *
   * Unknown identity returns null, so a frame for a genuinely new message (or
   * one whose id is not known yet while its element is still live) keeps the
   * normal path.
   *
   * @param {string|null} messageId session-entry id the frame carries, if any
   * @param {number|null} messageTs the frame's runtime message timestamp
   */
  findFinalizedAssistantElement(messageId = null, messageTs = null) {
    const byId = this.findAssistantElement(messageId);
    if (byId) return byId.dataset.finalized === "true" ? byId : null;
    const wanted =
      typeof messageTs === "number" && Number.isFinite(messageTs) ? String(messageTs) : null;
    if (!wanted) return null;
    const element = this.assistantsByTs.get(wanted);
    if (this.isLiveAssistant(element) && element.dataset.finalized === "true") return element;
    return null;
  }

  /**
   * Assistant element a run-end finalize settled before its session-entry id
   * arrived — still carrying the live placeholder id (or none) and already
   * finalized.
   *
   * `agent_end` is broadcast immediately while the assistant `message_end` is
   * held for the entry-id retry (omp persists the message a few ms after its
   * `message_end` handler runs), so the run end can finalize the live element
   * with no id to key on. The identified frame then found neither an element
   * for its entry (`findAssistantElement`) nor an unfinished one
   * (`findUnfinishedAssistantElement`, the finalize cleared that flag) and
   * appended a second copy of the same reply — the duplicate the debug bundle
   * caught as `transcript.duplicate` with one `null` id.
   *
   * Matched by the runtime message identity (`timestamp`), the same
   * role+timestamp key the extension resolves entry ids with, so a frame for a
   * different message can never adopt this element.
   */
  findSettledAssistantElement(messageTs = null) {
    const wanted =
      typeof messageTs === "number" && Number.isFinite(messageTs) ? String(messageTs) : null;
    if (!wanted) return null;
    for (let i = this.assistantOrder.length - 1; i >= 0; i--) {
      const element = this.assistantOrder[i];
      if (!this.isLiveAssistant(element)) continue;
      if (element.dataset.finalized !== "true") continue;
      const id = element.dataset.messageId || "";
      if (id && id !== "streaming") continue;
      if (element.dataset.messageTs !== wanted) continue;
      return element;
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
      // The id arrived after the render: the identity index (and the duplicate
      // counters) have to see it, or the element is invisible to every lookup
      // keyed on the real entry id.
      this.indexAssistant(messageElement);
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
    this.transcriptState("finalize", { messageId: messageElement.dataset.messageId || null });

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

  /**
   * Append a displayable session notice.
   *
   * omp persists notices the TUI renders as `custom_message` entries with
   * `display: true` (background-job delivery `async-result`, `launch-completion`,
   * late diagnostics). They are ordinary transcript items — the same reply can
   * be re-read from the session file — so the element is keyed on the entry id
   * and an entry that is already on screen (a snapshot repaint drew it, then
   * the extension forwarded it, or a resync replayed it) is not drawn twice.
   *
   * @param {{id?: string|null, customType?: string, content?: unknown, label?: string|null}} notice
   * @returns {HTMLElement|null} the appended element, or null when skipped
   */
  renderNotice({ id = null, customType = "", content = null, label = null } = {}) {
    if (AGENT_ONLY_NOTICE_TYPES.has(String(customType || ""))) return null;
    const text = noticeText(content);
    if (!text) return null;
    if (typeof id === "string" && id && this.findNoticeElement(id)) return null;

    const block = document.createElement("div");
    block.className = "notice-block";
    if (typeof id === "string" && id) block.dataset.noticeId = id;

    const head = document.createElement("div");
    head.className = "notice-head";
    const labelEl = document.createElement("span");
    labelEl.className = "notice-label";
    labelEl.textContent = label || t("notice.label");
    head.appendChild(labelEl);
    if (customType) {
      // The producer's identifier (omp's own or an extension's) is data, not a
      // translatable label — shown as written, like a tool name.
      const type = document.createElement("span");
      type.className = "notice-type";
      type.textContent = customType;
      type.title = t("notice.typeTitle", { type: customType });
      head.appendChild(type);
    }
    block.appendChild(head);

    const body = document.createElement("div");
    body.className = "notice-body";
    body.textContent = text;
    block.appendChild(body);

    this.container.appendChild(block);
    this.scrollToBottom();
    return block;
  }

  /**
   * Append a committed compaction (`type:"compaction"` entry).
   *
   * The entry holds the summary that replaced the summarized history — the
   * transcript's only record of that stretch of the conversation, since the
   * entries it covered are no longer on the session's branch. It renders like
   * a notice (id-keyed, clamped body) under a label that says what it is.
   *
   * @param {{id?: string|null, summary?: unknown}} compaction
   * @returns {HTMLElement|null} the appended element, or null when skipped
   */
  renderCompaction({ id = null, summary = null } = {}) {
    return this.renderNotice({
      id,
      customType: "compaction",
      content: summary,
      label: t("ctx.compacted"),
    });
  }

  /** The notice element for a session-entry id, if it is on screen. */
  findNoticeElement(entryId) {
    for (const el of this.container.querySelectorAll("[data-notice-id]")) {
      if (el.dataset.noticeId === entryId) return el;
    }
    return null;
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

  /**
   * Reveal the newest content, if the viewer is following it.
   *
   * `force` is for the messages the *local* user just sent: scrolling is the
   * follow policy's job (a reader who scrolled away stays where they are), but
   * their own message is the one thing they must see — without it the capsule
   * is appended below the viewport and sits behind the composer until they
   * scroll manually. `immediate` jumps in the same task (the append already
   * forced layout, so `scrollHeight` includes the new element) and then again on
   * the next frame, the position a late composer-inset change leaves stale.
   */
  scrollToBottom({ force = false, immediate = false } = {}) {
    if (!force && !this.follow.isPinned) return;
    if (immediate) this.jumpToBottom();
    // One follow per frame however many frames arrived: every jump clamps
    // against the content end, and that read forces a layout of the whole
    // transcript (measured ~28 ms on an 80k-node / 3775-item session), so a
    // burst of deltas must not queue one jump each.
    if (this.followFrame !== null) return;
    this.followFrame = requestAnimationFrame(() => {
      this.followFrame = null;
      this.jumpToBottom();
    });
  }

  /**
   * Pin the viewport to the newest content, bypassing the container's
   * `scroll-behavior: smooth`.
   *
   * A smooth follow cannot keep up with a stream (or with a block that lands in
   * one big delta): while the animation runs, the geometry still reports "far
   * from the bottom", which flips the follow policy unpinned and silently stops
   * every later follow — the feed froze while the run was still going, and the
   * newest block stayed under the composer. An instant jump lands on the
   * bottom in the same frame, so the state stays truthful.
   */
  jumpToBottom() {
    this.follow.jump();
  }
}

/**
 * Plain text of a notice entry's `content` (a string, or content blocks).
 *
 * omp ships some notices wrapped in a `<system-notice>` envelope — markup the
 * model is meant to see, not the reader; the block already carries a notice
 * label, so a wrapper around the whole payload is unwrapped. Anything else is
 * rendered verbatim (textContent, so no markup is interpreted).
 */
function noticeText(content) {
  const raw =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => block && block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n")
        : "";
  const text = raw.trim();
  const opened = /^<system-notice>\s*/i.exec(text);
  if (!opened) return text;
  const rest = text.slice(opened[0].length);
  return rest.replace(/\s*<\/system-notice>$/i, "").trim();
}
