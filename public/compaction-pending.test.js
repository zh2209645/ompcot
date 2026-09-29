import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPendingCompaction } from "./compaction-pending.js";

describe("createPendingCompaction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("ends a dispatched command as skipped when no compaction follows", () => {
    // omp's builtin swallows its own no-op: without this window a `/compact`
    // the runtime declined shows nothing at all.
    const onStart = vi.fn();
    const onSkip = vi.fn();
    const pending = createPendingCompaction({ onStart, onSkip, timeoutMs: 5000 });

    pending.arm();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(pending.pending).toBe(true);

    vi.advanceTimersByTime(4999);
    expect(onSkip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);

    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(pending.pending).toBe(false);
  });

  test("an answer from the command's own prompt_result ends the window early", () => {
    // The runtime writes one `prompt_result` when the command it accepted has
    // settled (the broker relays it): a `/compact` whose answer arrives with no
    // compaction frame in between is the builtin's no-op, and the user gets the
    // skip line then — not after the window's guess elapses.
    const onSkip = vi.fn();
    const pending = createPendingCompaction({ onStart: vi.fn(), onSkip, timeoutMs: 5000 });

    pending.arm();
    vi.advanceTimersByTime(50);
    pending.settle("skipped");
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(pending.pending).toBe(false);

    // ...and its timer can never fire a second skip.
    vi.advanceTimersByTime(10000);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  test("a real compaction settles the window instead of skipping", () => {
    const onSkip = vi.fn();
    const pending = createPendingCompaction({ onStart: vi.fn(), onSkip, timeoutMs: 5000 });

    pending.arm();
    vi.advanceTimersByTime(300); // `session.compacting` lands here
    pending.settle();
    vi.advanceTimersByTime(10000);

    expect(onSkip).not.toHaveBeenCalled();
    expect(pending.pending).toBe(false);
  });

  test("re-arming restarts the window instead of stacking skips", () => {
    // A second `/compact` (or the queued one being delivered) must not leave
    // the first window's timer to fire a skip over the new attempt.
    const onSkip = vi.fn();
    const pending = createPendingCompaction({ onStart: vi.fn(), onSkip, timeoutMs: 5000 });

    pending.arm();
    vi.advanceTimersByTime(4000);
    pending.arm();
    vi.advanceTimersByTime(4000);

    expect(onSkip).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
