import { onLanguageChanged, t } from "./i18n.js";

export function createAppUpdater({
  transport,
  appVersionValue,
  updaterSection,
  checkUpdatesBtn,
  updateStatusRow,
  updateStatusEl,
  updateInstallRow,
  updateInstallLabel,
  installUpdateBtn,
  sidebarUpdateBtn,
  onOpenSettings,
}) {
  const APP_VERSION = (() => {
    const meta = document.querySelector('meta[name="app-version"]');
    return meta?.content?.trim() || null;
  })();

  let pendingUpdate = null;
  let updaterBusy = false;
  let updateCheckFailed = false;
  let uiInitialized = false;
  let startupCheckTimer = null;
  let periodicCheckInterval = null;
  const BETA_VERSION_RE = /-beta(?:[.-]|$)/i;
  const NUMERIC_PRERELEASE_VERSION_RE = /-\d+(?:\.\d+)*$/;
  let currentAppVersion = APP_VERSION;

  function setSidebarUpdateButton({
    visible,
    label = t("sidebar.update"),
    tone = "ok",
    title = t("update.openInSettings"),
    disabled = false,
  }) {
    if (!sidebarUpdateBtn) return;
    sidebarUpdateBtn.classList.toggle("hidden", !visible);
    if (!visible) {
      sidebarUpdateBtn.textContent = t("sidebar.update");
      sidebarUpdateBtn.dataset.tone = "";
      sidebarUpdateBtn.disabled = false;
      sidebarUpdateBtn.title = t("update.openInSettings");
      return;
    }
    sidebarUpdateBtn.textContent = label;
    sidebarUpdateBtn.dataset.tone = tone;
    sidebarUpdateBtn.disabled = disabled;
    sidebarUpdateBtn.title = title;
  }

  function syncSidebarUpdateButton() {
    if (updaterBusy) {
      setSidebarUpdateButton({
        visible: true,
        label: t("update.updating"),
        tone: "warn",
        title: t("update.inProgress"),
        disabled: true,
      });
      return;
    }
    if (pendingUpdate) {
      setSidebarUpdateButton({
        visible: true,
        label: t("sidebar.update"),
        tone: "ok",
        title: t("update.availableWithVersion", { version: pendingUpdate.version }),
      });
      return;
    }
    if (updateCheckFailed) {
      setSidebarUpdateButton({
        visible: true,
        label: t("update.retry"),
        tone: "error",
        title: t("update.checkFailedTitle"),
      });
      return;
    }
    setSidebarUpdateButton({ visible: false });
  }

  function setUpdateStatus(message, tone = "info") {
    if (!updateStatusRow || !updateStatusEl) return;
    if (!message) {
      updateStatusRow.hidden = true;
      updateStatusEl.textContent = "";
      updateStatusEl.dataset.tone = "";
      return;
    }
    updateStatusRow.hidden = false;
    updateStatusEl.textContent = message;
    updateStatusEl.dataset.tone = tone;
  }

  function showInstallButton(update) {
    if (!updateInstallRow || !updateInstallLabel || !installUpdateBtn) return;
    if (!update) {
      updateInstallRow.hidden = true;
      return;
    }
    updateInstallRow.hidden = false;
    const from = update.currentVersion
      ? t("update.fromVersion", { version: update.currentVersion })
      : "";
    updateInstallLabel.textContent = `Ompcot ${update.version}${from}`;
    installUpdateBtn.disabled = false;
    installUpdateBtn.textContent = t("settings.downloadInstall");
  }

  function isIgnoredPrereleaseVersion(version) {
    return BETA_VERSION_RE.test(String(version || "").trim());
  }

  function isLocalPrereleaseBuild(version) {
    return NUMERIC_PRERELEASE_VERSION_RE.test(String(version || "").trim());
  }

  async function loadAppVersion() {
    if (!appVersionValue) return;

    if (APP_VERSION) {
      appVersionValue.textContent = APP_VERSION;
      currentAppVersion = APP_VERSION;
      return APP_VERSION;
    }

    try {
      if (transport?.capabilities?.native) {
        const v = await transport.getAppVersion();
        if (v) {
          appVersionValue.textContent = v;
          currentAppVersion = v;
          return v;
        }
      }
    } catch (err) {
      console.warn("[updater] unable to read app version:", err);
    }
    appVersionValue.textContent = t("update.versionUnknown");
    currentAppVersion = "unknown";
    return currentAppVersion;
  }

  function explainUpdateError(rawMessage) {
    const msg = String(rawMessage || "");
    if (/Could not fetch a valid release JSON/i.test(msg)) {
      return t("update.errorNoManifest");
    }
    if (/pubkey|public key|signature/i.test(msg)) {
      return t("update.errorSignature");
    }
    return msg || t("update.errorUnknown");
  }

  async function checkForUpdates({ silent = false } = {}) {
    if (updaterBusy) return null;

    if (isLocalPrereleaseBuild(currentAppVersion)) {
      if (!silent) {
        setUpdateStatus(t("update.prereleaseDisabled", { version: currentAppVersion }), "info");
      }
      pendingUpdate = null;
      updateCheckFailed = false;
      showInstallButton(null);
      syncSidebarUpdateButton();
      return null;
    }

    if (!transport?.hasUpdater) {
      if (!silent) setUpdateStatus(t("update.desktopOnly"), "warn");
      if (updaterSection && !transport?.capabilities?.native) updaterSection.hidden = true;
      setSidebarUpdateButton({ visible: false });
      return null;
    }

    updaterBusy = true;
    syncSidebarUpdateButton();
    if (checkUpdatesBtn) {
      checkUpdatesBtn.disabled = true;
      checkUpdatesBtn.textContent = t("update.checkingBtn");
    }
    if (!silent) setUpdateStatus(t("update.checkingForUpdates"), "info");

    try {
      const update = await transport.checkForUpdate();
      if (!update) {
        pendingUpdate = null;
        updateCheckFailed = false;
        showInstallButton(null);
        setUpdateStatus(t("update.upToDate"), "ok");
        syncSidebarUpdateButton();
        return null;
      }

      if (isIgnoredPrereleaseVersion(update.version)) {
        console.info("[updater] ignoring beta release:", update.version);
        pendingUpdate = null;
        updateCheckFailed = false;
        showInstallButton(null);
        setUpdateStatus(t("update.upToDateStable"), "ok");
        syncSidebarUpdateButton();
        return null;
      }

      pendingUpdate = update;
      updateCheckFailed = false;
      showInstallButton(update);
      setUpdateStatus(t("update.availableWithVersion", { version: update.version }), "ok");
      syncSidebarUpdateButton();
      return update;
    } catch (err) {
      const friendly = explainUpdateError(err?.message || err);
      console.warn("[updater] check failed:", err);
      if (!silent) {
        setUpdateStatus(friendly, "warn");
      }
      updateCheckFailed = true;
      syncSidebarUpdateButton();
      return null;
    } finally {
      updaterBusy = false;
      syncSidebarUpdateButton();
      if (checkUpdatesBtn) {
        checkUpdatesBtn.disabled = false;
        checkUpdatesBtn.textContent = t("settings.checkNow");
      }
    }
  }

  async function installPendingUpdate() {
    if (updaterBusy || !pendingUpdate) return;
    if (!transport?.capabilities?.native) return;

    updaterBusy = true;
    syncSidebarUpdateButton();
    if (installUpdateBtn) {
      installUpdateBtn.disabled = true;
      installUpdateBtn.textContent = t("update.downloading");
    }
    if (checkUpdatesBtn) checkUpdatesBtn.disabled = true;

    try {
      await transport.downloadAndInstallUpdate((evt) => {
        if (evt.phase === "started") {
          setUpdateStatus(
            evt.contentLength
              ? t("update.downloadingMb", { size: (evt.contentLength / 1_048_576).toFixed(1) })
              : t("update.downloading"),
            "info",
          );
        } else if (evt.phase === "progress" && evt.contentLength) {
          const pct = Math.min(100, Math.round((evt.downloaded / evt.contentLength) * 100));
          if (installUpdateBtn)
            installUpdateBtn.textContent = t("update.downloadingPct", { percent: pct });
        } else if (evt.phase === "finished") {
          if (installUpdateBtn) installUpdateBtn.textContent = t("update.installing");
          setUpdateStatus(t("update.installing"), "info");
        }
      });

      setUpdateStatus(t("update.installedRestarting"), "ok");
      pendingUpdate = null;
      updateCheckFailed = false;
      syncSidebarUpdateButton();
      setTimeout(() => {
        transport?.relaunchApp?.().catch((err) => {
          console.error("[updater] relaunch failed:", err);
          setUpdateStatus(t("update.restartManually"), "warn");
          updateCheckFailed = true;
          syncSidebarUpdateButton();
        });
      }, 600);
    } catch (err) {
      const msg = String(err?.message || err || t("update.unknownError"));
      console.error("[updater] install failed:", err);
      setUpdateStatus(t("update.installFailed", { error: msg }), "error");
      if (installUpdateBtn) {
        installUpdateBtn.disabled = false;
        installUpdateBtn.textContent = t("update.retry");
      }
      updateCheckFailed = true;
      syncSidebarUpdateButton();
    } finally {
      updaterBusy = false;
      syncSidebarUpdateButton();
      if (checkUpdatesBtn) checkUpdatesBtn.disabled = false;
    }
  }

  let isDevBuildCache = null;
  async function isDevBuild() {
    if (isDevBuildCache !== null) return isDevBuildCache;
    try {
      isDevBuildCache = !!(transport?.capabilities?.native && (await transport.isDev()));
    } catch {
      isDevBuildCache = false;
    }
    return isDevBuildCache;
  }

  async function initUpdaterUI() {
    if (!updaterSection) return;

    if (!transport?.hasUpdater) {
      updaterSection.hidden = true;
      syncSidebarUpdateButton();
      return;
    }
    // Capabilities can arrive asynchronously and may be re-emitted on reconnect.
    // Ensure the section becomes visible once native updater support is known.
    updaterSection.hidden = false;

    const appVersion = await loadAppVersion();

    if (await isDevBuild()) {
      setUpdateStatus(t("update.devBuild"), "info");
      if (checkUpdatesBtn) checkUpdatesBtn.disabled = true;
      syncSidebarUpdateButton();
      return;
    }

    if (isLocalPrereleaseBuild(appVersion)) {
      setUpdateStatus(t("update.prereleaseDisabled", { version: appVersion }), "info");
      if (checkUpdatesBtn) checkUpdatesBtn.disabled = true;
      if (installUpdateBtn) installUpdateBtn.disabled = true;
      showInstallButton(null);
      syncSidebarUpdateButton();
      return;
    }

    if (uiInitialized) {
      syncSidebarUpdateButton();
      return;
    }
    uiInitialized = true;

    checkUpdatesBtn?.addEventListener("click", () => {
      checkForUpdates({ silent: false });
    });
    installUpdateBtn?.addEventListener("click", () => {
      installPendingUpdate();
    });

    startupCheckTimer = setTimeout(() => {
      checkForUpdates({ silent: true }).catch(() => {});
    }, 5_000);

    periodicCheckInterval = setInterval(
      () => {
        if (document.visibilityState === "visible") {
          checkForUpdates({ silent: true }).catch(() => {});
        }
      },
      6 * 60 * 60 * 1000,
    );
    // Keep references intentionally; helps future teardown work and makes
    // duplicate-initialization bugs obvious in devtools.
    void startupCheckTimer;
    void periodicCheckInterval;
    syncSidebarUpdateButton();
  }

  async function openUpdatesFromSidebar() {
    await onOpenSettings();
    updaterSection?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    if (pendingUpdate && installUpdateBtn && !installUpdateBtn.disabled) {
      installUpdateBtn.focus();
      return;
    }
    checkUpdatesBtn?.focus();
  }

  // This module owns persistent chrome (sidebar update button, updater
  // buttons), so refresh their labels when the interface language changes.
  // Transient status text stays in the language it was produced in until the
  // next status update.
  onLanguageChanged(() => {
    syncSidebarUpdateButton();
    if (checkUpdatesBtn && !updaterBusy) {
      checkUpdatesBtn.textContent = t("settings.checkNow");
    }
    showInstallButton(pendingUpdate);
  });

  return {
    initUpdaterUI,
    openUpdatesFromSidebar,
  };
}
