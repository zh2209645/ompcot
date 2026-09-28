/**
 * Composer @-mention autocomplete (files and directories).
 *
 * omp reads file mentions natively: an `@path` token in a prompt makes the
 * runtime auto-read that file — or a directory listing — into the turn (text up
 * to 5 MB, images resized and attached as image content, videos as a contact
 * sheet) and records it as a `fileMention` entry
 * (`utils/file-mentions.ts` → `extractFileMentions`). The token has to resolve
 * to a real path (relative to the session cwd, or absolute) — a mention that
 * does not resolve is treated as prose — so the GUI's job is exactly what the
 * TUI's @-selector does: insert the real path, quoted when it contains
 * whitespace. It never reads or inlines file content itself.
 *
 * Grammar mirrored from `extractFileMentions`:
 *
 *   @(?:"([^"]+)"|'([^']+)'|([^\s@]+))
 *
 * with the `@` at a boundary (start of text, or after whitespace / `([{<"'``)
 * and trailing punctuation ignored by the runtime. Bare paths may contain any
 * character except whitespace and `@`, so a path with spaces is inserted in one
 * of the quoted forms; Windows separators are written as `/` (both forms
 * resolve).
 *
 * The popup lists the directory the caret's token points at through
 * `/api/files` — the same listing the file browser renders — and inserts
 * workspace-relative paths (`@src/foo.ts`, `@"docs/my plan.md"`) so the
 * transcript stays readable; a path outside the workspace keeps its absolute
 * form. Keys: ↑/↓ cycle, Enter/Tab insert, Escape closes. `app.js` calls
 * `handleKeydown` before its own Enter-send handling.
 */

import { t } from "./i18n.js";

