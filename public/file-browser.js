/**
 * File Browser — right sidebar file tree with drag-and-drop
 */

import { onLanguageChanged, t } from "./i18n.js";

const FILE_ICONS = {
  // Folders
  directory: "📁",
  // Code
  js: "📄",
  ts: "📄",
  jsx: "📄",
  tsx: "📄",
  py: "🐍",
  rb: "💎",
  go: "📄",
  rs: "🦀",
  // Web
  html: "🌐",
  css: "🎨",
  svg: "🎨",
  // Data
  json: "📋",
  yaml: "📋",
  yml: "📋",
  toml: "📋",
  xml: "📋",
  csv: "📋",
  // Docs
  md: "📝",
  txt: "📝",
  rst: "📝",
  // Images
  png: "🖼️",
  jpg: "🖼️",
  jpeg: "🖼️",
  gif: "🖼️",
  webp: "🖼️",
  ico: "🖼️",
  // Config
  env: "🔒",
  gitignore: "🔒",
  lock: "🔒",
  // Default
  default: "📄",
};

function getFileIcon(name, isDirectory) {
  if (isDirectory) return FILE_ICONS.directory;
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return FILE_ICONS[ext] || FILE_ICONS.default;
}

function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export class FileBrowser {
  constructor(container, pathEl, messageInput) {
    this.container = container;
    this.pathEl = pathEl;
    this.messageInput = messageInput;
    this.currentPath = null;
    // Which placeholder label ("loading" | "error" | "empty") is on screen,
    // or null when a real listing (or a server-provided error) is shown.
    this.labelState = null;

    // Re-render the current placeholder label when the interface language
    // changes and the browser pane is open; rendered listings contain only
    // file names/paths, which are never translated.
    this.unsubscribeLanguageChanged = onLanguageChanged(() => this.refreshLabels());

    this.setupDropTarget();
  }

  async load(dirPath) {
    this.labelState = "loading";
    this.container.innerHTML = `<div class="file-loading">${t("files.loading")}</div>`;

    try {
      const url = dirPath ? `/api/files?path=${encodeURIComponent(dirPath)}` : "/api/files";
      const res = await fetch(url);
      const data = await res.json();

      if (data.error) {
        // Server-provided message — dynamic content, keep verbatim.
        this.labelState = null;
        this.container.innerHTML = `<div class="file-loading">${data.error}</div>`;
        return;
      }

      this.currentPath = data.path;
      this.pathEl.textContent = data.path;
      this.pathEl.title = data.path;
      this.render(data.items);
    } catch (_err) {
      this.labelState = "error";
      this.container.innerHTML = `<div class="file-loading">${t("files.loadFailed")}</div>`;
    }
  }

  refreshLabels() {
    if (!this.container.isConnected || this.container.closest(".collapsed")) return;
    const label =
      this.labelState === "loading"
        ? t("files.loading")
        : this.labelState === "error"
          ? t("files.loadFailed")
          : this.labelState === "empty"
            ? t("files.emptyDirectory")
            : null;
    if (label === null) return;
    this.container.innerHTML = `<div class="file-loading">${label}</div>`;
  }

  getParentPath() {
    if (!this.currentPath) return null;
    const parts = this.currentPath.split("/");
    parts.pop();
    return parts.join("/") || "/";
  }

  render(items) {
    this.container.innerHTML = "";

    if (items.length === 0) {
      this.labelState = "empty";
      this.container.innerHTML = `<div class="file-loading">${t("files.emptyDirectory")}</div>`;
      return;
    }
    this.labelState = null;

    for (const item of items) {
      const el = document.createElement("div");
      el.className = `file-item${item.isDirectory ? " directory" : ""}`;
      el.draggable = true;
      el.dataset.path = item.path;
      el.dataset.name = item.name;
      el.dataset.isDirectory = item.isDirectory;

      const icon = getFileIcon(item.name, item.isDirectory);
      const size = item.isDirectory ? "" : formatSize(item.size);

      el.innerHTML = `
        <span class="file-icon">${icon}</span>
        <span class="file-name" title="${item.name}">${item.name}</span>
        ${size ? `<span class="file-size">${size}</span>` : ""}
      `;

      // Click: open directory or open file natively
      el.addEventListener("click", () => {
        if (item.isDirectory) {
          this.load(item.path);
        }
      });

      // Double-click: open file natively
      el.addEventListener("dblclick", (e) => {
        e.preventDefault();
        if (!item.isDirectory) {
          this.openNatively(item.path);
        }
      });

      // Drag start
      el.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", item.path);
        e.dataTransfer.effectAllowed = "copy";
        el.classList.add("dragging");
      });

      el.addEventListener("dragend", () => {
        el.classList.remove("dragging");
      });

      this.container.appendChild(el);
    }
  }

  async openNatively(filePath) {
    try {
      await fetch("/api/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filePath }),
      });
    } catch (err) {
      console.error("[FileBrowser] Failed to open:", err);
    }
  }

  setupDropTarget() {
    const input = this.messageInput;

    input.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      input.classList.add("file-drop-hover");
    });

    input.addEventListener("dragleave", () => {
      input.classList.remove("file-drop-hover");
    });

    input.addEventListener("drop", (e) => {
      e.preventDefault();
      input.classList.remove("file-drop-hover");

      const filePath = e.dataTransfer.getData("text/plain");
      if (filePath?.startsWith("/")) {
        // Insert file path at cursor
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const before = input.value.substring(0, start);
        const after = input.value.substring(end);
        const insert = filePath;
        input.value = before + insert + after;
        input.selectionStart = input.selectionEnd = start + insert.length;
        input.focus();

        // Trigger input event for auto-resize
        input.dispatchEvent(new Event("input"));
      }
    });
  }
}
