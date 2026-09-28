import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageRenderer } from "./message-renderer.js";

describe("MessageRenderer streaming markdown preview", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("renders markdown live during streaming updates", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "hello **bold te");

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold te</strong>");
  });

  it("finalizes from the raw text, not the rendered DOM", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "a **bold** word and `code`");
    renderer.finalizeStreamingMessage(el);

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold</strong>");
    expect(content.innerHTML).toContain("<code>code</code>");
  });

  it("keeps a partial code block previewing as a code block", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "```js\nconst a = 1;");

    const content = el.querySelector(".message-content");
    expect(content.querySelector(".code-block-wrapper")).not.toBeNull();
    expect(content.textContent).toContain("const a = 1;");
  });

  it("preserves the thinking block while streaming text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, "pondering...");
    renderer.updateStreamingMessage(el, "some *italic");

    expect(el.querySelector(".streaming-thinking")).not.toBeNull();
    expect(el.querySelector(".streaming-text").innerHTML).toContain("<em>italic</em>");
  });

  it("does not render raw HTML from streamed text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "`<script>alert(1)</script>`");

    const content = el.querySelector(".message-content");
    expect(content.querySelector("script")).toBeNull();
  });

  it("keeps the streaming placeholder until finalize stamps the real entry id (F2)", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    expect(el.dataset.messageId).toBe("streaming");

    renderer.updateStreamingMessage(el, "answer");
    renderer.finalizeStreamingMessage(el, null, "", "msg_entry_42");

    expect(el.dataset.messageId).toBe("msg_entry_42");
  });

  it("shows the caret only while user-facing text is being written", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    const text = () => el.querySelector(".streaming-text");

    // A fresh streaming message (thinking only, nothing said yet): no caret.
    expect(text().classList.contains("typing")).toBe(false);

    renderer.updateStreamingMessage(el, "hello", { typing: true });
    expect(text().classList.contains("typing")).toBe(true);
    expect(text().className).toBe("streaming-text typing");

    // The model moved on to thinking / a tool call: the caret goes away.
    renderer.setStreamingTyping(el, false);
    expect(text().classList.contains("typing")).toBe(false);

    // `typing: null` (seed/adoption writes) leaves the last decision alone.
    renderer.updateStreamingMessage(el, "hello again");
    expect(text().classList.contains("typing")).toBe(false);
    renderer.updateStreamingMessage(el, "hello again", { typing: true });
    renderer.updateStreamingMessage(el, "hello again once more");
    expect(text().classList.contains("typing")).toBe(true);
  });

  it("streams text into the block the caret is drawn in (CSS contract)", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);

    // The streaming cursor is drawn by .streaming-text's last block, so the
    // element must own one from the moment the message starts.
    expect(el.querySelector(".message-content > .streaming-text")).not.toBeNull();
  });

  it("stopStreaming drops the caret and collapses the thinking block in place", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, "half a thought");
    renderer.updateStreamingMessage(el, "half an **answer");

    renderer.stopStreaming(el);

    const content = el.querySelector(".message-content");
    expect(content.classList.contains("streaming")).toBe(false);
    expect(el.querySelector(".streaming-thinking")).toBeNull();
    const thinking = el.querySelector(".thinking-block");
    expect(thinking.classList.contains("streaming-thinking")).toBe(false);
    expect(thinking.querySelector(".thinking-toggle").classList.contains("expanded")).toBe(false);
    expect(thinking.querySelector(".thinking-content").classList.contains("expanded")).toBe(false);
    // A stopped message is complete as far as the UI is concerned.
    expect(el.querySelector(".message-copy-btn")).not.toBeNull();
  });

  it("ignores late deltas after the run was stopped", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "partial");
    renderer.stopStreaming(el);

    renderer.updateStreamingMessage(el, "partial plus a late frame");
    renderer.updateStreamingThinking(el, "late thought");

    expect(el.querySelector(".message-content").classList.contains("streaming")).toBe(false);
    expect(el.querySelector(".streaming-thinking")).toBeNull();
    expect(el.querySelector(".streaming-text").textContent).toBe("partial");
  });

  it("finalizes a stopped element from its stashed raw text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "a **bold** stop");
    renderer.stopStreaming(el);

    renderer.finalizeStreamingMessage(el, null, "thought");

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold</strong>");
    expect(content.querySelector(".thinking-block")).not.toBeNull();
  });

  it("does not re-render an already finalized message on a duplicate message_end", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "## Heading");
    renderer.finalizeStreamingMessage(el);
    const finalized = el.querySelector(".message-content").innerHTML;

    renderer.finalizeStreamingMessage(el);

    expect(el.querySelector(".message-content").innerHTML).toBe(finalized);
    expect(el.querySelectorAll(".message-copy-btn")).toHaveLength(1);
  });

  it("finds the unfinished assistant element for a late message_end", () => {
    renderer.renderAssistantMessage({ content: "done", id: "msg_1" }, false, true);
    expect(renderer.findUnfinishedAssistantElement("msg_1")).toBeNull();

    const live = renderer.renderAssistantMessage({ content: "", id: "msg_2" }, true);
    expect(renderer.findUnfinishedAssistantElement("msg_2")).toBe(live);
    // No id available (older event shapes) — the newest unfinished element wins.
    expect(renderer.findUnfinishedAssistantElement()).toBe(live);
  });

  it("follows the bottom instantly, so the guard cannot latch off mid-stream", async () => {
    const messageContainer = document.createElement("div");
    Object.defineProperty(messageContainer, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(messageContainer, "clientHeight", { value: 400, configurable: true });
    messageContainer.style.scrollBehavior = "smooth";
    const followRenderer = new MessageRenderer(messageContainer);
    followRenderer.isNearBottom = true;

    followRenderer.scrollToBottom();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // A smooth follow would still be animating here; landing in one frame is
    // what keeps the near-bottom guard truthful for the rest of the run.
    expect(messageContainer.scrollTop).toBe(2000);
    expect(messageContainer.style.scrollBehavior).toBe("smooth");
  });

  it("does not yank the viewport when the user scrolled away", async () => {
    const messageContainer = document.createElement("div");
    Object.defineProperty(messageContainer, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(messageContainer, "clientHeight", { value: 400, configurable: true });
    messageContainer.scrollTop = 300;
    const followRenderer = new MessageRenderer(messageContainer);
    followRenderer.isNearBottom = false;

    followRenderer.scrollToBottom();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(messageContainer.scrollTop).toBe(300);
  });

  it("re-anchors after finalize so the finished block stays in view", async () => {
    const messageContainer = document.createElement("div");
    Object.defineProperty(messageContainer, "scrollHeight", { value: 1500, configurable: true });
    Object.defineProperty(messageContainer, "clientHeight", { value: 300, configurable: true });
    const followRenderer = new MessageRenderer(messageContainer);
    followRenderer.isNearBottom = true;
    const el = followRenderer.renderAssistantMessage({ content: "" }, true);
    followRenderer.updateStreamingMessage(el, "```\ncode\n```");
    messageContainer.scrollTop = 0;

    followRenderer.finalizeStreamingMessage(el);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(messageContainer.scrollTop).toBe(1500);
  });

  it("leaves the placeholder untouched when finalize has no id to stamp (F2)", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.finalizeStreamingMessage(el);
    expect(el.dataset.messageId).toBe("streaming");
  });

  it("history renders carry the entry id passed with the message (F2)", () => {
    const el = renderer.renderAssistantMessage({ content: "hi", id: "msg_7" }, false, true);
    expect(el.dataset.messageId).toBe("msg_7");
  });

  it("highlights keyword matches across rendered messages", () => {
    renderer.renderUserMessage({ content: "Alpha beta gamma" }, true);
    renderer.renderAssistantMessage({ content: "Beta appears twice: beta." }, false, true);

    const count = renderer.highlightSearchQuery("beta");
    const marks = container.querySelectorAll("mark");

    expect(count).toBe(3);
    expect(marks).toHaveLength(3);
    expect(marks[0].textContent.toLowerCase()).toBe("beta");
  });

  it("scrolls the first highlighted match into view", () => {
    renderer.renderAssistantMessage({ content: "jump to keyword" }, false, true);

    let scrolled = false;
    Element.prototype.scrollIntoView = () => {
      scrolled = true;
    };

    const count = renderer.highlightSearchQuery("keyword");

    expect(count).toBe(1);
    expect(scrolled).toBe(true);
  });
});

