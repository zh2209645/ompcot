/**
 * Debug capture — a bounded, always-safe record of what the GUI saw and did.
 *
 * Rendering bugs (a transcript item drawn twice, a stale status pill, a
 * viewport that stopped following) are invisible in the session file: the file
 * holds one entry and the DOM shows two elements, so the evidence has to come
 * from the window itself. This module keeps the last N observations in a ring
 * buffer — console output, window errors, WebSocket frames in both directions,
 * session-routing decisions and transcript element operations — so a report can
 * be exported as one JSON bundle instead of asking for a screenshot.
 *
 * Rules:
 * - capture never throws and never recurses into itself (the console wrapper
 *   calls the original method, and its own failures are swallowed);
 * - payloads are summarized and truncated: a streaming reply produces thousands
 *   of frames, and a bundle that kept them verbatim would be hundreds of MB;
 * - the buffer is bounded by both entry count and total bytes, dropping the
 *   oldest observations first.
 */

export const DEBUG_LOG_LIMIT = 5000;
export const DEBUG_LOG_MAX_BYTES = 4 * 1024 * 1024;
/** Longest string kept for a single field of a captured payload. */
export const DEBUG_FIELD_LIMIT = 400;

/** Text summary of a value, cut to `limit` characters. */
export function summarizeValue(value, limit = DEBUG_FIELD_LIMIT) {
  try {
    if (value === null || value === undefined) return value ?? null;
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") {
      return value.length > limit ? `${value.slice(0, limit)}…(+${value.length - limit})` : value;
    }
    const json = JSON.stringify(value);
    if (typeof json !== "string") return String(value);
    return json.length > limit ? `${json.slice(0, limit)}…(+${json.length - limit})` : json;
  } catch {
    return "[unserializable]";
  }
}

/** Block kinds and sizes of an assistant message, without its text. */
function summarizeBlocks(content) {
  if (typeof content === "string") return `text:${content.length}`;
  if (!Array.isArray(content)) return "none";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "?";
      if (block.type === "text") return `text:${(block.text || "").length}`;
      if (block.type === "thinking") return `thinking:${(block.thinking || "").length}`;
      if (block.type === "toolCall") return `toolCall:${block.name || "?"}`;
      return String(block.type || "?");
    })
    .join(",");
}

/** One transcript event, without its payload. */
export function summarizeTranscriptEvent(event) {
  const message = event?.message || null;
  return {
    type: event?.type ?? null,
    role: message?.role ?? null,
    ts: message?.timestamp ?? null,
    messageId: message?.id ?? null,
    entryId: event?.entryId ?? event?.messageId ?? null,
    blocks: message ? summarizeBlocks(message.content) : null,
    stopReason: message?.stopReason ?? null,
    toolCallId: event?.toolCallId ?? null,
    toolName: event?.toolName ?? null,
    isError: event?.isError ?? null,
  };
}

/**
 * Small, comparable summary of one WebSocket frame.
 *
 * Frames arrive per streaming delta, so the summary carries sizes, ids and
 * routing metadata — never message text or tool output.
 */
export function summarizeWsFrame(direction, payload) {
  const type = payload?.type ?? "?";
  const frame = { dir: direction, type };
  if (payload && typeof payload === "object") {
    if (payload.id) frame.id = summarizeValue(payload.id, 60);
    if (payload.command) frame.command = summarizeValue(payload.command, 60);
    if (payload.success === false) frame.error = summarizeValue(payload.error, 200);
    if (payload.sessionFile) frame.sessionFile = summarizeValue(payload.sessionFile, 200);
  }
  if (type === "event" && payload?.event) {
    frame.sessionId = summarizeValue(payload.__broker?.sessionId ?? null, 200);
    frame.sourcePort = payload.__broker?.sourcePort ?? null;
    frame.event = summarizeTranscriptEvent(payload.event);
  } else if (type === "mirror_sync") {
    frame.sessionId = summarizeValue(payload.sessionId ?? null, 200);
    frame.isStreaming = payload.isStreaming ?? null;
    frame.entryCount = Array.isArray(payload.entries) ? payload.entries.length : 0;
    frame.tail = (Array.isArray(payload.entries) ? payload.entries : []).slice(-5).map((entry) => ({
      type: entry?.type ?? null,
      id: entry?.id ?? null,
      role: entry?.message?.role ?? null,
      ts: entry?.message?.timestamp ?? null,
    }));
  }
  return frame;
}

/**
 * Ring buffer of debug observations.
 *
 * @param {object} [options]
 * @param {number} [options.limit] - most recent entries kept
 * @param {number} [options.maxBytes] - approximate size cap for the buffer
 * @param {() => number} [options.now] - clock, injectable for tests
 */
