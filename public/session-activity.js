/**
 * Session activity reconciliation for the sidebar's "running" dot.
 *
 * The dot is driven by agent lifecycle events (`agent_start` / `agent_end`) and
 * mirror snapshots. Those are fast but latched: a mark is only undone by a
 * frame naming that exact session file, so a dropped frame (saturated client,
 * broker reconnect), a re-tagged frame, or a process that dies mid-run leaves a
 * pulsing green dot on a session that has not been running for a long time —
 * it only disappeared when the user selected the session and its snapshot
 * reported the truth.
 *
 * The instance registry (`/api/instances`: one entry per live omp process,
 * carrying its session file and run state, dead pids pruned) is the
 * cross-process source of truth. Reconciling the marks against it on every poll
 * makes the indicator self-correcting in both directions:
 * - a session whose instance reports a run in progress is marked (also covers a
 *   missed `agent_start`, e.g. an event lost while the window was reconnecting),
 * - a session with no live instance at all cannot be running, so its mark is
 *   dropped,
 * - a session whose live instance reports idle is dropped as well.
 *
 * An entry that carries no `isStreaming` field (an omp process still running an
 * older extension build) is left untouched: a missing flag is not evidence of
 * idleness, while a missing *instance* is (a session cannot run without a
 * process behind it).
 *
 * The window's own process is the exception. For it the live event stream is
 * strictly better evidence than the registry: a run this window watched finish
 * must not be resurrected by a registry flag that was never corrected (a lost
 * `agent_end` write, a stale `${pid}.json`). `foreground` therefore disables the
 * registry's vote to *stop* that one process — but it must not read a momentary
 * `isStreaming:false` as proof of idleness either: the registry samples
 * `!ctx.isIdle()` (false between messages and tool calls) and the window's own
 * flag is cleared by non-terminal events (`state.reset()` on a selection, a
 * suppressed `agent_start`). So the entry for the foreground port may only
 * *add* a mark; when the local flag says idle, the entry is treated as unknown
 * (keep whatever the marks say) instead of dropping them. The foreground *file*
 * is immune from the stop rule entirely while the local flag says running, so a
 * clobbered or never-recreated registry entry cannot unmark a run the event
 * stream still reports.
 *
 * @param {Iterable<string>} markedFiles session files currently marked as running
 * @param {Array<{sessionFile?: unknown, isStreaming?: unknown, port?: number}>} instances `/api/instances` payload
 * @param {{port?: number|null, streaming?: boolean, file?: string|null}} [foreground] window's own process
 * @returns {{start: string[], stop: string[]}} files to mark and unmark
 */
export function reconcileSessionActivity(markedFiles, instances, foreground = {}) {
  const foregroundPort = typeof foreground?.port === "number" ? foreground.port : null;
  const foregroundStreaming = foreground?.streaming === true;
  const foregroundFile =
    typeof foreground?.file === "string" && foreground.file ? foreground.file : null;
  const streaming = new Set();
  const unknown = new Set();
  for (const instance of Array.isArray(instances) ? instances : []) {
    const file = instance?.sessionFile;
    if (typeof file !== "string" || file.length === 0) continue;
    if (foregroundPort !== null && instance?.port === foregroundPort) {
      // Own process: the event stream decides. Running → the mark came from
      // `agent_start` already; idle while the registry says streaming → keep the
      // existing marks rather than trusting either side alone.
      if (foregroundStreaming) streaming.add(file);
      else if (instance.isStreaming === true) unknown.add(file);
      continue;
    }
    if (instance.isStreaming === true) streaming.add(file);
    else if (instance.isStreaming !== false) unknown.add(file);
  }
  if (foregroundFile && foregroundStreaming) unknown.add(foregroundFile);

  const marked = new Set(markedFiles || []);
  const start = [];
  for (const file of streaming) {
    if (!marked.has(file)) start.push(file);
  }

  const stop = [];
  for (const file of marked) {
    // No instance at all, or an instance that reports idle → not running.
    if (!streaming.has(file) && !unknown.has(file)) stop.push(file);
  }

  return { start, stop };
}
