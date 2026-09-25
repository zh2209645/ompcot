import { afterEach, describe, expect, test, vi } from "vitest";
import { createAgentSettings } from "./agent-settings.js";
import { pageForKey } from "./agent-settings-pages.js";

function makeCatalog() {
  return {
    agentRoot: "/home/u/.omp/agent",
    source: "inprocess",
    settings: [
      {
        key: "model.temperature",
        value: 0.7,
        type: "number",
        description: "Sampling temperature",
        redacted: false,
      },
      {
        key: "model.name",
        value: "sonnet",
        type: "string",
        description: "Default model",
        redacted: false,
      },
      {
        key: "tools.bash.enabled",
        value: true,
        type: "boolean",
        description: "Allow bash tool",
        redacted: false,
      },
      { key: "theme", value: "dark", type: "enum", description: "Color theme", redacted: false },
      {
        key: "permissions.allow",
        value: ["ls", "cat"],
        type: "array",
        description: "Extra allowed tools",
        redacted: false,
      },
      { key: "api.token", value: null, type: "string", description: "API token", redacted: true },
    ],
  };
}

function defaultFetchJson(catalog) {
  return vi.fn(async (_url, options = {}) => {
    if (options.method === "PUT") {
      return { ok: true, key: options.body?.key, value: options.body?.value };
    }
    return catalog;
  });
}

function setup({ catalog = makeCatalog(), fetchJson = defaultFetchJson(catalog) } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let frameCb = null;
  const unsubscribe = vi.fn(() => {
    frameCb = null;
  });
  const wsSubscribe = vi.fn((cb) => {
    frameCb = cb;
    return unsubscribe;
  });
  const settings = createAgentSettings({ fetchJson, wsSubscribe });
  settings.attach(container);
  return {
    settings,
    container,
    fetchJson,
    unsubscribe,
    pushFrame: (frame) => frameCb?.(frame),
  };
}

function rowOf(container, key) {
  return container.querySelector(`[data-agent-setting-key="${key}"]`);
}

function controlOf(container, key) {
  return rowOf(container, key)?.querySelector("input, textarea, button");
}

function statusOf(container, key) {
  return rowOf(container, key)?.querySelector(".agent-setting-status");
}

function putCalls(fetchJson) {
  return fetchJson.mock.calls.filter(([, options]) => options?.method === "PUT");
}

function resetButtonOf(container, key) {
  return rowOf(container, key)?.querySelector(".agent-setting-reset");
}

