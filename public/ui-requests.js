// Server-driven UI surfaces, in two parts:
//
// 1. Extension UI request dialogs (B4). The embedded server asks the UI to
//    show a modal — `extension_ui_request` events with method
//    select/confirm/input (editor + notify kept for older extensions). This
//    module is the single path for those events: it reuses the DialogHandler
//    primitives from dialogs.js for the visuals and adds what the frozen
//    server contract needs on top:
//
//      - one dialog at a time; extra requests queue FIFO and replay in order
//      - replies go out as `ui_response` / `ui_cancel` over ws-rpc:
//        select → {value: string|undefined}, confirm → {value: boolean},
//        input → {value: string|undefined}. Dismissing without a choice
//        counts as cancel and sends `ui_cancel`.
//      - deadlines come from the server's absolute `expiresAt` (epoch ms)
//        when present, so a request that queued behind another dialog keeps
//        its true deadline; the relative `timeout` field is the compat
//        fallback and starts its window when the dialog is shown.
//      - expiry protocol (F4/F5): the server resolves expired requests at
//        their `expiresAt` and treats them as already settled — a late
//        `ui_response` only earns a server-side error. On a frontend-observed
//        expiry the dialog is therefore dismissed locally and a best-effort
//        `ui_cancel {id}` goes out (the server ignores it when settled).
//        Requests already expired when dequeued are discarded silently
//        (nothing shown, nothing sent), and an incoming
//        `{method:"cancel", id}` frame — the server telling us a request died
//        (timeout/abort/teardown) — dismisses the active dialog or drops the
//        queued request, again with no reply.
//      - `timeout` is honored with a subtle countdown; at the deadline the
//        request auto-cancels
//      - keyboard access: Esc cancels, select options are tabbable and
//        Enter/Space-activatable, focus lands on the first control
//
// 2. Fork from message (B7). A hover action next to the copy button on
//    assistant messages ("Fork from here") plus the "Fork from latest"
//    palette command. Both send `{type:"fork_session", entryId}` — the entry
//    id comes from the message element's `data-message-id` when it carries a
//    real id (streaming placeholders and history renders without ids simply
//    omit it, which the server treats as "fork from the latest entry").

import { DialogHandler } from "./dialogs.js";
import { onLanguageChanged, t } from "./i18n.js";
import { wsRpc } from "./ws-rpc.js";

/** Methods the manager knows how to render; anything else warns and drops. */
const KNOWN_METHODS = new Set(["select", "confirm", "input", "editor", "notify"]);

/** How long we wait for the server to ack a ui_response / ui_cancel. */
const UI_RESPONSE_TIMEOUT_MS = 4000;

/** Translate a DialogHandler response shape into the wire `value`. */
function valueFromResponse(response, method) {
  if (!response) return method === "confirm" ? false : undefined;
  if (response.confirmed !== undefined) return response.confirmed === true;
  if (response.value !== undefined) return response.value;
  return method === "confirm" ? false : undefined;
}

/**
 * Absolute epoch-ms deadline for a request, or 0 when it has none (F5).
 *
 * The server stamps every request with `expiresAt` (absolute epoch ms) so
 * the deadline is meaningful no matter how long the request queued behind
 * other dialogs — the frontend must never restart the window at dequeue
 * time. Older servers only send the relative `timeout`; for those the
 * window starts when the dialog is shown (compat fallback).
 */
function deadlineFor(request, now = Date.now()) {
  const expiresAt = Number(request?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) return expiresAt;
  const timeout = Number(request?.timeout);
  if (Number.isFinite(timeout) && timeout > 0) return now + timeout;
  return 0;
}

