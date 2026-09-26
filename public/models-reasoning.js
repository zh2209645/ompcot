// Settings → Configuration → Models & Reasoning sub-page.
//
// One management surface for everything model- and reasoning-shaped that the
// agent-settings catalog cannot express: per-role model assignments
// (get_model_configuration / set_model_role), the default thinking depth that
// applies to NEW sessions (set_default_thinking_level — the current session is
// adjusted from the composer depth menu), and per-task-agent model overrides
// plus enable/disable (set_task_agent_model_override / set_task_agent_disabled).
// Picker options come from the same get_available_models RPC the header model
// dropdown uses.
//
// Behavior contracts (mirrors mcp-manager.js):
// - Every mutation fires immediately on control change, shows per-row
//   saving/saved/error status (server error text verbatim), then refetches the
//   configuration so the page always mirrors server state.
// - A stored selector whose NORMALIZED base id is genuinely absent from the
//   available-models list renders as an extra flagged option (⚠ not in
//   available list) instead of being silently dropped by the rebuild.
//   Selectors are not bare registry ids — real omp accepts `zai/glm-5.3:high`
//   (provider-prefixed + effort suffix), `@smol` (role reference), aliases,
//   and bare ids — so the flag check compares after normalization
//   (normalizeModelSelector / isModelSelectorAvailable below).
// - `available: false` degrades to an unavailable note AND schedules a
//   bounded silent retry (the embedded server can still be initializing on
//   the first page load — the note is not a dead end); a failed fetch keeps
//   last-good content with an error line + retry above it.
// - The page is fully rebuilt by render(); onLanguageChanged re-renders, and
//   per-row statuses survive the rebuild (keyed by row id).

import { onLanguageChanged, t } from "./i18n.js";
import { wsRpc } from "./ws-rpc.js";

const OK_STATUS_MS = 2000;
// `available:false` is not terminal: the in-process Settings surface may not
// be reachable yet when the page first loads (extension context still
// initializing), so the note silently re-fetches a few times before giving
// up. Reopening the page restarts the budget. Exported for the tests.
export const UNAVAILABLE_RETRY_MS = 5000;
const UNAVAILABLE_RETRY_MAX = 3;

// ── Model-selector normalization (exported pure helpers) ────────────────
//
// Stored model selectors are not necessarily bare registry ids:
//   zai/glm-5.3:high  provider-prefixed + trailing `:effort` suffix
//   @smol             role reference — resolves to that role's current model
//   glm-5.3           bare id (available lists may be prefixed or bare)
// The not-in-list check must compare the normalized base id, or every
// legitimate selector shape gets flagged 「模型未在可用列表」.

// Effort words that may appear as a selector's trailing `:effort` suffix.
// "off"/"inherit" are agent-local thinking values, not persisted-default
// enum options, but a stored selector may still carry them.
export const MODEL_SELECTOR_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
  "off",
  "inherit",
]);

// Strip ONE trailing `:effort` suffix. Only strips when the remaining
// prefix is non-empty (":high" stays) and the suffix is a known effort word
// ("gpt-5:blue" stays — that may be a real id).
function stripTrailingEffort(value) {
  const idx = value.lastIndexOf(":");
  if (idx <= 0) return value;
  const suffix = value.slice(idx + 1).toLowerCase();
  if (!MODEL_SELECTOR_EFFORTS.has(suffix)) return value;
  return value.slice(0, idx);
}

function lookupRoleCurrent(rolesById, roleId) {
  if (!rolesById) return null;
  if (typeof rolesById.get === "function") {
    const current = rolesById.get(roleId);
    return typeof current === "string" ? current : null;
  }
  const current = rolesById[roleId];
  return typeof current === "string" ? current : null;
}

/**
 * Reduce a stored model selector to the base id used for list matching:
 * trim → strip a trailing `:effort` suffix → resolve `@role` references
 * through the current roles table (one level per spec, with a cycle guard;
 * the resolved value gets its effort suffix stripped again). An unresolved
 * role reference (the role itself is unset/unknown) returns the raw ref —
 * it cannot match any model id, so it stays flagged, which is correct.
 *
 * @param {string|null|undefined} selector stored selector value
 * @param {Map<string, string|null>|Record<string, string>|null} rolesById
 *   role id → the role's current selector (Map or plain object)
 * @returns {string} normalized base id ("" for empty input)
 */
