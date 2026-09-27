// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  applyInstancePatch,
  type InstanceEntry,
  mergeInstanceEntry,
  parseInstanceEntry,
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