function getCalls(fetchJson) {
  return fetchJson.mock.calls.filter(
    ([url, options]) => url === "/api/agent-settings" && !options?.method,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("createAgentSettings rendering", () => {
  test("groups fields by top-level key prefix, unprefixed keys under general", async () => {
    const { settings, container } = setup();
    await settings.load();

    const titles = Array.from(
      container.querySelectorAll(".agent-settings-group .settings-section-title"),
    ).map((el) => el.textContent);
    expect(titles).toEqual(["model", "tools", "general", "permissions"]);

    const generalSection = container.querySelector('.agent-settings-group[data-group="general"]');
    expect(generalSection.contains(rowOf(container, "theme"))).toBe(true);
    expect(
      rowOf(container, "model.temperature").closest(".agent-settings-group").dataset.group,
    ).toBe("model");
  });

  test("maps setting types to matching controls", async () => {
    const { settings, container } = setup();
    await settings.load();

    const toggle = controlOf(container, "tools.bash.enabled");
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.classList.contains("settings-toggle")).toBe(true);
    expect(toggle.classList.contains("on")).toBe(true);

    const number = controlOf(container, "model.temperature");
    expect(number.tagName).toBe("INPUT");
    expect(number.type).toBe("number");
    expect(number.value).toBe("0.7");

    const text = controlOf(container, "model.name");
    expect(text.tagName).toBe("INPUT");
    expect(text.type).toBe("text");
    expect(text.value).toBe("sonnet");

    const json = controlOf(container, "permissions.allow");
    expect(json.tagName).toBe("TEXTAREA");
    expect(json.value).toBe(JSON.stringify(["ls", "cat"], null, 2));
  });

  test("enum fields render a free-text input with a hinted description", async () => {
    const { settings, container } = setup();
    await settings.load();

    const enumInput = controlOf(container, "theme");
    expect(enumInput.tagName).toBe("INPUT");
    expect(enumInput.type).toBe("text");
    expect(rowOf(container, "theme").querySelector(".settings-label-sub").textContent).toBe(
      "Color theme (free text)",
    );
  });

  test("skips redacted keys entirely", async () => {
    const { settings, container } = setup();
    await settings.load();

    expect(rowOf(container, "api.token")).toBeNull();
  });

  test("shows the agentRoot caption with the source label", async () => {
    const { settings, container } = setup();
    await settings.load();

    expect(container.querySelector(".agent-settings-caption").textContent).toBe(
      "Settings are stored in /home/u/.omp/agent (source: in-process).",
    );
  });

  test("renders a load error with retry", async () => {
    const catalog = makeCatalog();
    let fail = true;
    const fetchJson = vi.fn(async (_url, options = {}) => {
      if (options.method === "PUT") return { ok: true };
      if (fail) throw new Error("socket hang up");
      return catalog;
    });
    const { settings, container } = setup({ fetchJson });

    await settings.load();
    expect(container.querySelector(".agent-settings-error").classList.contains("hidden")).toBe(
      false,
    );
    expect(container.querySelector(".agent-settings-error").textContent).toContain(
      "socket hang up",
    );

    fail = false;
    container.querySelector(".agent-settings-error button").click();
    await vi.waitFor(() => {
      expect(rowOf(container, "model.temperature")).not.toBeNull();
    });
  });
});

describe("createAgentSettings filtering", () => {
  test("filters rows by key or description substring and hides empty groups", async () => {
    const { settings, container } = setup();
    await settings.load();

    const filter = container.querySelector(".agent-settings-filter");
    filter.value = "temperature";
    filter.dispatchEvent(new Event("input", { bubbles: true }));

    expect(rowOf(container, "model.temperature").classList.contains("hidden")).toBe(false);
    expect(rowOf(container, "model.name").classList.contains("hidden")).toBe(true);
    expect(
      container
        .querySelector('.agent-settings-group[data-group="tools"]')
        .classList.contains("hidden"),
    ).toBe(true);
    expect(
      container
        .querySelector('.agent-settings-group[data-group="general"]')
        .classList.contains("hidden"),
    ).toBe(true);

    filter.value = "bash";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    expect(rowOf(container, "tools.bash.enabled").classList.contains("hidden")).toBe(false);
    expect(rowOf(container, "model.temperature").classList.contains("hidden")).toBe(true);
  });
});

describe("createAgentSettings saving", () => {
  test("debounces each field save by 600ms and PUTs the parsed value", async () => {
    vi.useFakeTimers();
    const { settings, container, fetchJson } = setup();
    await settings.load();

    const input = controlOf(container, "model.temperature");
    input.value = "0.9";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    await vi.advanceTimersByTimeAsync(599);
    expect(putCalls(fetchJson)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(putCalls(fetchJson)).toHaveLength(1);
    const [url, options] = putCalls(fetchJson)[0];
    expect(url).toBe("/api/agent-settings");
    expect(options).toEqual({ method: "PUT", body: { key: "model.temperature", value: 0.9 } });
    expect(statusOf(container, "model.temperature").textContent).toBe("Saved");
  });

  test("string edits save raw text after the debounce", async () => {
    vi.useFakeTimers();
    const { settings, container, fetchJson } = setup();
    await settings.load();

    const input = controlOf(container, "model.name");
    input.value = "opus";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);

    expect(putCalls(fetchJson)[0][1].body).toEqual({ key: "model.name", value: "opus" });
  });

  test("boolean toggles save the flipped value", async () => {
    vi.useFakeTimers();
    const { settings, container, fetchJson } = setup();
    await settings.load();

    controlOf(container, "tools.bash.enabled").click();
    await vi.advanceTimersByTimeAsync(600);

    expect(putCalls(fetchJson)[0][1].body).toEqual({ key: "tools.bash.enabled", value: false });
  });

  test("invalid JSON in a JSON field blocks the request with an inline error", async () => {
    vi.useFakeTimers();
    const { settings, container, fetchJson } = setup();
    await settings.load();

    const textarea = controlOf(container, "permissions.allow");
    textarea.value = "{oops";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);

    expect(putCalls(fetchJson)).toHaveLength(0);
    const status = statusOf(container, "permissions.allow");
    expect(status.dataset.tone).toBe("error");
    expect(status.textContent).toContain("Invalid JSON");
  });

  test("a failed PUT renders the error and reverts an optimistic toggle", async () => {
    vi.useFakeTimers();
    const catalog = makeCatalog();
    const fetchJson = vi.fn(async (_url, options = {}) => {
      if (options.method === "PUT") throw new Error("disk full");
      return catalog;
    });
    const { settings, container } = setup({ fetchJson });
    await settings.load();

    const toggle = controlOf(container, "tools.bash.enabled");
    toggle.click();
    await vi.advanceTimersByTimeAsync(600);

    const status = statusOf(container, "tools.bash.enabled");
    expect(status.dataset.tone).toBe("error");
    expect(status.textContent).toContain("disk full");
    expect(toggle.classList.contains("on")).toBe(true); // reverted to saved value
  });

  test("saving one field does not block saving another", async () => {
    vi.useFakeTimers();
    const catalog = makeCatalog();
    let resolveFirst;
    const fetchJson = vi.fn(async (_url, options = {}) => {
      if (options.method === "PUT" && options.body?.key === "model.name") {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      if (options.method === "PUT")
        return { ok: true, key: options.body.key, value: options.body.value };
      return catalog;
    });
    const { settings, container } = setup({ fetchJson });
    await settings.load();

    const nameInput = controlOf(container, "model.name");
    nameInput.value = "opus";
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    const tempInput = controlOf(container, "model.temperature");
    tempInput.value = "0.2";
    tempInput.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600);

    // temperature saved fine while model.name is still in flight
    expect(statusOf(container, "model.temperature").textContent).toBe("Saved");
    expect(statusOf(container, "model.name").textContent).toBe("Saving...");

    resolveFirst({ ok: true, key: "model.name", value: "opus" });
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf(container, "model.name").textContent).toBe("Saved");
  });
});

