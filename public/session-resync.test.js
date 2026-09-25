import { afterEach, describe, expect, test, vi } from "vitest";
import { renderTranscriptFromEntries, resyncTranscript } from "./session-resync.js";

function makeRenderers() {
  return {
    messageRenderer: {
      renderUserMessage: vi.fn(),
      renderAssistantMessage: vi.fn(),
      highlightSearchQuery: vi.fn(),
    },
    toolCardRenderer: {
      createHistoryCard: vi.fn(),
      addHistoryResult: vi.fn(),
    },
  };
}

// Raw session entries (sessionManager.getEntries() shape): a mix of message
// roles plus a non-message entry that must be skipped.
const fixture = [
  { type: "summary", summary: "compacted preamble" },
  {
    type: "message",
    message: {
      role: "user",
      content: [
        { type: "text", text: "list files" },
        { type: "image", source: { data: "aGk=", media_type: "image/png" } },
      ],
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "thinking hard" },
        { type: "text", text: "running ls" },
        { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
      ],
      usage: { input: 10, cacheRead: 5, cost: { total: 0.02 } },
    },
  },
  {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "tc-1",
      content: [{ type: "text", text: "file-a\nfile-b" }],
      isError: false,
    },
  },
  { type: "message", message: { role: "user", content: "" } },
];

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("renderTranscriptFromEntries", () => {
  test("maps entries to user/assistant/tool-card renders and reports counts", () => {
    const renderers = makeRenderers();
    const onAssistantUsage = vi.fn();
    const counts = renderTranscriptFromEntries(fixture, { ...renderers, onAssistantUsage });

    expect(counts).toEqual({ user: 1, assistant: 1, toolCards: 1, toolResults: 1 });

    // User message: text + extracted image, rendered in history mode.
    expect(renderers.messageRenderer.renderUserMessage).toHaveBeenCalledTimes(1);
    expect(renderers.messageRenderer.renderUserMessage).toHaveBeenCalledWith(
      { content: "list files", images: [{ data: "aGk=", mimeType: "image/png" }] },
      true,
    );

    // Assistant message: text/thinking blocks + usage, history mode.
    expect(renderers.messageRenderer.renderAssistantMessage).toHaveBeenCalledTimes(1);
    const [assistantArg] = renderers.messageRenderer.renderAssistantMessage.mock.calls[0];
    expect(assistantArg.content).toEqual([
      { type: "thinking", thinking: "thinking hard" },
      { type: "text", text: "running ls" },
    ]);
    expect(assistantArg.usage).toEqual({ input: 10, cacheRead: 5, cost: { total: 0.02 } });
    expect(renderers.messageRenderer.renderAssistantMessage.mock.calls[0].slice(1)).toEqual([
      false,
      true,
    ]);
    expect(onAssistantUsage).toHaveBeenCalledWith(assistantArg.usage);

    // Tool call → compact history card; tool result attached to the card.
    expect(renderers.toolCardRenderer.createHistoryCard).toHaveBeenCalledWith({
      toolCallId: "tc-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(renderers.toolCardRenderer.addHistoryResult).toHaveBeenCalledWith(
      "tc-1",
      { content: [{ type: "text", text: "file-a\nfile-b" }] },
      false,
    );
  });

  test("renders a plain string user message without image extraction", () => {
    const renderers = makeRenderers();
    renderTranscriptFromEntries(
      [{ type: "message", message: { role: "user", content: "hi there" } }],
      renderers,
    );
    expect(renderers.messageRenderer.renderUserMessage).toHaveBeenCalledWith(
      { content: "hi there", images: undefined },
      true,
    );
  });

  test("renders tool calls without any assistant text as cards only", () => {
    const renderers = makeRenderers();
    const counts = renderTranscriptFromEntries(
      [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tc-2", name: "read", arguments: {} }],
          },
        },
      ],
      renderers,
    );
    expect(counts).toEqual({ user: 0, assistant: 0, toolCards: 1, toolResults: 0 });
    expect(renderers.messageRenderer.renderAssistantMessage).not.toHaveBeenCalled();
    expect(renderers.toolCardRenderer.createHistoryCard).toHaveBeenCalledTimes(1);
  });

  test("non-array and empty inputs render nothing", () => {
    const renderers = makeRenderers();
    expect(renderTranscriptFromEntries(undefined, renderers)).toEqual({
      user: 0,
      assistant: 0,
      toolCards: 0,
      toolResults: 0,
    });
    expect(renderTranscriptFromEntries([], renderers)).toEqual({
      user: 0,
      assistant: 0,
      toolCards: 0,
      toolResults: 0,
    });
    expect(renderers.messageRenderer.renderUserMessage).not.toHaveBeenCalled();
  });

  test("highlights a search query after rendering", () => {
    const renderers = makeRenderers();
    renderTranscriptFromEntries(fixture, { ...renderers, searchQuery: "files" });
    expect(renderers.messageRenderer.highlightSearchQuery).toHaveBeenCalledWith("files");
  });
});

