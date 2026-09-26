// @vitest-environment node
//
// Regression tests for the child-agent (subagent / advisor) inertness guards
// in the embedded server's extension lifecycle.
//
// omp rebinds this extension module for every session it drives — including
// each subagent spawned by the task tool (the root session forwards its
// prepared extension factories and every child binds a fresh instance to its
// own ExtensionAPI; omp src/task/executor.ts emits `session_start` on the
// child's own extension runner). Before the guards, a child instance ran the
// same session_start logic as the root: it re-published the process-scoped
// globalState handler pointers, broadcast a mirror_sync snapshot of the
// SUBAGENT transcript to the WebView (hijacking the GUI into the subagent),
// overwrote the instance registry entry with the subagent's session file, and
// its later session_shutdown nulled the globals — leaving the still-running
// root session answering "No active session" (dead prompts, dead Agent Hub).
//
// These tests drive the default export with a fake omp and assert the child
// instance stays inert: no broadcasts, no auto-title, no dialog settlement.

import { describe, expect, it } from "vitest";
import embeddedServer from "./embedded-server.ts";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

type FakeOmp = {
  on: (type: string, handler: Handler) => void;
  handlers: Map<string, Handler[]>;
  pi: {
    AgentRegistry: {
      global: () => { list: () => unknown[] };
    };
  };
};

function makeFakeOmp(refs: unknown[]): FakeOmp {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    on(type, handler) {
      const list = handlers.get(type) ?? [];
      list.push(handler);
      handlers.set(type, list);
    },
    pi: {
      AgentRegistry: {
        global: () => ({ list: () => refs }),
      },
    },
  };
}

async function emit(omp: FakeOmp, type: string, event: unknown, ctx: unknown) {
  for (const handler of omp.handlers.get(type) ?? []) {
    await handler(event, ctx);
  }
}

function ctxWithSessionFile(sessionFile: string) {
  return { sessionManager: { getSessionFile: () => sessionFile } };
}

/** Fake WS client capturing every frame the extension broadcasts. */
function makeCapturingClient() {
  const sent: string[] = [];
  return {
    sent,
    frames: () => sent.map((raw) => JSON.parse(raw) as Record<string, unknown>),
    readyState: 1, // WS_OPEN
    send: (raw: string) => {
      sent.push(raw);
    },
  };
}

// The extension keeps its process-scoped state on globalThis; reach in to
// observe broadcasts and pending-UI-dialog settlement without spinning up a
// real HTTP/WS server.
type EmbeddedGlobalForTest = {
  clients: Set<unknown>;
  uiPendingRequests: Map<string, { kind?: string; resolve: (value: unknown) => void }>;
  handleCommand: unknown;
  server: unknown;
};

function embeddedGlobal(): EmbeddedGlobalForTest {
  // Instantiating the extension (re)creates the process-scoped state on
  // globalThis — do it against a throwaway fake so callers can safely read
  // and patch the shared object before driving their own instance.
  embeddedServer(makeFakeOmp([]) as never);
  return (globalThis as Record<string, unknown>).__ompcotEmbeddedServer__ as EmbeddedGlobalForTest;
}

describe("embedded server child-agent inertness", () => {
  it("a subagent session_start broadcasts nothing and binds no server", async () => {
    const g = embeddedGlobal();
    const savedClients = new Set(g.clients);
    const savedServer = g.server;
    const savedHandleCommand = g.handleCommand;
    g.server = null;
    g.handleCommand = null;
    const client = makeCapturingClient();
    g.clients = new Set([client]) as unknown as Set<unknown>;
    try {
      const subFile = `${process.cwd()}/tmp-subagent-session.jsonl`;
      const mainFile = `${process.cwd()}/tmp-main-session.jsonl`;
      const omp = makeFakeOmp([
        { id: "Main", kind: "main", sessionFile: mainFile },
        { id: "task-1", kind: "sub", sessionFile: subFile },
      ]);
      embeddedServer(omp as never);

      // The child's session_start: with the guards this must neither
      // broadcast a mirror_sync snapshot nor start / re-publish the
      // process-scoped server surfaces.
      await emit(omp, "session_start", {}, ctxWithSessionFile(subFile));
      await emit(omp, "agent_start", {}, ctxWithSessionFile(subFile));
      await emit(omp, "message_start", { message: { role: "user", content: "hi" } }, null);
      await emit(omp, "turn_start", {}, null);
      await emit(omp, "turn_start", {}, null);
      await emit(omp, "turn_end", {}, null);

      expect(client.frames().filter((f) => f.type === "mirror_sync")).toEqual([]);
      expect(client.frames().filter((f) => f.type === "event")).toEqual([]);
      expect(g.server).toBe(null);
      expect(g.handleCommand).toBe(null);
    } finally {
      g.clients = savedClients;
      g.server = savedServer;
      g.handleCommand = savedHandleCommand;
    }
  });

  it("a subagent session_shutdown never settles the root session's dialogs", async () => {
    const g = embeddedGlobal();
    const savedPending = g.uiPendingRequests;
    let settled = false;
    g.uiPendingRequests = new Map([
      [
        "req-1",
        {
          kind: "confirm",
          resolve: () => {
            settled = true;
          },
        },
      ],
    ]) as unknown as Map<string, { kind?: string; resolve: (value: unknown) => void }>;
    try {
      const subFile = `${process.cwd()}/tmp-subagent-session.jsonl`;
      const mainFile = `${process.cwd()}/tmp-main-session.jsonl`;
      const omp = makeFakeOmp([
        { id: "Main", kind: "main", sessionFile: mainFile },
        { id: "task-1", kind: "sub", sessionFile: subFile },
      ]);
      embeddedServer(omp as never);

      await emit(omp, "session_start", {}, ctxWithSessionFile(subFile));
      await emit(omp, "session_shutdown", {}, null);

      expect(settled).toBe(false);
    } finally {
      g.uiPendingRequests = savedPending;
    }
  });

  it("an advisor session_start is treated as a child too", async () => {
    const g = embeddedGlobal();
    const savedClients = new Set(g.clients);
    const savedServer = g.server;
    g.server = null;
    const client = makeCapturingClient();
    g.clients = new Set([client]) as unknown as Set<unknown>;
    try {
      const mainFile = `${process.cwd()}/tmp-main-session.jsonl`;
      const advisorFile = `${process.cwd()}/tmp-advisor-session.jsonl`;
      const omp = makeFakeOmp([
        { id: "Main", kind: "main", sessionFile: mainFile },
        { id: "adv-1", kind: "advisor", sessionFile: advisorFile },
      ]);
      embeddedServer(omp as never);

      await emit(omp, "session_start", {}, ctxWithSessionFile(advisorFile));

      expect(client.frames().filter((f) => f.type === "mirror_sync")).toEqual([]);
      expect(g.server).toBe(null);
    } finally {
      g.clients = savedClients;
      g.server = savedServer;
    }
  });
});
