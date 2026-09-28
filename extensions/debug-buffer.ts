/**
 * Extension-side debug capture.
 *
 * The embedded server is the only place that sees both halves of the wire: the
 * frames omp emits (broadcast to every window) and the commands windows send
 * back. Rendering bugs that cannot be reproduced from the session file — the
 * same message drawn twice, a card whose status regressed — are decided by that
 * traffic, so the last N observations are kept in a bounded ring buffer and
 * served to the GUI (`GET /api/debug-log`) for its export bundle.
 *
 * Summaries only: a streaming reply is thousands of frames and a verbatim
 * buffer would be hundreds of megabytes. Frame payloads are reduced to ids,
 * routing metadata and block sizes.
 */

export const DEBUG_BUFFER_LIMIT = 5000;
export const DEBUG_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
export const DEBUG_FIELD_LIMIT = 400;

/** Text summary of a value, cut to `limit` characters. */
export function summarizeValue(value: unknown, limit = DEBUG_FIELD_LIMIT): unknown {
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

function summarizeBlocks(content: unknown): string {
  if (typeof content === "string") return `text:${content.length}`;
  if (!Array.isArray(content)) return "none";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "?";
      const typed = block as { type?: string; text?: string; thinking?: string; name?: string };
      if (typed.type === "text") return `text:${(typed.text || "").length}`;
      if (typed.type === "thinking") return `thinking:${(typed.thinking || "").length}`;
      if (typed.type === "toolCall") return `toolCall:${typed.name || "?"}`;
      return String(typed.type || "?");
    })
    .join(",");
}

/** One forwarded event, without its payload. */
export function summarizeEvent(event: Record<string, unknown> | null | undefined) {
  const message = (event?.message ?? null) as Record<string, unknown> | null;
  return {
    type: event?.type ?? null,
    role: message?.role ?? null,
    ts: message?.timestamp ?? null,
    messageId: message?.id ?? null,
    entryId: event?.entryId ?? event?.messageId ?? null,
    blocks: message ? summarizeBlocks(message.content) : null,
    stopReason: message?.stopReason ?? null,
    // Run-lifecycle flags: an `agent_end` that is a *pause* (a scheduled
    // continuation, or 18.3.3+'s `awaitingAsyncWork` whose wake is not
    // guaranteed) is only distinguishable here — the GUI keeps the run marked
    // live for it, so an export without these fields cannot explain a session
    // that "never stopped".
    willContinue: event?.willContinue ?? null,
    awaitingAsyncWork: event?.awaitingAsyncWork ?? null,
    isTerminal: event?.isTerminal ?? null,
    toolCallId: event?.toolCallId ?? null,
    toolName: event?.toolName ?? null,
    isError: event?.isError ?? null,
  };
}

/** Small summary of one outgoing frame (broadcast payload). */
export function summarizeBroadcast(data: unknown) {
  const frame = data as Record<string, unknown> | null;
  const type = (frame?.type as string) ?? "?";
  const summary: Record<string, unknown> = { type };
  if (type === "event") {
    summary.event = summarizeEvent(frame?.event as Record<string, unknown> | null);
  } else if (type === "mirror_sync") {
    const entries = Array.isArray(frame?.entries) ? (frame?.entries as unknown[]) : [];
    summary.sessionFile = summarizeValue(frame?.sessionFile ?? null, 200);
    summary.isStreaming = frame?.isStreaming ?? null;
    summary.entryCount = entries.length;
  } else if (type === "response") {
    summary.command = summarizeValue(frame?.command ?? null, 60);
    summary.success = frame?.success ?? null;
    if (frame?.success === false) summary.error = summarizeValue(frame?.error ?? null, 200);
  } else {
    for (const key of ["id", "method", "statusKey", "widgetKey", "sessionId"]) {
      if (frame && key in frame) summary[key] = summarizeValue(frame[key], 120);
    }
  }
  return summary;
}

