// @vitest-environment node

// Unit coverage for the `omp config list --json` read fallback that backs
// `get_model_configuration` when the in-process Settings instance is
// unreachable (extension context still initializing on first page load),
// and for the CLI write fallback (`omp config set`) that keeps the four
// Models & Reasoning setters working in that same situation. The pure
// helpers and the injected-surface writer core are exported for exactly
// this purpose; the end-to-end "no instance → CLI" path needs a live omp
// runtime and is exercised by the real-environment headless smoke.
import { describe, expect, it, vi } from "vitest";
import {
  createModelConfigWriter,
  extractModelConfigCliValues,
  type ModelConfigWriterDeps,
  type OmpSettingsInstanceLike,
  parseCliConfigGetJson,
  serializeCliConfigValue,
} from "./embedded-server.ts";

describe("extractModelConfigCliValues", () => {
  it("mines the model/reasoning keys out of a CLI catalog", () => {
    const values = extractModelConfigCliValues({
      defaultModel: { value: "claude-opus-4-20250514", type: "string" },
      modelRoles: {
        value: { default: "claude-opus-4-20250514", advisor: "gpt-5" },
        type: "object",
      },
      cycleOrder: { value: ["default", "slow"], type: "array" },
      modelTags: { value: { fast: ["default"] }, type: "object" },
      defaultThinkingLevel: { value: "high", type: "string" },
      // Real `omp config list --json` catalogs use DOTTED top-level keys
      // (verified against omp 18.3.0), not a nested "task" object.
      "task.agentModelOverrides": { value: { explorer: "gpt-5" }, type: "object" },
      "task.disabledAgents": { value: ["explorer"], type: "array" },
      apiKey: { type: "string", redacted: true }, // unrelated keys ignored
    });
    expect(values).toEqual({
      modelRoles: { default: "claude-opus-4-20250514", advisor: "gpt-5" },
      cycleOrder: ["default", "slow"],
      modelTags: { fast: ["default"] },
      defaultThinkingLevel: "high",
      taskAgentModelOverrides: { explorer: "gpt-5" },
      taskDisabledAgents: ["explorer"],
    });
  });

  it("degrades missing or unusable keys to null fields instead of throwing", () => {
    const empty = {
      modelRoles: null,
      cycleOrder: null,
      modelTags: null,
      defaultThinkingLevel: null,
      taskAgentModelOverrides: null,
      taskDisabledAgents: null,
    };
    expect(extractModelConfigCliValues({})).toEqual(empty);
    // Wrong entry shapes must not crash the fallback.
    expect(extractModelConfigCliValues({ modelRoles: "junk", cycleOrder: 3 })).toEqual(empty);
    // Unset values (key present, value absent) are null, not undefined.
    expect(extractModelConfigCliValues({ defaultThinkingLevel: { type: "string" } })).toEqual(
      empty,
    );
  });

  it("rejects non-object catalogs wholesale", () => {
    expect(extractModelConfigCliValues(null)).toBeNull();
    expect(extractModelConfigCliValues("nope")).toBeNull();
    expect(extractModelConfigCliValues([{ key: "modelRoles" }])).toBeNull();
  });
});

describe("serializeCliConfigValue", () => {
  // VALUE form verified against omp 18.3.0 in an isolated HOME: records and
  // arrays must be JSON text; scalar strings must be BARE (a JSON-quoted
  // scalar keeps its quotes and fails schema validation).
  it("serializes records and arrays as JSON text", () => {
    expect(serializeCliConfigValue({ default: "gpt-5" })).toBe('{"default":"gpt-5"}');
    expect(serializeCliConfigValue(["explorer", "writer"])).toBe('["explorer","writer"]');
    expect(serializeCliConfigValue({})).toBe("{}");
    expect(serializeCliConfigValue([])).toBe("[]");
  });

  it("passes scalar strings through bare and stringifies other primitives", () => {
    expect(serializeCliConfigValue("low")).toBe("low");
    expect(serializeCliConfigValue(5)).toBe("5");
    expect(serializeCliConfigValue(true)).toBe("true");
  });
});

describe("parseCliConfigGetJson", () => {
  it("unwraps the { key, value, type } envelope to the bare value", () => {
    expect(
      parseCliConfigGetJson('{"key":"modelRoles","value":{"default":"gpt-5"},"type":"record"}'),
    ).toEqual({ default: "gpt-5" });
    expect(
      parseCliConfigGetJson('{"key":"task.disabledAgents","value":["a"],"type":"array"}'),
    ).toEqual(["a"]);
  });

  it("throws on non-JSON output or an unexpected envelope", () => {
    expect(() => parseCliConfigGetJson("not json")).toThrow();
    expect(() => parseCliConfigGetJson('{"key":"modelRoles","type":"record"}')).toThrow();
    expect(() => parseCliConfigGetJson('["unexpected"]')).toThrow();
  });
});

