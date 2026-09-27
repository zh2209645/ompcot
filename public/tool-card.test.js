import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCardRenderer } from "./tool-card.js";

describe("ToolCardRenderer streaming updates", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new ToolCardRenderer(container);
  });

  function streamingExecution(overrides = {}) {
    return {
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "echo hi" },
      status: "pending",
      output: "",
      ...overrides,
    };
  }

  it("keeps a card the user collapsed collapsed while output keeps streaming", () => {
    const execution = streamingExecution();
    renderer.createToolCard(execution);
    const card = container.querySelector(".tool-card");
    const body = card.querySelector(".tool-card-body");

    renderer.updateToolCard(streamingExecution({ status: "streaming", output: "line 1" }));
    expect(body.classList.contains("expanded")).toBe(true);

    // The user collapses the running card …
    card.querySelector(".tool-card-header").click();
    expect(body.classList.contains("expanded")).toBe(false);

    // … and the next partial outputs must not pop it back open.
    renderer.updateToolCard(streamingExecution({ status: "streaming", output: "line 1\nline 2" }));
    renderer.updateToolCard(
      streamingExecution({ status: "streaming", output: "line 1\nline 2\nline 3" }),
    );
    expect(body.classList.contains("expanded")).toBe(false);
  });

  it("writes the status pill only when the status actually changes", async () => {
    renderer.createToolCard(streamingExecution());
    const card = container.querySelector(".tool-card");
    const statusElement = card.querySelector(".tool-status");

    const mutations = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) mutations.push(record.type);
    });
    observer.observe(statusElement, { attributes: true, childList: true, characterData: true });
    const flushMutations = () => new Promise((resolve) => setTimeout(resolve, 0));

    renderer.updateToolCard(streamingExecution({ status: "streaming", output: "a" }));
    await flushMutations();
    const afterTransition = mutations.length;
    expect(afterTransition).toBeGreaterThan(0);
    expect(statusElement.className).toBe("tool-status streaming");

    for (let i = 0; i < 5; i++) {
      renderer.updateToolCard(
        streamingExecution({ status: "streaming", output: `a${"\nb".repeat(i + 1)}` }),
      );
    }
    await flushMutations();
    // Repeated partial-output refreshes must not touch the pill again.
    expect(mutations.length).toBe(afterTransition);

    renderer.finalizeToolCard("call_1", { content: [{ type: "text", text: "done" }] }, false);
    await flushMutations();
    expect(mutations.length).toBeGreaterThan(afterTransition);
    expect(statusElement.className).toBe("tool-status complete");

    observer.disconnect();
  });

  it("does not rewrite the output element when the text is unchanged", () => {
    renderer.createToolCard(streamingExecution({ status: "streaming", output: "same" }));
    const output = container.querySelector(".tool-output");
    output.dataset.probe = "kept";

    renderer.updateToolCard(streamingExecution({ status: "streaming", output: "same" }));

    // Replacing textContent would drop the marker and reset the inner scroll.
    expect(output.dataset.probe).toBe("kept");
    expect(output.textContent).toBe("same");
  });

  it("ends a finished card with a single status transition", () => {
    renderer.createToolCard(streamingExecution({ status: "streaming", output: "partial" }));
    const statusElement = container.querySelector(".tool-status");

    renderer.finalizeToolCard("call_1", { content: [{ type: "text", text: "final" }] }, false);
    expect(statusElement.className).toBe("tool-status complete");
    expect(container.querySelector(".tool-output").textContent).toContain("final");
    expect(container.querySelector(".tool-card-body").classList.contains("expanded")).toBe(false);
  });
});

describe("ToolCardRenderer follow behavior", () => {
  it("pins to the bottom without the transcript's smooth scroll animation", async () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 100, configurable: true });
    container.scrollTop = 950;
    container.style.scrollBehavior = "smooth";
    const renderer = new ToolCardRenderer(container);

    renderer.scrollToBottom();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(container.scrollTop).toBe(1000);
    expect(container.style.scrollBehavior).toBe("smooth");
  });

  it("stays put when the viewport is scrolled away from the bottom", async () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 100, configurable: true });
    container.scrollTop = 200;
    const renderer = new ToolCardRenderer(container);
    const raf = vi.fn();
    renderer.scrollToBottom();

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(container.scrollTop).toBe(200);
    expect(raf).not.toHaveBeenCalled();
  });
});

describe("ToolCardRenderer history cards use the live status", () => {
  it("draws a still-running call as Working…, not Done", () => {
    const container = document.createElement("div");
    const renderer = new ToolCardRenderer(container, {
      statusLookup: (toolCallId) => (toolCallId === "call_live" ? "streaming" : null),
    });

    renderer.createHistoryCard({ toolCallId: "call_live", toolName: "eval", args: {} });
    const running = container.querySelector(".tool-card[data-tool-call-id='call_live']");
    expect(running.dataset.toolStatus).toBe("streaming");
    expect(running.querySelector(".tool-status").className).toBe("tool-status streaming");

    renderer.createHistoryCard({ toolCallId: "call_done", toolName: "bash", args: {} });
    const finished = container.querySelector(".tool-card[data-tool-call-id='call_done']");
    expect(finished.dataset.toolStatus).toBe("complete");
    expect(finished.querySelector(".tool-status").className).toBe("tool-status complete");
  });

  it("falls back to Done without a status source", () => {
    const container = document.createElement("div");
    const renderer = new ToolCardRenderer(container);

    renderer.createHistoryCard({ toolCallId: "call_1", toolName: "bash", args: {} });

    expect(container.querySelector(".tool-status").className).toBe("tool-status complete");
  });
});

describe("ToolCardRenderer identity (one card per tool call)", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new ToolCardRenderer(container);
  });

  const execution = (overrides = {}) => ({
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "ls" },
    status: "pending",
    output: "",
    ...overrides,
  });

  it("a replayed createToolCard reuses the existing card", () => {
    const first = renderer.createToolCard(execution());
    const second = renderer.createToolCard(execution());

    expect(second).toBe(first);
    expect(container.querySelectorAll(".tool-card")).toHaveLength(1);
  });

  it("updateToolCard never appends a second card for the same call", () => {
    const first = renderer.createToolCard(execution());
    renderer.updateToolCard(execution({ status: "streaming", output: "partial" }));
    const updated = renderer.updateToolCard(
      execution({ status: "streaming", output: "partial more" }),
    );

    expect(updated).toBe(first);
    expect(container.querySelectorAll(".tool-card")).toHaveLength(1);
    expect(container.querySelector(".tool-output").textContent).toBe("partial more");
  });

  it("a history render reuses a live card instead of duplicating it", () => {
    const live = renderer.createToolCard(execution());
    const history = renderer.createHistoryCard({
      toolCallId: "call_1",
      toolName: "bash",
      args: {},
    });

    expect(history).toBe(live);
    expect(container.querySelectorAll(".tool-card")).toHaveLength(1);
  });

  it("creates a fresh card once the previous one was detached by a re-render", () => {
    const stale = renderer.createToolCard(execution());
    container.replaceChildren();

    // The live update path (what a tool event does) must rebuild into the
    // current transcript rather than write into the detached card.
    const fresh = renderer.updateToolCard(
      execution({ status: "streaming", output: "after re-render" }),
    );

    expect(fresh).not.toBe(stale);
    expect(container.querySelectorAll(".tool-card")).toHaveLength(1);
    expect(container.querySelector(".tool-output").textContent).toBe("after re-render");
  });
});