export function normalizeModelSelector(selector, rolesById = null) {
  let value = String(selector ?? "").trim();
  if (!value) return "";
  value = stripTrailingEffort(value);
  const seen = new Set();
  while (value.startsWith("@")) {
    if (seen.has(value)) break; // @a → @b → @a cycle: stop, stays flagged
    seen.add(value);
    const current = lookupRoleCurrent(rolesById, value.slice(1));
    if (typeof current !== "string" || !current.trim()) return value;
    value = stripTrailingEffort(current.trim());
  }
  return value;
}

function lastSegmentLower(id) {
  const lower = String(id).toLowerCase();
  const idx = lower.lastIndexOf("/");
  return idx >= 0 ? lower.slice(idx + 1) : null;
}

/**
 * Is the stored selector's normalized base id genuinely present in the
 * available-models list? get_available_models entries look like
 * `{ id, provider, contextWindow }` where `id` may be bare (`gpt-5`) or
 * provider-prefixed (`zai/glm-5.3`) depending on the provider, so we match
 *   - exact id (case-insensitive),
 *   - `${provider}/${id}` when the entry carries a provider,
 *   - cross bare↔prefixed last-segment: selector `zai/glm-5.3` vs id
 *     `glm-5.3`, and the reverse.
 * Both-prefixed ids must match exactly (no last-segment guess — different
 * providers can share a model name).
 *
 * @param {string} selector stored selector value
 * @param {Array<{id: string, provider?: string}>} models available list
 * @returns {boolean} true when available or nothing is stored
 */
export function isModelSelectorAvailable(selector, models, rolesById = null) {
  const base = normalizeModelSelector(selector, rolesById);
  if (!base) return true; // nothing stored → nothing to flag
  const baseLower = base.toLowerCase();
  const baseLast = lastSegmentLower(base);
  for (const model of Array.isArray(models) ? models : []) {
    const id = typeof model?.id === "string" ? model.id : "";
    if (!id) continue;
    const idLower = id.toLowerCase();
    if (baseLower === idLower) return true;
    const provider = typeof model?.provider === "string" ? model.provider.toLowerCase() : "";
    if (provider && baseLower === `${provider}/${idLower}`) return true;
    const idLast = lastSegmentLower(id);
    if (baseLast && !idLast && baseLast === idLower) return true;
    if (idLast && !baseLast && baseLower === idLast) return true;
  }
  return false;
}

function cssEscape(value) {
  return typeof window.CSS?.escape === "function" ? window.CSS.escape(value) : value;
}

function thinkingLabelKey(level) {
  const raw = String(level);
  return `composer.thinkLevelName${raw.charAt(0).toUpperCase()}${raw.slice(1)}`;
}

function thinkingLevelLabel(level) {
  if (level === "auto") return t("models.thinkingAuto");
  const key = thinkingLabelKey(level);
  const label = t(key);
  // Unknown level (or untranslated key) → show the raw level string.
  return label === key ? String(level) : label;
}

function isAdvisorRole(id) {
  return /advisor/i.test(String(id));
}

