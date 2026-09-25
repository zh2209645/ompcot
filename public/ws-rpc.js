// Shared WebSocket request/response helper.
//
// Feature modules (agent-hub.js, mcp-manager.js) talk to the embedded server
// with the same one-shot pattern: `wsClient.send({type, ...})` returns a
// requestId, and the correlated reply arrives later as a `commandResponse`
// CustomEvent whose detail carries the same requestId (or `id`). This module
// wraps that handshake into a single promise that always resolves — never
// rejects — with `{ok, data}` / `{ok: false, error}`, so callers can render
// inline errors without try/catch ceremony and a dropped reply degrades into
// a normal error state instead of an unhandled rejection.
//
// Envelope tolerance mirrors composer-commands.js: accept `data`/`result`
// wrappers and both requestId spellings so minor server-side reshapes stay
// safe.

export const WS_RPC_TIMEOUT_MS = 8000;

function normalizeResponse(detail) {
  if (!detail) return { ok: false, error: "timeout" };
  if (detail.success === false || detail.error != null) {
    return { ok: false, error: String(detail.error || "request-failed") };
  }
  const data =
    detail.data !== undefined ? detail.data : detail.result !== undefined ? detail.result : null;
  return { ok: true, data };
}

/**
 * Send `command` over the WebSocket client and await the correlated reply.
 * Resolves `{ok: true, data}` on success, `{ok: false, error}` when the send
 * fails, times out, or the server replies with an error envelope.
 *
 * @param {EventTarget} wsClient - WebSocketClient (send + commandResponse)
 * @param {object} command - `{type: "...", ...}` payload for wsClient.send
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, data?: unknown, error?: string}>}
 */
export function wsRpc(wsClient, command, { timeoutMs = WS_RPC_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let requestId = null;
    try {
      requestId = wsClient.send(command);
    } catch (err) {
      console.error("[WsRpc] send failed:", command?.type, err);
    }
    if (!requestId) {
      // Not connected — surface as a normal failure so the caller's error
      // UI stays the single funnel for bad states.
      resolve({ ok: false, error: "not-connected" });
      return;
    }
    const timer = setTimeout(finish, timeoutMs);
    function finish(detail) {
      clearTimeout(timer);
      wsClient.removeEventListener("commandResponse", onResponse);
      resolve(normalizeResponse(detail));
    }
    function onResponse(event) {
      const detail = event.detail || {};
      if (detail.requestId !== requestId && detail.id !== requestId) return;
      finish(detail);
    }
    wsClient.addEventListener("commandResponse", onResponse);
  });
}
