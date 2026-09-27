// Agent Hub (right-docked roster panel, mirrors the file browser sidebar).
//
// Shows the workspace's agent roster from the `list_agents` RPC:
// `{agents: [{id, name, kind, parentId, status, running, sessionFile}],
// available}`. The header toggle button stays hidden until the first
// successful fetch reports a non-empty roster, so windows without subagent
// tracking carry zero extra chrome.
//
// Freshness: refetch on panel open, on the `agents_changed` push event, and
// every 10s while open (interval cleared on close). Push events are observed
// on every shape the transport may deliver them in — an rpcEvent whose detail
// type is `agents_changed`, a direct `agentsChanged` custom event, or a
// brokerEvent payload — without owning the WebSocket client's dispatch table.
//
// "View transcript" reuses the app's existing session-selection flow via the
// `onOpenSession(sessionFile)` callback; this module never renders transcripts
// itself.

import { onLanguageChanged, t } from "./i18n.js";
import { wsRpc } from "./ws-rpc.js";

const DEFAULT_POLL_MS = 10000;

/** True when a roster entry should render in the live (running) group. */
function isRunning(agent) {
  return agent?.running === true;
}

function rosterOf(data) {
  const body = data && typeof data === "object" ? data : {};
  return Array.isArray(body.agents) ? body.agents.filter((agent) => agent?.name) : [];
}