/** Small summary of one inbound command. */
export function summarizeCommand(command: Record<string, unknown> | null | undefined) {
  const type = (command?.type as string) ?? "?";
  const summary: Record<string, unknown> = { type };
  for (const key of ["id", "sessionPath", "streamingBehavior", "action", "name", "provider"]) {
    if (command && command[key] !== undefined) summary[key] = summarizeValue(command[key], 160);
  }
  if (typeof command?.message === "string") summary.message = summarizeValue(command.message, 200);
  if (Array.isArray(command?.images)) summary.images = command.images.length;
  if (command && typeof command.sessionFile === "string") {
    summary.sessionFile = summarizeValue(command.sessionFile, 200);
  }
  return summary;
}

export interface DebugEntry {
  t: number;
  kind: string;
  data: unknown;
}

/**
 * Bounded ring buffer of debug observations.
 *
 * @param options.limit most recent entries kept
 * @param options.maxBytes approximate size cap
 * @param options.now clock, injectable for tests
 */
export function createDebugBuffer({
  limit = DEBUG_BUFFER_LIMIT,
  maxBytes = DEBUG_BUFFER_MAX_BYTES,
  now = () => Date.now(),
}: {
  limit?: number;
  maxBytes?: number;
  now?: () => number;
} = {}) {
  const entries: (DebugEntry & { __bytes: number })[] = [];
  let bytes = 0;

  function drop(count: number): void {
    for (let i = 0; i < count && entries.length > 0; i++) {
      const removed = entries.shift();
      bytes -= removed?.__bytes ?? 0;
    }
    if (bytes < 0) bytes = 0;
  }

  function log(kind: string, data: unknown, coalesceKey?: string | null): DebugEntry | null {
    // Streaming frames arrive per delta: folding the run of identical-key
    // observations into one counted entry keeps the buffer's limited slots for
    // the transitions that explain a bug instead of one message's 2000 updates.
    const last = entries[entries.length - 1];
    if (coalesceKey && last && last.kind === kind && last.__coalesceKey === coalesceKey) {
      last.t = now();
      last.data = data ?? null;
      last.__count = (last.__count ?? 1) + 1;
      return last;
    }
    let entry: DebugEntry & { __bytes: number; __coalesceKey?: string; __count?: number };
    try {
      entry = {
        t: now(),
        kind,
        data: data ?? null,
        __bytes: 0,
        __coalesceKey: coalesceKey ?? undefined,
      };
      entry.__bytes = JSON.stringify(entry).length;
    } catch {
      entry = { t: now(), kind, data: "[unserializable]", __bytes: 40 };
    }
    entries.push(entry);
    bytes += entry.__bytes;
    if (entries.length > limit) drop(entries.length - limit);
    while (bytes > maxBytes && entries.length > 1) drop(1);
    return entry;
  }

  return {
    log,
    size: () => entries.length,
    bytes: () => bytes,
    snapshot: (take = entries.length): (DebugEntry & { count?: number })[] => {
      const wanted =
        Number.isFinite(take) && take > 0 ? Math.min(take, entries.length) : entries.length;
      return entries
        .slice(entries.length - wanted)
        .map(({ __bytes, __coalesceKey, __count, ...entry }) => ({
          ...entry,
          ...(__count ? { count: __count } : {}),
        }));
    },
  };
}

/**
 * Write one debug bundle to `<dir>/<name>`.
 *
 * Returns the absolute path and the byte size so the UI can show where the
 * evidence landed (a debug dump the user cannot find is not a debug dump).
 */
export async function writeDebugBundle(
  filePath: string,
  bundle: unknown,
  fsPromises: {
    mkdir: (path: string, options: { recursive: boolean }) => Promise<unknown>;
    writeFile: (path: string, data: string, encoding: string) => Promise<unknown>;
  },
  dir = filePath.slice(0, Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"))),
): Promise<{ path: string; bytes: number }> {
  // The caller owns path joining (`path.join` on the extension side), so the
  // path reported to the UI uses the platform's separators.
  if (dir) await fsPromises.mkdir(dir, { recursive: true });
  const text = JSON.stringify(bundle, null, 2);
  await fsPromises.writeFile(filePath, text, "utf8");
  return { path: filePath, bytes: text.length };
}