describe("createAgentSettings reset to default", () => {
  test("POSTs the key to /api/agent-settings/reset, patches the single row, and leaves other rows untouched", async () => {
    const before = makeCatalog();
    const after = makeCatalog();
    after.settings = before.settings.map((entry) =>
      entry.key === "model.temperature" ? { ...entry, value: 0.5 } : entry,
    );
    let servedGets = 0;
    const fetchJson = vi.fn(async (_url, options = {}) => {
      if (options.method === "PUT") {
        return { ok: true, key: options.body?.key, value: options.body?.value };
      }
      if (options.method === "POST") {
        expect(_url).toBe("/api/agent-settings/reset");
        return { ok: true, key: options.body?.key };
      }
      servedGets += 1;
      return servedGets === 1 ? before : after;
    });
    const { settings, container, fetchJson: fn } = setup({ fetchJson });
    await settings.load();
    const tempInput = controlOf(container, "model.temperature");
    expect(tempInput.value).toBe("0.7");

    // Another row carries an unsaved edit that must survive the reset (F18b).
    const nameInput = controlOf(container, "model.name");
    nameInput.value = "opus";

    const resetBtn = resetButtonOf(container, "model.temperature");
    expect(resetBtn.title).toBe("Reset to default");
    resetBtn.click();
    await vi.waitFor(() => {
      expect(tempInput.value).toBe("0.5");
    });

    const postCalls = fn.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0][0]).toBe("/api/agent-settings/reset");
    expect(postCalls[0][1]).toEqual({ method: "POST", body: { key: "model.temperature" } });

    const status = statusOf(container, "model.temperature");
    expect(status.dataset.tone).toBe("ok");
    expect(status.textContent).toBe("Saved");

    // The reset row was patched IN PLACE — same element, no rebuild...
    expect(controlOf(container, "model.temperature")).toBe(tempInput);
    // ...and the other row's unsaved edit is intact (F18b: no load() rebuild
    // cancelling unrelated pending edits).
    expect(controlOf(container, "model.name")).toBe(nameInput);
    expect(nameInput.value).toBe("opus");

    // The initial load plus the single-row refresh — still exactly two GETs.
    expect(getCalls(fn)).toHaveLength(2);
  });

  test("shows an error status and skips the reload when the reset fails", async () => {
    const fetchJson = vi.fn(async (_url, options = {}) => {
      if (options.method === "POST") throw new Error("permission denied");
      return makeCatalog();
    });
    const { settings, container } = setup({ fetchJson });
    await settings.load();

    resetButtonOf(container, "model.name").click();
    await vi.waitFor(() => {
      expect(statusOf(container, "model.name").dataset.tone).toBe("error");
    });
    expect(statusOf(container, "model.name").textContent).toContain("permission denied");
    // No catalog reload after a failed reset — value stays as-is.
    expect(getCalls(fetchJson)).toHaveLength(1);
    expect(controlOf(container, "model.name").value).toBe("sonnet");
  });

  test("cancels a pending debounced edit so the reset is not overwritten", async () => {
    vi.useFakeTimers();
    const fetchJson = vi.fn(async (_url, options = {}) => {
      if (options.method === "PUT") return { ok: true };
      if (options.method === "POST") return { ok: true, key: options.body?.key };
      return makeCatalog();
    });
    const { settings, container, fetchJson: fn } = setup({ fetchJson });
    await settings.load();

    const input = controlOf(container, "model.name");
    input.value = "opus";
    input.dispatchEvent(new Event("input", { bubbles: true })); // debounce pending
    resetButtonOf(container, "model.name").click();
    await vi.advanceTimersByTimeAsync(2000);

    expect(putCalls(fn)).toHaveLength(0); // the debounced PUT never fires
    const postCalls = fn.mock.calls.filter(([, options]) => options?.method === "POST");
    expect(postCalls).toHaveLength(1);
  });

  // ── F18: reset races ────────────────────────────────────────────────────

  test("F18a: reset waits for the row's in-flight save before POSTing", async () => {
    vi.useFakeTimers();
    const catalog = makeCatalog();
    let resolvePut;
    const order = [];
    const fetchJson = vi.fn(async (_url, options = {}) => {
      order.push(options.method || "GET");
      if (options.method === "PUT" && options.body?.key === "model.name") {
        return new Promise((resolve) => {
          resolvePut = resolve;
        });
      }
      if (options.method === "PUT") return { ok: true };
      if (options.method === "POST") {
        expect(_url).toBe("/api/agent-settings/reset");
        return { ok: true, key: options.body?.key };
      }
      return catalog;
    });
    const { settings, container } = setup({ fetchJson });
    await settings.load();

    const input = controlOf(container, "model.name");
    input.value = "opus";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600); // PUT for model.name now in flight

    resetButtonOf(container, "model.name").click();
    const flush = async () => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
    };
    await flush();
    // The reset is parked behind the in-flight PUT — no POST yet.
    expect(order).toEqual(["GET", "PUT"]);

    resolvePut({ ok: true, key: "model.name", value: "opus" });
    await flush();
    // The PUT settled strictly before the reset POST, then the single-row
    // refresh GET followed.
    expect(order).toEqual(["GET", "PUT", "POST", "GET"]);
    expect(statusOf(container, "model.name").dataset.tone).toBe("ok");
  });

  test("F18b: reset patches only its row — other rows' pending saves still fire", async () => {
    vi.useFakeTimers();
    const catalog = makeCatalog();
    const fetchJson = vi.fn(async (_url, options = {}) => {
      if (options.method === "PUT") {
        return { ok: true, key: options.body?.key, value: options.body?.value };
      }
      if (options.method === "POST") return { ok: true, key: options.body?.key };
      return catalog;
    });
    const { settings, container, fetchJson: fn } = setup({ fetchJson });
    await settings.load();

    const nameInput = controlOf(container, "model.name");
    nameInput.value = "opus";
    nameInput.dispatchEvent(new Event("input", { bubbles: true })); // debounce pending

    const tempInput = controlOf(container, "model.temperature");
    resetButtonOf(container, "model.temperature").click();
    const flush = async () => {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
    };
    await flush();

    // Reset refreshed its own row in place...
    expect(controlOf(container, "model.temperature")).toBe(tempInput);
    expect(statusOf(container, "model.temperature").dataset.tone).toBe("ok");
    // ...while the other row's debounced edit is intact and still pending.
    expect(controlOf(container, "model.name")).toBe(nameInput);
    expect(nameInput.value).toBe("opus");
    expect(putCalls(fn)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(600);
    const puts = putCalls(fn);
    expect(puts).toHaveLength(1); // not cancelled by the reset
    expect(puts[0][1].body).toEqual({ key: "model.name", value: "opus" });
  });
});