/** True when a request's absolute `expiresAt` is already in the past (F5). */
function requestExpired(request, now = Date.now()) {
  const expiresAt = Number(request?.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now;
}

/**
 * One live dialog. Extends DialogHandler so every visual (titles, options,
 * buttons, i18n'd fallbacks) comes from the shared primitives; only the
 * response channel, the deadline countdown and the keyboard handling are
 * added here.
 */
class UIRequestDialogHandler extends DialogHandler {
  constructor(container, wsClient, request, onDone) {
    super(container, wsClient);
    this.request = request;
    this.onDone = onDone;
    this.deadline = 0;
    this.totalMs = null;
    this.countdownInterval = null;
    this.countdownText = null;
    this.countdownFill = null;
    this.onKeyDown = null;
  }

  /** Render the dialog for this request. `preserveValue` restores typed text. */
  render(preserveValue = "") {
    const request = this.request;
    switch (request.method) {
      case "select":
        this.showSelect(request);
        break;
      case "confirm":
        this.showConfirm(request);
        break;
      case "input":
        this.showInput(request);
        if (preserveValue) {
          const input = this.currentDialog?.querySelector(".dialog-input");
          if (input) input.value = preserveValue;
        }
        break;
      case "editor":
        this.showEditor(request);
        if (preserveValue) {
          const textarea = this.currentDialog?.querySelector(".dialog-textarea");
          if (textarea) textarea.value = preserveValue;
        }
        break;
      default:
        this.onDone();
        return;
    }
    this.enhanceDialog();
  }

  /**
   * The base class arms its own silent timeout, which would fire a user-style
   * cancel. Deadline handling is ours (see startDeadline) — always neutralize
   * the base timer.
   */
  showDialog(dialogElement, _timeout, requestId) {
    super.showDialog(dialogElement, 0, requestId);
  }

  /**
   * Deadline + countdown. Called after render (and again after a language
   * re-render, passing the remaining time so the deadline survives).
   *
   * F5: without an explicit `remainingMs` the deadline derives from the
   * server's absolute `expiresAt` when present, so a request that queued
   * behind another dialog keeps its true deadline instead of getting a
   * fresh local window; the relative `timeout` remains the compat fallback.
   */
  startDeadline(remainingMs = null) {
    const now = Date.now();
    const deadline = Number.isFinite(remainingMs)
      ? now + Math.max(0, remainingMs)
      : deadlineFor(this.request, now);
    if (!deadline) return;
    this.deadline = deadline;

    // Total window for the progress bar: the declared `timeout` when the
    // server sent one, else the remaining time at first paint (the bar then
    // starts full and drains from there). Kept for the handler's lifetime so
    // language re-renders don't rescale it.
    if (!Number.isFinite(this.totalMs) || this.totalMs <= 0) {
      const timeout = Number(this.request.timeout);
      this.totalMs =
        Number.isFinite(timeout) && timeout > 0 ? timeout : Math.max(1, deadline - now);
    }

    const bar = document.createElement("div");
    bar.className = "dialog-countdown";
    bar.innerHTML =
      '<span class="dialog-countdown-text"></span>' +
      '<span class="dialog-countdown-bar"><span class="dialog-countdown-fill"></span></span>';
    this.currentDialog?.appendChild(bar);
    this.countdownText = bar.querySelector(".dialog-countdown-text");
    this.countdownFill = bar.querySelector(".dialog-countdown-fill");
    this.updateCountdown(this.deadline - now, this.totalMs);

    this.countdownInterval = setInterval(() => {
      const left = this.deadline - Date.now();
      if (left <= 0) {
        this.autoCancel();
        return;
      }
      this.updateCountdown(left, this.totalMs);
    }, 1000);
  }

  /**
   * Seconds display uses ceil(): an honest upper bound, so the label never
   * reads 0s while the dialog is still live (the 0s case is auto-cancelled
   * before it could render).
   */
  updateCountdown(remainingMs, totalMs) {
    if (!this.countdownText) return;
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    this.countdownText.textContent = t("uiRequest.autoCancelIn", { seconds });
    if (this.countdownFill) {
      const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
      this.countdownFill.style.width = `${pct}%`;
    }
  }

  /** Modal niceties: aria, Esc-to-cancel, keyboard-activatable options. */
  enhanceDialog() {
    const dialog = this.currentDialog;
    if (!dialog) return;
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    const title = typeof this.request.title === "string" ? this.request.title : "";
    if (title) dialog.setAttribute("aria-label", title);

    for (const option of dialog.querySelectorAll(".dialog-option")) {
      option.tabIndex = 0;
      option.setAttribute("role", "button");
      option.setAttribute("aria-label", option.textContent || "");
      option.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          option.click();
        }
      });
    }

    this.onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.respond(this.request.id, { cancelled: true });
    };
    // Capture phase so the dialog consumes Esc before the app-level handler
    // (abort stream / close panels) can act on it.
    document.addEventListener("keydown", this.onKeyDown, true);

    const first = dialog.querySelector(".dialog-option") || dialog.querySelector("button");
    if (first) setTimeout(() => first.focus(), 50);
  }

  /**
   * Deadline hit — the client observed the expiry (F4).
   *
   * Coordinated server contract: the server ALSO resolves expired requests
   * at their `expiresAt` and treats them as already settled, so a late
   * `ui_response` (with or without a value) would only produce a
   * server-side error. The one consistent frontend behavior is to dismiss
   * locally and send a best-effort `ui_cancel {id}` — the server ignores it
   * when the request already settled.
   */
  autoCancel() {
    this.clearCurrentDialog();
    this.sendReply({ type: "ui_cancel", id: this.request.id });
    this.onDone();
  }

  /** User acted (choice / explicit cancel) — send per the frozen contract. */
  respond(id, response) {
    const command = response?.cancelled
      ? { type: "ui_cancel", id }
      : {
          type: "ui_response",
          id,
          value: valueFromResponse(response, this.request.method),
        };
    this.clearCurrentDialog();
    this.sendReply(command);
    this.onDone();
  }

  /**
   * F9: replies are fire-and-forget. The server acks ui_response/ui_cancel
   * by echoing the ws-rpc transport requestId (standard envelope — never
   * the dialog id), and nothing here keys off the ack's contents. A failed
   * ack (e.g. "Unknown or expired UI request") surfaces as a non-blocking
   * console warn — never a user-facing error, since the dialog is already
   * dismissed either way and the request may legitimately have settled
   * server-side before our reply landed.
   */
  sendReply(command) {
    void wsRpc(this.wsClient, command, { timeoutMs: UI_RESPONSE_TIMEOUT_MS }).then((result) => {
      if (!result.ok) {
        console.warn("[UIRequests] Reply not accepted by server:", command.id, result.error);
      }
    });
  }

  clearCurrentDialog() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    if (this.onKeyDown) {
      document.removeEventListener("keydown", this.onKeyDown, true);
      this.onKeyDown = null;
    }
    this.deadline = 0;
    this.countdownText = null;
    this.countdownFill = null;
    super.clearCurrentDialog();
  }
}

