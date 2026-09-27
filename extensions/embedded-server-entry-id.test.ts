// @vitest-environment node

import { describe, expect, it } from "vitest";
import { matchMessageEntryId } from "./embedded-server.ts";

const TS = 1790545667514;

const assistantEntry = {
  type: "message",
  id: "7caad963",
  message: { role: "assistant", timestamp: TS, content: [] },
};

describe("matchMessageEntryId", () => {
  it("matches the newest entry with the same role and timestamp", () => {
    const entries = [
      { type: "message", id: "older", message: { role: "assistant", timestamp: TS - 1 } },
      assistantEntry,
    ];
    expect(matchMessageEntryId(entries, { role: "assistant", timestamp: TS })).toBe("7caad963");
  });

  it("ignores entries of the other role at the same timestamp", () => {
    const entries = [
      assistantEntry,
      { type: "message", id: "user", message: { role: "user", timestamp: TS } },
    ];
    expect(matchMessageEntryId(entries, { role: "user", timestamp: TS })).toBe("user");
  });

  it("skips non-message entries (session header, model change, hidden notices)", () => {
    const entries = [
      { type: "session", id: "01a0e4b7", timestamp: TS },
      { type: "custom_message", id: "notice", message: { role: "assistant", timestamp: TS } },
      assistantEntry,
    ];
    expect(matchMessageEntryId(entries, { role: "assistant", timestamp: TS })).toBe("7caad963");
  });

  it("returns null when the entry is not persisted yet (the reason for the deferred retry)", () => {
    expect(matchMessageEntryId([], { role: "assistant", timestamp: TS })).toBeNull();
    expect(
      matchMessageEntryId(
        [{ type: "message", id: "x", message: { role: "user", timestamp: TS } }],
        { role: "assistant", timestamp: TS },
      ),
    ).toBeNull();
  });

  it("returns null for a message without a numeric timestamp", () => {
    expect(matchMessageEntryId([assistantEntry], { role: "assistant" })).toBeNull();
    expect(
      matchMessageEntryId([assistantEntry], { role: "assistant", timestamp: String(TS) }),
    ).toBeNull();
    expect(matchMessageEntryId([assistantEntry], null)).toBeNull();
  });

  it("survives malformed entries without throwing", () => {
    const entries = [null, 42, "x", { type: "message" }, { type: "message", id: "n", message: 7 }];
    expect(matchMessageEntryId(entries, { role: "assistant", timestamp: TS })).toBeNull();
  });
});
