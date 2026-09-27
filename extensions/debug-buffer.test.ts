import { describe, expect, test } from "vitest";
import {
  createDebugBuffer,
  summarizeBroadcast,
  summarizeCommand,
  summarizeValue,
  writeDebugBundle,
} from "./debug-buffer.ts";

/**
 * Narrow a summary to a plain object. The summarizers return `unknown`-shaped
 * records on purpose (their fields vary per frame type), so the test narrows
 * once with a runtime check instead of assert-casting at every read.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(`expected object, got ${typeof value}`);
  return value; // narrowed by the guard above
}

describe("createDebugBuffer", () => {
  test("keeps the newest entries within the limit", () => {
    const buffer = createDebugBuffer({ limit: 3 });
    for (let i = 0; i < 6; i++) buffer.log("http", { i });
    expect(buffer.snapshot().map((entry) => asRecord(entry.data).i)).toEqual([3, 4, 5]);
    expect(buffer.size()).toBe(3);
  });

  test("folds repeated frames sharing a coalesce key", () => {
    const buffer = createDebugBuffer({ limit: 10 });
    for (let i = 0; i < 100; i++) buffer.log("broadcast", { len: i }, "message_update:7");
    const snapshot = buffer.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].count).toBe(100);
    buffer.log("broadcast", {}, "message_update:8");
    expect(buffer.size()).toBe(2);
  });

  test("snapshot(take) returns the newest N entries", () => {
    const buffer = createDebugBuffer();
    for (let i = 0; i < 10; i++) buffer.log("http", { i });
    expect(buffer.snapshot(3).map((entry) => asRecord(entry.data).i)).toEqual([7, 8, 9]);
  });

  test("bounds the buffer by bytes", () => {
    const buffer = createDebugBuffer({ limit: 1000, maxBytes: 2000 });
    for (let i = 0; i < 50; i++) buffer.log("http", "z".repeat(200));
    expect(buffer.bytes()).toBeLessThanOrEqual(2000);
  });
});

describe("summarizeBroadcast", () => {
  test("summarizes a forwarded event without payload text", () => {
    const summary = asRecord(
      summarizeBroadcast({
        type: "event",
        event: {
          type: "message_end",
          entryId: "e9",
          message: {
            role: "assistant",
            timestamp: 7,
            content: [
              { type: "text", text: "x".repeat(120) },
              { type: "thinking", thinking: "y".repeat(30) },
            ],
            stopReason: "end_turn",
          },
        },
      }),
    );
    expect(asRecord(summary.event)).toMatchObject({
      type: "message_end",
      role: "assistant",
      ts: 7,
      entryId: "e9",
      blocks: "text:120,thinking:30",
      stopReason: "end_turn",
    });
    expect(JSON.stringify(summary)).not.toContain("xxxx");
  });

  test("summarizes a snapshot by size, not by entries", () => {
    const summary = asRecord(
      summarizeBroadcast({
        type: "mirror_sync",
        sessionFile: "C:/sessions/p/s.jsonl",
        isStreaming: false,
        entries: new Array(900).fill({ type: "message" }),
      }),
    );
    expect(summary).toMatchObject({ type: "mirror_sync", isStreaming: false, entryCount: 900 });
  });

  test("keeps the command and error of a failed response", () => {
    const summary = asRecord(
      summarizeBroadcast({
        type: "response",
        command: "prompt",
        success: false,
        error: "no active session",
      }),
    );
    expect(summary).toMatchObject({ type: "response", command: "prompt", success: false });
    expect(summary.error).toBe("no active session");
  });

  test("keeps routing keys for other frames", () => {
    const summary = asRecord(
      summarizeBroadcast({
        type: "extension_ui_request",
        id: "req-1",
        method: "confirm",
        statusKey: "k",
      }),
    );
    expect(summary).toMatchObject({ type: "extension_ui_request", id: "req-1", method: "confirm" });
  });
});

describe("summarizeCommand", () => {
  test("keeps the command type and small identifying fields", () => {
    const summary = asRecord(
      summarizeCommand({
        type: "prompt",
        id: "r1",
        message: "x".repeat(500),
        streamingBehavior: "steer",
        images: [{}, {}],
      }),
    );
    expect(summary).toMatchObject({
      type: "prompt",
      id: "r1",
      streamingBehavior: "steer",
      images: 2,
    });
    expect(String(summary.message)).toContain("…(+300)");
  });
});

describe("writeDebugBundle", () => {
  test("creates the directory, writes pretty JSON and reports size", async () => {
    const written: { path?: string; data?: string; dirs: string[] } = { dirs: [] };
    const fsPromises = {
      mkdir: async (path: string) => {
        written.dirs.push(path);
      },
      writeFile: async (path: string, data: string) => {
        written.path = path;
        written.data = data;
      },
    };
    const result = await writeDebugBundle("C:/tmp/ompcot-debug/dump.json", { a: 1 }, fsPromises);
    expect(written.dirs).toEqual(["C:/tmp/ompcot-debug"]);
    expect(written.path).toBe("C:/tmp/ompcot-debug/dump.json");
    expect(JSON.parse(String(written.data))).toEqual({ a: 1 });
    expect(result.bytes).toBe(String(written.data).length);
  });

  test("creates the parent directory of the given file path", async () => {
    const seen: { dir?: string; file?: string } = {};
    await writeDebugBundle(
      "C:/tmp/x/d.json",
      {},
      {
        mkdir: async (dir: string) => {
          seen.dir = dir;
        },
        writeFile: async (file: string) => {
          seen.file = file;
        },
      },
    );
    expect(seen.dir).toBe("C:/tmp/x");
    expect(seen.file).toBe("C:/tmp/x/d.json");
  });
});

describe("summarizeValue", () => {
  test("truncates long fields", () => {
    expect(String(summarizeValue("q".repeat(500)))).toContain("…(+100)");
    expect(summarizeValue(3)).toBe(3);
  });
});
