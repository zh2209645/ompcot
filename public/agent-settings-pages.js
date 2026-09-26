// Settings → Configuration sub-page taxonomy.
//
// The /api/agent-settings catalog is a flat list of { key, value, type, ... }
// rows with no tab metadata, so sub-pages are derived on the client from the
// first key segment (the same segment agent-settings.js groups by). The
// taxonomy mirrors the omp TUI /settings panel (appearance, model, interaction,
// context, memory, files, shell, tools, tasks), bookended by two
// Ompcot-specific pages: Providers (authentication + models.yml), Models &
// Reasoning (roles/thinking/task-agent overrides over dedicated RPCs) — both
// static UI — plus Other (every catalog key the map below does not claim) and
// Advanced (raw config.yml only — it owns no catalog keys at all). Unmapped
// segments always land in Other so a setting can never disappear from the UI.
//
// `providers` catalog keys are deliberately NOT mapped to the Providers page:
// that page is static (API keys + models.yml) so it stays instant to open, and
// leaving it catalog-free keeps the default sub-page lazy-load free.

/** Sub-pages in display order. `always: true` pages exist with or without catalog entries. */
export const CONFIG_PAGES = [
  { id: "providers", i18nKey: "settings.pages.providers", always: true },
  // Models & Reasoning — model roles, default thinking depth and task-agent
  // overrides, managed over dedicated RPCs (models-reasoning.js), not the
  // settings catalog.
  { id: "models", i18nKey: "models.pageTitle", always: true },
  { id: "appearance", i18nKey: "settings.pages.appearance" },
  { id: "model", i18nKey: "settings.pages.model" },
  { id: "interaction", i18nKey: "settings.pages.interaction" },
  { id: "context", i18nKey: "settings.pages.context" },
  { id: "memory", i18nKey: "settings.pages.memory" },
  { id: "files", i18nKey: "settings.pages.files" },
  { id: "shell", i18nKey: "settings.pages.shell" },
  { id: "tools", i18nKey: "settings.pages.tools" },
  // MCP servers management — static UI (mcp-manager.js), not catalog-backed.
  { id: "mcp", i18nKey: "settings.pages.mcp", always: true },
  { id: "tasks", i18nKey: "settings.pages.tasks" },
  // Catch-all for catalog keys without a category page — the only place
  // unmapped segments render. Hidden when the catalog has no such keys.
  { id: "other", i18nKey: "settings.pages.other" },
  // Raw config.yml editor only — no catalog keys live on this page.
  { id: "advanced", i18nKey: "settings.pages.advanced", always: true },
];

const ALWAYS_PAGE_IDS = new Set(CONFIG_PAGES.filter((page) => page.always).map((page) => page.id));

/** First key segment → sub-page id. Anything absent falls through to "other". */
const SEGMENT_TO_PAGE = {
  // appearance: Theme, Composer, Status Line, Display, Images
  theme: "appearance",
  composer: "appearance",
  statusline: "appearance",
  display: "appearance",
  images: "appearance",
  // model: Thinking, Sampling, Prompt, Retry & Fallback, Advisor, Prewalk, Vision
  model: "model",
  sampling: "model",
  prompt: "model",
  thinking: "model",
  retry: "model",
  advisor: "model",
  prewalk: "model",
  vision: "model",
  // interaction: Input, Approvals, Notifications, Speech, Collab, Startup & Updates, Power, Agent, Git
  input: "interaction",
  approvals: "interaction",
  notifications: "interaction",
  speech: "interaction",
  collab: "interaction",
  startup: "interaction",
  updates: "interaction",
  power: "interaction",
  agent: "interaction",
  git: "interaction",
  // context: General, Compaction, Rules (TTSR), Experimental
  context: "context",
  compaction: "context",
  ttsr: "context",
  experimental: "context",
  // memory: General, Auto-Learn, Mnemopi, Hindsight, Sharpshooter
  memory: "memory",
  autolearn: "memory",
  hindsight: "memory",
  mnemopi: "memory",
  sharpshooter: "memory",
  // files: Editing, Reading, Read Summaries, LSP
  files: "files",
  edit: "files",
  read: "files",
  lsp: "files",
  // shell: Bash, Eval & Runtimes
  bash: "shell",
  eval: "shell",
  shell: "shell",
  runtimes: "shell",
  // tools: Available Tools, Todos, Grep & Browser, Computer, GitHub, Output Limits, Execution, Discovery & MCP, Extensions, Developer
  // (catalog keys under the mcp segment stay on Tools — the MCP servers
  // *management* page is static UI, not part of the settings catalog.)
  tools: "tools",
  todos: "tools",
  grep: "tools",
  browser: "tools",
  computer: "tools",
  github: "tools",
  output: "tools",
  execution: "tools",
  discovery: "tools",
  mcp: "tools",
  extensions: "tools",
  developer: "tools",
  // tasks: Modes, Subagents, Isolation, Commands & Skills
  tasks: "tasks",
  modes: "tasks",
  subagents: "tasks",
  isolation: "tasks",
  commands: "tasks",
  skills: "tasks",
};

/**
 * Maps a catalog key to its sub-page id by first key segment. Unprefixed keys
 * ("theme") map by their single segment; anything unrecognized — including
 * null/undefined — falls back to "other" (the Advanced page is only the raw
 * config.yml editor and never receives catalog keys).
 */
export function pageForKey(key) {
  if (typeof key !== "string" || key.length === 0) return "other";
  const dot = key.indexOf(".");
  const segment = dot > 0 ? key.slice(0, dot) : key;
  return SEGMENT_TO_PAGE[segment] || "other";
}

/** Convenience alias: agent-settings group names are already first key segments. */
export const pageForGroup = pageForKey;

export function isAlwaysPage(pageId) {
  return ALWAYS_PAGE_IDS.has(pageId);
}
