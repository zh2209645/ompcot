// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  type GuiCompactOptions,
  nextCompactionLifecycle,
  startGuiCompaction,
  summarizeCompactionEntry,
} from "./embedded-server.ts";

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

describe("nextCompactionLifecycle", () => {
  it("starts on the automatic path's own frame and ends on it", () => {
    const started = nextCompactionLifecycle(null, { kind: "auto-start", action: "context-full" });
    expect(started.state).toEqual({ source: "auto", action: "context-full" });
    expect(started.emit).toBe("start");

    const ended = nextCompactionLifecycle(started.state, {
      kind: "auto-end",
      action: "context-full",
    });
    expect(ended.state).toBeNull();
    expect(ended.emit).toBe("end");
  });

  it("starts a manual compaction from the summarize step, once", () => {
    // omp's own `/compact` builtin reaches the host through the RPC prompt
    // frame: it emits no `auto_compaction_start`, so the summarize step (which
    // it does emit, inside the long part of the pass) is the first honest
    // signal — and the GUI must see it.
    const first = nextCompactionLifecycle(null, { kind: "summarize" });
    expect(first.state).toEqual({ source: "manual" });
    expect(first.emit).toBe("start");

    // A method fallback summarizes again inside the same pass; that is not a
    // second compaction.
    const second = nextCompactionLifecycle(first.state, { kind: "summarize" });
    expect(second.state).toEqual({ source: "manual" });
    expect(second.emit).toBeNull();

    // The auto path's summarize is covered by its own start frame.
    const autoSummarize = nextCompactionLifecycle(
      { source: "auto", action: "context-full" },
      { kind: "summarize" },
    );
    expect(autoSummarize.emit).toBeNull();
  });

  it("ends a manual compaction on the commit", () => {
    // `session_compact` is the only end signal the builtin path gets, and the
    // commit is also where the transcript must be repainted: the summarized
    // stretch collapses into the compaction item.
    const committed = nextCompactionLifecycle({ source: "manual" }, { kind: "commit" });
    expect(committed.state).toBeNull();
    expect(committed.emit).toBe("snapshot+end");
  });

  it("converges on a commit it never saw start", () => {
    // An extension reload mid-pass loses the start frame; the commit still has
    // to repaint and report, or the window shows a branch the session left.
    const committed = nextCompactionLifecycle(null, { kind: "commit" });
    expect(committed.state).toBeNull();
    expect(committed.emit).toBe("snapshot+end");
  });

  it("lets the auto and gui paths keep their own end", () => {
    // The auto path's `auto_compaction_end` follows the commit, and the GUI
    // command reports from its promise; the commit only adds the repaint — and
    // marks itself seen, so the GUI command does not repaint a second time.
    const autoCommitted = nextCompactionLifecycle(
      { source: "auto", action: "soft" },
      { kind: "commit" },
    );
    expect(autoCommitted.state).toEqual({ source: "auto", action: "soft" });
    expect(autoCommitted.emit).toBe("snapshot");

    const guiStarted = nextCompactionLifecycle(null, { kind: "gui-start" });
    expect(guiStarted).toEqual({ state: { source: "gui" }, emit: "start" });
    const guiCommitted = nextCompactionLifecycle(guiStarted.state, { kind: "commit" });
    expect(guiCommitted.state).toEqual({ source: "gui", committed: true });
    expect(guiCommitted.emit).toBe("snapshot");
    const guiEnded = nextCompactionLifecycle(guiCommitted.state, { kind: "gui-end" });
    expect(guiEnded.state).toBeNull();
    expect(guiEnded.emit).toBe("end");
  });

  it("repaints for a shake, which rewrites the branch without a commit", () => {
    // `/shake elide` drops tool results from the session's entries in place:
    // no compaction entry, so no `session_compact` follows — the end frame is
    // the only place the repaint can ride.
    const ended = nextCompactionLifecycle(
      { source: "auto", action: "shake" },
      { kind: "auto-end", action: "shake" },
    );
    expect(ended.state).toBeNull();
    expect(ended.emit).toBe("snapshot+end");
  });
});

describe("summarizeCompactionEntry", () => {
  it("keeps the fields the GUI draws the item from", () => {
    const entry = summarizeCompactionEntry({
      id: "5a3ae3d4",
      summary: "## Goal\n- earlier work",
      shortSummary: "Archived 83,055 chars",
      firstKeptEntryId: "771c869b",
      method: "snapcompact",
      timestamp: "2026-09-28T02:14:08.588Z",
      tokensBefore: 851008,
      tokensAfter: 45263,
      details: { readFiles: ["a", "b"] },
    });

    expect(entry).toEqual({
      id: "5a3ae3d4",
      summary: "## Goal\n- earlier work",
      shortSummary: "Archived 83,055 chars",
      firstKeptEntryId: "771c869b",
      method: "snapcompact",
      timestamp: "2026-09-28T02:14:08.588Z",
      tokensBefore: 851008,
      tokensAfter: 45263,
    });
  });

  it("drops the bulky fields the item never renders", () => {
    const entry = summarizeCompactionEntry({
      id: "x",
      summary: "s",
      details: { readFiles: Array.from({ length: 500 }, (_, i) => `file-${i}`) },
    });

    expect(entry).not.toBeNull();
    expect("details" in entry).toBe(false);
  });

  it("returns null for a payload without identity or summary", () => {
    // Unknown shapes must not put an undefined item on screen.
    expect(summarizeCompactionEntry(null)).toBeNull();
    expect(summarizeCompactionEntry("nope")).toBeNull();
    expect(summarizeCompactionEntry({ tokensBefore: 5 })).toBeNull();
  });
});
