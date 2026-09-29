import { describe, expect, test } from "vitest";
import { createTranscriptView, isTranscriptEvent } from "./transcript-view.js";

const AGENT_FILE = "C:/omp/sessions/p/root/Explorer.jsonl";
const SESSION_FILE = "C:/omp/sessions/p/root/session.jsonl";

describe("isTranscriptEvent", () => {
  test("marks the events that draw into the transcript", () => {
    for (const type of [
      "message_start",
      "message_update",
      "message_end",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "extension_error",
    ]) {
      expect(isTranscriptEvent(type)).toBe(true);
    }
  });

  test("leaves everything that is not transcript content alone", () => {
    for (const type of [
      // `agent_start`/`agent_end` carry no transcript content: they maintain
      // the streaming flag, the typing indicator and the sidebar's running
      // mark. Suppressing `agent_start` during a peek left the sidebar dot off
      // for a run that started while the user was reading a subagent.
      "agent_start",
      "agent_end",
      "extension_ui_request",
      "session_branch",
      "session_name",
      "agents_changed",
      // The compaction frames carry the *global* compaction state (the
      // header's "compacting" label and dot); only the transcript line they
      // draw is surface-owned, and the handlers guard that write themselves.
      // Dropping the frames whole left a compaction that ran during a peek
      // completely invisible — and its start line stuck on screen.
      "auto_compaction_start",
      "auto_compaction_end",
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

  test("detach() keeps the view and its token but gives up ownership", () => {
    // A selected session no process can host (another workspace's, whose
    // directory is gone) is drawn read-only: the live session's frames and
    // snapshots must leave it alone, and the tail-first hydration that is
    // already loading earlier entries must keep working — so the token stays.
    const view = createTranscriptView();
    const token = view.claimLive(SESSION_FILE);
    view.detach();
    expect(view.isCurrent(token)).toBe(true);
    expect(view.detached).toBe(true);
    expect(view.kind).toBe("history");
    expect(view.file).toBe(SESSION_FILE);
    expect(view.suppresses("message_end")).toBe(true);
    expect(view.suppresses("extension_ui_request")).toBe(false);
    // Not a peek: the Agent-Hub-specific callers test `active`.
    expect(view.active).toBe(false);

    view.reattach();
    expect(view.detached).toBe(false);
    expect(view.suppresses("message_end")).toBe(false);
  });

  test("detach() is a no-op for a view that is not the live session", () => {
    const view = createTranscriptView();
    view.claimAgent(AGENT_FILE);
    view.detach();
    expect(view.kind).toBe("agent");
    view.reattach();
    expect(view.kind).toBe("agent");
  });

  test("a new claim clears a detached view", () => {
    const view = createTranscriptView();
    view.claimLive(SESSION_FILE);
    view.detach();
    view.claimLive(AGENT_FILE);
    expect(view.detached).toBe(false);
    expect(view.kind).toBe("live");
    expect(view.suppresses("message_update")).toBe(false);
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
