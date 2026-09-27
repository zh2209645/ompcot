// Settings → Debug: capture and export the window's debug bundle.
//
// Rendering bugs (a message drawn twice, a status pill that flickered) leave no
// trace in the session file — one entry, two elements — so the evidence has to
// come from the window. This page reports what is being captured, lets the user
// pause it, and exports one JSON bundle containing:
//
//   - the frontend buffer: console output, window errors, every WebSocket frame
//     in both directions (summarized), session-routing decisions and transcript
//     element operations (see debug-log.js);
//   - the process buffer: what the embedded server broadcast, which commands
//     windows sent, and the HTTP routes they hit (see debug-buffer.ts);
//   - window metadata: workspace, port, session file, app/omp versions, UA.
//
// Exporting is a POST to the running omp process (`/api/debug-dump`), which
// writes the merged bundle next to the OS temp dir and answers with the path —
// a dump the user cannot find is not a dump. The path is shown in the panel and
// logged to the console for copying.

import { buildDebugBundle, debugLog } from "./debug-log.js";
import { onLanguageChanged, t } from "./i18n.js";

export function createDebugPanel({ root, fetchImpl = fetch, meta = () => ({}) } = {}) {
  const toggleEl = root?.querySelector("#debug-capture-toggle") ?? null;
  const windowCountEl = root?.querySelector("#debug-window-count") ?? null;
  const processCountEl = root?.querySelector("#debug-process-count") ?? null;
  const statusEl = root?.querySelector("#debug-status") ?? null;
  const pathEl = root?.querySelector("#debug-dump-path") ?? null;
  const refreshEl = root?.querySelector("#debug-refresh") ?? null;
  const exportEl = root?.querySelector("#debug-export") ?? null;

  let busy = false;

  function setStatus(message, kind = "ok") {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.classList.toggle("hidden", !message);
    statusEl.classList.toggle("settings-status-error", kind === "error");
  }

  function paintWindowCount() {
    if (windowCountEl) windowCountEl.textContent = String(debugLog.size());
  }

  /** Counts on both sides of the wire; the process half may be unavailable. */
  async function refresh() {
    paintWindowCount();
    if (processCountEl) processCountEl.textContent = t("common.loading");
    try {
      const res = await fetchImpl("/api/debug-log?limit=1");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      if (processCountEl) processCountEl.textContent = String(data?.size ?? 0);
    } catch {
      if (processCountEl) processCountEl.textContent = t("debug.unavailable");
    }
  }

  async function exportBundle() {
    if (busy) return;
    busy = true;
    exportEl?.classList.add("disabled");
    setStatus(t("debug.exporting"));
    try {
      const bundle = buildDebugBundle({
        meta: { ...meta(), windowEntries: debugLog.size() },
        frontend: debugLog.snapshot(),
      });
      const res = await fetchImpl("/api/debug-dump", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.path) {
        throw new Error(data?.error || `status ${res.status}`);
      }
      setStatus(
        t("debug.exported", {
          frontend: data.frontendEntries ?? bundle.frontend.length,
          extension: data.extensionEntries ?? 0,
        }),
      );
      if (pathEl) {
        pathEl.textContent = data.path;
        pathEl.classList.remove("hidden");
      }
      console.log("[debug] bundle written:", data.path, `(${data.bytes} bytes)`);
    } catch (err) {
      setStatus(t("debug.exportFailed", { error: String(err?.message || err) }), "error");
    } finally {
      busy = false;
      exportEl?.classList.remove("disabled");
      void refresh();
    }
  }

  function syncToggle() {
    if (!toggleEl) return;
    toggleEl.classList.toggle("on", debugLog.isEnabled());
    toggleEl.setAttribute("aria-pressed", String(debugLog.isEnabled()));
  }

  toggleEl?.addEventListener("click", () => {
    debugLog.setEnabled(!debugLog.isEnabled());
    syncToggle();
    setStatus(debugLog.isEnabled() ? t("debug.captureOn") : t("debug.captureOff"));
  });
  refreshEl?.addEventListener("click", () => {
    void refresh();
  });
  exportEl?.addEventListener("click", () => {
    void exportBundle();
  });

  // The pill labels are JS-built elsewhere; here only the live counts need a
  // repaint on language change (labels come from data-i18n attributes).
  const unsubscribeLanguage = onLanguageChanged(() => {
    void refresh();
  });

  syncToggle();
  return {
    refresh,
    export: exportBundle,
    destroy: () => unsubscribeLanguage(),
  };
}
