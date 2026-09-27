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

const DEFAULT_ATTEMPTS = 20;
const DEFAULT_INTERVAL_MS = 250;

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