export function createModelsReasoning({ root, wsClient, requestTimeoutMs } = {}) {
  if (!root) {
    return { refresh: async () => {}, destroy: () => {} };
  }

  // ── State ───────────────────────────────────────────────────────────────
  let config = null; // last-good get_model_configuration payload
  let models = []; // get_available_models payload
  let loaded = false; // at least one successful configuration fetch
  let loadFailed = false; // last configuration fetch failed
  let loadGeneration = 0;
  let destroyed = false;
  // Silent-retry bookkeeping for the available:false note (see
  // scheduleUnavailableRetry).
  let unavailableRetries = 0; // attempts spent this page-open
  let unavailableRetryTimer = null;
  // rowKey → { text, tone, timer } — survives full re-renders so a save
  // confirmation is not wiped by the refetch that follows it.
  const rowStatuses = new Map();

  const pageEl = document.createElement("div");
  pageEl.className = "mr-page";
  root.appendChild(pageEl);

  const unsubscribeLanguage = onLanguageChanged(() => render());

  const rpcOptions = () => ({ timeoutMs: requestTimeoutMs });

  // Role id → the role's current selector, for `@role` reference resolution
  // in the not-in-list check (see normalizeModelSelector).
  function rolesById() {
    const map = new Map();
    for (const role of Array.isArray(config?.roles) ? config.roles : []) {
      if (!role || typeof role.id !== "string" || role.id.length === 0) continue;
      map.set(role.id, typeof role.current === "string" ? role.current : null);
    }
    return map;
  }

  // ── Row statuses (painted into whatever render() last built) ────────────

  function setRowStatus(rowKey, text, tone) {
    const prev = rowStatuses.get(rowKey);
    if (prev?.timer) clearTimeout(prev.timer);
    const entry = { text, tone, timer: null };
    if (tone === "ok") {
      entry.timer = setTimeout(() => {
        if (rowStatuses.get(rowKey) === entry) {
          rowStatuses.delete(rowKey);
          paintRowStatus(rowKey);
        }
      }, OK_STATUS_MS);
    }
    rowStatuses.set(rowKey, entry);
    paintRowStatus(rowKey);
  }

  function paintRowStatus(rowKey) {
    const el = pageEl.querySelector(`[data-mr-status="${cssEscape(rowKey)}"]`);
    if (!el) return;
    const entry = rowStatuses.get(rowKey);
    if (!entry) {
      el.textContent = "";
      delete el.dataset.tone;
      el.classList.add("hidden");
      return;
    }
    el.textContent = entry.text;
    if (entry.tone) el.dataset.tone = entry.tone;
    else delete el.dataset.tone;
    el.classList.remove("hidden");
  }

  // ── Mutations + fetch ───────────────────────────────────────────────────

  async function mutate(command, rowKey, { revert } = {}) {
    setRowStatus(rowKey, t("models.saving"), "busy");
    const result = await wsRpc(wsClient, command, rpcOptions());
    if (destroyed) return false;
    if (result.ok) {
      setRowStatus(rowKey, t("models.saved"), "ok");
    } else {
      setRowStatus(rowKey, String(result.error || "error"), "error");
      // Optimistic controls (the enable/disable toggle) go back to their
      // pre-click state; the refetch below re-renders everything else.
      revert?.();
    }
    await refresh();
    return result.ok;
  }

  async function refresh() {
    if (destroyed) return;
    const generation = ++loadGeneration;
    // Only the first load shows a loading state — a refetch after a mutation
    // must not flash blank over content the user is interacting with.
    if (!loaded) render();
    const [configRes, modelsRes] = await Promise.all([
      wsRpc(wsClient, { type: "get_model_configuration" }, rpcOptions()),
      wsRpc(wsClient, { type: "get_available_models" }, rpcOptions()),
    ]);
    if (destroyed || generation !== loadGeneration) return;
    if (configRes.ok) {
      loadFailed = false;
      loaded = true;
      config = configRes.data && typeof configRes.data === "object" ? configRes.data : {};
    } else {
      loadFailed = true;
    }
    if (modelsRes.ok && Array.isArray(modelsRes.data?.models)) {
      models = modelsRes.data.models.filter(Boolean);
    }
    render();
  }

  // ── Shared builders ─────────────────────────────────────────────────────

  function sectionTitle(key) {
    const el = document.createElement("div");
    el.className = "settings-section-title";
    el.textContent = t(key);
    return el;
  }

  function noteEl(key) {
    const el = document.createElement("div");
    el.className = "mr-note";
    el.textContent = t(key);
    return el;
  }

  function badge(text, title = "", extraClass = "") {
    const el = document.createElement("span");
    el.className = `mr-badge${extraClass ? ` ${extraClass}` : ""}`;
    el.textContent = text;
    if (title) el.title = title;
    return el;
  }

  function chip(text, extraClass = "") {
    const el = document.createElement("span");
    el.className = `mr-chip${extraClass ? ` ${extraClass}` : ""}`;
    el.textContent = text;
    el.title = text;
    return el;
  }

  function statusEl(rowKey) {
    const el = document.createElement("span");
    el.className = "mr-status hidden";
    el.dataset.mrStatus = rowKey;
    return el;
  }

  /**
   * Model picker as a plain select. Options: optional empty option (Not set /
   * No override), then every available model, then — when the stored
   * selector is not literally among them — the stored value as an extra
   * option so a stale/custom selector stays visible instead of being
   * silently dropped. The extra option is flagged (⚠ not in available list)
   * only when the selector's NORMALIZED base id is genuinely absent
   * (effort suffix / `@role` ref / provider-prefix variants render clean).
   */
  function buildModelSelect({ value, emptyKey, ariaLabel, onChange }) {
    const select = document.createElement("select");
    select.className = "settings-select mr-select";
    if (ariaLabel) select.setAttribute("aria-label", ariaLabel);

    if (emptyKey) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = t(emptyKey);
      select.appendChild(empty);
    }

    const known = new Set();
    for (const model of models) {
      const id = typeof model?.id === "string" ? model.id : "";
      if (!id || known.has(id)) continue;
      known.add(id);
      const option = document.createElement("option");
      option.value = id;
      option.textContent = id;
      select.appendChild(option);
    }

    const current = typeof value === "string" ? value : "";
    if (current && !known.has(current)) {
      const extra = document.createElement("option");
      extra.value = current;
      extra.textContent = isModelSelectorAvailable(current, models, rolesById())
        ? current
        : `⚠ ${current} (${t("models.notInList")})`;
      select.appendChild(extra);
    }

    select.value = current;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  function buildThinkingSelect({ value, ariaLabel, onChange }) {
    const select = document.createElement("select");
    select.className = "settings-select mr-select";
    if (ariaLabel) select.setAttribute("aria-label", ariaLabel);

    const raw = typeof value === "string" ? value : "";
    const options =
      Array.isArray(config?.thinkingLevelOptions) && config.thinkingLevelOptions.length > 0
        ? config.thinkingLevelOptions.map(String)
        : raw
          ? [raw]
          : [];
    if (!raw || !options.includes(raw)) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = t("models.notSet");
      select.appendChild(empty);
    }
    for (const level of options) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = thinkingLevelLabel(level);
      select.appendChild(option);
    }
    select.value = raw;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  // ── Section 1: main session (default model + thinking depth) ────────────

  function buildMainSession() {
    const section = document.createElement("div");
    section.className = "settings-section";
    section.appendChild(sectionTitle("models.mainSession"));

    const defaultRole = (Array.isArray(config?.roles) ? config.roles : []).find(
      (role) => role?.id === "default",
    );

    const modelRow = document.createElement("div");
    modelRow.className = "mr-row";
    modelRow.dataset.mrRow = "default-model";
    const modelLabel = document.createElement("span");
    modelLabel.className = "settings-label";
    modelLabel.textContent = t("models.defaultModel");
    modelRow.append(
      modelLabel,
      buildModelSelect({
        value: defaultRole?.current ?? "",
        emptyKey: "models.notSet",
        ariaLabel: t("models.defaultModel"),
        onChange: (value) => {
          void mutate(
            { type: "set_model_role", role: "default", selector: value || null },
            "default-model",
          );
        },
      }),
      statusEl("default-model"),
    );
    section.appendChild(modelRow);

    const thinkingRow = document.createElement("div");
    thinkingRow.className = "mr-row";
    thinkingRow.dataset.mrRow = "default-thinking";
    const thinkingLabel = document.createElement("span");
    thinkingLabel.className = "settings-label";
    thinkingLabel.textContent = t("models.defaultThinking");
    thinkingRow.append(
      thinkingLabel,
      buildThinkingSelect({
        value: config?.defaultThinkingLevel ?? "",
        ariaLabel: t("models.defaultThinking"),
        onChange: (level) => {
          void mutate({ type: "set_default_thinking_level", level }, "default-thinking");
        },
      }),
      statusEl("default-thinking"),
    );
    section.appendChild(thinkingRow);

    const hint = document.createElement("p");
    hint.className = "settings-help mr-hint";
    hint.textContent = t("models.defaultThinkingHint");
    section.appendChild(hint);
    return section;
  }

  // ── Section 2: model roles ──────────────────────────────────────────────

  function buildRoleRow(role) {
    const rowKey = `role:${role.id}`;
    const row = document.createElement("div");
    row.className = "mr-row";
    row.dataset.mrRow = rowKey;

    const label = document.createElement("span");
    label.className = "mr-row-label";
    const id = document.createElement("span");
    id.className = "mr-row-id";
    id.textContent = String(role.id);
    label.appendChild(id);
    if (isAdvisorRole(role.id)) {
      const hint = document.createElement("span");
      hint.className = "mr-row-hint";
      hint.textContent = t("models.advisorHint");
      label.appendChild(hint);
    }

    const select = buildModelSelect({
      value: role.current ?? "",
      emptyKey: "models.notSet",
      ariaLabel: `${t("models.modelRoles")}: ${role.id}`,
      onChange: (value) => {
        void mutate({ type: "set_model_role", role: role.id, selector: value || null }, rowKey);
      },
    });

    row.append(label, select);

    if (role.current) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "mr-clear";
      clear.textContent = "✕";
      const clearLabel = t("models.clearRole", { name: String(role.id) });
      clear.title = clearLabel;
      clear.setAttribute("aria-label", clearLabel);
      clear.addEventListener("click", () => {
        void mutate({ type: "set_model_role", role: role.id, selector: null }, rowKey);
      });
      row.appendChild(clear);
    }

    row.appendChild(statusEl(rowKey));
    return row;
  }

  function buildRoles() {
    const section = document.createElement("div");
    section.className = "settings-section";
    section.appendChild(sectionTitle("models.modelRoles"));
    const roles = Array.isArray(config?.roles) ? config.roles : [];
    for (const role of roles) {
      if (!role || typeof role.id !== "string" || role.id.length === 0) continue;
      section.appendChild(buildRoleRow(role));
    }
    return section;
  }

  // ── Section 3: task agents ──────────────────────────────────────────────

  function buildToggle(agent, rowKey) {
    const btn = document.createElement("button");
    btn.type = "button";
    const enabled = !agent.disabled;
    btn.className = `settings-toggle${enabled ? " on" : ""}`;
    btn.setAttribute("role", "switch");
    btn.setAttribute("aria-checked", String(enabled));
    btn.setAttribute(
      "aria-label",
      t(enabled ? "models.disableAgent" : "models.enableAgent", { name: String(agent.name ?? "") }),
    );
    btn.addEventListener("click", () => {
      const nowEnabled = !btn.classList.contains("on");
      btn.classList.toggle("on", nowEnabled);
      btn.setAttribute("aria-checked", String(nowEnabled));
      void mutate(
        { type: "set_task_agent_disabled", agent: agent.name, disabled: !nowEnabled },
        rowKey,
        {
          revert: () => {
            btn.classList.toggle("on", !nowEnabled);
            btn.setAttribute("aria-checked", String(!nowEnabled));
          },
        },
      );
    });
    return btn;
  }

  function buildAgentCard(agent) {
    const rowKey = `agent:${agent.name}`;
    const card = document.createElement("div");
    card.className = `mr-agent${agent.parseError ? " mr-agent-error" : ""}${
      agent.disabled ? " mr-agent-disabled" : ""
    }`;
    card.dataset.mrRow = rowKey;

    const head = document.createElement("div");
    head.className = "mr-agent-head";
    const name = document.createElement("span");
    name.className = "mr-agent-name";
    name.textContent = String(agent.name ?? "");
    head.appendChild(name);
    if (agent.source === "user" || agent.source === "project") {
      head.appendChild(
        badge(
          t(agent.source === "user" ? "models.sourceUser" : "models.sourceProject"),
          agent.path ? String(agent.path) : "",
        ),
      );
    }
    if (agent.disabled) {
      head.appendChild(badge(t("models.disabled"), "", "mr-badge-muted"));
    }
    head.appendChild(buildToggle(agent, rowKey));
    card.appendChild(head);

    if (agent.description) {
      const desc = document.createElement("div");
      desc.className = "mr-agent-desc";
      desc.textContent = String(agent.description);
      desc.title = String(agent.description);
      card.appendChild(desc);
    }

    if (agent.parseError) {
      const parse = document.createElement("div");
      parse.className = "mr-agent-parse";
      parse.textContent = `⚠ ${t("models.parseError")}`;
      parse.title = String(agent.parseError);
      card.appendChild(parse);
    }

    const meta = document.createElement("div");
    meta.className = "mr-agent-meta";
    if (agent.definitionModel || agent.definitionThinkingLevel) {
      meta.appendChild(chip(t("models.definitionValue"), "mr-chip-label"));
      if (agent.definitionModel) meta.appendChild(chip(String(agent.definitionModel)));
      if (agent.definitionThinkingLevel) {
        meta.appendChild(chip(thinkingLevelLabel(agent.definitionThinkingLevel)));
      }
    }

    const override = document.createElement("label");
    override.className = "mr-override";
    const overrideLabel = document.createElement("span");
    overrideLabel.className = "mr-override-label";
    overrideLabel.textContent = t("models.overrideModel");
    override.append(
      overrideLabel,
      buildModelSelect({
        value: agent.overrideModel ?? "",
        emptyKey: "models.noOverride",
        ariaLabel: `${agent.name}: ${t("models.overrideModel")}`,
        onChange: (value) => {
          void mutate(
            { type: "set_task_agent_model_override", agent: agent.name, model: value || null },
            rowKey,
          );
        },
      }),
    );
    meta.appendChild(override);
    meta.appendChild(statusEl(rowKey));
    card.appendChild(meta);
    return card;
  }

  function buildAgents() {
    const section = document.createElement("div");
    section.className = "settings-section";
    section.appendChild(sectionTitle("models.taskAgents"));
    const agents = Array.isArray(config?.taskAgents) ? config.taskAgents : [];
    if (agents.length === 0) {
      section.appendChild(noteEl("models.noTaskAgents"));
    }
    const list = document.createElement("div");
    list.className = "mr-agent-list";
    for (const agent of agents) {
      if (!agent || typeof agent.name !== "string" || agent.name.length === 0) continue;
      list.appendChild(buildAgentCard(agent));
    }
    section.appendChild(list);
    const foot = document.createElement("p");
    foot.className = "mr-footnote";
    foot.textContent = t("models.agentNote");
    section.appendChild(foot);
    return section;
  }

  // ── Unavailable-note silent retry ───────────────────────────────────────
  //
  // At most one retry in flight, only while the page is visible, and at most
  // UNAVAILABLE_RETRY_MAX per page-open so we never spin forever. A later
  // successful load renders real content and simply stops rescheduling; the
  // manual retry button (error path) and reopening the page stay available
  // regardless.

  function clearUnavailableRetry() {
    if (unavailableRetryTimer) {
      clearTimeout(unavailableRetryTimer);
      unavailableRetryTimer = null;
    }
  }

  function scheduleUnavailableRetry() {
    if (
      destroyed ||
      unavailableRetryTimer ||
      unavailableRetries >= UNAVAILABLE_RETRY_MAX ||
      document.visibilityState === "hidden"
    ) {
      return;
    }
    unavailableRetries += 1;
    unavailableRetryTimer = setTimeout(() => {
      unavailableRetryTimer = null;
      void refresh();
    }, UNAVAILABLE_RETRY_MS);
  }

  // ── Page states ─────────────────────────────────────────────────────────

  function errorLine() {
    const line = document.createElement("div");
    line.className = "mr-error";
    const text = document.createElement("span");
    text.textContent = t("models.loadFailed");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "settings-value-btn mr-retry";
    retry.textContent = t("models.retry");
    retry.addEventListener("click", () => {
      void refresh();
    });
    line.append(text, retry);
    return line;
  }

  function render() {
    pageEl.replaceChildren();
    // Never had a good load: loading note while in flight, error + retry when
    // the first fetch failed.
    if (!loaded) {
      pageEl.appendChild(loadFailed ? errorLine() : noteEl("models.loading"));
      return;
    }
    // Last-good content stays up with an error line above it (mcp pattern).
    if (loadFailed) pageEl.appendChild(errorLine());
    if (config?.available === false) {
      pageEl.appendChild(noteEl("models.unavailable"));
      scheduleUnavailableRetry();
      return;
    }
    pageEl.appendChild(buildMainSession());
    pageEl.appendChild(buildRoles());
    pageEl.appendChild(buildAgents());
    for (const rowKey of rowStatuses.keys()) paintRowStatus(rowKey);
  }

  function destroy() {
    destroyed = true;
    clearUnavailableRetry();
    unsubscribeLanguage();
    for (const entry of rowStatuses.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    rowStatuses.clear();
  }

  return { refresh, destroy };
}
