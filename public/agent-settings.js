// Settings → Configuration → Agent settings: renders the catalog served by
// GET /api/agent-settings as a grouped, filterable form. Edits are debounced
// per field (600ms) and saved via PUT /api/agent-settings; each field reports
// its own saving/saved/error status so one failing field never blocks the
// others. `settings_changed` frames pushed over the WebSocket keep idle
// fields in sync with changes made elsewhere (CLI, another window). Redacted
// keys (secrets) are never rendered — authentication lives in the API-keys
// UI above, and raw file editing remains available in the config.yml /
// models.yml editors below.

import {
  clearSettingsSaveMessage,
  showSettingsSaveError,
  showSettingsSaveSuccess,
} from "./settings-save-status.js";

const SAVE_DEBOUNCE_MS = 600;
const GENERAL_GROUP = "general";
const SOURCE_LABELS = { inprocess: "in-process", cli: "CLI" };

function groupOf(key) {
  const dot = key.indexOf(".");
  return dot > 0 ? key.slice(0, dot) : GENERAL_GROUP;
}

function isToggleType(type) {
  return type === "boolean";
}

function isJsonType(type) {
  return type !== "boolean" && type !== "number" && type !== "string" && type !== "enum";
}

function showSavingStatus(messageEl) {
  clearSettingsSaveMessage(messageEl);
  messageEl.textContent = "Saving...";
  messageEl.classList.remove("hidden");
}

