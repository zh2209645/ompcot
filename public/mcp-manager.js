// Settings → Configuration → MCP sub-page: MCP server management.
//
// Talks to the embedded server over the shared WebSocket command channel:
// `mcp.list` for the roster, `mcp.save/remove/toggle/connect/disconnect/
// reconnect` for mutations. Every mutation refetches the list afterwards and
// surfaces the server's `error` string inline — this module never invents a
// success state the server didn't confirm.
//
// Render discipline:
// - Chrome (toolbar, form, banner) is built once with data-i18n attributes so
//   applyTranslations() keeps it current on language switches.
// - The server card list is rebuilt from state via t() and re-rendered on
//   onLanguageChanged.
// - Connect/Disconnect/Reconnect buttons exist only when the server advertises
//   capabilities.connect; with capabilities.liveStatus === false a banner
//   explains the absence of live status and every card renders as unknown.

import { onLanguageChanged, t } from "./i18n.js";
import { wsRpc } from "./ws-rpc.js";

const STATUS_CLASSES = new Set([
  "connected",
  "connecting",
  "reconnecting",
  "failed",
  "disconnected",
]);

const STATUS_KEY = {
  connected: "mcp.statusConnected",
  connecting: "mcp.statusConnecting",
  reconnecting: "mcp.statusReconnecting",
  failed: "mcp.statusFailed",
  disconnected: "mcp.statusDisconnected",
};

const FORM_TYPES = ["stdio", "http", "sse"];

/** Parse "KEY=value" lines into an object; null when a line is malformed. */
function parseEnv(text) {
  const env = {};
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return null;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return env;
}