describe("createModelConfigWriter", () => {
  interface InstanceState {
    values: Map<string, unknown>;
    setCalls: Array<{ key: string; value: unknown }>;
    overrideCalls: Array<{ key: string; value: unknown }>;
    flushCalls: number;
    setImpl?: (key: string, value: unknown) => void;
  }

  function makeInstance(state: InstanceState): OmpSettingsInstanceLike {
    return {
      get: (key: string) => state.values.get(key),
      set: (key: string, value: unknown) =>
        state.setImpl?.(key, value) ?? state.setCalls.push({ key, value }),
      override: (key: string, value: unknown) => state.overrideCalls.push({ key, value }),
      flush: () => {
        state.flushCalls += 1;
      },
    };
  }

  function makeWriter(
    instance: OmpSettingsInstanceLike | null,
    execImpl: (args: string[]) => Promise<string> = async () => "",
  ) {
    const execCli = vi.fn(execImpl);
    const deps: ModelConfigWriterDeps = {
      getInstance: () => instance,
      execCli,
      onError: () => {}, // silence expected diagnostic logs in tests
    };
    return { writer: createModelConfigWriter(deps), execCli };
  }

  it("writes through the CLI (JSON text) when no in-process instance exists", async () => {
    const { writer, execCli } = makeWriter(null);
    await writer.writeStructuredSetting("modelRoles", { default: "gpt-5" });
    expect(execCli).toHaveBeenCalledWith(["config", "set", "modelRoles", '{"default":"gpt-5"}']);

    await writer.writeStructuredSetting("defaultThinkingLevel", "low");
    expect(execCli).toHaveBeenLastCalledWith(["config", "set", "defaultThinkingLevel", "low"]);
  });

  it("prefers in-process set() + flush() and does not shell out", async () => {
    const state: InstanceState = {
      values: new Map(),
      setCalls: [],
      overrideCalls: [],
      flushCalls: 0,
    };
    const { writer, execCli } = makeWriter(makeInstance(state));
    await writer.writeStructuredSetting("modelRoles", { default: "gpt-5" });
    expect(state.setCalls).toEqual([{ key: "modelRoles", value: { default: "gpt-5" } }]);
    expect(state.flushCalls).toBe(1);
    expect(execCli).not.toHaveBeenCalled();
  });

  it("falls back to the CLI when in-process set() throws", async () => {
    const state: InstanceState = {
      values: new Map(),
      setCalls: [],
      overrideCalls: [],
      flushCalls: 0,
      setImpl: () => {
        throw new Error("schema rejected");
      },
    };
    const { writer, execCli } = makeWriter(makeInstance(state));
    await writer.writeStructuredSetting("task.disabledAgents", ["explorer"]);
    expect(execCli).toHaveBeenCalledWith(["config", "set", "task.disabledAgents", '["explorer"]']);
  });

  it("errors naming BOTH failures only when both paths fail", async () => {
    const state: InstanceState = {
      values: new Map(),
      setCalls: [],
      overrideCalls: [],
      flushCalls: 0,
      setImpl: () => {
        throw new Error("schema rejected");
      },
    };
    const { writer } = makeWriter(makeInstance(state), async () => {
      throw new Error("spawn failed");
    });
    await expect(writer.writeStructuredSetting("modelRoles", {})).rejects.toThrow(
      /in-process Settings write failed \(schema rejected\).*omp config set.*fallback failed too \(spawn failed\)/,
    );
  });

  it("reads via the instance when reachable, else via `config get`", async () => {
    const state: InstanceState = {
      values: new Map([["modelRoles", { default: "gpt-5" }]]),
      setCalls: [],
      overrideCalls: [],
      flushCalls: 0,
    };
    const inProcess = makeWriter(makeInstance(state));
    expect(await inProcess.writer.readSettingValue("modelRoles")).toEqual({ default: "gpt-5" });
    expect(inProcess.execCli).not.toHaveBeenCalled();

    const cli = makeWriter(
      null,
      async () => '{"key":"modelRoles","value":{"plan":"zai/glm-5.3"},"type":"record"}',
    );
    expect(await cli.writer.readSettingValue("modelRoles")).toEqual({ plan: "zai/glm-5.3" });
    expect(cli.execCli).toHaveBeenCalledWith(["config", "get", "modelRoles", "--json"]);
  });

  it("a failed CLI read rejects before any write (merge never wipes siblings)", async () => {
    const { writer, execCli } = makeWriter(null, async () => {
      throw new Error("read failed");
    });
    await expect(writer.readSettingValue("modelRoles")).rejects.toThrow("read failed");
    // Only the read attempt ran — no `config set` was ever issued.
    expect(execCli).toHaveBeenCalledTimes(1);
    expect(execCli.mock.calls[0][0]).toEqual(["config", "get", "modelRoles", "--json"]);
  });

  it("writeTaskAgentSetting mirrors the runtime-override layer with an instance", async () => {
    const state: InstanceState = {
      values: new Map(),
      setCalls: [],
      overrideCalls: [],
      flushCalls: 0,
    };
    const { writer, execCli } = makeWriter(makeInstance(state));
    await writer.writeTaskAgentSetting("task.disabledAgents", ["explorer"]);
    expect(state.setCalls).toEqual([{ key: "task.disabledAgents", value: ["explorer"] }]);
    expect(state.overrideCalls).toEqual([{ key: "task.disabledAgents", value: ["explorer"] }]);
    expect(execCli).not.toHaveBeenCalled();
  });

  it("writeTaskAgentSetting persists via CLI without an instance (no override mirror, no throw)", async () => {
    const { writer, execCli } = makeWriter(null);
    await writer.writeTaskAgentSetting("task.agentModelOverrides", { explorer: "gpt-5" });
    expect(execCli).toHaveBeenCalledWith([
      "config",
      "set",
      "task.agentModelOverrides",
      '{"explorer":"gpt-5"}',
    ]);
  });
});
