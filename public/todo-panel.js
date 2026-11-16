/**
 * TODO list panel (the header's checklist button + popover).
 *
 * Data: the session's todo snapshots (omp's `todo` tool commits a full
 * `TodoPhase[]` snapshot on every state-changing op; TUI HUD edits land as
 * `user_todo_edit` entries) — read through the embedded server's `get_todos`
 * command, which scans the entries of the session the transcript shows. The
 * file identity comes from `getSessionFile()` (app.js answers with the file the
 * DOM renders — `transcriptView.file` / `renderedTranscriptFile`), so peeked
 * and historical sessions report their own lists, and a null identity means
 * "the process's live session".
 *
 * Updates: `scheduleRefresh()` (debounced) from the triggers app.js sees —
 * `todo` tool lifecycle events, run settle, session paints. State changes come
 * in bursts (one `todo` op per tool call), so a trailing debounce keeps the
 * refresh count at one per burst.
 *
 * Interaction mirrors the context popover (app-context-viz.js): the button
 * toggles on `pointerdown` (the header is a drag region — a drifting press
 * never produces a `click`), and outside dismissal listens on the document in
 * the **capture** phase. Capture runs before the context pill's bubble-phase
 * handler, whose `stopPropagation()` would otherwise leave this popover open
 * next to the one the press opened.
 *
 * Rendering is content-guarded (`signature`): the refresh triggers are polled
 * and event-driven, and repainting an unchanged list would restart CSS
 * animations and steal focus. All session-authored text goes through
 * `textContent`, never markup.
 */
import { onLanguageChanged, t } from "./i18n.js";
import { wsRpc } from "./ws-rpc.js";

/** Trailing debounce for refresh bursts (one `todo` op per tool call). */
const REFRESH_DEBOUNCE_MS = 300;

const STATUS_GLYPHS = {
  in_progress: "▶",
  pending: "○",
  completed: "✓",
  abandoned: "✕",
};

const STATUS_LABEL_KEYS = {
  in_progress: "todo.status.inProgress",
  pending: "todo.status.pending",
  completed: "todo.status.completed",
  abandoned: "todo.status.abandoned",
};

/** Client-side shape guard; the server sanitizes, this tolerates old frames. */
function normalizePhases(value) {
  if (!Array.isArray(value)) return [];
  const phases = [];
  for (const phase of value) {
    if (!phase || typeof phase !== "object") continue;
    const name = typeof phase.name === "string" ? phase.name : "";
    const tasks = [];
    for (const task of Array.isArray(phase.tasks) ? phase.tasks : []) {
      if (!task || typeof task !== "object" || typeof task.content !== "string") continue;
      const status = STATUS_GLYPHS[task.status] ? task.status : "pending";
      tasks.push({
        content: task.content,
        status,
        details: typeof task.details === "string" && task.details ? task.details : "",
      });
    }
    phases.push({ name, tasks });
  }
  return phases;
}

