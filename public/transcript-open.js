/**
 * What a click on the Agent Hub's "view transcript" button should do.
 *
 * The roster lists agents, including the `main` one whose `sessionFile` is the
 * process's own session — so the button is the natural way to look at "the main
 * session" again after peeking at a subagent. Driving that through the sidebar's
 * session-selection flow (`handleSessionSelect`) turned it into a real switch:
 * it cleared the composer queue, reset the transcript state (dropping the
 * running mark the sidebar's green dot is derived from), re-fetched history and
 * — when the target session was streaming and its registry entry had been
 * missed by the 5s instance poll — spawned a second omp process for the session
 * that was already running and re-routed the window to it. A "view" affordance
 * must never move the window, so the decision lives here, as data:
 *
 * - `live` — the file is the session this window is live on: hand the
 *   transcript back to the live view (repaint from the runtime's snapshot);
 * - `peek` — anything else: render it read-only through `get_agent_transcript`.
 */

/**
 * Session files name the same file in more than one spelling: producers hand
 * over native (`C:\x\y.jsonl`), slash-separated, `\\?\`-prefixed and
 * differently-cased paths, and every one of them is the same session on
 * Windows. Comparing them literally is how a click on the live session missed
 * and peeked another one.
 */
function sameSessionFile(a, b) {
  const normalize = (value) => {
    let path = String(value)
      .replace(/^\\\\\?\\/, "")
      .replace(/\\/g, "/");
    if (/^[a-z]:/i.test(path) || /^\/\//.test(path)) path = path.toLowerCase();
    return path.replace(/\/+$/, "");
  };
  return normalize(a) === normalize(b);
}

/**
 * @param {{sessionFile?: unknown, kind?: unknown}} input
 * @param {Iterable<unknown>} liveFiles files this window considers its own live
 *   session (mirror snapshot, active sidebar row, foreground instance)
 * @returns {"live"|"peek"}
 */
export function resolveTranscriptOpenAction({ sessionFile, kind } = {}, liveFiles = []) {
  // The `main` row *is* this window's own process session, whatever file the
  // roster names: omp registers the main agent once and its ref keeps that
  // registration's session file, so after a `new_session` / switch / fork the
  // row carried a session the process had already left. Clicking it means
  // "show me the live session", never "render that path read-only" — the
  // comparison below cannot be trusted to notice a stale file.
  if (kind === "main") return "live";
  if (typeof sessionFile !== "string" || !sessionFile) return "peek";
  for (const file of liveFiles) {
    if (typeof file === "string" && file && sameSessionFile(file, sessionFile)) return "live";
  }
  return "peek";
}
