# OMP Feature Gaps in the Ompcot GUI

| | |
|---|---|
| **Audit date** | 2026-09-25 |
| **Last status review** | 2026-09-26 (aligned to Ompcot v0.8.3) |
| **omp version audited** | 18.3.0 (local system install; source: `pi-coding-agent@18.3.0` `CHANGELOG.md`, changelog coverage 18.0.1 → 18.3.0) |
| **Ompcot GUI version audited** | 0.5.1 @ commit `b123906` (feat(settings): split Configuration into categorized sub-pages) |
| **omp upstream** | can1357/oh-my-pi |

> Method: cross-reference of the omp 18.x changelog against the GUI's actual consumption surface (RPC commands sent, broker controls, HTTP endpoints used, UI affordances) in `public/` and `extensions/embedded-server.ts`.

> Status review 2026-09-26 (v0.8.3): B4's interactive dialogs shipped via omp's `extension_ui_request` loop (already reflected in the B4 row). Post-audit v0.8.x additions — the **Models & Reasoning** configuration page and **registry-resilience Extensions** browsing — are beyond the original audit scope and are not scored here.

This document records which omp capabilities the GUI does **not** expose today, split by remediation cost, plus explicit non-gaps. Use it as the backlog source when planning GUI feature work.

---

## A. Quick wins — server surface already exists, frontend-only work

| # | Missing feature | Server-side evidence | GUI today |
|---|---|---|---|
| A1 ✅ | **Thinking-level direct setter** (pick off/minimal/low/medium/high from a menu) — *implemented 2026-09-25* | `set_thinking_level` RPC implemented (`embedded-server.ts:1497-1503`) | Composer button now opens a picker menu (`thinking-level-menu.js`); Settings-tab cycle kept |
| A2 ✅ | **Steer / follow-up delivery controls** — *implemented 2026-09-25* | `steer`, `follow_up` RPC (`embedded-server.ts:1211-1225`) | Queue/Steer-now segmented toggle while streaming + per-item steer button (`composer-commands.js`) |
| A3 ✅ | **Per-setting reset to default** — *implemented 2026-09-25* | `POST /api/agent-settings/reset` (`embedded-server.ts:2372-2400`) | Per-row ↺ reset button with status + catalog reload (`agent-settings.js`) |
| A4 ✅ | **RPC-based full message read** — *implemented 2026-09-25* | `get_messages` RPC (`embedded-server.ts:1296-1304`) | "Resync transcript" palette command sharing the session-history render mapping (`session-resync.js`) |

## B. Major gaps — need embedded-server extension + UI

Ordered by user value.

| # | Missing feature | omp context (version) | GUI today |
|---|---|---|---|
| B1 ✅ | **Subagents / Agent Hub** — *implemented 2026-09-25 (read-only v1)*: `list_agents` RPC via `AgentRegistry.global()` + throttled `agents_changed` push + `get_agent_transcript` (path-safe); Agent Hub right-dock panel with live roster, status, and transcript viewing via the existing session-load flow. Stop/message/focus remain blocked: no extension API on omp 18.3.0 (needs upstream seam) | `^` model tagging (18.2.3); workpools (18.1.7) | Roster + status + transcript shipped; control actions deferred |
| B2 ✅ | **MCP server management** — *implemented 2026-09-25*: Configuration → MCP sub-page (cards + inline add/edit form, stdio/http/sse) over new `mcp.list/save/remove/toggle/connect/disconnect/reconnect` RPCs; omp's own validators/writers reached via file-URL import of the `/mcp` module. Live connection status/connect is structurally unavailable in the bundled omp build (bun-bundle singleton) → honestly degraded (`capabilities.liveStatus:false`, status shown as unknown). Config edits apply on restart/reconnect | `/mcp` with autocomplete (18.2.1); live MCP management in `/extensions` (18.0.4); startup controls (18.3.0) | Full config CRUD + validation + enable/disable with persistence (disabled rows stay visible) |
| B3 ✅ | **OAuth login** — *implemented 2026-09-25*: Providers page "OAuth login" row driving the `run_omp_login` RPC (subprocess `omp login <provider>`, 5-min cap, output tail surfaced; success refreshes the API-keys panel; terminal-flow failures show the `omp login <provider>` command) | Terminal OAuth via `omp login` (18.3.0); MCP OAuth for Google issuers (18.2.9) | API-key CRUD + subprocess-driven OAuth login |
| B4 ✅ | **Interactive UI requests** — *implemented 2026-09-25*: `ui_response`/`ui_cancel` RPCs complete omp's native `extension_ui_request` loop (select/confirm/input, timeouts, FIFO queue, a11y dialogs via dialogs.js). Tool-call approve/deny with argument diffing remains TUI-side (no host reply op on 18.3.0) | Approval policies + hook approval-aware rewriting (18.2.3); masked-secret prompts rejected by RPC (18.2.1) | Extension-UI interactivity shipped; tool-approval diffing blocked upstream |
| B5 ✅ | **Slash-command coverage** — *implemented 2026-09-25*: composer `/` autocomplete over a new `list_commands` RPC (extension/prompt/skill sources), executed via idle prompts; slash messages auto-queue while streaming | Rich TUI command set across 18.x | Command palette retains its 5 GUI actions; omp workflows now reachable via composer slash input |
| B6 ✅ | **Account usage views** — *implemented 2026-09-25*: Usage tab "Account usage" section via the `get_usage` RPC (`omp usage --json`), defensive generic renderer with auth hints | `/usage`, Claude saved resets (18.2.9), account policies (18.3.0) | Local cost dashboard + live account quotas |
| B7 ⚠️ | **Session fork/branch** — *implemented 2026-09-25 with upstream limitation*: `fork_session` RPC → `ctx.branch(entryId)` + "Fork from here" message action and palette command. omp 18.3.0's embedded command ctx exposes no `branch` → feature-detects and degrades to "Fork unavailable in this build" (headless-verified); activates automatically when upstream exposes it | Fork/branch supported by omp core (server reloads on fork — `embedded-server.ts:461,553,1011`) | Wired and ready; awaiting upstream `ctx.branch` availability |
| B8 ⚠️ | **Memory management** — *probe-only 2026-09-25*: `list_memory_files` RPC reads storage roots when a backend is active (returns `available:false` when off/empty); no UI shipped. Browse/queue/sync need upstream programmatic APIs | Sharpshooter backend + `/memory queue` `/memory sync` (18.0.10); Hindsight auto-recall (18.2.9) | Blocked upstream: no extension-reachable memory manager |
| B9 ⛔ | **Git/VCS workflows** — *descoped 2026-09-25*: `omp git` is a fullscreen TUI with no JSON surface; a thin slice is not viable. GUI keeps the branch pill + open-in-editor; use the terminal for full flows | `/git` discard with confirmation (18.1.22); `/wt`, `/review`, `/move` across 18.x | Descope to terminal-native |
| B10 ⚠️ | **External session import** — *implemented 2026-09-25 as honest partial*: sidebar Import menu (Claude Code / Codex) → `import_session` RPC; omp 18.3.0's `--from-claude/--from-codex` require the interactive launcher, so the RPC returns `interactive-only` and the GUI shows the exact terminal command (`omp --from-claude`) | `--from-claude` / `--from-codex`, `/resume @claude` `/resume @codex` (18.2.1) | Guided entry point; headless import blocked upstream |