export function createAgentSettings({ fetchJson, wsSubscribe }) {
  let container = null;
  let captionEl = null;
  let filterEl = null;
  let errorEl = null;
  let groupsEl = null;
  let catalog = null;
  // Monotonic load generation: a late-failing older load (or its render) must
  // not clobber the result of a newer one.
  let loadSeq = 0;
  // key -> { entry, control, statusEl, timer, saving, savedValue }
  const fields = new Map();
  let unsubscribeWs = null;

  if (typeof wsSubscribe === "function") {
    unsubscribeWs = wsSubscribe(onSettingsChanged);
  }

  function attach(containerEl) {
    container = containerEl;
    if (!container) return;
    container.replaceChildren();
    container.classList.add("agent-settings");

    captionEl = document.createElement("p");
    captionEl.className = "settings-help agent-settings-caption";

    filterEl = document.createElement("input");
    filterEl.type = "text";
    filterEl.className = "settings-input agent-settings-filter";
    filterEl.placeholder = "Filter settings…";
    filterEl.autocomplete = "off";
    filterEl.spellcheck = false;
    filterEl.addEventListener("input", () => applyFilter());

    errorEl = document.createElement("div");
    errorEl.className = "agent-settings-error hidden";

    groupsEl = document.createElement("div");
    groupsEl.className = "agent-settings-groups";
    setGroupsLoading();

    container.append(captionEl, filterEl, errorEl, groupsEl);
  }

  function setGroupsLoading() {
    if (!groupsEl) return;
    groupsEl.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "agent-settings-loading";
    loading.textContent = "Loading agent settings…";
    groupsEl.appendChild(loading);
  }

  async function load() {
    if (!container || typeof fetchJson !== "function") return;
    const seq = ++loadSeq;
    hideLoadError();
    if (!catalog) setGroupsLoading();
    try {
      const data = await fetchJson("/api/agent-settings");
      if (seq !== loadSeq) return;
      if (!data || !Array.isArray(data.settings)) {
        throw new Error("Invalid settings catalog");
      }
      catalog = data;
      renderCatalog();
    } catch (err) {
      if (seq !== loadSeq) return;
      renderLoadError(err);
    }
  }

  function renderLoadError(err) {
    clearFields();
    if (groupsEl) groupsEl.replaceChildren();
    if (!errorEl) return;
    errorEl.replaceChildren();
    const msg = document.createElement("div");
    msg.textContent = `Failed to load agent settings: ${String(
      err?.message || err || "unknown error",
    )}`;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "settings-value-btn";
    retry.style.marginTop = "8px";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => {
      void load();
    });
    errorEl.append(msg, retry);
    errorEl.classList.remove("hidden");
  }

  function hideLoadError() {
    if (!errorEl) return;
    errorEl.classList.add("hidden");
    errorEl.replaceChildren();
  }

  function clearFields() {
    for (const field of fields.values()) {
      if (field.timer) clearTimeout(field.timer);
      field.timer = null;
    }
    fields.clear();
  }

  function renderCatalog() {
    clearFields();
    if (!groupsEl) return;
    groupsEl.replaceChildren();
    if (captionEl) {
      const source = SOURCE_LABELS[catalog.source] || catalog.source;
      captionEl.textContent = catalog.agentRoot
        ? `Settings are stored in ${catalog.agentRoot}${source ? ` (source: ${source})` : ""}.`
        : "";
    }
    const entries = catalog.settings.filter(
      (entry) => entry && !entry.redacted && typeof entry.key === "string",
    );
    const groups = new Map();
    for (const entry of entries) {
      const group = groupOf(entry.key);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(entry);
    }
    for (const [group, groupEntries] of groups) {
      groupsEl.appendChild(buildGroupSection(group, groupEntries));
    }
    applyFilter();
  }

  function buildGroupSection(group, entries) {
    const section = document.createElement("div");
    section.className = "settings-section agent-settings-group";
    section.dataset.group = group;
    const title = document.createElement("div");
    title.className = "settings-section-title";
    title.textContent = group;
    section.appendChild(title);
    for (const entry of entries) {
      section.appendChild(buildFieldRow(entry));
    }
    return section;
  }

  function buildFieldRow(entry) {
    const type = entry.type || "string";
    const row = document.createElement("div");
    row.className = `settings-row agent-setting-row${isJsonType(type) ? " agent-setting-row-json" : ""}`;
    row.dataset.agentSettingKey = entry.key;

    const label = document.createElement("span");
    label.className = "settings-label settings-label-stack";
    const main = document.createElement("span");
    main.className = "settings-label-main";
    main.textContent = entry.key;
    label.appendChild(main);
    const description =
      entry.type === "enum" && entry.description
        ? `${entry.description} (free text)`
        : entry.description;
    if (description) {
      const sub = document.createElement("span");
      sub.className = "settings-label-sub";
      sub.textContent = description;
      label.appendChild(sub);
    }

    const control = buildControl(entry);
    const statusEl = document.createElement("span");
    statusEl.className = "settings-save-status agent-setting-status hidden";

    row.append(label, control, statusEl);
    const field = { entry, control, statusEl, timer: null, saving: false, savedValue: entry.value };
    fields.set(entry.key, field);
    wireControl(field);
    return row;
  }

  function buildControl(entry) {
    const type = entry.type || "string";
    if (type === "boolean") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `settings-toggle${entry.value ? " on" : ""}`;
      btn.setAttribute("role", "switch");
      btn.setAttribute("aria-label", entry.key);
      return btn;
    }
    if (type === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.step = "any";
      input.className = "settings-input agent-setting-input";
      input.setAttribute("aria-label", entry.key);
      input.value = entry.value == null ? "" : String(entry.value);
      return input;
    }
    if (type === "string" || type === "enum") {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "settings-input agent-setting-input";
      input.spellcheck = false;
      input.setAttribute("aria-label", entry.key);
      input.value = entry.value == null ? "" : String(entry.value);
      return input;
    }
    const textarea = document.createElement("textarea");
    textarea.className = "config-editor-textarea agent-setting-json";
    textarea.rows = 4;
    textarea.spellcheck = false;
    textarea.setAttribute("aria-label", entry.key);
    textarea.value = JSON.stringify(entry.value ?? null, null, 2);
    return textarea;
  }

  function wireControl(field) {
    const { entry, control } = field;
    if (isToggleType(entry.type)) {
      control.addEventListener("click", () => {
        control.classList.toggle("on");
        scheduleSave(field);
      });
      return;
    }
    control.addEventListener("input", () => scheduleSave(field));
  }

  function scheduleSave(field) {
    if (field.timer) clearTimeout(field.timer);
    clearSettingsSaveMessage(field.statusEl);
    field.timer = setTimeout(() => {
      field.timer = null;
      void saveField(field);
    }, SAVE_DEBOUNCE_MS);
  }

  function parseControlValue(field) {
    const type = field.entry.type || "string";
    if (type === "boolean") {
      return { value: field.control.classList.contains("on") };
    }
    if (type === "number") {
      const raw = field.control.value.trim();
      if (raw === "") return { error: "Enter a number" };
      const num = Number(raw);
      if (!Number.isFinite(num)) return { error: `"${raw}" is not a number` };
      return { value: num };
    }
    if (type === "string" || type === "enum") {
      return { value: field.control.value };
    }
    try {
      return { value: JSON.parse(field.control.value) };
    } catch (err) {
      return { error: `Invalid JSON: ${String(err?.message || err)}` };
    }
  }

  async function saveField(field) {
    // A save for this field is still in flight — re-check shortly instead of
    // racing two PUTs for the same key.
    if (field.saving) {
      scheduleSave(field);
      return;
    }
    const parsed = parseControlValue(field);
    if (parsed.error) {
      showSettingsSaveError(field.statusEl, parsed.error);
      return;
    }
    field.saving = true;
    showSavingStatus(field.statusEl);
    try {
      const res = await fetchJson("/api/agent-settings", {
        method: "PUT",
        body: { key: field.entry.key, value: parsed.value },
      });
      if (!res || res.ok === false) {
        throw new Error(res?.error || "Failed to save setting");
      }
      field.savedValue = res.value !== undefined ? res.value : parsed.value;
      showSettingsSaveSuccess(field.statusEl);
    } catch (err) {
      showSettingsSaveError(
        field.statusEl,
        String(err?.message || err || "Failed to save setting"),
      );
      // A boolean toggle is optimistic — restore the last saved state so the
      // control reflects reality after a failed PUT.
      if (isToggleType(field.entry.type)) {
        field.control.classList.toggle("on", Boolean(field.savedValue));
      }
    } finally {
      field.saving = false;
    }
  }

  function setControlValue(field, value) {
    const type = field.entry.type || "string";
    if (type === "boolean") {
      field.control.classList.toggle("on", Boolean(value));
      return;
    }
    if (isJsonType(type)) {
      field.control.value = JSON.stringify(value ?? null, null, 2);
      return;
    }
    field.control.value = value == null ? "" : String(value);
  }

  function onSettingsChanged(frame) {
    if (frame?.type !== "settings_changed") return;
    const field = fields.get(frame.path);
    if (!field) return;
    // Never clobber the user: skip while they are editing this field (focus or
    // a pending debounced edit) or while one of its saves is in flight.
    if (field.saving || field.timer) return;
    if (document.activeElement === field.control) return;
    field.savedValue = frame.value;
    setControlValue(field, frame.value);
  }

  function applyFilter() {
    if (!groupsEl) return;
    const query = filterEl ? filterEl.value.trim().toLowerCase() : "";
    for (const section of groupsEl.querySelectorAll(".agent-settings-group")) {
      let visible = 0;
      for (const row of section.querySelectorAll(".agent-setting-row")) {
        const key = row.dataset.agentSettingKey || "";
        const description = row.querySelector(".settings-label-sub")?.textContent || "";
        const matches =
          !query || key.toLowerCase().includes(query) || description.toLowerCase().includes(query);
        row.classList.toggle("hidden", !matches);
        if (matches) visible += 1;
      }
      section.classList.toggle("hidden", visible === 0);
    }
  }

  function destroy() {
    clearFields();
    if (unsubscribeWs) {
      unsubscribeWs();
      unsubscribeWs = null;
    }
    if (container) container.replaceChildren();
    container = null;
    captionEl = null;
    filterEl = null;
    errorEl = null;
    groupsEl = null;
    catalog = null;
  }

  return { attach, load, destroy };
}
