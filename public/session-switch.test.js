import { describe, expect, test } from "vitest";
import { SessionSwitchGate, sameWorkspacePath } from "./session-switch.js";

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
