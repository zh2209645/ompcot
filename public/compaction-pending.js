/**
 * The window between "this window dispatched `/compact`" and "a compaction
 * frame acknowledged it".
 *
 * omp's own `/compact` builtin catches its no-op ("Nothing to compact (session
 * too small)", "Already compacted") and returns silently: no extension event,
 * and its `command_output` line goes to the process's stdout, which the GUI
 * never sees (the broker drops it). A command the user sent therefore did
 * nothing visible at all — the reported "压缩命令没有任何反馈".
 *
 * A real pass emits `session.compacting` within milliseconds of dispatch
 * (before it starts summarizing), so "no compaction frame inside a short
 * window" is a sound reading of "the command declined": the window ends as a
 * skip, never as a made-up success, and a real start settles it instead.
 */
export function createPendingCompaction({ onStart, onSkip, timeoutMs = 5000 }) {
  let timer = null;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    /** Arm the window (called when the runtime accepted the command). */
    arm() {
      onStart();
      clear();
      timer = setTimeout(() => {
        timer = null;
        onSkip();
      }, timeoutMs);
    },
    /** A real compaction took over (or reported an outcome): stop watching. */
    settle() {
      clear();
    },
    /** True while a dispatched command is still unacknowledged. */
    get pending() {
      return timer !== null;
    },
  };
}
