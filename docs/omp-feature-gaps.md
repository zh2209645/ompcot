# OMP Feature Gaps in the Ompcot GUI

| | |
|---|---|
| **Audit date** | 2026-09-25 |
| **omp version audited** | 18.3.0 (local system install; source: `pi-coding-agent@18.3.0` `CHANGELOG.md`, changelog coverage 18.0.1 → 18.3.0) |
| **Ompcot GUI version audited** | 0.5.1 @ commit `b123906` (feat(settings): split Configuration into categorized sub-pages) |
| **omp upstream** | can1357/oh-my-pi |

> Method: cross-reference of the omp 18.x changelog against the GUI's actual consumption surface (RPC commands sent, broker controls, HTTP endpoints used, UI affordances) in `public/` and `extensions/embedded-server.ts`.

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
| B3 | **OAuth login** for providers | Terminal OAuth via `omp login`, account/org details, model-discovery refresh (18.3.0); MCP OAuth for Google issuers (18.2.9) | API-key CRUD only; embedded server explicitly excludes OAuth (`embedded-server.ts:1323-1336`) |
| B4 | **Interactive permission/approval prompts** — approve/deny tool calls with argument diffing | Approval policies + hook approval-aware rewriting (18.2.3); masked-secret prompts rejected by RPC (18.2.1) | No approval UI; no approve/deny RPC in embedded server |
| B5 ✅ | **Slash-command coverage** — *implemented 2026-09-25*: composer `/` autocomplete over a new `list_commands` RPC (extension/prompt/skill sources), executed via idle prompts; slash messages auto-queue while streaming | Rich TUI command set across 18.x | Command palette retains its 5 GUI actions; omp workflows now reachable via composer slash input |
| B6 | **Account usage views** — quotas, limits, resets, policies | `/usage`, Claude saved resets + blocked-limit recovery (18.2.9), account policies & `daybreak` badge (18.3.0) | Cost dashboard covers local session cost only; no account/quota perspective |
| B7 | **Session fork/branch** | Fork/branch supported by omp (server reloads on fork — `embedded-server.ts:461,553,1011`) | No fork command exposed; GUI multi-session = new process, not branch-from-state |
| B8 | **Memory management UI** — browse memories, queue, sync | Sharpshooter backend + `/memory queue` `/memory sync` (18.0.10); Hindsight auto-recall (18.2.9); advisor memory context (18.1.2) | Only `memory.*` settings keys (now on the Memory settings page); no browse/sync UI |
| B9 | **Git/VCS workflows** — discard changes, AI-assisted staging, worktrees, review | `/git` discard with confirmation (18.1.22); `/wt`, `/review`, `/move` across 18.x | Branch-name pill only |
| B10 | **External session import** | `--from-claude` / `--from-codex`, `/resume @claude` `/resume @codex` (18.2.1) | Session list shows omp sessions only |

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
