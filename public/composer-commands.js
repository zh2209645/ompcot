/**
 * Composer slash commands + delivery mode (queue vs steer).
 *
 * Two related composer behaviors live here:
 *
 * 1. Slash autocomplete (B5) — when the composer text starts with `/` and the
 *    caret is still inside that first whitespace-delimited token, a popup above
 *    the composer lists the agent's available commands. Commands come from the
 *    `{type:"list_commands"}` RPC over the existing WebSocket client; the
 *    response envelope is `{ commands: [{name, description?, source?}],
 *    available: boolean }`. Results are cached for the window session and
 *    refetched on a later open when the cache came back empty. If the RPC
 *    fails or reports `available:false`, the popup simply never appears —
 *    sending still passes the raw text through, so omp can handle it itself.
 *
 * 2. Delivery mode (A2) — while the agent is streaming, a plain message can
 *    either wait (Queue, the default — delivered as a follow-up when idle) or
 *    interrupt the current run (Steer now → `{type:"steer", message}`).
 *    Slash commands are the exception: the server rejects steered slash
 *    commands, so they always queue, and if that rejection ever comes back we
 *    auto-queue the message instead of surfacing an error.
 *
 * The factory owns the popup and toggle DOM; app.js keeps only wiring (it
 * supplies callbacks for the queue list and submit path).
 */

import { onLanguageChanged, t } from "./i18n.js";

/** Exact error the server returns when a slash command is steered mid-run. */
export const SLASH_STREAM_REJECTION =
  "Slash command cannot run while the agent is streaming; it will be queued and delivered when idle";

/** True when `text` is the server's slash-while-streaming rejection. */
export function isSlashStreamRejection(text) {
  return typeof text === "string" && text.trim() === SLASH_STREAM_REJECTION;
}

/** True when a (trimmed) message is a slash command for the agent to execute. */
export function isSlashCommand(message) {
  return typeof message === "string" && message.trimStart().startsWith("/");
}

/**
 * Slash-popup context for the current composer state. Returns null when the
 * popup must not appear: text does not start with `/`, or the caret has moved
 * past the first whitespace-delimited token (i.e. the user is typing args).
 */
export function resolveSlashContext(value, caret) {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  const wsMatch = /\s/.exec(value);
  const tokenEnd = wsMatch ? wsMatch.index : value.length;
  const caretPos = typeof caret === "number" ? caret : value.length;
  if (caretPos > tokenEnd) return null;
  return { token: value.slice(0, tokenEnd), tokenEnd };
}