export function createDebugLog({
  limit = DEBUG_LOG_LIMIT,
  maxBytes = DEBUG_LOG_MAX_BYTES,
  now = () => Date.now(),
} = {}) {
  const entries = [];
  let bytes = 0;
  let enabled = true;

  function drop(n) {
    for (let i = 0; i < n && entries.length > 0; i++) {
      const removed = entries.shift();
      bytes -= removed?.__bytes ?? 0;
    }
    if (bytes < 0) bytes = 0;
  }

  function log(kind, data, coalesceKey = null) {
    if (!enabled) return null;
    // Streaming frames arrive per delta: folding a run of identical-key
    // observations into one counted entry keeps the limited slots for the
    // transitions that explain a bug instead of one message's 2000 updates.
    const last = entries[entries.length - 1];
    if (coalesceKey && last && last.kind === kind && last.__coalesceKey === coalesceKey) {
      last.t = now();
      last.data = data ?? null;
      last.__count = (last.__count ?? 1) + 1;
      return last;
    }
    let entry;
    try {
      entry = {
        t: now(),
        kind: String(kind),
        data: data ?? null,
        __coalesceKey: coalesceKey ?? undefined,
      };
      entry.__bytes = JSON.stringify(entry).length;
    } catch {
      entry = { t: now(), kind: String(kind), data: "[unserializable]", __bytes: 40 };
    }
    entries.push(entry);
    bytes += entry.__bytes;
    if (entries.length > limit) drop(entries.length - limit);
    while (bytes > maxBytes && entries.length > 1) drop(1);
    return entry;
  }

  return {
    log,
    /** Copy of the buffer, oldest first, without the internal size marker. */
    snapshot: () =>
      entries.map(({ __bytes, __coalesceKey, __count, ...entry }) => ({
        ...entry,
        ...(__count ? { count: __count } : {}),
      })),
    size: () => entries.length,
    bytes: () => bytes,
    clear: () => {
      entries.length = 0;
      bytes = 0;
    },
    setEnabled: (value) => {
      enabled = Boolean(value);
      return enabled;
    },
    isEnabled: () => enabled,
  };
}

/** App-wide buffer. Other modules log through `logDebug` (a no-op when off). */
export const debugLog = createDebugLog();

/** Record one observation. Never throws. */
export function logDebug(kind, data) {
  try {
    return debugLog.log(kind, data);
  } catch {
    return null;
  }
}

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"];

/**
 * Mirror console output into the debug buffer.
 *
 * Each wrapped method calls the original first (so devtools output is
 * unchanged) and swallows any capture failure — a debug recorder must never be
 * the reason the app breaks.
 *
 * @returns {() => void} uninstall
 */
export function installConsoleCapture(log = debugLog, { consoleRef = globalThis.console } = {}) {
  if (!consoleRef) return () => {};
  const originals = new Map();
  for (const method of CONSOLE_METHODS) {
    const original = consoleRef[method];
    if (typeof original !== "function") continue;
    originals.set(method, original);
    consoleRef[method] = (...args) => {
      try {
        original.apply(consoleRef, args);
      } catch {
        /* the original console is unavailable — keep the app running */
      }
      try {
        log.log(`console.${method}`, args.map((arg) => summarizeValue(arg)).join(" "));
      } catch {
        /* capture must never throw */
      }
    };
  }
  return () => {
    for (const [method, original] of originals) consoleRef[method] = original;
  };
}

/**
 * Capture window-level errors and unhandled rejections.
 *
 * @returns {() => void} uninstall
 */
export function installErrorCapture(log = debugLog, { windowRef = globalThis.window } = {}) {
  if (!windowRef?.addEventListener) return () => {};
  const onError = (event) => {
    log.log("window.error", {
      message: summarizeValue(event?.message ?? event?.error?.message ?? "unknown", 300),
      source: summarizeValue(event?.filename ?? null, 200),
      line: event?.lineno ?? null,
      column: event?.colno ?? null,
      stack: summarizeValue(event?.error?.stack ?? null, 600),
    });
  };
  const onRejection = (event) => {
    const reason = event?.reason;
    log.log("window.unhandledrejection", {
      message: summarizeValue(reason?.message ?? reason ?? "unknown", 300),
      stack: summarizeValue(reason?.stack ?? null, 600),
    });
  };
  windowRef.addEventListener("error", onError);
  windowRef.addEventListener("unhandledrejection", onRejection);
  return () => {
    windowRef.removeEventListener("error", onError);
    windowRef.removeEventListener("unhandledrejection", onRejection);
  };
}

/**
 * Assemble the exportable bundle: window metadata, the frontend buffer and the
 * extension-side buffer (whatever `GET /api/debug-log` reported).
 */
export function buildDebugBundle({ meta = null, frontend = [], extension = null } = {}) {
  return {
    kind: "ompcot-debug-bundle",
    version: 1,
    capturedAt: new Date().toISOString(),
    meta: meta ?? null,
    frontend: Array.isArray(frontend) ? frontend : [],
    extension: extension ?? null,
  };
}