export function createTodoPanel({ wsClient, toggleEl, panelEl, getSessionFile = () => null }) {
  let phases = [];
  let known = false;
  let signature = "";
  let debounceTimer = null;
  let destroyed = false;

  function isOpen() {
    return panelEl && !panelEl.classList.contains("hidden");
  }

  function setOpen(open) {
    if (!panelEl) return;
    panelEl.classList.toggle("hidden", !open);
    if (toggleEl?.setAttribute) toggleEl.setAttribute("aria-expanded", String(open));
    if (open) render();
  }

  function counts() {
    let open = 0;
    let done = 0;
    let total = 0;
    for (const phase of phases) {
      for (const task of phase.tasks) {
        total++;
        if (task.status === "completed" || task.status === "abandoned") done++;
        else open++;
      }
    }
    return { open, done, total };
  }

  function updateBadge() {
    const badge = toggleEl?.querySelector(".todo-count");
    if (!badge) return;
    const { open, done, total } = counts();
    badge.textContent = known ? String(open) : "";
    badge.classList.toggle("hidden", !known || open === 0);
    if (toggleEl?.setAttribute && known) {
      toggleEl.setAttribute(
        "title",
        `${t("todo.toggleAria")} · ${t("todo.progress", { done, total })}`,
      );
    }
  }

  function render() {
    if (!panelEl) return;
    updateBadge();
    const nextSignature = `${known ? "1" : "0"}|${t("todo.title")}|${JSON.stringify(phases)}`;
    if (nextSignature === signature) return;
    signature = nextSignature;
    panelEl.textContent = "";

    const title = document.createElement("div");
    title.className = "context-viz-title todo-title";
    const titleText = document.createElement("span");
    titleText.textContent = t("todo.title");
    title.appendChild(titleText);
    if (known && phases.length > 0) {
      const { done, total } = counts();
      const progress = document.createElement("span");
      progress.className = "todo-progress";
      progress.textContent = t("todo.progress", { done, total });
      progress.title = t("todo.progressAria", { done, total });
      title.appendChild(progress);
    }
    panelEl.appendChild(title);

    const flatTasks = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
    if (!known || flatTasks === 0) {
      const empty = document.createElement("div");
      empty.className = "context-viz-empty";
      empty.textContent = t("todo.empty");
      panelEl.appendChild(empty);
      return;
    }

    for (const phase of phases) {
      const group = document.createElement("div");
      group.className = "todo-phase";
      if (phase.name) {
        const name = document.createElement("div");
        name.className = "todo-phase-name";
        name.textContent = phase.name;
        group.appendChild(name);
      }
      for (const task of phase.tasks) {
        const row = document.createElement("div");
        row.className = `todo-task todo-task-${task.status}`;
        const glyph = document.createElement("span");
        glyph.className = "todo-task-glyph";
        glyph.textContent = STATUS_GLYPHS[task.status] || STATUS_GLYPHS.pending;
        glyph.title = t(STATUS_LABEL_KEYS[task.status] || STATUS_LABEL_KEYS.pending);
        glyph.setAttribute("aria-hidden", "true");
        row.appendChild(glyph);
        const content = document.createElement("span");
        content.className = "todo-task-content";
        content.textContent = task.content;
        row.appendChild(content);
        if (task.details) {
          const details = document.createElement("div");
          details.className = "todo-task-details";
          details.textContent = task.details;
          row.appendChild(details);
        }
        group.appendChild(row);
      }
      panelEl.appendChild(group);
    }
  }

  async function refresh() {
    if (destroyed) return;
    const sessionFile = getSessionFile();
    const result = await wsRpc(wsClient, {
      type: "get_todos",
      sessionPath: sessionFile || null,
    });
    if (destroyed) return;
    if (!result.ok) {
      // A transient failure (not connected, timeout) must not wipe a list the
      // user is reading; a never-known panel stays on the empty state.
      console.warn("[TodoPanel] get_todos failed:", result.error);
      render();
      return;
    }
    phases = normalizePhases(result.data?.phases);
    known = true;
    render();
  }

  function scheduleRefresh() {
    if (destroyed) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Session switch / `/clear`: the old list must never label the new view. */
  function clear() {
    phases = [];
    known = false;
    render();
  }

  // ── Popover mechanics (see the module header) ──
  if (toggleEl && panelEl) {
    toggleEl.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      setOpen(!isOpen());
    });
    toggleEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setOpen(!isOpen());
      } else if (event.key === "Escape" && isOpen()) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    });
    // Capture phase: runs before the context pill's bubble handler, whose
    // stopPropagation() would keep this popover open next to the one the
    // press opened. Containment on both sides — presses on the button's
    // icon/badge or the panel's padding keep the popover open.
    const onOutsidePointerDown = (event) => {
      if (panelEl.contains(event.target) || toggleEl.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onOutsidePointerDown, true);
  }

  const unsubscribeLanguage = onLanguageChanged(() => {
    // Titles/labels come from `t()`; force the guarded render to redo them.
    signature = "";
    render();
  });

  function destroy() {
    destroyed = true;
    clearTimeout(debounceTimer);
    unsubscribeLanguage();
    setOpen(false);
  }

  render();
  return { refresh, scheduleRefresh, clear, destroy, isOpen };
}
