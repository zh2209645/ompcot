// @vitest-environment node

import { describe, expect, it } from "vitest";
import { latestTodoPhasesFromEntries, type TodoPhaseSnapshot } from "./embedded-server.ts";

// The shapes omp 18.20.0 writes into a session file (read off live session
// files): a state-changing `todo` op commits a snapshot through its own
// toolResult message (`type:"message"`, `message.role:"toolResult"`,
// `message.toolName:"todo"`, `message.details.phases`), and TUI-HUD edits
// land as `user_todo_edit` custom entries (`data.phases`). Entries arrive
// branch-ordered, newest last.

const PHASES_A: TodoPhaseSnapshot[] = [
  {
    name: "Audit",
    tasks: [
      { content: "Triage notes", status: "completed" },
      { content: "Map findings", status: "in_progress" },
      {
        content: "Write report",
        status: "pending",
        details: "with evidence",
        notes: ["keep terse"],
      },
    ],
  },
];

const PHASES_B: TodoPhaseSnapshot[] = [
  { name: "Ship", tasks: [{ content: "Land it", status: "pending" }] },
];

function todoToolResult(id: string, phases: unknown, timestamp = "2026-11-16T00:00:00.000Z") {
  return {
    type: "message",
    id,
    timestamp,
    message: {
      role: "toolResult",
      toolName: "todo",
      toolCallId: `call-${id}`,
      details: { op: "init", phases, storage: "session" },
    },
  };
}

function userTodoEdit(id: string, phases: unknown) {
  return { type: "custom", customType: "user_todo_edit", id, data: { phases } };
}

describe("latestTodoPhasesFromEntries", () => {
  it("returns the newest todo tool-result snapshot", () => {
    const entries = [todoToolResult("a", PHASES_A), todoToolResult("b", PHASES_B)];
    expect(latestTodoPhasesFromEntries(entries)).toEqual(PHASES_B);
  });

  it("lets a newer user_todo_edit override the tool snapshot", () => {
    const entries = [todoToolResult("a", PHASES_A), userTodoEdit("u1", PHASES_B)];
    expect(latestTodoPhasesFromEntries(entries)).toEqual(PHASES_B);
  });

  it("accepts the custom_message spelling of user edit entries", () => {
    const entries = [
      todoToolResult("a", PHASES_A),
      {
        type: "custom_message",
        customType: "user_todo_edit",
        id: "u1",
        data: { phases: PHASES_B },
      },
    ];
    expect(latestTodoPhasesFromEntries(entries)).toEqual(PHASES_B);
  });

  it("ignores task-tool phases that merely look similar (no todo carrier)", () => {
    // `task` tool details also carry `phases`/`tasks` keys (subagent steps) —
    // a loose read would render those as todos.
    const entries = [
      {
        type: "message",
        id: "t1",
        message: {
          role: "toolResult",
          toolName: "task",
          details: { phases: [{ name: "Step", tasks: [{ content: "x", status: "pending" }] }] },
        },
      },
    ];
    expect(latestTodoPhasesFromEntries(entries)).toBeNull();
  });

  it("skips a malformed snapshot and falls back to an earlier good one", () => {
    const entries = [
      todoToolResult("a", PHASES_A),
      todoToolResult("b", [{ name: "Broken", tasks: "not-an-array" }]),
    ];
    expect(latestTodoPhasesFromEntries(entries)).toEqual(PHASES_A);
  });

  it("maps unknown statuses to pending and keeps details/notes", () => {
    // `blocked` existed before omp 18.19.0 removed it; the runtime restores
    // such tasks as pending, and so does this scanner.
    const entries = [
      todoToolResult("a", [
        {
          name: "P",
          tasks: [
            {
              content: "old blocked task",
              status: "blocked",
              blocker: "waiting",
              details: "d",
              notes: ["n", 7],
            },
          ],
        },
      ]),
    ];
    expect(latestTodoPhasesFromEntries(entries)).toEqual([
      {
        name: "P",
        tasks: [{ content: "old blocked task", status: "pending", details: "d", notes: ["n"] }],
      },
    ]);
  });

  it("treats an empty phases array as a real snapshot, not a miss", () => {
    // `todo rm` of the last task commits an empty list — the panel must show
    // "no todos", not the earlier list.
    const entries = [todoToolResult("a", PHASES_A), todoToolResult("b", [])];
    expect(latestTodoPhasesFromEntries(entries)).toEqual([]);
  });

  it("returns null when no snapshot exists and tolerates junk entries", () => {
    expect(latestTodoPhasesFromEntries([])).toBeNull();
    expect(latestTodoPhasesFromEntries(null)).toBeNull();
    expect(latestTodoPhasesFromEntries([null, 3, { type: "message", message: {} }, {}])).toBeNull();
  });
});
