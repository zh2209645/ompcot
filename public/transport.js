/**
 * Transport layer — the single surface the frontend uses to drive process /
 * window lifecycle and native operations.
 *
 * Historically every control op went through Tauri IPC via a browser bridge.
 * That hard-wired the UI to the desktop app: a mobile / remote client could
 * not drive those commands.
 *
 * Now there is ONE transport: every op is a `broker_control` request sent over
 * the shared broker WebSocket and awaited via a correlated `control_response`.
 * Inside the desktop app the Rust broker installs a native control handler
 * (capabilities.native = true) and executes these ops; a bare broker / remote
 * client without a handler reports capabilities.native = false and native-only
 * ops reject server-side. The UI is identical across environments.
 */

import { resolveBrokerWsUrl } from "./websocket-client.js";

// Long/interactive ops must not be killed by the default 30s control timeout:
// the folder picker waits for the user, the updater download streams for a while.
const NO_TIMEOUT = 0;
const SPAWN_TIMEOUT_MS = 60000;
const PACKAGE_TIMEOUT_MS = 120000;

function currentPort(env = globalThis.window || globalThis) {
  const port = Number.parseInt(env?.location?.port, 10);
  return Number.isFinite(port) && port > 0 ? port : 47821;
}

export class WsTransport {
  constructor(wsClient, env = globalThis.window || globalThis) {
    this.wsClient = wsClient;
    this.env = env;
  }

  get available() {
    return Boolean(this.wsClient);
  }

  // Live native-capability flag from the broker handshake. Native-only UI is
  // gated on this; it flips true once the `capabilities` frame arrives.
  get capabilities() {
    return this.wsClient?.capabilities || { native: false };
  }

  get hasUpdater() {
    return this.capabilities.native;
  }

  _control(command, args = {}, options = {}) {
    if (!this.wsClient) {
      return Promise.reject(new Error("Transport is not connected"));
    }
    return this.wsClient.sendControl(command, args, options);
  }

  // ── Process / window lifecycle (create project, sessions, instances) ───────

  openWorkspace(cwd, options = {}) {
    return this._control(
      "open_workspace",
      {
        cwd,
        sessionPath: options.sessionPath ?? null,
        forceNewSession: options.forceNewSession ?? false,
        openWindow: options.openWindow ?? true,
        waitForHealth: options.waitForHealth ?? true,
        waitForSessions: options.waitForSessions ?? false,
      },
      { timeoutMs: SPAWN_TIMEOUT_MS },
    );
  }

  newSession(port) {
    return this._control("new_session", { port: port ?? null });
  }

  switchSession(sessionPath, port) {
    return this._control("switch_session", { sessionPath, port: port ?? null });
  }

  // Fork the CURRENT session of this window's omp process from a transcript
  // entry. omp's native RPC `branch` (18.3.1+) performs it; completion is
  // confirmed by the `session_branch` extension event, not the control reply
  // (the broker forwards the frame fire-and-forget, like switch_session).
  forkSession(entryId) {
    return this._control("fork_session", {
      entryId,
      port: currentPort(this.env),
    });
  }

  stopInstance(port) {
    return this._control("stop_instance", { port: port ?? null });
  }

  spawnSessionProcess(sessionFile, cwd) {
    return this._control(
      "spawn_session_process",
      { sessionFile, cwd, workspacePort: currentPort(this.env) },
      { timeoutMs: SPAWN_TIMEOUT_MS },
    );
  }

  // ── Versions / packages ────────────────────────────────────────────────────

  getOMPVersion() {
    return this._control("get_omp_version", {});
  }

  getOmpBinaryStatus() {
    return this._control("get_omp_binary_status", {});
  }

  getAppVersion() {
    return this._control("get_app_version", {});
  }

  isDev() {
    return this._control("is_dev", {});
  }

  listOMPPackages() {
    return this._control("list_pi_packages", {});
  }

  installOMPPackage(source) {
    return this._control("install_pi_package", { source }, { timeoutMs: PACKAGE_TIMEOUT_MS });
  }

  removeOMPPackage(source) {
    return this._control("remove_pi_package", { source }, { timeoutMs: PACKAGE_TIMEOUT_MS });
  }

  /**
   * Send a prompt through omp's own RPC `prompt` frame (written to the process's
   * stdin by the desktop broker) instead of the extension's WS API.
   *
   * Slash commands need this: omp's RPC prompt path dispatches extension
   * commands, custom commands, skills and builtins, while `sendUserMessage`
   * (the extension API the embedded server uses) explicitly passes
   * `expandPromptTemplates: false` — a `/cmd` sent that way reaches the model as
   * literal text. The upstream answers with a normal `response` frame carrying
   * `requestId`, which the WebSocket client dispatches as `commandResponse`.
   */
  promptUpstream({ message, requestId = null, streamingBehavior = null, port = null } = {}) {
    return this._control("prompt_upstream", {
      message,
      requestId,
      streamingBehavior,
      port: port ?? currentPort(this.env),
    });
  }

  // ── Native-only ops (need an OS host; reject when capabilities.native=false) ─

  pickFolder() {
    return this._control("pick_folder", {}, { timeoutMs: NO_TIMEOUT });
  }

  /**
   * Native multi-file picker for composer `@`-mentions. Resolves with the
   * picked absolute paths (an empty array when the dialog was cancelled); the
   * frontend inserts them as mention text, so no content crosses the wire.
   */
  pickFiles() {
    return this._control("pick_files", {}, { timeoutMs: NO_TIMEOUT });
  }

  // OS file dialog + backend validation waits for the user: no timeout.
  pickOmpBinary() {
    return this._control("pick_omp_binary", {}, { timeoutMs: NO_TIMEOUT });
  }

  listInstalledApps() {
    return this._control("list_installed_apps", {});
  }

  openInApp(path, { appName = null, command = null } = {}) {
    return this._control("open_in_app", { path, appName, command });
  }

  openExternal(url) {
    return this._control("open_external", { url });
  }

  openDevtools(port) {
    return this._control("open_devtools", { port: port ?? currentPort(this.env) });
  }

  // ── Auto-updater ────────────────────────────────────────────────────────────

  checkForUpdate() {
    return this._control("check_for_update", {}, { timeoutMs: SPAWN_TIMEOUT_MS });
  }

  downloadAndInstallUpdate(onProgress) {
    return this._control("download_and_install_update", {}, { onProgress, timeoutMs: NO_TIMEOUT });
  }

  relaunchApp() {
    // The host restarts the process, so the control_response typically never
    // arrives (the socket drops first). Swallow only the expected disconnect;
    // surface all other errors to avoid hiding real restart failures.
    return this._control("relaunch_app", {}).catch((err) => {
      const message = String(err?.message || err || "");
      if (/websocket disconnected/i.test(message)) {
        console.warn("[transport] relaunch response not received (app restarting):", err);
        return;
      }
      throw err;
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  currentPort() {
    return currentPort(this.env);
  }

  brokerWsUrl() {
    return resolveBrokerWsUrl(this.env);
  }
}

let singleton = null;

export function createTransport({ wsClient, env = globalThis.window || globalThis } = {}) {
  return new WsTransport(wsClient, env);
}

export function initTransport(opts) {
  singleton = createTransport(opts);
  return singleton;
}

export function getTransport() {
  return singleton;
}
