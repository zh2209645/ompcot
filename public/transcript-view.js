/**
 * Which view owns the transcript.
 *
 * `#messages` is a single surface: the live foreground session streams into it,
 * history renders rebuild it, and the Agent Hub can put a subagent's transcript
 * on screen read-only while the workspace's own session keeps running. The
 * broker broadcasts the foreground session's frames to every client regardless
 * of what is displayed, and every repaint that starts with an `await` (a
 * history fetch, an agent transcript read, a resync) can land after the surface
 * was handed to something else. Nothing in the frames says which view should
 * own them, so ownership is tracked here:
 *
 * - while an agent transcript owns the surface, the foreground session's
 *   transcript-drawing events are dropped — they used to paint the parent's own
 *   cards (a running `wait`) into whichever subagent transcript the user was
 *   reading, the same card in every agent view;
 * - `mirror_sync` snapshots must not repaint it either, which read as "view
 *   transcript switched me to the wrong session";
 * - a claim carries a token, so a response that resolves after a newer claim
 *   (two quick clicks, a session selection landing mid-load) is dropped instead
 *   of painting the view the user already navigated away from.
 */

/**
 * Events that draw into the transcript, and are dropped while an agent owns it.
 *
 * `agent_start` is deliberately absent: it paints nothing (it only flips the
 * streaming state, the typing indicator and the sidebar's running mark), and
 * dropping it made a run that began during a peek invisible to the sidebar —
 * the dot never appeared, and the 5s activity reconcile then treated the
 * window's own process as idle, because the local flag drives that verdict.
 * `agent_end` stays unfiltered for the same reason in the other direction.
 *
 * The compaction frames are absent for a third reason: they carry the *global*
 * compaction state — the header's label and dot say "the runtime is busy
 * compacting", which is not part of the peeking surface — and only the
 * transcript line they draw is. Their handlers therefore guard their own
 * `#messages` write with `transcriptView.active` instead of being dropped whole:
 * a compaction that runs while the user reads a subagent must still be visible
 * (and endable) in the header, and it must never paint into the peek.
 */
const TRANSCRIPT_EVENTS = new Set([
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "extension_error",
  "session_notice",
]);

/** True when `type` is an event that renders into the transcript. */
export function isTranscriptEvent(type) {
  return TRANSCRIPT_EVENTS.has(type);
}

export function createTranscriptView() {
  let owner = null; // { kind: "live" | "agent", file: string | null }
  let token = 0;

  return {
    /** The live session claims the surface (selection, new session, resync). */
    claimLive(file = null) {
      owner = { kind: "live", file: typeof file === "string" && file ? file : null };
      token += 1;
      return token;
    },
    /** A read-only agent transcript claims the surface. */
    claimAgent(file) {
      owner = { kind: "agent", file: typeof file === "string" && file ? file : null };
      token += 1;
      return token;
    },
    /**
     * Hand the surface back to the live session without a new claim — used by
     * paths that do not know yet which session they will render (a deferred
     * switch) and by failures that fall back to the welcome view.
     */
    end() {
      owner = null;
      token += 1;
    },
    /** True while a read-only agent transcript owns the transcript. */
    get active() {
      return owner?.kind === "agent";
    },
    /** The agent file on screen, or null. */
    get file() {
      return owner?.kind === "agent" ? owner.file : null;
    },
    /** True when `requestToken` is still the newest claim. */
    isCurrent(requestToken) {
      return requestToken === token;
    },
    /** True when the current owner wants this live event kept off screen. */
    suppresses(type) {
      return this.active && TRANSCRIPT_EVENTS.has(type);
    },
  };
}
