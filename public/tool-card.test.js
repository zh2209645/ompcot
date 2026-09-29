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

  it("keeps a finished pill finished when a late update arrives", () => {
    // Reported symptom: a running `wait` card kept flipping back to
    // "Working…", restarting its pulse animation. A frame that lands after the
    // end (duplicate, replayed, out-of-order) must not move the pill
    // backwards.
    renderer.createToolCard(streamingExecution({ toolName: "wait", status: "streaming" }));
    const statusElement = container.querySelector(".tool-status");
    renderer.finalizeToolCard("call_1", { content: [{ type: "text", text: "ready" }] }, false);

    renderer.updateToolCard(
      streamingExecution({ toolName: "wait", status: "streaming", output: "ready" }),
    );
    renderer.updateToolCard(
      streamingExecution({ toolName: "wait", status: "pending", output: "ready" }),
    );

    expect(statusElement.className).toBe("tool-status complete");
    expect(statusElement.textContent).toBe("Done");
    expect(container.querySelector(".tool-output").textContent).toBe("ready");
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

describe("ToolCardRenderer history cards use the live state", () => {
  it("draws a still-running call as Working…, not Done", () => {
    const container = document.createElement("div");
    const renderer = new ToolCardRenderer(container, {
      liveLookup: (toolCallId) => (toolCallId === "call_live" ? { status: "streaming" } : null),
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

  it("keeps the output the live view already showed when the file has no result yet", () => {
    // omp 18.4.2 emits `tool_execution_end` as soon as a call settles but holds
    // its tool-result message until every earlier call in the batch has one, so
    // a repaint while a sibling tool still runs finds a settled call with no
    // result entry in the session file. The card must not come back empty.
    const container = document.createElement("div");
    const renderer = new ToolCardRenderer(container, {
      liveLookup: (toolCallId) =>
        toolCallId === "call_seeded" ? { status: "complete", output: "11 files changed" } : null,
    });

    renderer.createHistoryCard({ toolCallId: "call_seeded", toolName: "bash", args: {} });
    const seeded = container.querySelector(".tool-card[data-tool-call-id='call_seeded']");
    expect(seeded.dataset.toolStatus).toBe("complete");
    expect(seeded.querySelector(".tool-output").textContent).toBe("11 files changed");

    // The file stays authoritative: its result entry replaces the seeded body.
    renderer.addHistoryResult("call_seeded", { content: [{ type: "text", text: "done" }] }, false);
    expect(seeded.querySelector(".tool-output").textContent).toBe("done");

    // An out-of-order (held) file result still wins over the live seed.
    renderer.addHistoryResult("call_held", { content: [{ type: "text", text: "file" }] }, false);
    renderer.createHistoryCard({ toolCallId: "call_held", toolName: "bash", args: {} });
    expect(
      container.querySelector(".tool-card[data-tool-call-id='call_held'] .tool-output").textContent,
    ).toBe("file");
  });

  it("falls back to Done without a live source", () => {
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

describe("ToolCardRenderer status settling", () => {
  let container;

  beforeEach(() => {
    container = document.createElement("div");
  });

  it("settles a history card to done when its result lands, even if the live status still says streaming", () => {
    // What a peek/suppressed frame leaves behind: the live lookup never saw the
    // end frame, so the reloaded card is drawn "Working…" — and without the
    // result settling it, the pill pulsed forever.
    const renderer = new ToolCardRenderer(container, {
      liveLookup: () => ({ status: "streaming" }),
    });
    renderer.createHistoryCard({ toolCallId: "call_9", toolName: "bash", args: { command: "x" } });
    const pill = container.querySelector(".tool-status");
    expect(pill.className).toContain("streaming");

    renderer.addHistoryResult("call_9", { content: [{ type: "text", text: "done" }] }, false);

    expect(pill.className).toContain("complete");
    expect(pill.className).not.toContain("streaming");
    expect(container.querySelector(".tool-output").textContent).toBe("done");
  });

  it("keeps an errored history result labelled as an error", () => {
    const renderer = new ToolCardRenderer(container, {
      liveLookup: () => ({ status: "streaming" }),
    });
    renderer.createHistoryCard({ toolCallId: "call_10", toolName: "bash", args: {} });

    renderer.addHistoryResult("call_10", { content: [{ type: "text", text: "boom" }] }, true);

    expect(container.querySelector(".tool-status").className).toContain("error");
  });

  it("holds a tool result until the card it belongs to is drawn", () => {
    // Tail-first hydration paints slices newest-first, so the result of a call
    // can be rendered before the assistant message that made it. Dropping it
    // here left the card stuck on "Working…" with an empty body — the result is
    // the only thing that settles a card drawn from the session file.
    const renderer = new ToolCardRenderer(container);

    renderer.addHistoryResult("call_11", { content: [{ type: "text", text: "file-a" }] }, false);
    expect(container.querySelector(".tool-card")).toBe(null);

    renderer.createHistoryCard({
      toolCallId: "call_11",
      toolName: "bash",
      args: { command: "ls" },
    });

    const card = container.querySelector(".tool-card");
    expect(card.querySelector(".tool-status").className).toContain("complete");
    expect(card.querySelector(".tool-output").textContent).toBe("file-a");
  });

  it("drops held results when the transcript is cleared", () => {
    const renderer = new ToolCardRenderer(container);
    renderer.addHistoryResult("call_12", { content: [{ type: "text", text: "stale" }] }, false);
    renderer.clear();
    renderer.createHistoryCard({ toolCallId: "call_12", toolName: "bash", args: {} });

    // A result from a session that is no longer on screen must not paint into a
    // card of the one that is.
    expect(container.querySelector(".tool-output").textContent).not.toBe("stale");
  });

  it("finalizes the card on screen after a re-render dropped the renderer's index", () => {
    const renderer = new ToolCardRenderer(container);
    renderer.createToolCard({
      toolCallId: "call_7",
      toolName: "bash",
      args: { command: "x" },
      status: "streaming",
      output: "",
    });
    // A transcript repaint replaces the DOM and resets the index, then draws
    // the same call again from the session entries.
    renderer.clear();
    renderer.createHistoryCard({ toolCallId: "call_7", toolName: "bash", args: { command: "x" } });

    // The late end frame must land on the visible card, not on a lost index.
    renderer.finalizeToolCard("call_7", { content: [{ type: "text", text: "ok" }] }, false);

    const pill = container.querySelector(".tool-status");
    expect(pill.className).toContain("complete");
    expect(container.querySelectorAll(".tool-card")).toHaveLength(1);
    expect(container.querySelector(".tool-output").textContent).toBe("ok");
  });
});
