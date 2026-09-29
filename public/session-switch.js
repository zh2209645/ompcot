/**
 * Session-switch confirmation for the desktop host path.
 *
 * The race this closes (verified live against omp 18.3.2):
 * `switch_session` over the broker's omp stdin pipe is fire-and-forget — the
 * broker drops omp's RPC replies — and the `mirror_sync_request` the WebView
 * sends right after is answered from the PRE-switch session (the swap completes
 * ~15ms later; 18.3.2 does not reload the extension on switch_session, so no
 * `session_start` broadcast corrects it). Applying that stale snapshot repaints
 * the transcript with the session the user just left, so "click a session to
 * switch" appears to do nothing.
 *
 * The gate turns that into a confirmable sequence: arm it with the session we
 * asked for, let `handleMirrorSync` apply only snapshots that match, and
 * re-request until one lands. A switch omp refuses (e.g. `switch_session` is
 * cancelled across a workspace/cwd change) never confirms, so the caller can
 * report it honestly instead of pretending the switch happened.
 */

/**
 * The confirmation window.
 *
 * `switch_session` is fire-and-forget over the broker (the broker drops omp's
 * RPC replies), so the only confirmation is the session's own snapshot coming
 * back — and a long session, or a process still finishing a compaction, can
 * take far longer to answer than the 5 s this used to allow. That is exactly
 * the "运行中的 OMP 未确认会话切换" report on a huge session: the switch had
 * happened (or was still happening) while the window had already given up.
 * These are a ceiling, not a delay: the gate returns the moment the matching
 * snapshot lands, and a newer selection supersedes the wait.
 *
 * The ceiling is *also* the length of the freeze it can cause, which is why it
 * is 15 s and not the two minutes it used to be: while a switch is pending,
 * every snapshot of the foreground session is dropped (that is the gate's job),
 * so a switch that can never land — omp refuses a target recorded under another
 * workspace, and a process that died mid-request answers nothing at all — left
 * the window looking frozen for two full minutes, with every later selection
 * queued behind it (selections are serialized) and replayed afterwards. A
 * switch that *can* land answers this fast: a live process answers the
 * `mirror_sync_request` in well under a second (measured 27–170 ms on sessions
 * of 1866–6552 entries), and a pass that holds the switch up is waited out
 * *before* it is sent (`waitForCompactionEnd` in app.js).
 */
const DEFAULT_ATTEMPTS = 30;
const DEFAULT_INTERVAL_MS = 500;

/** Total time a pending switch may suppress the foreground session's snapshots. */
export const SWITCH_CONFIRM_BUDGET_MS = DEFAULT_ATTEMPTS * DEFAULT_INTERVAL_MS;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tracks the session a switch is expected to land on.
 *
 * `accepts()` is the render guard: while a switch is pending, a snapshot for
 * any other session (or one without a session file at all) must not repaint the
 * transcript or rebind routing. With no switch pending every snapshot applies,
 * exactly as before this gate existed.
 */
export class SessionSwitchGate {
  constructor({
    attempts = DEFAULT_ATTEMPTS,
    intervalMs = DEFAULT_INTERVAL_MS,
    sleep = defaultSleep,
  } = {}) {
    this.attempts = attempts;
    this.intervalMs = intervalMs;
    this.sleep = sleep;
    this.expected = null;
    this.settledWith = null;
  }

  /** Session file a pending switch is expected to land on, or null. */
  get pending() {
    return this.expected;
  }

  /** Arm the gate for a switch to `sessionFile`; supersedes any pending switch. */
  expect(sessionFile) {
    this.expected = sessionFile || null;
    this.settledWith = null;
  }

  /** True when `snapshotSessionFile` may repaint the transcript. */
  accepts(snapshotSessionFile) {
    if (this.expected === null) return true;
    return snapshotSessionFile === this.expected;
  }

  /** Record that the pending switch landed; no-op when nothing is pending. */
  settle(snapshotSessionFile) {
    if (this.expected !== null && snapshotSessionFile === this.expected) {
      this.settledWith = this.expected;
      this.expected = null;
    }
  }

  /** Drop the pending switch so later snapshots apply again. */
  cancel() {
    this.expected = null;
    this.settledWith = null;
  }

  /**
   * Re-send the sync request (`sendRequest`) until a snapshot for
   * `sessionFile` settles the gate, or the retry budget runs out. Always
   * leaves the gate clear, so a failed switch can never block later snapshots.
   *
   * @param {string} sessionFile - session the switch must land on
   * @param {{sendRequest?: () => (void|Promise<void>)}} [options]
   * @returns {Promise<boolean>} true once the target session's snapshot applied
   */
  async waitForConfirmation(sessionFile, { sendRequest } = {}) {
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (this.settledWith === sessionFile) {
        this.settledWith = null;
        return true;
      }
      // Superseded by a newer selection (or cancelled): this switch's outcome
      // no longer matters and a newer confirmation is already driving.
      if (this.expected !== sessionFile) return false;
      try {
        await sendRequest?.();
      } catch {
        /* the next attempt retries */
      }
      await this.sleep(this.intervalMs);
      if (this.settledWith === sessionFile) {
        this.settledWith = null;
        return true;
      }
      if (this.expected !== sessionFile) return false;
    }
    this.cancel();
    return false;
  }
}

