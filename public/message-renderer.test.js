import { beforeEach, describe, expect, it } from "vitest";
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
