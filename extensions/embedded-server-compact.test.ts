// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { type GuiCompactOptions, startGuiCompaction } from "./embedded-server.ts";

function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

describe("startGuiCompaction", () => {
  it("reports a rejection instead of letting it escape", async () => {
    // The failure that killed the process: omp rejects every manual compaction
    // that ends as a no-op ("Already compacted", "Nothing to compact (session
    // too small)") or fails, its `onError` only covers the failures raised
    // inside its own try block, and the host treats an *unhandled* rejection as
    // fatal — the omp process exits and takes the workspace window with it.
    const report = vi.fn();
    startGuiCompaction(() => Promise.reject(new Error("Already compacted")), report);
    await flush();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toEqual({ error: "Already compacted" });
  });

  it("reports the summary the host completes with", async () => {
    const report = vi.fn();
    let options: GuiCompactOptions | undefined;
    startGuiCompaction((arg) => {
      options = arg as GuiCompactOptions;
      return Promise.resolve();
    }, report);
    options?.onComplete?.({ summary: "## Goal\n- prior work" });
    await flush();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toEqual({ summary: "## Goal\n- prior work" });
  });

  it("reports once when onError fires and the compaction still rejects", async () => {
    // omp calls `onError` and then rethrows, so both channels see the same
    // failure; the GUI must not get two terminal frames for one attempt.
    const report = vi.fn();
    let reject: ((err: unknown) => void) | undefined;
    startGuiCompaction((arg) => {
      const options = arg as GuiCompactOptions;
      const pending = Promise.withResolvers<unknown>();
      reject = pending.reject;
      options.onError?.(new Error("No configured compaction method can run manually."));
      return pending.promise;
    }, report);
    reject?.(new Error("No configured compaction method can run manually."));
    await flush();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toEqual({
      error: "No configured compaction method can run manually.",
    });
  });

  it("passes focus text positionally and still consumes the promise", async () => {
    // `compact(string)` is the *only* way to send focus instructions — a
    // `customInstructions` key inside the options object is ignored by the
    // host — and that form carries no callbacks, so the promise is the sole
    // signal for both outcomes.
    const report = vi.fn();
    const compact = vi.fn((_arg?: string | GuiCompactOptions) => Promise.resolve());
    startGuiCompaction(compact, report, "  keep the API decisions  ");
    await flush();

    expect(compact).toHaveBeenCalledWith("keep the API decisions");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toEqual({});
  });

  it("reports a synchronous throw", async () => {
    const report = vi.fn();
    startGuiCompaction(() => {
      throw new Error("Compaction already in progress");
    }, report);
    await flush();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toEqual({ error: "Compaction already in progress" });
  });

  it("treats a blank focus argument as no focus", async () => {
    const report = vi.fn();
    const compact = vi.fn((arg?: string | GuiCompactOptions) => {
      (arg as GuiCompactOptions).onComplete?.({ summary: "s" });
      return Promise.resolve();
    });
    startGuiCompaction(compact, report, "   ");

    expect(compact.mock.calls[0][0]).toBeTypeOf("object");
    expect(report).toHaveBeenCalledWith({ summary: "s" });
  });
});