describe("thinking blocks are rendered identically live and from history", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "first thought" },
      { type: "text", text: "the answer" },
      { type: "thinking", thinking: "second thought, longer than the first one" },
    ],
    id: "msg_9",
  };

  const blockTexts = (el) =>
    Array.from(el.querySelectorAll(".thinking-block")).map(
      (block) => block.querySelector(".thinking-content").textContent,
    );

  it("finalize renders one block per thinking segment, like the history path", () => {
    const live = renderer.renderAssistantMessage({ content: "", id: message.id }, true);
    renderer.finalizeStreamingMessage(live, null, message.content, message.id);

    const history = renderer.renderAssistantMessage(message, false, true);

    expect(blockTexts(live)).toEqual([
      "first thought",
      "second thought, longer than the first one",
    ]);
    expect(blockTexts(live)).toEqual(blockTexts(history));
  });

  it("keeps the streamed placeholder in sync per segment (no merged block)", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, ["alpha"]);
    renderer.updateStreamingThinking(el, ["alpha", "beta"]);

    expect(blockTexts(el)).toEqual(["alpha", "beta"]);
    // Blocks keep message order and stay ahead of the text block.
    const order = Array.from(el.querySelector(".message-content").children).map((child) =>
      child.classList.contains("thinking-block")
        ? "thinking"
        : child.classList.contains("streaming-text")
          ? "text"
          : "other",
    );
    expect(order).toEqual(["thinking", "thinking", "text"]);
  });

  it("does not rewrite a segment whose text did not change", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, ["alpha"]);
    const contentEl = el.querySelector(".thinking-content");
    const textNode = contentEl.firstChild;

    renderer.updateStreamingThinking(el, ["alpha"]);

    expect(contentEl.firstChild).toBe(textNode);
  });

  it("collapses every streamed segment when the run is stopped", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, ["alpha", "beta"]);

    renderer.stopStreaming(el);

    expect(el.querySelectorAll(".streaming-thinking")).toHaveLength(0);
    expect(el.querySelectorAll(".thinking-content.expanded")).toHaveLength(0);
  });

  it("drops blocks the current message no longer reports", () => {
    // Reported symptom: a thinking block showed the previous reasoning chain.
    // An element can be adopted across messages (a dropped `message_start`, a
    // message that ends without one), and the incoming reply reported fewer
    // segments — the leftovers stayed on screen.
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, ["first chain, part one", "first chain, part two"]);
    expect(blockTexts(el)).toEqual(["first chain, part one", "first chain, part two"]);

    renderer.updateStreamingThinking(el, ["the new chain"]);

    expect(blockTexts(el)).toEqual(["the new chain"]);
  });
});

