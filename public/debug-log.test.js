import { describe, expect, test } from "vitest";
import {
  buildDebugBundle,
  createDebugLog,
  DEBUG_FIELD_LIMIT,
  installConsoleCapture,
  installErrorCapture,
  summarizeValue,
  summarizeWsFrame,
} from "./debug-log.js";

describe("createDebugLog", () => {
  test("keeps observations in order and hands out copies", () => {
    const log = createDebugLog();
    log.log("a", { n: 1 });
    log.log("b", "two");
    const snapshot = log.snapshot();
    expect(snapshot.map((entry) => entry.kind)).toEqual(["a", "b"]);
    expect(log.size()).toBe(2);
    // The snapshot is a copy: mutating it must not corrupt the buffer.
    snapshot.push({ kind: "c" });
    expect(log.size()).toBe(2);
  });

  test("drops the oldest entries past the limit", () => {
    const log = createDebugLog({ limit: 3 });
    for (let i = 0; i < 5; i++) log.log("tick", { i });
    expect(log.snapshot().map((entry) => entry.data.i)).toEqual([2, 3, 4]);
  });

  test("bounds the buffer by bytes as well", () => {
    const log = createDebugLog({ limit: 1000, maxBytes: 2000 });
    for (let i = 0; i < 50; i++) log.log("big", "x".repeat(200));
    expect(log.bytes()).toBeLessThanOrEqual(2000);
    expect(log.size()).toBeGreaterThan(1);
  });

  test("folds repeated observations sharing a coalesce key", () => {
    // A streaming reply emits thousands of near-identical frames: they must not
    // crowd out the transitions that explain a bug.
    const log = createDebugLog({ limit: 10 });
    for (let i = 0; i < 200; i++) log.log("ws.in", { len: i }, "message_update:42");
    const snapshot = log.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].count).toBe(200);
    expect(snapshot[0].data.len).toBe(199);
    // A different key starts a new entry.
    log.log("ws.in", { len: 0 }, "message_update:43");
    expect(log.size()).toBe(2);
  });

  test("a disabled log records nothing and can be re-enabled", () => {
    const log = createDebugLog();
    log.log("a", 1);
    log.setEnabled(false);
    log.log("b", 2);
    expect(log.snapshot().map((entry) => entry.kind)).toEqual(["a"]);
    log.setEnabled(true);
    log.log("c", 3);
    expect(log.snapshot().map((entry) => entry.kind)).toEqual(["a", "c"]);
  });

  test("survives a payload it cannot serialize", () => {
    const log = createDebugLog();
    const cyclic = {};
    cyclic.self = cyclic;
    expect(() => log.log("cyclic", cyclic)).not.toThrow();
    expect(log.size()).toBe(1);
  });
});

