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
 * @param {Iterable<string>} markedFiles session files currently marked as running
 * @param {Array<{sessionFile?: unknown, isStreaming?: unknown}>} instances `/api/instances` payload
 * @returns {{start: string[], stop: string[]}} files to mark and unmark
 */
export function reconcileSessionActivity(markedFiles, instances) {
  const streaming = new Set();
  const unknown = new Set();
  for (const instance of Array.isArray(instances) ? instances : []) {
    const file = instance?.sessionFile;
    if (typeof file !== "string" || file.length === 0) continue;
    if (instance.isStreaming === true) streaming.add(file);
    else if (instance.isStreaming !== false) unknown.add(file);
  }

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