/**
 * Single funnel for `extension_ui_request` events. Queueing + the active
 * dialog lifecycle live here; app.js only forwards events.
 */
export class UIRequestManager {
  constructor(container, wsClient) {
    this.container = container;
    this.wsClient = wsClient;
    this.queue = [];
    this.active = null;
    this.seenIds = new Set();
    this.unsubscribeLanguage = onLanguageChanged(() => this.rerenderActive());
  }

  /** Entry point for every `extension_ui_request` event. */
  handle(event) {
    const request = event?.payload && typeof event.payload === "object" ? event.payload : event;
    const id = typeof request?.id === "string" ? request.id : "";
    const method = typeof request?.method === "string" ? request.method : "";
    if (!id) {
      console.warn("[UIRequests] Ignoring malformed extension UI request:", event);
      return;
    }
    // F4: `{method:"cancel", id}` is the server telling us a request died on
    // its side (deadline reached there, abort, teardown). Dismiss the live
    // dialog / drop the queued request and reply with nothing — the server
    // already settled it, so any reply from us would be a late one.
    if (method === "cancel") {
      this.cancelById(id);
      return;
    }
    if (!KNOWN_METHODS.has(method)) {
      console.warn("[UIRequests] Ignoring malformed extension UI request:", event);
      return;
    }
    // The server retries nothing, but a broker re-broadcast of the same
    // request id must not stack a second dialog.
    if (this.seenIds.has(id)) return;
    this.seenIds.add(id);

    if (method === "notify") {
      // Toast-style, never modal — safe to show immediately.
      new DialogHandler(this.container, this.wsClient).showNotification(request);
      return;
    }
    this.queue.push(request);
    this.showNext();
  }

  /**
   * Consume a `{method:"cancel", id}` frame (F4/F5). Dismisses the active
   * dialog or drops the queued request matching `id`; sends nothing back.
   * Unknown ids are a silent no-op (frames may arrive after we already
   * replied, e.g. a user dismissal racing the server-side timeout).
   */
  cancelById(id) {
    const active = this.active;
    if (active && active.request.id === id) {
      this.active = null;
      // clearCurrentDialog only — no ui_cancel/ui_response: the server told
      // us the request is dead, it is already settled there.
      active.handler.clearCurrentDialog();
      this.showNext();
      return;
    }
    const index = this.queue.findIndex((request) => request.id === id);
    if (index !== -1) this.queue.splice(index, 1);
  }

