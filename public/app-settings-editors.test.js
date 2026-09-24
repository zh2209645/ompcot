import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { setupSettingsEditors } from "./app-settings-editors.js";

describe("settings API key model refresh", () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM(`
      <div id="settings-api-keys"></div>
      <button id="config-editor-close"></button>
      <button id="config-editor-cancel"></button>
      <button id="config-editor-save"></button>
      <div id="config-editor-overlay"></div>
      <div id="config-editor-modal"></div>
      <textarea id="config-editor-textarea"></textarea>
      <div id="config-editor-error"></div>
      <div id="config-editor-path"></div>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.confirm = vi.fn(() => true);
    globalThis.requestAnimationFrame = (callback) => callback();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.confirm;
    delete globalThis.requestAnimationFrame;
  });

  test("refreshes model configuration after removing a stored API key", async () => {
    const onModelConfigurationChanged = vi.fn();
    const fetchModelInfo = vi.fn();
    const rpcCommand = vi.fn(async (command) => {
      if (command.type === "list_auth_status") {
        return {
          success: true,
          data: {
            providers: [
              {
                provider: "anthropic",
                displayName: "Anthropic",
                configured: true,
                source: "stored",
              },
            ],
          },
        };
      }
      if (command.type === "remove_api_key") {
        return { success: true };
      }
      throw new Error(`Unexpected command: ${command.type}`);
    });

    const { loadApiKeysPanel } = setupSettingsEditors({
      rpcCommand,
      fetchModelInfo,
      closeSettings: vi.fn(),
      onModelConfigurationChanged,
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
    });

    await loadApiKeysPanel();
    document.querySelector(".api-key-row-actions .danger").click();
    await Promise.resolve();

    expect(onModelConfigurationChanged).toHaveBeenCalledTimes(1);
    expect(fetchModelInfo).not.toHaveBeenCalled();
  });
});

describe("models config editor loading", () => {
  let dom;

  beforeEach(() => {
    dom = new JSDOM(`
      <div id="settings-api-keys"></div>
      <button id="config-editor-close"></button>
      <button id="config-editor-cancel"></button>
      <button id="config-editor-save"></button>
      <div id="config-editor-overlay"></div>
      <div id="config-editor-modal"></div>
      <textarea id="config-editor-textarea"></textarea>
      <div id="config-editor-error"></div>
      <div id="config-editor-path"></div>
      <span id="inline-config-path"></span>
      <textarea id="inline-config-textarea"></textarea>
      <div id="inline-config-error"></div>
      <button id="inline-config-save"></button>
      <span id="inline-models-path"></span>
      <textarea id="inline-models-textarea"></textarea>
      <div id="inline-models-error"></div>
      <button id="inline-models-save"></button>
      <button id="inline-models-insert-example"></button>
      <a href="#" id="models-config-docs-link"></a>
    `);
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.confirm = vi.fn(() => true);
    globalThis.requestAnimationFrame = (callback) => callback();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.confirm;
    delete globalThis.requestAnimationFrame;
  });

  function setupEditors(overrides = {}) {
    return setupSettingsEditors({
      rpcCommand: vi.fn(),
      closeSettings: vi.fn(),
      onModelConfigurationChanged: vi.fn(),
      clearSettingsSaveMessage: vi.fn(),
      setSettingsSaveButtonSaving: vi.fn(),
      showSettingsSaveError: vi.fn(),
      showSettingsSaveSuccess: vi.fn(),
      ...overrides,
    });
  }

  test("surfaces the HTTP status when loading models.yml fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    const showSettingsSaveError = vi.fn();
    const { loadInlineModelsEditor } = setupEditors({ showSettingsSaveError });

    await loadInlineModelsEditor();

    expect(showSettingsSaveError).toHaveBeenCalledTimes(1);
    const message = showSettingsSaveError.mock.calls[0][1];
    expect(message).toContain("503");
    expect(message).not.toContain("Unexpected token");
    expect(document.getElementById("inline-models-path").textContent).toBe("");
    expect(document.getElementById("inline-models-textarea").value).toBe("");
  });

  test("loads models.yml content and path on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          success: true,
          content: "providers:\n  ollama: {}\n",
          path: "/home/u/.omp/agent/models.yml",
        }),
      })),
    );
    const showSettingsSaveError = vi.fn();
    const { loadInlineModelsEditor } = setupEditors({ showSettingsSaveError });

    await loadInlineModelsEditor();

    expect(showSettingsSaveError).not.toHaveBeenCalled();
    expect(document.getElementById("inline-models-textarea").value).toContain("providers:");
    expect(document.getElementById("inline-models-path").textContent).toBe(
      "/home/u/.omp/agent/models.yml",
    );
  });

  test("insert example fills the textarea with a YAML-shaped models.yml example", () => {
    setupEditors();

    document.getElementById("inline-models-insert-example").click();

    const value = document.getElementById("inline-models-textarea").value;
    expect(value).toContain("providers:");
    expect(value).toContain("baseUrl: http://localhost:11434/v1");
    expect(value).not.toContain('"providers"');
  });
});