describe("rendering is keyed on message identity (no duplicate elements)", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("a replayed message_start for the same id streams into the existing element", () => {
    const first = renderer.renderAssistantMessage({ content: "", id: "msg_1" }, true);
    renderer.updateStreamingMessage(first, "partial answer");

    // Replay of the same frame (provider retry / re-delivered event).
    const second = renderer.renderAssistantMessage({ content: "", id: "msg_1" }, true);

    expect(second).toBe(first);
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
  });

  it("an id-less replay adopts the unfinished element instead of appending", () => {
    const first = renderer.renderAssistantMessage({ content: "" }, true);
    const second = renderer.renderAssistantMessage({ content: "" }, true);

    expect(second).toBe(first);
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
  });

  it("still creates a new element for the next turn of the same run", () => {
    const first = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(first, "turn one");
    renderer.finalizeStreamingMessage(first);

    const second = renderer.renderAssistantMessage({ content: "" }, true);

    expect(second).not.toBe(first);
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(2);
  });

  it("a new message never adopts an earlier message's unfinished element", () => {
    // The runtime holds an identified `message_end` for its entry-id retry, so
    // the next message's start/updates can arrive while the previous element is
    // still unfinished. Adopting it there replaced the earlier reply on screen
    // (the census recorded one element changing its `data-message-ts`).
    const first = renderer.renderAssistantMessage({ content: "", timestamp: 1000 }, true);
    renderer.updateStreamingMessage(first, "the first reply");

    const second = renderer.renderAssistantMessage({ content: "", timestamp: 2000 }, true);

    expect(second).not.toBe(first);
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(2);
    expect(first.dataset.messageTs).toBe("1000");
    expect(first.querySelector(".message-content").textContent).toContain("the first reply");
    expect(second.dataset.messageTs).toBe("2000");
  });

  it("an id-less replay still adopts the element for its own timestamp", () => {
    const first = renderer.renderAssistantMessage({ content: "", timestamp: 1000 }, true);

    const replay = renderer.renderAssistantMessage({ content: "", timestamp: 1000 }, true);

    expect(replay).toBe(first);
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
  });

  it("a late message_end finds its own unfinished element by identity", () => {
    // The held end arrives after the next message started: its element is still
    // unfinished and must be found by timestamp, not by "the newest unfinished".
    const first = renderer.renderAssistantMessage({ content: "", timestamp: 1000 }, true);
    renderer.updateStreamingMessage(first, "first");
    renderer.renderAssistantMessage({ content: "", timestamp: 2000 }, true);

    expect(renderer.findUnfinishedAssistantElement(null, 1000)).toBe(first);
    expect(renderer.findUnfinishedAssistantElement(null, 2000)).not.toBe(first);
    expect(renderer.findUnfinishedAssistantElement(null, 9999)).toBeNull();
  });

  it("re-rendering the same finalized message replaces it in place", () => {
    const first = renderer.renderAssistantMessage({ content: "hello", id: "msg_7" }, false, true);
    const again = renderer.renderAssistantMessage({ content: "hello", id: "msg_7" }, false, true);

    expect(again).toBe(first);
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
    expect(container.querySelectorAll(".message-copy-btn")).toHaveLength(1);
  });

  it("a settled element is still unfinished: the copy button is not the state marker", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "partial answer");
    // stopStreaming (agent_end before message_end, user abort) settles the
    // element and adds the copy button as a visual affordance only.
    renderer.stopStreaming(el);
    expect(el.querySelector(".message-copy-btn")).not.toBeNull();

    // A late message_end must find THAT element — not append a second copy.
    expect(renderer.findUnfinishedAssistantElement(null)).toBe(el);
  });

  it("finalize marks the element done so later frames cannot duplicate it", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "the answer");
    renderer.finalizeStreamingMessage(el);

    expect(el.dataset.finalized).toBe("true");
    expect(renderer.findUnfinishedAssistantElement(null)).toBeNull();
    expect(renderer.findUnfinishedAssistantElement(el.dataset.messageId)).toBeNull();
  });

  it("finds a finalized element by entry id, or by runtime identity alone", () => {
    const el = renderer.renderAssistantMessage(
      { content: "", id: "4d13d778", timestamp: 1790562840193 },
      true,
    );
    renderer.updateStreamingMessage(el, "the answer");
    renderer.finalizeStreamingMessage(el, null, "", "4d13d778");

    expect(renderer.findFinalizedAssistantElement("4d13d778", 1790562840193)).toBe(el);
    // The frame may arrive before its entry id is known: the timestamp is the
    // identity every adoption rule shares.
    expect(renderer.findFinalizedAssistantElement(null, 1790562840193)).toBe(el);
    expect(renderer.findFinalizedAssistantElement(null, 1790562840194)).toBeNull();
    expect(renderer.findFinalizedAssistantElement("other", null)).toBeNull();
  });

  it("does not treat a live element as a finished duplicate", () => {
    const el = renderer.renderAssistantMessage({ content: "", id: "live_1", timestamp: 7 }, true);
    renderer.updateStreamingMessage(el, "still going");

    expect(renderer.findFinalizedAssistantElement("live_1", 7)).toBeNull();
    expect(renderer.findFinalizedAssistantElement(null, 7)).toBeNull();
  });

  it("the census names a crossed pair by runtime identity, where id and text both differ", () => {
    // The pair the bundle recorded: `agent_end` finalized the element (real
    // entry id, rendered markdown), then a late streaming frame for the same
    // message created a second one (placeholder id, raw markdown). The id check
    // skips "streaming" and the text check compares different renderings — only
    // the shared message timestamp names them.
    const finalized = renderer.renderAssistantMessage(
      { content: "", id: "4d13d778", timestamp: 1790562840193 },
      true,
    );
    renderer.updateStreamingMessage(
      finalized,
      "one and the same answer text, long enough to compare",
    );
    renderer.finalizeStreamingMessage(finalized, null, "", "4d13d778");

    const late = renderer.renderAssistantMessage({ content: "", timestamp: 1790562840193 }, true);
    renderer.updateStreamingMessage(late, "one and the same answer text, long enough to compare");
    expect(late).not.toBe(finalized);
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(2);

    const findings = renderer.reportDuplicateMessages();
    expect(findings).toContainEqual({
      id: null,
      ts: "1790562840193",
      count: 2,
      reason: "same-message-ts",
    });
  });

  it("stops the caret when an element is settled, not just the streaming class", () => {
    // The caret is only *shown* under `.message-content.streaming`, but the
    // `typing` class outlived every settle path — so an element adopted again
    // as live (a replayed frame, a late partial flush) resumed blinking on text
    // that stopped arriving.
    const el = renderer.renderAssistantMessage({ content: "", timestamp: 1000 }, true);
    renderer.updateStreamingMessage(el, "writing something", { typing: true });
    expect(el.querySelector(".streaming-text").classList.contains("typing")).toBe(true);

    renderer.stopStreaming(el);
    expect(el.querySelector(".streaming-text").classList.contains("typing")).toBe(false);
    expect(el.querySelector(".message-content").classList.contains("streaming")).toBe(false);
  });

  it("refuses to start a caret on an element the run already settled", () => {
    // A late delta (the runtime flushes the turn's last partial on its way out)
    // must not bring the caret back to a message that is already finished. The
    // text div survives a settle when the element was not rebuilt from its
    // blocks — exactly the shape a replayed frame finds.
    const el = renderer.renderAssistantMessage({ content: "", timestamp: 1000 }, true);
    renderer.updateStreamingMessage(el, "writing something");
    el.querySelector(".message-content").classList.remove("streaming");

    renderer.setStreamingTyping(el, true);
    expect(el.querySelector(".streaming-text").classList.contains("typing")).toBe(false);

    // Clearing is always allowed, so a stale class can never survive.
    el.querySelector(".streaming-text").classList.add("typing");
    renderer.setStreamingTyping(el, false);
    expect(el.querySelector(".streaming-text").classList.contains("typing")).toBe(false);
  });

  it("finds an element by its runtime identity whatever shape it has", () => {
    const live = renderer.renderAssistantMessage({ content: "", timestamp: 111 }, true);
    const settled = renderer.renderAssistantMessage({ content: "hi", timestamp: 222 }, false);
    const finalized = renderer.renderAssistantMessage(
      { content: "old", id: "abc12345", timestamp: 333 },
      false,
    );

    expect(renderer.findAssistantElementByTs(111)).toBe(live);
    expect(renderer.findAssistantElementByTs(222)).toBe(settled);
    expect(renderer.findAssistantElementByTs(333)).toBe(finalized);
    expect(renderer.findAssistantElementByTs(999)).toBeNull();
    expect(renderer.findAssistantElementByTs(null)).toBeNull();
  });

  it("finishes every element the stream left behind", () => {
    // A `message_end` suppressed while a deferred session switch was pending —
    // or lost with a dead process — leaves elements mid-stream: a frozen caret,
    // no copy button, and an unfinalized flag every lookup keys on. The end of
    // the run settles them, exactly like `settleOpenToolCalls` does for cards.
    const first = renderer.renderAssistantMessage({ content: "", timestamp: 1000 }, true);
    renderer.updateStreamingMessage(first, "the first reply");
    const second = renderer.renderAssistantMessage({ content: "", timestamp: 2000 }, true);
    renderer.updateStreamingMessage(second, "the second reply");

    expect(renderer.settleAllStreaming()).toBe(2);

    for (const [element, text] of [
      [first, "the first reply"],
      [second, "the second reply"],
    ]) {
      expect(element.dataset.finalized).toBe("true");
      expect(element.querySelector(".message-copy-btn")).not.toBeNull();
      expect(element.textContent).toContain(text);
      expect(element.querySelector(".message-content").classList.contains("streaming")).toBe(false);
    }
    // Idempotent: a second pass finds nothing to settle.
    expect(renderer.settleAllStreaming()).toBe(0);
  });

  it("a live render adopts the element a snapshot already rendered for its entry id", () => {
    // A re-render mid-run (snapshot from the session file) holds the message
    // under its real entry id while the live path only knows the placeholder.
    const snapshot = renderer.renderAssistantMessage(
      {
        content: [
          { type: "thinking", thinking: "pondering" },
          { type: "text", text: "half" },
        ],
        id: "msg_77",
      },
      false,
      true,
    );
    const live = renderer.renderAssistantMessage({ content: "", id: "msg_77" }, true);

    expect(live).toBe(snapshot);
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
    expect(snapshot.dataset.finalized).toBeUndefined();
    renderer.updateStreamingMessage(live, "half of the answer");
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
  });

  it("drops the finished affordances when a finalized element goes back to streaming", () => {
    const el = renderer.renderAssistantMessage({ content: "old answer", id: "msg_9" }, false, true);
    expect(el.querySelector(".message-copy-btn")).not.toBeNull();

    const streamed = renderer.renderAssistantMessage({ content: "", id: "msg_9" }, true);

    expect(streamed).toBe(el);
    expect(el.querySelector(".message-copy-btn")).toBeNull();
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
  });

  it("adopts an element settled before its id arrived when its own frame lands late", () => {
    // The wire order the debug bundle caught: the live element is finalized by
    // agent_end while the identified message_end is still held for the
    // extension's entry-id retry, so the element is settled on the "streaming"
    // placeholder — and the late frame appended a second copy of the same
    // reply (`transcript.duplicate`, one `null` id).
    const ts = 1790553955657;
    const content = [
      { type: "thinking", thinking: "Everything is recorded and clean." },
      { type: "text", text: "结论：不需要改代码。" },
    ];
    const live = renderer.renderAssistantMessage({ content: "", timestamp: ts }, true);
    renderer.updateStreamingThinking(live, ["Everything is recorded and clean."]);
    renderer.updateStreamingMessage(live, "结论：不需要改代码。");
    // agent_end: finalize from the last cumulative frame, entry id not known.
    renderer.finalizeStreamingMessage(live, null, content, null);
    expect(live.dataset.messageId).toBe("streaming");

    // The devtools-backed handle on that element is the runtime identity.
    const adopted = renderer.findSettledAssistantElement(ts);
    expect(adopted).toBe(live);
    renderer.finalizeStreamingMessage(adopted, null, content, "e018fd1d");

    expect(live.dataset.messageId).toBe("e018fd1d");
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
    expect(renderer.reportDuplicateMessages()).toEqual([]);
  });

  it("never adopts a settled element for a different message or a history copy", () => {
    const live = renderer.renderAssistantMessage({ content: "", timestamp: 111 }, true);
    renderer.updateStreamingMessage(live, "first reply of the run");
    renderer.finalizeStreamingMessage(
      live,
      null,
      [{ type: "text", text: "first reply of the run" }],
      null,
    );

    // A later message of the same run has its own identity.
    expect(renderer.findSettledAssistantElement(222)).toBeNull();
    // A history copy carries a real entry id; only the settled live element is
    // a candidate for adoption.
    renderer.renderAssistantMessage(
      { content: "history reply", id: "entry_h", timestamp: 111 },
      false,
      true,
    );
    expect(renderer.findSettledAssistantElement(111)).toBe(live);
  });

  it("a replayed live frame re-opens the element settled for its own message", () => {
    const live = renderer.renderAssistantMessage({ content: "", timestamp: 333 }, true);
    renderer.updateStreamingMessage(live, "partial");
    renderer.finalizeStreamingMessage(live, null, [{ type: "text", text: "partial" }], null);

    const again = renderer.renderAssistantMessage({ content: "", timestamp: 333 }, true);

    expect(again).toBe(live);
    expect(live.dataset.finalized).toBeUndefined();
    expect(container.querySelectorAll(".message.assistant")).toHaveLength(1);
  });
});

