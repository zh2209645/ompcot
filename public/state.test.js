import { describe, expect, test } from "vitest";
import { agentEndContinues, mergeToolExecution, nextToolStatus, StateManager } from "./state.js";

describe("agentEndContinues", () => {
  test("a scheduled continuation is not the end of the run", () => {
    // `willContinue: true` means omp already queued its own continuation
    // (auto-retry, empty-stop retry, compaction) — the host's contract says
    // subscribers must not treat it as a terminal settle.
    expect(agentEndContinues({ type: "agent_end", willContinue: true })).toBe(true);
  });

  test("a plain end is terminal", () => {
    expect(agentEndContinues({ type: "agent_end" })).toBe(false);
    expect(agentEndContinues({ type: "agent_end", willContinue: false })).toBe(false);
    // Absent event object (defensive call sites pass null) is terminal.
    expect(agentEndContinues(null)).toBe(false);
    expect(agentEndContinues(undefined)).toBe(false);
  });

  test("only a literal true continues", () => {
    expect(agentEndContinues({ willContinue: "true" })).toBe(false);
    expect(agentEndContinues({ willContinue: 1 })).toBe(false);
  });
});

describe("nextToolStatus", () => {
  test("only moves forward through the lifecycle", () => {
    expect(nextToolStatus("pending", "streaming")).toBe("streaming");
    expect(nextToolStatus("streaming", "complete")).toBe("complete");
    expect(nextToolStatus("streaming", "error")).toBe("error");
  });

  test("never walks a finished call back to running", () => {
    // A late `tool_execution_update` (or a replayed start) used to flip the
    // pill back to "Working…" and restart its pulse animation.
    expect(nextToolStatus("complete", "streaming")).toBe("complete");
    expect(nextToolStatus("complete", "pending")).toBe("complete");
    expect(nextToolStatus("error", "streaming")).toBe("error");
    expect(nextToolStatus("error", "complete")).toBe("error");
  });

  test("ignores unknown statuses and fills in a missing one", () => {
    expect(nextToolStatus("complete", undefined)).toBe("complete");
    expect(nextToolStatus(undefined, "streaming")).toBe("streaming");
    expect(nextToolStatus("complete", "banana")).toBe("complete");
  });
});

describe("mergeToolExecution", () => {
  test("creates a pending record for a first sighting", () => {
    expect(mergeToolExecution(null, { toolName: "bash" })).toEqual({
      status: "pending",
      output: "",
      isError: false,
      toolName: "bash",
    });
  });

  test("keeps the output a replayed start frame does not carry", () => {
    const running = { toolCallId: "call_1", status: "streaming", output: "line\n", isError: false };
    const replayedStart = { toolCallId: "call_1", toolName: "bash", args: {}, status: "pending" };
    expect(mergeToolExecution(running, replayedStart)).toEqual({
      toolCallId: "call_1",
      toolName: "bash",
      args: {},
      status: "streaming",
      output: "line\n",
      isError: false,
    });
  });

  test("keeps the final result when an update lands late", () => {
    const finished = { toolCallId: "call_1", status: "complete", output: "done", isError: false };
    const late = { status: "streaming", output: "" };
    const merged = mergeToolExecution(finished, late);
    expect(merged.status).toBe("complete");
    expect(merged.output).toBe("done");
  });

  test("an error is sticky", () => {
    const failed = { toolCallId: "call_1", status: "error", output: "boom", isError: true };
    expect(mergeToolExecution(failed, { status: "complete", isError: false }).isError).toBe(true);
  });
});

describe("StateManager tool executions", () => {
  test("a replayed start does not reset a running call", () => {
    const state = new StateManager();
    state.addToolExecution("call_1", { toolName: "wait", args: {}, status: "pending" });
    state.updateToolExecution("call_1", { status: "streaming", output: "1\n2\n" });
    state.addToolExecution("call_1", { toolName: "wait", args: {}, status: "pending" });
    const execution = state.getToolExecution("call_1");
    expect(execution.status).toBe("streaming");
    expect(execution.output).toBe("1\n2\n");
  });

  test("a late update after the end keeps the finished status", () => {
    const state = new StateManager();
    state.addToolExecution("call_1", { toolName: "bash", args: {} });
    state.updateToolExecution("call_1", { status: "complete", output: "done" });
    state.updateToolExecution("call_1", { status: "streaming", output: "" });
    expect(state.getToolExecution("call_1").status).toBe("complete");
    expect(state.getToolExecution("call_1").output).toBe("done");
  });
});
