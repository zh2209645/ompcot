// Transcript re-sync (palette action): asks the running agent for its raw
// session entries (RPC `get_messages` → sessionManager.getEntries()) and
// re-renders the #messages transcript from them. The entry→renderer mapping
// lives here so the session-history loader in app.js (renderSessionHistory)
// and this re-sync path share exactly one implementation.
//
// Failure discipline: `resyncTranscript` only invokes `renderEntries` with a
// non-empty entries array — an empty or failed sync never wipes the current
// transcript; the caller surfaces a transient status instead.

export const RESYNC_TIMEOUT_MS = 15000;

/**
 * Map raw session entries to transcript renderer calls.
 *
 * Walk order matches the historical session render: user messages (text +
 * images), assistant messages (text/thinking blocks + compact tool cards),
 * tool results attached to their cards. Returns per-kind counts for logging.
 *
 * @param {Array} entries - raw session entries ({type:"message", message})
 * @param {object} deps
 * @param {object} deps.messageRenderer - MessageRenderer instance
 * @param {object} deps.toolCardRenderer - ToolCardRenderer instance
 * @param {string} [deps.searchQuery] - highlight query after rendering
 * @param {(usage: object) => void} [deps.onAssistantUsage] - usage/cost sink
 */
export function renderTranscriptFromEntries(
  entries,
  { messageRenderer, toolCardRenderer, searchQuery = "", onAssistantUsage = null } = {},
) {
  const counts = { user: 0, assistant: 0, toolCards: 0, toolResults: 0 };
  if (!Array.isArray(entries)) return counts;

  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : (msg.content || [])
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n");
      // Extract images from content blocks
      const images = Array.isArray(msg.content)
        ? msg.content
            .filter((b) => b.type === "image")
            .map((b) => ({
              data: b.source?.data || b.data || "",
              mimeType: b.source?.media_type || b.media_type || "image/png",
            }))
        : [];
      if (content || images.length > 0) {
        counts.user++;
        messageRenderer.renderUserMessage(
          { content: content || "", images: images.length > 0 ? images : undefined },
          true,
        );
      }
      continue;
    }

    if (msg.role === "assistant") {
      const textBlocks = (msg.content || []).filter((b) => b.type === "text");
      const thinkingBlocks = (msg.content || []).filter((b) => b.type === "thinking");
      const toolCalls = (msg.content || []).filter((b) => b.type === "toolCall");

      const contentBlocks = [];
      for (const block of msg.content || []) {
        if (block.type === "text" || block.type === "thinking") contentBlocks.push(block);
      }
      const text = textBlocks.map((b) => b.text).join("\n");

      if (text || thinkingBlocks.length > 0) {
        counts.assistant++;
        messageRenderer.renderAssistantMessage(
          {
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true,
        );
        onAssistantUsage?.(msg.usage);
      }

      // Show tool calls as compact history cards
      for (const tc of toolCalls) {
        counts.toolCards++;
        toolCardRenderer.createHistoryCard({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.arguments || {},
        });
      }
      continue;
    }

    if (msg.role === "toolResult") {
      counts.toolResults++;
      toolCardRenderer.addHistoryResult(
        msg.toolCallId,
        { content: msg.content || [] },
        msg.isError,
      );
    }
  }

  if (searchQuery && typeof messageRenderer.highlightSearchQuery === "function") {
    messageRenderer.highlightSearchQuery(searchQuery);
  }
  return counts;
}

/**
 * Send the `get_messages` RPC over the WebSocket and wait for the matching
 * command response. The broker tags replies with the originating requestId
 * (mirrored by the embedded server in `id`), so responses are correlated via
 * the id returned by `wsClient.send`.
 *
 * @param {object} deps
 * @param {object} deps.wsClient - WebSocketClient (must be connected)
 * @param {(entries: Array) => void} deps.renderEntries - re-render callback
 * @param {(kind: "start"|"done"|"failed") => void} [deps.onStatus] - status sink
 * @param {number} [deps.timeoutMs] - response timeout
 * @returns {Promise<boolean>} true when entries were rendered
 */
export async function resyncTranscript({
  wsClient,
  renderEntries,
  onStatus = () => {},
  timeoutMs = RESYNC_TIMEOUT_MS,
}) {
  if (!wsClient || typeof renderEntries !== "function") {
    onStatus("failed");
    return false;
  }

  onStatus("start");
  const requestId = wsClient.send({ type: "get_messages" });
  if (!requestId) {
    // Not connected — surface the failure, keep the current transcript.
    onStatus("failed");
    return false;
  }

  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      wsClient.removeEventListener("commandResponse", handleResponse);
      resolve(result);
    };

    timer = setTimeout(() => {
      onStatus("failed");
      finish(false);
    }, timeoutMs);

    const handleResponse = (event) => {
      const detail = event.detail || {};
      if (detail.requestId !== requestId && detail.id !== requestId) return;
      const entries = detail.data?.entries;
      if (detail.success && Array.isArray(entries) && entries.length > 0) {
        try {
          renderEntries(entries);
          onStatus("done");
          finish(true);
        } catch (err) {
          console.error("[Resync] Failed to re-render transcript:", err);
          onStatus("failed");
          finish(false);
        }
        return;
      }
      // Failed sync or an empty transcript: keep the current DOM as-is.
      onStatus(detail.success ? "done" : "failed");
      finish(detail.success === true);
    };

    wsClient.addEventListener("commandResponse", handleResponse);
  });
}
