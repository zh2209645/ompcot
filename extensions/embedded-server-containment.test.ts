// @vitest-environment node

import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  containedInterval,
  containedTimeout,
  FORWARDED_EVENT_TYPES,
  installRejectionContainment,
  isOwnRejection,
} from "./embedded-server.ts";

/**
 * The timer helpers are exercised against stubbed globals rather than real
 * clocks: what matters is *which* scheduler is used and whether the callback
 * they hand it can take the process down, and both are observable by invoking
 * the captured callback directly.
 */
type Captured = { callback: (...args: unknown[]) => void; ms: number | undefined };

function stubGlobalTimer(name: "setTimeout" | "setInterval"): {
  captured: Captured[];
  unref: Mock;
} {
  const captured: Captured[] = [];
  const unref = vi.fn();
  vi.stubGlobal(
    name,
    vi.fn((callback: (...args: unknown[]) => void, ms?: number) => {
      captured.push({ callback, ms });
      return { unref } as unknown as NodeJS.Timeout;
    }),
  );
  return { captured, unref };
}

const failures: { kind: string; error: unknown }[] = [];

function recordFailure(kind: "interval" | "timeout", error: unknown): void {
  failures.push({ kind, error });
}

function anError(message: string): Error {
  return new Error(message);
}

afterEach(() => {
  vi.unstubAllGlobals();
  failures.length = 0;
});

describe("contained timers", () => {
  it("runs a raw timer callback's throw into the failure sink, not the process", () => {
    const { captured, unref } = stubGlobalTimer("setTimeout");
    containedTimeout(
      null,
      () => {
        throw anError("registry rewrite exploded");
      },
      5,
      recordFailure,
    );
    expect(captured).toHaveLength(1);
    expect(captured[0]?.ms).toBe(5);
    // The guarded callback is what the scheduler holds: it cannot throw, so a
    // callback failure can never reach the process-level `uncaughtException`
    // handler that treats it as fatal.
    expect(() => captured[0]?.callback()).not.toThrow();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("timeout");
    expect((failures[0]?.error as Error).message).toBe("registry rewrite exploded");
    // Never pins the event loop: the process may exit while a timer is pending.
    expect(unref).toHaveBeenCalled();
  });

  it("uses the host's managed timer when the ctx exposes it", () => {
    const { captured } = stubGlobalTimer("setTimeout");
    const managed: Captured[] = [];
    const handle = containedInterval(
      {
        setInterval: (callback: () => void, ms?: number) => {
          managed.push({ callback, ms });
          return {};
        },
      },
      () => {
        throw anError("audit exploded");
      },
      3000,
      recordFailure,
    );
    // The host surface owns the handle (it clears it on session teardown)...
    expect(managed).toHaveLength(1);
    expect(managed[0]?.ms).toBe(3000);
    expect(captured).toHaveLength(0);
    expect(handle).toEqual({});
    // ...and the callback it runs is still the guarded one.
    expect(() => managed[0]?.callback()).not.toThrow();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("interval");
  });

  it("falls back to a raw timer when the host surface is missing or rejects the call", () => {
    const { captured } = stubGlobalTimer("setInterval");
    const ticks: number[] = [];
    // An older build without the surface.
    containedInterval(null, () => ticks.push(1), 10, recordFailure);
    // A present-but-unusable surface (a ctx being torn down mid-swap).
    containedInterval(
      {
        setInterval: () => {
          throw anError("stale ctx");
        },
      },
      () => ticks.push(2),
      10,
      recordFailure,
    );
    expect(captured).toHaveLength(2);
    expect(captured[0]?.ms).toBe(10);
    for (const entry of captured) entry.callback();
    expect(ticks).toEqual([1, 2]);
    // A rejected host call is not a callback failure: nothing ran on it.
    expect(failures).toHaveLength(0);
  });
});