describe("resyncTranscript", () => {
  function makeWs(requestId = "req-1") {
    const ws = new EventTarget();
    ws.send = vi.fn(() => requestId);
    return ws;
  }

  test("renders entries from the matching command response", async () => {
    const ws = makeWs();
    const entries = [{ type: "message", message: { role: "user", content: "hi" } }];
    const renderEntries = vi.fn();
    const onStatus = vi.fn();

    const promise = resyncTranscript({ wsClient: ws, renderEntries, onStatus });
    ws.dispatchEvent(
      new CustomEvent("commandResponse", {
        detail: { id: "req-1", success: true, data: { entries } },
      }),
    );
    await expect(promise).resolves.toBe(true);

    expect(ws.send).toHaveBeenCalledWith({ type: "get_messages" });
    expect(renderEntries).toHaveBeenCalledWith(entries);
    expect(onStatus.mock.calls.map((call) => call[0])).toEqual(["start", "done"]);
  });

  test("matches responses correlated by requestId as well as id", async () => {
    const ws = makeWs("req-7");
    const renderEntries = vi.fn();
    const promise = resyncTranscript({ wsClient: ws, renderEntries, onStatus: vi.fn() });
    ws.dispatchEvent(
      new CustomEvent("commandResponse", {
        detail: { requestId: "req-7", success: true, data: { entries: [{}] } },
      }),
    );
    await expect(promise).resolves.toBe(true);
    expect(renderEntries).toHaveBeenCalledTimes(1);
  });

  test("ignores responses for other requests until the matching one arrives", async () => {
    const ws = makeWs("req-1");
    const renderEntries = vi.fn();
    const promise = resyncTranscript({ wsClient: ws, renderEntries, onStatus: vi.fn() });
    ws.dispatchEvent(
      new CustomEvent("commandResponse", {
        detail: { id: "req-99", success: true, data: { entries: [{ other: true }] } },
      }),
    );
    ws.dispatchEvent(
      new CustomEvent("commandResponse", {
        detail: { id: "req-1", success: true, data: { entries: [{ mine: true }] } },
      }),
    );
    await expect(promise).resolves.toBe(true);
    expect(renderEntries).toHaveBeenCalledWith([{ mine: true }]);
  });

  test("keeps the transcript on an empty entries response", async () => {
    const ws = makeWs();
    const renderEntries = vi.fn();
    const onStatus = vi.fn();
    const promise = resyncTranscript({ wsClient: ws, renderEntries, onStatus });
    ws.dispatchEvent(
      new CustomEvent("commandResponse", {
        detail: { id: "req-1", success: true, data: { entries: [] } },
      }),
    );
    await expect(promise).resolves.toBe(true);
    expect(renderEntries).not.toHaveBeenCalled();
    expect(onStatus.mock.calls.map((call) => call[0])).toEqual(["start", "done"]);
  });

  test("reports failed on an error response without rendering", async () => {
    const ws = makeWs();
    const renderEntries = vi.fn();
    const onStatus = vi.fn();
    const promise = resyncTranscript({ wsClient: ws, renderEntries, onStatus });
    ws.dispatchEvent(
      new CustomEvent("commandResponse", {
        detail: { id: "req-1", success: false, error: "No context available" },
      }),
    );
    await expect(promise).resolves.toBe(false);
    expect(renderEntries).not.toHaveBeenCalled();
    expect(onStatus.mock.calls.map((call) => call[0])).toEqual(["start", "failed"]);
  });

  test("times out when no response arrives", async () => {
    vi.useFakeTimers();
    const ws = makeWs();
    const renderEntries = vi.fn();
    const onStatus = vi.fn();
    const promise = resyncTranscript({
      wsClient: ws,
      renderEntries,
      onStatus,
      timeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBe(false);
    expect(renderEntries).not.toHaveBeenCalled();
    expect(onStatus.mock.calls.map((call) => call[0])).toEqual(["start", "failed"]);
  });

  test("fails fast when the socket is not connected (send returns null)", async () => {
    const ws = new EventTarget();
    ws.send = vi.fn(() => null);
    const renderEntries = vi.fn();
    const onStatus = vi.fn();
    await expect(resyncTranscript({ wsClient: ws, renderEntries, onStatus })).resolves.toBe(false);
    expect(renderEntries).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith("failed");
  });

  test("reports failed when the re-render throws", async () => {
    const ws = makeWs();
    const onStatus = vi.fn();
    const promise = resyncTranscript({
      wsClient: ws,
      renderEntries: () => {
        throw new Error("render boom");
      },
      onStatus,
    });
    ws.dispatchEvent(
      new CustomEvent("commandResponse", {
        detail: { id: "req-1", success: true, data: { entries: [{ type: "message" }] } },
      }),
    );
    await expect(promise).resolves.toBe(false);
    expect(onStatus.mock.calls.map((call) => call[0])).toEqual(["start", "failed"]);
  });
});
