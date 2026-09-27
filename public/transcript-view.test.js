import { describe, expect, test } from "vitest";
import { createTranscriptView, isTranscriptEvent } from "./transcript-view.js";

const AGENT_FILE = "C:/omp/sessions/p/root/Explorer.jsonl";
const SESSION_FILE = "C:/omp/sessions/p/root/session.jsonl";

describe("isTranscriptEvent", () => {
  test("marks the events that draw into the transcript", () => {
    for (const type of [
      "agent_start",
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "auto_compaction_start",
      "auto_compaction_end",
      "extension_error",
    ]) {
      expect(isTranscriptEvent(type)).toBe(true);
    }
  });

  test("leaves everything that is not transcript content alone", () => {
    for (const type of [
      "agent_end",
      "extension_ui_request",
      "session_branch",
      "session_name",
      "agents_changed",
    ]) {
      expect(isTranscriptEvent(type)).toBe(false);
    }
  });
});

describe("createTranscriptView", () => {
  test("starts with no owner and suppresses nothing", () => {
    const view = createTranscriptView();
    expect(view.active).toBe(false);
    expect(view.file).toBeNull();
    expect(view.suppresses("tool_execution_update")).toBe(false);
  });

  test("an agent claim owns the transcript until it is handed back", () => {
    const view = createTranscriptView();
    view.claimAgent(AGENT_FILE);
    expect(view.active).toBe(true);
    expect(view.file).toBe(AGENT_FILE);
    // The parent's live `wait` card must not be painted into this view.
    expect(view.suppresses("tool_execution_update")).toBe(true);
    expect(view.suppresses("message_end")).toBe(true);
    // Dialogs and session-branch acks still reach the UI.
    expect(view.suppresses("extension_ui_request")).toBe(false);

    view.end();
    expect(view.active).toBe(false);
    expect(view.suppresses("message_update")).toBe(false);
  });

  test("a live claim takes the transcript back and keeps streaming live", () => {
    const view = createTranscriptView();
    view.claimAgent(AGENT_FILE);
    view.claimLive(SESSION_FILE);
    expect(view.active).toBe(false);
    expect(view.file).toBeNull();
    expect(view.suppresses("message_update")).toBe(false);
  });

  test("the newest claim owns the transcript", () => {
    const view = createTranscriptView();
    const first = view.claimAgent("C:/omp/sessions/p/root/A.jsonl");
    expect(view.isCurrent(first)).toBe(true);
    // Two quick clicks: the slower response for the first agent must not paint.
    const second = view.claimAgent("C:/omp/sessions/p/root/B.jsonl");
    expect(view.isCurrent(first)).toBe(false);
    expect(view.isCurrent(second)).toBe(true);
    expect(view.file).toBe("C:/omp/sessions/p/root/B.jsonl");
  });

  test("a session selection invalidates a transcript load in flight", () => {
    const view = createTranscriptView();
    const peek = view.claimAgent(AGENT_FILE);
    const live = view.claimLive(SESSION_FILE);
    expect(view.isCurrent(peek)).toBe(false);
    expect(view.isCurrent(live)).toBe(true);
    expect(view.active).toBe(false);
  });

  test("a history fetch that resolves after a newer claim is stale", () => {
    // The reported race: clicking a sidebar session and an Agent Hub row in
    // quick succession let the slower history response paint over the view.
    const view = createTranscriptView();
    const selection = view.claimLive(SESSION_FILE);
    const peek = view.claimAgent(AGENT_FILE);
    expect(view.isCurrent(selection)).toBe(false);
    expect(view.isCurrent(peek)).toBe(true);
  });

  test("end() invalidates an in-flight claim without an owner", () => {
    const view = createTranscriptView();
    const token = view.claimAgent(AGENT_FILE);
    view.end();
    expect(view.isCurrent(token)).toBe(false);
    expect(view.active).toBe(false);
    expect(view.file).toBeNull();
  });
});