function parseArgs(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

const PENCIL_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
const TRASH_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

export function createMcpManager({ root, wsClient, requestTimeoutMs } = {}) {
  if (!root) {
    return { refresh: async () => {}, destroy: () => {} };
  }

  // ── State ───────────────────────────────────────────────────────────────
  let servers = [];
  let capabilities = { liveStatus: true, connect: false };
  let loaded = false;
  let loadFailed = false;
  let formMode = null; // null | "add" | "edit"
  let mutationDepth = 0; // > 0 → action buttons render disabled
  const armedRemoves = new Map(); // server name → disarm timer
  let destroyed = false;

  // ── Static chrome (data-i18n keeps it language-current) ────────────────

  const banner = document.createElement("div");
  banner.className = "mcp-banner hidden";
  banner.setAttribute("data-i18n", "mcp.liveStatusUnavailable");
  banner.textContent = t("mcp.liveStatusUnavailable");

  const errorLine = document.createElement("div");
  errorLine.className = "mcp-error hidden";

  const listEl = document.createElement("div");
  listEl.className = "mcp-list";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "settings-value-btn mcp-add-btn";
  addBtn.setAttribute("data-i18n", "mcp.addServer");
  addBtn.textContent = t("mcp.addServer");
  addBtn.addEventListener("click", () => openForm("add"));

  const toolbar = document.createElement("div");
  toolbar.className = "mcp-toolbar";
  toolbar.append(addBtn);

  // ── Inline add/edit form ────────────────────────────────────────────────

  const form = document.createElement("form");
  form.className = "mcp-form hidden";
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveForm();
  });

  const formTitle = document.createElement("div");
  formTitle.className = "mcp-form-title";

  const formError = document.createElement("div");
  formError.className = "mcp-form-error hidden";

  function field(labelKey, control) {
    const wrap = document.createElement("label");
    wrap.className = "mcp-field";
    const label = document.createElement("span");
    label.className = "mcp-field-label";
    label.setAttribute("data-i18n", labelKey);
    label.textContent = t(labelKey);
    wrap.append(label, control);
    return wrap;
  }

  function gridRow(...fields) {
    const row = document.createElement("div");
    row.className = "mcp-form-grid";
    row.append(...fields);
    return row;
  }

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "settings-input mcp-input";
  nameInput.autocomplete = "off";
  nameInput.spellcheck = false;

  const typeSelect = document.createElement("select");
  typeSelect.className = "settings-select mcp-input";
  for (const value of FORM_TYPES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    typeSelect.append(option);
  }
  typeSelect.addEventListener("change", syncTypeFields);

  const scopeSelect = document.createElement("select");
  scopeSelect.className = "settings-select mcp-input";
  for (const [value, key] of [
    ["user", "mcp.scopeUser"],
    ["project", "mcp.scopeProject"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.setAttribute("data-i18n", key);
    option.textContent = t(key);
    scopeSelect.append(option);
  }

  const commandInput = document.createElement("input");
  commandInput.type = "text";
  commandInput.className = "settings-input mcp-input";
  commandInput.autocomplete = "off";
  commandInput.spellcheck = false;

  const argsInput = document.createElement("textarea");
  argsInput.className = "settings-input mcp-input mcp-textarea";
  argsInput.spellcheck = false;
  argsInput.setAttribute("data-i18n-placeholder", "mcp.argsPlaceholder");
  argsInput.placeholder = t("mcp.argsPlaceholder");

  const urlInput = document.createElement("input");
  urlInput.type = "text";
  urlInput.className = "settings-input mcp-input";
  urlInput.autocomplete = "off";
  urlInput.spellcheck = false;

  const envInput = document.createElement("textarea");
  envInput.className = "settings-input mcp-input mcp-textarea";
  envInput.spellcheck = false;
  envInput.setAttribute("data-i18n-placeholder", "mcp.envPlaceholder");
  envInput.placeholder = t("mcp.envPlaceholder");

  const urlField = field("mcp.url", urlInput);

  const stdioFields = gridRow(field("mcp.command", commandInput), field("mcp.args", argsInput));
  stdioFields.classList.add("mcp-form-stack");

  const formActions = document.createElement("div");
  formActions.className = "mcp-form-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "settings-value-btn";
  cancelBtn.setAttribute("data-i18n", "common.cancel");
  cancelBtn.textContent = t("common.cancel");
  cancelBtn.addEventListener("click", closeForm);
  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn-primary";
  saveBtn.setAttribute("data-i18n", "common.save");
  saveBtn.textContent = t("common.save");
  formActions.append(cancelBtn, saveBtn);

  form.append(
    formTitle,
    formError,
    gridRow(field("mcp.name", nameInput), field("mcp.scope", scopeSelect)),
    gridRow(field("mcp.type", typeSelect), urlField),
    stdioFields,
    field("mcp.env", envInput),
    formActions,
  );

  root.append(banner, errorLine, listEl, toolbar, form);

  // ── Form behavior ───────────────────────────────────────────────────────

  function syncTypeFields() {
    const isStdio = typeSelect.value === "stdio";
    stdioFields.classList.toggle("hidden", !isStdio);
    urlField.classList.toggle("hidden", isStdio);
  }

  function showFormError(text) {
    formError.textContent = text;
    formError.classList.remove("hidden");
  }

  function openForm(mode, server = null) {
    formMode = mode;
    formTitle.textContent = t(mode === "edit" ? "mcp.editServer" : "mcp.addServer");
    nameInput.value = server?.name ? String(server.name) : "";
    // The name is the server's identity key; renames are not part of the
    // contract, so edit mode locks it (remove + re-add changes the name).
    nameInput.disabled = mode === "edit";
    typeSelect.value = FORM_TYPES.includes(server?.type) ? server.type : "stdio";
    commandInput.value = server?.command ? String(server.command) : "";
    argsInput.value = Array.isArray(server?.args) ? server.args.join("\n") : "";
    urlInput.value = server?.url ? String(server.url) : "";
    // The list payload does not include env, so the field starts empty; an
    // untouched env field is omitted from the save payload (see saveForm)
    // rather than wiping the server's real env.
    envInput.value = "";
    scopeSelect.value = server?.source === "project" ? "project" : "user";
    formError.classList.add("hidden");
    syncTypeFields();
    form.classList.remove("hidden");
    addBtn.classList.add("hidden");
    nameInput.focus();
  }

  function closeForm() {
    formMode = null;
    form.classList.add("hidden");
    addBtn.classList.remove("hidden");
  }

  async function saveForm() {
    if (destroyed || !formMode) return;
    const name = nameInput.value.trim();
    const type = typeSelect.value;
    const command = commandInput.value.trim();
    const url = urlInput.value.trim();
    if (!name || (type === "stdio" ? !command : !url)) {
      showFormError(t("mcp.errorRequired"));
      return;
    }
    const env = parseEnv(envInput.value);
    if (env === null) {
      showFormError(t("mcp.envInvalid"));
      return;
    }
    const config = { type };
    if (type === "stdio") {
      config.command = command;
      config.args = parseArgs(argsInput.value);
    } else {
      config.url = url;
    }
    // Include env only when the user actually provided some — an empty env
    // must never wipe whatever the server has stored for an existing name.
    if (Object.keys(env).length > 0) config.env = env;

    const ok = await mutate(
      { type: "mcp.save", name, config, scope: scopeSelect.value },
      { formError: true },
    );
    if (ok) closeForm();
  }

  // ── Mutations + fetch ───────────────────────────────────────────────────

  async function mutate(command, { formError: surfaceOnForm = false } = {}) {
    mutationDepth++;
    let result;
    try {
      result = await wsRpc(wsClient, command, { timeoutMs: requestTimeoutMs });
    } finally {
      mutationDepth--;
    }
    if (destroyed) return false;
    if (!result.ok) {
      const text = result.error || t("mcp.actionFailed");
      if (surfaceOnForm && formMode) showFormError(text);
      else showError(text);
    } else {
      hideError();
    }
    await refresh();
    return result.ok;
  }

  function showError(text) {
    errorLine.textContent = text;
    errorLine.classList.remove("hidden");
  }

  function hideError() {
    errorLine.classList.add("hidden");
  }

  async function refresh() {
    if (destroyed) return;
    const result = await wsRpc(wsClient, { type: "mcp.list" }, { timeoutMs: requestTimeoutMs });
    if (destroyed) return;
    if (!result.ok) {
      loadFailed = true;
      showError(t("mcp.loadFailed"));
    } else {
      // Clear the error line only when it came from a failed list load —
      // a mutation error stays visible until the next successful mutation.
      if (loadFailed) hideError();
      loadFailed = false;
      loaded = true;
      servers = Array.isArray(result.data?.servers) ? result.data.servers : [];
      capabilities = {
        liveStatus: result.data?.capabilities?.liveStatus !== false,
        connect: result.data?.capabilities?.connect === true,
      };
    }
    render();
  }

  // ── Card list rendering ─────────────────────────────────────────────────

  function statusLabel(server) {
    if (!capabilities.liveStatus) return t("mcp.statusUnknown");
    return t(STATUS_KEY[server.status] || "mcp.statusUnknown");
  }

  function statusClass(server) {
    if (!capabilities.liveStatus) return "unknown";
    return STATUS_CLASSES.has(server.status) ? server.status : "unknown";
  }

  function sourceLabel(server) {
    if (server.source === "user") return t("mcp.scopeUser");
    if (server.source === "project") return t("mcp.scopeProject");
    return server.source ? String(server.source) : "";
  }

  function badge(text, extraClass = "", title = "") {
    const el = document.createElement("span");
    el.className = `mcp-badge ${extraClass}`.trim();
    el.textContent = text;
    if (title) el.title = title;
    return el;
  }

  function iconButton(icon, labelKey, labelParams, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn mcp-card-btn";
    btn.innerHTML = icon;
    const label = t(labelKey, labelParams);
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.disabled = mutationDepth > 0;
    if (onClick) btn.addEventListener("click", onClick);
    return btn;
  }

  function connectActions(server) {
    if (!capabilities.connect) return [];
    switch (statusClass(server)) {
      case "connected":
        return [{ command: "mcp.disconnect", key: "mcp.disconnect" }];
      case "connecting":
      case "reconnecting":
        return [];
      case "failed":
        return [{ command: "mcp.reconnect", key: "mcp.reconnect" }];
      default:
        return [{ command: "mcp.connect", key: "mcp.connect" }];
    }
  }

  function card(server) {
    const el = document.createElement("div");
    el.className = "mcp-card";
    el.tabIndex = 0;
    el.setAttribute("aria-label", `${server.name} — ${statusLabel(server)}`);

    const head = document.createElement("div");
    head.className = "mcp-card-head";
    const dot = document.createElement("span");
    dot.className = `mcp-dot ${statusClass(server)}`;
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "mcp-name";
    name.textContent = String(server.name);
    head.append(dot, name, badge(String(server.type || ""), "mcp-type"));
    if (sourceLabel(server)) {
      head.append(
        badge(
          sourceLabel(server),
          "mcp-source",
          server.sourcePath ? String(server.sourcePath) : "",
        ),
      );
    }

    const meta = document.createElement("div");
    meta.className = "mcp-card-meta";
    const status = document.createElement("span");
    status.className = "mcp-status";
    const statusValue = document.createElement("span");
    statusValue.className = "mcp-status-value";
    statusValue.textContent = statusLabel(server);
    status.append(document.createTextNode(`${t("mcp.status")}: `), statusValue);
    meta.append(status);
    if (server.toolCount != null) {
      meta.append(badge(t("mcp.toolCount", { count: server.toolCount }), "mcp-tools"));
    }
    if (server.writable === false) {
      const lock = document.createElement("span");
      lock.className = "mcp-lock";
      lock.textContent = `🔒 ${t("mcp.readOnly")}`;
      meta.append(lock);
    }

    const actions = document.createElement("div");
    actions.className = "mcp-card-actions";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = `settings-toggle ${server.enabled ? "on" : ""}`.trim();
    const toggleLabel = `${server.name} — ${t(server.enabled ? "mcp.enabled" : "mcp.disabled")}`;
    toggle.title = toggleLabel;
    toggle.setAttribute("aria-label", toggleLabel);
    toggle.setAttribute("aria-pressed", String(server.enabled === true));
    toggle.disabled = mutationDepth > 0;
    toggle.addEventListener("click", () => {
      void mutate({ type: "mcp.toggle", name: server.name, enabled: !server.enabled });
    });
    actions.append(toggle);

    for (const action of connectActions(server)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "settings-value-btn mcp-action-btn";
      btn.textContent = t(action.key);
      btn.disabled = mutationDepth > 0;
      btn.addEventListener("click", () => {
        void mutate({ type: action.command, name: server.name });
      });
      actions.append(btn);
    }

    if (server.writable !== false) {
      const armed = armedRemoves.has(server.name);
      actions.append(
        iconButton(PENCIL_ICON, "mcp.edit", { name: server.name }, () => openForm("edit", server)),
        iconButton(
          TRASH_ICON,
          armed ? "mcp.removeConfirm" : "mcp.remove",
          { name: server.name },
          () => handleRemove(server),
        ),
      );
      actions.lastChild.classList.toggle("armed", armed);
    }

    el.append(head, meta, actions);
    return el;
  }

  /** Two-step remove: first click arms the button, second click sends. */
  function handleRemove(server) {
    if (armedRemoves.has(server.name)) {
      clearTimeout(armedRemoves.get(server.name));
      armedRemoves.delete(server.name);
      const command = { type: "mcp.remove", name: server.name };
      if (server.source === "user" || server.source === "project") command.scope = server.source;
      void mutate(command);
      return;
    }
    const timer = setTimeout(() => {
      armedRemoves.delete(server.name);
      render();
    }, 4000);
    armedRemoves.set(server.name, timer);
    render();
  }

  function note(text) {
    const el = document.createElement("div");
    el.className = "mcp-note";
    el.textContent = text;
    return el;
  }

  function render() {
    banner.classList.toggle("hidden", capabilities.liveStatus);
    listEl.replaceChildren();
    if (loadFailed) {
      listEl.append(note(t("mcp.loadFailed")));
      return;
    }
    if (!loaded) {
      listEl.append(note(t("common.loading")));
      return;
    }
    if (servers.length === 0) {
      listEl.append(note(t("mcp.empty")));
      return;
    }
    for (const server of servers) listEl.append(card(server));
  }

  const unsubscribeLanguage = onLanguageChanged(() => {
    if (formMode) {
      formTitle.textContent = t(formMode === "edit" ? "mcp.editServer" : "mcp.addServer");
    }
    render();
  });

  render();

  return {
    refresh,
    openAddForm: () => openForm("add"),
    closeForm,
    destroy: () => {
      destroyed = true;
      unsubscribeLanguage();
      for (const timer of armedRemoves.values()) clearTimeout(timer);
      armedRemoves.clear();
      root.replaceChildren();
    },
  };
}