describe("duplicate transcript detection (debug capture)", () => {
  it("reports two elements claiming the same session-entry id", () => {
    // How the bug looks once the runtime resolves an id late: the history copy
    // already carries it, and the live continuation that could not adopt the
    // element is stamped with the same id when it finalizes.
    const container = document.createElement("div");
    const renderer = new MessageRenderer(container);
    const reply = "A reply long enough to be compared against its twin element.";
    renderer.renderAssistantMessage({ content: reply, id: "entry_1" }, false, true);
    const live = renderer.renderAssistantMessage({ content: "", id: null }, true);
    renderer.finalizeStreamingMessage(live, null, reply, "entry_1");
    const findings = renderer.reportDuplicateMessages();
    expect(findings).toEqual([{ id: "entry_1", count: 2, reason: "same-entry-id" }]);
  });

  it("reports the same reply rendered once from history and once live", () => {
    // The reported symptom: a history copy carries the real entry id while the
    // live copy still carries the "streaming" placeholder, so only the content
    // can identify them as one message.
    const container = document.createElement("div");
    const renderer = new MessageRenderer(container);
    const long = "六个问题全部定位、修复并在真实 omp 18.3.4 上验证，下面是逐条的证据与修复位置。";
    renderer.renderAssistantMessage({ content: long, id: "entry_9" }, false, true);
    renderer.renderAssistantMessage({ content: long, id: null }, true);
    const findings = renderer.reportDuplicateMessages();
    expect(findings.map((finding) => finding.reason)).toEqual(["same-content"]);
    expect(findings[0].count).toBe(2);
  });

  it("stays quiet for a transcript with distinct turns", () => {
    const container = document.createElement("div");
    const renderer = new MessageRenderer(container);
    renderer.renderAssistantMessage(
      { content: "first reply, long enough to be compared", id: "a" },
      false,
      true,
    );
    renderer.renderAssistantMessage(
      { content: "second reply, a different message entirely", id: "b" },
      false,
      true,
    );
    expect(renderer.reportDuplicateMessages()).toEqual([]);
  });
});

