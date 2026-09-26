# Ompcot

## Product

**Ompcot** is a local desktop GUI for the OMP coding agent. It is a Tauri app that spawns one `omp --mode rpc` subprocess per workspace, each on its own port, running the **system `omp` from the user's PATH** (overridable via the `OMP_BIN` env var) — there is no bundled omp binary anymore (`scripts/fetch-omp-binary.js` is a kept-as-no-op; `scripts/omp-version.json` is gone). Each workspace gets its own OS window.

```
Ompcot .app
  resources/
    public/                        (frontend, vanilla JS — no framework)
    extensions/dist/embedded-server.mjs (HTTP + WS server, runs inside omp as an extension)
  Rust OmpManager
    spawn omp --mode rpc --extension embedded-server.mjs  (project A, :3001)
    spawn omp --mode rpc --extension embedded-server.mjs  (project B, :3002)
    OS Window per project  →  WebView  →  localhost:300X
  omp resolved from PATH (or OMP_BIN)
```

Tauri IPC commands (invoked via `window.tauriNative` in `public/tauri-bridge.js`):
- `cmd_open_workspace(cwd)` — spawn omp for a workspace, open a window
- `cmd_new_session(port)` — create a new session in a running omp
- `cmd_switch_session(port, sessionPath)` — resume a historical session
- `cmd_stop_instance(port)` — kill a omp process
- `cmd_pick_folder()` — native folder picker

### Goals

- Local desktop GUI: all projects and agents visible in one app
- Multi-project: each project has its own window, isolated working directory, session history, and running agent
- Multi-agent: one `omp --mode rpc` process drives **one active session** at a time, so every concurrently-running session gets its own omp process. "+ New Session" and sidebar "start new chat" spawn a fresh **headless** omp and navigate the current WebView to it — no new OS window, previously-running sessions keep running.
- Bilingual UI (English / 简体中文) with a Settings picker; preference persisted in a cookie so all workspace windows (different localhost ports) share it
- Visualization: streaming chat, tool-call cards, thinking blocks, token/cost tracking per session
- Self-contained desktop app; the only external requirement is `omp` on PATH

### Feature surface (as of v0.8.3)

- Chat: streaming, tool cards, thinking blocks, abort, queued messages with Queue/Steer-now delivery, queued slash commands (composer `/` autocomplete backed by `list_commands`; slash prompts execute when omp is idle, auto-queue while streaming)
- Model & reasoning: model dropdown, per-model thinking-depth menu (levels resolved from `ctx.model.thinking.efforts`; non-controllable models disable the controls), Configuration → Models & Reasoning page (default model + default thinking depth, 15 model roles, task-agent model overrides/disable — selectors composed as `provider/model:effort`)
- Sessions: history/search/favourites/archive/rename/batch-delete, export HTML, fork (`ctx.branch` — wired, awaiting upstream availability on 18.3.0), transcript re-sync, external import entry points (honest interactive-only guidance)
- Agent Hub: right-dock panel with live agent roster (`AgentRegistry`), status, and read-only nested transcript viewing
- MCP management: Configuration → MCP page — server cards, add/edit (stdio/http/sse) via omp's own validators/writers (file-URL import of the `/mcp` module), enable/disable with persistence; live connection status honestly degraded when the bundled omp build can't expose it
- Interactive UI requests: omp's `extension_ui_request` loop (select/confirm/input) fully interactive — replayable pending dialogs, absolute deadlines, cancel frames
- Settings: General (Appearance themes + language), Extensions (package browse with configurable registry + offline cache), Usage (account usage via `omp usage --json` + local cost dashboard), Configuration sub-pages (Providers incl. API keys + OAuth login via `omp login` subprocess / Appearance / Model / Interaction / Context / Memory / Files / Shell / Tools / Tasks / **Models & Reasoning** / **MCP** / **Other** / Advanced)
- Themes: 6 built-in + 9 VS Code schemes + Windows Terminal theme import (windowsterminalthemes.dev JSON, cookie-persisted, cap 20)

### Constraints

- Frontend: vanilla JS, no framework (`public/`)
- Backend: Rust (Tauri) manages process lifecycle; the Node/TS extension (`extensions/embedded-server.ts`, bundled to `extensions/dist/embedded-server.mjs`) implements the HTTP + WS surface
- omp integration: always via the spawned `omp --mode rpc` subprocess — never re-implement runtime logic. When omp lacks an extension API, prefer in-process surfaces (`currentOMP()`, settings, registry) then CLI fallbacks (`omp config`, `omp usage`, `omp login`); degrade honestly in the UI rather than faking state
- The running omp version is whatever the user has installed; the GUI feature-detects surfaces per build
- User extensions under `~/.omp/agent/extensions/` and `<workspace>/.omp/extensions/` are auto-loaded by omp itself

### omp references

Local install (authoritative for the running version): `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/types/` (readable `.d.ts`; `dist/cli.js` greppable). Upstream: `can1357/oh-my-pi` on GitHub.

---

# Agent working notes

Conventions for any coding agent working in this directory.

## Package manager

Use **Bun** exclusively. Never run `npm install` or `npm ci` — this would create a stray `package-lock.json` that drifts from `bun.lock`.

```bash
bun install --frozen-lockfile   # install deps
bun run <script>                # run package.json scripts
```

## Common commands

