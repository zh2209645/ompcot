import { describe, expect, test, vi } from "vitest";
import { createOmpBinarySettings, formatOmpBinaryStatus } from "./omp-binary-settings.js";

function setup({ status, picked, pickError } = {}) {
  const statusValueEl = document.createElement("span");
  const browseBtn = document.createElement("button");
  const onBinaryChanged = vi.fn();
  const transport = {
    available: true,
    getOmpBinaryStatus: vi.fn(() => Promise.resolve(status ?? { path: null, source: "none" })),
    pickOmpBinary: vi.fn(() =>
      pickError ? Promise.reject(new Error(pickError)) : Promise.resolve(picked ?? null),
    ),
  };
  const settings = createOmpBinarySettings({
    transport,
    isNativeAvailable: () => true,
    statusValueEl,
    browseBtn,
    onBinaryChanged,
  });
  return { settings, statusValueEl, browseBtn, transport, onBinaryChanged };
}

describe("formatOmpBinaryStatus", () => {
  test("labels the resolved path by its source", () => {
    expect(formatOmpBinaryStatus({ path: "/opt/omp/omp", source: "override" })).toBe(
      "/opt/omp/omp (manually set)",
    );
    expect(formatOmpBinaryStatus({ path: "/usr/local/bin/omp", source: "path" })).toBe(
      "/usr/local/bin/omp (from PATH)",
    );
    expect(formatOmpBinaryStatus({ path: "/x/omp", source: "env" })).toBe(
      "/x/omp (from environment)",
    );
  });

  test("renders the not-found state", () => {
    expect(formatOmpBinaryStatus({ path: null, source: "none" })).toBe("Not found");
    expect(formatOmpBinaryStatus(null)).toBe("Not found");
  });
});

describe("createOmpBinarySettings", () => {
  test("refresh renders the resolved binary with its source", async () => {
    const { settings, statusValueEl, transport } = setup({
      status: { path: "/usr/local/bin/omp", source: "path" },
    });

    await settings.refresh();

    expect(transport.getOmpBinaryStatus).toHaveBeenCalledTimes(1);
    expect(statusValueEl.textContent).toBe("/usr/local/bin/omp (from PATH)");
  });

  test("refresh surfaces a transport failure without throwing", async () => {
    const statusValueEl = document.createElement("span");
    const transport = {
      available: true,
      getOmpBinaryStatus: vi.fn(() => Promise.reject(new Error("broker offline"))),
    };
    const settings = createOmpBinarySettings({
      transport,
      isNativeAvailable: () => true,
      statusValueEl,
      browseBtn: null,
    });

    await expect(settings.refresh()).resolves.toBeUndefined();
    expect(statusValueEl.textContent).toBe("Unavailable (broker offline)");
  });

  test("successful pick updates the row and notifies the host", async () => {
    const { settings, statusValueEl, transport, onBinaryChanged } = setup({
      status: { path: null, source: "none" },
      picked: "/opt/omp/omp",
    });
    await settings.refresh();

    await settings.browse();

    expect(transport.pickOmpBinary).toHaveBeenCalledTimes(1);
    expect(statusValueEl.textContent).toBe("/opt/omp/omp (manually set)");
    expect(onBinaryChanged).toHaveBeenCalledTimes(1);
  });

  test("cancelled pick keeps the current display and does not notify", async () => {
    const { settings, statusValueEl, onBinaryChanged } = setup({
      status: { path: "/x/omp", source: "env" },
      picked: null,
    });
    await settings.refresh();

    await settings.browse();

    expect(statusValueEl.textContent).toBe("/x/omp (from environment)");
    expect(onBinaryChanged).not.toHaveBeenCalled();
  });

  test("invalid pick surfaces the backend error message", async () => {
    const { settings, statusValueEl, onBinaryChanged } = setup({
      pickError: "Selected file is not a valid omp binary",
    });

    await settings.browse();

    expect(statusValueEl.textContent).toBe("Selected file is not a valid omp binary");
    expect(onBinaryChanged).not.toHaveBeenCalled();
  });

  test("browse button click triggers the pick flow once per click", async () => {
    const { browseBtn, transport } = setup({ picked: null });
    browseBtn.click();
    expect(transport.pickOmpBinary).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
  });

  test("hides the browse button when no native host is available", async () => {
    const browseBtn = document.createElement("button");
    const settings = createOmpBinarySettings({
      transport: {
        available: true,
        getOmpBinaryStatus: vi.fn(() => Promise.resolve({ path: null, source: "none" })),
      },
      isNativeAvailable: () => false,
      statusValueEl: document.createElement("span"),
      browseBtn,
    });

    await settings.refresh();

    expect(browseBtn.classList.contains("hidden")).toBe(true);
  });
});