/** `@` must start the text or follow one of these (omp's MENTION_BOUNDARY_REGEX). */
const MENTION_BOUNDARY = /[\s([{<"'`]/;

/** Characters a bare (unquoted) mention may not contain. */
const BARE_TOKEN = /^[^\s@]*$/;

const DIR_CACHE_TTL_MS = 10_000;
const DIR_CACHE_ERROR_TTL_MS = 3_000;

/** True when `value[i] === "@"` may open a mention at `i`. */
export function isMentionBoundary(value, index) {
  if (index <= 0) return true;
  return MENTION_BOUNDARY.test(value[index - 1]);
}

/**
 * The `@`-token the caret sits in, or null when there is none.
 *
 * `end` is where the token stops in the current text (the closing quote of a
 * quoted mention, or the first whitespace / end of text for a bare one), so a
 * completion replaces exactly that range.
 *
 * @returns {{start: number, end: number, token: string, query: string}|null}
 */
export function resolveMentionContext(value, caret) {
  if (typeof value !== "string" || value.length === 0) return null;
  const pos = Math.max(0, Math.min(typeof caret === "number" ? caret : value.length, value.length));

  // The token starts at the last boundary `@` before the caret.
  let start = -1;
  for (let i = pos - 1; i >= 0; i--) {
    if (value[i] === "@" && isMentionBoundary(value, i)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  const first = value[start + 1];
  if (first === '"' || first === "'") {
    // Quoted form: whitespace is allowed inside, the token ends at the quote.
    const close = value.indexOf(first, start + 2);
    if (close !== -1 && pos > close) return null; // caret is past the mention
    const end = close === -1 ? value.length : close + 1;
    return { start, end, token: value.slice(start, end), query: value.slice(start + 2, pos) };
  }

  const tail = value.slice(start + 1, pos);
  if (!BARE_TOKEN.test(tail)) return null; // caret is past the token's end
  let end = value.length;
  for (let i = pos; i < value.length; i++) {
    if (/\s/.test(value[i])) {
      end = i;
      break;
    }
  }
  return { start, end, token: value.slice(start, end), query: tail };
}

/**
 * Split a mention query into the directory part it walks and the name prefix
 * being typed. The directory keeps its trailing separator (and may be empty =
 * the workspace root); an absolute directory is kept as typed.
 */
export function splitMentionQuery(query) {
  const match = /^(.*[\\/])?([^\\/]*)$/.exec(String(query ?? ""));
  return { dir: match?.[1] ?? "", prefix: match?.[2] ?? "" };
}

/** True when a mention directory is absolute (POSIX, Windows drive, or UNC). */
export function isAbsoluteMentionDir(dir) {
  const value = String(dir ?? "");
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

/** Case-insensitive name-prefix filter; the server listing order is preserved. */
export function filterMentionEntries(items, prefix) {
  const wanted = String(prefix ?? "").toLowerCase();
  return (Array.isArray(items) ? items : []).filter((item) =>
    String(item?.name ?? "")
      .toLowerCase()
      .startsWith(wanted),
  );
}

/** The path a mention carries: workspace-relative when inside the root. */
export function relativeMentionPath(absolutePath, root) {
  const path = String(absolutePath ?? "").replace(/\\/g, "/");
  const base = String(root ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!base) return path;
  if (path === base) return ".";
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  return path;
}

/**
 * The text to insert for a mention. Directories keep the popup open (no
 * trailing space, so the caret can walk into them); a file gets one trailing
 * space because the user is done with that token.
 */
export function mentionTextForPath(path, { isDirectory = false } = {}) {
  const normalized = String(path ?? "").replace(/\\/g, "/");
  const body = BARE_TOKEN.test(normalized)
    ? normalized
    : normalized.includes('"')
      ? `'${normalized}'`
      : `"${normalized}"`;
  const suffix = isDirectory ? "/" : " ";
  return `@${body}${suffix}`;
}

/** Replace `context`'s token range with `text`; returns the new value + caret. */
export function insertMention(value, context, text) {
  const before = value.slice(0, context.start);
  const after = value.slice(context.end);
  return { value: before + text + after, caret: before.length + text.length };
}

/** Cache key for a directory: forward slashes, no trailing separator. */
function normalizeDir(dir) {
  const value = String(dir ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  return value || "/";
}

/** Join a typed mention directory onto the workspace root ("" = the root). */
function joinMentionDir(root, dir) {
  const base = normalizeDir(root || "");
  if (!dir) return base === "/" ? "" : base;
  return `${base === "/" ? "" : base}/${dir}`.replace(/\/+$/, "");
}

/** Default directory listing: the file browser's `/api/files` (absolute paths). */
async function fetchFileDir(absDir) {
  const query = absDir ? `?path=${encodeURIComponent(absDir)}` : "";
  const res = await fetch(`/api/files${query}`);
  const data = await res.json();
  if (data?.error) throw new Error(String(data.error));
  return { path: String(data?.path ?? ""), items: Array.isArray(data?.items) ? data.items : [] };
}

/**
 * Creates the mention popup for a composer textarea.
 *
 * @param {object} deps
 * @param {HTMLTextAreaElement} deps.input
 * @param {(dir: string) => Promise<{path: string, items: Array}>} [deps.fetchDir]
 * @param {() => void} [deps.onChange] - called after an insertion (app.js refreshes its own UI)
 */
export function createComposerMentions({ input, fetchDir = fetchFileDir, onChange = () => {} }) {
  const anchor =
    (input.closest ? input.closest(".composer-card") : null) || input.parentElement || null;
  const menu = document.createElement("div");
  // The composer popup look is the slash menu's; `.mention-menu` only adds the
  // path styling (see style.css).
  menu.className = "slash-menu mention-menu hidden";
  anchor?.appendChild(menu);

  let context = null;
  let entries = [];
  let activeIndex = 0;
  let generation = 0;
  let suppressed = false; // Escape: stay closed until the token changes
  let suppressedToken = "";
  let workspaceRoot = null;
  const dirCache = new Map(); // absDir → { items, at, error }

  function isOpen() {
    return !menu.classList.contains("hidden");
  }

  function close() {
    menu.classList.add("hidden");
    menu.innerHTML = "";
    context = null;
    entries = [];
    activeIndex = 0;
  }

  async function loadDir(absDir) {
    const key = normalizeDir(absDir);
    const cached = dirCache.get(key);
    if (
      cached &&
      Date.now() - cached.at < (cached.error ? DIR_CACHE_ERROR_TTL_MS : DIR_CACHE_TTL_MS)
    ) {
      if (cached.error) throw new Error(cached.error);
      return cached.items;
    }
    try {
      const data = await fetchDir(absDir);
      dirCache.set(key, { items: data.items, at: Date.now() });
      return data.items;
    } catch (err) {
      dirCache.set(key, { items: [], at: Date.now(), error: String(err?.message || err) });
      throw err;
    }
  }

  /** Workspace root = the session cwd the server reports for a bare listing. */
  async function resolveRoot() {
    if (workspaceRoot) return workspaceRoot;
    try {
      const data = await fetchDir("");
      workspaceRoot = data.path || null;
      dirCache.set(normalizeDir(workspaceRoot), { items: data.items, at: Date.now() });
    } catch {
      workspaceRoot = null;
    }
    return workspaceRoot;
  }

  function render(dirLabel) {
    menu.innerHTML = "";
    const header = document.createElement("div");
    header.className = "slash-menu-header";
    header.textContent = dirLabel ? `@${dirLabel}` : "@";
    menu.appendChild(header);

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "slash-menu-item mention-menu-empty";
      empty.textContent = t("mention.noMatches");
      menu.appendChild(empty);
    }
    entries.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = `slash-menu-item mention-menu-item${item.isDirectory ? " directory" : ""}`;
      row.classList.toggle("active", index === activeIndex);
      row.dataset.index = String(index);
      const name = document.createElement("span");
      name.className = "slash-menu-name mention-menu-name";
      name.textContent = item.isDirectory ? `${item.name}/` : item.name;
      row.appendChild(name);
      if (!item.isDirectory && typeof item.size === "number" && item.size > 0) {
        const size = document.createElement("span");
        size.className = "slash-menu-desc";
        size.textContent = formatSize(item.size);
        row.appendChild(size);
      }
      row.addEventListener("mousedown", (event) => {
        // mousedown so the textarea does not lose the caret before insertion.
        event.preventDefault();
        activeIndex = index;
        complete();
      });
      menu.appendChild(row);
    });

    const hint = document.createElement("div");
    hint.className = "mention-menu-hint";
    hint.textContent = t("mention.hint");
    menu.appendChild(hint);
    menu.classList.remove("hidden");
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function complete() {
    const item = entries[activeIndex];
    if (!item || !context) return;
    const root = workspaceRoot || "";
    const text = mentionTextForPath(relativeMentionPath(item.path, root), {
      isDirectory: Boolean(item.isDirectory),
    });
    const next = insertMention(input.value, context, text);
    input.value = next.value;
    try {
      input.setSelectionRange(next.caret, next.caret);
    } catch {
      /* clients without selection APIs still get the value */
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    onChange();
    if (item.isDirectory) void refresh();
    else input.focus();
  }

  async function refresh() {
    if (!input) return;
    const next = resolveMentionContext(input.value, input.selectionStart);
    if (!next) {
      suppressed = false;
      close();
      return;
    }
    if (suppressed && next.token === suppressedToken) return;
    suppressed = false;
    context = next;
    const { dir, prefix } = splitMentionQuery(next.query);

    const run = ++generation;
    let absDir = dir;
    if (!isAbsoluteMentionDir(dir)) {
      const root = await resolveRoot();
      absDir = joinMentionDir(root, dir);
    }

    let items = [];
    let failed = false;
    try {
      items = await loadDir(absDir);
    } catch {
      failed = true;
    }
    if (run !== generation) return; // a newer keystroke owns the popup
    if (failed) {
      close();
      return;
    }
    entries = filterMentionEntries(items, prefix);
    activeIndex = 0;
    render(dir);
  }

  /** Consumes navigation/completion keys while the popup is open. */
  function handleKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return false;
    if (!isOpen()) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (entries.length > 0) {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        activeIndex = (activeIndex + delta + entries.length) % entries.length;
        menu.querySelectorAll(".mention-menu-item").forEach((row, index) => {
          row.classList.toggle("active", index === activeIndex);
        });
      }
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (entries.length === 0) return false;
      event.preventDefault();
      complete();
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      suppressedToken = context?.token ?? "";
      suppressed = true;
      close();
      return true;
    }
    return false;
  }

  input?.addEventListener("input", () => {
    void refresh();
  });
  input?.addEventListener("click", () => {
    void refresh();
  });
  input?.addEventListener("blur", () => {
    // A click on a row lands before blur (rows use mousedown), so the popup can
    // close without stealing the completion.
    close();
  });

  return {
    handleKeydown,
    refresh,
    close,
    isOpen,
    /**
     * Insert mentions for paths picked outside the composer (native picker).
     * Resolves the workspace root first when the user never opened the popup,
     * so picked paths are written relative whenever they live in the workspace.
     */
    async insertPaths(paths) {
      const list = (Array.isArray(paths) ? paths : [paths]).filter(
        (p) => typeof p === "string" && p.length > 0,
      );
      if (list.length === 0) return;
      if (!workspaceRoot) await resolveRoot();
      const caret =
        typeof input.selectionStart === "number" ? input.selectionStart : input.value.length;
      const text = list
        .map((p) => mentionTextForPath(relativeMentionPath(p, workspaceRoot || "")))
        .join("");
      const before = input.value.slice(0, caret);
      const after = input.value.slice(caret);
      const spacer = before.length > 0 && !/\s$/.test(before) ? " " : "";
      input.value = `${before}${spacer}${text}${after}`;
      const next = before.length + spacer.length + text.length;
      try {
        input.setSelectionRange(next, next);
      } catch {
        /* see complete() */
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      onChange();
    },
  };
}
