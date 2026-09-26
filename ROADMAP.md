# Ompcot Roadmap

> **As of 2026-09-26 / v0.8.3.** Ideas and planned features. Nothing unfinished here is committed — just captured so it doesn't get lost. omp feature-gap work is tracked in detail in [`docs/omp-feature-gaps.md`](docs/omp-feature-gaps.md).

---

## ✅ Shipped

### Early wins (pre-v0.6)

- **PWA / Install to Home Screen** — service worker, manifest, custom icons. Installable on iOS/Android/macOS as a standalone app.
- **Full-Text Session Search** — search across all historical sessions by message content, with highlighted snippets in the sidebar.
- **Context Window Visualiser** — click the token usage pill for a breakdown of cached tokens, fresh input, and available space.
- **File Browser** — right sidebar with lazy-loaded file tree, native file open, drag-to-input path insert.
- **Custom Model Picker** — styled dropdown with search/filter and keyboard support.
- **Compaction Support** — manual compact with status shown in the conversation; auto-compaction toggle.
- **Voice Input** — mic button with on-device dictation (Web Speech API), live transcription.
- **Diff Viewer** — inline red/green diffs on edit tool cards, live and historical.
- **Message Queuing** — keep typing while the agent works; queued pills auto-send in order.
- **Image Previews in Chat** — sent images display inline, new messages and history alike.
- **Six Themes** — Dusk, Dawn, Midnight, Clean, Terracotta, Sage.
- **Frosted Header & Footer** — frosted-glass header and input bar.
- **Settings Panel** — theme picker, compaction, thinking level, thinking-block visibility, notifications.

### Gap-closing wave (v0.6.0 – v0.8.3)

Closes the A/B items from the [feature-gap audit](docs/omp-feature-gaps.md), plus adjacent surface:

- ✅ **Thinking-depth menu** (A1), **Queue / Steer-now delivery controls** (A2), **per-setting reset** (A3), **transcript resync** (A4)
- ✅ **Agent Hub** — live subagent roster, status, and read-only transcripts (B1)
- ✅ **MCP server management** — add/edit/toggle with omp's own validators (B2)
- ✅ **OAuth login** via `omp login` subprocess + API-key CRUD (B3)
- ✅ **Interactive agent dialogs** — select/confirm/input via omp's UI-request loop (B4)
- ✅ **Slash-command autocomplete** in the composer (B5)
- ✅ **Account usage views** + local cost dashboard with trends and per-model breakdown (B6)
- ✅ **Session export to HTML**, archive, batch delete; fork wiring (B7 — activation upstream-gated); Claude Code / Codex import entry points (B10)
- ✅ **Copy-output quick action** on tool cards
- ✅ **Configuration sub-pages** — Providers, Models & Reasoning (default model & thinking depth, 15 model roles, per-agent model overrides), MCP, Advanced `config.yml`
- ✅ **Extensions page** — package browser with configurable registry + offline cache (v0.8.x)
- ✅ **Bilingual UI** — English / 简体中文, preference shared across workspace windows
- ✅ **Theme imports** — 9 VS Code schemes + Windows Terminal theme JSON
- ✅ **Auto-updater** and **LAN QR** access
- ✅ **README refresh** — feature overview in English and Chinese; screenshots still pending

---

## ⏳ Upstream-gated

Blocked on omp itself, not on GUI work. Re-evaluate on omp releases:

- **Session fork activation (B7)** — fully wired to `ctx.branch`; activates automatically once omp's embedded command context exposes it.
- **Memory management (B8)** — probe-only today; browse/queue/sync need programmatic memory APIs upstream.
- **Tool-approval RPC channel** — approve/deny with argument diffing is still TUI-side; needs a host reply op in omp.
- **Live MCP connection status** — structurally unavailable in current omp builds (bundle singleton); config CRUD and toggles are shipped. Re-probe on newer omp releases.
- **Agent Hub control actions** — stop/message/focus need an extension seam on omp.

---

## 💡 Ideas

- **File Preview Panel** — context-aware split pane for files the agent is working on: syntax-highlighted code, image/HTML/Markdown previews. Could auto-show on file edits; builds on the file browser.
- **Agent Teams** — spawn teams from the UI with visual grouping and team status overview. Partially superseded by the read-only Agent Hub; the control side is upstream-gated.
- **Conversation fork visualisation** — render history as a tree once forks activate upstream. Like git for conversations.
- **Session Templates** — start a session pre-loaded with per-project context and a starter prompt.
- **Multi-Model A/B Testing** — same prompt to two models side by side, split view with both streaming.
- **Live Terminal Embed** — xterm.js panel with real-time bash output; needs a PTY stream through the extension API (bash tool is one-shot today).
- **memoryd Dashboard** — standalone memory viewer; tracked with B8 above once upstream APIs exist.
- **npm Publishing** — `omp install npm:ompcot` for frictionless install; needs npm account setup and packaging.
- **Screenshots** — Dusk, Clean, mobile, file browser, search, for the README.