describe("createAgentSettings live updates", () => {
  test("updates an idle field from a settings_changed frame", async () => {
    const { settings, container, pushFrame } = setup();
    await settings.load();

    pushFrame({ type: "settings_changed", path: "model.name", value: "opus" });
    expect(controlOf(container, "model.name").value).toBe("opus");
  });

  test("ignores frames that are not settings_changed", async () => {
    const { settings, container, pushFrame } = setup();
    await settings.load();

    pushFrame({ type: "state", path: "model.name", value: "opus" });
    expect(controlOf(container, "model.name").value).toBe("sonnet");
  });

  test("does not clobber a focused field", async () => {
    const { settings, container, pushFrame } = setup();
    await settings.load();

    const input = controlOf(container, "model.name");
    input.focus();
    pushFrame({ type: "settings_changed", path: "model.name", value: "opus" });
    expect(input.value).toBe("sonnet");

    input.blur();
    pushFrame({ type: "settings_changed", path: "model.name", value: "opus" });
    expect(input.value).toBe("opus");
  });

  test("does not clobber a field with an in-flight save", async () => {
    vi.useFakeTimers();
    const catalog = makeCatalog();
    let resolvePut;
    const fetchJson = vi.fn(async (_url, options = {}) => {
      if (options.method === "PUT") {
        return new Promise((resolve) => {
          resolvePut = resolve;
        });
      }
      return catalog;
    });
    const { settings, container, pushFrame } = setup({ fetchJson });
    await settings.load();

    const input = controlOf(container, "model.name");
    input.value = "opus";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(600); // PUT now in flight

    input.blur(); // not focused — in-flight save is the only guard left
    pushFrame({ type: "settings_changed", path: "model.name", value: "haiku" });
    expect(input.value).toBe("opus");

    resolvePut({ ok: true, key: "model.name", value: "opus" });
    await vi.advanceTimersByTimeAsync(0);
    pushFrame({ type: "settings_changed", path: "model.name", value: "haiku" });
    expect(input.value).toBe("haiku");
  });

  test("does not clobber a field with a pending debounced edit", async () => {
    vi.useFakeTimers();
    const { settings, container, pushFrame } = setup();
    await settings.load();

    const input = controlOf(container, "model.name");
    input.value = "opus";
    input.dispatchEvent(new Event("input", { bubbles: true })); // debounce running
    input.blur();

    pushFrame({ type: "settings_changed", path: "model.name", value: "haiku" });
    expect(input.value).toBe("opus");
  });
});

