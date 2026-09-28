import { describe, expect, test } from "vitest";
import { reconcileSessionActivity } from "./session-activity.js";

const RUNNING = "/ws/.omp/sessions/proj/running.jsonl";
const IDLE = "/ws/.omp/sessions/proj/idle.jsonl";

function instance(sessionFile, isStreaming) {
  return { port: 47821, pid: 1234, sessionFile, isStreaming };
}

describe("reconcileSessionActivity", () => {
  test("drops a mark whose session has no live instance at all", () => {
    // The classic stale dot: the run that set the mark is long over (or the
    // process died mid-run), so nothing in the registry owns the session.
    const { start, stop } = reconcileSessionActivity([RUNNING], [instance(IDLE, false)]);

    expect(stop).toEqual([RUNNING]);
    expect(start).toEqual([]);
  });

  test("drops a mark whose live instance reports idle", () => {
    const { stop } = reconcileSessionActivity([IDLE], [instance(IDLE, false)]);

    expect(stop).toEqual([IDLE]);
  });

  test("keeps a mark whose instance reports a run in progress", () => {
    const { start, stop } = reconcileSessionActivity([RUNNING], [instance(RUNNING, true)]);

    expect(stop).toEqual([]);
    expect(start).toEqual([]);
  });

  test("marks a streaming session that was never marked (missed agent_start)", () => {
    const { start, stop } = reconcileSessionActivity([], [instance(RUNNING, true)]);

    expect(start).toEqual([RUNNING]);
    expect(stop).toEqual([]);
  });

  test("leaves marks alone for instances without a run-state flag", () => {
    // An omp process still running an older bundled extension: a missing flag
    // is not evidence of idleness, so neither direction is asserted.
    const { start, stop } = reconcileSessionActivity([RUNNING], [instance(RUNNING, undefined)]);

    expect(start).toEqual([]);
    expect(stop).toEqual([]);
  });

  test("treats a missing, empty or malformed instance list as 'nothing is running'", () => {
    expect(reconcileSessionActivity([RUNNING], []).stop).toEqual([RUNNING]);
    expect(reconcileSessionActivity([RUNNING], undefined).stop).toEqual([RUNNING]);
    expect(reconcileSessionActivity([RUNNING], [{}, { sessionFile: "" }]).stop).toEqual([RUNNING]);
  });

  test("prefers the streaming instance when several report the same session", () => {
    // Two live processes can briefly share a session file (a session resumed
    // into its own process while the old one is still shutting down).
    const { stop } = reconcileSessionActivity(
      [RUNNING],
      [instance(RUNNING, false), instance(RUNNING, true)],
    );

    expect(stop).toEqual([]);
  });

  test("a stale registry flag cannot resurrect a run the window watched end", () => {
    // The window's own process: `agent_end` already cleared the mark, and the
    // registry still claims a run because its flag was never corrected.
    const { start, stop } = reconcileSessionActivity([], [instance(RUNNING, true)], {
      port: 47821,
      streaming: false,
    });

    expect(start).toEqual([]);
    expect(stop).toEqual([]);
  });

  test("a momentary idle sample does not drop the mark on the window's own session", () => {
    // The registry flag is an instantaneous `!ctx.isIdle()` sample — false
    // between messages and tool calls of a run that is still going — and the
    // window's own flag can be behind too (a selection reset it, an
    // `agent_start` was suppressed by a peek). Neither side may unmark the
    // other's run: the mark survives until both agree the session is idle.
    const { start, stop } = reconcileSessionActivity([RUNNING], [instance(RUNNING, true)], {
      port: 47821,
      streaming: false,
    });

    expect(start).toEqual([]);
    expect(stop).toEqual([]);
  });

  test("drops the window's own mark once the flag and the registry agree it is idle", () => {
    const { stop } = reconcileSessionActivity([RUNNING], [instance(RUNNING, false)], {
      port: 47821,
      streaming: false,
    });

    expect(stop).toEqual([RUNNING]);
  });

  test("keeps the foreground file marked while the window streams, with no registry entry", () => {
    // The entry can be missing (never re-created after a delete, or pruned by a
    // torn read in another process) or clobbered; for the session this window
    // is running, the event stream is the better evidence.
    const { start, stop } = reconcileSessionActivity([RUNNING], [], {
      port: 47821,
      streaming: true,
      file: RUNNING,
    });

    expect(start).toEqual([]);
    expect(stop).toEqual([]);
  });

  test("the foreground file is not immune once the window reports idle", () => {
    const { stop } = reconcileSessionActivity([RUNNING], [], {
      port: 47821,
      streaming: false,
      file: RUNNING,
    });

    expect(stop).toEqual([RUNNING]);
  });

  test("a stored idle from the runtime closes a run the event stream never ended", () => {
    // The stuck case: a non-terminal settle (`willContinue`) is the last frame
    // the run emits (`awaitingAsyncWork`, 18.3.3+), so the window's own flag
    // never clears — but the runtime is idle and the registry says so. The
    // stored `false` is debounced (`!ctx.isIdle()` three times in a row), so it
    // outranks the latched local flag.
    const { start, stop } = reconcileSessionActivity([RUNNING], [instance(RUNNING, false)], {
      port: 47821,
      streaming: true,
      file: RUNNING,
    });

    expect(start).toEqual([]);
    expect(stop).toEqual([RUNNING]);
  });

  test("a registry idle cannot unmark a session it does not name", () => {
    const other = "/ws/.omp/sessions/proj/other.jsonl";
    const { start, stop } = reconcileSessionActivity([RUNNING], [instance(other, false)], {
      port: 47821,
      streaming: true,
      file: RUNNING,
    });

    expect(start).toEqual([]);
    expect(stop).toEqual([]);
  });

  test("while the window streams a *different* session, the registry only adds", () => {
    const { start, stop } = reconcileSessionActivity([], [instance(RUNNING, true)], {
      port: 47821,
      streaming: true,
    });

    expect(start).toEqual([RUNNING]);
    expect(stop).toEqual([]);
  });

  test("the foreground rule only applies to the foreground port", () => {
    const other = "/ws/.omp/sessions/proj/other.jsonl";
    const { start } = reconcileSessionActivity(
      [],
      [{ ...instance(other, true), port: 49000 }, instance(RUNNING, true)],
      { port: 47821, streaming: false },
    );

    expect(start).toEqual([other]);
  });

  test("reconciles every mark, not just the first", () => {
    const other = "/ws/.omp/sessions/proj/other.jsonl";
    const { start, stop } = reconcileSessionActivity(
      [IDLE, other],
      [instance(IDLE, false), instance(RUNNING, true)],
    );

    expect(stop).toEqual([IDLE, other]);
    expect(start).toEqual([RUNNING]);
  });
});