describe("MessageRenderer session notices", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("renders the notice type and unwraps the system-notice envelope", () => {
    const el = renderer.renderNotice({
      id: "entry_n1",
      customType: "async-result",
      content: "<system-notice>\nBackground job ScoutX has completed.\n</system-notice>",
    });

    expect(el).not.toBeNull();
    expect(el.dataset.noticeId).toBe("entry_n1");
    expect(el.querySelector(".notice-type").textContent).toBe("async-result");
    // The envelope is markup for the model; the block itself says "Notice".
    expect(el.querySelector(".notice-body").textContent).toBe(
      "Background job ScoutX has completed.",
    );
  });

  it("accepts content blocks and renders them as text, never as markup", () => {
    const el = renderer.renderNotice({
      id: "entry_n2",
      customType: "launch-completion",
      content: [{ type: "text", text: "<img src=x onerror=alert(1)> done" }],
    });
    const body = el.querySelector(".notice-body");
    expect(body.textContent).toContain("<img src=x onerror=alert(1)> done");
    expect(body.querySelector("img")).toBeNull();
  });

  it("draws an entry once, so a snapshot plus a live frame cannot double it", () => {
    const first = renderer.renderNotice({ id: "entry_n3", content: "one" });
    const second = renderer.renderNotice({ id: "entry_n3", content: "one" });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(container.querySelectorAll("[data-notice-id]")).toHaveLength(1);
  });

  it("skips entries with no text and keeps notice ordering stable", () => {
    expect(renderer.renderNotice({ id: "entry_n4", content: "   " })).toBeNull();

    renderer.renderNotice({ id: "entry_n5", content: "first" });
    renderer.renderNotice({ id: "entry_n6", content: "second" });
    const bodies = Array.from(container.querySelectorAll(".notice-body")).map(
      (el) => el.textContent,
    );
    expect(bodies).toEqual(["first", "second"]);
  });
});

