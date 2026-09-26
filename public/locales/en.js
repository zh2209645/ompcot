/**
 * English UI strings — the source of truth for Ompcot's interface language.
 *
 * Key naming: flat dotted keys namespaced by UI area — `common.*` (shared
 * buttons/labels), `sidebar.*`, `header.*`, `status.*` (connection pill +
 * transient RPC status text), `welcome.*`, `composer.*` (message input +
 * thinking chip), `model.*` (model dropdown), `settings.*` (settings panel),
 * `palette.*` (command palette), `dialog.*` (modals), `files.*` (file
 * browser chrome), `ctx.*` (context window viz + usage pills), `update.*`
 * (updater), `session.*` (session/overlay/LAN-QR strings).
 *
 * Fallback rules (see public/i18n.js `t()`): look the key up in the active
 * language's dictionary first, then in this English dictionary, then return
 * the raw key. zh-CN.js intentionally mirrors this key set — a key missing
 * there simply falls back to the English value here, so partial
 * translations never render a broken string.
 *
 * `{param}` placeholders are interpolated by `t(key, params)`.
 *
 * Do not translate: "Ompcot", "OMP", file paths, or code/config contents
 * that appear inside a string.
 */
export const en = {
  // ── common (shared short labels) ──
  "common.loading": "Loading...",
  "common.chat": "Chat",
  "common.save": "Save",
  "common.cancel": "Cancel",
  "common.close": "Close",

  // ── sidebar ──
  "sidebar.searchPlaceholder": "Search...",
  "sidebar.clearSearch": "Clear search",
  "sidebar.openFolder": "Open folder",
  "sidebar.openFolderAsWorkspace": "Open folder as workspace",
  "sidebar.openingWorkspace": "Opening workspace...",
  "sidebar.refreshSessions": "Refresh sessions",
  "sidebar.loadingSessions": "Loading sessions...",
  "sidebar.settings": "Settings",
  "sidebar.update": "Update",

  // ── header ──
  "header.toggleSidebar": "Toggle sidebar",
  "header.showQr": "Show mobile QR code",
  "header.sessionCost": "Session cost",
  "header.contextUsage": "Context usage",
  "header.openWorkspace": "Open workspace",
  "header.openWorkspaceAria": "Open workspace in app",
  "header.openWorkspaceInApp": "Open workspace in {app}",
  "header.openPathInApp": "Open {path} in {app}",
  "header.chooseApp": "Choose app",
  "header.chooseAppAria": "Choose app to open workspace",
  "header.openInApp": "Open in {app}",
  "header.files": "Files",
  "header.toggleFiles": "Toggle file browser",
  "header.currentGitBranch": "Current git branch",
  "header.branch": "Branch: {name}",

  // ── status (connection pill + transient RPC status text) ──
  "status.connecting": "Connecting...",
  "status.connected": "Connected",
  "status.connectedTs": "Connected • TS",
  "status.connectedLan": "Connected • LAN",
  "status.disconnected": "Disconnected",
  "status.working": "Working...",
  "status.done": "Done",
  "status.failed": "Failed",
  "status.error": "Error",
  "status.compacting": "Compacting...",
  "status.exporting": "Exporting...",
  "status.exported": "Exported: {path}",
  "status.loadingStats": "Loading stats...",
  "status.cyclingThinking": "Cycling thinking...",
  "status.switchingModel": "Switching to {model}...",
  "status.startingSession": "Starting session…",

  // ── welcome (static welcome block) ──
  "welcome.title": "Welcome to Ompcot",
  "welcome.hint":
    "Type a message below to start chatting with OMP, or select a session from the sidebar.",
  "welcome.focusInput": "/ Focus input",
  "welcome.escAbort": "Esc Abort",

  // ── composer (message input + thinking chip) ──
  "composer.placeholder": "Type a message...",
  "composer.message": "Message...",
  "composer.waitingFinish": "Waiting for current session to finish…",
  "composer.readonlyHistory": "Viewing historical session (read-only)",
  "composer.attachImage": "Attach image",
  "composer.commandsTitle": "Commands",
  "composer.openCommandsAria": "Open commands",
  "composer.voiceInput": "Voice input",
  "composer.send": "Send message",
  "composer.abort": "Abort (Esc)",
  "composer.thinkOff": "Depth: off",
  "composer.thinkLevel": "Depth: {level}",
  "composer.thinkingLevel": "Depth: {level}",
  "composer.thinkingTitle": "Thinking depth controls reasoning. Click to cycle.",
  "composer.thinkingAria": "Thinking depth: off. Click to cycle reasoning.",
  "composer.thinkingAriaDynamic": "Thinking depth: {level}. Click to cycle reasoning.",

  // ── thinking-depth menu (A1) + per-setting reset (A3) + transcript resync (A4) ──
  "composer.thinkLevelMenuTitle": "Choose thinking depth",
  "composer.thinkLevelNameOff": "Off",
  "composer.thinkLevelNameMinimal": "Minimal",
  "composer.thinkLevelNameLow": "Low",
  "composer.thinkLevelNameMedium": "Medium",
  "composer.thinkLevelNameHigh": "High",
  "composer.thinkLevelNameXhigh": "xhigh",
  "composer.thinkLevelNameMax": "Max",
  "composer.thinkingTitleMenu": "Thinking depth controls reasoning. Click to choose.",
  "composer.thinkingAriaMenu": "Thinking depth. Click to choose.",
  "composer.thinkingAriaDynamicMenu": "Thinking depth: {level}. Click to choose.",
  "settings.resetToDefault": "Reset to default",
  "palette.resync": "Resync transcript",
  "palette.resyncDesc": "Reload and re-render the transcript from the running session",
  "status.resyncing": "Resynchronizing transcript...",
  "status.resynced": "Resynchronized",
  "status.resyncFailed": "Resync failed",

  // ── model dropdown ──
  "model.switch": "Switch model",
  "model.defaultLabel": "model",
  "model.search": "Search models…",
  "model.noneAvailable": "No models available",
  "model.noKeys": "No API keys configured. Set a key in Settings → Configuration.",
  "model.openSettings": "Open Settings",

  // ── settings panel ──
  "settings.title": "Settings",
  "settings.tab.general": "General",
  "settings.tab.extensions": "Extensions",
  "settings.tab.usage": "Usage",
  "settings.tab.configuration": "Configuration",
  "settings.backToChat": "Back to chat",
  "settings.general": "General",
  "settings.extensions": "Extensions",
  "settings.usage": "Usage",
  "settings.configuration": "Configuration",
  "settings.appearance": "Appearance",
  "settings.language": "Language",
  "settings.interfaceLanguage": "Interface language",
  "settings.agent": "Agent",
  "settings.autoCompaction": "Auto-compaction",
  "settings.thinkingEffort": "Thinking depth",
  "settings.thinkingEffortSub": "Reasoning depth",
  "settings.thinkingCycle": "Click to cycle: off, minimal, low, medium, high, xhigh, max",
  "settings.thinkingLevelOff": "Depth: off",
  "settings.showThinking": "Show thinking",
  "settings.updates": "Updates",
  "settings.ompVersion": "OMP version",
  "settings.appVersion": "Ompcot version",
  "settings.checkForUpdates": "Check for updates",
  "settings.checkNow": "Check now",
  "settings.status": "Status",
  "settings.updateAvailable": "Update available",
  "settings.downloadInstall": "Download & install",
  "settings.runtime": "Runtime",
  "settings.ompBinary": "OMP binary",
  "settings.ompBinaryBrowse": "Choose an omp binary file manually when it cannot be found",
  "settings.browse": "Browse…",
  "settings.costDashboard": "Cost Dashboard",
  "settings.browsePackages": "Browse Community Packages",
  "settings.browseHelp":
    "Discover extensions, skills, themes, and prompts from the OMP ecosystem. Install with one click.",
  "settings.searchPackages": "Search packages...",
  "settings.filterAll": "All",
  "settings.filterExtensions": "Extensions",
  "settings.filterSkills": "Skills",
  "settings.filterThemes": "Themes",
  "settings.filterPrompts": "Prompts",
  "settings.installedOnly": "Installed only",
  "settings.sortPackages": "Sort packages",
  "settings.sortDownloads": "Most downloads",
  "settings.sortName": "Name (A–Z)",
  "settings.sortUpdated": "Recently updated",
  "settings.loadingPackages": "Loading packages...",
  "settings.authentication": "Authentication",
  "settings.authHelp":
    "Keys are stored locally in <code>~/.omp/agent/auth.json</code> (chmod 600). Ompcot launched from Finder does not read shell environment variables, so set keys here for them to stick across launches.",
  "settings.loadingProviders": "Loading providers…",
  "settings.protection": "Protection",
  "settings.requireLogin": "Require login",
  "settings.agentSettings": "Agent settings",
  "settings.agentSettingsHelp":
    "Common agent options, editable in place. Changes save automatically and are picked up by the running agent. Secret keys are managed on the Providers page.",
  "settings.loadingAgentSettings": "Loading agent settings…",
  "settings.agentConfigFile": "Agent config (~/.omp/agent/config.yml)",
  "settings.agentConfigHelp":
    "Advanced: edit <code>~/.omp/agent/config.yml</code> directly as YAML/JSON. Prefer the categorized sub-pages for known keys.",
  "settings.agentConfigLabel": "Agent config file",
  "settings.llmProviders": "LLM providers",
  "settings.llmProvidersHelp":
    'Edit <code>~/.omp/agent/models.yml</code> to add custom providers (Ollama, vLLM, LM Studio, OpenAI-compatible proxies, OpenRouter routing overrides, etc). The file is YAML — JSON works too, since JSON is valid YAML. See the <a href="#">models.yml docs</a> for the full schema. Changes are picked up immediately — no restart needed.',
  "settings.providersFile": "Providers file",
  "settings.insertExample": "Insert example",
  "settings.pages.label": "Configuration sections",
  "settings.pages.providers": "Providers",
  "settings.pages.appearance": "Appearance",
  "settings.pages.model": "Model",
  "settings.pages.interaction": "Interaction",
  "settings.pages.context": "Context",
  "settings.pages.memory": "Memory",
  "settings.pages.files": "Files",
  "settings.pages.shell": "Shell",
  "settings.pages.tools": "Tools",
  "settings.pages.tasks": "Tasks",
  "settings.pages.advanced": "Advanced",

  // ── command palette ──
  "palette.commands": "Commands",
  "palette.compact": "Compact",
  "palette.compactDesc": "Compact context to save tokens",
  "palette.exportHtml": "Export HTML",
  "palette.exportHtmlDesc": "Export session as HTML file",
  "palette.sessionStats": "Session Stats",
  "palette.sessionStatsDesc": "Show session statistics",
  "palette.expandAll": "Expand All Tools",
  "palette.expandAllDesc": "Expand all tool cards",
  "palette.collapseAll": "Collapse All Tools",
  "palette.collapseAllDesc": "Collapse all tool cards",

  // ── composer slash commands + delivery mode ──
  "slash.commands": "Commands",
  "slash.queue": "Queue",
  "slash.steerNow": "Steer now",
  "slash.deliveryLabel": "Delivery",
  "slash.toggleTitle": "How to deliver while the agent is busy. Ctrl+Enter always steers.",
  "slash.queuedHint": "Command will run when the agent is idle",

  // ── agent hub (subagent roster panel) ──
  "agents.title": "Agents",
  "agents.toggleAria": "Toggle agents panel",
  "agents.closeAria": "Close agents panel",
  "agents.groupRunning": "Running",
  "agents.groupFinished": "Finished",
  "agents.kindMain": "Main",
  "agents.kindSub": "Sub",
  "agents.status": "status",
  "agents.viewTranscript": "View transcript",
  "agents.empty": "No subagents yet",
  "agents.unavailable": "Feature unavailable",
  "agents.loadFailed": "Failed to load agents",

  // ── MCP servers (Configuration sub-page) ──
  "settings.pages.mcp": "MCP",
  "mcp.help":
    "MCP servers available to the agent. User-scope servers load for every project; project-scope servers only for this workspace.",
  "mcp.title": "MCP servers",
  "mcp.addServer": "Add server",
  "mcp.editServer": "Edit server",
  "mcp.status": "Status",
  "mcp.statusConnected": "Connected",
  "mcp.statusConnecting": "Connecting",
  "mcp.statusReconnecting": "Reconnecting",
  "mcp.statusFailed": "Failed",
  "mcp.statusDisconnected": "Disconnected",
  "mcp.statusUnknown": "Unknown",
  "mcp.source": "Source",
  "mcp.readOnly": "Read-only",
  "mcp.toolCount": "{count} tools",
  "mcp.enabled": "Enabled",
  "mcp.disabled": "Disabled",
  "mcp.edit": "Edit {name}",
  "mcp.remove": "Remove {name}",
  "mcp.removeConfirm": "Click again to remove {name}",
  "mcp.connect": "Connect",
  "mcp.disconnect": "Disconnect",
  "mcp.reconnect": "Reconnect",
  "mcp.name": "Name",
  "mcp.type": "Type",
  "mcp.command": "Command",
  "mcp.args": "Arguments",
  "mcp.url": "URL",
  "mcp.env": "Environment variables",
  "mcp.scope": "Scope",
  "mcp.scopeUser": "User",
  "mcp.scopeProject": "Project",
  "mcp.liveStatusUnavailable": "Live connection status unavailable",
  "mcp.empty": "No MCP servers configured",
  "mcp.loadFailed": "Failed to load MCP servers",
  "mcp.actionFailed": "Action failed",
  "mcp.errorRequired": "Name and a command or URL are required",
  "mcp.envInvalid": "Environment variables must be KEY=value, one per line",
  "mcp.argsPlaceholder": "one argument per line",
  "mcp.envPlaceholder": "KEY=value (one per line)",

  // ── package registry (Settings → Extensions browse) ──
  "pkg.registryLabel": "Package registry",
  "pkg.registryInvalidUrl": "Address must be an http(s) URL",
  "pkg.registryUnreachable": "Registry unreachable",
  "pkg.retry": "Retry",
  "pkg.cachedData": "Cached data (offline)",
  "pkg.refreshed": "Refreshed",

  // ── theme groups (Settings → Appearance) ──
  "settings.themeGroupBuiltin": "Built-in themes",
  "settings.themeGroupVscode": "VS Code schemes",

  // ── fork availability (feature-detected from the server reply) ──
  "fork.unavailable": "Fork unavailable in this build",

  // ── account usage (Settings → Usage, above the cost dashboard) ──
  "usage.accountUsage": "Account usage",
  "usage.refresh": "Refresh",
  "usage.empty": "No usage data available",
  "usage.loadFailed": "Failed to load account usage",
  "usage.authHint": "If this is an authentication error, log in on the Providers page first.",
  "usage.general": "General",

  // ── OAuth login (Configuration → Providers) ──
  "oauth.title": "OAuth login",
  "oauth.providerPlaceholder": "anthropic / openai-codex",
  "oauth.login": "Login",
  "oauth.browserHint": "Opened in your browser — if it didn't open, complete the flow manually…",
  "oauth.pending": "Waiting for login to complete…",
  "oauth.invalidProvider": "Provider may only contain letters, digits, dashes and underscores",
  "oauth.loginSuccess": "Login complete",
  "oauth.loginFailed": "Login failed",
  "oauth.terminalHint": "If the flow needs terminal interaction, run: omp login {provider}",

  // ── fork from message (hover action + palette) ──
  "fork.fromHere": "Fork from here",
  "fork.failed": "Fork failed",
  "palette.fork": "Fork from latest",
  "palette.forkDesc": "Create a fork from the latest message",
  "status.forking": "Forking...",
  "status.forked": "Fork created",

  // ── extension UI request dialogs ──
  "uiRequest.autoCancelIn": "Auto-cancels in {seconds}s",

  // ── import sessions (sidebar) ──
  "sidebar.importSessions": "Import sessions",
  "session.importFromClaude": "From Claude Code",
  "session.importFromCodex": "From Codex",
  "status.importing": "Importing...",
  "status.imported": "Import complete",
  "session.importFailed": "Import failed",
  "session.importTerminalOnly": "This source must be imported from a terminal: omp --from-{source}",

  // ── modals ──
  "dialog.agentConfig": "Agent Configuration",

  // ── file browser chrome ──
  "files.title": "Files",
  "files.parentDirectory": "Parent directory",
  "files.openInFileManager": "Open in file manager",
  "files.close": "Close",
  "files.closeBrowser": "Close file browser",

  // ── context window / usage pills ──
  "ctx.window": "Context Window",
  "ctx.compact": "Compact",
  "ctx.compactTitle": "Context is over 80% — compact to save tokens",
  "ctx.usageTitle": "Context: {used} / {total} tokens",

  // ── updater ──
  "update.available": "Update available",
  "update.openInSettings": "Open updates in settings",
  "update.availableWithVersion": "Update available: {version}",
  "update.updating": "Updating...",
  "update.inProgress": "Update is in progress",
  "update.retry": "Retry",
  "update.checkFailedTitle": "Last update check failed. Open settings to retry.",
  "update.fromVersion": " (from {version})",
  "update.versionUnknown": "unknown",
  "update.unknownError": "unknown error",
  "update.checkingBtn": "Checking...",
  "update.checkingForUpdates": "Checking for updates...",
  "update.upToDate": "You're on the latest version.",
  "update.upToDateStable": "You're on the latest stable version.",
  "update.desktopOnly": "Auto-updates are only available in the desktop app.",
  "update.prereleaseDisabled":
    "Pre-release build ({version}) — auto-update is disabled for this build.",
  "update.devBuild": "Dev build — updates are checked only in packaged releases.",
  "update.downloading": "Downloading...",
  "update.downloadingMb": "Downloading {size} MB...",
  "update.downloadingPct": "Downloading {percent}%",
  "update.installing": "Installing...",
  "update.installedRestarting": "Update installed. Restarting...",
  "update.restartManually": "Please restart Ompcot to finish updating.",
  "update.installFailed": "Update failed: {error}",
  "update.errorNoManifest":
    "No update manifest published yet. Either the latest GitHub release doesn't include `latest.json`, or it has no entry for this platform. See docs/AUTO_UPDATER.md.",
  "update.errorSignature":
    "Updater public key is missing or the bundle signature is invalid. See docs/AUTO_UPDATER.md.",
  "update.errorUnknown": "Unknown updater error",

  // ── tool cards ──
  "tool.copyOutput": "Copy output",

  // ── chat messages / markdown chrome ──
  "msg.copy": "Copy",
  "msg.copied": "Copied!",
  "msg.copyMessage": "Copy message",
  "msg.attachedImage": "Attached image",
  "msg.thinking": "Thinking",
  "msg.currentWorkspace": "Current workspace: <code>{path}</code>",

  // ── workspace actions (swap overlay labels + failure messages) ──
  "ws.attachFailed": "Failed to attach to workspace: {error}",
  "ws.newSessionNativeOnly": "New session is only supported with a native host.",
  "ws.newSessionNoCwd": "Failed to start new session: current workspace path is unavailable",
  "ws.newSessionNavUnavailable": "Failed to start new session: navigation is unavailable",
  "ws.newSessionFailed": "Failed to start new session: {error}",
  "ws.newChatNativeOnly": "Project new chat is only supported with a native host.",
  "ws.newChatNoPath": "Failed to start new chat: project path is unavailable",
  "ws.newChatNavUnavailable": "Failed to start new chat: navigation is unavailable",
  "ws.startingNewChat": "Starting new chat…",
  "ws.newChatFailed": "Failed to start new chat: {error}",
  "ws.openProjectNativeOnly": "Open project is only supported with a native host.",
  "ws.openProjectNoPath": "Failed to open project: project path is unavailable",
  "ws.openProjectFailed": "Failed to open project: {error}",
  "ws.openFolderNativeOnly": "Open folder is only supported with a native host.",
  "ws.openFolderFailed": "Failed to open folder: {error}",

  // ── startup bootstrap page (bootstrap.html) ──
  "bootstrap.windowTitle": "Ompcot Startup",
  "bootstrap.heading": "Ompcot could not start",
  "bootstrap.embeddedFailed":
    "The embedded <code>omp</code> runtime that ships with Ompcot failed to launch.",
  "bootstrap.reinstallHint":
    "This usually means the installation is incomplete or corrupted. Reinstalling Ompcot normally fixes it. Click <b>Retry startup</b> after reinstalling or rebooting.",
  "bootstrap.retry": "Retry startup",
  "bootstrap.pickBinary": "Specify omp binary path…",
  "bootstrap.tauriUnavailable": "Tauri runtime is unavailable in this window.",
  "bootstrap.startingRuntime": "Starting Pi runtime...",
  "bootstrap.startupFailed": "Startup failed",
  "bootstrap.usingBinary": "Using omp binary: {path}",
  "bootstrap.invalidBinary": "Invalid omp binary",

  // ── session (routing states + LAN QR modal) ──
  "session.newBadge": "New",
  "session.loadingSession": "Loading session…",
  "session.cancelled": "New session was cancelled",
  "session.qrAria": "Mobile QR code",
  "session.openOnMobile": "Open on Mobile",
  "session.generatingQr": "Generating QR code…",
  "session.qrHint": "Scan with your phone to open Ompcot on the same network",
  "session.openLink": "Open Link",
  "session.qrUnavailable": "QR code unavailable",

  // ── dialogs (extension UI modals + sidebar confirm) ──
  "dialog.selectTitle": "Select an option",
  "dialog.confirmTitle": "Confirm",
  "dialog.yes": "Yes",
  "dialog.no": "No",
  "dialog.inputTitle": "Input",
  "dialog.submit": "Submit",
  "dialog.editorTitle": "Editor",
  "dialog.delete": "Delete",
  "dialog.deleteArchivedTitle": "Delete archived sessions",
  "dialog.deleteArchivedOne": "Delete {count} archived session permanently? This cannot be undone.",
  "dialog.deleteArchivedMany":
    "Delete {count} archived sessions permanently? This cannot be undone.",

  // ── session sidebar (dynamic strings) ──
  "session.retry": "Retry",
  "session.loadFailed": "Failed to load sessions.",
  "session.loadFailedRuntime": "Failed to load sessions. OMP runtime may be unavailable.",
  "session.messageMatches": "Message matches",
  "session.matchCount": "{count} matches",
  "session.untitled": "Untitled",
  "session.archive": "Archive",
  "session.unarchive": "Unarchive",
  "session.archiveSession": "Archive session",
  "session.unarchiveSession": "Unarchive session",
  "session.emptySession": "Empty session",
  "session.showMore": "Show more",
  "session.showLess": "Show less",
  "session.favourites": "Favourites",
  "session.newChatIn": "New chat in {name}",
  "session.archived": "Archived",
  "session.deleteAllArchived": "Delete all archived sessions",
  "session.openProject": "Open Project",
  "session.openProjectAria": "Open project",
  "session.justNow": "Just now",
  "session.minutesAgo": "{count}m ago",
  "session.hoursAgo": "{count}h ago",
  "session.yesterday": "Yesterday",
  "session.onboardingNeedsProject": "Open a project to start chatting.",
  "session.onboardingNeedsModel": "Configure an API key or provider to start chatting.",

  // ── file browser (dynamic labels) ──
  "files.loading": "Loading…",
  "files.loadFailed": "Failed to load",
  "files.emptyDirectory": "Empty directory",
};