describe("isOwnRejection", () => {
  it("claims a rejection whose stack names this bundle", () => {
    const err = anError("boom");
    err.stack = "Error: boom\n    at file:///D:/app/extensions/embedded-server.mjs:12:3";
    expect(isOwnRejection(err, "embedded-server")).toBe(true);
  });

  it("leaves a rejection it cannot prove is ours to omp's fatal path", () => {
    const foreign = anError("host internals");
    foreign.stack = "Error: host internals\n    at file:///opt/omp/dist/cli.js:1:1";
    expect(isOwnRejection(foreign, "embedded-server")).toBe(false);
    // No stack, non-errors, empty marker: all unproven.
    expect(isOwnRejection("boom", "embedded-server")).toBe(false);
    expect(isOwnRejection(anError("boom"), "")).toBe(false);
  });
});

describe("installRejectionContainment", () => {
  it("marks only this bundle's rejections, ahead of the host's handler", () => {
    const listeners: { event: string; listener: (reason: unknown) => void }[] = [];
    const contained: unknown[] = [];
    const installed = installRejectionContainment({
      marker: "embedded-server",
      host: {
        prependListener: (event, listener) => {
          // `prependListener` is the whole point: the host registered its fatal
          // handler at startup, so appending ours would run too late to mark.
          listeners.push({ event, listener });
        },
      },
      onContained: (reason) => contained.push(reason),
    });
    expect(installed).toBe(true);
    expect(listeners).toHaveLength(1);
    expect(listeners[0]?.event).toBe("unhandledRejection");
    const mine = anError("boom");
    mine.stack = "Error: boom\n    at file:///D:/app/extensions/embedded-server.mjs:9:1";
    const theirs = anError("host internals");
    theirs.stack = "Error: host internals\n    at file:///opt/omp/dist/cli.js:1:1";
    listeners[0]?.listener(mine);
    expect(contained).toEqual([mine]);
    // The marker is what the host's own handler reads (`Symbol.for`, so it
    // crosses bundle instances) — without it the process still exits.
    expect(Reflect.get(mine, Symbol.for("omp.expectedCleanupError"))).toBe(true);
    listeners[0]?.listener(theirs);
    expect(contained).toEqual([mine]);
    expect(Reflect.get(theirs, Symbol.for("omp.expectedCleanupError"))).toBeUndefined();
  });

  it("reports an unavailable seam instead of failing", () => {
    const reasons: unknown[] = [];
    const installed = installRejectionContainment({
      marker: "embedded-server",
      host: {},
      onUnavailable: (error) => reasons.push(error),
    });
    expect(installed).toBe(false);
    // No host handler at all: installing the first listener would suppress the
    // runtime's default reporting for every rejection, ours or not.
    const lonely = installRejectionContainment({
      marker: "embedded-server",
      host: { prependListener: () => {}, listenerCount: () => 0 },
      onUnavailable: (error) => reasons.push(error),
    });
    expect(lonely).toBe(false);
    expect(reasons).toHaveLength(2);
  });

  it("installs ahead of the host's handler once one is registered", () => {
    const listeners: string[] = [];
    const installed = installRejectionContainment({
      marker: "embedded-server",
      host: {
        prependListener: () => listeners.push("ours"),
        listenerCount: () => 1,
      },
    });
    expect(installed).toBe(true);
    expect(listeners).toEqual(["ours"]);
  });
});

describe("forwarded event contract", () => {
  it("forwards the events the frontend switch consumes, verbatim", () => {
    // The list *is* the wire contract with `public/app.js`: each type is
    // broadcast as `{type:"event", event:{type, ...payload}}`. These are the
    // three answered only by this lane (the transcript's tool/message identity
    // and the streaming snapshot all ride it), plus the account-loss frame that
    // had no producer before omp 18.3.1 made sign-outs visible.
    for (const type of [
      "agent_start",
      "agent_end",
      "message_update",
      "tool_execution_end",
      "session_branch",
      "credential_disabled",
    ]) {
      expect(FORWARDED_EVENT_TYPES).toContain(type);
    }
    // A duplicate would subscribe the same event twice and double every frame.
    expect(new Set(FORWARDED_EVENT_TYPES).size).toBe(FORWARDED_EVENT_TYPES.length);
  });
});