function commandName(cmd) {
  return String(cmd?.name ? cmd.name : "").replace(/^\//, "");
}

/** Case-insensitive prefix filter of `commands` against a `/token`. */
export function filterSlashCommands(commands, token) {
  const prefix = String(token || "")
    .replace(/^\//, "")
    .toLowerCase();
  return (Array.isArray(commands) ? commands : []).filter((cmd) =>
    commandName(cmd).toLowerCase().startsWith(prefix),
  );
}

/**
 * Where should this message go? Idle → send now. Streaming → slash commands
 * always queue (steered slash commands are rejected server-side); plain
 * messages follow the delivery toggle.
 */
export function resolveDelivery({ message, isStreaming, deliveryMode }) {
  if (!isStreaming) return "send";
  if (isSlashCommand(message)) return "queue";
  return deliveryMode === "steer" ? "steer" : "queue";
}

// When a steer is not confirmed (delivered, rejected, or timed out) within
// this window, stop offering it for rejection recovery — mirrors the
// in-flight prompt expiry in app.js.
const STEER_EXPIRY_MS = 8000;

// After a failed/empty list_commands response, wait this long before asking
// again on the next popup open (avoids hammering the RPC while typing).
const EMPTY_REFETCH_THROTTLE_MS = 5000;

const LIST_COMMANDS_TIMEOUT_MS = 4000;

/**
 * Queued-strip model (F15): genuinely pending commands (queue / slash) live
 * in `pending` and are flushed one-by-one when the agent idles. A Steer-now
 * send is delivered IMMEDIATELY over its own RPC, so its strip chip is a
 * visual-only echo that must never be flushed — flushing it would re-send an
 * already-delivered message.
 *
 * @returns {{ queuePrompt, addSteerEcho, removeSteerEcho, clear, remove,
 *   takeFlushable, snapshot, flushableCount, isEmpty }}
 */
export function createComposerQueue() {
  const pending = []; // flushable { type:"prompt", message, kind, images? }
  const steerEchoes = []; // visual-only message strings

  return {
    /** Queue a genuinely pending prompt for idle delivery. */
    queuePrompt(message, { kind = "queue", images } = {}) {
      const item = { type: "prompt", message, kind };
      if (images && images.length > 0) item.images = images;
      pending.push(item);
    },
    /** Mirror an already-delivered steer in the strip (visual only). */
    addSteerEcho(message) {
      steerEchoes.push(message);
    },
    /** Drop the echo once its user message lands in the transcript.
     *  Returns true when an echo was actually removed. */
    removeSteerEcho(message) {
      const idx = steerEchoes.indexOf(message);
      if (idx === -1) return false;
      steerEchoes.splice(idx, 1);
      return true;
    },
    clear() {
      pending.length = 0;
      steerEchoes.length = 0;
    },
    /** Cancel / promote a pending item (identity-based, from snapshot()). */
    remove(item) {
      const idx = pending.indexOf(item);
      if (idx !== -1) pending.splice(idx, 1);
    },
    /** Pop the oldest flushable command, or null when none are pending. */
    takeFlushable() {
      return pending.shift() || null;
    },
    /** Render model: interactive pending items, then non-interactive echoes. */
    snapshot() {
      return [
        ...pending.map((item) => ({
          item,
          message: item.message,
          kind: item.kind || "queue",
          flushable: true,
        })),
        ...steerEchoes.map((message) => ({
          item: null,
          message,
          kind: "steer",
          flushable: false,
        })),
      ];
    },
    get flushableCount() {
      return pending.length;
    },
    get isEmpty() {
      return pending.length === 0 && steerEchoes.length === 0;
    },
  };
}

/**
 * Creates the slash-command popup + delivery toggle and returns the small
 * surface app.js wires into its composer listeners.
 *
 * @param {object} deps
 * @param {HTMLTextAreaElement} deps.input          #message-input
 * @param {EventTarget} deps.wsClient               WebSocket client (send + commandResponse events)
 * @param {() => boolean} [deps.isStreaming]
 * @param {() => void} [deps.onSubmit]              exact-match Enter → normal submit path
 * @param {(message: string) => void} [deps.queueSlash]        queue a slash command for idle delivery
 * @param {(message: string) => void} [deps.showSteerQueued]   reflect a sent steer in the queue area
 * @param {HTMLElement} [deps.toggleEl]             .delivery-toggle container (Queue / Steer now)
 */
export function createComposerCommands(deps) {
  const {
    input,
    wsClient,
    isStreaming = () => false,
    onSubmit = () => {},
    queueSlash = () => {},
    showSteerQueued = () => {},
    toggleEl = null,
  } = deps;

  // ── Slash popup ────────────────────────────────────────────────────────

  const container = input.closest ? input.closest(".composer-card") : null;
  const anchor = container || input.parentElement;
  const menu = document.createElement("div");
  menu.className = "slash-menu hidden";
  anchor.appendChild(menu);

  let context = null; // active resolveSlashContext result while the popup is open
  let filtered = [];
  let activeIndex = 0;

  let commandsCache = null; // last good { commands, available }
  let inFlight = null;
  let emptyUntil = 0;

  function normalizeCommandResponse(detail) {
    // Success envelope: data = { commands: [...], available: boolean }.
    // Accept `data`/`result` wrappers so minor server-side reshapes stay safe.
    const body = (detail && (detail.data || detail.result)) || detail || {};
    const commands = Array.isArray(body.commands) ? body.commands : [];
    const available = body.available !== false && commands.length > 0;
    return { commands, available };
  }

  function requestCommands() {
    return new Promise((resolve) => {
      let requestId = null;
      try {
        requestId = wsClient.send({ type: "list_commands" });
      } catch (err) {
        console.error("[Composer] list_commands failed:", err);
      }
      if (!requestId) {
        resolve({ commands: [], available: false });
        return;
      }
      const timer = setTimeout(finish, LIST_COMMANDS_TIMEOUT_MS);
      function finish(response) {
        clearTimeout(timer);
        wsClient.removeEventListener("commandResponse", onResponse);
        resolve(response || { commands: [], available: false });
      }
      function onResponse(event) {
        const detail = event.detail || {};
        // The embedded server / broker mirrors the requestId back as `id` —
        // accept both spellings so correlation survives either hop (F13).
        const replyId = detail.requestId ?? detail.id;
        if (replyId !== requestId) return;
        finish(normalizeCommandResponse(detail));
      }
      wsClient.addEventListener("commandResponse", onResponse);
    });
  }

  function loadCommands({ force = false } = {}) {
    if (commandsCache?.available) return Promise.resolve(commandsCache);
    if (!force && Date.now() < emptyUntil) {
      return Promise.resolve({ commands: [], available: false });
    }
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => requestCommands())
      .then((result) => {
        inFlight = null;
        if (result.available) {
          commandsCache = result;
        } else {
          emptyUntil = Date.now() + EMPTY_REFETCH_THROTTLE_MS;
        }
        return result;
      })
      .catch((err) => {
        inFlight = null;
        emptyUntil = Date.now() + EMPTY_REFETCH_THROTTLE_MS;
        console.error("[Composer] list_commands failed:", err);
        return { commands: [], available: false };
      });
    return inFlight;
  }

  function isPopupOpen() {
    return !menu.classList.contains("hidden");
  }

  function closePopup() {
    context = null;
    filtered = [];
    activeIndex = 0;
    menu.innerHTML = "";
    menu.classList.add("hidden");
  }

  function renderPopup() {
    menu.innerHTML = "";
    const header = document.createElement("div");
    header.className = "slash-menu-header";
    header.textContent = t("slash.commands");
    menu.appendChild(header);

    filtered.forEach((cmd, i) => {
      const row = document.createElement("div");
      row.className = `slash-menu-item${i === activeIndex ? " active" : ""}`;
      const name = document.createElement("span");
      name.className = "slash-menu-name";
      name.textContent = `/${commandName(cmd)}`;
      const description = document.createElement("span");
      description.className = "slash-menu-desc";
      description.textContent = cmd?.description || "";
      row.appendChild(name);
      row.appendChild(description);
      if (cmd?.source) {
        const badge = document.createElement("span");
        badge.className = "slash-menu-source";
        badge.textContent = String(cmd.source);
        row.appendChild(badge);
      }
      // Keep focus in the textarea so completion can set the caret.
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", () => completeCommand(commandName(cmd)));
      menu.appendChild(row);
    });

    menu.classList.remove("hidden");
  }

  function updateActiveRow() {
    const rows = menu.querySelectorAll(".slash-menu-item");
    rows.forEach((row, i) => {
      row.classList.toggle("active", i === activeIndex);
    });
    const row = rows[activeIndex];
    if (row && typeof row.scrollIntoView === "function") {
      try {
        row.scrollIntoView({ block: "nearest" });
      } catch {
        // jsdom and older WebViews — visible-area scrolling is best-effort
      }
    }
  }

  function completeCommand(name) {
    const ctx = context || resolveSlashContext(input.value, input.selectionStart);
    if (!name || !ctx) {
      closePopup();
      return;
    }
    const rest = input.value.slice(ctx.tokenEnd);
    input.value = `/${name} ${rest}`;
    const caret = name.length + 2; // after "/name "
    input.setSelectionRange(caret, caret);
    closePopup();
    renderToggle();
  }

  function isExactMatch(cmd) {
    if (!cmd || !context) return false;
    if (context.token.toLowerCase() !== `/${commandName(cmd).toLowerCase()}`) return false;
    // No args typed after the command → Enter can submit it immediately.
    return input.value.slice(context.tokenEnd).trim() === "";
  }

  async function refreshPopup() {
    const opening = !isPopupOpen();
    context = resolveSlashContext(input.value, input.selectionStart);
    if (!context) {
      closePopup();
      return;
    }
    const result = await loadCommands({ force: opening });
    // The user may have kept typing while the RPC was in flight.
    context = resolveSlashContext(input.value, input.selectionStart);
    if (!context || !result.available) {
      closePopup();
      return;
    }
    filtered = filterSlashCommands(result.commands, context.token);
    if (filtered.length === 0) {
      closePopup();
      return;
    }
    activeIndex = 0;
    renderPopup();
  }

  /**
   * Composer keydown pre-handler. Returns true when the key was consumed and
   * the caller must skip its own Enter-send handling. Only hijacks keys while
   * the popup is open; Enter with the popup closed falls through untouched.
   */
  function handleKeydown(e) {
    if (e.isComposing || e.keyCode === 229) return false;

    if (isPopupOpen()) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length > 0) {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          activeIndex = (activeIndex + delta + filtered.length) % filtered.length;
          updateActiveRow();
        }
        return true;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        completeCommand(commandName(filtered[activeIndex]));
        return true;
      }
      if (e.key === "Enter") {
        if (isExactMatch(filtered[activeIndex])) {
          // `/cmd` with no args → submit straight away via the normal path.
          // Prevent the default so no stray newline lands in the textarea.
          e.preventDefault();
          closePopup();
          onSubmit();
          return true;
        }
        e.preventDefault();
        completeCommand(commandName(filtered[activeIndex]));
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Stop the document-level Esc handler (abort stream, close panels).
        e.stopPropagation();
        closePopup();
        return true;
      }
    }
    return false;
  }

  // ── Delivery mode (queue vs steer) ─────────────────────────────────────

  let deliveryMode = "queue";
  const pendingSteers = new Map(); // requestId → { message, timer }

  function toggleVisible() {
    const value = input.value.trim();
    // Only relevant mid-run, with text that is not a slash command (those
    // always queue — steered slash commands are rejected server-side).
    return isStreaming() && value.length > 0 && !isSlashCommand(value);
  }

  function renderToggle() {
    if (!toggleEl) return;
    // Reset to the Queue default whenever the toggle hides — each streaming
    // episode starts conservative.
    if (!toggleVisible()) deliveryMode = "queue";
    toggleEl.classList.toggle("hidden", !toggleVisible());
    toggleEl.setAttribute("aria-label", t("slash.deliveryLabel"));
    toggleEl.title = t("slash.toggleTitle");
    for (const btn of toggleEl.querySelectorAll(".delivery-option")) {
      const active = btn.dataset.mode === deliveryMode;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-checked", String(active));
    }
  }

  function getDeliveryMode() {
    return deliveryMode;
  }

  /**
   * Begin a send: reads the message and resolves its delivery decision
   * BEFORE clearing the input and refreshing the controls. refresh() hides
   * the toggle and resets the mode back to "queue", so reading the mode
   * after the reset would silently downgrade a Steer-now send to Queue
   * (F14). Returns `{ message, delivery }`, or null when there is nothing
   * to send.
   */
  function beginSend() {
    const message = input.value.trim();
    if (!message) return null;
    const delivery = resolveDelivery({
      message,
      isStreaming: isStreaming(),
      deliveryMode,
    });
    input.value = "";
    input.style.height = "auto";
    refreshPopup();
    renderToggle();
    return { message, delivery };
  }

  function setDeliveryMode(mode) {
    deliveryMode = mode === "steer" ? "steer" : "queue";
    renderToggle();
  }

  /**
   * Sends `{type:"steer", message}` immediately and mirrors it in the queued
   * strip with a "steering" tone. The requestId is tracked briefly so a
   * slash-command rejection can be recovered into the queue (see
   * consumeStreamRejection).
   */
  function sendSteerNow(message) {
    let requestId = null;
    try {
      requestId = wsClient.send({ type: "steer", message });
    } catch (err) {
      console.error("[Composer] steer failed:", err);
    }
    if (requestId) {
      const timer = setTimeout(() => pendingSteers.delete(requestId), STEER_EXPIRY_MS);
      pendingSteers.set(requestId, { message, timer });
    }
    showSteerQueued(message);
    return requestId;
  }

  /**
   * Called with server error text. When it is the slash-while-streaming
   * rejection for a steer we just sent, convert that message back into a
   * queued follow-up and swallow the error. Returns true when handled.
   */
  function consumeStreamRejection(errorText) {
    if (!isSlashStreamRejection(errorText)) return false;
    for (const [requestId, entry] of pendingSteers) {
      if (!isSlashCommand(entry.message)) continue;
      clearTimeout(entry.timer);
      pendingSteers.delete(requestId);
      queueSlash(entry.message);
      return true;
    }
    return false;
  }

  // ── Shared wiring ──────────────────────────────────────────────────────

  if (toggleEl) {
    for (const btn of toggleEl.querySelectorAll(".delivery-option")) {
      btn.addEventListener("click", () => setDeliveryMode(btn.dataset.mode));
    }
  }

  input.addEventListener("input", () => {
    refreshPopup();
    renderToggle();
  });

  function onDocumentClick(e) {
    if (isPopupOpen() && anchor.contains && !anchor.contains(e.target)) closePopup();
  }
  document.addEventListener("click", onDocumentClick);

  const unsubscribeLanguage = onLanguageChanged(() => {
    renderToggle();
    if (isPopupOpen()) renderPopup();
  });

  renderToggle();

  return {
    handleKeydown,
    refresh: () => {
      refreshPopup();
      renderToggle();
    },
    closePopup,
    isPopupOpen,
    getDeliveryMode,
    setDeliveryMode,
    beginSend,
    sendSteerNow,
    consumeStreamRejection,
    destroy: () => {
      unsubscribeLanguage();
      document.removeEventListener("click", onDocumentClick);
    },
  };
}
