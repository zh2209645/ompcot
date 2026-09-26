/**
 * Embedded Server Extension for Ompcot desktop
 *
 * Starts the HTTP + WebSocket server that the Ompcot Tauri WebView talks to.
 * This is not a user-facing "omp extension" — it ships inside the Ompcot
 * .app bundle and is loaded by the bundled `omp` binary that Ompcot spawns
 * via `--extension <bundle>/embedded-server.mjs`.
 *
 * Responsibilities:
 * - Serve the static frontend assets (`public/`)
 * - Bridge browser RPC over `/api/rpc` (HTTP) and `/ws` (WebSocket) to the
 *   omp extension API (sendUserMessage, abort, set_model, etc.)
 * - Expose REST endpoints the frontend queries directly:
 *   `/api/sessions`, `/api/cost-dashboard`, `/api/files`, `/api/search`,
 *   `/api/open`, `/api/agent-settings`, `/api/agent-config`,
 *   `/api/models-config`, `/api/instances`
 * - Forward all omp lifecycle events to connected browsers
 * - Bridge omp's interactive-UI dialogs (`ctx.ui.select/confirm/input/editor`)
 *   to the WebView as `extension_ui_request` events resolved by the
 *   `ui_response` / `ui_cancel` commands
 * - Shell out to the embedded omp CLI for GUI features with no extension API:
 *   `get_usage` (usage --json), `run_omp_login` (login, headless),
 *   `import_session` (interactive-only probe), `fork_session` (ctx.branch),
 *   `list_memory_files` (read-only storage probe)
 * - Generate session titles from user messages
 *
 * What's intentionally NOT here anymore (vs the old mirror-server.ts):
 * - QR / pairing flow — LAN mobile access is advertised as a plain URL
 * - Basic auth — the mobile entry point is an explicit local-network dev mode
 * - `/studiostart` / `/studiostop` / `/qr` commands — server lifecycle is
 *   tied 1:1 to the omp process Ompcot spawns
 * - Cross-process instance discovery via `~/.omp/ompcot-instances/` —
 *   Ompcot's Rust side already knows which ports it spawned. We keep a
 *   trivial single-entry registry so the frontend's `active` state stays
 *   correct without needing a Tauri invoke for `/api/instances` queries.
 * - `omp --version` exec probing — version is forwarded by Ompcot via
 *   `OMCOT_OMP_VERSION` env var.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, ModelRegistry } from "@oh-my-pi/omp-coding-agent";
import QRCode from "qrcode";
import { type WebSocket, WebSocketServer } from "ws";
import {
  buildCostDashboardPayload,
  buildEmptyCostDashboardPayload,
  type CostSession,
} from "./cost-dashboard-data.ts";
import { buildProjectSearchMatch } from "./session-search";

// `omp` is compiled with `bun build --compile`. Inside that runtime,
// `http.createServer(...).on("upgrade", ...)` accepts the upgrade event
// but `socket.write()` (which `ws.handleUpgrade` uses to send the
// `HTTP/1.1 101 Switching Protocols` reply) is silently dropped, so the
// client never completes the handshake. The result in Ompcot is
// "Disconnected" forever and chat sessions never render.
//
// `Bun.serve()` ships its own native WebSocket upgrade path and *does*
// work in the bundled binary, so when the global is present we go that
// route. The plain Node path is kept for dev (jiti/tsx loading the .ts
// source directly under Node) and as a defensive fallback.
interface BunRuntime {
  serve: (...args: unknown[]) => unknown;
  file: (path: string) => {
    exists: () => Promise<boolean>;
    type: string;
    size: number;
    slice: (start: number, end?: number) => unknown;
  };
}
declare const Bun: BunRuntime;
const HAS_BUN_SERVE =
  typeof (globalThis as { Bun?: BunRuntime }).Bun !== "undefined" &&
  typeof (globalThis as { Bun?: BunRuntime }).Bun?.serve === "function";

// Ompcot settings live under `ompcot` key in ~/.omp/agent/settings.json.
// We only honor the fields that still make sense in desktop-only mode.
// TODO(rename->ompcot): key is `ompcot` for historical reasons. Changing it to `ompcot`
// would break existing users' settings — add a migration path before renaming.
function buildHomeDirCandidates(): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value?: string) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const normalized = path.resolve(trimmed);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  add(process.env.HOME);
  add(process.env.USERPROFILE);
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    add(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`);
  }
  add(os.homedir());

  return candidates;
}

function resolveOmpAgentRoot(): string {
  // omp 18.x uses `.omp/agent`; `.pi/agent` is the legacy layout. Per home
  // candidate, prefer the modern directory first, then the legacy one.
  for (const home of buildHomeDirCandidates()) {
    for (const dirName of [".omp", ".pi"]) {
      const candidate = path.join(home, dirName, "agent");
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // Fallback for some Windows setups where app data is relocated.
  const appData = process.env.APPDATA;
  if (typeof appData === "string" && appData.trim()) {
    const roamingCandidate = path.join(path.resolve(appData), "omp", "agent");
    if (fs.existsSync(roamingCandidate)) return roamingCandidate;
  }

  const home = buildHomeDirCandidates()[0] || "~";
  return path.join(home, ".omp", "agent");
}

const OMP_AGENT_ROOT = resolveOmpAgentRoot();

// ─── Network exposure (audit A5) ──────────────────────────────────────────────
//
// Loopback by default. Binding 0.0.0.0 (LAN-exposed) happens ONLY when the
// user opts in:
//   1. `LAN_BIND_HOST` env set → honored verbatim (explicit configuration)
//   2. `OMCOT_LAN` env is "1" / "true" → bind all interfaces
//   3. default → 127.0.0.1
// Everything else (CORS, LAN URL/QR payloads) derives from BIND_HOST below.
export const LOOPBACK_BIND_HOST = "127.0.0.1";
export const LAN_BIND_HOST = "0.0.0.0";

export function resolveBindHost(): string {
  const explicit = process.env.LAN_BIND_HOST?.trim();
  if (explicit) return explicit;
  const lan = process.env.OMCOT_LAN?.trim().toLowerCase();
  if (lan === "1" || lan === "true") return LAN_BIND_HOST;
  return LOOPBACK_BIND_HOST;
}

function isLanBindEnabled(): boolean {
  return !isLoopbackHost(BIND_HOST);
}

function isLoopbackHost(host: string): boolean {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  // 127.0.0.0/8 — the whole IPv4 loopback block, not just .1
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// ─── Host header parsing (audit A10) ──────────────────────────────────────────
//
// `host.split(":")[0]` mangles bracketed IPv6 Host headers ("[::1]:47821"
// → "[", silently non-loopback). Parse bracket-aware instead.

// Parse a Host header into { hostname, port }. Bracketed IPv6 literals
// ("[::1]:47821" → hostname "::1") and bare IPv6 literals (no port) are
// handled; anything unparsable yields empty strings (callers fail closed).
export function parseHostHeader(host: string): { hostname: string; port: string } {
  const trimmed = host.trim();
  if (!trimmed) return { hostname: "", port: "" };
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close < 2) return { hostname: "", port: "" };
    const rest = trimmed.slice(close + 1);
    return { hostname: trimmed.slice(1, close), port: rest.startsWith(":") ? rest.slice(1) : "" };
  }
  const firstColon = trimmed.indexOf(":");
  if (firstColon === -1) return { hostname: trimmed, port: "" };
  // Multiple colons without brackets = bare IPv6 literal, no port suffix.
  if (trimmed.indexOf(":", firstColon + 1) !== -1) return { hostname: trimmed, port: "" };
  return { hostname: trimmed.slice(0, firstColon), port: trimmed.slice(firstColon + 1) };
}

export function parseHostHeaderName(host: string): string {
  return parseHostHeader(host).hostname;
}

// ─── CORS origin trust (audit A5) ─────────────────────────────────────────────
//
// No wildcard `Access-Control-Allow-Origin`. The header is only emitted when
// the request carries an Origin that is either loopback (the WebView / local
// dev pages) or identical to the request's own Host (same-origin fetch with
// an explicit Origin). Same-origin requests — the normal WebView case — send
// no Origin at all and don't need CORS.
function isTrustedCorsOrigin(originHeader: string, reqHost: string): boolean {
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return false;
  if (isLoopbackHost(origin.hostname.toLowerCase())) return true;
  const { hostname: reqHostName, port: reqPort } = parseHostHeader(reqHost);
  if (!reqHostName || reqHostName.toLowerCase() !== origin.hostname) return false;
  // Host omits the port when it is the scheme default; URL parses the port
  // away in that case too, so compare what each side carries.
  const originPort = origin.port || (origin.protocol === "https:" ? "443" : "80");
  return !reqPort || reqPort === originPort;
}

// ─── Request body cap (audit A6) ──────────────────────────────────────────────

const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB

// Read a request body with a hard size cap. Oversized payloads are answered
// with 413 and the body is never handed to the route handler; subsequent
// chunks are drained without accumulating so the connection stays healthy.
function readCappedBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  onBody: (body: string) => void | Promise<void>,
): void {
  let body = "";
  let received = 0;
  let overflowed = false;
  req.on("data", (chunk: Buffer) => {
    if (overflowed) return; // drain mode: discard, don't accumulate
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      overflowed = true;
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "payload too large" }));
      return;
    }
    body += chunk.toString();
  });
  req.on("end", () => {
    if (overflowed) return;
    try {
      const result = onBody(body);
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).catch((err: unknown) => {
          console.error("[embedded-server] body handler failed:", err);
        });
      }
    } catch (err: unknown) {
      console.error("[embedded-server] body handler failed:", err);
    }
  });
}

// Bun-adapter counterpart: read a web `Request` body with the same cap.
// Resolves `null` when the payload exceeds MAX_BODY_BYTES (caller answers 413).
async function readCappedBodyBun(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  const reader = req.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {}
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    return null;
  }
  return body;
}

function findLanHosts(): string[] {
  const hosts = new Set<string>();
  try {
    const interfaces = os.networkInterfaces();
    for (const details of Object.values(interfaces)) {
      if (!details) continue;
      for (const detail of details) {
        if (detail.family === "IPv4" && !detail.internal && detail.address) {
          hosts.add(detail.address);
        }
      }
    }
  } catch {}
  return [...hosts].sort();
}

export function buildLanAccessUrls(port: number, hosts: string[]): string[] {
  const brokerPort = Number.parseInt(process.env.OMCOT_BROKER_PORT || "", 10);
  return hosts.map((host) => {
    const url = new URL(`http://${host}:${port}/`);
    url.searchParams.set("mobile", "1");
    if (Number.isFinite(brokerPort) && brokerPort > 0) {
      url.searchParams.set("brokerWs", `ws://${host}:${brokerPort}/ui-ws`);
    }
    return url.toString();
  });
}

function buildLanUrls(port: number): string[] {
  if (isLoopbackHost(BIND_HOST)) return [];
  const hosts = BIND_HOST === "0.0.0.0" ? findLanHosts() : [BIND_HOST];
  return buildLanAccessUrls(port, hosts);
}

function loadSettings(): { port: number } {
  let settings: { port?: number | string } = {};
  try {
    const settingsPath = path.join(OMP_AGENT_ROOT, "settings.json");
    // TODO(rename->ompcot): key `ompcot` kept for backward compat — migrate to `ompcot` once a settings-migration path exists.
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")).ompcot || {};
  } catch {}
  return {
    port: parseInt(String(process.env.OMCOT_PORT || settings.port || "47821"), 10),
  };
}

const SETTINGS = loadSettings();
const PORT = SETTINGS.port;
const BIND_HOST = resolveBindHost();
// Forwarded by Ompcot (Rust side) from `scripts/omp-version.json`. We deliberately
// do not call `omp --version` here: this extension always runs *inside* the pi
// binary Ompcot spawned, so the version is known.
const EMBEDDED_OMP_VERSION = process.env.OMCOT_OMP_VERSION || "";

const STATIC_DIR = process.env.OMCOT_STATIC_DIR || findPublicDir();

function findPublicDir(): string {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (dir: string) => {
    const normalized = path.resolve(dir);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push(normalized);
  };

  // Common extension-relative paths. Ompcot's Rust side always sets
  // OMCOT_STATIC_DIR, so this fallback chain is only exercised in
  // weird dev scenarios (e.g. loading the extension directly via omp -e).
  addCandidate(path.resolve(__dirname, "public"));
  addCandidate(path.resolve(__dirname, "../public"));
  addCandidate(path.resolve(process.cwd(), "public"));

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }

  return path.resolve(process.cwd(), "public");
}
const SESSIONS_DIR = path.join(OMP_AGENT_ROOT, "sessions");
// TODO(rename->ompcot): directory `ompcot-instances` kept for backward compat — migrate to `ompcot-instances` once existing users are handled.
const INSTANCES_DIR = path.join(path.dirname(OMP_AGENT_ROOT), "ompcot-instances");

// Minimal single-process instance registry. We keep this so the frontend's
// `/api/instances` response reflects the running workspace without needing
// a Tauri invoke. Unlike the old mirror-server
// which scanned the whole INSTANCES_DIR (for tmux / standalone pi
// processes), we only ever write our own entry: Ompcot's Rust side
// manages all omp processes it spawns.
function registerInstance(port: number, sessionFile: string, cwd: string) {
  fs.mkdirSync(INSTANCES_DIR, { recursive: true });
  const info = { port, pid: process.pid, sessionFile, cwd, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(INSTANCES_DIR, `${process.pid}.json`), JSON.stringify(info));
}

function updateInstanceSession(sessionFile: string) {
  const file = path.join(INSTANCES_DIR, `${process.pid}.json`);
  if (!fs.existsSync(file)) return;
  try {
    const info = JSON.parse(fs.readFileSync(file, "utf8"));
    info.sessionFile = sessionFile;
    fs.writeFileSync(file, JSON.stringify(info));
  } catch {}
}

function getRunningInstances(): Array<{
  port: number;
  pid: number;
  sessionFile: string;
  cwd: string;
}> {
  if (!fs.existsSync(INSTANCES_DIR)) return [];
  const instances: Array<{ port: number; pid: number; sessionFile: string; cwd: string }> = [];
  for (const file of fs.readdirSync(INSTANCES_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(INSTANCES_DIR, file), "utf8"));
      // Check if process is still alive
      try {
        process.kill(info.pid, 0);
        instances.push(info);
      } catch {
        // Process dead — clean up stale file
        try {
          fs.unlinkSync(path.join(INSTANCES_DIR, file));
        } catch {}
      }
    } catch {}
  }
  return instances;
}

type GitBranchContextLike = {
  sessionManager?: {
    getEntries?: () => Array<{ type?: string; cwd?: string }>;
  };
} | null;

export function normalizeApiRoutePath(urlPath: string): string {
  return urlPath.split("?")[0] || "/";
}

export function resolveGitBranchCwd({
  foregroundPort,
  fallbackCwd,
  instances,
  latestCtx,
}: {
  foregroundPort: number | null;
  fallbackCwd: string;
  instances: Array<{ port: number; pid: number; sessionFile: string; cwd: string }>;
  latestCtx: GitBranchContextLike;
}): string {
  if (typeof foregroundPort === "number" && Number.isFinite(foregroundPort)) {
    const matchedWorkspace = instances.find((instance) => instance?.port === foregroundPort)?.cwd;
    if (typeof matchedWorkspace === "string" && matchedWorkspace.trim()) {
      return matchedWorkspace;
    }
  }

  if (latestCtx?.sessionManager?.getEntries) {
    try {
      const entries = latestCtx.sessionManager.getEntries();
      const sessionEntry = entries.find((e: { type?: string }) => e.type === "session");
      if (sessionEntry?.cwd) return sessionEntry.cwd;
    } catch {}
  }

  return fallbackCwd;
}

// MIME types for static file serving
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

// ─── Process-global server state ──────────────────────────────────────────────
//
// omp reloads the extension on every `new_session` / `switch_session` / `fork`:
// the old extension instance receives `session_shutdown`, the module is
// rebound, and the new instance receives `session_start`. If we closed the
// HTTP+WS server in `session_shutdown` and re-listened on `session_start`,
// the WebView (anchored at e.g. `http://localhost:3001`) would either:
//   - race against the slow `server.close()` and end up on PORT+1, OR
//   - just see a dead socket while close() drains active connections.
// Both manifest to the user as "create session does nothing".
//
// Fix: own the HTTP server, WS server, client set, and heartbeat at the
// process scope. We start them once (lazily on the first `session_start`)
// and keep them alive for the lifetime of the omp process. Each new extension
// instance just (re)publishes its `handleCommand` / `latestCtx` / event
// broadcaster into the global so the long-lived `wss.on("connection", …)`
// handler always dispatches through the *current* session's bindings.
// Cache key for parsed session file headers / metrics. We key on absolute
// path and invalidate on (mtimeMs, size). omp *appends* to JSONL files for the
// active session, so size grows monotonically until the session ends — this
// is sufficient to detect "needs reparse" without diffing content.
type SessionFileCacheEntry<T> = {
  mtimeMs: number;
  size: number;
  value: T;
};

// A unified handle to whichever underlying server is currently bound.
// Only one of `nodeServer` / `bunServer` is non-null at any time; the
// other fields (port / close) abstract over the differences so the rest
// of the code (lifecycle, instance registry, shutdown) doesn't need to
// branch on runtime.
type ServerHandle = {
  port: number;
  // Force-close everything, used in tests / hot reload — production never
  // calls this, the server lives for the omp process lifetime.
  close: () => void;
  // The native handle, for callers that genuinely need it (currently
  // only the `server.address()` peek in the re-register path).
  nodeServer: http.Server | null;
  bunServer: unknown | null;
};

// Unified WebSocket wrapper: either the `ws`-library WebSocket (node path)
// or Bun's `ServerWebSocket` (bun path). We only depend on the small
// surface used by the rest of this extension: send/close/readyState/ping,
// plus a synthetic `isAlive` flag for the heartbeat reaper.
//
// We keep this as a structural type rather than a wrapper class because
// the bun ServerWebSocket already exposes `.send(string)`, `.readyState`,
// `.ping()`, and `.close()` — they just lack `.terminate()` and the
// event-emitter `.on(...)` API. The wrapper closes that gap minimally.
interface RpcCommand {
  type: string;
  id?: string;
  apiKey?: string;
  confirmed?: boolean;
  cancelled?: boolean;
  customInstructions?: string;
  entryId?: string;
  images?: Array<{ data?: string; mimeType?: string }>;
  level?: string;
  message: string;
  modelId?: string;
  name?: string;
  outputPath?: string;
  provider?: string;
  sessionPath?: string;
  source?: string;
  streamingBehavior?: string;
  timedOut?: boolean;
  transportRequestId?: string;
  value?: string | boolean;
  [key: string]: unknown;
}

type UnifiedWS = {
  readyState: number;
  send: (data: string) => unknown;
  close: () => void;
  terminate: () => void;
  ping: () => void;
  isAlive?: boolean;
};

type EmbeddedServerGlobal = {
  server: ServerHandle | null;
  wss: WebSocketServer | null;
  clients: Set<UnifiedWS>;
  heartbeatTimer: NodeJS.Timeout | null;
  localUrl: string;
  lanUrl: string;
  // Re-published by every extension instance on session_start so the
  // connection handler dispatches to the new session's pi/ctx.
  handleCommand: ((ws: WebSocket, command: RpcCommand) => Promise<void>) | null;
  buildStateSnapshot: ((ctx: ExtensionContext) => Promise<unknown>) | null;
  getLatestCtx: (() => ExtensionContext | null) | null;
  // Cached process-scoped references that don't change across sessions.
  //
  // `ModelRegistry` (and its `AuthStorage`) are owned by the omp process,
  // not by any one session: `~/.omp/agent/auth.json` is shared across every
  // `new_session` / `switch_session` / `fork` and every extension reload
  // oh-my-omp does. The auth Settings panel (`list_auth_status` /
  // `set_api_key` / `remove_api_key`) only needs the registry — gating it
  // behind the per-session `latestCtx` caused "Failed to load providers"
  // whenever the user opened Settings → Authentication during the brief
  // window before omp fires its first `session_start`, or in the gap
  // between sessions during a reload. We cache the first registry we see
  // here and prefer it (when present) over `latestCtx?.modelRegistry`.
  modelRegistry: ModelRegistry | null;
  // The freshest `ExtensionAPI` (i.e. `omp`) reference, re-published on
  // every `session_start`. Command handlers MUST go through this getter
  // instead of capturing the `omp` parameter from `export default function`
  // in their closure: oh-my-omp invalidates the old `omp` after `new_session`,
  // `switch_session`, `fork`, and `reload`, and any session-bound call on
  // a stale `omp` (e.g. `omp.setThinkingLevel`, `omp.sendUserMessage`,
  // `omp.setSessionName`) throws an error that oh-my-omp surfaces as an
  // `extension_error` event — which the frontend renders as a red error
  // bubble in chat. Routing through `getApi()` guarantees we always hit
  // the current session's `omp`.
  getAomp: (() => ExtensionAPI | null) | null;
  // Process-scoped parse caches. Live across extension reloads (which would
  // otherwise wipe per-extension `Map`s on every new_session). Without these,
  // `/api/sessions` re-reads + re-parses the JSONL header of every session
  // file in `~/.omp/agent/sessions/**` on every request, which dominates
  // launcher / sidebar warmup latency for users with many sessions.
  sessionHeaderCache: Map<string, SessionFileCacheEntry<unknown>>;
  sessionMetricsCache: Map<string, SessionFileCacheEntry<unknown>>;
  // Idempotence flag for the process-scoped Settings.onEffectiveChange
  // subscription (see startServer): the extension reloads on every
  // new_session / switch_session / fork, and each reload must not add
  // another listener to the process-wide settings singleton.
  settingsChangeSubscribed: boolean;
  // Idempotence flag for the process-scoped AgentRegistry.onChange
  // subscription backing the `agents_changed` push event (see startServer).
  agentsChangeSubscribed: boolean;
  // Idempotence flag for the one-shot OMCOT_DEBUG_NAMESPACE startup dump.
  namespaceDebugLogged: boolean;
  // Process-scoped cache for the dynamically imported MCP management module
  // (`@oh-my-pi/*-coding-agent/mcp`). The promise memo survives extension
  // reloads; a resolved `null` (module unreachable) is cached too so repeated
  // mcp.* RPCs do not re-attempt resolution on every call.
  mcpModuleCache: { promise: Promise<McpModuleLike | null> | null };
  // Last MCP connection-status event per server (from the live manager's
  // addConnectionStatusListener). `getConnectionStatus` cannot express
  // "failed" / "reconnecting", so we overlay this map on top of it.
  mcpStatusByServer: Map<string, string>;
  // Idempotence flag for the process-scoped MCP status listener attach.
  mcpStatusListenerAttached: boolean;
  // ─── Interactive-UI bridge (tier-1 `ui_response`) ─────────────────────────
  //
  // omp's RPC mode routes `ctx.ui.select/confirm/input/editor` to
  // `extension_ui_request` frames on the RPC stdio channel and waits for
  // `extension_ui_response` frames from the RPC client. In Ompcot the WebView
  // is NOT that client — the embedded server is the only UI host — so those
  // requests would hang until timeout. We instead patch the *shared*
  // RpcExtensionUIContext instance (the same object every extension ctx and
  // the ask tool receive; verified in omp 18.3 runner.ts `ui: this.#uiContext`)
  // to broadcast requests over our WS and resolve them via the
  // `ui_response` / `ui_cancel` commands. The patch is per-instance
  // idempotent: `patchedUiContext` records which instance we already wrapped
  // so extension reloads (new_session / switch_session / fork) don't
  // double-wrap, and `uiPendingRequests` survives those reloads so a reply
  // racing a session switch still resolves.
  uiPendingRequests: Map<string, PendingUiRequest>;
  patchedUiContext: unknown | null;
  uiRequestCounter: number;
};

// One in-flight interactive-UI dialog originated from a patched
// RpcExtensionUIContext method. `resolve` settles the caller's promise with
// the runtime's own default semantics (select/input/editor → undefined,
// confirm → false) whenever the dialog is cancelled or times out.
type PendingUiRequest = {
  kind: "select" | "confirm" | "input" | "editor";
  resolve: (value: unknown) => void;
  timer: NodeJS.Timeout | null;
  cleanup: () => void;
  // F3 (P1): verbatim replayable copy of the broadcast request frame. A
  // dialog is broadcast exactly once at creation; if the WebView reloads or
  // the WS drops before answering, the pending promise would be stranded.
  // We keep the frame so (re)connecting clients can be re-served the dialog
  // (same id → frontend dedupes, so re-broadcasts never stack dialogs).
  frame: Record<string, unknown>;
  // F3: session this dialog belongs to (session file id, see
  // currentSessionIdFromCtx). Replay only hands a dialog back to clients
  // that are looking at the session it came from.
  sessionKey: string | null;
};

const EMBEDDED_GLOBAL_KEY = "__ompcotEmbeddedServer__";

interface SessionMetrics {
  id: string;
  title: string;
  cwd: string;
  timestamp: Date | null;
  lastActive: Date | null;
  model: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolCostByName: Record<string, number>;
}

// Normalize an unknown thrown value to a human-readable message.
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

// ─── Thinking levels (per-model capability) ──────────────────────────────────
//
// omp bakes each model's thinking ladder into `model.thinking.efforts`
// (pi-catalog `ThinkingConfig`: "Supported user-facing efforts, ordered
// least → most intensive"). Real ladders are sparse and model-specific —
// e.g. z-ai/glm-5.3 → ["low","high","max"], z-ai/glm-5v-turbo →
// ["minimal","low","medium","high","xhigh"] — and the TUI's thinking picker
// resolves from exactly this field (ModelControls.getAvailableThinkingLevels
// → pi-catalog getSupportedEfforts(model) → model.thinking.efforts).
//
// The pi-catalog type is explicit that `thinking.efforts` is never empty: "a
// reasoning model without a controllable effort surface carries
// `thinking: undefined`". So an absent `thinking` (or a non-array/empty
// `efforts`) on a REACHABLE model object is not doubt — it is the catalog
// saying "no user-facing depth control". The contract with the GUI:
//   - `[]`                → model has NO controllable thinking depth (chip disabled)
//   - fallback 5-level set → model object unreachable (no ctx.model / registry
//                           lookup failed) — we simply don't know
//
// The extension API only exposes getThinkingLevel/setThinkingLevel — no
// per-model level getter — so we read the baked field off the model object
// directly, feature-detecting every step. `xhigh`/`max` appear ONLY when the
// model's own metadata lists them.

// Canonical effort order, least → most intensive (pi-catalog `Effort`).
const THINKING_EFFORT_ORDER: readonly string[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// Today's cycle set — the safe default ONLY when the model surface is
// unreachable (we don't know the model at all).
const FALLBACK_THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high"];

// Whether the model reports a reasoning surface (`model.reasoning === true`).
// Anything else (false, undefined, unreachable) reports false; the GUI uses
// this only as a secondary signal next to `thinkingLevels`.
function modelSupportsReasoning(model: unknown): boolean {
  return (
    !!model && typeof model === "object" && (model as { reasoning?: unknown }).reasoning === true
  );
}

// Resolve the thinking levels the CURRENT model supports, ordered least →
// most intensive with "off" first. Never throws.
function resolveThinkingLevels(model: unknown): string[] {
  if (!model || typeof model !== "object") {
    // Model object unreachable (no ctx.model / registry lookup failed) —
    // we simply don't know → today's cycle set.
    return [...FALLBACK_THINKING_LEVELS];
  }
  const m = model as { thinking?: { efforts?: unknown } };
  const efforts = m.thinking?.efforts;
  if (!Array.isArray(efforts) || efforts.length === 0) {
    // Per the pi-catalog contract, a model without a controllable effort
    // surface carries `thinking: undefined` (efforts is never empty on
    // models that DO have a ladder). EMPTY array = no user-facing depth
    // control — the GUI disables the chip on this.
    return [];
  }
  const levels = efforts.filter(
    (e): e is string => typeof e === "string" && THINKING_EFFORT_ORDER.includes(e),
  );
  if (levels.length === 0) return [];
  levels.sort((a, b) => THINKING_EFFORT_ORDER.indexOf(a) - THINKING_EFFORT_ORDER.indexOf(b));
  return ["off", ...levels];
}

// ─── Provider auth status (Settings → API keys panel) ────────────────────────
//
// omp 18.3.0 removed `ModelRegistry.getProviderAuthStatus` AND
// `ModelRegistry.getProviderDisplayName`, which crashed the whole panel with
// "getProviderAuthStatus is not a function". This helper rebuilds the status
// from the 18.3.0 surface (`hasConcreteAuth`, `hasCommandBackedApiKey`,
// `authStorage.keys.source`, `authStorage.oauth.identity`). Every probe is
// feature-detected and failure-isolated so one missing or misbehaving method
// degrades to a plain value instead of throwing.
//
// `source` is mapped onto the vocabulary `public/app-settings-editors.js`
// renders (describeAuthStatus):
//   "stored"      → credential entry (api_key or OAuth) — enables the Remove button
//   "environment" → provider env var (`label` carries the variable name)
//   "runtime"     → runtime --api-key override
//   "command"     → models.yml `!command`-backed key (never removable here)
//   "keyless"     → local endpoint that needs no auth
//   "config"      → models.yml `providers.<name>.apiKey`
//   "configured" | "unknown" | "error" → nothing finer derivable

interface ProviderAuthStatus {
  provider: string;
  displayName?: string;
  configured: boolean;
  source?: string;
  label?: string;
}

function computeProviderAuthStatus(registry: ModelRegistry, provider: string): ProviderAuthStatus {
  const reg = registry as unknown as Record<string, unknown>;
  const authStorage = reg.authStorage as Record<string, unknown> | undefined;

  // configured: hasConcreteAuth(provider) is omp 18.3's "a concrete auth
  // source exists" signal. Older surfaces fall back to a per-model
  // hasConfiguredAuth probe, then to plain false.
  let configured = false;
  try {
    if (typeof reg.hasConcreteAuth === "function") {
      configured = (reg.hasConcreteAuth as (p: string) => boolean)(provider) === true;
    } else if (
      typeof reg.hasConfiguredAuth === "function" &&
      typeof reg.getProviderModels === "function"
    ) {
      const model = ((reg.getProviderModels as (p: string) => unknown[])(provider) ?? [])[0];
      if (model !== undefined && model !== null) {
        configured = (reg.hasConfiguredAuth as (m: unknown) => boolean)(model) === true;
      }
    }
  } catch {
    configured = false;
  }

  let source: string | undefined;
  let label: string | undefined;
  try {
    // Command-backed key (models.yml `!command`): checked first — the key is
    // minted by a program, not stored, so the panel must not offer Remove.
    if (
      typeof reg.hasCommandBackedApiKey === "function" &&
      (reg.hasCommandBackedApiKey as (p: string) => boolean)(provider) === true
    ) {
      source = "command";
    }
    if (!source && authStorage) {
      // keys.source(): the credential cascade's winning leg (runtime >
      // config > oauth > stored api_key > env), synchronous, refresh-free.
      const keys = authStorage.keys as Record<string, unknown> | undefined;
      if (keys && typeof keys.source === "function") {
        const origin = (
          keys.source as (p: string) => { kind?: unknown; envVar?: unknown } | undefined
        )(provider);
        if (origin && typeof origin === "object" && typeof origin.kind === "string") {
          if (origin.kind === "env") {
            source = "environment";
            if (typeof origin.envVar === "string") label = origin.envVar;
          } else if (origin.kind === "oauth" || origin.kind === "api_key") {
            source = "stored";
          } else {
            source = origin.kind; // "runtime" | "config"
          }
        }
      }
      // Fallback probe when keys.source is unavailable: inspect the stored
      // credential entry shape directly (OAuth vs API key).
      if (!source) {
        const credentials = authStorage.credentials as Record<string, unknown> | undefined;
        const get = credentials?.get as ((p: string) => { type?: unknown } | undefined) | undefined;
        const entry = typeof get === "function" ? get.call(credentials, provider) : undefined;
        if (
          entry &&
          typeof entry === "object" &&
          (entry.type === "oauth" || entry.type === "api_key")
        ) {
          source = "stored";
        }
      }
    }
    if (!source && configured && authStorage) {
      // Keyless local endpoint (Ollama, llama.cpp, …): configured, but there
      // is no credential to show or manage.
      const keys = authStorage.keys as Record<string, unknown> | undefined;
      const keyless = keys?.keyless as ((p: string) => boolean) | undefined;
      if (typeof keyless === "function" && keyless.call(keys, provider) === true)
        source = "keyless";
    }
    // Label for stored OAuth logins: the account email/id via the read-only
    // identity lookup (no token refresh, no token material).
    if (source === "stored" && label === undefined && authStorage) {
      const oauth = authStorage.oauth as Record<string, unknown> | undefined;
      const identity = oauth?.identity as (
        p: string,
      ) => { email?: unknown; accountId?: unknown } | undefined | null;
      if (typeof identity === "function") {
        const id = identity.call(oauth, provider);
        if (id && typeof id === "object") {
          if (typeof id.email === "string" && id.email) label = id.email;
          else if (typeof id.accountId === "string" && id.accountId) label = id.accountId;
        }
      }
    }
  } catch {
    source = undefined;
    label = undefined;
  }
  if (!source) source = configured ? "configured" : "unknown";

  // displayName: no registry API for this survives in 18.3.0 — omit and let
  // the frontend fall back to the raw provider id.
  let displayName: string | undefined;
  try {
    if (typeof reg.getProviderDisplayName === "function") {
      const name = (reg.getProviderDisplayName as (p: string) => string)(provider);
      if (typeof name === "string" && name) displayName = name;
    }
  } catch {
    displayName = undefined;
  }

  return { provider, displayName, configured, source, label };
}

// ─── omp agent settings surface ──────────────────────────────────────────────
//
// Structural types for the omp runtime's Settings singleton and package
// namespace. We deliberately do not value-import `@oh-my-pi/omp-coding-agent`
// (the bundle keeps it external): the ExtensionAPI exposes the package
// namespace as `omp.pi`, and every member below is optional so a mismatched
// embedded omp version degrades to the CLI fallback instead of crashing the
// extension. This is a source-level contract, not a documented API.

type OmpSettingsInstanceLike = {
  get?: (path: string) => unknown;
  set?: (path: string, value: unknown) => unknown;
  onEffectiveChange?: (listener: (path: string, value: unknown) => void) => () => void;
  reloadFromDisk?: () => unknown;
  getAgentDir?: () => string;
  list?: () => unknown;
  entries?: () => unknown;
  // Documented in the SDK source: forces the debounced global-layer save to
  // disk. Awaited after set() so a PUT response means "persisted", not
  // "queued" (a quick process exit would otherwise drop the write).
  flush?: () => void | Promise<void>;
};

type OmpSettingsStaticLike = {
  instance?: OmpSettingsInstanceLike | null;
  SETTINGS_SCHEMA?: Record<string, unknown>;
};

// ─── Agent roster + MCP surfaces (B1/B2) ──────────────────────────────────────
//
// Structural types for the omp runtime's AgentRegistry (root export) and the
// MCP management module (`@oh-my-pi/pi-coding-agent/mcp` subpath). Like the
// Settings surface above, every member is optional: a mismatched embedded omp
// version degrades to `{agents: [], available: false}` / config-file CRUD
// instead of crashing the extension.

type AgentRefLike = {
  id?: unknown;
  displayName?: unknown;
  kind?: unknown;
  parentId?: unknown;
  status?: unknown;
  sessionFile?: unknown;
};

type AgentRegistryLike = {
  list?: () => unknown[];
  isRunning?: (ref: AgentRefLike) => boolean;
  onChange?: (listener: (event: unknown) => void) => unknown;
};

type McpServerConfigLike = {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
};

type McpSourceMetaLike = {
  provider?: string;
  providerName?: string;
  path?: string;
  level?: string;
};

type McpConfigFileLike = {
  $schema?: string;
  mcpServers?: Record<string, McpServerConfigLike>;
  disabledServers?: string[];
  enabledServers?: string[];
};

type McpManagerLike = {
  getConnectionStatus?: (name: string) => string;
  getAllServerNames?: () => string[];
  getTools?: () => Array<{ name?: string; details?: { serverName?: string } }>;
  connectServers?: (
    configs: Record<string, McpServerConfigLike>,
    sources: Record<string, McpSourceMetaLike>,
    onStatus?: (event: unknown) => void,
    startupTimeoutMs?: number,
  ) => Promise<unknown>;
  disconnectServer?: (name: string) => Promise<void>;
  reconnectServer?: (name: string, options?: { manual?: boolean }) => Promise<unknown>;
  addConnectionStatusListener?: (
    listener: (event: { type?: string; serverName?: string } & Record<string, unknown>) => void,
  ) => unknown;
};

type McpModuleLike = {
  loadAllMCPConfigs?: (
    cwd: string,
    options?: Record<string, unknown>,
  ) => Promise<{
    configs?: Record<string, McpServerConfigLike>;
    sources?: Record<string, McpSourceMetaLike>;
  } | null>;
  readMCPConfigFile?: (filePath: string) => Promise<McpConfigFileLike>;
  writeMCPConfigFile?: (filePath: string, config: McpConfigFileLike) => Promise<void>;
  listMCPServers?: (filePath: string) => Promise<string[]>;
  addMCPServer?: (filePath: string, name: string, config: McpServerConfigLike) => Promise<void>;
  updateMCPServer?: (filePath: string, name: string, config: McpServerConfigLike) => Promise<void>;
  removeMCPServer?: (filePath: string, name: string) => Promise<void>;
  setMcpServerEnabled?: (options: {
    userPath: string;
    projectPath: string;
    sourcePath?: string;
    name: string;
    enabled: boolean;
  }) => Promise<void>;
  validateServerName?: (name: string) => string | undefined;
  validateServerConfig?: (name: string, config: McpServerConfigLike) => string[];
  MCPManager?: { instance?: () => McpManagerLike | undefined | null };
};

// Frozen `mcp.list` server row (frontend contract — do not reshape).
type McpServerRow = {
  name: string;
  type: string;
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  source: string;
  sourcePath: string;
  writable: boolean;
  status: "connected" | "connecting" | "reconnecting" | "failed" | "disconnected" | "unknown";
  toolCount?: number;
};

type OmpPackageNamespaceLike = {
  Settings?: OmpSettingsStaticLike;
  settings?: OmpSettingsInstanceLike;
  AgentRegistry?: { global?: () => AgentRegistryLike | null } | null;
};

type OmpSettingMeta = {
  type: string;
  description: string;
  redacted: boolean;
  hasValue: boolean;
  value?: unknown;
};

type AgentSettingRow = {
  key: string;
  value: unknown;
  type: string;
  description: string;
  redacted: boolean;
};

// Keys whose values must never be echoed back to a client. The CLI catalog
// flags these via `redacted: true`; this heuristic additionally covers the
// in-process enumeration path (and any key the catalog forgot to flag).
function isCredentialLikeKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k === "auth.broker.token" ||
    k.endsWith("apikey") || // *.apiKey
    k.includes("token") || // *token*
    k.includes("password") || // *password*
    k.includes("secret") // *secret*
  );
}

// CLI fallbacks shell out to the embedded omp binary itself: this extension
// runs *inside* that process. `process.execPath` is the omp executable for
// compiled builds, but for shim-style installs (e.g. `bun i -g` bins) it is
// the *runtime* (bun.exe) with the omp entry script at process.argv[1] —
// re-compose the command line so both layouts work.
const OMP_CLI_TIMEOUT_MS = 15000;

// `omp usage --json` fans out to provider usage APIs over the network — give
// it more headroom than a local config read.
const OMP_USAGE_TIMEOUT_MS = 45000;

// `omp login <provider>` is a terminal OAuth flow: it can wait on a browser
// round-trip plus pasted codes. Long leash; the GUI shows a spinner.
const OMP_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

// Login output is echoed to the GUI; cap the tail we hand back.
const LOGIN_OUTPUT_TAIL_MAX_CHARS = 4096;

function resolveOmpCliInvocation(): { cmd: string; prefix: string[] } {
  // Preferred: the Rust manager passes the exact omp binary it spawned via
  // env (works for both compiled binaries and shim installs).
  const fromEnv = process.env.OMPCOT_OMP_BIN?.trim();
  if (fromEnv) {
    return { cmd: fromEnv, prefix: [] };
  }
  const argv1 = process.argv[1];
  if (argv1 && /\.(?:[cm]?js|[cm]?ts)$/i.test(argv1)) {
    // Shim layout: <runtime> <omp-entry.js> ...user args
    return { cmd: process.execPath, prefix: [argv1] };
  }
  // Compiled layout: process.execPath IS the omp binary.
  return { cmd: process.execPath, prefix: [] };
}

function execOmpCli(args: string[], timeoutMs: number): Promise<string> {
  const { cmd, prefix } = resolveOmpCliInvocation();
  return execFileText(cmd, [...prefix, ...args], timeoutMs);
}

function execFileText(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(typeof stdout === "string" ? stdout : String(stdout ?? ""));
    });
  });
}

// ─── omp CLI helpers for the GUI feature RPCs ─────────────────────────────────
//
// `execOmpCli` resolves only on success (exit 0) and returns stdout alone.
// Two things the new RPCs need that it can't express:
//   - the stderr tail for error envelopes (`get_usage`),
//   - combined stdout+stderr plus the real exit code (`run_omp_login`), where
//     a non-zero exit is a *result*, not a failure of the helper itself.
//
// execFile errors carry `code` (exit status), `stderr`, and `stdout` fields.

const CLI_ERROR_TAIL_MAX_CHARS = 2000;

function cliErrorTail(e: unknown, maxChars = CLI_ERROR_TAIL_MAX_CHARS): string {
  if (e && typeof e === "object" && "stderr" in e) {
    const stderr = (e as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      return `stderr: ${tailText(stderr, maxChars)}`;
    }
  }
  if (e && typeof e === "object" && "message" in e) {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return tailText(msg, maxChars);
  }
  return tailText(String(e ?? ""), maxChars);
}

function tailText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…${trimmed.slice(trimmed.length - maxChars)}`;
}

// F8/F10 knobs for `runOmpCliCaptured`:
//   - KILL: terminate the whole process tree on timeout, escalate to a
//     forced kill after the grace window, and bound finalization so the
//     promise always resolves shortly after the timeout no matter what the
//     OS does with the child.
//   - TAIL: once the output cap is hit, retain the LAST bytes instead of
//     the first, so late failure text (where login errors explain
//     themselves) survives in the returned tail.
const CLI_KILL_GRACE_MS = 5000;
const CLI_FINALIZE_BOUND_MS = 10000;
const CLI_ROLLING_TAIL_BYTES = 16 * 1024;

// Kill a child AND its process tree. Windows has no signal-based tree kill;
// `taskkill /T /F` is the only reliable reach into grandchildren. POSIX: we
// spawn without a new process group (detached:false), so killing `-pgid`
// would take *us* down too — instead signal the child directly and, best
// effort, its direct children via `pkill -P` (grandchildren are reaped by
// the forced escalation because orphans get re-parented as they exit).
function killChildTree(
  child: { pid?: number; kill: (signal?: string) => boolean },
  force: boolean,
) {
  const pid = child.pid;
  if (process.platform === "win32") {
    if (typeof pid === "number" && pid > 0) {
      try {
        execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        return;
      } catch {}
    }
    try {
      child.kill();
    } catch {}
    return;
  }
  try {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  } catch {}
  if (typeof pid === "number" && pid > 0) {
    try {
      const reaper = spawn("pkill", [force ? "-KILL" : "-TERM", "-P", String(pid)], {
        stdio: "ignore",
      });
      reaper.unref();
    } catch {}
  }
}

// Spawn the embedded omp CLI with stdin detached and capture combined output.
// Used by `run_omp_login`: the OAuth flow is a terminal interaction we do NOT
// emulate — if it needs a TTY it exits non-zero and that surfaces in `output`
// for the GUI to explain. Resolves with the real exit code (never rejects for
// a non-zero exit; only for spawn failures / timeout).
type OmpCliRunResult = {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
};

function runOmpCliCaptured(
  args: string[],
  timeoutMs: number,
  maxOutputBytes = 256 * 1024,
): Promise<OmpCliRunResult> {
  const { cmd, prefix } = resolveOmpCliInvocation();
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [...prefix, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
      });
    } catch (e: unknown) {
      resolve({
        exitCode: null,
        output: `Failed to launch omp: ${errMessage(e)}`,
        timedOut: false,
      });
      return;
    }

    // F10: bounded rolling tail. Below the cap we keep everything; the
    // first chunk that would overflow switches us to retaining only the
    // LAST CLI_ROLLING_TAIL_BYTES, so the end of the output — where login
    // failures print their actionable text — always survives in `output`.
    const chunks: Buffer[] = [];
    let buffered = 0;
    let rolling = false;
    const append = (chunk: Buffer) => {
      if (!rolling && buffered + chunk.length > maxOutputBytes) rolling = true;
      chunks.push(chunk);
      buffered += chunk.length;
      if (rolling) {
        while (buffered > CLI_ROLLING_TAIL_BYTES && chunks.length > 1) {
          buffered -= chunks[0].length;
          chunks.shift();
        }
      }
    };

    let timedOut = false;
    let settled = false;
    let escalateTimer: NodeJS.Timeout | null = null;
    let boundTimer: NodeJS.Timeout | null = null;

    // Release the pipe handles so a child that refuses to die cannot hold
    // the event loop open after we've stopped caring (part of F8 reaping).
    const detachStreams = () => {
      try {
        child.stdout?.destroy();
      } catch {}
      try {
        child.stderr?.destroy();
      } catch {}
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (escalateTimer) clearTimeout(escalateTimer);
      if (boundTimer) clearTimeout(boundTimer);
      const combined = chunks.length ? Buffer.concat(chunks).toString("utf8") : "(no output)";
      resolve({
        exitCode,
        output: tailText(combined, LOGIN_OUTPUT_TAIL_MAX_CHARS),
        // `timedOut` reflects OUR patience, not the child's fate: it stays
        // true even if the child exits 0 while being torn down, and the
        // eventual (possibly late) exit code never un-flags it.
        timedOut,
      });
    };

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      setTimeout(() => {
        timedOut = true;
        // F8: take down the child AND its process tree. A bare SIGTERM +
        // resolve-on-close could hang forever when the child (or one of its
        // descendants, e.g. a browser helper spawned by an OAuth flow)
        // ignores the signal or inherits a leaked pipe.
        killChildTree(child, false);
        // Escalate to a forced kill after the grace window.
        escalateTimer = setTimeout(() => killChildTree(child, true), CLI_KILL_GRACE_MS);
        // Hard bound: resolve within ~CLI_FINALIZE_BOUND_MS of the timeout
        // no matter what the OS reports. After that we no longer care
        // about the child: detach pipes and unref it so a straggler can't
        // pin the event loop (the `close` listener still fires whenever it
        // finally exits, and the settled guard makes that a no-op).
        boundTimer = setTimeout(() => {
          detachStreams();
          try {
            child.unref();
          } catch {}
          finish(null);
        }, CLI_FINALIZE_BOUND_MS);
        escalateTimer.unref?.();
        boundTimer.unref?.();
      }, timeoutMs);
    }

    child.stdout?.on("data", (chunk: Buffer) => append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk));
    child.on("error", (e: Error) => {
      append(Buffer.from(`\n[spawn error] ${e.message}\n`));
      finish(null);
    });
    child.on("close", (code: number | null) => finish(code));
  });
}

// ─── External terminal launch (audit A2) ──────────────────────────────────────
//
// Opens a terminal window running `omp` in `dir` (user's PATH — the legacy
// "open in external terminal" affordance). Security properties:
//   - No shell string building anywhere: every child process is spawned with
//     an argv array, so the caller-controlled directory path is never
//     interpreted as shell metacharacters.
//   - On macOS the path reaches the terminal's shell via AppleScript
//     `on run argv` + `quoted form of` — osascript receives it as a literal
//     argument and does the shell-quoting itself.
//   - The result reports the real outcome; callers must not claim success
//     when every launch attempt failed.
type TerminalOpenResult = { ok: true } | { ok: false; error: string };

const TERMINAL_LAUNCH_TIMEOUT_MS = 15000;

async function openTerminalInDirectory(dir: string): Promise<TerminalOpenResult> {
  if (process.platform === "darwin") {
    // `do script` runs its argument as a shell command inside Terminal; the
    // command string is composed *inside AppleScript* from the literal argv
    // entry, so `dir` can't break out of quoting.
    const viaTerminal = [
      "on run argv",
      '  tell application "Terminal"',
      '    do script "cd " & quoted form of item 1 of argv & " && omp"',
      "    activate",
      "  end tell",
      "end run",
    ].join("\n");
    const viaITerm2 = [
      "on run argv",
      '  tell application "iTerm2"',
      '    create window with default profile command "cd " & quoted form of item 1 of argv & " && omp"',
      "  end tell",
      "end run",
    ].join("\n");
    try {
      await execFileText("osascript", ["-e", viaTerminal, "--", dir], TERMINAL_LAUNCH_TIMEOUT_MS);
      return { ok: true };
    } catch (terminalErr: unknown) {
      try {
        await execFileText("osascript", ["-e", viaITerm2, "--", dir], TERMINAL_LAUNCH_TIMEOUT_MS);
        return { ok: true };
      } catch (itermErr: unknown) {
        return {
          ok: false,
          error: `Failed to open a terminal (Terminal: ${errMessage(terminalErr)}; iTerm2: ${errMessage(itermErr)})`,
        };
      }
    }
  }

  if (process.platform === "win32") {
    // `cmd /k omp` in a new console window: `cwd` pins the directory without
    // the path ever appearing on a shell command line. `detached: true` gives
    // the child its own console; stdio ignored keeps it independent of us.
    return await new Promise<TerminalOpenResult>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn("cmd.exe", ["/k", "omp"], {
          cwd: dir,
          detached: true,
          stdio: "ignore",
          shell: false,
        });
      } catch (e: unknown) {
        resolve({ ok: false, error: errMessage(e) });
        return;
      }
      child.on("error", (e: Error) => resolve({ ok: false, error: errMessage(e) }));
      child.once("spawn", () => resolve({ ok: true }));
      child.unref();
    });
  }

  // No terminal-launch path for this platform — report failure honestly
  // instead of pretending the workspace was opened.
  return {
    ok: false,
    error: `Opening an external terminal is not supported on this platform (${process.platform})`,
  };
}

function getOrCreateGlobalState(): EmbeddedServerGlobal {
  const g = globalThis as Record<string, unknown>;
  if (!g[EMBEDDED_GLOBAL_KEY]) {
    g[EMBEDDED_GLOBAL_KEY] = {
      server: null,
      wss: null,
      clients: new Set<UnifiedWS>(),
      heartbeatTimer: null,
      localUrl: "",
      lanUrl: "",
      handleCommand: null,
      buildStateSnapshot: null,
      getLatestCtx: null,
      getAomp: null,
      modelRegistry: null,
      sessionHeaderCache: new Map<string, SessionFileCacheEntry<unknown>>(),
      sessionMetricsCache: new Map<string, SessionFileCacheEntry<unknown>>(),
      settingsChangeSubscribed: false,
      agentsChangeSubscribed: false,
      namespaceDebugLogged: false,
      mcpModuleCache: { promise: null },
      mcpStatusByServer: new Map<string, string>(),
      mcpStatusListenerAttached: false,
      uiPendingRequests: new Map<string, PendingUiRequest>(),
      patchedUiContext: null,
      uiRequestCounter: 0,
    } as EmbeddedServerGlobal;
  }
  return g[EMBEDDED_GLOBAL_KEY] as EmbeddedServerGlobal;
}

export default function (omp: ExtensionAPI) {
  const globalState = getOrCreateGlobalState();

  // Store latest context reference for use in command handlers
  let latestCtx: ExtensionContext | null = null;

  // ═══════════════════════════════════════
  // Always resolve the freshest `omp` from globalState before calling any
  // session-bound API.
  //
  // oh-my-omp invalidates the captured `omp` after `new_session`,
  // `switch_session`, `fork`, and `reload`. If a WS command (e.g.
  // `cycle_thinking_level`) is dispatched through a closure that captured
  // the *old* `omp` — for example because `globalState.handleCommand` was
  // re-published a tick later than expected — calling
  // `oldOMP.setThinkingLevel()` etc. throws "This extension ctx is stale
  // after session replacement or reload". oh-my-omp surfaces that throw as
  // an `extension_error` event, which the frontend renders as a red error
  // bubble in chat (`public/app.js` `extension_error` case).
  //
  // Routing through `currentOMP()` guarantees the call is dispatched to
  // whichever extension instance most recently received `session_start`
  // (and thus owns the live, non-stale `omp` for the active session).
  // Returns `null` only during the brief window between an old instance's
  // `session_shutdown` and the new instance's `session_start`; callers
  // must treat that as "no active session".
  function currentOMP(): ExtensionAPI | null {
    // `getAomp` is the getter actually published on globalState (:2981);
    // `getApi` is kept as a legacy fallback from the pi→omp rename (d4cb8b0),
    // which renamed the declaration but not every reader.
    return globalState.getAomp?.() ?? globalState.getApi?.() ?? null;
  }

  // ═══════════════════════════════════════
  // Helper: send to one client
  //
  // Accepts either a `ws.WebSocket` or a Bun `ServerWebSocket` — both
  // expose `.send(string)` and `.readyState`. We hard-code the OPEN
  // constant (1) instead of referencing `WebSocket.OPEN`, because on the
  // Bun path the `ws` library isn't actually live (just imported for
  // types) and pulling its constants would defeat the whole point.
  // ═══════════════════════════════════════
  const WS_OPEN = 1;
  const PROTOCOL_VERSION = 1;
  const workspaceId = `workspace:${process.cwd()}`;

  function currentSessionIdFromCtx(ctx: ExtensionContext | null): string | null {
    if (!ctx) return null;
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (typeof sessionFile === "string" && sessionFile.trim()) return sessionFile;
    } catch {}
    try {
      const entries = ctx.sessionManager.getEntries();
      const sessionEntry = entries.find(
        (e: { type?: string; id?: unknown }) => e?.type === "session" && typeof e?.id === "string",
      );
      if (sessionEntry?.id) return sessionEntry.id;
    } catch {}
    return null;
  }

  function withRouteMeta(data: unknown) {
    const currentCtx = globalState.getLatestCtx?.() ?? latestCtx;
    const sessionId = currentSessionIdFromCtx(currentCtx);
    const extra = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    return {
      protocolVersion: PROTOCOL_VERSION,
      workspaceId,
      sessionId: sessionId || undefined,
      port: globalState.server?.port || PORT,
      ...extra,
    };
  }

  function sendTo(ws: UnifiedWS, data: unknown) {
    if (ws.readyState === WS_OPEN) {
      try {
        ws.send(JSON.stringify(withRouteMeta(data)));
      } catch {}
    }
  }

  // ═══════════════════════════════════════
  // Helper: broadcast to all clients
  // ═══════════════════════════════════════
  function broadcast(data: unknown) {
    const json = JSON.stringify(withRouteMeta(data));
    for (const client of globalState.clients) {
      if (client.readyState === WS_OPEN) {
        try {
          client.send(json);
        } catch {}
      }
    }
  }

  // NOTE: we intentionally do NOT close the HTTP/WS server on
  // `session_shutdown`. The server is owned by `globalState` and lives for
  // the whole omp process lifetime — see the comment on `EmbeddedServerGlobal`
  // above for why. Per-session cleanup (clearing context, unregistering the
  // instance entry) happens in the `session_shutdown` handler instead.

  // ═══════════════════════════════════════
  // Interactive-UI bridge (tier-1 `ui_response`)
  // ═══════════════════════════════════════
  //
  // How omp natively moves these dialogs (verified against omp 18.3.0 source,
  // src/modes/rpc/rpc-mode.ts): `ctx.ui.select/confirm/input/editor` create an
  // id, park a resolver in the mode's `pendingExtensionRequests` map, and
  // `output()` an `extension_ui_request` frame on the RPC stdio channel; the
  // RPC client answers with an `extension_ui_response` frame
  // ({id, value} | {id, confirmed} | {id, cancelled, timedOut?}) that
  // `dispatchRpcControlFrame` routes back to the resolver.
  //
  // Ompcot's WebView is not that RPC client, so in our topology those frames
  // go to the Rust manager's pipe and die there — every ask/select would hang
  // until the dialog's timeout. The fix: patch the shared UI-context instance
  // (runner.ts hands the SAME object to every extension ctx and the ask tool)
  // so the four dialog methods broadcast verbatim `extension_ui_request`
  // frames to the WebView and resolve through our `ui_response` /
  // `ui_cancel` commands instead. Fire-and-forget `notify` is teed (original
  // stdio frame + WS broadcast) since it needs no answer.
  //
  // Semantics mirrored from rpc-mode.ts so extension/ask-tool callers can't
  // tell the difference: timeout resolves the default (undefined / false) and
  // fires `dialogOptions.onTimeout`; `signal` abort cancels with the default
  // and emits a `{method:"cancel", targetId}` frame; cancelled responses
  // resolve the default for the kind.

  function nextUiRequestId(): string {
    globalState.uiRequestCounter += 1;
    return `ompcot-ui-${Date.now().toString(36)}-${globalState.uiRequestCounter}`;
  }

  function broadcastUiFrame(frame: Record<string, unknown>) {
    broadcast({ type: "event", event: { type: "extension_ui_request", ...frame } });
  }

  // F4 (P1): cancel frame shape — the single wire contract for "this dialog
  // went away without a client answer" (server timeout, AbortSignal, session
  // teardown). Broadcast as:
  //   { type: "event",
  //     event: { type: "extension_ui_request", id, method: "cancel", targetId } }
  // where `id` and `targetId` are BOTH the dialog's id. The frontend
  // (ui-requests.js lane) dismisses the queued/active dialog matching
  // `targetId` (falling back to `id`) and must NOT send a ui_response for it.
  function broadcastUiCancelFrame(id: string) {
    broadcastUiFrame({ id, method: "cancel", targetId: id });
  }

  function defaultUiValue(kind: PendingUiRequest["kind"]): unknown {
    return kind === "confirm" ? false : undefined;
  }

  function settleUiRequest(id: string, value: unknown, announceCancel = false): boolean {
    const pending = globalState.uiPendingRequests.get(id);
    if (!pending) return false;
    globalState.uiPendingRequests.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    try {
      pending.cleanup();
    } catch {}
    if (announceCancel) broadcastUiCancelFrame(id);
    pending.resolve(value);
    return true;
  }

  function cancelAllUiRequests() {
    for (const id of Array.from(globalState.uiPendingRequests.keys())) {
      const pending = globalState.uiPendingRequests.get(id);
      // F4: announce each cancellation on the wire before settling so
      // connected clients dismiss rendered dialogs (session_shutdown /
      // teardown previously settled promises silently, leaving ghost
      // dialogs on screen that could never be answered).
      settleUiRequest(id, defaultUiValue(pending?.kind ?? "select"), true);
    }
  }

  // F3 (P1): re-serve pending dialogs. Called whenever a WebSocket client
  // (re)connects/attaches, and after a session swap's snapshot push. Only
  // dialogs belonging to the session the client is looking at are replayed;
  // the frontend dedupes by request id, so clients that already saw a frame
  // simply ignore the re-broadcast. Frames carry their original `expiresAt`
  // (F5), so a replayed dialog keeps its true deadline instead of restarting
  // the countdown.
  function replayPendingUiRequests(target?: UnifiedWS) {
    if (globalState.uiPendingRequests.size === 0) return;
    const currentKey = currentSessionIdFromCtx(globalState.getLatestCtx?.() ?? latestCtx);
    for (const pending of globalState.uiPendingRequests.values()) {
      // Skip dialogs from a different session than the active one (only
      // possible for entries parked in the shutdown→start gap). Entries
      // without a recorded session key are replayed defensively.
      if (pending.sessionKey && currentKey && pending.sessionKey !== currentKey) continue;
      const frame = { type: "event", event: { type: "extension_ui_request", ...pending.frame } };
      if (target) {
        sendTo(target, frame);
      } else {
        broadcast(frame);
      }
    }
  }

  // Structural view of the shared ExtensionUIContext we patch. Everything is
  // optional — a mismatched embedded omp version simply leaves that method
  // on its native stdio round-trip (degrades, never crashes).
  type UiDialogOptionsLike = {
    timeout?: unknown;
    onTimeout?: () => void;
    signal?: AbortSignal;
  };

  function uiSelectOptionLabel(option: unknown): string {
    if (typeof option === "string") return option;
    if (option && typeof option === "object") {
      const o = option as { label?: unknown; value?: unknown };
      if (typeof o.label === "string") return o.label;
      if (typeof o.value === "string") return o.value;
    }
    return String(option ?? "");
  }

  function recordUiDialog(
    kind: PendingUiRequest["kind"],
    frame: Record<string, unknown>,
    dialogOptions: UiDialogOptionsLike | undefined,
  ): Promise<unknown> {
    const id = nextUiRequestId();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const onAbort = () => {
        // Mirror the runtime: emit a cancel frame so hosts dismiss the
        // dialog, then settle with the kind's default value.
        settleUiRequest(id, defaultUiValue(kind), true);
      };
      // F4: if the caller's signal is ALREADY aborted, settle immediately
      // with the default instead of parking an unanswerable request (and
      // skip the cancel frame — nothing was ever broadcast).
      if (dialogOptions?.signal?.aborted) {
        resolve(defaultUiValue(kind));
        return;
      }
      dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = () => {
        dialogOptions?.signal?.removeEventListener("abort", onAbort);
      };

      const timeout = dialogOptions?.timeout;
      if (typeof timeout === "number" && timeout > 0) {
        timer = setTimeout(() => {
          try {
            dialogOptions?.onTimeout?.();
          } catch {}
          // F5: the server-side timeout resolves the promise locally with
          // the kind's default — NO client reply is needed or waited for.
          // The entry is deleted here, so a late client reply for an
          // expired request fails the lookup and gets the standard
          // "Unknown or expired UI request" error envelope. F4: announce
          // with a cancel frame so clients dismiss the rendered dialog.
          settleUiRequest(id, defaultUiValue(kind), true);
        }, timeout);
      }

      // F5 (P1): absolute expiry (epoch ms) in addition to the relative
      // `timeout`, so clients that receive the dialog late — replayed after
      // a reload (F3) or queued behind another dialog — can compute the
      // true remaining time instead of restarting the countdown.
      const expiresAt =
        typeof timeout === "number" && timeout > 0 ? Date.now() + timeout : undefined;
      const requestFrame: Record<string, unknown> = {
        id,
        method: kind,
        timeout: typeof timeout === "number" ? timeout : undefined,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...frame,
      };
      globalState.uiPendingRequests.set(id, {
        kind,
        resolve,
        timer,
        cleanup,
        frame: requestFrame,
        sessionKey: currentSessionIdFromCtx(latestCtx),
      });
      broadcastUiFrame(requestFrame);
    });
  }

  function installUiBridge(ctx: ExtensionContext) {
    const ui = (ctx as { ui?: unknown }).ui;
    if (!ui || typeof ui !== "object") return;
    if (globalState.patchedUiContext === ui) return; // idempotent across reloads

    const target = ui as Record<string, unknown>;

    const patchDialog = (
      name: "select" | "confirm" | "input" | "editor",
      buildFrame: (...args: unknown[]) => {
        frame: Record<string, unknown>;
        options?: UiDialogOptionsLike;
      },
    ) => {
      if (typeof target[name] !== "function") return;
      target[name] = (...args: unknown[]) => {
        const { frame, options } = buildFrame(...args);
        return recordUiDialog(name, frame, options);
      };
    };

    patchDialog(
      "select",
      (title: unknown, options: unknown, dialogOptions?: UiDialogOptionsLike) => {
        const items = Array.isArray(options) ? options : [];
        const labels = items.map(uiSelectOptionLabel);
        // Mirror requestRpcSelect: attach descriptions only when at least one
        // option object carries a non-empty description.
        let optionDetails: Array<{ description?: string }> | undefined;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const description =
            item && typeof item === "object"
              ? ((item as { description?: unknown }).description as string | undefined)?.trim()
              : undefined;
          if (!description) continue;
          optionDetails ??= items.map(() => ({}));
          optionDetails[i] = { description };
        }
        return {
          frame: {
            title: String(title ?? ""),
            options: labels,
            ...(optionDetails ? { optionDetails } : {}),
          },
          options: dialogOptions,
        };
      },
    );

    patchDialog(
      "confirm",
      (title: unknown, message: unknown, dialogOptions?: UiDialogOptionsLike) => ({
        frame: { title: String(title ?? ""), message: String(message ?? "") },
        options: dialogOptions,
      }),
    );

    patchDialog(
      "input",
      (title: unknown, placeholder: unknown, dialogOptions?: UiDialogOptionsLike) => ({
        frame: {
          title: String(title ?? ""),
          ...(typeof placeholder === "string" && placeholder ? { placeholder } : {}),
        },
        options: dialogOptions,
      }),
    );

    patchDialog(
      "editor",
      (
        title: unknown,
        prefill: unknown,
        dialogOptions?: UiDialogOptionsLike,
        editorOptions?: { promptStyle?: boolean },
      ) => ({
        frame: {
          title: String(title ?? ""),
          ...(typeof prefill === "string" && prefill ? { prefill } : {}),
          ...(editorOptions?.promptStyle !== undefined
            ? { promptStyle: editorOptions.promptStyle }
            : {}),
        },
        options: dialogOptions,
      }),
    );

    // `notify` is fire-and-forget: keep the native stdio frame (harmless) and
    // additionally surface it in the WebView (dialogs.js handles method
    // "notify"). The other fire-and-forget methods (setStatus / setWidget /
    // setEditorText / setTitle) stay untouched — the current GUI has no
    // renderer for them and teeing would only spam console warnings.
    if (typeof target.notify === "function") {
      const originalNotify = target.notify as (
        message: string,
        type?: "info" | "warning" | "error",
      ) => void;
      target.notify = (message: string, type?: "info" | "warning" | "error") => {
        try {
          originalNotify.call(ui, message, type);
        } catch {}
        broadcastUiFrame({ id: nextUiRequestId(), method: "notify", message, notifyType: type });
      };
    }

    globalState.patchedUiContext = ui;
    console.log("[Embedded] Interactive-UI bridge installed on shared ui context");
  }

  // ─── Memory file listing (tier-3 probe) ────────────────────────────────────
  //
  // Read-only probe of omp's memory storage roots. omp 18.3 keeps per-project
  // memory under `<agentDir>/memories/state/<encoded-cwd>/` (plus
  // `<agentDir>/memories/mnemopi/` for the mnemopi backend); we probe the
  // agent-level `memories/` + legacy `memory/` spellings and the
  // workspace-local `.omp/memory/`. No parsing — just file facts.

  const MEMORY_LIST_MAX_FILES = 500;

  type MemoryFileRow = { path: string; size: number; mtime: number };

  async function collectMemoryFilesFromRoot(
    root: string,
    files: Map<string, MemoryFileRow>,
  ): Promise<boolean> {
    let existed = false;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (files.size >= MEMORY_LIST_MAX_FILES || depth > 4) return;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
        existed = true;
      } catch {
        return; // root or subdir missing — normal for a fresh install
      }
      for (const entry of entries) {
        if (files.size >= MEMORY_LIST_MAX_FILES) return;
        const full = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            if (entry.name === ".git" || entry.name === "node_modules") continue;
            await walk(full, depth + 1);
          } else if (entry.isFile()) {
            const stats = await fs.promises.stat(full);
            const resolved = path.resolve(full);
            if (!files.has(resolved)) {
              files.set(resolved, { path: resolved, size: stats.size, mtime: stats.mtimeMs });
            }
          }
        } catch {
          /* raced or unreadable — skip */
        }
      }
    };
    await walk(root, 0);
    return existed;
  }

  async function listMemoryFiles(ctx: ExtensionContext | null): Promise<{
    files: MemoryFileRow[];
    available: boolean;
    backend?: string;
    roots: string[];
  }> {
    // Cheap settings read for the configured backend id (best-effort).
    let backend: string | undefined;
    try {
      const raw = getSettingsInstance()?.get?.("memory.backend");
      if (typeof raw === "string" && raw) backend = raw;
    } catch {}

    const agentRoot = (() => {
      try {
        const fromSettings = getSettingsInstance()?.getAgentDir?.();
        if (typeof fromSettings === "string" && fromSettings.trim()) return fromSettings;
      } catch {}
      return OMP_AGENT_ROOT;
    })();

    const workspace = ctx?.cwd || process.cwd();
    const roots = [
      path.join(agentRoot, "memories"),
      path.join(agentRoot, "memory"),
      path.join(workspace, ".omp", "memory"),
    ];

    const files = new Map<string, MemoryFileRow>();
    const rootsFound: string[] = [];
    for (const root of roots) {
      const existed = await collectMemoryFilesFromRoot(root, files);
      if (existed) rootsFound.push(root);
    }

    return {
      files: Array.from(files.values()).sort((a, b) => b.mtime - a.mtime),
      available: files.size > 0,
      ...(backend ? { backend } : {}),
      roots: rootsFound,
    };
  }

  // ═══════════════════════════════════════
  // Event forwarding — subscribe to all OMP events
  // ═══════════════════════════════════════
  const eventTypes = [
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
    "auto_compaction_start",
    "auto_compaction_end",
    "auto_retry_start",
    "auto_retry_end",
    "model_select",
  ] as const;

  // Cache the process-scoped ModelRegistry the first time we see any ctx.
  // See the EmbeddedServerGlobal.modelRegistry comment for why this is
  // process-scoped (and why gating auth handlers on latestCtx was wrong).
  function rememberCtx(ctx: ExtensionContext) {
    latestCtx = ctx;
    if (!globalState.modelRegistry && ctx?.modelRegistry) {
      globalState.modelRegistry = ctx.modelRegistry;
    }
  }

  for (const eventType of eventTypes) {
    omp.on(
      eventType as Parameters<typeof omp.on>[0],
      async (event: unknown, ctx: ExtensionContext) => {
        rememberCtx(ctx);

        // Forward event to all connected browser clients
        // Wrap in { type: "event", event: ... } to match the existing frontend protocol
        broadcast({
          type: "event",
          event: { type: eventType, ...(event as Record<string, unknown>) },
        });
      },
    );
  }

  // Also capture context from session events
  // Auto-title: collect user messages and generate a title after a few turns
  let turnCount = 0;
  let titleSet = false;
  let userMessages: string[] = [];

  omp.on("session_start", async (_event, ctx) => {
    rememberCtx(ctx);
    // Attach the interactive-UI bridge to the shared ui context (idempotent —
    // the same instance survives new_session / switch_session / fork reloads).
    try {
      installUiBridge(ctx);
    } catch (e: unknown) {
      console.error("[Embedded] Failed to install UI bridge:", errMessage(e));
    }
    turnCount = 0;
    titleSet = false;
    userMessages = [];
    // Update instance registry with new session file
    updateInstanceSession(ctx.sessionManager.getSessionFile() || "");
  });

  omp.on("turn_start", async (_event, _ctx) => {
    turnCount++;
  });

  // Capture user messages for title generation via message_start
  omp.on("message_start", async (event, _ctx) => {
    if (titleSet) return;
    const msg = event.message;
    if (msg?.role !== "user") return;
    const content = msg.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      const tb = content.find((b: { type?: string }) => b.type === "text");
      if (tb) text = tb.text;
    }
    if (text) userMessages.push(text.substring(0, 300));
  });

  omp.on("turn_end", async (_event, _ctx) => {
    if (titleSet || turnCount < 2) return;

    // Defensive: if the turn that just ended also kicked off a session
    // replacement (e.g. `/new`, `/fork`, `/switch`), the captured `omp` of
    // this OLD extension instance is now stale. Route through the freshest
    // `omp` published on `globalState` so we never call a stale
    // `getSessionName` / `setSessionName`.
    const a = currentOMP();
    if (!a) return;

    const sessionName = a.getSessionName();
    if (sessionName && sessionName !== "New Session" && sessionName !== "Untitled") {
      titleSet = true;
      return;
    }

    // Generate title from collected messages
    const title = generateSessionTitle(userMessages);
    if (title) {
      a.setSessionName(title);
      titleSet = true;
      // Broadcast to connected clients
      broadcast({ type: "event", event: { type: "session_name", name: title } });
    }
  });

  function generateSessionTitle(messages: string[]): string | null {
    if (messages.length === 0) return null;

    // Find first substantive message (skip greetings and memory instructions)
    const greetings = /^(hey|hello|hi|morning|good morning|howdy|yo|sup)[\s!.:,]*$/i;
    const memoryInstructions = /read (your |the )?(memory|seed|persona|working) files/i;

    let bestMessage = "";
    for (const msg of messages) {
      const cleaned = msg.trim();
      if (greetings.test(cleaned)) continue;
      if (memoryInstructions.test(cleaned)) continue;
      if (cleaned.length < 10) continue;
      bestMessage = cleaned;
      break;
    }

    if (!bestMessage) {
      // Fall back to first message with any content
      bestMessage = messages.find((m) => m.trim().length > 0) || "";
    }

    if (!bestMessage) return null;

    // Extract a clean title: first sentence or clause, max ~60 chars
    let title = bestMessage
      .replace(
        /^(ok |okay |so |actually |hey |please |can you |could you |i want(ed)? to |i wanna |let'?s )/i,
        "",
      )
      .replace(/\n.*/s, "") // first line only
      .trim();

    // Take first sentence
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 10 && sentenceEnd < 80) {
      title = title.substring(0, sentenceEnd);
    }

    // Truncate cleanly
    if (title.length > 60) {
      const spaceIdx = title.lastIndexOf(" ", 57);
      title = `${title.substring(0, spaceIdx > 20 ? spaceIdx : 57)}…`;
    }

    // Capitalize first letter
    title = title.charAt(0).toUpperCase() + title.slice(1);

    return title;
  }

  // ═══════════════════════════════════════
  // Build state snapshot for new connections
  // ═══════════════════════════════════════
  async function buildStateSnapshot(ctx: ExtensionContext) {
    // Get session entries for message history
    const entries = ctx.sessionManager.getEntries();

    // Get model info
    const model = ctx.model;
    const aomp = currentOMP();
    const thinkingLevel = aomp?.getThinkingLevel() ?? "off";
    // Keep in sync with the `get_state` response below: both feed the GUI's
    // thinking menu, which filters unsupported levels via `thinkingLevels`.
    // `reasoning` is the secondary capability signal (model.reasoning === true).
    const thinkingLevels = resolveThinkingLevels(model);
    const reasoning = modelSupportsReasoning(model);
    const sessionName = aomp?.getSessionName() ?? "";
    const sessionFile = ctx.sessionManager.getSessionFile();

    // Context usage
    const contextUsage = ctx.getContextUsage();

    return {
      type: "mirror_sync",
      entries,
      model,
      thinkingLevel,
      thinkingLevels,
      reasoning,
      sessionName,
      sessionFile,
      isStreaming: !ctx.isIdle(),
      contextUsage,
    };
  }

  // ═══════════════════════════════════════
  // Handle commands from browser clients
  // ═══════════════════════════════════════
  async function handleCommand(ws: UnifiedWS, command: RpcCommand) {
    const id = command.id;
    const ctx = latestCtx;
    // Always resolve `omp` from the global publisher rather than the
    // closure-captured one. See `currentOMP()` for the rationale.
    const aomp = currentOMP();

    const success = (cmd: string, data?: unknown) => {
      const resp: Record<string, unknown> = { type: "response", command: cmd, success: true, id };
      if (data !== undefined) resp.data = data;
      return resp;
    };

    const error = (cmd: string, message: string) => {
      return { type: "response", command: cmd, success: false, error: message, id };
    };

    // Used by every case that performs a session-bound mutation
    // (`sendUserMessage`, `setThinkingLevel`, `setModel`, `setSessionName`,
    // …). Returning a clean error here is cheaper than letting the call
    // throw `"This extension ctx is stale after session replacement"` and
    // having oh-my-omp re-emit it as an `extension_error` event in chat.
    // (The pi→omp rename d4cb8b0 left the call sites as `requireApi` and the
    // guard below referencing `api`; both were undefined and every call threw
    // a caught ReferenceError. Restored here.)
    const requireAomp = (cmd: string): ExtensionAPI | null => {
      if (aomp) return aomp;
      sendTo(ws, error(cmd, "No active session"));
      return null;
    };

    try {
      switch (command.type) {
        // ─── Prompting ───
        case "prompt": {
          const a = requireAomp("prompt");
          if (!a) break;
          if (ctx && !ctx.isIdle()) {
            const behavior = command.streamingBehavior || "steer";
            // omp core throws when a `/`-prefixed message is delivered as
            // steer mid-stream (slash commands only execute when idle).
            // Reject with this exact sentence — the GUI keys off it to
            // auto-queue the command until the agent goes idle.
            if (behavior === "steer" && command.message.startsWith("/")) {
              sendTo(
                ws,
                error(
                  "prompt",
                  "Slash command cannot run while the agent is streaming; it will be queued and delivered when idle",
                ),
              );
              break;
            }
            if (behavior === "steer") {
              a.sendUserMessage(command.message, { deliverAs: "steer" });
            } else {
              a.sendUserMessage(command.message, { deliverAs: "followUp" });
            }
          } else {
            // Build content with optional images
            if (command.images?.length) {
              const validMimes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
              // biome-ignore lint/suspicious/noExplicitAny: mixed text/image content blocks for sendUserMessage
              const content: any[] = [
                { type: "text", text: command.message || "(see attached image)" },
              ];
              for (const img of command.images) {
                if (!img.data || typeof img.data !== "string") {
                  console.error("[embedded-server] Skipping image: missing or invalid data");
                  continue;
                }
                // Strip data URL prefix if accidentally included
                const data = img.data.includes(",") ? img.data.split(",")[1] : img.data;
                const mimeType = (
                  validMimes.includes(img.mimeType ?? "") ? (img.mimeType as string) : "image/png"
                ) as "image/png" | "image/jpeg" | "image/gif" | "image/webp";
                console.log(
                  `[embedded-server] Image: mimeType=${mimeType}, dataLen=${data.length}, rawMimeType=${img.mimeType}`,
                );
                const imageBlock = {
                  type: "image" as const,
                  data: data,
                  mimeType: mimeType,
                };
                // Defensive: verify mimeType is actually set (debug crash where it was missing)
                if (!imageBlock.mimeType) {
                  console.error(
                    `[embedded-server] BUG: mimeType is falsy after assignment! img.mimeType=${img.mimeType}, falling back to image/png`,
                  );
                  imageBlock.mimeType = "image/png";
                }
                content.push(imageBlock);
              }
              // Only send content array if we actually have images, otherwise just text
              const hasImages = content.some((c) => c.type === "image");
              if (hasImages) {
                a.sendUserMessage(content);
              } else {
                a.sendUserMessage(command.message);
              }
            } else {
              a.sendUserMessage(command.message);
            }
          }
          sendTo(ws, success("prompt"));
          break;
        }

        case "steer": {
          const a = requireAomp("steer");
          if (!a) break;
          a.sendUserMessage(command.message, { deliverAs: "steer" });
          sendTo(ws, success("steer"));
          break;
        }

        case "follow_up": {
          const a = requireAomp("follow_up");
          if (!a) break;
          a.sendUserMessage(command.message, { deliverAs: "followUp" });
          sendTo(ws, success("follow_up"));
          break;
        }

        case "list_commands": {
          // Enumerate the session's dynamic slash commands via
          // `ExtensionAPI.getCommands()` (extension + custom prompt/MCP +
          // skill commands; built-ins are intentionally excluded by omp
          // core). Commands are session-scoped, so "no active session" is
          // not an error: the GUI fetches lazily and gets a graceful empty
          // result.
          if (!aomp) {
            sendTo(ws, success("list_commands", { commands: [], available: false }));
            break;
          }
          try {
            const commands: Array<{ name: string; description?: string; source?: string }> = [];
            // Feature-detect: older embedded omp builds may predate
            // `getCommands` on ExtensionAPI.
            const raw = typeof aomp.getCommands === "function" ? aomp.getCommands() : null;
            if (!Array.isArray(raw)) {
              throw new Error("getCommands() is not available on this omp runtime");
            }
            for (const cmd of raw) {
              if (!cmd || typeof cmd !== "object" || typeof cmd.name !== "string") continue;
              const info: { name: string; description?: string; source?: string } = {
                name: cmd.name,
              };
              if (typeof cmd.description === "string") info.description = cmd.description;
              if (typeof cmd.source === "string") info.source = cmd.source;
              commands.push(info);
            }
            sendTo(ws, success("list_commands", { commands, available: true }));
          } catch (err) {
            console.error(
              `[Embedded] list_commands failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            sendTo(ws, success("list_commands", { commands: [], available: false }));
          }
          break;
        }

        case "abort": {
          if (ctx) ctx.abort();
          sendTo(ws, success("abort"));
          break;
        }

        // ─── Interactive-UI replies (tier-1) ───
        //
        // Completes the dialog loop opened by the patched ui context (see
        // installUiBridge). The frontend's dialogs.js sends command type
        // `extension_ui_response` with the runtime's frame payload
        // ({id, value} | {id, confirmed} | {id, cancelled}); the frozen GUI
        // contract also allows `ui_response`. Both names resolve the same
        // pending request; `ui_cancel` (and its `extension_ui_cancel` alias)
        // cancels one.
        //
        // F9 (P2) ack correlation: `command.id` here is the DIALOG id (the
        // payload's id), but clients correlate replies by their transport
        // requestId (ws-rpc matches response.id against the broker
        // envelope's requestId). Acknowledgments therefore echo the
        // TRANSPORT requestId when one exists — standard envelope behavior
        // like every other command — and the dialog payload `id` rides
        // inside `data`. Raw (non-broker) frames have no transport id and
        // fall back to echoing the dialog id.
        //
        // Retry semantics (F3): an ERROR ack (missing/invalid answer, or
        // "unknown request") does NOT settle the pending promise — the
        // dialog stays answerable until a valid ui_response/ui_cancel or
        // its own timeout/cancel arrives. Only success paths settle.
        case "ui_response":
        case "extension_ui_response": {
          const requestId = command.id;
          const ackId =
            typeof command.transportRequestId === "string" && command.transportRequestId
              ? command.transportRequestId
              : requestId;
          const ackSuccess = (data: Record<string, unknown>) => {
            const resp: Record<string, unknown> = {
              type: "response",
              command: command.type,
              success: true,
              id: ackId,
              data: { id: requestId, ...data },
            };
            sendTo(ws, resp);
          };
          const ackError = (message: string) => {
            sendTo(ws, {
              type: "response",
              command: command.type,
              success: false,
              error: message,
              id: ackId,
            });
          };
          if (typeof requestId !== "string" || !requestId) {
            ackError("id is required");
            break;
          }
          const pending = globalState.uiPendingRequests.get(requestId);
          if (!pending) {
            ackError(`Unknown or expired UI request: ${requestId}`);
            break;
          }

          // Cancelled variant — resolves the kind's default (undefined for
          // select/input/editor, false for confirm), matching how the native
          // RPC layer treats {cancelled: true} responses.
          if (command.cancelled === true) {
            settleUiRequest(requestId, defaultUiValue(pending.kind));
            ackSuccess({ cancelled: true });
            break;
          }

          if (pending.kind === "confirm") {
            let confirmed: boolean | undefined;
            if (typeof command.confirmed === "boolean") confirmed = command.confirmed;
            else if (typeof command.value === "boolean") confirmed = command.value;
            else if (command.value === "true") confirmed = true;
            else if (command.value === "false") confirmed = false;
            if (confirmed === undefined) {
              ackError("Confirm dialogs require a boolean answer (confirmed)");
              break;
            }
            settleUiRequest(requestId, confirmed);
            ackSuccess({ confirmed });
            break;
          }

          if (typeof command.value !== "string") {
            ackError(`${pending.kind} dialogs require a string answer (value)`);
            break;
          }
          settleUiRequest(requestId, command.value);
          ackSuccess({ value: command.value });
          break;
        }

        case "ui_cancel":
        case "extension_ui_cancel": {
          const requestId = command.id;
          const ackId =
            typeof command.transportRequestId === "string" && command.transportRequestId
              ? command.transportRequestId
              : requestId;
          if (typeof requestId !== "string" || !requestId) {
            sendTo(ws, {
              type: "response",
              command: command.type,
              success: false,
              error: "id is required",
              id: ackId,
            });
            break;
          }
          const pending = globalState.uiPendingRequests.get(requestId);
          if (!pending) {
            sendTo(ws, {
              type: "response",
              command: command.type,
              success: false,
              error: `Unknown or expired UI request: ${requestId}`,
              id: ackId,
            });
            break;
          }
          // No cancel frame on the wire here: the client itself initiated
          // the cancel, so it has already dismissed the dialog.
          settleUiRequest(requestId, defaultUiValue(pending.kind));
          sendTo(ws, {
            type: "response",
            command: command.type,
            success: true,
            id: ackId,
            data: { id: requestId, cancelled: true },
          });
          break;
        }

        case "new_session": {
          if (!ctx) {
            sendTo(ws, error("new_session", "No context available"));
            break;
          }
          if (typeof (ctx as unknown as { newSession?: unknown }).newSession !== "function") {
            sendTo(
              ws,
              error(
                "new_session",
                "New session requires the desktop broker with this embedded omp version.",
              ),
            );
            break;
          }
          const result = await ctx.newSession();
          sendTo(ws, success("new_session", result || {}));
          break;
        }

        case "switch_session": {
          if (!ctx) {
            sendTo(ws, error("switch_session", "No context available"));
            break;
          }
          if (!command.sessionPath || typeof command.sessionPath !== "string") {
            sendTo(ws, error("switch_session", "sessionPath is required"));
            break;
          }
          if (typeof (ctx as unknown as { switchSession?: unknown }).switchSession !== "function") {
            sendTo(
              ws,
              error(
                "switch_session",
                "Session switching requires the desktop broker with this embedded omp version.",
              ),
            );
            break;
          }
          const result = await ctx.switchSession(command.sessionPath);
          sendTo(ws, success("switch_session", result || {}));
          break;
        }

        // ─── Fork (tier-1) ───
        // Branch the current session from a specific entry. `branch` lives on
        // the command-context surface (ExtensionCommandContext in omp's
        // types); the session_start ctx carries it in RPC mode. Feature-detect
        // so an older embedded omp degrades to a clear error instead of a
        // thrown TypeError.
        case "fork_session": {
          if (!ctx) {
            sendTo(ws, error("fork_session", "No context available"));
            break;
          }
          const entryId = command.entryId;
          if (typeof entryId !== "string" || !entryId.trim()) {
            sendTo(ws, error("fork_session", "entryId is required"));
            break;
          }
          const branchFn = (
            ctx as unknown as {
              branch?: (entryId: string) => Promise<{ cancelled?: boolean } | undefined>;
            }
          ).branch;
          if (typeof branchFn !== "function") {
            sendTo(ws, error("fork_session", "Fork unavailable in this build"));
            break;
          }
          try {
            const result = await branchFn.call(ctx, entryId);
            sendTo(ws, success("fork_session", { cancelled: result?.cancelled ?? false }));
          } catch (e: unknown) {
            sendTo(ws, error("fork_session", errMessage(e)));
          }
          break;
        }

        // ─── State ───
        case "get_state": {
          if (!ctx) {
            sendTo(ws, error("get_state", "No context available"));
            break;
          }
          const model = ctx.model;
          const state = {
            model,
            thinkingLevel: aomp?.getThinkingLevel() ?? "off",
            // Supported levels for THIS model (least → most intensive,
            // "off" first) — the GUI menu filters on this. EMPTY array
            // means the model has no controllable thinking depth (chip
            // disabled). Mirrored into the initial `mirror_sync` snapshot
            // in `buildStateSnapshot`.
            thinkingLevels: resolveThinkingLevels(model),
            // Secondary capability signal: does the model report a
            // reasoning surface at all (model.reasoning === true).
            reasoning: modelSupportsReasoning(model),
            isStreaming: !ctx.isIdle(),
            sessionFile: ctx.sessionManager.getSessionFile(),
            sessionName: aomp?.getSessionName() ?? "",
            autoCompactionEnabled: true, // Extension can't easily check this
          };
          sendTo(ws, success("get_state", state));
          break;
        }

        case "get_messages": {
          if (!ctx) {
            sendTo(ws, error("get_messages", "No context available"));
            break;
          }
          const entries = ctx.sessionManager.getEntries();
          sendTo(ws, success("get_messages", { entries }));
          break;
        }

        case "get_omp_version": {
          // Embedded omp version is forwarded by Ompcot (Rust) at spawn time.
          sendTo(ws, success("get_omp_version", { version: EMBEDDED_OMP_VERSION }));
          break;
        }

        // ─── Model ───
        case "get_available_models": {
          if (!ctx) {
            sendTo(ws, error("get_available_models", "No context available"));
            break;
          }
          const models = await ctx.modelRegistry.getAvailable();
          sendTo(ws, success("get_available_models", { models }));
          break;
        }

        // ─── API keys (auth.json) ───
        //
        // Why: GUI-launched Ompcot (Finder/dock) does not inherit
        // ANTHROPIC_API_KEY etc. from the user's login shell, and we
        // deliberately removed the brittle login-shell env-harvest path in
        // commit 8b1f5e4. The user therefore needs an in-app way to write
        // their API key into ~/.omp/agent/auth.json once, which then sticks
        // across runs (same file format omp's `/login` writes).
        //
        // These handlers expose a minimal CRUD over auth.json scoped to the
        // built-in providers we know about. OAuth providers are deliberately
        // excluded — they require a browser round-trip we don't support yet
        // from the desktop UI; users who need OAuth should run `omp /login`
        // from a terminal.
        case "list_auth_status": {
          // Use the cached process-scoped registry when available so this
          // works even if the user opens Settings → Authentication before
          // omp's first session_start has fired, or between sessions during
          // a new_session / switch_session / fork reload. See the
          // EmbeddedServerGlobal.modelRegistry comment for the full why.
          const registry = ctx?.modelRegistry ?? globalState.modelRegistry;
          if (!registry) {
            sendTo(
              ws,
              error("list_auth_status", "Model registry not ready yet — try again in a moment."),
            );
            break;
          }
          // Collect unique providers from all known models (built-in + custom).
          const allModels = registry.getAll();
          const providerNames = new Set<string>();
          for (const m of allModels) providerNames.add(m.provider);
          const providers = Array.from(providerNames)
            .sort()
            .map((p) => {
              // One bad provider must not break the whole panel — omp API
              // drift has taken the entire Settings page down before.
              try {
                return computeProviderAuthStatus(registry, p);
              } catch (e: unknown) {
                console.error(
                  `[Embedded] list_auth_status: provider "${p}" failed:`,
                  errMessage(e),
                );
                const failed: ProviderAuthStatus = {
                  provider: p,
                  configured: false,
                  source: "error",
                };
                return failed;
              }
            });
          sendTo(ws, success("list_auth_status", { providers }));
          break;
        }

        case "set_api_key": {
          const registry = ctx?.modelRegistry ?? globalState.modelRegistry;
          if (!registry) {
            sendTo(
              ws,
              error("set_api_key", "Model registry not ready yet — try again in a moment."),
            );
            break;
          }
          const provider = typeof command.provider === "string" ? command.provider.trim() : "";
          const apiKey = typeof command.apiKey === "string" ? command.apiKey.trim() : "";
          if (!provider) {
            sendTo(ws, error("set_api_key", "provider is required"));
            break;
          }
          if (!apiKey) {
            sendTo(ws, error("set_api_key", "apiKey is required"));
            break;
          }
          try {
            // omp 18.3.0 moved the flat `authStorage.set/remove` onto the
            // `authStorage.credentials` namespace. Prefer the new surface and
            // fall back to the legacy flat one so both embedded versions work.
            const authStorage = registry.authStorage as unknown as
              | Record<string, unknown>
              | undefined;
            const credentialsApi = authStorage?.credentials as Record<string, unknown> | undefined;
            const setCredential =
              typeof credentialsApi?.set === "function"
                ? (prov: string, cred: unknown) =>
                    (credentialsApi.set as (p: string, c: unknown) => Promise<void> | void)(
                      prov,
                      cred,
                    )
                : typeof authStorage?.set === "function"
                  ? (authStorage.set as (p: string, c: unknown) => Promise<void> | void).bind(
                      authStorage,
                    )
                  : null;
            if (!setCredential) {
              sendTo(
                ws,
                error(
                  "set_api_key",
                  "This omp version's auth storage does not support writing API keys.",
                ),
              );
              break;
            }
            await setCredential(provider, { type: "api_key", key: apiKey });
            // Refresh so getAvailable() picks up the new key without restart.
            if (typeof registry.refresh === "function") {
              await registry.refresh();
            }
            sendTo(ws, success("set_api_key", { provider }));
          } catch (e: unknown) {
            sendTo(ws, error("set_api_key", errMessage(e)));
          }
          break;
        }

        case "remove_api_key": {
          const registry = ctx?.modelRegistry ?? globalState.modelRegistry;
          if (!registry) {
            sendTo(
              ws,
              error("remove_api_key", "Model registry not ready yet — try again in a moment."),
            );
            break;
          }
          const provider = typeof command.provider === "string" ? command.provider.trim() : "";
          if (!provider) {
            sendTo(ws, error("remove_api_key", "provider is required"));
            break;
          }
          try {
            // Same 18.3.0 surface change as set_api_key: credentials.remove
            // first, legacy flat authStorage.remove as fallback.
            const authStorage = registry.authStorage as unknown as
              | Record<string, unknown>
              | undefined;
            const credentialsApi = authStorage?.credentials as Record<string, unknown> | undefined;
            const removeCredential =
              typeof credentialsApi?.remove === "function"
                ? (prov: string) =>
                    (credentialsApi.remove as (p: string) => Promise<void> | void)(prov)
                : typeof authStorage?.remove === "function"
                  ? (authStorage.remove as (p: string) => Promise<void> | void).bind(authStorage)
                  : null;
            if (!removeCredential) {
              sendTo(
                ws,
                error(
                  "remove_api_key",
                  "This omp version's auth storage does not support removing credentials.",
                ),
              );
              break;
            }
            await removeCredential(provider);
            if (typeof registry.refresh === "function") {
              await registry.refresh();
            }
            sendTo(ws, success("remove_api_key", { provider }));
          } catch (e: unknown) {
            sendTo(ws, error("remove_api_key", errMessage(e)));
          }
          break;
        }

        case "set_model": {
          if (!ctx) {
            sendTo(ws, error("set_model", "No context available"));
            break;
          }
          const a = requireAomp("set_model");
          if (!a) break;
          const models = await ctx.modelRegistry.getAvailable();
          const model = models.find(
            (m: { provider?: string; id?: string }) =>
              m.provider === command.provider && m.id === command.modelId,
          );
          if (!model) {
            sendTo(
              ws,
              error("set_model", `Model not found: ${command.provider}/${command.modelId}`),
            );
            break;
          }
          const ok = await a.setModel(model);
          if (!ok) {
            sendTo(ws, error("set_model", "No API key for this model"));
            break;
          }
          // Ack carries the new model's thinking surface so the GUI can
          // refresh its depth chip/menu immediately, without waiting for
          // (or racing) the next get_state fetch. Shape mirrors get_state:
          // `thinkingLevels: []` = no controllable depth on the new model.
          sendTo(
            ws,
            success("set_model", {
              model,
              thinkingLevel: a.getThinkingLevel(),
              thinkingLevels: resolveThinkingLevels(model),
              reasoning: modelSupportsReasoning(model),
            }),
          );
          break;
        }

        case "cycle_model": {
          // Extension API doesn't have cycleModel directly
          // Workaround: get available models, find current, pick next
          if (!ctx) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const a = requireAomp("cycle_model");
          if (!a) break;
          const availModels = await ctx.modelRegistry.getAvailable();
          const currentModel = ctx.model;
          if (!currentModel || availModels.length <= 1) {
            sendTo(ws, success("cycle_model", null));
            break;
          }
          const idx = availModels.findIndex(
            (m: { provider?: string; id?: string }) =>
              m.provider === currentModel.provider && m.id === currentModel.id,
          );
          const nextModel = availModels[(idx + 1) % availModels.length];
          await a.setModel(nextModel);
          sendTo(
            ws,
            success("cycle_model", {
              model: nextModel,
              thinkingLevel: a.getThinkingLevel(),
            }),
          );
          break;
        }

        // ─── Thinking ───
        case "cycle_thinking_level": {
          const a = requireAomp("cycle_thinking_level");
          if (!a) break;
          // Cycle within the same resolved set the GUI menu
          // (`get_state`/`mirror_sync` `thinkingLevels`) is built from, so
          // cycling never lands on a level the current model doesn't
          // support. An EMPTY resolved set means the current model has no
          // controllable thinking depth → explicit error (the GUI also
          // disables its controls on this).
          const levels = resolveThinkingLevels(ctx?.model);
          if (levels.length === 0) {
            sendTo(
              ws,
              error("cycle_thinking_level", "This model does not support thinking depth control"),
            );
            break;
          }
          const current = a.getThinkingLevel();
          const idx = levels.indexOf(current ?? "");
          const next = levels[(idx + 1) % levels.length];
          a.setThinkingLevel(next as Parameters<typeof a.setThinkingLevel>[0]);
          sendTo(ws, success("cycle_thinking_level", { level: next }));
          break;
        }

        case "set_thinking_level": {
          const a = requireAomp("set_thinking_level");
          if (!a) break;
          // Same capability gate as cycle_thinking_level: an EMPTY resolved
          // set means no user-facing depth control on this model.
          if (resolveThinkingLevels(ctx?.model).length === 0) {
            sendTo(
              ws,
              error("set_thinking_level", "This model does not support thinking depth control"),
            );
            break;
          }
          a.setThinkingLevel(command.level as Parameters<typeof a.setThinkingLevel>[0]);
          sendTo(ws, success("set_thinking_level"));
          break;
        }

        // ─── Session ───
        case "get_session_stats": {
          if (!ctx) {
            sendTo(ws, error("get_session_stats", "No context available"));
            break;
          }
          const usage = ctx.getContextUsage();
          const entries = ctx.sessionManager.getEntries();
          let userMessages = 0,
            assistantMessages = 0,
            toolCalls = 0;
          for (const e of entries) {
            if (e.type === "message") {
              if (e.message?.role === "user") userMessages++;
              else if (e.message?.role === "assistant") assistantMessages++;
              else if (e.message?.role === "toolResult") toolCalls++;
            }
          }
          sendTo(
            ws,
            success("get_session_stats", {
              sessionFile: ctx.sessionManager.getSessionFile(),
              userMessages,
              assistantMessages,
              toolCalls,
              totalMessages: entries.length,
              tokens: usage ? { input: usage.tokens, total: usage.tokens } : null,
            }),
          );
          break;
        }

        case "set_session_name": {
          const name = command.name?.trim();
          if (!name) {
            sendTo(ws, error("set_session_name", "Name cannot be empty"));
            break;
          }
          const a = requireAomp("set_session_name");
          if (!a) break;
          a.setSessionName(name);
          sendTo(ws, success("set_session_name"));
          break;
        }

        case "set_auto_compaction": {
          // Extension can't easily toggle auto-compaction
          // Just acknowledge
          sendTo(ws, success("set_auto_compaction"));
          break;
        }

        case "compact": {
          if (ctx) {
            // Broadcast compaction start to all clients
            broadcast({ type: "auto_compaction_start" });
            ctx.compact({
              customInstructions: command.customInstructions,
              onComplete: (result: { summary?: string }) => {
                broadcast({ type: "auto_compaction_end", summary: result?.summary });
              },
              onError: (err: unknown) => {
                broadcast({ type: "auto_compaction_end", summary: `Error: ${errMessage(err)}` });
              },
            });
          }
          sendTo(ws, success("compact"));
          break;
        }

        case "export_html": {
          if (!ctx) {
            sendTo(ws, error("export_html", "No context available"));
            break;
          }
          try {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (!sessionFile) throw new Error("No session file to export");
            // Argv-array exec — no shell involved, so the request-controlled
            // `outputPath` can never inject command syntax (audit A1).
            // `resolveOmpCliInvocation` handles both process layouts:
            // compiled binary (execPath IS omp) and shim installs (execPath
            // is the runtime with the omp entry script at argv[1]).
            const { cmd, prefix } = resolveOmpCliInvocation();
            const outputPath =
              typeof command.outputPath === "string" && command.outputPath
                ? command.outputPath
                : "";
            const output = execFileSync(
              cmd,
              [...prefix, "--export", sessionFile, ...(outputPath ? [outputPath] : [])],
              {
                cwd: process.cwd(),
                timeout: 30000,
                encoding: "utf-8",
              },
            );
            // omp prints the output path
            const result =
              output.trim().split("\n").pop() || sessionFile.replace(".jsonl", ".html");
            sendTo(ws, success("export_html", { path: result }));
          } catch (e: unknown) {
            sendTo(ws, error("export_html", errMessage(e)));
          }
          break;
        }

        // ─── Sync ───
        case "mirror_sync_request": {
          if (ctx) {
            const snapshot = await buildStateSnapshot(ctx);
            sendTo(ws, snapshot);
          } else {
            sendTo(ws, { type: "mirror_sync", entries: [], model: null });
          }
          break;
        }

        // ─── Auth ───
        // Desktop mode does not need basic auth (WebView is local). We keep
        // the RPC surface so the frontend's settings panel doesn't break,
        // but always report "not configured" so the auth toggle stays
        // hidden client-side.
        case "get_auth": {
          sendTo(ws, success("get_auth", { configured: false, enabled: false }));
          break;
        }

        case "set_auth": {
          sendTo(ws, error("set_auth", "Auth is not configurable in desktop mode"));
          break;
        }

        // ─── Agent roster (B1) ───
        case "list_agents": {
          // Registry access is best-effort: never throw, always a success
          // envelope (with available:false when the surface is missing).
          sendTo(ws, success("list_agents", listSanitizedAgents()));
          break;
        }

        case "get_agent_transcript": {
          if (typeof command.sessionPath !== "string" || !command.sessionPath) {
            sendTo(ws, error("get_agent_transcript", "sessionPath is required"));
            break;
          }
          try {
            const transcript = await readAgentTranscript(command.sessionPath);
            sendTo(ws, success("get_agent_transcript", transcript));
          } catch (e: unknown) {
            sendTo(ws, error("get_agent_transcript", errMessage(e)));
          }
          break;
        }

        // ─── MCP management (B2) ───
        case "mcp.list": {
          try {
            const listing = await listMcpServers();
            sendTo(ws, success("mcp.list", listing));
          } catch (e: unknown) {
            sendTo(ws, error("mcp.list", errMessage(e)));
          }
          break;
        }

        case "mcp.save": {
          const name = typeof command.name === "string" ? command.name.trim() : "";
          const scope = command.scope === "project" ? "project" : "user";
          if (!name) {
            sendTo(ws, error("mcp.save", "name is required"));
            break;
          }
          try {
            const written = await saveMcpServer(name, command.config, scope);
            sendTo(ws, success("mcp.save", written));
          } catch (e: unknown) {
            sendTo(ws, error("mcp.save", errMessage(e)));
          }
          break;
        }

        case "mcp.remove": {
          const name = typeof command.name === "string" ? command.name.trim() : "";
          const scope = command.scope === "project" ? "project" : "user";
          if (!name) {
            sendTo(ws, error("mcp.remove", "name is required"));
            break;
          }
          try {
            const removed = await removeMcpServerByName(name, scope);
            sendTo(ws, success("mcp.remove", removed));
          } catch (e: unknown) {
            sendTo(ws, error("mcp.remove", errMessage(e)));
          }
          break;
        }

        case "mcp.toggle": {
          const name = typeof command.name === "string" ? command.name.trim() : "";
          if (!name) {
            sendTo(ws, error("mcp.toggle", "name is required"));
            break;
          }
          if (typeof command.enabled !== "boolean") {
            sendTo(ws, error("mcp.toggle", "enabled must be a boolean"));
            break;
          }
          try {
            const toggled = await toggleMcpServer(name, command.enabled);
            sendTo(ws, success("mcp.toggle", toggled));
          } catch (e: unknown) {
            sendTo(ws, error("mcp.toggle", errMessage(e)));
          }
          break;
        }

        case "mcp.connect":
        case "mcp.disconnect":
        case "mcp.reconnect": {
          const action = command.type.slice("mcp.".length) as
            | "connect"
            | "disconnect"
            | "reconnect";
          const name = typeof command.name === "string" ? command.name.trim() : "";
          if (!name) {
            sendTo(ws, error(command.type, "name is required"));
            break;
          }
          try {
            const result = await controlMcpConnection(name, action);
            sendTo(ws, success(command.type, result));
          } catch (e: unknown) {
            sendTo(ws, error(command.type, errMessage(e)));
          }
          break;
        }

        // ─── Usage dashboard (tier-1) ───
        //
        // `omp usage --json` reports provider quota windows; it may hit
        // provider APIs over the network, hence the longer timeout. On CLI
        // failure (no auth, network down) the error envelope carries the
        // stderr tail so the GUI can explain what to fix.
        case "get_usage": {
          try {
            const stdout = await execOmpCli(["usage", "--json"], OMP_USAGE_TIMEOUT_MS);
            let usage: unknown;
            try {
              usage = JSON.parse(stdout);
            } catch {
              sendTo(ws, error("get_usage", "omp usage --json produced non-JSON output"));
              break;
            }
            sendTo(ws, success("get_usage", { usage }));
          } catch (e: unknown) {
            sendTo(ws, error("get_usage", `omp usage --json failed — ${cliErrorTail(e)}`));
          }
          break;
        }

        // ─── Terminal OAuth login (tier-2) ───
        //
        // `omp login <provider>` is a terminal flow (browser round-trip +
        // pasted code prompts). We run it headless with stdin detached and a
        // 5-minute leash: providers that hard-require a TTY exit non-zero and
        // that surfaces in `output` for the GUI to show alongside advice
        // ("run omp login <provider> in a terminal"). No TTY emulation.
        case "run_omp_login": {
          const provider = typeof command.provider === "string" ? command.provider.trim() : "";
          if (!provider) {
            sendTo(ws, error("run_omp_login", "provider is required"));
            break;
          }
          if (!/^[a-z0-9_-]+$/i.test(provider)) {
            sendTo(ws, error("run_omp_login", "Invalid provider id"));
            break;
          }
          try {
            const result = await runOmpCliCaptured(["login", provider], OMP_LOGIN_TIMEOUT_MS);
            sendTo(
              ws,
              success("run_omp_login", {
                exitCode: result.exitCode,
                output: result.output,
                timedOut: result.timedOut,
                provider,
              }),
            );
          } catch (e: unknown) {
            sendTo(ws, error("run_omp_login", errMessage(e)));
          }
          break;
        }

        // ─── Claude/Codex session import (tier-2, degraded) ───
        //
        // Verified against omp 18.3.0: `--from-claude` / `--from-codex` are
        // *launch* flags that open the interactive TUI session picker to
        // choose which foreign session to import; headless (stdin closed)
        // they exit immediately without importing, and there is no
        // `omp import` one-shot subcommand. Until omp grows a headless
        // import, this RPC reports interactive-only so the GUI can direct
        // users to a terminal instead of silently doing nothing.
        case "import_session": {
          const source = command.source;
          if (source !== "claude" && source !== "codex") {
            sendTo(ws, error("import_session", 'source must be "claude" or "codex"'));
            break;
          }
          sendTo(
            ws,
            success("import_session", {
              ok: false,
              reason: "interactive-only",
              output: `omp --from-${source} requires the interactive terminal launcher; run it in a terminal to pick the session to import.`,
            }),
          );
          break;
        }

        // ─── Memory files probe (tier-3) ───
        //
        // Read-only listing of candidate memory storage roots. See
        // listMemoryFiles for the probed paths; nothing is parsed or written.
        case "list_memory_files": {
          try {
            const listing = await listMemoryFiles(ctx);
            sendTo(ws, success("list_memory_files", listing));
          } catch (e: unknown) {
            sendTo(ws, error("list_memory_files", errMessage(e)));
          }
          break;
        }

        default: {
          sendTo(ws, error(command.type, `Unknown command: ${command.type}`));
        }
      }
    } catch (e: unknown) {
      sendTo(ws, error(command.type || "unknown", errMessage(e)));
    }
  }

  // ═══════════════════════════════════════
  // Static file server
  // ═══════════════════════════════════════
  async function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse) {
    let urlPath = req.url || "/";

    // Handle API routes
    if (urlPath.startsWith("/api/")) {
      handleApiRoute(req, res, urlPath);
      return;
    }

    // Auto-redirect remote browsers to the full mobile URL so users don't
    // need to manually append ?mobile=1&brokerWs=... to the LAN address.
    const brokerPort = Number.parseInt(process.env.OMCOT_BROKER_PORT || "", 10);
    const host = req.headers.host || "";
    const hostName = parseHostHeaderName(host);
    const isLoopback = isLoopbackHost(hostName);
    const rawPath = urlPath.split("?")[0];
    const hasParams = urlPath.includes("mobile=1");
    if (
      rawPath === "/" &&
      !isLoopback &&
      !hasParams &&
      Number.isFinite(brokerPort) &&
      brokerPort > 0
    ) {
      const redirect = new URL(`http://${host}/`);
      redirect.searchParams.set("mobile", "1");
      redirect.searchParams.set("brokerWs", `ws://${hostName}:${brokerPort}/ui-ws`);
      res.writeHead(302, { Location: redirect.toString() });
      res.end();
      return;
    }

    // Strip query params
    urlPath = urlPath.split("?")[0];

    // Pretty routes
    if (urlPath === "/") urlPath = "/index.html";
    if (urlPath === "/cost" || urlPath === "/cost/") urlPath = "/cost.html";

    const filePath = path.join(STATIC_DIR, urlPath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Check file exists
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-store" });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  // ═══════════════════════════════════════
  // Agent settings (omp config) — in-process + CLI surfaces
  // ═══════════════════════════════════════
  //
  // The omp runtime owns a process-scoped Settings singleton (reachable via
  // the ExtensionAPI's package namespace, `omp.pi.Settings.instance`) that
  // reads/writes ~/.omp/agent/config.yml, persists to the global layer
  // debounced + lock-safe, and applies changes in-process immediately. All
  // access below is optional-chained and try/catch'd so a mismatched
  // embedded omp version degrades to the CLI fallback (`omp config …` via
  // process.execPath, which IS the embedded omp binary here).

  // Resolve the package namespace off the freshest ExtensionAPI. Prefer the
  // process-global re-published reference (survives new_session /
  // switch_session / fork reloads); the captured `omp` is the fallback for
  // the pre-first-start window. Settings is process-scoped (like
  // modelRegistry), so fallback staleness is harmless for our use.
  function currentPi(): OmpPackageNamespaceLike | null {
    const api: unknown = globalState.getAomp?.() ?? omp;
    const pi = (api as { pi?: OmpPackageNamespaceLike } | null | undefined)?.pi;
    return pi ?? null;
  }

  function getSettingsInstance(): OmpSettingsInstanceLike | null {
    const pi = currentPi();
    const fromClass = pi?.Settings?.instance;
    if (fromClass && typeof fromClass === "object") return fromClass;
    const standalone = pi?.settings;
    if (standalone && typeof standalone === "object") return standalone;
    return null;
  }

  // Enumerate setting keys + metadata in-process. We try, in order:
  //   1. instance.list() / instance.entries() — full rows (key/value/type/
  //      description/redacted) when the runtime exposes them,
  //   2. the exported Settings.SETTINGS_SCHEMA key map.
  // Values are NOT trusted from enumeration — the caller refreshes them via
  // instance.get() so the WebView always sees effective in-process values.
  function collectInProcessSettingMetas(
    instance: OmpSettingsInstanceLike,
  ): Map<string, OmpSettingMeta> {
    const metas = new Map<string, OmpSettingMeta>();

    const upsert = (
      key: unknown,
      meta: { value?: unknown; type?: unknown; description?: unknown; redacted?: unknown },
    ) => {
      if (typeof key !== "string" || !key.trim()) return;
      const prev = metas.get(key);
      const type =
        typeof meta.type === "string" && meta.type ? meta.type : (prev?.type ?? "string");
      const description =
        typeof meta.description === "string" && meta.description
          ? meta.description
          : (prev?.description ?? "");
      const redacted = meta.redacted === true || (prev?.redacted ?? false);
      const hasValue = prev?.hasValue || meta.value !== undefined;
      const value = prev?.hasValue ? prev.value : meta.value;
      metas.set(key, { type, description, redacted, hasValue, value });
    };

    for (const method of ["list", "entries"] as const) {
      const fn = instance[method];
      if (typeof fn !== "function") continue;
      try {
        const out = fn.call(instance) as unknown;
        if (Array.isArray(out)) {
          for (const item of out) {
            if (typeof item === "string") upsert(item, {});
            else if (item && typeof item === "object") {
              upsert((item as { key?: unknown }).key, item as Record<string, unknown>);
            }
          }
        } else if (out && typeof out === "object") {
          for (const [key, meta] of Object.entries(out)) {
            if (meta && typeof meta === "object") upsert(key, meta as Record<string, unknown>);
            else upsert(key, { value: meta });
          }
        }
      } catch {}
    }

    const schema = currentPi()?.Settings?.SETTINGS_SCHEMA;
    if (schema && typeof schema === "object") {
      for (const [key, def] of Object.entries(schema)) {
        if (def && typeof def === "object") upsert(key, def as Record<string, unknown>);
        else upsert(key, {});
      }
    }

    return metas;
  }

  function buildInProcessSettingRows(
    instance: OmpSettingsInstanceLike,
    metas: Map<string, OmpSettingMeta>,
  ): AgentSettingRow[] {
    const rows: AgentSettingRow[] = [];
    for (const [key, meta] of metas) {
      const redacted = meta.redacted || isCredentialLikeKey(key);
      let value: unknown = meta.hasValue ? meta.value : null;
      if (!redacted && typeof instance.get === "function") {
        try {
          const live = instance.get(key);
          if (live !== undefined) value = live;
        } catch {}
      }
      rows.push({
        key,
        value: redacted ? null : (value ?? null),
        type: meta.type,
        description: meta.description,
        redacted,
      });
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }

  // CLI fallback catalog: `omp config list --json` prints
  // { "<dotted.key>": { value?, type, description, redacted? }, ... }.
  async function collectCliSettingRows(): Promise<AgentSettingRow[] | null> {
    let stdout: string;
    try {
      stdout = await execOmpCli(["config", "list", "--json"], OMP_CLI_TIMEOUT_MS);
    } catch (e) {
      const { cmd, prefix } = resolveOmpCliInvocation();
      console.error(
        `[Embedded] agent-settings CLI fallback spawn failed (${cmd} ${prefix.join(" ")}):`,
        errMessage(e),
      );
      return null;
    }
    let catalog: unknown;
    try {
      catalog = JSON.parse(stdout);
    } catch (e) {
      console.error(
        "[Embedded] agent-settings CLI fallback produced non-JSON output:",
        errMessage(e),
      );
      return null;
    }
    if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return null;
    const rows: AgentSettingRow[] = [];
    for (const [key, metaRaw] of Object.entries(catalog)) {
      const meta = (metaRaw && typeof metaRaw === "object" ? metaRaw : {}) as Record<
        string,
        unknown
      >;
      const redacted = meta.redacted === true || isCredentialLikeKey(key);
      rows.push({
        key,
        value: redacted ? null : (meta.value ?? null),
        type: typeof meta.type === "string" && meta.type ? meta.type : "string",
        description: typeof meta.description === "string" ? meta.description : "",
        redacted,
      });
    }
    return rows.sort((a, b) => a.key.localeCompare(b.key));
  }

  async function serveAgentSettingsCatalog(res: http.ServerResponse) {
    try {
      const instance = getSettingsInstance();
      let rows: AgentSettingRow[] | null = null;
      let source: "inprocess" | "cli" = "cli";
      if (instance) {
        const metas = collectInProcessSettingMetas(instance);
        if (metas.size > 0) {
          rows = buildInProcessSettingRows(instance, metas);
          source = "inprocess";
        } else {
          console.error(
            "[Embedded] agent-settings: in-process Settings instance reachable but no enumeration surface (list/entries/SETTINGS_SCHEMA) matched",
          );
        }
      } else {
        console.error(
          "[Embedded] agent-settings: in-process Settings surface unreachable (omp.pi missing)",
        );
      }
      if (!rows) {
        rows = await collectCliSettingRows();
      }
      if (!rows) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "Unable to enumerate agent settings (in-process Settings surface and `omp config list --json` both unavailable)",
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ agentRoot: OMP_AGENT_ROOT, source, settings: rows }));
    } catch (e: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(e) }));
    }
  }

  // Set one setting. In-process set() persists to the global layer and is
  // effective immediately; on absence/throw we fall back to the CLI.
  async function applyAgentSetting(key: string, value: unknown): Promise<void> {
    const instance = getSettingsInstance();
    if (instance && typeof instance.set === "function") {
      try {
        instance.set(key, value);
        // set() persists on a debounce; flush before responding so the write
        // survives an immediately-following process exit.
        if (typeof instance.flush === "function") {
          await instance.flush();
        }
        return;
      } catch {
        // Fall through to the CLI below — a set() throw usually means the
        // in-process surface rejected the value (unknown key, bad type).
      }
    }
    await execOmpCli(["config", "set", key, String(value)], OMP_CLI_TIMEOUT_MS);
  }

  // ═══════════════════════════════════════
  // Agent roster (B1) + MCP management (B2) — in-process surfaces
  // ═══════════════════════════════════════
  //
  // Both feature groups reach into the omp runtime's own singletons:
  //  - AgentRegistry: root export on the ExtensionAPI's package namespace
  //    (`omp.pi.AgentRegistry.global()`), process-scoped.
  //  - MCP: the `/mcp` subpath of the omp package (not on the root
  //    namespace). Access layers, first wins per call:
  //      a. namespace probe (future runtimes may expose it there),
  //      b. dynamic import inside the omp process (omp's extension loader
  //         installs a resolver shim that redirects the canonical
  //         `@oh-my-pi/*` specifiers to the host's own modules),
  //      c. local user-scope `mcp.json` CRUD (no scope discovery, no live
  //         status) when both fail.
  // Every step is feature-detected; failures degrade, never throw.

  const AGENTS_CHANGED_THROTTLE_MS = 500;

  // Computed at call time (never a literal at the import site) so the
  // esbuild bundle keeps these runtime-resolved: resolution MUST happen
  // inside the omp process, where the legacy-pi resolver shim lives.
  const MCP_MODULE_SPECIFIERS = ["@oh-my-pi/pi-coding-agent/mcp", "@oh-my-pi/omp-coding-agent/mcp"];

  function resolveAgentRegistry(): AgentRegistryLike | null {
    try {
      const ctor = currentPi()?.AgentRegistry;
      if (ctor && typeof ctor.global === "function") {
        const registry = ctor.global();
        if (registry && typeof registry.list === "function") {
          return registry;
        }
        console.error("[Embedded] AgentRegistry.global() returned no usable registry");
        return null;
      }
      console.error("[Embedded] omp namespace has no AgentRegistry export");
    } catch (err: unknown) {
      console.error("[Embedded] AgentRegistry resolution failed:", errMessage(err));
    }
    return null;
  }

  // Frozen sanitize: EXACTLY {id, name, kind, parentId, status, running,
  // sessionFile}. `advisor` refs are observability-only and excluded; `main`
  // refs are included (the GUI shows main + subs).
  function sanitizeAgentRef(
    ref: AgentRefLike,
    registry: AgentRegistryLike,
  ): {
    id: string;
    name: string;
    kind: string;
    parentId: string | null;
    status: string;
    running: boolean;
    sessionFile: string | null;
  } | null {
    if (!ref || typeof ref !== "object") return null;
    const kind = typeof ref.kind === "string" ? ref.kind : "sub";
    if (kind === "advisor") return null;
    const id = typeof ref.id === "string" ? ref.id : "";
    let running = false;
    try {
      running = registry.isRunning ? registry.isRunning(ref) === true : false;
    } catch {}
    return {
      id,
      name: typeof ref.displayName === "string" && ref.displayName ? ref.displayName : id,
      kind,
      parentId: typeof ref.parentId === "string" && ref.parentId ? ref.parentId : null,
      status: typeof ref.status === "string" ? ref.status : "unknown",
      running,
      sessionFile: typeof ref.sessionFile === "string" && ref.sessionFile ? ref.sessionFile : null,
    };
  }

  type SanitizedAgent = NonNullable<ReturnType<typeof sanitizeAgentRef>>;

  function listSanitizedAgents(): { agents: SanitizedAgent[]; available: boolean } {
    const registry = resolveAgentRegistry();
    if (!registry) return { agents: [], available: false };
    try {
      const refs = registry.list?.() ?? [];
      if (!Array.isArray(refs)) return { agents: [], available: false };
      const agents: SanitizedAgent[] = [];
      for (const ref of refs) {
        const sanitized = sanitizeAgentRef(ref as AgentRefLike, registry);
        if (sanitized) agents.push(sanitized);
      }
      return { agents, available: true };
    } catch (err: unknown) {
      console.error("[Embedded] list_agents failed:", errMessage(err));
      return { agents: [], available: false };
    }
  }

  // Transcript serving for subagent session files. Subagent transcripts live
  // in a nested tree under the sessions root (`<session>.jsonl` → sibling
  // directory `<session>/…`), which the two-segment `/api/sessions/:dir/:file`
  // route cannot address — hence this RPC with identical path-safety checks.
  async function readAgentTranscript(
    sessionPath: string,
  ): Promise<{ entries: unknown[]; sessionFile: string }> {
    const sessionsRoot = path.resolve(SESSIONS_DIR);
    const filePath = path.resolve(sessionPath);
    if (filePath === sessionsRoot || !filePath.startsWith(sessionsRoot + path.sep)) {
      throw new Error("Transcript path must resolve inside the sessions root");
    }
    let realSessionsRoot = "";
    let realFilePath = "";
    try {
      realSessionsRoot = fs.realpathSync(sessionsRoot);
      realFilePath = fs.realpathSync(filePath);
    } catch {
      throw new Error("Transcript not found");
    }
    if (
      realFilePath === realSessionsRoot ||
      !realFilePath.startsWith(realSessionsRoot + path.sep)
    ) {
      throw new Error("Transcript path must resolve inside the sessions root");
    }
    const content = await fs.promises.readFile(realFilePath, "utf8");
    const entries: unknown[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        /* skip malformed lines, mirroring serveSessionFile */
      }
    }
    return { entries, sessionFile: realFilePath };
  }

  // Layer (a): does the runtime namespace itself carry the mcp exports?
  function probeNamespaceForMcpModule(): McpModuleLike | null {
    const pi = currentPi() as unknown as Record<string, unknown> | null;
    if (!pi) return null;
    for (const key of ["mcp", "MCP", "Mcp"]) {
      const candidate = pi[key];
      if (
        candidate &&
        typeof candidate === "object" &&
        typeof (candidate as McpModuleLike).loadAllMCPConfigs === "function"
      ) {
        return candidate as McpModuleLike;
      }
    }
    if (typeof pi.loadAllMCPConfigs === "function") {
      return pi as unknown as McpModuleLike;
    }
    return null;
  }

  // Candidate roots for the installed omp package that hosts this process:
  //   - OMPCOT_OMP_BIN (Rust manager passes the exact binary it spawned)
  //   - process.argv[1] for shim installs (`bun <pkg>/dist/cli.js` layout)
  // Compiled `bun build --compile` binaries have no package tree next to
  // them — those candidates simply fail the src/mcp/index.ts existence
  // check and resolution falls through to the bare-specifier attempts.
  function ompMcpSourceCandidates(): string[] {
    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const base of [process.env.OMPCOT_OMP_BIN?.trim(), process.argv[1]]) {
      if (!base) continue;
      const pkgRoot = path.resolve(base, "..", "..");
      if (seen.has(pkgRoot)) continue;
      seen.add(pkgRoot);
      candidates.push(path.join(pkgRoot, "src", "mcp", "index.ts"));
    }
    return candidates;
  }

  // Layers (a) → (b) → (b'). Cached per process; `null` (unreachable) is
  // cached too. Verified against installed omp 18.3.0:
  //   - the omp namespace does NOT carry the mcp exports (layer a misses),
  //   - importing the host package's own src/mcp/index.ts via its absolute
  //     file URL resolves to the SAME module instance omp uses internally
  //     (shared MCPManager singleton, shared AgentRegistry-adjacent state),
  //   - bare-specifier dynamic imports from the bundled extension do NOT
  //     resolve (the extension has no peer install and omp's load-time
  //     source rewrite only rewrites literal specifiers, which esbuild
  //     bundling would try to resolve at build time). They are kept as a
  //     last-ditch attempt for compiled-binary hosts whose virtual module
  //     registry may serve them.
  async function resolveMcpModule(): Promise<McpModuleLike | null> {
    const viaNamespace = probeNamespaceForMcpModule();
    if (viaNamespace) return viaNamespace;

    if (!globalState.mcpModuleCache.promise) {
      globalState.mcpModuleCache.promise = (async () => {
        for (const filePath of ompMcpSourceCandidates()) {
          if (!fs.existsSync(filePath)) continue;
          try {
            const mod =
              ((await import(pathToFileURL(filePath).href)) as McpModuleLike | null | undefined) ??
              null;
            if (mod && typeof mod.loadAllMCPConfigs === "function") {
              return mod;
            }
            console.error(
              `[Embedded] MCP module candidate "${filePath}" loaded without loadAllMCPConfigs`,
            );
          } catch (err: unknown) {
            console.error(
              `[Embedded] MCP module import failed for "${filePath}":`,
              errMessage(err),
            );
          }
        }
        for (const specifier of MCP_MODULE_SPECIFIERS) {
          try {
            const mod = ((await import(specifier)) as McpModuleLike | null | undefined) ?? null;
            if (mod && typeof mod.loadAllMCPConfigs === "function") {
              return mod;
            }
            console.error(
              `[Embedded] MCP module candidate "${specifier}" resolved without loadAllMCPConfigs`,
            );
          } catch {
            /* bare-specifier resolution needs the host's shim — expected to miss */
          }
        }
        console.error(
          "[Embedded] MCP module unreachable: namespace probe and dynamic import both failed — serving user-scope mcp.json CRUD only",
        );
        return null;
      })();
    }
    return await globalState.mcpModuleCache.promise;
  }

  // The live, session-owned manager (installed via MCPManager.setInstance by
  // the omp runtime when the top-level session was created). We never
  // fabricate one: a synthetic manager's connections would be invisible to
  // the session and could double-spawn stdio servers.
  function findLiveMcpManager(mod: McpModuleLike): McpManagerLike | null {
    try {
      const manager = mod.MCPManager?.instance?.();
      if (manager && typeof manager.getConnectionStatus === "function") {
        return manager;
      }
    } catch (err: unknown) {
      console.error("[Embedded] MCPManager.instance() probe failed:", errMessage(err));
    }
    return null;
  }

  // Record "failed" / "reconnecting" transitions the synchronous
  // getConnectionStatus() cannot express. Attached once per process.
  async function attachMcpStatusListener(mod: McpModuleLike): Promise<void> {
    if (globalState.mcpStatusListenerAttached) return;
    const manager = findLiveMcpManager(mod);
    if (!manager || typeof manager.addConnectionStatusListener !== "function") return;
    try {
      const unsubscribe = manager.addConnectionStatusListener((event) => {
        const name = event?.serverName;
        const type = event?.type;
        if (typeof name !== "string" || typeof type !== "string") return;
        if (type === "failed" || type === "reconnecting") {
          globalState.mcpStatusByServer.set(name, type);
        } else if (type === "connected") {
          globalState.mcpStatusByServer.delete(name);
        }
      });
      if (typeof unsubscribe === "function") {
        globalState.mcpStatusListenerAttached = true;
      }
    } catch (err: unknown) {
      console.error("[Embedded] MCP status listener attach failed:", errMessage(err));
    }
  }

  function mcpServerStatus(manager: McpManagerLike | null, name: string): McpServerRow["status"] {
    if (!manager) return "unknown";
    let raw = "";
    try {
      raw = manager.getConnectionStatus?.(name) ?? "";
    } catch {
      return "unknown";
    }
    if (raw === "connected") return "connected";
    if (raw === "connecting") return "connecting";
    const last = globalState.mcpStatusByServer.get(name);
    if (last === "failed") return "failed";
    if (last === "reconnecting") return "reconnecting";
    return "disconnected";
  }

  function mcpServerToolCount(manager: McpManagerLike | null, name: string): number | undefined {
    if (!manager || typeof manager.getTools !== "function") return undefined;
    try {
      let count = 0;
      for (const tool of manager.getTools() ?? []) {
        if (tool?.details?.serverName === name) count++;
      }
      return count;
    } catch {
      return undefined;
    }
  }

  // The workspace root this server instance serves. omp is spawned with
  // cwd = workspace; the session entry's cwd is preferred when known
  // (same precedence as the /api/git-branch route).
  function currentWorkspaceCwd(): string {
    const ctx = globalState.getLatestCtx?.() ?? latestCtx;
    return resolveGitBranchCwd({
      foregroundPort: null,
      fallbackCwd: process.cwd(),
      instances: getRunningInstances(),
      latestCtx: ctx ?? null,
    });
  }

  // User-scope MCP config: <agentRoot>/mcp.json (matches the runtime's
  // getMCPConfigPath("user")). Project-scope: <cwd>/.omp/mcp.json (the
  // native project config the runtime's writer targets).
  function mcpUserConfigPath(): string {
    return path.join(OMP_AGENT_ROOT, "mcp.json");
  }

  function mcpProjectConfigPath(cwd: string): string {
    return path.join(cwd, ".omp", "mcp.json");
  }

  // Only omp-owned config formats are safe to mutate: `native` (~/.omp and
  // .omp/mcp.json) and `mcp-json` (standalone project mcp.json/.mcp.json).
  // Tool-owned sources (claude.json, codex, cursor, …) are read-only; their
  // enable/disable goes through the user-level override lists instead.
  function isWritableMcpSource(source: McpSourceMetaLike | null | undefined): boolean {
    return (
      !!source &&
      typeof source.provider === "string" &&
      (source.provider === "native" || source.provider === "mcp-json")
    );
  }

  function buildMcpServerRow(
    name: string,
    config: McpServerConfigLike | undefined,
    options: {
      enabled: boolean;
      source: string;
      sourcePath: string;
      writable: boolean;
      manager: McpManagerLike | null;
    },
  ): McpServerRow {
    const cfg = config ?? {};
    const type = cfg.type === "http" || cfg.type === "sse" ? cfg.type : "stdio";
    const row: McpServerRow = {
      name,
      type,
      enabled: options.enabled,
      source: options.source,
      sourcePath: options.sourcePath,
      writable: options.writable,
      status: mcpServerStatus(options.manager, name),
    };
    if (type === "stdio") {
      if (typeof cfg.command === "string") row.command = cfg.command;
      if (Array.isArray(cfg.args)) row.args = cfg.args;
    } else if (typeof cfg.url === "string") {
      row.url = cfg.url;
    }
    const toolCount = mcpServerToolCount(options.manager, name);
    if (typeof toolCount === "number") row.toolCount = toolCount;
    return row;
  }

  // Layer (c): direct JSON file access, used only when the omp MCP module is
  // unreachable. User scope only — no scope discovery is reimplemented.
  function readLocalMcpConfigFile(filePath: string): McpConfigFileLike {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as McpConfigFileLike;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeLocalMcpConfigFile(filePath: string, config: McpConfigFileLike): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
  }

  async function listMcpServers(): Promise<{
    servers: McpServerRow[];
    capabilities: { liveStatus: boolean; connect: boolean };
  }> {
    const mod = await resolveMcpModule();
    const manager = mod ? findLiveMcpManager(mod) : null;
    if (mod) await attachMcpStatusListener(mod);

    const rows = new Map<string, McpServerRow>();
    const cwd = currentWorkspaceCwd();
    const userPath = mcpUserConfigPath();
    const projectPath = mcpProjectConfigPath(cwd);

    // 1. The loader's effective view: every visible (enabled) server across
    //    ALL sources, with proper SourceMeta and env expansion.
    if (mod?.loadAllMCPConfigs) {
      try {
        const loaded = await mod.loadAllMCPConfigs(cwd);
        const configs = loaded?.configs ?? {};
        const sources = loaded?.sources ?? {};
        for (const [name, config] of Object.entries(configs)) {
          const source = sources[name];
          let sourceLabel = (source && (source.providerName || source.provider)) || "discovered";
          if (source && (source.level === "user" || source.level === "project")) {
            sourceLabel = `${sourceLabel} (${source.level})`;
          }
          rows.set(
            name,
            buildMcpServerRow(name, config, {
              // Survivors of the loader are effectively enabled (suppressed
              // entries are excluded from its result entirely).
              enabled: true,
              source: sourceLabel,
              sourcePath: source && typeof source.path === "string" ? source.path : "",
              writable: isWritableMcpSource(source),
              manager,
            }),
          );
        }
      } catch (err: unknown) {
        console.error("[Embedded] mcp.list: loadAllMCPConfigs failed:", errMessage(err));
      }
    }

    // 2. Rows the loader suppressed (disabled entries in omp-owned files)
    //    still belong in the list — the GUI needs them to re-enable. Mirrors
    //    omp's own `/mcp list`: config files + disabledServers union.
    if (mod?.readMCPConfigFile) {
      let userFile: McpConfigFileLike | null = null;
      try {
        userFile = await mod.readMCPConfigFile(userPath);
      } catch {}
      const deniedSet = new Set(
        Array.isArray(userFile?.disabledServers) ? userFile.disabledServers : [],
      );
      const fileScopes = [
        { filePath: userPath, label: "OMP (user)" },
        { filePath: projectPath, label: "OMP (project)" },
        { filePath: path.join(cwd, "mcp.json"), label: "MCP Config (project)" },
        { filePath: path.join(cwd, ".mcp.json"), label: "MCP Config (project)" },
      ];
      for (const scopeInfo of fileScopes) {
        let file: McpConfigFileLike | null = null;
        try {
          file = await mod.readMCPConfigFile(scopeInfo.filePath);
        } catch {
          continue;
        }
        for (const [name, config] of Object.entries(file?.mcpServers ?? {})) {
          if (rows.has(name)) continue;
          rows.set(
            name,
            buildMcpServerRow(name, config, {
              enabled: !deniedSet.has(name) && config?.enabled !== false,
              source: scopeInfo.label,
              sourcePath: scopeInfo.filePath,
              writable: true,
              manager,
            }),
          );
        }
      }
      // 3. Denylist-only names (foreign/plugin sources disabled via the
      //    override list): show a minimal row so they can be re-enabled.
      for (const name of deniedSet) {
        if (rows.has(name)) continue;
        rows.set(name, {
          name,
          type: "stdio",
          enabled: false,
          source: "user",
          sourcePath: userPath,
          writable: true,
          status: mcpServerStatus(manager, name),
        });
      }
    }

    // Layer (c): no module at all — serve user-scope file rows only.
    if (!mod) {
      const file = readLocalMcpConfigFile(userPath);
      for (const [name, config] of Object.entries(file.mcpServers ?? {})) {
        rows.set(
          name,
          buildMcpServerRow(name, config, {
            enabled: config?.enabled !== false,
            source: "user",
            sourcePath: userPath,
            writable: true,
            manager: null,
          }),
        );
      }
    }

    return {
      servers: [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)),
      capabilities: { liveStatus: manager !== null, connect: manager !== null },
    };
  }

  function requireMcpConfigInput(input: unknown): McpServerConfigLike {
    // Pass through the documented config shape untouched (type, command,
    // args, env, url, headers, enabled, timeout); the runtime validators do
    // the real checking. Rejects non-object junk up front.
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("config must be an object");
    }
    return input as McpServerConfigLike;
  }

  // F19 (P1): non-destructive merge for `mcp.save`.
  //
  // Both writers we can reach — omp's `updateMCPServer` and the local
  // fallback writer — REPLACE the whole server entry. A GUI edit that only
  // changes `command` (and legitimately omits env/headers/timeout/enabled/
  // cwd/auth because its form never shows them) would silently destroy
  // those fields. So before writing we load the existing raw entry for
  // name+scope and merge:
  //   - every field present in the submitted config wins verbatim;
  //   - omitted fields are preserved from the existing entry;
  //   - EXPLICIT CLEARING for the container fields: submitting env:"" /
  //     env:{} / headers:"" / headers:{} / args:[] clears that field (the
  //     caller saying "no value" on purpose). Scalars can't express
  //     "clear" — send the value you want (e.g. enabled:false).
  //   - transport-switch hygiene: when the submitted config explicitly
  //     changes `type`, fields that only make sense for the OTHER transport
  //     family are dropped instead of carried over as dead weight
  //     (stdio→http drops command/args/env/cwd; http→stdio drops
  //     url/headers), unless the submitted config sets them itself.
  const MCP_CLEARABLE_FIELDS = new Set(["env", "headers", "args"]);
  const MCP_STDIO_ONLY_FIELDS = ["command", "args", "env", "cwd"];
  const MCP_HTTP_ONLY_FIELDS = ["url", "headers"];

  function isEmptyMcpValue(value: unknown): boolean {
    if (value === "") return true;
    if (Array.isArray(value)) return value.length === 0;
    if (value !== null && typeof value === "object") return Object.keys(value).length === 0;
    return false;
  }

  function mergeMcpServerConfig(
    existing: McpServerConfigLike | undefined,
    submitted: McpServerConfigLike,
  ): McpServerConfigLike {
    if (!existing || typeof existing !== "object") return submitted;
    const merged: Record<string, unknown> = { ...existing };

    const existingType = typeof existing.type === "string" ? existing.type : undefined;
    const submittedType = typeof submitted.type === "string" ? submitted.type : undefined;
    if (submittedType && existingType && submittedType !== existingType) {
      const staleFields = submittedType === "stdio" ? MCP_HTTP_ONLY_FIELDS : MCP_STDIO_ONLY_FIELDS;
      for (const key of staleFields) {
        if (!(key in submitted)) delete merged[key];
      }
    }

    for (const [key, value] of Object.entries(submitted as Record<string, unknown>)) {
      if (value === undefined) continue; // JSON round-trips never carry undefined
      if (MCP_CLEARABLE_FIELDS.has(key) && isEmptyMcpValue(value)) {
        delete merged[key]; // explicit clear (see rules above)
        continue;
      }
      merged[key] = value;
    }
    return merged as McpServerConfigLike;
  }

  async function saveMcpServer(
    name: string,
    configInput: unknown,
    scope: "user" | "project",
  ): Promise<{ name: string; scope: string; path: string; created: boolean }> {
    const cwd = currentWorkspaceCwd();
    const filePath = scope === "user" ? mcpUserConfigPath() : mcpProjectConfigPath(cwd);
    const mod = await resolveMcpModule();
    const submitted = requireMcpConfigInput(configInput);

    // F19: load the existing raw entry for name+scope BEFORE writing so the
    // merge can preserve fields the caller omitted (both omp's
    // updateMCPServer and the local writer REPLACE the whole entry — see
    // mergeMcpServerConfig for the exact rules).
    let existingEntry: McpServerConfigLike | undefined;
    if (mod?.readMCPConfigFile) {
      try {
        existingEntry = (await mod.readMCPConfigFile(filePath)).mcpServers?.[name];
      } catch {}
    } else if (scope === "user") {
      existingEntry = readLocalMcpConfigFile(filePath).mcpServers?.[name];
    }
    let existing = existingEntry !== undefined;
    if (!existing && mod?.listMCPServers) {
      try {
        existing = (await mod.listMCPServers(filePath)).includes(name);
      } catch {}
    }
    const config = mergeMcpServerConfig(existingEntry, submitted);

    if (mod?.validateServerName) {
      const nameError = mod.validateServerName(name);
      if (nameError) throw new Error(nameError);
    }
    if (mod?.validateServerConfig) {
      const errors = mod.validateServerConfig(name, config);
      if (Array.isArray(errors) && errors.length > 0) {
        throw new Error(`Invalid server config: ${errors.join("; ")}`);
      }
    }

    if (mod?.addMCPServer && mod.updateMCPServer) {
      if (existing) {
        await mod.updateMCPServer(filePath, name, config);
      } else {
        await mod.addMCPServer(filePath, name, config);
      }
      return { name, scope, path: filePath, created: !existing };
    }

    // Layer (c): local user-scope CRUD only.
    if (scope !== "user") {
      throw new Error(
        "Project-scope MCP saves require the omp MCP module, which is unavailable in this build",
      );
    }
    const file = readLocalMcpConfigFile(filePath);
    const created = file.mcpServers?.[name] === undefined;
    writeLocalMcpConfigFile(filePath, {
      ...file,
      mcpServers: { ...(file.mcpServers ?? {}), [name]: config },
    });
    return { name, scope, path: filePath, created };
  }

  async function removeMcpServerByName(
    name: string,
    scope: "user" | "project",
  ): Promise<{ name: string; scope: string; path: string }> {
    const cwd = currentWorkspaceCwd();
    const filePath = scope === "user" ? mcpUserConfigPath() : mcpProjectConfigPath(cwd);
    const mod = await resolveMcpModule();

    if (mod?.removeMCPServer) {
      await mod.removeMCPServer(filePath, name);
      return { name, scope, path: filePath };
    }

    if (scope !== "user") {
      throw new Error(
        "Project-scope MCP removal requires the omp MCP module, which is unavailable in this build",
      );
    }
    const file = readLocalMcpConfigFile(filePath);
    if (!file.mcpServers?.[name]) {
      throw new Error(`Server "${name}" not found in ${filePath}`);
    }
    const { [name]: _removed, ...remaining } = file.mcpServers;
    writeLocalMcpConfigFile(filePath, { ...file, mcpServers: remaining });
    return { name, scope, path: filePath };
  }

  async function toggleMcpServer(
    name: string,
    enabled: boolean,
  ): Promise<{ name: string; enabled: boolean; sourcePath: string | null }> {
    const cwd = currentWorkspaceCwd();
    const userPath = mcpUserConfigPath();
    const projectPath = mcpProjectConfigPath(cwd);
    const mod = await resolveMcpModule();

    if (mod?.setMcpServerEnabled) {
      // setMcpServerEnabled mutates omp-owned source files directly and uses
      // the user-level override lists for non-writable sources. It needs the
      // sourcePath ONLY for formats the runtime owns (native / mcp-json).
      let sourcePath: string | undefined;
      try {
        const loaded = await mod.loadAllMCPConfigs?.(cwd);
        const source = loaded?.sources?.[name];
        if (isWritableMcpSource(source) && typeof source?.path === "string") {
          sourcePath = source.path;
        }
      } catch {}
      if (!sourcePath && mod.readMCPConfigFile) {
        // Disabled rows are invisible to the loader — scan the omp-owned
        // files directly (project scope wins, mirroring write precedence).
        for (const candidate of [
          projectPath,
          path.join(cwd, "mcp.json"),
          path.join(cwd, ".mcp.json"),
          userPath,
        ]) {
          try {
            const file = await mod.readMCPConfigFile(candidate);
            if (file?.mcpServers?.[name] !== undefined) {
              sourcePath = candidate;
              break;
            }
          } catch {}
        }
      }
      await mod.setMcpServerEnabled({ userPath, projectPath, sourcePath, name, enabled });
      return { name, enabled, sourcePath: sourcePath ?? null };
    }

    // Layer (c): user-scope file only.
    const file = readLocalMcpConfigFile(userPath);
    if (file.mcpServers?.[name] !== undefined) {
      writeLocalMcpConfigFile(userPath, {
        ...file,
        mcpServers: { ...file.mcpServers, [name]: { ...file.mcpServers[name], enabled } },
      });
      return { name, enabled, sourcePath: userPath };
    }
    const current = new Set(file.disabledServers ?? []);
    if (enabled) {
      current.delete(name);
    } else {
      current.add(name);
    }
    const disabledServers = [...current].sort();
    writeLocalMcpConfigFile(userPath, {
      ...file,
      disabledServers: disabledServers.length > 0 ? disabledServers : undefined,
    });
    return { name, enabled, sourcePath: userPath };
  }

  async function controlMcpConnection(
    name: string,
    action: "connect" | "disconnect" | "reconnect",
  ): Promise<{ name: string; action: string; status: McpServerRow["status"] }> {
    const mod = await resolveMcpModule();
    const manager = mod ? findLiveMcpManager(mod) : null;
    if (!mod || !manager) {
      throw new Error("MCP connection control unavailable in this build");
    }
    await attachMcpStatusListener(mod);

    if (action === "disconnect") {
      if (typeof manager.disconnectServer !== "function") {
        throw new Error("MCP connection control unavailable in this build");
      }
      await manager.disconnectServer(name);
    } else if (action === "reconnect") {
      if (typeof manager.reconnectServer !== "function") {
        throw new Error("MCP connection control unavailable in this build");
      }
      await manager.reconnectServer(name, { manual: true });
    } else {
      if (
        typeof manager.connectServers !== "function" ||
        typeof mod.loadAllMCPConfigs !== "function"
      ) {
        throw new Error("MCP connection control unavailable in this build");
      }
      const cwd = currentWorkspaceCwd();
      const result = await mod.loadAllMCPConfigs(cwd);
      const config = result?.configs?.[name];
      if (!config) {
        throw new Error(`MCP server "${name}" not found or disabled`);
      }
      const sources = result?.sources ?? {};
      await manager.connectServers(
        { [name]: config },
        sources[name] ? { [name]: sources[name] } : {},
      );
    }
    return { name, action, status: mcpServerStatus(manager, name) };
  }

  // ═══════════════════════════════════════
  // API routes (sessions list, etc.)
  // ═══════════════════════════════════════
  async function handleApiRoute(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    urlPath: string,
  ) {
    urlPath = normalizeApiRoutePath(urlPath);

    // CORS (audit A5): never a wildcard. Mirror the Origin only when it is a
    // loopback origin or matches this request's own Host (same-origin fetch
    // with an explicit Origin). Same-origin WebView requests carry no Origin
    // header at all and need no CORS.
    const originHeader = req.headers.origin;
    if (
      typeof originHeader === "string" &&
      originHeader &&
      isTrustedCorsOrigin(originHeader, req.headers.host || "")
    ) {
      res.setHeader("Access-Control-Allow-Origin", originHeader);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (urlPath === "/api/health") {
      // Keep the legacy `mirrorUrl` field name in the payload — the frontend
      // still reads it via the old name, and renaming is a churn-without-
      // benefit change scoped out of this migration.
      res.writeHead(200, { "Content-Type": "application/json" });
      const healthPayload: Record<string, unknown> = {
        status: "ok",
        mode: "embedded",
        mirrorUrl: globalState.localUrl,
        // Audit A5: let the UI distinguish loopback vs LAN mode.
        lanEnabled: isLanBindEnabled(),
        bindMode: isLanBindEnabled() ? "lan" : "loopback",
        bindHost: BIND_HOST,
      };
      const lanUrls = buildLanUrls(globalState.server?.port || PORT);
      if (isLanBindEnabled()) {
        healthPayload.lanUrl = lanUrls[0] || null;
        healthPayload.lanUrls = lanUrls;
      }
      res.end(JSON.stringify(healthPayload));
      return;
    }

    if (urlPath === "/api/lan-qr" && req.method === "GET") {
      const lanUrls = buildLanUrls(globalState.server?.port || PORT);
      const url = lanUrls[0] || "";
      if (!url) {
        // Audit A5: in loopback mode there is no LAN URL to encode; keep the
        // 404 contract but tell the UI why via the mode fields.
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "LAN URL unavailable",
            lanEnabled: false,
            bindMode: "loopback",
            bindHost: BIND_HOST,
          }),
        );
        return;
      }
      try {
        const dataUrl = await QRCode.toDataURL(url, { width: 280, margin: 2 });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            dataUrl,
            url,
            // Audit A5: distinguish loopback vs LAN mode for the UI.
            lanEnabled: true,
            bindMode: "lan",
            bindHost: BIND_HOST,
          }),
        );
      } catch {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to generate QR code" }));
      }
      return;
    }

    if (urlPath === "/api/omp-version" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, version: EMBEDDED_OMP_VERSION }));
      return;
    }

    if (urlPath === "/api/instances") {
      res.writeHead(200, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ instances: getRunningInstances() }));
      return;
    }

    if (urlPath === "/api/sessions" && req.method === "GET") {
      serveSessionsList(res);
      return;
    }

    if (urlPath.startsWith("/api/cost-dashboard") && req.method === "GET") {
      serveCostDashboard(req, res);
      return;
    }

    // Current git branch for the active workspace
    if (urlPath === "/api/git-branch" && req.method === "GET") {
      const gitBranchUrl = new URL(`http://localhost${req.url}`);
      const requestedPort = Number(gitBranchUrl.searchParams.get("foregroundPort"));
      const cwd = resolveGitBranchCwd({
        foregroundPort: Number.isFinite(requestedPort) ? requestedPort : null,
        fallbackCwd: process.cwd(),
        instances: getRunningInstances(),
        latestCtx,
      });
      execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }, (err, stdout) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (err) {
          res.end(JSON.stringify({ branch: null }));
          return;
        }
        const branch = stdout.toString().trim();
        res.end(JSON.stringify({ branch: branch || null }));
      });
      return;
    }

    // Full-text search across sessions
    if (urlPath.startsWith("/api/search") && req.method === "GET") {
      const searchUrl = new URL(`http://localhost${req.url}`);
      const q = searchUrl.searchParams.get("q") || "";
      serveSearch(res, q);
      return;
    }

    // File browser: list directory
    if (urlPath === "/api/files" || urlPath.startsWith("/api/files?")) {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const filesUrl = new URL(`http://localhost${req.url}`);
        const explicitPath = filesUrl.searchParams.get("path");
        let dirPath = explicitPath || process.cwd();
        if (!explicitPath && latestCtx) {
          try {
            const entries = latestCtx.sessionManager.getEntries();
            const sessionEntry = entries.find((e: { type?: string }) => e.type === "session");
            if (sessionEntry?.cwd) dirPath = sessionEntry.cwd;
          } catch {}
        }
        serveFileList(res, dirPath);
      } catch (err: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: errMessage(err) }));
      }
      return;
    }

    // File browser: open file natively (or hand a URL off to the OS default browser).
    if (urlPath === "/api/open" && req.method === "POST") {
      readCappedBody(req, res, (body) => {
        try {
          const { filePath: fp } = JSON.parse(body);
          if (!fp || typeof fp !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePath required" }));
            return;
          }
          execFile("open", [fp], (err) => {
            if (err) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: errMessage(err) }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          });
        } catch (err: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(err) }));
        }
      });
      return;
    }

    // Session file endpoint: /api/sessions/:dirName/:file
    const sessionMatch = urlPath.match(/^\/api\/sessions\/([^/]+)\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      serveSessionFile(res, sessionMatch[1], sessionMatch[2]);
      return;
    }

    // RPC proxy — handle via WebSocket command handler
    if (urlPath === "/api/rpc" && req.method === "POST") {
      readCappedBody(req, res, async (body) => {
        let command: RpcCommand;
        try {
          const parsed: unknown = JSON.parse(body);
          // Audit A4: a body that is not a non-null object with a string
          // `type` used to make handleCommand throw synchronously inside a
          // Promise executor, so the response never settled and the request
          // hung forever. Reject it up front instead.
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            typeof (parsed as { type?: unknown }).type !== "string"
          ) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: "RPC body must be a JSON object with a string 'type'" }),
            );
            return;
          }
          command = parsed as RpcCommand;
        } catch (e: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(e) }));
          return;
        }
        try {
          // Create a fake WebSocket-like object to capture the response.
          // ANY failure before the response frame is registered (sync throw
          // or rejection inside handleCommand) rejects this promise so the
          // HTTP request gets an error response instead of hanging (A4).
          const response = await new Promise<unknown>((resolve, reject) => {
            const fakeWs: UnifiedWS = {
              readyState: WS_OPEN,
              send: (data: string) => {
                try {
                  resolve(JSON.parse(data));
                } catch (e: unknown) {
                  reject(e);
                }
              },
              close: () => {},
              terminate: () => {},
              ping: () => {},
            };
            Promise.resolve(handleCommand(fakeWs, command)).catch(reject);
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        } catch (e: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: command.id ?? null, error: errMessage(e) }));
        }
      });
      return;
    }

    if (urlPath === "/api/sessions/delete-batch" && req.method === "POST") {
      readCappedBody(req, res, async (body) => {
        try {
          const { filePaths } = JSON.parse(body);
          if (!Array.isArray(filePaths)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "filePaths must be an array" }));
            return;
          }

          let deleted = 0;
          const errors: string[] = [];
          const resolvedSessionsDir = path.resolve(SESSIONS_DIR);
          // Audit A9: containment must hold against the *real* filesystem
          // paths, not just lexical prefixes — a symlink inside the sessions
          // tree pointing outside must be rejected. If the sessions dir
          // itself can't be resolved, nothing is deletable.
          let realSessionsDir: string | null = null;
          try {
            realSessionsDir = fs.realpathSync(resolvedSessionsDir);
          } catch {}

          for (const fp of filePaths) {
            // Safety: must be a string, end with .jsonl, resolve strictly
            // inside SESSIONS_DIR lexically, AND its realpath must stay
            // strictly inside the realpath of SESSIONS_DIR (symlink escape
            // rejected).
            if (
              typeof fp !== "string" ||
              !fp.endsWith(".jsonl") ||
              !path.resolve(fp).startsWith(resolvedSessionsDir + path.sep)
            ) {
              errors.push(fp);
              continue;
            }
            if (!realSessionsDir) {
              errors.push(fp);
              continue;
            }
            let realFp: string;
            try {
              realFp = fs.realpathSync(path.resolve(fp));
            } catch {
              // Missing/unresolvable target — report as error, never delete.
              errors.push(fp);
              continue;
            }
            if (!realFp.startsWith(realSessionsDir + path.sep)) {
              errors.push(fp);
              continue;
            }
            try {
              await fs.promises.unlink(fp);
              globalState.sessionHeaderCache.delete(fp);
              globalState.sessionMetricsCache.delete(fp);
              deleted++;
            } catch {
              errors.push(fp);
            }
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ deleted, errors }));
        } catch (e: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(e) }));
        }
      });
      return;
    }

    // Session switch — in embedded mode, this is a no-op (session is controlled by Ompcot).
    if (urlPath === "/api/sessions/switch" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          embedded: true,
          note: "Session switching is controlled by Ompcot's Rust side",
        }),
      );
      return;
    }

    if (urlPath === "/api/workspace/open" && req.method === "POST") {
      console.log("[Embedded] Received workspace open request");
      readCappedBody(req, res, async (body) => {
        try {
          const { path: workspacePath } = JSON.parse(body);
          if (!workspacePath || typeof workspacePath !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "path required" }));
            return;
          }
          const resolved = workspacePath.startsWith("~")
            ? path.join(process.env.HOME || "", workspacePath.slice(1))
            : workspacePath;
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: `Directory not found: ${resolved}` }));
            return;
          }
          // Open a new terminal window running omp in the selected directory.
          // Note: this still uses the user's PATH `omp`, not the embedded one,
          // because Ompcot's own workspace flow lives in Tauri commands;
          // this endpoint is the legacy "open in external terminal" affordance.
          //
          // Audit A2: the path crosses into the terminal via argument arrays
          // only (no shell string building) — see openTerminalInDirectory.
          // The outcome is reported truthfully; no unconditional {ok:true}.
          const outcome = await openTerminalInDirectory(resolved);
          if (outcome.ok) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, path: resolved }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: outcome.error }));
          }
        } catch (e: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(e) }));
        }
      });
      return;
    }

    // Agent settings catalog (omp config): schema + effective values for
    // the Settings → Agent panel. Enumerated in-process off the omp
    // runtime's Settings singleton when possible (source: "inprocess"),
    // falling back to `omp config list --json` (source: "cli"). Redacted /
    // credential-like keys always come back with value: null — the catalog
    // is for schema/UI, never for secret retrieval.
    if (urlPath === "/api/agent-settings" && req.method === "GET") {
      await serveAgentSettingsCatalog(res);
      return;
    }

    if (urlPath === "/api/agent-settings" && req.method === "PUT") {
      readCappedBody(req, res, async (body) => {
        let key: unknown;
        let value: unknown;
        try {
          const parsed = JSON.parse(body);
          key = parsed?.key;
          value = parsed?.value ?? null;
        } catch (e: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(e) }));
          return;
        }
        if (typeof key !== "string" || !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(key)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: 'key must be a non-empty dotted path (e.g. "theme", "auth.broker.token")',
            }),
          );
          return;
        }
        try {
          await applyAgentSetting(key, value);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, key, value }));
        } catch (e: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(e) }));
        }
      });
      return;
    }

    if (urlPath === "/api/agent-settings/reset" && req.method === "POST") {
      readCappedBody(req, res, async (body) => {
        let key: unknown;
        try {
          key = JSON.parse(body)?.key;
        } catch (e: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(e) }));
          return;
        }
        if (typeof key !== "string" || !key.trim()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "key is required" }));
          return;
        }
        try {
          // No in-process equivalent is documented for reset — always CLI.
          await execOmpCli(["config", "reset", key], OMP_CLI_TIMEOUT_MS);
          const settings = getSettingsInstance();
          try {
            await settings?.reloadFromDisk?.();
          } catch {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, key }));
        } catch (e: unknown) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: errMessage(e) }));
        }
      });
      return;
    }

    // Agent config read/write — <agentRoot>/config.yml, the omp global
    // settings layer (YAML, persisted debounced + lock-safe by the omp
    // runtime itself).
    if (urlPath === "/api/agent-config" && req.method === "GET") {
      try {
        const configPath = path.join(OMP_AGENT_ROOT, "config.yml");
        // Empty string is a valid (null) YAML document — safer default than
        // guessing at skeleton keys the runtime doesn't expect.
        const content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, content, path: configPath }));
      } catch (e: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: errMessage(e) }));
      }
      return;
    }

    if (urlPath === "/api/agent-config" && req.method === "PUT") {
      readCappedBody(req, res, async (body) => {
        try {
          const { content } = JSON.parse(body);
          if (typeof content !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "content must be a string" }));
            return;
          }
          const configPath = path.join(OMP_AGENT_ROOT, "config.yml");
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, content, "utf8");
          // Validate via omp's own YAML loader: reloading the in-process
          // Settings from disk throws on invalid YAML, which we surface as
          // a 400 so the user can fix the editor content. When the
          // in-process surface isn't reachable, accept the write as-is —
          // omp tolerates (and re-reports) a broken file at next start.
          let validated = false;
          try {
            const settings = getSettingsInstance();
            if (settings && typeof settings.reloadFromDisk === "function") {
              await settings.reloadFromDisk();
              validated = true;
            }
          } catch (e: unknown) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                success: false,
                error: `Invalid config.yml (saved, but omp could not parse it): ${errMessage(e)}`,
              }),
            );
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, validated }));
        } catch (e: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: errMessage(e) }));
        }
      });
      return;
    }

    // LLM providers / models.yml read/write
    //
    // Exposes <agentRoot>/models.yml — the file omp uses to declare custom
    // providers and models (Ollama, vLLM, LM Studio, OpenAI-compat proxies,
    // OpenRouter routing overrides, etc). See docs/models.md in the embedded
    // omp runtime for the schema. The frontend Settings → Configuration →
    // "LLM providers" panel reads and writes through these endpoints so users
    // never have to leave Ompcot to edit the file by hand.
    //
    // After a successful save we call modelRegistry.refresh() so the new
    // providers/models show up in the model picker immediately — matching the
    // omp behaviour where /model rereads models.yml on each invocation.
    if (urlPath === "/api/models-config" && req.method === "GET") {
      try {
        const configPath = path.join(OMP_AGENT_ROOT, "models.yml");
        const content = fs.existsSync(configPath)
          ? fs.readFileSync(configPath, "utf8")
          : "providers: {}\n";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true, content, path: configPath }));
      } catch (e: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: errMessage(e) }));
      }
      return;
    }

    if (urlPath === "/api/models-config" && req.method === "PUT") {
      readCappedBody(req, res, async (body) => {
        try {
          const { content } = JSON.parse(body);
          if (typeof content !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: "content must be a string" }));
            return;
          }
          // models.yml is YAML and we don't parse YAML here (no new deps),
          // so content validation is left to the omp runtime on reload.
          // omp itself does the real validation and reports parse errors at
          // startup / on next model-list refresh.
          const configPath = path.join(OMP_AGENT_ROOT, "models.yml");
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, content, "utf8");
          // Reload omp's in-memory model registry so the picker sees the new
          // providers/models without restarting the workspace.
          // IMPORTANT: await refresh() so the registry is fully updated
          // before we respond — the frontend calls get_available_models
          // immediately after receiving our response, and without await it
          // would race against the async reload and return stale models.
          let refreshed = false;
          try {
            const registry = globalState.modelRegistry;
            if (registry && typeof (registry as { refresh?: unknown }).refresh === "function") {
              await (registry as { refresh: () => unknown }).refresh();
              refreshed = true;
            }
          } catch {
            // Non-fatal: file is saved, user can /reload or restart.
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, refreshed }));
        } catch (e: unknown) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: errMessage(e) }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // Wraps `parseSessionFile` with an mtime+size keyed in-memory cache so we
  // only re-parse files that have actually changed since the last call.
  // A `null` parse result (file rejected by the trivial-session filter) is
  // also cached so we don't keep retrying. Also returns the stat so callers
  // can avoid a second `fs.statSync`.
  async function parseSessionFileCached(
    filePath: string,
    readline: typeof import("node:readline"),
  ) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      globalState.sessionHeaderCache.delete(filePath);
      return null;
    }

    const cached = globalState.sessionHeaderCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { parsed: cached.value, stat };
    }

    const parsed = await parseSessionFile(filePath, readline);
    globalState.sessionHeaderCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      value: parsed,
    });
    return { parsed, stat };
  }

  // Drop cache entries for files that no longer exist under SESSIONS_DIR.
  // Cheap (single iteration over the Map keys) and bounds memory growth in
  // long-lived omp processes where users archive / delete sessions.
  function pruneSessionCaches(liveFiles: Set<string>) {
    for (const key of globalState.sessionHeaderCache.keys()) {
      if (!liveFiles.has(key)) globalState.sessionHeaderCache.delete(key);
    }
    for (const key of globalState.sessionMetricsCache.keys()) {
      if (!liveFiles.has(key)) globalState.sessionMetricsCache.delete(key);
    }
  }

  // Bounded async map to avoid EMFILE when users have many session files.
  async function mapWithConcurrencyLimit<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) return [];
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const current = nextIndex++;
          if (current >= items.length) return;
          results[current] = await mapper(items[current]);
        }
      }),
    );

    return results;
  }

  async function serveSessionsList(res: http.ServerResponse) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ projects: [] }));
        return;
      }

      const readline = await import("node:readline");
      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
      const liveFiles = new Set<string>();

      // Walk the tree first to build the (dir, files) work list and the
      // live-file set used for cache pruning. Parsing then happens in
      // parallel per project — most cost is fs.read on cold cache, and
      // bun + node handle a few hundred concurrent stream reads cheaply.
      const projectWork: {
        dirName: string;
        projectDir: string;
        files: string[];
        decodedPath: string;
      }[] = [];
      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        const projectDir = path.join(SESSIONS_DIR, dir.name);
        let files: string[] = [];
        try {
          files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
        } catch {
          // Ignore inaccessible/removed project directories while listing.
          continue;
        }
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
        for (const f of files) liveFiles.add(path.join(projectDir, f));
        projectWork.push({ dirName: dir.name, projectDir, files, decodedPath });
      }

      pruneSessionCaches(liveFiles);

      const projects = (
        await mapWithConcurrencyLimit(
          projectWork,
          8,
          async ({ dirName, projectDir, files, decodedPath }) => {
            // biome-ignore lint/suspicious/noExplicitAny: dynamic session-list entries built by spreading parsed JSONL headers
            const sessions: any[] = [];
            const results = await mapWithConcurrencyLimit(files, 24, async (file) => {
              const filePath = path.join(projectDir, file);
              try {
                const result = await parseSessionFileCached(filePath, readline);
                if (!result?.parsed) return null;
                return {
                  ...result.parsed,
                  file,
                  filePath,
                  mtime: result.stat.mtimeMs,
                  ctime: result.stat.birthtimeMs,
                };
              } catch {
                return null;
              }
            });
            for (const r of results) {
              if (r) sessions.push(r);
            }

            sessions.sort((a, b) => {
              const aCreated = a.timestamp ? new Date(a.timestamp).getTime() : a.ctime || 0;
              const bCreated = b.timestamp ? new Date(b.timestamp).getTime() : b.ctime || 0;
              return bCreated - aCreated;
            });

            if (sessions.length === 0) return null;

            // Directory-name decoding is lossy for paths containing "-" (e.g. "oh-my-pi").
            // Prefer the real cwd recorded in session headers when available.
            const cwdCounts = new Map<string, number>();
            for (const s of sessions) {
              if (!s.cwd) continue;
              cwdCounts.set(s.cwd, (cwdCounts.get(s.cwd) || 0) + 1);
            }
            const inferredPath =
              Array.from(cwdCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || decodedPath;

            return { path: inferredPath, dirName, sessions };
          },
        )
      ).filter(
        // biome-ignore lint/suspicious/noExplicitAny: dynamic session-list entries
        (p): p is { path: string; dirName: string; sessions: any[] } => p !== null,
      );

      projects.sort((a, b) => {
        const aSession = a.sessions[0];
        const bSession = b.sessions[0];
        const aTime = aSession?.timestamp
          ? new Date(aSession.timestamp).getTime()
          : aSession?.ctime || 0;
        const bTime = bSession?.timestamp
          ? new Date(bSession.timestamp).getTime()
          : bSession?.ctime || 0;
        return bTime - aTime;
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects }));
    } catch (e: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(e) }));
    }
  }

  function parseDateOnly(value: string): Date | null {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return d;
  }

  function parseRangeParams(req: http.IncomingMessage) {
    const reqUrl = req.url || "";
    const parsed = new URL(reqUrl, "http://localhost");
    const range = (parsed.searchParams.get("range") || "30d").toLowerCase();
    const granularity = (parsed.searchParams.get("granularity") || "day").toLowerCase();
    const scope = (parsed.searchParams.get("scope") || "all").toLowerCase();
    const modelsParam = parsed.searchParams.get("models") || "";
    const models = new Set(
      modelsParam
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    );

    const now = new Date();
    let from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    let to = now;

    if (range === "7d") from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    else if (range === "90d") from = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    else if (range === "custom") {
      const fromParam = parsed.searchParams.get("from");
      const toParam = parsed.searchParams.get("to");
      const parsedFrom = fromParam ? parseDateOnly(fromParam) : null;
      const parsedTo = toParam ? parseDateOnly(toParam) : null;
      if (parsedFrom) from = parsedFrom;
      if (parsedTo) to = parsedTo;
    }

    if (to < from) {
      const tmp = from;
      from = to;
      to = tmp;
    }

    return {
      from,
      to,
      range,
      granularity: granularity === "week" || granularity === "month" ? granularity : "day",
      scope: scope === "all" ? "all" : "current",
      models,
    };
  }

  async function parseSessionMetrics(
    filePath: string,
    readline: typeof import("node:readline"),
  ): Promise<SessionMetrics | null> {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const data: SessionMetrics = {
      id: "",
      title: "",
      cwd: "",
      timestamp: null,
      lastActive: null,
      model: "unknown",
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolCostByName: {} as Record<string, number>,
    };

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (!data.lastActive && entry.timestamp) {
          const ts = parseDateOnly(entry.timestamp);
          if (ts) data.lastActive = ts;
        } else if (entry.timestamp) {
          const ts = parseDateOnly(entry.timestamp);
          if (ts) data.lastActive = ts;
        }

        if (entry.type === "session") {
          data.id = entry.id || data.id;
          data.cwd = entry.cwd || data.cwd;
          if (entry.timestamp) {
            const ts = parseDateOnly(entry.timestamp);
            if (ts) data.timestamp = ts;
          }
          continue;
        }

        if (entry.type === "session_info" && entry.name) {
          data.title = entry.name;
          continue;
        }

        if (entry.type === "model_change" && entry.model) {
          data.model = entry.model;
          continue;
        }

        if (entry.type !== "message" || !entry.message) continue;
        const msg = entry.message;
        if (msg.role === "user") {
          data.userMessages += 1;
          continue;
        }

        if (msg.role !== "assistant") continue;
        data.assistantMessages += 1;

        if (typeof msg.model === "string" && msg.model) {
          data.model = msg.model;
        }

        const usage = msg.usage || {};
        const cost = Number(usage?.cost?.total || 0);
        data.totalCost += cost;
        data.inputTokens += Number(usage?.input || 0);
        data.outputTokens += Number(usage?.output || 0);
        data.cacheRead += Number(usage?.cacheRead || 0);
        data.cacheWrite += Number(usage?.cacheWrite || 0);

        const toolCalls = Array.isArray(msg.content)
          ? msg.content.filter(
              (b: { type?: string; name?: unknown }) =>
                b?.type === "toolCall" && typeof b?.name === "string",
            )
          : [];
        data.toolCalls += toolCalls.length;
        if (toolCalls.length > 0 && cost > 0) {
          const perToolCost = cost / toolCalls.length;
          for (const toolCall of toolCalls) {
            data.toolCostByName[toolCall.name] =
              (data.toolCostByName[toolCall.name] || 0) + perToolCost;
          }
        }
      } catch {
        // ignore malformed lines
      }
    }

    rl.close();
    stream.destroy();

    if (!data.id) return null;
    if (!data.lastActive) {
      const stat = fs.statSync(filePath);
      data.lastActive = new Date(stat.mtimeMs);
    }
    if (!data.timestamp) data.timestamp = data.lastActive;
    return data;
  }

  async function serveCostDashboard(req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(buildEmptyCostDashboardPayload()));
        return;
      }

      const readline = await import("node:readline");
      const params = parseRangeParams(req);
      const currentWorkspace = (() => {
        try {
          return fs.realpathSync(process.cwd());
        } catch {
          return path.resolve(process.cwd());
        }
      })();

      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
      const sessions: CostSession[] = [];

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
        for (const file of files) {
          const filePath = path.join(projectDir, file);
          // Cache-aware fetch: cost dashboard scans every session file in the
          // tree, which is dramatically more expensive than `/api/sessions`
          // because it parses every JSONL line (not just the header). The
          // mtime+size key means re-opening the dashboard reuses prior work
          // for any session that hasn't been written to since.
          let stat: fs.Stats;
          try {
            stat = fs.statSync(filePath);
          } catch {
            globalState.sessionMetricsCache.delete(filePath);
            continue;
          }
          let parsed: SessionMetrics | null;
          const cached = globalState.sessionMetricsCache.get(filePath);
          if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            parsed = cached.value as SessionMetrics;
          } else {
            parsed = await parseSessionMetrics(filePath, readline);
            globalState.sessionMetricsCache.set(filePath, {
              mtimeMs: stat.mtimeMs,
              size: stat.size,
              value: parsed,
            });
          }
          if (!parsed) continue;

          const sessionCwdResolved = (() => {
            try {
              return parsed.cwd ? fs.realpathSync(parsed.cwd) : "";
            } catch {
              return parsed.cwd ? path.resolve(parsed.cwd) : "";
            }
          })();
          if (
            params.scope === "current" &&
            sessionCwdResolved &&
            sessionCwdResolved !== currentWorkspace
          )
            continue;
          if (params.models.size > 0 && !params.models.has(parsed.model)) continue;

          const time = parsed.lastActive || parsed.timestamp;
          if (!time || time < params.from || time > params.to) continue;

          sessions.push({
            id: parsed.id,
            title: parsed.title || "Untitled",
            workspace: parsed.cwd || "",
            model: parsed.model || "unknown",
            time: time.toISOString(),
            totalCost: parsed.totalCost,
            inputTokens: parsed.inputTokens,
            outputTokens: parsed.outputTokens,
            cacheRead: parsed.cacheRead,
            cacheWrite: parsed.cacheWrite,
            totalTokens: parsed.inputTokens + parsed.outputTokens + parsed.cacheRead,
            toolCalls: parsed.toolCalls,
            userMessages: parsed.userMessages,
            assistantMessages: parsed.assistantMessages,
            costPerUserMessage:
              parsed.userMessages > 0 ? parsed.totalCost / parsed.userMessages : parsed.totalCost,
            toolCostByName: parsed.toolCostByName || {},
          });
        }
      }

      const payload = buildCostDashboardPayload(sessions, params, new Date());

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (e: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(e) || "Failed to build cost dashboard" }));
    }
  }

  // ═══════════════════════════════════════
  // Session file endpoint
  // ═══════════════════════════════════════
  function serveSessionFile(res: http.ServerResponse, dirName: string, file: string) {
    // Audit A3: containment. Reject any component that isn't a plain file
    // name (no separators, no "." / ".."), verify the resolved path stays
    // strictly beneath the sessions root, and re-verify after realpath so a
    // symlink inside the sessions tree pointing outside is rejected too.
    const sessionsRoot = path.resolve(SESSIONS_DIR);
    const isSafeSegment = (s: string) =>
      !!s && s !== "." && s !== ".." && !s.includes("/") && !s.includes("\\");
    const notFound = () => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
    };
    if (!isSafeSegment(dirName) || !isSafeSegment(file)) {
      notFound();
      return;
    }
    const filePath = path.resolve(sessionsRoot, dirName, file);
    if (filePath === sessionsRoot || !filePath.startsWith(sessionsRoot + path.sep)) {
      notFound();
      return;
    }
    let realSessionsRoot = "";
    let realFilePath = "";
    try {
      realSessionsRoot = fs.realpathSync(sessionsRoot);
      realFilePath = fs.realpathSync(filePath);
    } catch {
      notFound();
      return;
    }
    if (
      realFilePath === realSessionsRoot ||
      !realFilePath.startsWith(realSessionsRoot + path.sep)
    ) {
      notFound();
      return;
    }

    if (!fs.existsSync(realFilePath)) {
      notFound();
      return;
    }

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous parsed JSONL entries
    const entries: any[] = [];
    const stream = fs.createReadStream(realFilePath, { encoding: "utf8" });
    let buffer = "";

    stream.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) {
          try {
            entries.push(JSON.parse(line));
          } catch {
            /* skip */
          }
        }
      }
    });

    stream.on("end", () => {
      if (buffer.trim()) {
        try {
          entries.push(JSON.parse(buffer));
        } catch {
          /* skip */
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ entries }));
    });

    stream.on("error", (e: Error) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(e) }));
    });
  }

  // ═══════════════════════════════════════
  // Parse session file header
  // ═══════════════════════════════════════
  async function parseSessionFile(filePath: string, readline: typeof import("node:readline")) {
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let header: { id?: string; timestamp?: string; cwd?: string } | null = null;
    let firstMessage: string | null = null;
    let sessionName: string | null = null;
    let userMessageCount = 0;
    let lineCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;
      lineCount++;

      try {
        const entry = JSON.parse(line);
        if (entry.type === "session") header = entry;
        else if (entry.type === "session_info" && entry.name) sessionName = entry.name;
        else if (entry.type === "message" && entry.message?.role === "user") {
          userMessageCount++;
          if (!firstMessage) {
            const content = entry.message.content;
            if (typeof content === "string") firstMessage = content.substring(0, 120);
            else if (Array.isArray(content)) {
              const tb = content.find((b: { type?: string }) => b.type === "text");
              if (tb) firstMessage = tb.text.substring(0, 120);
            }
          }
        }
      } catch {
        /* skip */
      }

      if (lineCount > 50 && firstMessage) break;
    }

    rl.close();
    stream.destroy();

    if (!header?.id) return null;
    // Heuristic to suppress one-shot "pipe mode" invocations (no user input, no assistant turn).
    // Real interactive sessions write at least the session header + a model/thinking change pair,
    // and a brand-new chat with a single short user message can be as compact as ~7 lines, so we
    // only filter out trivially-short files that have NO user messages at all.
    if (userMessageCount === 0 && lineCount <= 4) return null;

    return {
      id: header.id,
      timestamp: header.timestamp || "",
      name: sessionName,
      firstMessage,
      cwd: header.cwd || null,
    };
  }

  // ═══════════════════════════════════════
  // File browser
  // ═══════════════════════════════════════

  const IGNORED_NAMES = new Set([
    "node_modules",
    ".git",
    "__pycache__",
    ".DS_Store",
    ".Trash",
    ".next",
    ".nuxt",
    "dist",
    "build",
    ".cache",
    ".turbo",
    "venv",
    ".venv",
    "env",
    ".env.local",
    ".pi",
    "coverage",
    ".nyc_output",
    ".parcel-cache",
  ]);

  function serveFileList(res: http.ServerResponse, dirPath: string) {
    try {
      if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not a directory" }));
        return;
      }

      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      // biome-ignore lint/suspicious/noExplicitAny: dynamic file-browser entries (name/isDirectory/etc.)
      const items: any[] = [];

      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".env") continue;
        if (IGNORED_NAMES.has(entry.name)) continue;

        try {
          const fullPath = path.join(dirPath, entry.name);
          const stat = fs.statSync(fullPath);

          items.push({
            name: entry.name,
            path: fullPath,
            isDirectory: entry.isDirectory(),
            size: entry.isDirectory() ? null : stat.size,
            mtime: stat.mtimeMs,
          });
        } catch {
          /* skip inaccessible */
        }
      }

      // Directories first, then files, both alphabetical
      items.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: dirPath, items }));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(err) }));
    }
  }

  // ═══════════════════════════════════════
  // Full-text search
  // ═══════════════════════════════════════

  async function serveSearch(res: http.ServerResponse, query: string) {
    try {
      if (!query || query.length < 2) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const q = query.toLowerCase();
      const readline = await import("node:readline");
      // biome-ignore lint/suspicious/noExplicitAny: dynamic search result rows
      const results: any[] = [];
      const MAX_RESULTS = 30;

      if (!fs.existsSync(SESSIONS_DIR)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
        return;
      }

      const dirEntries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });

      for (const dir of dirEntries) {
        if (!dir.isDirectory()) continue;
        if (results.length >= MAX_RESULTS) break;

        const projectDir = path.join(SESSIONS_DIR, dir.name);
        const decodedPath = dir.name.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
        const files = fs.readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));

        for (const file of files) {
          if (results.length >= MAX_RESULTS) break;

          try {
            const filePath = path.join(projectDir, file);
            const stream = fs.createReadStream(filePath, { encoding: "utf8" });
            const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

            let sessionId = "";
            let sessionName = "";
            let sessionTimestamp = "";
            let firstMessage = "";
            let sessionWorkspace = decodedPath;
            // biome-ignore lint/suspicious/noExplicitAny: dynamic search match rows
            const matches: any[] = [];

            for await (const line of rl) {
              if (!line.trim()) continue;
              try {
                const entry = JSON.parse(line);

                if (entry.type === "session") {
                  sessionId = entry.id;
                  sessionTimestamp = entry.timestamp || "";
                  if (typeof entry.cwd === "string" && entry.cwd.trim()) {
                    sessionWorkspace = entry.cwd;
                  }
                }
                if (entry.type === "session_info" && entry.name) {
                  sessionName = entry.name;
                }
                if (entry.type === "message") {
                  const content = entry.message?.content;
                  let text = "";
                  if (typeof content === "string") text = content;
                  else if (Array.isArray(content)) {
                    text = content
                      .filter((b: { type?: string }) => b.type === "text")
                      .map((b: { text?: string }) => b.text)
                      .join(" ");
                  }

                  if (!firstMessage && entry.message?.role === "user" && text) {
                    firstMessage = text.substring(0, 120);
                  }

                  if (text?.toLowerCase().includes(q)) {
                    // Extract a snippet around the match
                    const idx = text.toLowerCase().indexOf(q);
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(text.length, idx + q.length + 60);
                    const snippet =
                      (start > 0 ? "…" : "") +
                      text.substring(start, end) +
                      (end < text.length ? "…" : "");

                    matches.push({
                      role: entry.message?.role || "unknown",
                      snippet: snippet.replace(/\n/g, " "),
                    });

                    if (matches.length >= 3) break; // max 3 matches per session
                  }
                }
              } catch {
                /* skip line */
              }
            }

            rl.close();
            stream.destroy();

            const projectMatch = buildProjectSearchMatch(q, sessionWorkspace);
            if (projectMatch && !matches.some((match) => match.role === "project")) {
              matches.unshift(projectMatch);
            }

            if (matches.length > 0) {
              results.push({
                filePath,
                project: sessionWorkspace,
                sessionId,
                sessionName,
                sessionTimestamp,
                firstMessage,
                matches,
              });
            }
          } catch {
            /* skip file */
          }
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results }));
    } catch (err: unknown) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errMessage(err) }));
    }
  }

  // ═══════════════════════════════════════
  // Start server function (reusable across extension reloads)
  // ═══════════════════════════════════════
  //
  // The HTTP/WS server is process-scoped (see `globalState`). On the first
  // session_start of the omp process we actually create and bind the server.
  // On every subsequent session_start (after new_session / switch_session /
  // fork → extension reload), we just re-publish the current session's
  // command handler / state-snapshot builder / latest ctx into the global so
  // the long-lived `wss.on("connection", …)` callback below dispatches to
  // the new session. This is what keeps the WebView's URL alive across
  // session changes.
  function startServer(ctx: ExtensionContext) {
    // Always (re)publish per-session bindings — these are what every
    // request and WS message dispatches through.
    globalState.handleCommand = handleCommand;
    globalState.buildStateSnapshot = buildStateSnapshot;
    globalState.getLatestCtx = () => latestCtx;
    globalState.getAomp = () => omp;

    // Subscribe ONCE per process to omp's effective-settings change feed so
    // connected WebViews live-update when a setting changes — whether the
    // change came from Ompcot, another omp process, or this one. Best-effort:
    // when the in-process surface isn't reachable we clear the flag so a
    // later extension reload (after new_session / switch_session / fork) can
    // retry. Credential-like values are masked before broadcast.
    if (!globalState.settingsChangeSubscribed) {
      globalState.settingsChangeSubscribed = true;
      try {
        const instance = getSettingsInstance();
        const unsubscribe = instance?.onEffectiveChange?.((path: string, value: unknown) => {
          broadcast({
            type: "settings_changed",
            path,
            value: isCredentialLikeKey(path) ? null : value,
          });
        });
        if (typeof unsubscribe !== "function") {
          globalState.settingsChangeSubscribed = false;
        }
      } catch {
        globalState.settingsChangeSubscribed = false;
      }
    }

    // One-shot namespace dump for debugging runtime-surface access (which
    // exports the embedded omp actually exposes on `omp.pi`). Opt-in only.
    if (process.env.OMCOT_DEBUG_NAMESPACE === "1" && !globalState.namespaceDebugLogged) {
      globalState.namespaceDebugLogged = true;
      const pi = currentPi() as unknown as Record<string, unknown> | null;
      const keys = pi ? Object.keys(pi).sort() : [];
      console.error(`[Embedded] omp namespace keys (${keys.length}): ${keys.join(", ")}`);
    }

    // Subscribe ONCE per process to the AgentRegistry change feed and push
    // throttled `agents_changed` events so connected WebViews live-refresh
    // the roster. Trailing-throttled: at most one event per 500ms; bursts
    // coalesce into a single trailing emit. Best-effort — when the registry
    // is unreachable there is simply no subscription (list_agents reports
    // available:false too).
    if (!globalState.agentsChangeSubscribed) {
      const registry = resolveAgentRegistry();
      if (registry && typeof registry.onChange === "function") {
        try {
          let pendingEmit: NodeJS.Timeout | null = null;
          const unsubscribe = registry.onChange(() => {
            if (pendingEmit) return;
            pendingEmit = setTimeout(() => {
              pendingEmit = null;
              broadcast({ type: "event", event: { type: "agents_changed" } });
            }, AGENTS_CHANGED_THROTTLE_MS);
          });
          if (typeof unsubscribe === "function") {
            globalState.agentsChangeSubscribed = true;
          }
        } catch (err: unknown) {
          console.error("[Embedded] AgentRegistry.onChange subscription failed:", errMessage(err));
        }
      } else {
        console.error(
          "[Embedded] agents_changed: registry unreachable or has no onChange — no subscription",
        );
      }
    }

    // Re-register the instance entry with the *current* session file so
    // `/api/instances` reports the right session.
    if (globalState.server) {
      const port = globalState.server.port;
      const sessionFile = ctx.sessionManager.getSessionFile() || "";
      registerInstance(port, sessionFile, ctx.cwd || process.cwd());
      return;
    }

    // ─── Common: per-client lifecycle ────────────────────────────────────
    //
    // Both the Bun.serve and node http+ws paths funnel new connections
    // through `onClientConnected` so the rest of the system (handleCommand,
    // broadcast, heartbeat) doesn't care which runtime is underneath.
    function onClientConnected(ws: UnifiedWS) {
      console.log("[Embedded] Browser client connected");
      globalState.clients.add(ws);
      ws.isAlive = true;

      sendTo(ws, { type: "state", isStreaming: false, mode: "embedded" });

      const currentCtx = globalState.getLatestCtx?.() ?? null;
      const snapshotBuilder = globalState.buildStateSnapshot;
      if (currentCtx && snapshotBuilder) {
        snapshotBuilder(currentCtx)
          .then((snapshot) => {
            sendTo(ws, snapshot);
          })
          .catch((err) => {
            console.error("[Embedded] Failed to build initial snapshot:", err);
          });
      }

      // F3 (P1): re-serve any dialogs still pending for this session. A
      // page reload drops the client's knowledge of every in-flight dialog;
      // without this replay those requests could only ever time out. The
      // frontend dedupes by request id, so this is a no-op for state the
      // client already has.
      replayPendingUiRequests(ws);
    }

    function onClientMessage(ws: UnifiedWS, raw: string | ArrayBuffer | Buffer) {
      try {
        const text =
          typeof raw === "string"
            ? raw
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString("utf8")
              : raw.toString();
        const incoming = JSON.parse(text);
        const command =
          incoming?.type === "broker_command"
            ? {
                ...(incoming.payload || {}),
                id: incoming.payload?.id ?? incoming.requestId,
                // F9: keep the transport-level requestId of the broker
                // envelope. For commands whose payload carries its own `id`
                // (ui_response / ui_cancel echo the DIALOG id there), the
                // acknowledgment must correlate with what the client's
                // transport layer (ws-rpc) tracks — the envelope
                // requestId — not the dialog id.
                transportRequestId:
                  typeof incoming.requestId === "string" ? incoming.requestId : undefined,
              }
            : incoming;
        const dispatch = globalState.handleCommand;
        if (dispatch) {
          dispatch(ws, command);
        } else {
          sendTo(ws, {
            type: "response",
            command: command?.type || "unknown",
            success: false,
            error: "No active session",
            id: command?.id,
          });
        }
      } catch (e) {
        console.error("[Embedded] Failed to parse client message:", e);
      }
    }

    function onClientClosed(ws: UnifiedWS) {
      console.log("[Embedded] Browser client disconnected");
      globalState.clients.delete(ws);
    }

    // ─── Heartbeat (process-scoped, identical across runtimes) ───────────
    //
    // Removes stale clients (the WebView usually closes cleanly, but
    // ungraceful disconnects need a reaper). The Bun ServerWebSocket has
    // `.ping()` but not `.terminate()` — we fall back to `.close()` in the
    // wrapper exposed via UnifiedWS.
    //
    // Audit A7: start the reaper only once the server is actually listening
    // (see onListening) and guard against double-start across extension
    // reloads — a process-global interval that outlives a failed listen is a
    // leak and reaps against a client set that can never fill.
    function ensureHeartbeat() {
      if (globalState.heartbeatTimer) return;
      globalState.heartbeatTimer = setInterval(() => {
        for (const client of globalState.clients) {
          if (client.readyState !== WS_OPEN) {
            globalState.clients.delete(client);
            continue;
          }
          if (!client.isAlive) {
            try {
              client.terminate();
            } catch {}
            globalState.clients.delete(client);
            continue;
          }
          client.isAlive = false;
          try {
            client.ping();
          } catch {}
        }
      }, 20000);
    }

    // ─── Path A: Bun runtime ─────────────────────────────────────────────
    //
    // The bundled `omp` is compiled with `bun build --compile`, where the
    // node-style `http.createServer().on("upgrade", ...)` path silently
    // drops `socket.write` and the handshake never completes. `Bun.serve`
    // has a native upgrade path that works.
    if (HAS_BUN_SERVE) {
      const tryBunListen = (port: number, maxAttempts = 10) => {
        try {
          const bunServer = Bun.serve({
            port,
            hostname: BIND_HOST,
            // Sustained streaming responses (e.g. SSE / long polls hitting
            // our REST surface) should not be killed by Bun's default 10s
            // idle timeout. 0 = disable.
            idleTimeout: 0,
            fetch: bunFetchHandler,
            websocket: {
              open(ws: unknown) {
                onClientConnected(ws as UnifiedWS);
              },
              message(ws: unknown, msg: string | Buffer) {
                onClientMessage(ws as UnifiedWS, msg);
              },
              close(ws: unknown) {
                onClientClosed(ws as UnifiedWS);
              },
              drain() {
                /* no-op; backpressure is fine for our small JSON messages */
              },
              // Bun marks the client as alive on any pong it receives; we
              // expose a hook to flip the heartbeat sentinel.
              pong(ws: unknown) {
                (ws as UnifiedWS).isAlive = true;
              },
            },
          });
          onListening(port);
          globalState.server = {
            port,
            close: () => {
              try {
                (bunServer as { stop?: (force?: boolean) => void }).stop?.(true);
              } catch {}
            },
            nodeServer: null,
            bunServer,
          };
        } catch (err: unknown) {
          const msg = errMessage(err);
          // Bun surfaces EADDRINUSE as both `err.code === "EADDRINUSE"`
          // and as a message containing the literal string, depending on
          // version. Check both.
          const errCode = (err as { code?: string } | null)?.code;
          if (
            (errCode === "EADDRINUSE" || msg.includes("EADDRINUSE")) &&
            port < PORT + maxAttempts
          ) {
            console.log(`[Embedded] Port ${port} in use, trying ${port + 1}...`);
            tryBunListen(port + 1, maxAttempts);
          } else {
            console.error(`[Embedded] Failed to start Bun server:`, msg);
          }
        }
      };

      // Adapt our existing node-style `serveStaticFile(req, res)` API to
      // Bun's `fetch(Request) => Response` shape. The WS upgrade has to
      // short-circuit *before* the adapter runs, because once `req.body`
      // is consumed by the adapter the upgrade window is gone.
      //
      // Static asset requests bypass the adapter entirely: Bun's native
      // `Bun.file(path)` already supports byte ranges, content-type
      // inference, and zero-copy streaming, and the adapter's buffered
      // body approach would defeat all of that for the 200+ KB JS bundle.
      async function bunFetchHandler(req: Request, server: unknown): Promise<Response | undefined> {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          if ((server as { upgrade: (req: Request) => boolean }).upgrade(req)) return undefined;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        if (!url.pathname.startsWith("/api/")) {
          return serveStaticAssetBun(url, req);
        }
        return runNodeStyleHandler(req);
      }

      // Native Bun static serving — mirrors the routing in `serveStaticFile`
      // (pretty `/` and `/cost` paths, directory traversal guard, 404 on
      // missing files) but reads via `Bun.file` so large assets stream
      // straight from disk without going through our buffering adapter.
      async function serveStaticAssetBun(url: URL, req: Request): Promise<Response> {
        let urlPath = url.pathname;

        // Auto-redirect remote browsers to the full mobile URL.
        const brokerPort = Number.parseInt(process.env.OMCOT_BROKER_PORT || "", 10);
        const host = req.headers.get("host") || url.host;
        const hostName = parseHostHeaderName(host);
        const isLoopback = isLoopbackHost(hostName);
        if (
          urlPath === "/" &&
          !isLoopback &&
          !url.searchParams.has("mobile") &&
          Number.isFinite(brokerPort) &&
          brokerPort > 0
        ) {
          const redirect = new URL(`http://${host}/`);
          redirect.searchParams.set("mobile", "1");
          redirect.searchParams.set("brokerWs", `ws://${hostName}:${brokerPort}/ui-ws`);
          return Response.redirect(redirect.toString(), 302);
        }

        if (urlPath === "/") urlPath = "/index.html";
        if (urlPath === "/cost" || urlPath === "/cost/") urlPath = "/cost.html";

        const filePath = path.join(STATIC_DIR, urlPath);
        // Guard against directory-traversal. We do this with the resolved
        // filesystem path rather than the URL path so symlink shenanigans
        // can't escape STATIC_DIR either.
        if (!filePath.startsWith(STATIC_DIR)) {
          return new Response("Forbidden", { status: 403 });
        }

        try {
          const file = Bun.file(filePath);
          if (!(await file.exists())) {
            return new Response("Not Found", { status: 404 });
          }
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || file.type || "application/octet-stream";
          return new Response(file as unknown as BodyInit, {
            headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
          });
        } catch (err: unknown) {
          return new Response(`Internal error: ${errMessage(err)}`, { status: 500 });
        }
      }

      tryBunListen(PORT);
      return;
    }

    // ─── Path B: Node runtime fallback (dev/jiti) ────────────────────────
    //
    // Real Node.js doesn't have the bun upgrade bug, so the original
    // ws-on-http.createServer path is fine here. We keep it so
    // `tauri dev` (which loads the .ts source via jiti and node) still
    // works.
    const server = http.createServer((req, res) => serveStaticFile(req, res));
    const wss = new WebSocketServer({ noServer: true });
    globalState.wss = wss;

    server.on("upgrade", (request, socket, head) => {
      if (request.url === "/ws") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    wss.on("connection", (ws: WebSocket) => {
      // The `ws` library's WebSocket is structurally compatible with
      // UnifiedWS once we add the `isAlive` flag, except it uses
      // EventEmitter rather than fields for delivery. Wire those events
      // into the shared lifecycle hooks.
      const wrapped = ws as unknown as UnifiedWS;
      onClientConnected(wrapped);

      ws.on("pong", () => {
        wrapped.isAlive = true;
      });
      ws.on("message", (data) => {
        onClientMessage(wrapped, data as Buffer);
      });
      ws.on("close", () => {
        onClientClosed(wrapped);
      });
      ws.on("error", (e) => {
        console.error("[Embedded] Client error:", e);
        globalState.clients.delete(wrapped);
      });
    });

    const tryListen = (port: number, maxAttempts = 10) => {
      // Ompcot's mobile dev mode is always reachable from the local network.
      server.listen(port, BIND_HOST, () => {
        onListening(port);
        globalState.server = {
          port,
          close: () => {
            try {
              server.close();
            } catch {}
          },
          nodeServer: server,
          bunServer: null,
        };
      });
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < PORT + maxAttempts) {
          console.log(`[Embedded] Port ${port} in use, trying ${port + 1}...`);
          server.removeAllListeners("error");
          tryListen(port + 1, maxAttempts);
        } else {
          console.error("[Embedded] Failed to start server:", errMessage(err));
        }
      });
    };

    function onListening(port: number) {
      ensureHeartbeat(); // audit A7: only after the listen actually succeeded
      const localHost = isLoopbackHost(BIND_HOST) ? BIND_HOST : "127.0.0.1";
      globalState.localUrl = `http://${localHost}:${port}`;
      const lanUrls = buildLanUrls(port);
      globalState.lanUrl = lanUrls[0] || "";
      console.log(`[Embedded] Ompcot embedded server running on ${globalState.localUrl}`);
      const statusTarget = !isLoopbackHost(BIND_HOST)
        ? `${BIND_HOST}:${port}${globalState.lanUrl ? ` (${globalState.lanUrl})` : ""}`
        : `${BIND_HOST}:${port}`;
      ctx.ui.setStatus("embedded", `Embedded: ${statusTarget}`);
      const sessionFile = ctx.sessionManager.getSessionFile() || "";
      registerInstance(port, sessionFile, ctx.cwd || process.cwd());
    }

    tryListen(PORT);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Request adapter: convert a `Request` (web-fetch) into the node-style
  // `(req, res)` pair our existing handlers expect, then run `serveStaticFile`
  // and resolve to the final `Response`.
  //
  // Why we keep the node-style API:
  //   - `handleApiRoute` and friends are 1000+ lines of hand-rolled
  //     `res.writeHead(...)` / `res.end(...)` / `req.on("data", ...)`
  //     code. Rewriting all of it to return Response objects would be a
  //     much larger change and a much bigger risk of regression than
  //     the small adapter below.
  //
  // Things to know about this adapter:
  //   - We collect the body up-front (`await req.text()`) and feed it
  //     through synthetic `data` + `end` events. The request body sizes
  //     we deal with (RPC commands, agent-config saves) are tiny, so the
  //     buffering overhead is negligible.
  //   - We don't try to support streaming responses through this adapter:
  //     all our endpoints either return JSON in one shot or stream a
  //     session JSONL file fully into memory before writing. If a future
  //     endpoint needs true response streaming, it should branch on
  //     HAS_BUN_SERVE and return a Bun Response with a ReadableStream.
  // ═══════════════════════════════════════════════════════════════════════
  async function runNodeStyleHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Audit A6: same body cap as the node-side handlers. The old
    // `await req.text()` buffered arbitrarily large payloads in full.
    let bodyText = "";
    if (req.method !== "GET" && req.method !== "HEAD") {
      const body = await readCappedBodyBun(req);
      if (body === null) {
        return new Response(JSON.stringify({ error: "payload too large" }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        });
      }
      bodyText = body;
    }

    return await new Promise<Response>((resolve) => {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });

      // Build a minimal IncomingMessage-shaped object. Only the fields
      // our handlers actually touch are emulated; everything else is a
      // sealed `undefined` to fail loudly if a handler ever reaches for
      // something Bun.serve can't provide.
      const dataListeners: Array<(chunk: unknown) => void> = [];
      const endListeners: Array<() => void> = [];
      const reqLike: Record<string, unknown> = {
        url: url.pathname + url.search,
        method: req.method,
        headers,
        // Only `data`/`end` are consumed by our POST handlers — see
        // /api/rpc, /api/agent-config (PUT), etc.
        on(event: string, fn: (chunk?: unknown) => void) {
          if (event === "data") dataListeners.push(fn);
          else if (event === "end") endListeners.push(fn as () => void);
          return reqLike;
        },
      };

      let resolved = false;
      let statusCode = 200;
      const resHeaders: Record<string, string> = {};
      const bodyChunks: Array<Buffer> = [];
      const resLike: Record<string, unknown> = {
        setHeader(name: string, value: string) {
          resHeaders[name] = value;
        },
        writeHead(code: number, maybeHeaders?: Record<string, string>) {
          statusCode = code;
          if (maybeHeaders) {
            for (const [k, v] of Object.entries(maybeHeaders)) {
              resHeaders[k] = v;
            }
          }
        },
        write(chunk: unknown) {
          if (chunk == null) return;
          bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        },
        end(chunk?: unknown) {
          if (resolved) return;
          resolved = true;
          if (chunk != null) {
            bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
          }
          const body = Buffer.concat(bodyChunks);
          resolve(new Response(body, { status: statusCode, headers: resHeaders }));
        },
      };

      // Special case: session JSONL streaming. `serveSessionFile` uses
      // `fs.createReadStream(...).pipe(res)`. Our adapter doesn't
      // implement pipe, so emulate it with `on("data")`+`on("end")`.
      // We attach the pipe shim only when the handler tries to use it.
      resLike.pipe = undefined;
      resLike.on = (_event: string, _fn: unknown) => resLike;

      try {
        serveStaticFile(
          reqLike as unknown as http.IncomingMessage,
          resLike as unknown as http.ServerResponse,
        );
      } catch (err: unknown) {
        if (!resolved) {
          resolved = true;
          resolve(new Response(`Internal error: ${errMessage(err)}`, { status: 500 }));
        }
      }

      // Deliver the buffered body to the handler. Doing this *after*
      // calling `serveStaticFile` ensures the handler has already
      // registered its `data`/`end` listeners.
      if (bodyText) {
        for (const fn of dataListeners) fn(Buffer.from(bodyText));
      }
      for (const fn of endListeners) fn();
    });
  }

  // ═══════════════════════════════════════
  // Auto-start on session begin
  // ═══════════════════════════════════════
  omp.on("session_start", async (_event, ctx) => {
    rememberCtx(ctx);
    startServer(ctx);

    // Push a fresh state snapshot to every already-connected client.
    //
    // Why: omp reloads this extension on `switch_session` / `new_session` /
    // `fork`, which fires `session_shutdown` on the old instance and
    // `session_start` on the new one. The HTTP/WS server is process-scoped
    // and survives that reload (see `EmbeddedServerGlobal`), so the
    // WebView's existing WS connection stays open across the swap. Without
    // an explicit re-broadcast, those clients would keep showing the old
    // session's entries — `buildStateSnapshot` is otherwise only sent on
    // *new* connections in the `wss.on("connection", …)` handler above.
    //
    // We send the same `mirror_sync` payload `handleMirrorSync` already
    // knows how to consume, so the UI replays history, updates the model
    // label, and re-anchors `mirrorActiveSessionFile` to the new session.
    if (globalState.clients.size === 0) return;
    try {
      const snapshot = await buildStateSnapshot(ctx);
      broadcast(snapshot);
    } catch (err) {
      console.error("[Embedded] Failed to broadcast post-switch snapshot:", err);
    }
    // F3: after a session swap (switch/new/fork), re-serve any dialogs that
    // are still pending for the new session — e.g. ones created in the gap
    // between the old instance's shutdown and this start — so clients that
    // just re-anchored to the new session can answer them.
    replayPendingUiRequests();
  });

  // ═══════════════════════════════════════
  // Per-session teardown (NOT process shutdown — see EmbeddedServerGlobal)
  // ═══════════════════════════════════════
  omp.on("session_shutdown", async () => {
    // Drop our captured ctx so we don't accidentally use a torn-down session
    // before the next instance re-publishes its bindings.
    latestCtx = null;
    // Settle any interactive-UI dialogs still waiting on a WebView reply:
    // their callers belong to the outgoing session, so resolve them with the
    // kind's default (mirrors the runtime rejecting pending requests when the
    // RPC client goes away — we degrade to "cancelled" instead of hanging).
    cancelAllUiRequests();
    // Tear down the global pointers IFF they still point at *this* instance,
    // so any WS messages that arrive in the gap before the next
    // session_start fail cleanly with "No active session" instead of hitting
    // a stale handler. We use identity on the bound `handleCommand` closure
    // to detect "still this instance".
    if (globalState.handleCommand === handleCommand) {
      globalState.handleCommand = null;
      globalState.buildStateSnapshot = null;
      globalState.getLatestCtx = null;
      globalState.getAomp = null;
    }
    console.log("[Embedded] Session shutdown (server stays up)");
  });
}
