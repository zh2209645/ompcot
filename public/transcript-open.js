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
 * @param {{sessionFile?: unknown}} input
 * @param {Iterable<unknown>} liveFiles files this window considers its own live
 *   session (mirror snapshot, active sidebar row, foreground instance)
 * @returns {"live"|"peek"}
 */
export function resolveTranscriptOpenAction({ sessionFile } = {}, liveFiles = []) {
  if (typeof sessionFile !== "string" || !sessionFile) return "peek";
  for (const file of liveFiles) {
    if (typeof file === "string" && file && file === sessionFile) return "live";
  }
  return "peek";
}