describe("createAgentSettings teardown", () => {
  test("destroy clears the DOM, timers and the WS subscription", async () => {
    vi.useFakeTimers();
    const { settings, container, fetchJson, pushFrame, unsubscribe } = setup();
    await settings.load();

    const input = controlOf(container, "model.temperature");
    input.value = "0.9";
    input.dispatchEvent(new Event("input", { bubbles: true })); // pending debounce

    settings.destroy();
    expect(container.children).toHaveLength(0);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(putCalls(fetchJson)).toHaveLength(0);

    // Late frame after destroy is a no-op, not a crash.
    pushFrame({ type: "settings_changed", path: "model.name", value: "opus" });
  });
});

describe("createAgentSettings page mode", () => {
  function setupPaged({
    catalog = makeCatalog(),
    fetchJson = defaultFetchJson(catalog),
    onPageSetChanged,
  } = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const settings = createAgentSettings({
      fetchJson,
      wsSubscribe: () => () => {},
      getPageId: pageForKey,
      onPageSetChanged,
    });
    settings.attach(container);
    return { settings, container, fetchJson };
  }

  test("tags each group with its sub-page and reports the non-empty page set", async () => {
    const onPageSetChanged = vi.fn();
    const { settings, container } = setupPaged({ onPageSetChanged });
    await settings.load();

    // model.*, tools.*, theme (unprefixed → appearance), permissions.* (advanced)
    expect(onPageSetChanged).toHaveBeenCalledWith(["model", "tools", "appearance", "advanced"]);

    const modelGroup = container.querySelector('.agent-settings-group[data-group="model"]');
    expect(modelGroup.dataset.page).toBe("model");
    expect(modelGroup.contains(rowOf(container, "model.temperature"))).toBe(true);

    // The unprefixed `theme` key groups under "general" but maps to appearance.
    const generalGroups = container.querySelectorAll('.agent-settings-group[data-group="general"]');
    expect(generalGroups).toHaveLength(1);
    expect(generalGroups[0].dataset.page).toBe("appearance");
    expect(generalGroups[0].contains(rowOf(container, "theme"))).toBe(true);

    const permissionsGroup = container.querySelector(
      '.agent-settings-group[data-group="permissions"]',
    );
    expect(permissionsGroup.dataset.page).toBe("advanced");
  });

  test("setActivePage shows only that page's groups", async () => {
    const { settings, container } = setupPaged();
    await settings.load();

    settings.setActivePage("model");
    expect(
      rowOf(container, "model.temperature")
        .closest(".agent-settings-group")
        .classList.contains("hidden"),
    ).toBe(false);
    expect(
      container
        .querySelector('.agent-settings-group[data-group="tools"]')
        .classList.contains("hidden"),
    ).toBe(true);
    expect(
      container
        .querySelector('.agent-settings-group[data-group="general"]')
        .classList.contains("hidden"),
    ).toBe(true);

    settings.setActivePage(null);
    expect(
      container
        .querySelector('.agent-settings-group[data-group="tools"]')
        .classList.contains("hidden"),
    ).toBe(false);
  });

  test("page filtering composes with the filter query", async () => {
    const { settings, container } = setupPaged();
    await settings.load();

    const filter = container.querySelector(".agent-settings-filter");
    filter.value = "bash"; // tools.* key
    filter.dispatchEvent(new Event("input", { bubbles: true }));

    settings.setActivePage("model");
    expect(
      container
        .querySelector('.agent-settings-group[data-group="tools"]')
        .classList.contains("hidden"),
    ).toBe(true);

    settings.setActivePage("tools");
    expect(
      container
        .querySelector('.agent-settings-group[data-group="tools"]')
        .classList.contains("hidden"),
    ).toBe(false);
    expect(rowOf(container, "tools.bash.enabled").classList.contains("hidden")).toBe(false);
  });

  test("reports a null page set when the load fails", async () => {
    const onPageSetChanged = vi.fn();
    const fetchJson = vi.fn(async () => {
      throw new Error("socket hang up");
    });
    const { settings } = setupPaged({ fetchJson, onPageSetChanged });
    await settings.load();

    expect(onPageSetChanged).toHaveBeenCalledWith(null);
  });

  test("page mode off (default) renders the flat list with no page tags", async () => {
    const { settings, container } = setup();
    await settings.load();

    expect(container.querySelector('.agent-settings-group[data-group="model"]').dataset.page).toBe(
      undefined,
    );
    expect(settings.setActivePage("model")).toBeUndefined(); // harmless no-op
    expect(
      container
        .querySelector('.agent-settings-group[data-group="tools"]')
        .classList.contains("hidden"),
    ).toBe(false);
  });
});