/**
 * How a selected session can be shown. Decided before anything is sent, so the
 * window never reaches for a host that cannot serve the session:
 *
 * - `live`     — a running omp process already has this session; attach to it.
 * - `spawn`    — resume it in a dedicated process (`omp --session <file>`).
 * - `in-place` — switch the window's own process; only safe when that process
 *                is idle *and* the session was recorded under its workspace.
 * - `defer`    — wait for the process's run to end, then switch in place.
 * - `history`  — render the transcript read-only; no process can host it.
 *
 * Why the distinctions matter (verified against omp 18.4.2 and the debug
 * bundles of the archived-session freeze):
 *
 * - `AgentSession.switchSession` calls `abort({goalReason:"internal"})` *before*
 *   it loads the target, so an in-place switch kills whatever turn the process
 *   is running. A switch omp then refuses still leaves the turn dead: in the
 *   reported trace the process flipped `isStreaming` false right as the switch
 *   frame was written (10.72 s) and broadcast no `message_end`/`agent_end`
 *   for the rest of the capture. Hence: never in place while the process is
 *   busy — spawn, or defer.
 * - omp does not switch to a target whose recorded `cwd` differs from the
 *   process's (verified live on 18.3.2 — `cancelled: true`, the session does
 *   not change; in the reported trace the process kept its session after the
 *   frame was written), so a foreign session can never be hosted in place. It
 *   only appears in this window's sidebar because the archived/favourites
 *   groups collect sessions from every project directory — including ones whose
 *   workspace directory has since been deleted (temp workspaces), which is also
 *   why the dedicated spawn fails there (`omp` cannot start with a dead
 *   `current_dir`). The honest answer for that case is the read-only
 *   transcript, not a switch that will not happen.
 */
export const SESSION_HOSTING = {
  LIVE: "live",
  SPAWN: "spawn",
  IN_PLACE: "in-place",
  DEFER: "defer",
  HISTORY: "history",
};

/**
 * Decide how to show `sessionFile`.
 *
 * @param {object} input
 * @param {string|null} input.sessionFile - session being selected
 * @param {string} [input.sessionCwd] - the session's recorded workspace
 * @param {string} [input.workspacePath] - the window's foreground workspace
 * @param {boolean} [input.liveInstance] - a live process already has it
 * @param {boolean} [input.processStreaming] - the window's process is running
 * @param {boolean} [input.spawnAvailable] - can this client spawn a process?
 * @param {boolean} [input.spawnFailed] - a spawn was attempted and failed
 * @returns {string} one of {@link SESSION_HOSTING}
 */
export function planSessionHosting({
  sessionFile = null,
  sessionCwd = "",
  workspacePath = "",
  liveInstance = false,
  processStreaming = false,
  spawnAvailable = true,
  spawnFailed = false,
} = {}) {
  if (liveInstance) return SESSION_HOSTING.LIVE;
  if (!sessionFile) return SESSION_HOSTING.HISTORY;
  const foreign = Boolean(sessionCwd) && !sameWorkspacePath(sessionCwd, workspacePath);
  if (foreign) {
    // Cannot be hosted in this process, ever: its workspace is not ours.
    if (spawnFailed || !spawnAvailable) return SESSION_HOSTING.HISTORY;
    return SESSION_HOSTING.SPAWN;
  }
  if (processStreaming) {
    // An in-place switch would abort the run; a dedicated process keeps it.
    if (spawnFailed || !spawnAvailable) return SESSION_HOSTING.DEFER;
    return SESSION_HOSTING.SPAWN;
  }
  return SESSION_HOSTING.IN_PLACE;
}

/**
 * Workspace-path comparison for "can this process switch to that session?".
 * omp cancels `switch_session` when the target session's recorded cwd differs
 * from the process cwd, so the desktop path must give such sessions their own
 * process instead. Windows paths compare case-insensitively and separators and
 * trailing slashes are normalized away.
 */
export function sameWorkspacePath(a, b) {
  const na = normalizeWorkspacePath(a);
  const nb = normalizeWorkspacePath(b);
  return Boolean(na) && na === nb;
}

function normalizeWorkspacePath(p) {
  if (typeof p !== "string") return "";
  let out = p.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  // Drive-letter and UNC paths are case-insensitive on Windows.
  if (/^[a-zA-Z]:\//.test(out) || out.startsWith("//")) out = out.toLowerCase();
  return out;
}
