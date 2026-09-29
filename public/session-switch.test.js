import { describe, expect, test } from "vitest";
import {
  planSessionHosting,
  SESSION_HOSTING,
  SessionSwitchGate,
  SWITCH_CONFIRM_BUDGET_MS,
  sameWorkspacePath,
} from "./session-switch.js";

const SESSION_A = "C:/omp/sessions/p/session-a.jsonl";
const SESSION_B = "C:/omp/sessions/p/session-b.jsonl";

function makeGate() {
  const gate = new SessionSwitchGate({ attempts: 3, intervalMs: 1 });
  const calls = { sleep: 0, send: 0 };
  gate.sleep = async () => {
    calls.sleep++;
  };
  return { gate, calls };
}

describe("SessionSwitchGate", () => {
  test("applies every snapshot while no switch is pending", () => {
    const { gate } = makeGate();
    expect(gate.accepts(SESSION_A)).toBe(true);
    expect(gate.accepts(null)).toBe(true);
  });

  test("rejects the pre-switch snapshot while the switch is pending", () => {
    const { gate } = makeGate();
    gate.expect(SESSION_B);
    expect(gate.accepts(SESSION_A)).toBe(false);
    // A snapshot without a session file can never confirm a switch — and would
    // otherwise wipe the freshly rendered history.
    expect(gate.accepts(null)).toBe(false);
    expect(gate.accepts(SESSION_B)).toBe(true);
  });

  test("settle clears the gate so snapshots apply again", () => {
    const { gate } = makeGate();
    gate.expect(SESSION_B);
    gate.settle(SESSION_B);
    expect(gate.pending).toBeNull();
    expect(gate.accepts(SESSION_A)).toBe(true);
  });

  test("settle ignores a snapshot for a different session", () => {
    const { gate } = makeGate();
    gate.expect(SESSION_B);
    gate.settle(SESSION_A);
    expect(gate.pending).toBe(SESSION_B);
    expect(gate.accepts(SESSION_A)).toBe(false);
  });

  test("waitForConfirmation re-requests until the target snapshot settles", async () => {
    const { gate, calls } = makeGate();
    gate.expect(SESSION_B);
    const confirmed = await gate.waitForConfirmation(SESSION_B, {
      sendRequest: async () => {
        calls.send++;
        if (calls.send === 2) gate.settle(SESSION_B);
      },
    });
    expect(confirmed).toBe(true);
    expect(calls.send).toBe(2);
    expect(gate.pending).toBeNull();
    expect(gate.accepts(SESSION_A)).toBe(true);
  });

  test("waitForConfirmation passes immediately when the switch already settled", async () => {
    const { gate, calls } = makeGate();
    gate.expect(SESSION_B);
    gate.settle(SESSION_B);
    const confirmed = await gate.waitForConfirmation(SESSION_B, {
      sendRequest: async () => {
        calls.send++;
      },
    });
    expect(confirmed).toBe(true);
    expect(calls.send).toBe(0);
  });

  test("an unconfirmed switch times out and unblocks later snapshots", async () => {
    const { gate, calls } = makeGate();
    gate.expect(SESSION_B);
    const confirmed = await gate.waitForConfirmation(SESSION_B, {
      sendRequest: async () => {
        calls.send++;
        // The running agent keeps answering with the pre-switch session.
        gate.settle(SESSION_A);
      },
    });
    expect(confirmed).toBe(false);
    expect(calls.send).toBe(3);
    expect(gate.pending).toBeNull();
    expect(gate.accepts(SESSION_A)).toBe(true);
  });

  test("a superseded selection ends the previous wait without confirmation", async () => {
    const { gate } = makeGate();
    gate.expect(SESSION_B);
    const wait = gate.waitForConfirmation(SESSION_B, {
      sendRequest: async () => {
        // The user clicked another session while this switch was in flight.
        gate.expect(SESSION_A);
      },
    });
    await expect(wait).resolves.toBe(false);
    expect(gate.pending).toBe(SESSION_A);
    expect(gate.accepts(SESSION_B)).toBe(false);
    expect(gate.accepts(SESSION_A)).toBe(true);
  });

  test("sendRequest failures do not fail the wait", async () => {
    const { gate, calls } = makeGate();
    gate.expect(SESSION_B);
    const confirmed = await gate.waitForConfirmation(SESSION_B, {
      sendRequest: async () => {
        calls.send++;
        if (calls.send === 1) throw new Error("socket not ready");
        gate.settle(SESSION_B);
      },
    });
    expect(confirmed).toBe(true);
  });
});

describe("sameWorkspacePath", () => {
  test("matches the same workspace regardless of case, separators, trailing slash", () => {
    expect(sameWorkspacePath("D:\\WorkSpace\\ompcot", "D:\\WorkSpace\\ompcot")).toBe(true);
    expect(sameWorkspacePath("D:\\WorkSpace\\ompcot", "d:/workspace/ompcot")).toBe(true);
    expect(sameWorkspacePath("D:\\WorkSpace\\ompcot\\", "D:/WorkSpace/ompcot")).toBe(true);
    expect(sameWorkspacePath("D:\\WorkSpace\\ompcot\\", "D:\\WorkSpace\\ompcot\\")).toBe(true);
  });

  test("distinguishes different workspaces", () => {
    expect(sameWorkspacePath("D:\\WorkSpace\\ompcot", "D:\\WorkSpace\\ompcot2")).toBe(false);
    expect(sameWorkspacePath("D:\\WorkSpace\\ompcot\\src", "D:\\WorkSpace\\ompcot")).toBe(false);
    expect(
      sameWorkspacePath("C:\\Users\\qianp\\AppData\\Local\\Temp\\x", "D:\\WorkSpace\\ompcot"),
    ).toBe(false);
  });

  test("treats missing values as no match", () => {
    expect(sameWorkspacePath("", "D:\\WorkSpace\\ompcot")).toBe(false);
    expect(sameWorkspacePath(null, undefined)).toBe(false);
    expect(sameWorkspacePath("   ", "   ")).toBe(false);
  });
});

