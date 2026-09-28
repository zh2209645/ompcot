// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  applyInstancePatch,
  type InstanceEntry,
  mergeInstanceEntry,
  parseInstanceEntry,
  runStateHintForEvent,
  runtimeSettled,
} from "./embedded-server.ts";

const base: InstanceEntry = {
  port: 47822,
  pid: 28340,
  sessionFile: "/sessions/p/a.jsonl",
  cwd: "/repo",
  isStreaming: true,
  startedAt: "2026-09-27T21:13:18.663Z",
};

describe("mergeInstanceEntry", () => {
  it("keeps a live run flag across a re-registration (extension reload mid-run)", () => {
    const next = mergeInstanceEntry(base, {
      port: 47822,
      pid: 28340,
      sessionFile: "/sessions/p/b.jsonl",
      cwd: "/repo",
    });

    expect(next.isStreaming).toBe(true);
    expect(next.sessionFile).toBe("/sessions/p/b.jsonl");
  });

  it("keeps the process's startedAt, not the registration's", () => {
    const next = mergeInstanceEntry(base, {
      port: 47822,
      pid: 28340,
      sessionFile: "/sessions/p/b.jsonl",
      cwd: "/repo",
    });

    expect(next.startedAt).toBe(base.startedAt);
  });

  it("starts idle with a fresh timestamp when nothing was published yet", () => {
    const next = mergeInstanceEntry(null, {
      port: 47821,
      pid: 1,
      sessionFile: "/sessions/p/a.jsonl",
      cwd: "/repo",
    });

    expect(next.isStreaming).toBe(false);
    expect(Date.parse(next.startedAt)).not.toBeNaN();
  });
});

describe("applyInstancePatch", () => {
  it("merges a session-file change without disturbing the run flag", () => {
    const next = applyInstancePatch(base, { sessionFile: "/sessions/p/c.jsonl" });
    expect(next.sessionFile).toBe("/sessions/p/c.jsonl");
    expect(next.isStreaming).toBe(true);
  });

  it("ignores an empty session path and a non-boolean flag", () => {
    const next = applyInstancePatch(base, { sessionFile: "" });
    expect(next.sessionFile).toBe(base.sessionFile);
  });
});

describe("parseInstanceEntry", () => {
  it("accepts a well-formed entry", () => {
    expect(parseInstanceEntry(JSON.stringify(base))).toMatchObject({
      port: 47822,
      pid: 28340,
      sessionFile: "/sessions/p/a.jsonl",
      isStreaming: true,
    });
  });

  it("treats a torn read as unreadable, not as a dead process", () => {
    expect(parseInstanceEntry('{"port":47822,"pid":28')).toBeNull();
    expect(parseInstanceEntry("")).toBeNull();
  });

  it("rejects entries missing the fields the frontend keys on", () => {
    expect(parseInstanceEntry(JSON.stringify({ pid: 1, port: 2, cwd: "/repo" }))).toBeNull();
    expect(
      parseInstanceEntry(JSON.stringify({ pid: "1", port: 2, sessionFile: "s", cwd: "c" })),
    ).toBeNull();
  });

  it("keeps an entry without a run-state flag (an older extension build)", () => {
    const parsed = parseInstanceEntry(
      JSON.stringify({ port: 1, pid: 2, sessionFile: "/s.jsonl", cwd: "/repo" }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.isStreaming).toBeUndefined();
  });
});

describe("runStateHintForEvent", () => {
  it("marks the run as going on agent_start", () => {
    expect(runStateHintForEvent("agent_start", { type: "agent_start" })).toBe(true);
  });

  it("keeps a non-terminal agent_end marked as running", () => {
    // `willContinue` means the session already scheduled its own continuation
    // (auto-retry, stop-retry, compaction continuation), and omp 18.3.3 added a
    // background-work pause on top. Publishing `false` there cleared the
    // sidebar mark and every other window's view of this process mid-run.
    expect(runStateHintForEvent("agent_end", { type: "agent_end", willContinue: true })).toBe(true);
  });

  it("clears the run on a terminal agent_end", () => {
    expect(runStateHintForEvent("agent_end", { type: "agent_end" })).toBe(false);
    expect(runStateHintForEvent("agent_end", { willContinue: false })).toBe(false);
    // Only a literal true continues (a stray string must not pin the mark on).
    expect(runStateHintForEvent("agent_end", { willContinue: "true" })).toBe(false);
  });

  it("leaves the published flag alone for every other event", () => {
    expect(runStateHintForEvent("message_end", { willContinue: true })).toBeUndefined();
    expect(runStateHintForEvent("tool_execution_end", {})).toBeUndefined();
  });
});

describe("runtimeSettled", () => {
  it("is not settled while a run is live, whatever the jobs say", () => {
    expect(runtimeSettled(false, null)).toBe(false);
    expect(runtimeSettled(false, { running: [], delivery: { queued: 0, pendingJobIds: [] } })).toBe(
      false,
    );
  });

  it("is settled when idle with nothing that could wake the session", () => {
    expect(runtimeSettled(true, null)).toBe(true);
    expect(runtimeSettled(true, { running: [], delivery: { queued: 0, pendingJobIds: [] } })).toBe(
      true,
    );
    // A build without the surface (or a session without a job manager) hides no work.
    expect(runtimeSettled(true, undefined)).toBe(true);
    expect(runtimeSettled(true, {})).toBe(true);
  });

  it("holds the run open while background work can still report back", () => {
    // The pause 18.3.3+ can leave behind: idle per `ctx.isIdle()` only once the
    // prompt ends, but a running job or an undelivered result is exactly the
    // wake the host is waiting for — the TUI's loader and the RPC's
    // `session_settled` wait for it too.
    expect(runtimeSettled(true, { running: [{ id: "job-1" }] })).toBe(false);
    expect(runtimeSettled(true, { running: [], delivery: { queued: 1, pendingJobIds: [] } })).toBe(
      false,
    );
    expect(
      runtimeSettled(true, { running: [], delivery: { queued: 0, pendingJobIds: ["job-2"] } }),
    ).toBe(false);
    expect(
      runtimeSettled(true, {
        running: [],
        delivery: { delivering: true, pendingJobIds: ["job-2"] },
      }),
    ).toBe(false);
  });
});