describe("a locally sent message is always revealed", () => {
  /** A scroller whose geometry the test controls (jsdom lays nothing out). */
  function scroller({ scrollHeight, clientHeight, scrollTop }) {
    const el = document.createElement("div");
    const state = { scrollHeight, clientHeight, scrollTop };
    for (const key of ["scrollHeight", "clientHeight", "scrollTop"]) {
      Object.defineProperty(el, key, {
        get: () => state[key],
        set: (v) => {
          state[key] = Math.max(0, Math.min(v, state.scrollHeight - state.clientHeight));
        },
      });
    }
    return el;
  }

  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("jumps to it even when the reader had scrolled away", () => {
    // The capsule is appended below the viewport; the follow policy leaves a
    // reader who scrolled away alone, but the message *they* just sent must not
    // sit behind the composer until they scroll manually.
    const container = scroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    const renderer = new MessageRenderer(container);
    renderer.follow.isPinned = false;

    renderer.renderUserMessage({ content: "my new message" }, false, { forceScroll: true });

    expect(container.scrollTop).toBe(600);
    expect(container.querySelectorAll(".message.user")).toHaveLength(1);
  });

  it("leaves the viewport alone for a message that is not the local user's", () => {
    // A message echoed from another surface (mirror mode, a TUI client) follows
    // the normal policy: a reader mid-history is not yanked by it.
    const container = scroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });
    const renderer = new MessageRenderer(container);
    renderer.follow.isPinned = false;

    renderer.renderUserMessage({ content: "echoed elsewhere" });

    expect(container.scrollTop).toBe(100);
  });

  it("still follows while the reader is at the bottom", () => {
    const container = scroller({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });
    const renderer = new MessageRenderer(container);
    renderer.follow.isPinned = true;

    renderer.renderUserMessage({ content: "hello" });

    expect(container.scrollTop).toBe(600);
  });
});

