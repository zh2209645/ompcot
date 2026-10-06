import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionBranchWaiters } from "./session-branch.js";

describe("session_branch waiters", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves a fork waiter on the fork transition", async () => {
    const waiters = createSessionBranchWaiters();
    const pending = waiters.waitFor("fork", 10000);
    waiters.handle({ type: "session_branch", reason: "fork" });
    await expect(pending).resolves.toBe(true);
  });

  it("does not resolve a fork waiter on a /btw promotion", async () => {
    // Reported risk: a `/btw` side question promotes its answer through the
    // same event. Before the reason filter it confirmed any pending fork.
    const waiters = createSessionBranchWaiters();
    let settled = null;
    void waiters.waitFor("fork", 10000).then((v) => {
      settled = v;
    });
    waiters.handle({ type: "session_branch", reason: "btw" });
    expect(settled).toBeNull();

    waiters.handle({ type: "session_branch", reason: "fork" });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("does not resolve a fork waiter on a rewind (branch) transition", async () => {
    const waiters = createSessionBranchWaiters();
    let settled = null;
    void waiters.waitFor("fork", 10000).then((v) => {
      settled = v;
    });
    waiters.handle({ type: "session_branch", reason: "branch" });
    expect(settled).toBeNull();
  });

  it("accepts unlabelled events from omp builds before 18.4.11", async () => {
    const waiters = createSessionBranchWaiters();
    const pending = waiters.waitFor("fork", 10000);
    waiters.handle({ type: "session_branch", previousSessionFile: "/old.jsonl" });
    await expect(pending).resolves.toBe(true);
  });

  it("times out with false when no matching event arrives", async () => {
    const waiters = createSessionBranchWaiters();
    const pending = waiters.waitFor("fork", 10000);
    waiters.handle({ type: "session_branch", reason: "btw" });
    await vi.advanceTimersByTimeAsync(10001);
    await expect(pending).resolves.toBe(false);
  });
});
