# Ompcot

[English](./README.md) | [中文](./README.zh.md)

A local desktop GUI for the [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi) coding agent. No cloud, no account — runs entirely on your machine. UI in **English and 简体中文** (switchable in Settings).

Ompcot does **not** bundle `omp` — it spawns the **system `omp` from your PATH** (or the `OMP_BIN` env var) once per workspace, so you can update omp independently of the app and always run the version you chose.

> **Forked from [Picot](https://github.com/shixin-guo/picot)** (which was a fork of Tau), adapted for OMP instead of Pi.

---

## Install

[Download from GitHub Releases](https://github.com/zh2209645/ompcot/releases)

You **need `omp` installed first** — Ompcot uses your system omp, it does not ship one:

```bash
brew install omp   # macOS; see upstream for other platforms
```

Install options and details: [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). To point Ompcot at a specific binary, set the `OMP_BIN` environment variable.

### macOS unsigned release notice

Ompcot currently ships macOS builds without Apple Developer ID signing/notarization. Expected Gatekeeper behavior:

`"Ompcot" cannot be opened because the developer cannot be verified.`

**To allow it:**

1. Drag `Ompcot.app` into `/Applications`
2. Right-click → **Open**
3. If blocked: **System Settings → Privacy & Security → Open Anyway**

---

## What it does

Ompcot gives you a full visual interface for OMP. Open any project folder, start chatting with the agent, browse sessions and files — no terminal required. Multiple projects run in parallel, each in its own window with its own isolated agent process.

---

## Features

### 💬 Chat

- **Streaming responses** with full markdown rendering and syntax-highlighted code blocks
- **Tool-call cards** with inline diff viewer (red/green) and live **thinking blocks**
- **Model dropdown** plus a per-model **thinking-depth menu** — depth options follow each model's capabilities and lock when unsupported
- **Slash-command autocomplete** (`/` in the composer) reaching omp's full command set
- **Message queuing** while the agent works — choose per message between **Queue** and **Steer-now** delivery
- Image attachments (paste, drag & drop, or button), one-click copy, abort, unread indicator

### 🗂️ Sessions & Agents

- Session history with **full-text search**, favourites, archive, rename, batch delete, and **HTML export**
- **Fork a conversation** from any message (wired up; activates automatically when your omp build supports it)
- **Import** sessions from Claude Code / Codex — guided entry points
- **Parallel sessions** — each new chat spawns its own headless agent process; previously-running sessions keep running, no new window
- **Agent Hub** — live roster of running subagents with status and read-only transcript viewing

### 🗃️ Projects & Workspace

- **Multi-project** — each project gets its own window, working directory, session history, and agent
- Current **git branch** in the project header; **open in external editor** (VS Code, Cursor, …)
- Native folder picker, plus a **file browser** sidebar with lazy-loaded tree and drag-to-input

### 🔌 MCP & Interactions

- **MCP server management** — add/edit (stdio / HTTP / SSE) and enable/disable with persistence, validated by omp's own rules
- **Interactive agent dialogs** — select / confirm / input requests from the agent surface as dialogs, replayable with deadlines

### ⚙️ Settings

- **General** — appearance themes and UI language
- **Extensions** — package browser with configurable registry and offline cache
- **Usage** — account usage quotas plus a local **cost dashboard** (per-session token/cost, trends, per-model breakdown, context-window visualiser)
- **Configuration** — Providers (API keys + **OAuth login** via `omp login`), **Models & Reasoning** (default model & thinking depth, 15 model roles, per-agent model overrides), MCP, and Advanced raw `config.yml`

### 🎨 Themes

- Six built-in themes, nine VS Code colour schemes, and **Windows Terminal theme import** (windowsterminalthemes.dev JSON)

### 🎤 Voice Input

- Mic button using on-device dictation (Web Speech API), with live transcription

### 📱 Mobile & LAN Access

- **LAN QR code** — scan to open Ompcot on any device on the same network; mobile-optimised, installable as PWA

### 🔄 Updates

- **Built-in auto-updater** — the app keeps itself current with releases published to GitHub

---

## OMP integration

Ompcot does not re-implement agent logic — it drives the omp CLI you already have and exposes its runtime capabilities through a native UI.

- **System `omp --mode rpc` runtime** — one managed process per workspace, resolved from PATH (`OMP_BIN` overrides); update omp independently of Ompcot
- **Streaming RPC bridge** — token-by-token output, tool-call events, and thinking blocks rendered live
- **Session lifecycle APIs** — create, switch, and resume sessions; full per-project history
- **Multi-client sessions** — several UI clients (desktop windows, mobile via LAN) can attach to the same agent
- **Extension compatibility** — user extensions from `~/.omp/agent/extensions/` and `.omp/extensions/` are auto-loaded
- **Credential handling through omp itself** — API keys and OAuth logins land in omp's own `~/.omp/agent/auth.json`

---

## How it works

```
┌──────────────────────────────────────────────────────┐
│ Ompcot .app                                          │
│                                                      │
│   Tauri + OmpManager (Rust)                          │
│      ├─► spawn  omp --mode rpc  (project A, :3001)   │
│      ├─► spawn  omp --mode rpc  (project B, :3002)   │
│      └─► OS Window per project ──► WebView ──► HTTP  │
│                                                      │
│   resources/                                         │
│      ├─ public/             (frontend)               │
│      └─ extensions/         (embedded-server.mjs)    │
└──────────────────────────────────────────────────────┘
          │  omp resolved from PATH (or OMP_BIN)
          ▼ reads / writes
~/.omp/agent/
   ├─ sessions/   (chat history)
   ├─ auth.json   (API keys)
   └─ settings.json
```

Each omp process loads `embedded-server.mjs` at startup. That extension owns the HTTP + WebSocket surface the Tauri WebView talks to: static assets, session APIs, the RPC bridge for prompts, etc. Ompcot's Rust side controls process lifecycle, port allocation, and window management.

---

## Usage

1. Make sure `omp` is installed (`omp --version` in a terminal)
2. Launch **Ompcot** and pick a folder
3. Start chatting — Ompcot spawns the omp agent for that workspace automatically

Provide model credentials via **Settings → Configuration → Providers** (API keys or OAuth login), or via `omp /login` in a terminal. Ompcot delegates all credential handling to omp itself.

---

## Documentation

- [Auto-updater & releases](docs/AUTO_UPDATER.md) — updater architecture, release pipeline, incident runbook
- [OMP feature-gap audit](docs/omp-feature-gaps.md) — which omp capabilities the GUI exposes, and what's still missing
- [macOS release policy](docs/release-macos.md) — local bundle-signing policy check

---

## Build from source

```bash
git clone https://github.com/zh2209645/ompcot.git
cd ompcot
bun install --frozen-lockfile
bun run dev          # start tauri dev with hot reload
```

To make a release build:

```bash
bun run build        # build:extensions + tauri build
```

After any changes under `src-tauri/`:

```bash
bun run check:rust   # cargo check + clippy + fmt (fast; no full build needed)
```

---

## Upstream

Ompcot is a fork of [Picot](https://github.com/shixin-guo/picot) (which was a fork of Tau), adapted for OMP. Key changes:

- **Pi → OMP migration** — all binary references, package names, paths, and env vars updated
- **System omp runtime** — spawns the omp from your PATH (`OMP_BIN` to override); `brew upgrade omp` picks up new versions without rebuilding the app
- **OMP SDK packages** — `@oh-my-pi/pi-coding-agent` and related packages

---

## License

MIT