export function createAgentHub({
  toggleEl,
  panelEl,
  listEl,
  closeEl,
  wsClient,
  onOpenSession = null,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  if (!panelEl || !listEl) {
    return { refresh: async () => {}, open: () => {}, close: () => {}, destroy: () => {} };
  }

  // Panel content state: "loading" | "ready" | "empty" | "unavailable" | "error".
  let contentState = "loading";
  let agents = [];
  let fetchSeq = 0; // latest fetch wins; stale responses are dropped
  let pollTimer = null;
  let destroyed = false;
  // Signature of what the DOM currently shows (see `structureSignature` /
  // `statusSignature`): the poll refetches every 10 s while the panel is open
  // and the roster is usually identical, and rebuilding the rows anyway tore
  // down and re-created every status label (with its pulsing dot) on each
  // tick, which read as a flicker.
  let renderedStructure = null;
  let renderedStatuses = null;
  // Rows by agent id, so a status-only change updates the label in place
  // instead of rebuilding the list.
  const rowEls = new Map();

  const unsubscribeLanguage = onLanguageChanged(() => {
    // Labels (group headers, kind, status title) are translated at render
    // time, so a language switch must rebuild even though the roster did not
    // change.
    if (isOpen()) render({ force: true });
  });

  // ── Open / close ────────────────────────────────────────────────────────

  function isOpen() {
    return !panelEl.classList.contains("collapsed");
  }

  function syncToggle() {
    if (!toggleEl) return;
    // The toggle only exists while the roster has something to show; while the
    // panel is open it stays visible so the user can always close it again.
    const reveal = isOpen() || (contentState === "ready" && agents.length > 0);
    toggleEl.classList.toggle("hidden", !reveal);
    toggleEl.setAttribute("aria-expanded", String(isOpen()));
  }

  function open() {
    if (destroyed || isOpen()) return;
    panelEl.classList.remove("collapsed");
    syncToggle();
    render();
    void refresh();
    startPolling();
  }

  function close() {
    if (!isOpen()) return;
    panelEl.classList.add("collapsed");
    stopPolling();
    syncToggle();
  }

  function toggle() {
    if (isOpen()) close();
    else open();
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      void refresh();
    }, pollMs);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // ── Data ────────────────────────────────────────────────────────────────

  async function refresh() {
    if (destroyed) return;
    const seq = ++fetchSeq;
    // No render before the response: it could only repaint the previous state
    // (and flashed "Loading…" for an empty roster on every poll). The panel
    // repaints below, and only when the roster actually changed.
    const result = await wsRpc(wsClient, { type: "list_agents" });
    if (destroyed || seq !== fetchSeq) return;
    if (!result.ok) {
      contentState = "error";
    } else {
      const available = result.data?.available !== false;
      agents = rosterOf(result.data);
      contentState = available ? (agents.length > 0 ? "ready" : "empty") : "unavailable";
    }
    syncToggle();
    if (isOpen()) render();
  }

  // ── Rendering ───────────────────────────────────────────────────────────

  /**
   * Everything the DOM shows except the status text: content state plus each
   * row's identity, grouping and whether it is running. Only a change here
   * requires rebuilding rows.
   */
  function structureSignature() {
    return JSON.stringify([
      contentState,
      agents.map((agent) => [
        agent.id ?? agent.name,
        String(agent.name),
        agent.kind === "main" ? "main" : "sub",
        isRunning(agent),
        agent.sessionFile ?? null,
        typeof onOpenSession === "function" && Boolean(agent.sessionFile),
      ]),
    ]);
  }

  /** Status labels as currently reported by the roster. */
  function statusSignature() {
    return JSON.stringify(agents.map((agent) => [agent.id ?? agent.name, agent.status ?? null]));
  }

  function note(text) {
    const el = document.createElement("div");
    el.className = "agent-hub-note";
    el.textContent = text;
    return el;
  }

  function groupLabel(text) {
    const el = document.createElement("div");
    el.className = "agent-hub-group";
    el.textContent = text;
    return el;
  }

  function row(agent) {
    const running = isRunning(agent);
    const el = document.createElement("div");
    el.className = `agent-hub-row ${running ? "running" : "finished"}`;

    const top = document.createElement("div");
    top.className = "agent-hub-row-top";
    const dot = document.createElement("span");
    dot.className = "agent-hub-dot";
    dot.setAttribute("aria-hidden", "true");
    const kind = document.createElement("span");
    kind.className = `agent-hub-kind ${agent.kind === "main" ? "main" : "sub"}`;
    kind.textContent = t(agent.kind === "main" ? "agents.kindMain" : "agents.kindSub");
    const name = document.createElement("span");
    name.className = "agent-hub-name";
    name.textContent = String(agent.name);
    name.title = String(agent.name);
    top.append(dot, kind, name);

    const bottom = document.createElement("div");
    bottom.className = "agent-hub-row-bottom";
    const status = document.createElement("span");
    status.className = "agent-hub-status";
    setStatusLabel(status, agent.status);
    bottom.append(status);

    if (agent.sessionFile && typeof onOpenSession === "function") {
      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "agent-hub-open";
      openBtn.textContent = t("agents.viewTranscript");
      openBtn.addEventListener("click", () => onOpenSession(agent.sessionFile));
      bottom.append(openBtn);
    }

    el.append(top, bottom);
    rowEls.set(agent.id ?? agent.name, status);
    return el;
  }

  /** Write a roster status only when it differs from what the label shows. */
  function setStatusLabel(statusEl, status) {
    const statusText = status == null ? "" : String(status);
    if (statusEl.textContent === statusText) return;
    statusEl.textContent = statusText;
    statusEl.title = `${t("agents.status")}: ${statusText}`;
  }

  function render({ force = false } = {}) {
    const structure = structureSignature();
    // Same rows: refresh only the status labels that actually changed, so the
    // poll never tears down a row (and with it the pulsing live dot) for an
    // unchanged roster.
    if (!force && structure === renderedStructure && renderedStructure !== null) {
      const statuses = statusSignature();
      if (statuses === renderedStatuses) return;
      renderedStatuses = statuses;
      for (const agent of agents) {
        const statusEl = rowEls.get(agent.id ?? agent.name);
        if (statusEl) setStatusLabel(statusEl, agent.status);
      }
      return;
    }

    rowEls.clear();
    listEl.replaceChildren();
    renderedStructure = structure;
    renderedStatuses = statusSignature();

    if (contentState === "unavailable") {
      listEl.append(note(t("agents.unavailable")));
      return;
    }
    if (contentState === "error") {
      listEl.append(note(t("agents.loadFailed")));
      return;
    }
    if (contentState === "loading") {
      listEl.append(note(t("common.loading")));
      return;
    }
    if (agents.length === 0) {
      listEl.append(note(t("agents.empty")));
      return;
    }

    const running = agents.filter(isRunning);
    const finished = agents.filter((agent) => !isRunning(agent));
    if (running.length > 0) {
      listEl.append(groupLabel(t("agents.groupRunning")));
      for (const agent of running) listEl.append(row(agent));
    }
    if (finished.length > 0) {
      listEl.append(groupLabel(t("agents.groupFinished")));
      for (const agent of finished) listEl.append(row(agent));
    }
  }

  // ── Push events ─────────────────────────────────────────────────────────

  function onPushEvent() {
    void refresh();
  }
  function onRpcEvent(event) {
    if (event.detail?.type === "agents_changed") onPushEvent();
  }
  function onBrokerEvent(event) {
    if (event.detail?.payload?.type === "agents_changed") onPushEvent();
  }

  // Esc closes the panel ahead of the app-level shortcuts (abort stream, …).
  // Captured on window so it wins over app.js's document-level handler; the
  // higher chrome layers (settings, palette, dropdown, dialogs) still get Esc
  // first, mirroring app.js's own ordering.
  function onWindowKeydownCapture(event) {
    if (event.key !== "Escape" || !isOpen()) return;
    const higherLayerOpen = ["#settings-panel", "#command-palette", "#model-dropdown-menu"].some(
      (selector) => !document.querySelector(selector)?.classList.contains("hidden"),
    );
    if (higherLayerOpen || document.querySelector("#dialog-container")?.childElementCount > 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    close();
    toggleEl?.focus?.();
  }

  if (toggleEl) {
    toggleEl.addEventListener("click", toggle);
    toggleEl.setAttribute("aria-controls", panelEl.id || "agent-hub");
  }
  closeEl?.addEventListener("click", close);
  wsClient?.addEventListener?.("rpcEvent", onRpcEvent);
  wsClient?.addEventListener?.("agentsChanged", onPushEvent);
  wsClient?.addEventListener?.("brokerEvent", onBrokerEvent);
  wsClient?.addEventListener?.("connected", onPushEvent);
  window.addEventListener("keydown", onWindowKeydownCapture, true);

  syncToggle();

  return {
    refresh,
    open,
    close,
    toggle,
    isOpen,
    destroy: () => {
      destroyed = true;
      stopPolling();
      unsubscribeLanguage();
      wsClient?.removeEventListener?.("rpcEvent", onRpcEvent);
      wsClient?.removeEventListener?.("agentsChanged", onPushEvent);
      wsClient?.removeEventListener?.("brokerEvent", onBrokerEvent);
      wsClient?.removeEventListener?.("connected", onPushEvent);
      window.removeEventListener("keydown", onWindowKeydownCapture, true);
    },
  };
}
