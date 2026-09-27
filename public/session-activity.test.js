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