  showNext() {
    while (!this.active && this.queue.length > 0) {
      const request = this.queue.shift();
      // F5: a request that queued behind another dialog may already be dead
      // when we get to it. The server resolves expired requests at their
      // `expiresAt` and treats them as settled — showing the dialog or
      // sending anything would only produce a late-reply error, so discard
      // silently: nothing shown, nothing sent.
      if (requestExpired(request)) continue;
      const handler = new UIRequestDialogHandler(this.container, this.wsClient, request, () => {
        this.active = null;
        this.showNext();
      });
      this.active = { request, handler };
      handler.render();
      handler.startDeadline();
    }
  }

  /** Language switch: rebuild the live dialog (stateless ones fully; typed
   * input keeps its value). Queued requests re-render on show, so they pick
   * the new language up naturally. */
  rerenderActive() {
    const active = this.active;
    if (!active) return;
    const value =
      active.handler.currentDialog?.querySelector(".dialog-input, .dialog-textarea")?.value || "";
    const remaining = active.handler.deadline
      ? Math.max(0, active.handler.deadline - Date.now())
      : null;
    active.handler.clearCurrentDialog();
    active.handler.render(value);
    active.handler.startDeadline(remaining ?? undefined);
  }

  destroy() {
    this.queue = [];
    this.active?.handler.clearCurrentDialog();
    this.active = null;
    this.unsubscribeLanguage();
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Fork from message (B7)
// ═══════════════════════════════════════════════════════════════════════

/** Git-branch glyph, shared with the palette command in app.js. */
export const FORK_ICON_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="8" r="3"/><path d="M6 9v6"/><path d="M15 6.5A9 9 0 0 0 6 15.7"/></svg>';

/**
 * Hover "Fork from here" action on finished assistant messages + the
 * "Fork from latest" palette entry. Follows the copy-button pattern: an
 * icon button appended to the message element, revealed on hover, with
 * keyboard focus keeping it visible.
 */
export function createForkActions({
  wsClient,
  messagesContainer,
  onStatus = () => {},
  onError = () => {},
  onRefresh = () => {},
} = {}) {
  let lastKnownEntryId = null;
  let frame = 0;
  const schedule =
    typeof requestAnimationFrame === "function"
      ? (fn) => requestAnimationFrame(() => fn())
      : (fn) => setTimeout(fn, 16);

  function entryIdFromElement(el) {
    const id = el?.dataset?.messageId;
    return id && id !== "streaming" ? id : null;
  }

  function attachForkButtons() {
    if (!messagesContainer) return;
    for (const el of messagesContainer.querySelectorAll(".message.assistant")) {
      // Streaming placeholders carry no id yet — wait until finalize.
      if (el.querySelector(".message-content.streaming")) continue;
      if (el.querySelector(".message-fork-btn")) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "message-fork-btn";
      btn.innerHTML = FORK_ICON_SVG;
      const label = t("fork.fromHere");
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        void forkFromElement(el);
      });
      el.appendChild(btn);
      const id = entryIdFromElement(el);
      if (id) lastKnownEntryId = id;
    }
  }

  // Finalized messages land in #messages asynchronously (stream finalize,
  // history render) — observe and attach on the next frame, debounced.
  const observer =
    messagesContainer && typeof MutationObserver === "function"
      ? new MutationObserver(() => {
          if (frame) return;
          frame = schedule(() => {
            frame = 0;
            attachForkButtons();
          });
        })
      : null;
  observer?.observe(messagesContainer, { childList: true, subtree: true });
  attachForkButtons();

  async function sendFork(entryId) {
    const command = { type: "fork_session" };
    if (entryId) command.entryId = entryId;
    onStatus(t("status.forking"));
    const result = await wsRpc(wsClient, command, { timeoutMs: 20000 });
    if (!result.ok) {
      onError(result.error || t("fork.failed"));
      return false;
    }
    // `{cancelled:true}` → the server declined silently (e.g. mid-run guard).
    if (result.data?.cancelled === true) return true;
    onStatus(t("status.forked"));
    onRefresh();
    return true;
  }

  async function forkFromElement(el) {
    return sendFork(entryIdFromElement(el) || undefined);
  }

  /** Most recent forkable message in the transcript, else the last known id. */
  function forkFromLatest() {
    const messages = messagesContainer?.querySelectorAll(".message.assistant") || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const id = entryIdFromElement(messages[i]);
      if (id) return sendFork(id);
    }
    return sendFork(lastKnownEntryId || undefined);
  }

  return {
    attachForkButtons,
    forkFromElement,
    forkFromLatest,
    destroy: () => {
      observer?.disconnect();
    },
  };
}
