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
 */
export function renderTranscriptFromEntries(
  entries,
  { messageRenderer, toolCardRenderer, searchQuery = "" } = {},
) {
  const counts = {
    user: 0,
    assistant: 0,
    toolCards: 0,
    toolResults: 0,
    notices: 0,
    compactions: 0,
  };
  if (!Array.isArray(entries)) return counts;

  for (const entry of entries) {
    // A committed compaction is a transcript item of its own: the session's
    // branch continues from it and the history it summarized is gone from the
    // file, so without a block here a compacted session (loaded, peeked, or
    // repainted by the snapshot a manual compaction broadcasts) would show the
    // kept tail with a silent hole where the rest of the conversation was. The
    // summary is the only remaining record of it — same as omp's own TUI.
    if (entry?.type === "compaction") {
      if (typeof messageRenderer.renderCompaction === "function") {
        const drawn = messageRenderer.renderCompaction({ id: entry.id, summary: entry.summary });
        if (drawn) counts.compactions++;
      }
      continue;
    }
    // Displayable session notices (`async-result` for a delivered background
    // job, `launch-completion`, late diagnostics) are entries of their own kind
    // and part of the transcript; `display: false` ones are hidden by design.
    if (entry?.type === "custom_message") {
      if (entry.display !== false && typeof messageRenderer.renderNotice === "function") {
        const drawn = messageRenderer.renderNotice({
          id: entry.id,
          customType: entry.customType,
          content: entry.content,
        });
        if (drawn) counts.notices++;
      }
      continue;
    }
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
          { content: content || "", images: images.length > 0 ? images : undefined, id: entry.id },
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
            // The entry id is what every tree action (fork, rewind) and every
            // adoption/lookup resolves the element by, and the timestamp is the
            // runtime identity a late frame matches on — without them a history
            // render left the placeholder id on the element (`streaming`) and no
            // identity at all, so a replayed `message_end` could not adopt it.
            id: msg.id || entry.id,
            timestamp: msg.timestamp,
            content: contentBlocks.length > 0 ? contentBlocks : text,
            usage: msg.usage,
          },
          false,
          true,
        );
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
 * Render entries the same way `renderTranscriptFromEntries` does, but in
 * time-sliced chunks.
 *
 * A huge session (measured: 4826 entries / 16.5 MB) blocks the main thread for
 * ~5 s in one pass, so the whole window freezes and the transcript appears to
 * flicker as it is cleared and refilled. Yielding between slices keeps the UI
 * (and the scroll-follow policy) responsive and lets the caller report progress;
 * the elements still land in `#messages` in order, because each chunk appends
 * through the same renderers.
 *
 * @param {Array} entries - raw session entries (already id-stamped by the caller)
 * @param {object} options - identical to `renderTranscriptFromEntries`
 * @param {object} [chunk] - `chunkSize` entries per slice, `yieldTo` scheduler,
 *   `onProgress(done, total)` reporter, `shouldContinue()` abort check (evaluated
 *   after every yield so a newer view can stop a render mid-flight)
 * @returns {Promise<object>} merged per-kind counts
 */
export async function renderTranscriptFromEntriesChunked(
  entries,
  options = {},
  { chunkSize = 80, yieldTo = null, onProgress = null, shouldContinue = null } = {},
) {
  const counts = {
    user: 0,
    assistant: 0,
    toolCards: 0,
    toolResults: 0,
    notices: 0,
    compactions: 0,
  };
  const list = Array.isArray(entries) ? entries : [];
  const pause = yieldTo || (() => new Promise((resolve) => setTimeout(resolve, 0)));
  for (let start = 0; start < list.length; start += chunkSize) {
    if (start > 0 && shouldContinue && !shouldContinue()) return counts;
    const slice = list.slice(start, start + chunkSize);
    // The search highlight runs once for the whole transcript, after the last
    // slice: highlighting per slice would walk the same growing DOM N times.
    const sliceOptions =
      options.searchQuery && start + chunkSize < list.length
        ? { ...options, searchQuery: "" }
        : options;
    const partial = renderTranscriptFromEntries(slice, sliceOptions);
    for (const kind of Object.keys(counts)) counts[kind] += partial[kind] || 0;
    if (start + chunkSize < list.length) {
      onProgress?.(Math.min(start + chunkSize, list.length), list.length);
      await pause();
    }
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
