// @vitest-environment node

import { describe, expect, it } from "vitest";
import { applyLiveMainSession, newDisplayableNotices } from "./embedded-server.ts";

// The shapes omp writes into a session file (measured on 18.3.2/18.3.5):
// `display: true` notices are meant to be shown, `display: false` ones are
// hidden by design, and entries carry no `message` object at all.
const entries = [
  { type: "session", id: "header" },
  { type: "message", id: "m1", message: { role: "user", content: "hi" } },
  {
    type: "custom_message",
    id: "n1",
    customType: "async-result",
    display: true,
    content: "<system-notice>\nBackground job X has completed.\n</system-notice>",
  },
  {
    type: "custom_message",
    id: "n2",
    customType: "mid-run-todo-nudge",
    display: false,
    content: "hidden nudge",
  },
  {
    type: "custom_message",
    id: "n3",
    customType: "launch-completion",
    display: true,
    content: "done",
  },
];

describe("newDisplayableNotices", () => {
  it("returns the displayable notices, in entry order", () => {
    const notices = newDisplayableNotices(entries, new Set());

    expect(notices.map((notice) => notice.entryId)).toEqual(["n1", "n3"]);
    expect(notices[0]).toEqual({
      entryId: "n1",
      customType: "async-result",
      content: "<system-notice>\nBackground job X has completed.\n</system-notice>",
    });
  });

  it("hides the entries omp marks display:false", () => {
    const notices = newDisplayableNotices(entries, new Set());
    expect(notices.some((notice) => notice.entryId === "n2")).toBe(false);
  });

  it("does not re-offer an entry that was already forwarded", () => {
    const forwarded = new Set(["n1", "n3"]);
    expect(newDisplayableNotices(entries, forwarded)).toEqual([]);

    // The set is what makes the check idempotent across lifecycle frames.
    const notices = newDisplayableNotices(entries, new Set(["n1"]));
    expect(notices.map((notice) => notice.entryId)).toEqual(["n3"]);
  });

  it("skips entries without an id (they cannot be deduped) and malformed input", () => {
    expect(
      newDisplayableNotices(
        [
          { type: "custom_message", customType: "async-result", display: true, content: "x" },
          { type: "custom_message", id: "", display: true, content: "y" },
        ],
        new Set(),
      ),
    ).toEqual([]);
    expect(newDisplayableNotices(null, new Set())).toEqual([]);
    expect(newDisplayableNotices([null, 42, "x"], new Set())).toEqual([]);
  });

  it("defaults a missing customType instead of dropping the notice", () => {
    const notices = newDisplayableNotices(
      [{ type: "custom_message", id: "n9", display: true, content: "x" }],
      new Set(),
    );
    expect(notices).toEqual([{ entryId: "n9", customType: "", content: "x" }]);
  });
});

describe("applyLiveMainSession", () => {
  const row = (kind: string, sessionFile: string | null) => ({
    id: kind === "main" ? "Main" : "sub-1",
    name: kind,
    kind,
    parentId: null,
    status: "running",
    running: true,
    sessionFile,
  });

  it("points the main row at the session the process is driving now", () => {
    // omp registers the main agent once, at process start: its ref keeps the
    // session the process was born with, so after a new_session / switch / fork
    // the roster named a session the process had already left.
    const agents = [row("sub", "/sessions/p/sub.jsonl"), row("main", "/sessions/p/old.jsonl")];
    const patched = applyLiveMainSession(agents, "/sessions/p/current.jsonl");

    expect(patched.find((a) => a.kind === "main")?.sessionFile).toBe("/sessions/p/current.jsonl");
    // Subagent rows carry their own session tree — never overwritten.
    expect(patched.find((a) => a.kind === "sub")?.sessionFile).toBe("/sessions/p/sub.jsonl");
    // The input rows are not mutated in place.
    expect(agents[1].sessionFile).toBe("/sessions/p/old.jsonl");
  });

  it("leaves the roster alone while the process session is unknown", () => {
    const agents = [row("main", "/sessions/p/old.jsonl")];
    expect(applyLiveMainSession(agents, null)).toBe(agents);
  });
});
