// Settings → General → Runtime: shows which `omp` binary the host resolved
// (and where it came from), and lets the user pick one manually when the
// bundled / PATH lookup fails. The backend validates + persists the pick and
// the resolver prefers it immediately — no restart — so on success we just
// refresh this row and re-fetch the OMP version display via
// `onBinaryChanged`.

const SOURCE_LABELS = {
  override: "manually set",
  env: "from environment",
  path: "from PATH",
};

export function formatOmpBinaryStatus(status) {
  if (!status?.path) return "Not found";
  const source = SOURCE_LABELS[status.source];
  return source ? `${status.path} (${source})` : status.path;
}

export function createOmpBinarySettings({
  transport,
  isNativeAvailable,
  statusValueEl,
  browseBtn,
  onBinaryChanged,
}) {
  let picking = false;

  function render(text) {
    if (statusValueEl) statusValueEl.textContent = text;
  }

  function nativeAvailable() {
    return typeof isNativeAvailable === "function" ? Boolean(isNativeAvailable()) : true;
  }

  async function refresh() {
    // The Browse button drives an OS file dialog, which only the native host
    // provides; the status row itself stays visible everywhere.
    if (browseBtn) browseBtn.classList.toggle("hidden", !nativeAvailable());
    if (!statusValueEl || !transport?.available) return;
    try {
      render(formatOmpBinaryStatus(await transport.getOmpBinaryStatus()));
    } catch (err) {
      console.error("[settings] failed to load omp binary status:", err);
      render(`Unavailable (${String(err?.message || err || "unknown error")})`);
    }
  }

  async function browse() {
    if (picking || !nativeAvailable() || !transport?.available) return;
    picking = true;
    if (browseBtn) browseBtn.disabled = true;
    try {
      const picked = await transport.pickOmpBinary();
      if (picked) {
        render(`${picked} (manually set)`);
        if (typeof onBinaryChanged === "function") {
          try {
            await onBinaryChanged();
          } catch (err) {
            console.warn("[settings] omp binary change callback failed:", err);
          }
        }
      }
      // picked == null → user cancelled the file dialog; keep current display.
    } catch (err) {
      // Backend rejected the pick (e.g. not a valid omp binary) — say why.
      render(String(err?.message || err || "Could not set omp binary"));
    } finally {
      picking = false;
      if (browseBtn) browseBtn.disabled = false;
    }
  }

  if (browseBtn) {
    browseBtn.addEventListener("click", () => {
      void browse();
    });
  }

  return { refresh, browse };
}
