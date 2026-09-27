/**
 * State Manager - Manages chat state
 */

/**
 * Lifecycle order of a tool call's status. A call moves forward only: frames
 * repeat (a replayed `tool_execution_start` after a reconnect, a snapshot
 * re-render mid-run, an `update` that was already in flight when the result
 * landed), and merging them blindly flipped a finished pill back to
 * "Working…" — which also restarted its pulse animation, so the badge blinked
 * and could stay wrong for good.
 */
const TOOL_STATUS_RANK = { pending: 0, streaming: 1, complete: 2, error: 2 };

/**
 * Highest status the call has reported; unknown/absent statuses never win.
 * Exported so the card renderer enforces the same order on the DOM.
 */
export function nextToolStatus(current, next) {
  if (typeof next !== "string" || !(next in TOOL_STATUS_RANK)) {
    return current ?? next;
  }
  if (typeof current !== "string" || !(current in TOOL_STATUS_RANK)) return next;
  // A finished call keeps the outcome it reported first: a duplicated or
  // out-of-order frame must not relabel an error "Done" (or the reverse).
  if (TOOL_STATUS_RANK[current] >= 2) return current;
  return TOOL_STATUS_RANK[next] >= TOOL_STATUS_RANK[current] ? next : current;
}

/**
 * Fold an incoming tool update into the known state of that call.
 *
 * Monotonic in both directions that matter to the UI: the status never moves
 * backwards, and a partial output is never replaced by an empty one (the
 * start frame of a replayed call carries no output).
 */
export function mergeToolExecution(existing, incoming) {
  const base = existing ? { ...existing } : { status: "pending", output: "", isError: false };
  const merged = { ...base, ...incoming };
  merged.status = nextToolStatus(base.status, incoming?.status);
  if (!incoming?.output && base.output) merged.output = base.output;
  if (base.isError) merged.isError = true;
  return merged;
}

export class StateManager {
  constructor() {
    this.messages = [];
    this.toolExecutions = new Map(); // toolCallId -> tool execution data
    this.isStreaming = false;
    this.currentStreamingMessage = null;
    this.listeners = new Set();
  }

  addListener(callback) {
    this.listeners.add(callback);
  }

  removeListener(callback) {
    this.listeners.delete(callback);
  }

  notifyListeners() {
    this.listeners.forEach((callback) => {
      callback();
    });
  }

  addMessage(message) {
    this.messages.push(message);
    this.notifyListeners();
  }

  updateLastMessage(updates) {
    if (this.messages.length > 0) {
      const lastMessage = this.messages[this.messages.length - 1];
      Object.assign(lastMessage, updates);
      this.notifyListeners();
    }
  }

  setStreamingMessage(message) {
    this.currentStreamingMessage = message;
    this.notifyListeners();
  }

  clearStreamingMessage() {
    this.currentStreamingMessage = null;
    this.notifyListeners();
  }

  setStreaming(isStreaming) {
    this.isStreaming = isStreaming;
    this.notifyListeners();
  }

  addToolExecution(toolCallId, data) {
    const existing = this.toolExecutions.get(toolCallId);
    this.toolExecutions.set(toolCallId, mergeToolExecution(existing, { toolCallId, ...data }));
    this.notifyListeners();
  }

  updateToolExecution(toolCallId, updates) {
    const tool = this.toolExecutions.get(toolCallId);
    if (tool) {
      this.toolExecutions.set(toolCallId, mergeToolExecution(tool, updates));
      this.notifyListeners();
    }
  }

  getToolExecution(toolCallId) {
    return this.toolExecutions.get(toolCallId);
  }

  getAllToolExecutions() {
    return Array.from(this.toolExecutions.values());
  }

  reset() {
    this.messages = [];
    this.toolExecutions.clear();
    this.isStreaming = false;
    this.currentStreamingMessage = null;
    this.notifyListeners();
  }
}