describe("the message entrance animation (CSS contract)", () => {
  it("fades in without moving or scaling the capsule", () => {
    // `translateY(8px) scale(0.98)` drew a freshly sent capsule behind the
    // composer for its first frames and rendered its rounded, backdrop-blurred
    // edge scaled — the "irregular outline" a user reported.
    const css = readFileSync("public/style.css", "utf8"); // vitest cwd = repo root
    const block = css.match(/@keyframes msgIn \{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    expect(block[1]).toContain("opacity: 0");
    expect(block[1]).not.toContain("transform");
  });
});

describe("the typing caret under reduced motion (CSS contract)", () => {
  it("keeps blinking slowly instead of resting lit, like the status dot", () => {
    // Windows' "Animation effects → off" maps to prefers-reduced-motion, whose
    // global cap (0.01ms, one iteration) left the caret visible but frozen —
    // indistinguishable from a text cursor parked after text that stopped
    // arriving. Both exceptions must survive the cap.
    const css = readFileSync("public/style.css", "utf8");
    const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    const body = block[1];
    expect(body).toContain(".status-indicator.streaming");
    expect(body).toContain(".streaming-text.typing");
    const caret = body.slice(body.indexOf(".streaming-text.typing"));
    expect(caret).toContain("animation-iteration-count: infinite");
    expect(caret).toContain("animation-duration: 1.4s");
  });
});