describe("planSessionHosting", () => {
  const WORKSPACE = "D:\\WorkSpace\\ompcot";
  const FOREIGN = "C:\\Users\\qianp\\AppData\\Local\\Temp\\omp-ui4";
  const SESSION = "C:/Users/qianp/.omp/agent/sessions/x/session.jsonl";

  const plan = (overrides = {}) =>
    planSessionHosting({
      sessionFile: SESSION,
      sessionCwd: WORKSPACE,
      workspacePath: WORKSPACE,
      ...overrides,
    });

  test("attaches to the process that already hosts the session", () => {
    expect(plan({ liveInstance: true, processStreaming: true })).toBe(SESSION_HOSTING.LIVE);
  });

  test("an idle process on its own workspace switches in place", () => {
    expect(plan()).toBe(SESSION_HOSTING.IN_PLACE);
  });

  // The archived-session freeze: the foreign workspace no longer exists, the
  // dedicated spawn fails with it, and the old fallback switched the *live*
  // process in place — which omp answers by aborting the running turn and then
  // refusing the switch, while the window dropped every snapshot for 120 s.
  // Exactly the reported incident (2026-09-29): the sidebar's archived group
  // listed a session from `Temp\omp-ui4`, that directory had been deleted, the
  // dedicated spawn could not start there, and the old fallback asked the live
  // process to switch — which aborted the running turn (omp calls `abort()`
  // before it loads the target) and then did not switch at all, leaving the
  // window dropping every snapshot for two minutes while it kept re-requesting
  // one for a session the process would never hold.
  test("the archived dead-workspace session of the freeze report lands on history", () => {
    const incident = {
      sessionFile:
        "C:\\Users\\qianp\\.omp\\agent\\sessions\\-AppData-Local-Temp-omp-ui4\\2026-09-29T00-06-16-013Z.jsonl",
      sessionCwd: "C:\\Users\\qianp\\AppData\\Local\\Temp\\omp-ui4",
      workspacePath: "D:\\WorkSpace\\ompcot",
    };
    // Spawn attempted first (that is the only way it could ever be live) …
    expect(planSessionHosting(incident)).toBe(SESSION_HOSTING.SPAWN);
    // … and when the spawn fails, read-only history — never `in-place`.
    expect(planSessionHosting({ ...incident, spawnFailed: true })).toBe(SESSION_HOSTING.HISTORY);
  });

  test("a foreign session never switches this window's process in place", () => {
    expect(plan({ sessionCwd: FOREIGN })).toBe(SESSION_HOSTING.SPAWN);
    expect(plan({ sessionCwd: FOREIGN, spawnFailed: true })).toBe(SESSION_HOSTING.HISTORY);
    expect(plan({ sessionCwd: FOREIGN, spawnAvailable: false })).toBe(SESSION_HOSTING.HISTORY);
  });

  test("a busy process gets its own process, or waits — never an in-place switch", () => {
    expect(plan({ processStreaming: true })).toBe(SESSION_HOSTING.SPAWN);
    expect(plan({ processStreaming: true, spawnFailed: true })).toBe(SESSION_HOSTING.DEFER);
    expect(plan({ processStreaming: true, spawnAvailable: false })).toBe(SESSION_HOSTING.DEFER);
  });

  test("an unknown workspace does not make a same-workspace session foreign", () => {
    expect(plan({ sessionCwd: "" })).toBe(SESSION_HOSTING.IN_PLACE);
    expect(plan({ sessionCwd: "", processStreaming: true })).toBe(SESSION_HOSTING.SPAWN);
  });

  test("a selection without a session file is history-only", () => {
    expect(plan({ sessionFile: null })).toBe(SESSION_HOSTING.HISTORY);
  });
});

describe("confirmation budget", () => {
  test("a switch that never lands stops suppressing snapshots within seconds", async () => {
    // The ceiling is also the length of the freeze a hopeless switch causes
    // (every snapshot of the foreground session is dropped while it is
    // pending), so it must stay far below the two minutes it used to be.
    expect(SWITCH_CONFIRM_BUDGET_MS).toBeLessThanOrEqual(20000);
    let sends = 0;
    const gate = new SessionSwitchGate({ sleep: async () => {} });
    gate.expect(SESSION_B);
    const confirmed = await gate.waitForConfirmation(SESSION_B, {
      sendRequest: () => {
        sends++;
      },
    });
    expect(confirmed).toBe(false);
    expect(sends * 500).toBe(SWITCH_CONFIRM_BUDGET_MS);
    expect(gate.pending).toBeNull();
  });
});