```bash
bun run dev              # start tauri dev (hot reload)
bun run test             # vitest run + check-tauri-permissions
bun run test:watch       # vitest in watch mode
bun run check:rust       # cargo check + clippy + fmt (use after every Rust edit)
bun run build:extensions # compile extensions/embedded-server.ts → extensions/dist/embedded-server.mjs
bun run build            # full release build (prebuild: build:extensions)
```

Single test file: `bun run vitest run public/settings-save-status.test.js`

## Linting & Formatting

Biome for JS/TS. After every frontend or extension edit:

```bash
bun run check         # read-only
bun run check:fix     # auto-fix safe issues
```

- **Always** run `bun run check` (or `bunx biome check <touched files>`) after editing `.js`/`.ts` under `public/` or `extensions/`; only mark work done if it exits 0 for your files. Note: the repo-wide check has **pre-existing CRLF-drift failures in untouched files** on Windows checkouts — scope your checks to the files you touched.
- Windows checkouts flip files to CRLF; agents must re-normalize their touched files to LF before committing (biome `--write` on the touched set).

## Module Design

The frontend is vanilla JS with **no framework**:

- **One concern per file**; kebab-case filenames matching the responsibility
- **Avoid growing `app.js`** — it is the entry orchestrator; new feature logic belongs in a dedicated module imported from app.js
- **New file threshold**: >~50 lines of logic → own module
- **No shared-state side-effects at import time**
- **i18n is mandatory** for user-facing strings: `t(key, params)` from `public/i18n.js` for JS-rendered text, `data-i18n*` attributes for static markup; keys live in `public/locales/en.js` + `zh-CN.js` (flat dotted, 1:1 parity enforced by `public/i18n.test.js`); JS-built chrome re-renders via `onLanguageChanged`. Cookie-persisted preferences (`ompcot-theme`, `ompcot-lang`, …) — NOT localStorage — because workspace windows live on different localhost ports (origins); cookies are shared across ports.
- **RPC pattern**: one-shot calls go through `public/ws-rpc.js` (`wsRpc(wsClient, {type, ...})` → `{ok, data}|{ok:false, error}`); request ids are per-window prefixed (collision-proof across windows)

## Architecture

**1. Rust / Tauri (`src-tauri/`)** — process lifecycle and window management.
- `src-tauri/src/omp_manager.rs` — spawns `omp --mode rpc --extension <bundled embedded-server.mjs>` per workspace, port allocation, RPC forwarding (broker WS between WebViews and each omp).
- `src-tauri/src/main.rs` — Tauri commands (`cmd_open_workspace`, `cmd_new_session`, `cmd_switch_session`, `cmd_stop_instance`, `cmd_pick_folder`).

**2. Frontend (`public/`)** — vanilla JS modules: `app.js` (orchestrator), `websocket-client.js`/`transport.js`/`ws-rpc.js` (WS + broker RPC), `message-renderer.js`/`tool-card.js`/`markdown.js`, `session-sidebar.js`, `file-browser.js`, `agent-hub.js`, `mcp-manager.js`, `models-reasoning.js`, `composer-commands.js`, `thinking-level-menu.js`, `ui-requests.js`, `account-usage.js`, `agent-settings*.js`, `themes.js` + `theme-import.js`, `i18n.js` + `locales/`, `dialogs.js`, etc.

**3. Embedded server (`extensions/embedded-server.ts`)** — runs **inside** each omp process:
- HTTP: static assets, `/api/sessions`, `/api/search`, `/api/cost-dashboard`, `/api/files`, `/api/agent-settings`(+`PUT`/`reset`), `/api/agent-config`, `/api/models-config`, `/api/rpc`, `/api/lan-qr`, `/api/health`
- WS commands (shared dispatcher): prompt/steer/follow_up, abort/compact, get_state/set_model/set_thinking_level/cycle_thinking_level, list_commands, list_agents/get_agent_transcript, mcp.*, ui_response/ui_cancel, get_usage, run_omp_login, import_session, fork_session, list_memory_files, get_model_configuration/set_model_role/set_default_thinking_level/set_task_agent_*, auth key CRUD, session ops
- Forwarded events: message/tool lifecycle, auto-compaction, agents_changed, settings_changed, extension_ui_request (with replay), mirror_sync

Key data flow: user action → `window.tauriNative.*` or WS command → embedded-server → omp surfaces (ExtensionAPI / in-process settings+registry / CLI fallbacks).

## Post-fix verification (Rust / Tauri)

After every edit under `src-tauri/`, run `bun run check:rust` (cargo check + clippy -D warnings + fmt check) and only mark complete on exit 0. Never run `tauri build` for verification. NOTE: on Windows bash environments, coreutils `link` can shadow MSVC `link.exe` and break cargo check — run from a VS Developer Shell if that happens.

## Auto-updater & releases

See **docs/AUTO_UPDATER.md** for the updater architecture, the release pipeline's manifest design (per-job fragments + single-writer publish + never-dark-endpoint guarantees), the manual repair runbook, and the step-by-step release procedure. Releases are cut by: bump the 4 version files → `chore(release): vX.Y.Z` commit + tag → push → `gh workflow run Release --ref vX.Y.Z` (tag-push triggering does not work in this repo; releases are manually dispatched).

## Tests

Vitest tests live in `public/` as `*.test.js` (jsdom) and `extensions/*.test.ts`. The full `bun run test` also runs `scripts/check-tauri-permissions.js`. As of this writing: ~438 tests across 43 files; **`cost-infobar.test.js` has 2 known pre-existing palette failures** (fail on clean HEAD — do not chase them). Locale en/zh parity is test-enforced (`i18n.test.js`).