## C. NOT gaps — agent-side capabilities already effective through the GUI

These run inside the agent; the GUI benefits automatically (tool cards render them normally). No GUI work required beyond ongoing rendering polish.

- `find` semantic workspace search (18.2.7) and `omp://` documentation search (18.2.9 / 18.3.0)
- Browser automation suite: a11y audit, React inspection, network/console, tracing, recording, downloads, WebMCP (18.2.8)
- Edit operations: `CUT`/`PASTE`, `Insert Before/After`, new edit-mode syntax (18.2.1 / 18.3.0)
- Background jobs & services: `wait`, `proc://`, `agent://` messaging (18.3.0)
- Ephemeral `/btw` side turns for extensions (18.3.0)
- Judgment/batch evaluation (`judge`, `judge_batch`), TypeSafe provider (18.2.4 / 18.2.7)
- Image / speech / video pipelines (18.2.7 role-based models, 18.2.8 transcription)
- Auto-compaction with snapshot branches/rewinds (18.3.0)
- Secret obfuscation expansions (18.2.2)

## D. Out of scope — terminal-native, not recommended for GUI parity

- `omp stream` livestreaming, `/collab` relay hosts (18.2.5 / 18.1.20)
- `omp record` / `omp play` `.ompcast` (18.2.10)
- `omp bench` live rankings (18.2.10), `toks` offline token counting (18.3.0), `omp cleanse` (18.2.1)

## Recommended priority

1. **B5 slash commands** + **A1–A4 quick wins** — low cost, high visibility.
2. **B1 subagents** + **B2 MCP management** — omp 18.x's main evolution direction; largest experience gap.
3. **B3 OAuth login** — hard onboarding gap for providers without API keys.
4. B4 approvals, B6 usage, B7 fork — next tier.
5. B8–B10 — on demand.

## Appendix: GUI consumption surface at audit time

- RPC commands sent: `abort`, `compact`, `cycle_thinking_level`, `export_html`, `get_auth`, `get_available_models`, `get_omp_version`, `get_session_stats`, `get_state`, `list_auth_status`, `mirror_sync_request`, `new_session`, `prompt`, `remove_api_key`, `set_api_key`, `set_auto_compaction`, `set_auth`, `set_model`, `set_session_name`
- RPC events consumed: `agent_start/end`, `message_start/update/end`, `tool_execution_start/update/end`, `auto_compaction_start/end`, `extension_ui_request`, `extension_error`, `session_name`, `settings_changed`, `mirror_sync`
- Broker controls used: workspace/session lifecycle, packages, updater, folder picker, open-in-app, devtools
- HTTP: `/api/instances`, `/api/git-branch`, `/api/sessions`(+`/delete-batch`, `/switch`), `/api/search`, `/api/cost-dashboard`, `/api/files`, `/api/open`, `/api/rpc`, `/api/lan-qr`, `/api/health`, `/api/agent-settings`(+`PUT`), `/api/agent-config`, `/api/models-config`, external package registry
- Unused server surface: `set_thinking_level`, `steer`, `follow_up`, `get_messages`, `cycle_model`, `GET /api/omp-version`, `POST /api/agent-settings/reset`
- v0.8.x additions beyond the audit scope (not listed above): Models & Reasoning page RPCs (`get_model_configuration`, `set_model_role`, `set_default_thinking_level`, `set_task_agent_*`) and the registry-resilient Extensions package browse