describe("summarizeValue", () => {
  test("truncates long strings and marks the cut", () => {
    const text = "y".repeat(DEBUG_FIELD_LIMIT + 25);
    const summary = summarizeValue(text);
    expect(String(summary)).toContain("…(+25)");
    expect(String(summary).length).toBeLessThan(text.length);
  });

  test("passes scalars through and serializes objects", () => {
    expect(summarizeValue(7)).toBe(7);
    expect(summarizeValue(true)).toBe(true);
    expect(summarizeValue(null)).toBeNull();
    expect(summarizeValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe("summarizeWsFrame", () => {
  test("summarizes an event frame without its text or tool output", () => {
    const frame = summarizeWsFrame("in", {
      type: "event",
      __broker: { sessionId: "s1", sourcePort: 47821 },
      event: {
        type: "message_update",
        entryId: "e1",
        message: {
          role: "assistant",
          timestamp: 42,
          content: [
            { type: "thinking", thinking: "x".repeat(500) },
            { type: "text", text: "y".repeat(50) },
            { type: "toolCall", name: "bash" },
          ],
        },
      },
    });
    expect(frame.dir).toBe("in");
    expect(frame.sourcePort).toBe(47821);
    expect(frame.event).toMatchObject({
      type: "message_update",
      role: "assistant",
      ts: 42,
      entryId: "e1",
      blocks: "thinking:500,text:50,toolCall:bash",
    });
    expect(JSON.stringify(frame)).not.toContain("xxxx");
  });

  test("summarizes a snapshot by size and tail identity", () => {
    const frame = summarizeWsFrame("in", {
      type: "mirror_sync",
      sessionFile: "C:/sessions/p/s.jsonl",
      isStreaming: true,
      entries: [
        { type: "message", id: "a", message: { role: "user", timestamp: 1 } },
        { type: "message", id: "b", message: { role: "assistant", timestamp: 2 } },
      ],
    });
    expect(frame.entryCount).toBe(2);
    expect(frame.isStreaming).toBe(true);
    expect(frame.tail).toEqual([
      { type: "message", id: "a", role: "user", ts: 1 },
      { type: "message", id: "b", role: "assistant", ts: 2 },
    ]);
  });

  test("records command failures", () => {
    const frame = summarizeWsFrame("in", {
      type: "response",
      command: "prompt",
      success: false,
      error: "Slash command cannot run while the agent is streaming",
    });
    expect(frame).toMatchObject({ dir: "in", type: "response", command: "prompt" });
    expect(frame.error).toContain("Slash command");
  });
});

describe("installConsoleCapture", () => {
  test("mirrors console output and keeps the original behaviour", () => {
    const log = createDebugLog();
    const calls = [];
    const fake = { log: (...args) => calls.push(args), warn: () => {}, error: () => {} };
    const uninstall = installConsoleCapture(log, { consoleRef: fake });
    fake.log("hello", { a: 1 });
    expect(calls).toEqual([["hello", { a: 1 }]]);
    const entries = log.snapshot();
    expect(entries[0].kind).toBe("console.log");
    expect(String(entries[0].data)).toContain("hello");
    uninstall();
    expect(fake.log).toBe(fake.log); // restored wrapper is gone
  });

  test("capture failures never propagate", () => {
    const explodingLog = {
      log: () => {
        throw new Error("buffer gone");
      },
    };
    const fake = { log: () => {} };
    installConsoleCapture(explodingLog, { consoleRef: fake });
    expect(() => fake.log("still fine")).not.toThrow();
  });
});

describe("installErrorCapture", () => {
  test("records window errors and unhandled rejections", () => {
    const listeners = new Map();
    const windowRef = {
      addEventListener: (type, handler) => listeners.set(type, handler),
      removeEventListener: (type) => listeners.delete(type),
    };
    const log = createDebugLog();
    const uninstall = installErrorCapture(log, { windowRef });
    listeners.get("error")({ message: "boom", filename: "app.js", lineno: 12, colno: 3 });
    listeners.get("unhandledrejection")({ reason: new Error("nope") });
    const kinds = log.snapshot().map((entry) => entry.kind);
    expect(kinds).toEqual(["window.error", "window.unhandledrejection"]);
    uninstall();
    expect(listeners.size).toBe(0);
  });
});

describe("buildDebugBundle", () => {
  test("wraps the metadata and both buffers", () => {
    const bundle = buildDebugBundle({
      meta: { workspacePath: "D:/w" },
      frontend: [{ kind: "route", t: 1, data: {} }],
      extension: { entries: [], size: 0, bytes: 0 },
    });
    expect(bundle.kind).toBe("ompcot-debug-bundle");
    expect(bundle.meta).toEqual({ workspacePath: "D:/w" });
    expect(bundle.frontend).toHaveLength(1);
    expect(bundle.extension).toEqual({ entries: [], size: 0, bytes: 0 });
    expect(typeof bundle.capturedAt).toBe("string");
  });

  test("defaults to empty buffers", () => {
    const bundle = buildDebugBundle();
    expect(bundle.frontend).toEqual([]);
    expect(bundle.extension).toBeNull();
  });
});
